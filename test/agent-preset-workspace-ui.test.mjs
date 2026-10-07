import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The preset agent's page is driven by sight: one column, no tabs, the Mac's
// screen updating on its own, every action a labelled button with its result
// written out, and one "Reload page" that reloads the browser page.
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
    if (route === "/api/browser/desktop/screen") { assert.equal(parsed.searchParams.get("maxWidth"), "2560", "the page asks for the display's own pixels"); return jpeg(); }
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
const inputs = (calls) => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/desktop/input").map(([, , body]) => body.action);
const open = async (access, options) => {
  const calls = mock(access, options);
  const view = await dom.render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  views.add(view);
  const c = view.container;
  await dom.waitFor(() => c.querySelector(".agent-page"));
  return { c, calls };
};

test("one column, no tabs: what it may do is written out, the screen is live, and Reload page reloads the page", async () => {
  const { c } = await open(full);
  assert.equal(c.querySelector('[role="tab"]'), null, "nothing hides behind tabs");
  assert.match(c.textContent, /You may see and use the whole screen, open apps, read and change files, run commands as the owner/);
  assert.match(c.textContent, /The screen below updates by itself; you never need to refresh it/);
  assert.match(c.textContent, /Full control/);
  const headings = [...c.querySelectorAll("h2")].map((h) => h.textContent.trim());
  assert.deepEqual(headings, ["The Mac's screen", "Open an app on the Mac", "Files on the Mac", "Commands on the Mac"]);
  await dom.waitFor(() => /Live · updated/.test(c.textContent));
  assert.match(c.textContent, /1 protected window left out/);
  const reload = button(c, "Reload page");
  assert.ok(reload);
  assert.match(reload.title, /Reloads this web page/);
  assert.equal([...c.querySelectorAll("button")].filter((b) => /^Refresh/.test(b.textContent.trim())).length, 0, "no scoped Refresh buttons");
  assert.ok(button(c, "Take a screenshot now"));
});

test("clicking the picture clicks the Mac and the result is written next to the actions", async () => {
  const { c, calls } = await open(full);
  const frame = await dom.waitFor(() => c.querySelector('[aria-label="Mac screen. Click to click there."]'));
  await dom.waitFor(() => frame.querySelector("img"));
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  frame.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 50, clientY: 25 }));
  await dom.waitFor(() => inputs(calls).length === 1);
  assert.deepEqual(inputs(calls)[0], { type: "click", x: 0.25, y: 0.25, button: "left", count: 1 });
  await dom.waitFor(() => /Done: clicked at 25%, 25% in Google Chrome\. The screen below is updating\./.test(c.textContent));
  assert.ok(c.querySelector(".ap-status.is-done"));
  // Clicking by typed coordinates, in right-click mode.
  await click([...c.querySelectorAll('[aria-label="Click mode"] [role="radio"]')].find((item) => item.dataset.value === "right"));
  await type(c.querySelector('[aria-label="X percent"]'), "80");
  await type(c.querySelector('[aria-label="Y percent"]'), "10");
  await click(button(c, "Click there"));
  await dom.waitFor(() => inputs(calls).length === 2);
  assert.deepEqual(inputs(calls)[1], { type: "click", x: 0.8, y: 0.1, button: "right", count: 1 });
  await type(c.querySelector('[aria-label="Text to type"]'), "hello");
  await click(button(c, "Type + Enter"));
  await dom.waitFor(() => inputs(calls).length === 4);
  assert.deepEqual(inputs(calls).slice(2), [{ type: "type", text: "hello" }, { type: "key", key: "enter" }]);
  await click(button(c, "Esc"));
  await dom.waitFor(() => inputs(calls).length === 5);
  await type(c.querySelector('[aria-label="Shortcut"]'), "cmd+l");
  await click(button(c, "Press"));
  await dom.waitFor(() => inputs(calls).length === 6);
  assert.deepEqual(inputs(calls).at(-1), { type: "key", key: "l", modifiers: ["cmd"] });
  await click(button(c, "Check what's in front"));
  await dom.waitFor(() => /In front: Google Chrome · Amazon/.test(c.textContent));
  await dom.waitFor(() => [...c.querySelectorAll('[aria-label="Apps you may use"] [role="radio"]')].length === 2);
  await click([...c.querySelectorAll('[aria-label="Apps you may use"] [role="radio"]')].find((item) => item.dataset.value === "/System/Applications/Notes.app"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/desktop/open"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/desktop/open")[2], { app: "/System/Applications/Notes.app" });
  await dom.waitFor(() => /Done: Notes is in front/.test(c.textContent));
});

test("aiming: the picture is requested at the display's resolution, a zoomed quarter maps clicks exactly, and the last click is marked", async () => {
  const { c, calls } = await open(full);
  const frame = await dom.waitFor(() => c.querySelector('[aria-label="Mac screen. Click to click there."]'));
  await dom.waitFor(() => frame.querySelector("img"));
  assert.ok(calls.some(([, route, , ]) => route === "/api/browser/desktop/screen"), "screenshots are fetched");
  const shotUrl = [...c.ownerDocument.defaultView.document.querySelectorAll("img")].length >= 0 && calls.find(([, route]) => route === "/api/browser/desktop/screen");
  assert.ok(shotUrl);
  await dom.waitFor(() => /100×60 px/.test(c.textContent), "the picture's pixel size is written next to the live readout");
  const zoomIn = button(c, "Zoom in");
  assert.equal(zoomIn.getAttribute("aria-pressed"), "false");
  await click(zoomIn);
  assert.equal(button(c, "Zoom out").getAttribute("aria-pressed"), "true");
  assert.match(c.textContent, /Zoom mode: click the picture where you want to look closer/);
  const zoomFrame = c.querySelector('[aria-label="Mac screen. Click where to zoom in."]');
  zoomFrame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  zoomFrame.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 100, clientY: 50 }));
  await settle(40);
  assert.equal(inputs(calls).length, 0, "choosing where to zoom never clicks the Mac");
  assert.match(c.textContent, /Zoomed view/);
  assert.match(c.textContent, /X 38%–63%, Y 38%–63% · 4×/);
  const zoomed = c.querySelector('[aria-label="Zoomed view. Click to click there."]');
  assert.ok(zoomed);
  zoomed.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
  zoomed.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 100, clientY: 50 }));
  await dom.waitFor(() => inputs(calls).length === 1);
  const sent = inputs(calls)[0];
  assert.equal(sent.type, "click");
  assert.equal(sent.x.toFixed(4), "0.4375");
  assert.equal(sent.y.toFixed(4), "0.4375");
  assert.ok(c.querySelector(".ap-mark-ring"), "the last click is marked");
  await click(button(c, "Move zoom right"));
  assert.match(c.textContent, /X 48%–73%, Y 38%–63%/);
  await click(button(c, "Zoom out"));
  assert.equal(c.querySelector('[aria-label="Zoomed view. Click to click there."]'), null);
  assert.ok(button(c, "Full screen"));
});

test("another agent holding the Mac reads as waiting, not failure", async () => {
  const { c } = await open(full, { busy: true });
  const frame = await dom.waitFor(() => c.querySelector('[aria-label="Mac screen. Click to click there."]'));
  await dom.waitFor(() => frame.querySelector("img"));
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  frame.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 50, clientY: 25 }));
  await dom.waitFor(() => /Not done: Grok is using the Mac\. Try again in 2 s\./.test(c.textContent));
  assert.ok(c.querySelector(".ap-status.is-wait"));
});

test("commands and file changes live on the same page with their results", async () => {
  const { c, calls } = await open(full);
  await type(await dom.waitFor(() => c.querySelector('[aria-label="Command"]')), "ls");
  await click(button(c, "Run"));
  await dom.waitFor(() => /a\.txt/.test(c.textContent));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/shell")[2], { command: "ls", root: 0, cwd: "" });
  await type(c.querySelector('[aria-label="Command"]'), "sudo ls");
  await click(button(c, "Run"));
  await dom.waitFor(() => /That needs your password/.test(c.textContent));
  await dom.waitFor(() => c.querySelector('[aria-label="New file name"]'));
  await type(c.querySelector('[aria-label="New file name"]'), "todo.md");
  await click(button(c, "New file"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/files/change"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/files/change")[2], { root: 0, op: "write", path: "todo.md", content: "" });
  await click([...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Read file notes.md"));
  await dom.waitFor(() => button(c, "Edit notes.md"));
  await dom.waitFor(() => /Done: read notes\.md/.test(c.textContent));
  await click(button(c, "Edit notes.md"));
  const editor = await dom.waitFor(() => c.querySelector('textarea[aria-label="Edit notes.md"]'));
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(editor, "# Notes\nmore");
  editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await click(button(c, "Save"));
  await dom.waitFor(() => calls.filter(([method, route]) => method === "POST" && route === "/api/browser/files/change").length === 2);
  assert.deepEqual(calls.filter(([method, route]) => method === "POST" && route === "/api/browser/files/change")[1][2], { root: 0, op: "write", path: "notes.md", content: "# Notes\nmore" });
});

test("Read only looks and never touches; Apps shows only its apps", async () => {
  const { c, calls } = await open({ ...full, preset: "readonly", presetName: "Read only", control: false, open: false, shell: false, write: false });
  assert.match(c.textContent, /You may look at the screen, read files\./);
  await dom.waitFor(() => c.querySelector('[aria-label="Mac screen"]'));
  assert.equal(c.querySelector('[aria-label="Mac screen. Click to click there."]'), null);
  assert.equal(c.querySelector('[aria-label="Text to type"]'), null);
  assert.equal(button(c, "Esc"), undefined);
  assert.equal(c.querySelector('[aria-label="Command"]'), null);
  assert.equal(c.querySelector('[aria-label="New file name"]'), null);
  assert.match(c.textContent, /Look only\. Nothing on this page clicks or types on the Mac/);
  assert.doesNotMatch(c.querySelector(".ap-abilities").textContent, /Click the picture/);
  assert.ok(!calls.some(([, route]) => route === "/api/browser/desktop/apps"));
  for (const view of views) await view.unmount(); views.clear();
  const apps = await open({ ...full, preset: "apps", presetName: "Apps", shell: false, write: false, roots: [], apps: [{ id: "/Applications/Google Chrome.app", name: "Google Chrome" }] });
  assert.match(apps.c.textContent, /You may see and use only the chosen apps, open apps\./);
  assert.deepEqual([...apps.c.querySelectorAll("h2")].map((h) => h.textContent.trim()), ["The Mac's screen", "Open an app on the Mac"]);
  assert.match(apps.c.textContent, /Only these apps\./);
});

test("Files describes only shared files, without offering absent screen controls", async () => {
  const { c, calls } = await open({ ...full, preset: "files", presetName: "Files", screen: false, control: false, open: false, shell: false, write: false });
  assert.equal(c.querySelector(".ap-abilities").textContent, "You may read files. Everything else is closed.");
  assert.doesNotMatch(button(c, "Reload page").title, /screen/);
  assert.ok(!calls.some(([, route]) => route.startsWith("/api/browser/desktop/")));
  await click(await dom.waitFor(() => button(c, "Read file notes.md")));
  await dom.waitFor(() => /Done: read notes\.md/.test(c.textContent));
  assert.match(c.querySelector(".ap-file pre").textContent, /# Notes/);
});

test("the agent page renders without React warnings", () => assert.deepEqual(dom.errors, []));
