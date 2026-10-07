import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The agent's workspace for a preset session: the screen is a picture that
// clicks, every key is a button, the shell shows its refusals, and file
// changes are plain controls. Read only has none of the controls.
let dom, React, BrowserWorkspace;
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "agent", platform: "darwin" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const jpeg = () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "Content-Type": "image/jpeg", "X-Reach-Screen": JSON.stringify({ width: 100, height: 60, hidden: 1 }) } });
const views = new Set();
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.URL.createObjectURL ||= () => "blob:screen";
  dom.window.URL.revokeObjectURL ||= () => {};
  ({ default: BrowserWorkspace } = await dom.load("/src/BrowserWorkspace.tsx"));
});
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
after(async () => dom?.close());
const click = async (element) => { assert.ok(element); element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await settle(40); };
const button = (c, label) => [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
const tab = (c, label) => [...c.querySelectorAll('[role="tab"]')].find((item) => item.textContent.trim() === label);
const type = async (element, text) => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(element, text);
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle(20);
};
const full = {
  name: "My Mac", expiresAt: Date.now() + 20 * 60000, preset: "full", presetName: "Full control", screen: true, control: true, open: true, shell: true, write: true,
  roots: [{ index: 0, name: "Home", path: "/Users/me" }], terminals: [], apps: [], hidden: [],
};
function mock(access, { busy = false } = {}) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url), route = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/browser") return reply(access);
    if (route === "/api/browser/desktop/screen") return jpeg();
    if (route === "/api/browser/desktop/front") return reply({ app: "Google Chrome", title: "Amazon", terminalLike: false, secure: false, blocked: "", holder: "" });
    if (route === "/api/browser/desktop/input") return busy ? reply({ error: "Grok is using the Mac right now.", kind: "busy", holder: "Grok", retryInMs: 1800 }, 409) : reply({ ok: true, app: "Google Chrome" });
    if (route === "/api/browser/desktop/apps") return reply({ apps: [{ id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome", running: true }, { id: "/System/Applications/Notes.app", name: "Notes", bundleId: "com.apple.Notes", running: false }] });
    if (route === "/api/browser/desktop/open") return reply({ ok: true, app: "Notes" });
    if (route === "/api/browser/shell") return body.command.startsWith("sudo")
      ? reply({ id: "r2", status: "blocked", action: { type: "shell", command: body.command }, error: "That needs your password. The agent never gets it.", createdAt: Date.now() })
      : reply({ id: "r1", status: "executed", action: { type: "shell", command: body.command }, output: "a.txt\nb.txt\n", exitCode: 0, createdAt: Date.now() });
    if (route === "/api/browser/shell/history") return reply([]);
    if (route === "/api/browser/files/change") return reply({ ok: true });
    if (route === "/api/files") return reply({ items: [{ name: "notes.md", path: "notes.md", type: "file" }] });
    if (route === "/api/files/text") return reply({ text: "# Notes" });
    return reply({ error: `Unexpected ${route}` }, 404);
  };
  return calls;
}
const open = async (access, options) => {
  const calls = mock(access, options);
  const view = await dom.render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  views.add(view);
  const c = view.container;
  await dom.waitFor(() => c.querySelector(".ag-ws-access"));
  return { c, calls };
};

test("Full control: the summary names screen, files and commands; the picture clicks; keys and text are buttons", async () => {
  const { c, calls } = await open(full);
  assert.match(c.textContent, /The Mac as the owner uses it/);
  assert.match(c.textContent, /Run shell commands as the owner/);
  assert.match(c.textContent, /Read, search, download and change files/);
  const frame = await dom.waitFor(() => c.querySelector('[aria-label="Mac screen. Click to click there."]'));
  await dom.waitFor(() => frame.querySelector("img"));
  assert.match(c.textContent, /1 protected window is left out/);
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  frame.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 50, clientY: 25 }));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/desktop/input"));
  const clicked = calls.find(([method, route]) => method === "POST" && route === "/api/browser/desktop/input")[2];
  assert.deepEqual(clicked, { action: { type: "click", x: 0.25, y: 0.25, button: "left", count: 1 } });
  await dom.waitFor(() => /Clicked at 25%, 25% in Google Chrome/.test(c.textContent));
  await click([...c.querySelectorAll('[aria-label="Click mode"] [role="radio"]')].find((item) => item.dataset.value === "right"));
  frame.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 200, clientY: 100 }));
  await dom.waitFor(() => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input").length === 2);
  assert.equal(calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input")[1][2].action.button, "right");
  await type(c.querySelector('[aria-label="Text to type"]'), "hello");
  await click(button(c, "Type + Enter"));
  await dom.waitFor(() => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input").length === 4);
  const typed = calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input").slice(2).map(([, , body]) => body.action);
  assert.deepEqual(typed, [{ type: "type", text: "hello" }, { type: "key", key: "enter" }]);
  await click(button(c, "Esc"));
  await dom.waitFor(() => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input").length === 5);
  await type(c.querySelector('[aria-label="Shortcut"]'), "cmd+l");
  await click(button(c, "Press"));
  await dom.waitFor(() => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input").length === 6);
  assert.deepEqual(calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input").at(-1)[2].action, { type: "key", key: "l", modifiers: ["cmd"] });
  await click(button(c, "What’s in front?"));
  await dom.waitFor(() => /In front: Google Chrome · Amazon/.test(c.textContent));
  await dom.waitFor(() => [...c.querySelectorAll('[aria-label="Apps you may use"] [role="radio"]')].length === 2);
  await click([...c.querySelectorAll('[aria-label="Apps you may use"] [role="radio"]')].find((item) => item.dataset.value === "/System/Applications/Notes.app"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/desktop/open"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/desktop/open")[2], { app: "/System/Applications/Notes.app" });
  await dom.waitFor(() => /Notes is in front/.test(c.textContent));
});

test("another agent holding the Mac is explained as waiting, not failure", async () => {
  const { c } = await open(full, { busy: true });
  const frame = await dom.waitFor(() => c.querySelector('[aria-label="Mac screen. Click to click there."]'));
  await dom.waitFor(() => frame.querySelector("img"));
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  frame.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 50, clientY: 25 }));
  await dom.waitFor(() => /Grok is using the Mac\. Try again in 2 s\./.test(c.textContent));
  assert.ok(c.querySelector(".ag-desk-status.is-wait"));
});

test("the shell runs commands and shows refusals in the owner's words; file changes are plain controls", async () => {
  const { c, calls } = await open(full);
  await click(tab(c, "Terminal"));
  await type(await dom.waitFor(() => c.querySelector('[aria-label="Command"]')), "ls");
  await click(button(c, "Run"));
  await dom.waitFor(() => /a\.txt/.test(c.textContent));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/shell")[2], { command: "ls", root: 0, cwd: "" });
  await type(c.querySelector('[aria-label="Command"]'), "sudo ls");
  await click(button(c, "Run"));
  await dom.waitFor(() => /That needs your password/.test(c.textContent));
  assert.ok(c.querySelector(".ag-shell-result.is-blocked"));
  await click(tab(c, "Files"));
  await dom.waitFor(() => c.querySelector('[aria-label="New file name"]'));
  await type(c.querySelector('[aria-label="New file name"]'), "todo.md");
  await click(button(c, "New file"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/files/change"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/files/change")[2], { root: 0, op: "write", path: "todo.md", content: "" });
  await click([...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Read file notes.md"));
  await dom.waitFor(() => button(c, "Edit notes.md"));
  await click(button(c, "Edit notes.md"));
  const editor = c.querySelector('[aria-label="Edit notes.md"]');
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(editor, "# Notes\nmore");
  editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await click(button(c, "Save"));
  await dom.waitFor(() => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/files/change").length === 2);
  assert.deepEqual(calls.filter(([method, route]) => method === "POST" && route === "/api/browser/files/change")[1][2], { root: 0, op: "write", path: "notes.md", content: "# Notes\nmore" });
  await click(button(c, "Delete"));
  await click(button(c, "Confirm delete"));
  await dom.waitFor(() => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/files/change").length === 3);
  assert.deepEqual(calls.filter(([method, route]) => method === "POST" && route === "/api/browser/files/change")[2][2], { root: 0, op: "rm", path: "notes.md" });
});

test("Read only looks and never touches: no click target, no keys, no shell, no file changes", async () => {
  const { c, calls } = await open({ ...full, preset: "readonly", presetName: "Read only", control: false, open: false, shell: false, write: false });
  assert.match(c.textContent, /Look at the screen\. Nothing here clicks or types/);
  await dom.waitFor(() => c.querySelector('[aria-label="Mac screen"]'));
  assert.equal(c.querySelector('[aria-label="Mac screen. Click to click there."]'), null);
  assert.equal(c.querySelector('[aria-label="Text to type"]'), null);
  assert.equal(button(c, "Esc"), undefined);
  assert.equal(tab(c, "Terminal").disabled, true);
  await click(tab(c, "Files"));
  await settle(60);
  assert.equal(c.querySelector('[aria-label="New file name"]'), null);
  assert.ok(!calls.some(([, route]) => route === "/api/browser/desktop/apps"));
  assert.doesNotMatch(c.textContent, /change files/);
});

test("the workspace renders without React warnings", () => assert.deepEqual(dom.errors, []));
