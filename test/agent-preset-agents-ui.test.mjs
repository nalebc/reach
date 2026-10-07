import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Settings → Agents for preset sessions: the card says the preset and what the
// agent is using now, Pause and Resume work, and Edit access changes the preset.
let dom, React, BrowserAgents;
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

test("the card names the preset, what the agent is using, and pauses it", async () => {
  let paused = false;
  const calls = mock(() => [session("muse-1", paused ? { paused: true, holdsMac: false } : {}), session("grok-2", { name: "Grok", preset: "apps", policy: { invite: true, browser: true, preset: "apps", roots: [], apps: [chrome] }, folders: [], using: undefined, holdsMac: false })]);
  const view = await dom.render(React.createElement(BrowserAgents, { peer, device, invite() {}, toast() {} }));
  views.add(view);
  const c = view.container;
  const muse = await dom.waitFor(() => c.querySelector('[data-agent-id="muse-1"]'));
  assert.match(muse.querySelector(".ag-pill").textContent, /Using Google Chrome/);
  assert.match(muse.textContent, /Full control/);
  assert.match(muse.textContent, /Hidden from it\s*Messages/);
  assert.match(muse.textContent, /Reads and changes/);
  const grok = c.querySelector('[data-agent-id="grok-2"]');
  await click(grok.querySelector(".ag-agent-head"));
  assert.match(grok.textContent, /Apps/);
  assert.match(grok.textContent, /Uses.*Google Chrome/s);
  assert.doesNotMatch(c.textContent, /view-only/i);
  await click(button(muse, "Pause"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/agents/pause"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/agents/pause")[2], { clientId: "muse-1", paused: true });
  paused = true;
  await dom.waitFor(() => /Paused/.test(c.querySelector('[data-agent-id="muse-1"] .ag-pill').textContent));
  assert.ok(button(c.querySelector('[data-agent-id="muse-1"]'), "Resume"));
  assert.ok(!button(grok, "Pause") || grok.textContent.includes("Pause"), "Apps agents can be paused too");
});

test("an Always agent says Always, and Reopen link lets it come back in a new browser with the same link", async () => {
  const toasts = [];
  const calls = mock(() => [
    session("muse-1", { standing: true, relink: true, expiresAt: Date.now() + 10 * 365 * 86400000 }),
    session("grok-2", { name: "Grok", holdsMac: false, using: undefined }),
  ]);
  const view = await dom.render(React.createElement(BrowserAgents, { peer, device, invite() {}, toast: (message) => toasts.push(message) }));
  views.add(view);
  const c = view.container;
  const muse = await dom.waitFor(() => c.querySelector('[data-agent-id="muse-1"]'));
  assert.match(muse.querySelector(".ag-agent-title small").textContent, /^Always/);
  assert.match(muse.textContent, /When you end it/);
  assert.equal(button(c.querySelector('[data-agent-id="grok-2"]'), "Reopen link"), undefined, "only agents whose link can be reopened");
  await click(button(muse, "Reopen link"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/browser/agents/reopen"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/browser/agents/reopen")[2], { clientId: "muse-1" });
  await dom.waitFor(() => toasts.length);
  assert.match(toasts[0], /Muse can open the same link again for 15 minutes/);
});

test("Edit access offers the presets and saves the chosen one", async () => {
  const calls = mock(() => [session("muse-1")]);
  const view = await dom.render(React.createElement(BrowserAgents, { peer, device, invite() {}, toast() {} }));
  views.add(view);
  const c = view.container;
  const muse = await dom.waitFor(() => c.querySelector('[data-agent-id="muse-1"]'));
  await click(button(muse, "Edit access"));
  const editor = await dom.waitFor(() => dom.document.querySelector('[aria-label="Edit agent access"]'));
  const titles = [...editor.querySelectorAll('[aria-label="Access preset"] input')].map((input) => [input.getAttribute("aria-label"), input.disabled]);
  assert.deepEqual(titles, [["Full control", false], ["Apps", false], ["Files", false], ["Read only", false]]);
  assert.equal(editor.querySelector('[aria-label="Access preset"] input:checked').getAttribute("aria-label"), "Full control");
  await click(editor.querySelector('[aria-label="Access preset"] input[aria-label="Read only"]'));
  await click(button(editor, "Save"));
  await dom.waitFor(() => calls.some(([method, route]) => method === "POST" && route === "/api/guests/muse-1/access"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route === "/api/guests/muse-1/access")[2], {
    preset: "readonly", folders: [{ root: 0, path: "" }], hidden: [{ id: "/System/Applications/Messages.app" }],
  });
});

test("a Files agent cannot be raised into Full control or Apps from the editor", async () => {
  mock(() => [session("files-3", { name: "Reader", preset: "files", holdsMac: false, using: undefined, folders: ["/Users/me/Desktop"], policy: { invite: true, browser: true, preset: "files", roots: ["/Users/me/Desktop"], write: true } })]);
  const view = await dom.render(React.createElement(BrowserAgents, { peer, device, invite() {}, toast() {} }));
  views.add(view);
  const c = view.container;
  const card = await dom.waitFor(() => c.querySelector('[data-agent-id="files-3"]'));
  await click(card.querySelector(".ag-agent-head"));
  assert.match(card.textContent, /Files/);
  assert.equal(button(card, "Pause"), undefined, "nothing to pause: it never touches the Mac");
  await click(button(card, "Edit access"));
  const editor = await dom.waitFor(() => dom.document.querySelector('[aria-label="Edit agent access"]'));
  assert.equal(editor.querySelector('[aria-label="Access preset"] input[aria-label="Full control"]').disabled, true);
  assert.equal(editor.querySelector('[aria-label="Access preset"] input[aria-label="Apps"]').disabled, true);
  assert.match(editor.textContent, /Needs a new invitation from your phone/);
  assert.equal(editor.querySelector('[aria-label="Can edit files"]').checked, true);
});

test("agent cards render without React warnings", () => assert.deepEqual(dom.errors, []));
