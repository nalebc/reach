import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// A preset agent's panel in its sheet on Agents & people: the preset and what
// the agent is using now, Pause and Resume; the sheet's Edit access (the
// AccessEditor) changes the preset.
let dom, React, BrowserAgents, AccessEditor;
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
const device = { name: "My Mac", roots: [{ id: 0, path: "/Users/me", name: "Home" }], capabilities: { screen: true } };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const chrome = { id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome" };
const session = (id, overrides = {}) => ({
  id, name: "Muse", kind: "agent", status: "accepted", createdAt: Date.now() - 60000, expiresAt: Date.now() + 900000,
  folders: ["/Users/me"], pendingApprovals: 0, activity: { state: "idle" },
  scopes: ["device", "browser:read", "files:read", "browser:write", "browser:screen", "browser:control", "browser:open", "browser:shell"],
  policy: { invite: true, browser: true, preset: "full", roots: ["/Users/me"], hidden: [{ id: "/System/Applications/Messages.app", name: "Messages" }] },
  preset: "full", using: { at: Date.now(), kind: "click", app: "Google Chrome", bundle: "com.google.Chrome", name: "Muse" }, holdsMac: true,
  ...overrides,
});
before(async () => {
  dom = await startDom();
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ({ default: BrowserAgents } = await dom.load("/src/BrowserAgents.tsx"));
  ({ default: AccessEditor } = await dom.load("/src/AccessEditor.tsx"));
});
after(async () => dom?.close());
const views = new Set();
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
const button = (root, text) => [...root.querySelectorAll("button")].find((entry) => entry.textContent.trim() === text);
const click = async (element) => { assert.ok(element); element.click(); await settle(40); };
function mock(agents) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || "GET", route, body]);
    if (route === "/api/browser/agents") return reply({ agents: agents(), at: Date.now() });
    if (route === "/api/agents/browser-requests" || route === "/api/agents/browser-terminal-history" || route === "/api/agents/admissions") return reply([]);
    if (route === "/api/agents/browser-options") return reply({ terminals: [], desktopAvailable: true, presetApps: [{ ...chrome, running: true, protected: false }, { id: "/System/Applications/Messages.app", name: "Messages", bundleId: "com.apple.MobileSMS", running: true, protected: false }] });
    if (route === "/api/browser/agents/pause") return reply({ clientId: body.clientId, paused: body.paused });
    if (route === "/api/browser/agents/reopen") return reply({ clientId: body.clientId, joinBy: Date.now() + 900000 });
    if (route.startsWith("/api/guests/") && route.endsWith("/access")) return reply({ id: "muse-1", scopes: [], policy: { preset: body.preset } });
    if (route === "/api/files") return reply({ items: [] });
    return reply({ error: `Unexpected ${route}` }, 404);
  };
  return calls;
}

const panel = (focus) => React.createElement(BrowserAgents, { peer, device, toast() {}, focus });
const editor = (client) => React.createElement(AccessEditor, { peer, device, client, onClose() {}, onSaved() {} });

test("the panel names the preset, what the agent is using, and pauses it", async () => {
  let paused = false;
  const calls = mock(() => [session("muse-1", paused ? { paused: true, holdsMac: false } : {}), session("grok-2", { name: "Grok", preset: "apps", policy: { invite: true, browser: true, preset: "apps", roots: [], apps: [chrome] }, folders: [], using: undefined, holdsMac: false })]);
  const view = await dom.render(panel("muse-1"));
  views.add(view);
  const c = view.container;
  await dom.waitFor(() => /Full control/.test(c.textContent));
  assert.match(c.textContent, /Using\s*Google Chrome/);
  assert.match(c.textContent, /Hidden from it\s*Messages/);
  assert.match(c.textContent, /Reads and changes/);
  assert.doesNotMatch(c.textContent, /view-only/i);
  await click(button(c, "Pause"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/agents/pause"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/agents/pause")[2], { clientId: "muse-1", paused: true });
  paused = true;
  await dom.waitFor(() => button(c, "Resume"));
  assert.match(c.textContent, /Paused · last in\s*Google Chrome/);
  const grok = await dom.render(panel("grok-2"));
  views.add(grok);
  await dom.waitFor(() => /Uses/.test(grok.container.textContent));
  assert.match(grok.container.textContent, /Uses.*Google Chrome/s);
  assert.ok(button(grok.container, "Pause"), "Apps agents can be paused too");
});

test("an Always agent's panel has no Reopen link, since its one link already works from any browser", async () => {
  mock(() => [
    session("muse-1", { standing: true, relink: true, expiresAt: Date.now() + 10 * 365 * 86400000 }),
  ]);
  const view = await dom.render(panel("muse-1"));
  views.add(view);
  await dom.waitFor(() => view.container.querySelector(".ag-facts"));
  assert.equal(button(view.container, "Reopen link"), undefined);
});

test("Edit access offers the presets and saves the chosen one", async () => {
  const calls = mock(() => [session("muse-1")]);
  const view = await dom.render(editor(session("muse-1")));
  views.add(view);
  const sheet = await dom.waitFor(() => dom.document.querySelector('[aria-label="Edit agent access"]'));
  const titles = [...sheet.querySelectorAll('[aria-label="Access preset"] input')].map((input) => [input.getAttribute("aria-label"), input.disabled]);
  assert.deepEqual(titles, [["Full control", false], ["Apps", false], ["Files", false], ["Read only", false]]);
  assert.equal(sheet.querySelector('[aria-label="Access preset"] input:checked').getAttribute("aria-label"), "Full control");
  await click(sheet.querySelector('[aria-label="Access preset"] input[aria-label="Read only"]'));
  await click(button(sheet, "Save"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/guests/muse-1/access"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/guests/muse-1/access")[2], {
    preset: "readonly", folders: [{ root: 0, path: "" }], hidden: [{ id: "/System/Applications/Messages.app" }],
  });
});

test("a Files agent has nothing to pause and cannot be raised into Full control or Apps", async () => {
  const reader = session("files-3", { name: "Reader", preset: "files", holdsMac: false, using: undefined, folders: ["/Users/me/Desktop"], policy: { invite: true, browser: true, preset: "files", roots: ["/Users/me/Desktop"], write: true } });
  mock(() => [reader]);
  const view = await dom.render(panel("files-3"));
  views.add(view);
  await dom.waitFor(() => /Files/.test(view.container.textContent));
  assert.equal(button(view.container, "Pause"), undefined, "nothing to pause: it never touches the Mac");
  const edit = await dom.render(editor(reader));
  views.add(edit);
  const sheet = await dom.waitFor(() => dom.document.querySelector('[aria-label="Edit agent access"]'));
  assert.equal(sheet.querySelector('[aria-label="Access preset"] input[aria-label="Full control"]').disabled, true);
  assert.equal(sheet.querySelector('[aria-label="Access preset"] input[aria-label="Apps"]').disabled, true);
  assert.match(sheet.textContent, /Needs a new invitation from your phone/);
  assert.equal(sheet.querySelector('[aria-label="Can edit files"]').checked, true);
});

test("agent cards render without React warnings", () => assert.deepEqual(dom.errors, []));
