import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, React, BrowserTerminal, BrowserWorkspace;
const peer = { id: "mac", name: "Mac", url: "https://terminal-preview.invalid", token: "muse", platform: "darwin" };
const roots = [{ index: 0, name: "Project", path: "/shared/project" }, { index: 1, name: "Notes", path: "/shared/notes" }];
const reply = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const record = (command, other = {}) => ({ id: `r-${command}`, clientId: "muse", name: "Muse", action: { type: "terminal", command, root: 0, cwd: "" }, status: "executed", reason: "", createdAt: Date.now(), completedAt: Date.now(), expiresAt: Date.now() + 60000, output: "", ...other });
const active = new Set();
before(async () => { dom = await startDom(); React = dom.React; ({ default: BrowserTerminal } = await dom.load("/src/BrowserTerminal.tsx")); ({ default: BrowserWorkspace } = await dom.load("/src/BrowserWorkspace.tsx")); });
afterEach(async () => { for (const view of active) { await view.unmount(); active.delete(view); } });
after(async () => dom?.close());
const render = async (props = {}) => { const view = await dom.render(React.createElement(BrowserTerminal, { peer, roots, onError: assert.fail, ...props })); active.add(view); return view; };
const button = (c, label) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const click = async (element) => { assert.ok(element); element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await settle(40); };
const value = async (element, text) => {
  assert.ok(element);
  if (element.getAttribute("role") === "radiogroup") return click([...element.querySelectorAll('[role="radio"]')].find(option => option.dataset.value === text));
  const prototype = element.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, text); element.dispatchEvent(new dom.window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await settle();
};
const submit = async (c, command) => { await value(c.querySelector('[aria-label="Terminal command"]'), command); c.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await settle(50); };
const key = async (field, name) => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); await settle(); };

test("terminal submits from one prompt, displays inert output, and carries successful cd into subsequent commands", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (init.method === "POST") { const body = JSON.parse(init.body); calls.push([route, body]); return reply(record(body.command, { id: `r-${calls.length}`, action: { type: "terminal", ...body }, directory: body.command === "cd nested" ? "nested" : body.cwd, output: body.command === "cd nested" ? "/shared/project/nested" : "<script>inert</script>\u001b[31m\u202e" })); }
    return reply([]);
  };
  const view = await render(); const c = view.container;
  assert.equal(c.querySelectorAll('input[type="text"]').length, 1);
  assert.equal(c.querySelector("textarea"), null);
  assert.equal(button(c, "Request owner approval"), undefined);
  assert.match(c.querySelector('[aria-label="Terminal working folder"]').textContent, /\/shared\/project/);
  await submit(c, "cd nested"); await submit(c, "cat notes.txt");
  assert.deepEqual(calls, [
    ["/api/browser/terminal", { command: "cd nested", root: 0, cwd: "" }],
    ["/api/browser/terminal", { command: "cat notes.txt", root: 0, cwd: "nested" }],
  ]);
  assert.match(c.querySelector('[aria-label="Terminal working folder"]').textContent, /\/shared\/project\/nested/);
  const output = [...c.querySelectorAll('[aria-label="Command output"]')].at(-1);
  assert.equal(output.querySelector("script"), null);
  assert.match(output.textContent, /\\u001b\[31m\\u202e/);
  assert.equal(c.querySelector('[aria-label="Terminal command"]').value, "");
});

test("supported file change waits inline, cannot duplicate or run other commands, and owner outcome appears by polling", async () => {
  let current = null; const posts = []; let reads = 0;
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") { const body = JSON.parse(init.body); posts.push(body); current = record(body.command, { action: { type: "terminal-change", ...body }, status: "pending", output: undefined }); return reply(current); }
    reads++; return reply(current ? [current] : []);
  };
  const view = await render({ terminalApproval: true }); const c = view.container;
  await submit(c, "touch result.txt");
  assert.match(c.textContent, /Waiting for owner approval/);
  assert.equal(c.querySelector('[aria-label="Terminal command"]').readOnly, true);
  assert.ok(button(c, "Cancel request"));
  await submit(c, "another command");
  assert.equal(posts.length, 1);
  current = { ...current, status: "executed", output: "created", completedAt: Date.now() };
  await dom.waitFor(() => c.textContent.includes("created"), 4000);
  assert.equal(c.querySelector('[aria-label="Terminal command"]').readOnly, false);
  assert.equal(posts.length, 1, "polling does not replay a command");
  assert.ok(reads >= 2);
});

test("read-only grant shows blocked command result without upgrading or hiding its log entry", async () => {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") { const body = JSON.parse(init.body); calls.push(body); return reply(record(body.command, { action: { type: "terminal-change", ...body }, status: "blocked", error: "This session only permits read-only commands." })); }
    return reply([]);
  };
  const view = await render({ terminalApproval: false }); const c = view.container;
  await submit(c, "sudo command");
  assert.match(c.textContent, /Other commands are blocked/);
  assert.match(c.querySelector('[aria-label="Command transcript"]').textContent, /sudo command[\s\S]*Blocked[\s\S]*read-only commands/);
  assert.equal(button(c, "Approve"), undefined);
  assert.equal(c.querySelector('[aria-label="Terminal command"]').readOnly, false);
  assert.deepEqual(calls, [{ command: "sudo command", root: 0, cwd: "" }]);
});

test("durable history supports Up/Down recall and working folders remain separate per shared root", async () => {
  const old = record("cd nested", { id: "old-cd", directory: "nested", completedAt: 10, createdAt: 10 });
  const newer = record("ls", { id: "new-ls", action: { type: "terminal", command: "ls", root: 1, cwd: "" }, completedAt: 20, createdAt: 20, output: "notes.md" });
  const posts = [];
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") { const body = JSON.parse(init.body); posts.push(body); return reply(record(body.command, { action: { type: "terminal", ...body } })); }
    return reply([newer, old]);
  };
  const view = await render(); const c = view.container;
  await dom.waitFor(() => c.textContent.includes("notes.md"));
  const input = c.querySelector('[aria-label="Terminal command"]');
  await value(input, "unfinished"); await key(input, "ArrowUp"); assert.equal(input.value, "ls");
  await key(input, "ArrowUp"); assert.equal(input.value, "cd nested");
  await key(input, "ArrowDown"); assert.equal(input.value, "ls");
  await key(input, "ArrowDown"); assert.equal(input.value, "unfinished");
  assert.match(c.querySelector('[aria-label="Terminal working folder"]').textContent, /nested$/);
  await value(c.querySelector('[aria-label="Terminal shared folder"]'), "1");
  assert.equal(c.querySelector('[aria-label="Terminal working folder"]').textContent, "/shared/notes");
  await submit(c, "pwd"); assert.deepEqual(posts[0], { command: "pwd", root: 1, cwd: "" });
});

test("pending/executing command can be cancelled and completed commands are never silently retried", async () => {
  const current = record("rm draft.txt", { action: { type: "terminal-change", command: "rm draft.txt", root: 0, cwd: "" }, status: "executing" });
  const writes = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (init.method === "DELETE") { writes.push([new URL(url).pathname, "DELETE"]); return reply({ ...current, status: "cancelled" }); }
    return reply([current]);
  };
  const view = await render({ terminalApproval: true }); const c = view.container;
  await dom.waitFor(() => button(c, "Stop command")); await click(button(c, "Stop command"));
  assert.match(c.textContent, /Cancelled/);
  assert.match(c.textContent, /completed changes are not undone/);
  await settle(1400);
  assert.deepEqual(writes, [[`/api/browser/requests/${encodeURIComponent(current.id)}`, "DELETE"]]);
  assert.equal(button(c, "Stop command"), undefined, "stale history cannot turn cancelled record into active work");
});

test("identity change clears transcript and ignores late old-session results", async () => {
  let changePeer, resolvePost; let errors = 0; let posts = 0;
  globalThis.fetch = dom.window.fetch = async (_url, init = {}) => {
    if (init.method === "POST") { posts++; return new Promise((resolve) => { resolvePost = () => resolve(reply(record("ls", { output: "old private result" }))); }); }
    return reply([]);
  };
  function Harness() { const [current, set] = React.useState(peer); changePeer = set; return React.createElement(BrowserTerminal, { peer: current, roots, onError: () => errors++ }); }
  const view = await dom.render(React.createElement(Harness)); active.add(view); const c = view.container;
  await submit(c, "ls");
  dom.update(() => changePeer({ ...peer, sessionId: "new-bound-session" }));
  resolvePost(); await settle(80);
  assert.doesNotMatch(c.textContent, /old private result/);
  assert.equal(c.querySelector('[aria-label="Terminal command"]').value, "");
  assert.equal(errors, 0); assert.equal(posts, 1);
});

test("workspace uses command terminal for new grants and keeps shared output separate", async () => {
  globalThis.fetch = dom.window.fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route === "/api/browser") return reply({ name: "Muse", roots, terminals: [{ id: "reach:log", name: "Build output" }], screen: "off", restrictedTerminal: true, terminalApproval: true, expiresAt: Date.now() + 60000 });
    if (route.startsWith("/api/browser/terminals/")) return reply({ output: "Build complete" });
    if (route === "/api/files") return reply({ items: [] });
    return reply([]);
  };
  const view = await dom.render(React.createElement(BrowserWorkspace, { peer, onEnd: assert.fail })); active.add(view); const c = view.container;
  const terminalTab = await dom.waitFor(() => [...c.querySelectorAll('[role="tab"]')].find((item) => item.textContent.trim() === "Terminal"));
  await click(terminalTab);
  await dom.waitFor(() => c.querySelector('[aria-label="Terminal transcript"]')?.textContent.includes("Build complete"));
  assert.ok(c.querySelector('[aria-label="Terminal command"]'));
  assert.equal(c.querySelector('[aria-label="Reason for request"]'), null);
  assert.equal(button(c, "Request owner approval"), undefined);
  assert.match(c.textContent, /Supported file changes need owner approval/);
  assert.match(c.querySelector('[aria-label="Terminal transcript"]').textContent, /Build complete/);
  assert.deepEqual(dom.errors, []);
});
