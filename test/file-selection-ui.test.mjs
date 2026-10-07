import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, Files, entries, calls, messages, shares, extract, send, sequence = 0;
const views = new Set();
const file = (name, extra = {}) => ({ name, path: name, size: 20, type: "file", modified: "2026-10-07", ...extra });
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const click = async (element) => { assert.ok(element); dom.update(() => element.click()); await settle(); };
before(async () => {
  dom = await startDom();
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ({ default: Files } = await dom.load("/src/Files.tsx"));
});
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
after(async () => dom?.close());
async function show(files, options = {}) {
  entries = files; calls = []; messages = []; shares = [];
  extract = () => ({ name: "Unpacked" }); send = () => ({ delivered: true });
  Object.defineProperty(navigator, "share", { configurable: true, value: async (payload) => { shares.push(payload); } });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url), body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: parsed.pathname, query: parsed.searchParams, init, body });
    let response;
    if (parsed.pathname === "/api/files") response = { items: entries };
    else if (parsed.pathname === "/api/files/icons") response = { icons: {} };
    else if (parsed.pathname === "/api/files/extract") response = await extract(body);
    else if (parsed.pathname.endsWith("/messages")) response = await send(body);
    else if (parsed.pathname === "/api/files/content") return new Response(options.content?.() || `bytes:${parsed.searchParams.get("path")}`, { headers: { "Content-Type": "text/plain" } });
    else throw Error(`Unexpected route ${parsed.pathname}`);
    return response instanceof Response ? response : Response.json(response);
  };
  const peer = { id: "files", name: "Fixture", url: "https://files.test", token: `selection-${++sequence}` };
  const device = { platform: options.platform || "linux", name: "Fixture", roots: [{ id: 0, name: "Project", path: options.rootPath || "/project" }], capabilities: { files: true }, ...(options.access ? { access: options.access } : {}) };
  const view = await dom.render(dom.React.createElement(Files, { peer, peers: [peer], device, onSession() {}, toast: (m) => messages.push(m), ...options }));
  views.add(view);
  await dom.waitFor(() => view.container.querySelectorAll(".file-main").length === files.length);
  return view.container;
}
async function selectAll(container) {
  await click(container.querySelector('[aria-label="Select files"]'));
  await click(button(container, "Select All"));
  return container.querySelector('[aria-label="Selected items"]');
}

test("selected files share together as bytes and can be selected without opening previews", async () => {
  const c = await show([file("first.txt"), file("second.txt")]);
  const toolbar = await selectAll(c);
  assert.match(toolbar.textContent, /2 selected/);
  assert.equal(c.querySelector("dialog"), null);
  await click(button(toolbar, "Share"));
  await dom.waitFor(() => shares.length === 1);
  assert.deepEqual(Object.keys(shares[0]), ["files"]);
  assert.deepEqual(shares[0].files.map((f) => f.name), ["first.txt", "second.txt"]);
  assert.deepEqual(await Promise.all(shares[0].files.map((f) => f.text())), ["bytes:first.txt", "bytes:second.txt"]);
  assert.ok(calls.filter((c) => c.path === "/api/files/content").every((c) => c.init.headers.Authorization.startsWith("Bearer selection-")));
  await click(button(c, "Done"));
  assert.equal(c.querySelector('[aria-label="Selected items"]'), null);
});

test("multi-share retains a prepared selection above the warm cache budget for the required new tap", async () => {
  const size = 31 * 1024 * 1024;
  const c = await show([file("one.txt", { size }), file("two.txt", { size })], { content: () => new Uint8Array(size) });
  let attempts = 0;
  Object.defineProperty(navigator, "share", { configurable: true, value: (payload) => {
    if (++attempts === 1) return Promise.reject(new DOMException("Tap again", "NotAllowedError"));
    shares.push(payload); return Promise.resolve();
  } });
  const toolbar = await selectAll(c);
  await click(button(toolbar, "Share"));
  await dom.waitFor(() => button(toolbar, "Tap to share"));
  const reads = calls.filter((c) => c.path === "/api/files/content").length;
  dom.update(() => button(toolbar, "Tap to share").click());
  // Synchronous dispatch is essential: awaiting another evicted file would
  // expire browser activation again and leave this selection stuck forever.
  assert.equal(shares.length, 1);
  assert.equal(attempts, 2);
  assert.equal(calls.filter((c) => c.path === "/api/files/content").length, reads);
  assert.equal(shares[0].files.length, 2);
});

test("sharing never silently drops a selected oversized file or a directory", async () => {
  const c = await show([file("small.txt"), file("large.bin", { size: 101 * 1024 * 1024 })]);
  await click(button(await selectAll(c), "Share"));
  assert.equal(shares.length, 0);
  assert.equal(calls.some((c) => c.path === "/api/files/content"), false);
  assert.match(messages.at(-1), /totaling up to 100 MB/);
  const other = await show([file("small.txt"), file("folder", { type: "directory" })]);
  const toolbar = await selectAll(other);
  assert.equal(button(toolbar, "Share").disabled, true);
  assert.equal(button(toolbar, "Download").disabled, true);
});

test("Unzip sends the selected archive and refreshes its parent folder; read-only access cannot extract", async () => {
  const c = await show([file("bundle.zip")]);
  const before = calls.filter((c) => c.path === "/api/files").length;
  await click(button(await selectAll(c), "Unzip"));
  await dom.waitFor(() => messages.includes("Unzipped into “Unpacked”"));
  assert.deepEqual(calls.filter((c) => c.path === "/api/files/extract").map((c) => c.body), [{ root: 0, path: "bundle.zip" }]);
  await dom.waitFor(() => calls.filter((c) => c.path === "/api/files").length > before);
  const readonly = await show([file("bundle.zip")], { access: { kind: "guest", scopes: ["files:read"] } });
  assert.equal(button(await selectAll(readonly), "Unzip"), undefined);
  const fullGuest = await show([file("bundle.zip")], { access: { kind: "guest", scopes: ["admin", "files"] } });
  assert.equal(button(await selectAll(fullGuest), "Unzip"), undefined, "guest admin never confers owner extraction");
  const scoped = await show([file("bundle.zip")], { access: { kind: "agent", scopes: ["files", "files:write"] } });
  assert.equal(button(await selectAll(scoped), "Unzip"), undefined);
  const directory = await show([file("bundle.zip", { type: "directory" })]);
  assert.equal(button(await selectAll(directory), "Unzip"), undefined);
});

test("a missing second archive is reported by its own name without claiming extraction success", async () => {
  const c = await show([file("one.zip"), file("two.zip")]);
  extract = ({ path }) => path === "one.zip" ? { name: "one" } : Response.json({ error: "Gone" }, { status: 404 });
  await click(button(await selectAll(c), "Unzip"));
  await dom.waitFor(() => messages.some((m) => m.includes("two.zip” was moved")));
  assert.equal(messages.some((m) => m.includes("one.zip” was moved")), false);
  assert.equal(messages.filter((m) => m.startsWith("Unzipped into")).length, 1);
});

test("Send to agent passes same-host paths once and explains why read-only chats cannot receive files", async () => {
  let opened;
  const base = { title: "Working chat", cwd: "/project", updatedAt: 1, createdAt: 1, status: "idle", archived: false };
  const c = await show([file("notes.txt")], { agentSessions: [
    { ...base, agent: "codex", id: "chat" },
    { ...base, agent: "gemini", id: "readonly", title: "Read only Gemini" },
    { ...base, agent: "openclaw", id: "gateway", title: "Gateway chat" },
    { ...base, agent: "claude", id: "old", archived: true, title: "Archived chat" },
  ], openAgentSession: (s) => { opened = s; } });
  await click(button(await selectAll(c), "Send to agent"));
  const dialog = c.querySelector('dialog[aria-label="Send to agent"]');
  assert.equal(dialog.querySelectorAll('input[type="radio"]').length, 3);
  assert.equal(dialog.querySelectorAll('input[type="radio"]:disabled').length, 2);
  assert.match(dialog.textContent, /Gemini CLI no longer answers personal Google accounts/);
  assert.match(dialog.textContent, /Reach can’t reply in OpenClaw chats yet/);
  assert.doesNotMatch(dialog.textContent, /Archived chat/);
  await click(dialog.querySelector('input[type="radio"]:not(:disabled)'));
  let finish;
  send = () => new Promise((resolve) => { finish = resolve; });
  const form = dialog.querySelector("form");
  dom.update(() => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await dom.waitFor(() => finish);
  const sent = calls.filter((c) => c.path.endsWith("/messages"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, "/api/sessions/codex/chat/messages");
  assert.equal(sent[0].body.text, "Take a look at this file:\n- /project/notes.txt");
  finish({ delivered: true });
  await dom.waitFor(() => opened);
  assert.equal(opened.id, "chat");
  assert.equal(c.querySelector('dialog[aria-label="Send to agent"]'), null);
});

test("Send to agent exposes rejection inside the modal and allows a single retry without losing the selection", async () => {
  let opened;
  const c = await show([file("sample.pdf")], { agentSessions: [
    { agent: "codex", id: "chat", title: "Working chat", cwd: "/project", updatedAt: 1, status: "idle" },
  ], openAgentSession: (s) => { opened = s; } });
  await click(button(await selectAll(c), "Send to agent"));
  const dialog = c.querySelector('dialog[aria-label="Send to agent"]');
  await click(dialog.querySelector('input[type="radio"]'));
  send = () => Response.json({ error: "This UI demo is read-only." }, { status: 403 });
  await click(button(dialog, "Send"));
  await dom.waitFor(() => dialog.querySelector('[role="alert"]'));
  assert.equal(dialog.querySelector('[role="alert"]').textContent, "This UI demo is read-only.");
  assert.equal(button(dialog, "Send").disabled, false);
  assert.equal(dialog.querySelector('input[type="radio"]').checked, true);
  assert.equal(opened, undefined);
  assert.equal(messages.length, 0, "error does not depend on a toast behind the modal");
  let finish;
  send = () => new Promise((resolve) => { finish = resolve; });
  const form = dialog.querySelector("form");
  dom.update(() => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await dom.waitFor(() => finish);
  assert.equal(dialog.querySelector('[role="alert"]'), null);
  assert.equal(button(dialog, "Sending…").disabled, true);
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).length, 2);
  finish({ delivered: true });
  await dom.waitFor(() => opened);
  assert.equal(c.querySelector('dialog[aria-label="Send to agent"]'), null);
});

test("Send to agent is unavailable when all same-computer chats are read-only", async () => {
  const c = await show([file("notes.txt")], { agentSessions: [
    { agent: "openclaw", id: "gateway", title: "Gateway chat", updatedAt: 1 },
    { agent: "gemini", id: "readonly", title: "Gemini chat", updatedAt: 2 },
  ] });
  assert.equal(button(await selectAll(c), "Send to agent"), undefined);
  assert.equal(calls.some((c) => c.path.endsWith("/messages")), false);
});
