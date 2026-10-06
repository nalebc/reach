import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, React, BrowserInvite, BrowserWorkspace, BrowserApprovalReview;
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
const apps = [
  { id: "safari", name: "Safari", mode: "control", protected: false },
  { id: "notes", name: "Notes", mode: "hidden", protected: false },
  { id: "terminal", name: "Terminal", mode: "hidden", protected: true, reason: "Command apps are protected" },
];
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const screenshot = () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "Content-Type": "image/jpeg" } });
const pending = (action) => ({ id: "app-request", clientId: "muse", name: "Muse", action, reason: "", status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 60000, sessionExpiresAt: Date.now() + 900000 });
before(async () => {
  dom = await startDom(); React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ({ default: BrowserInvite } = await dom.load("/src/BrowserInvite.tsx"));
  ({ default: BrowserWorkspace } = await dom.load("/src/BrowserWorkspace.tsx"));
  ({ BrowserApprovalReview } = await dom.load("/src/browser-approvals.tsx"));
});
after(async () => dom?.close());
const views = new Set();
const render = async (component) => { const view = await dom.render(component); views.add(view); return view; };
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
const button = (container, label) => [...container.querySelectorAll("button")].find((entry) => entry.textContent.trim() === label);
const click = async (element) => { assert.ok(element); element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await settle(40); };
const value = async (element, text) => {
  assert.ok(element);
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set.call(element, text);
  element.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await settle(30);
};
const loadImage = async (container) => {
  const image = await dom.waitFor(() => container.querySelector(".browser-app-surface img"));
  Object.defineProperties(image, { naturalWidth: { value: 1000, configurable: true }, naturalHeight: { value: 500, configurable: true } });
  image.getBoundingClientRect = () => ({ left: 20, top: 30, width: 200, height: 100, right: 220, bottom: 130 });
  dom.update(() => image.dispatchEvent(new dom.window.Event("load")));
  return image;
};

test("invitation grants chosen apps only and describes exact per-app permissions", async () => {
  let issued;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/agents/browser-options") return reply({ terminals: [], screenAvailable: true, appAccessAvailable: true, apps });
    if (route === "/api/agents/browser-invitations") {
      issued = JSON.parse(init.body);
      return reply({ invitation: "b".repeat(43), url: `https://mac.tail.ts.net/agent-browser#invite=${"b".repeat(43)}`, clientId: "fresh", expiresAt: Date.now() + 900000, joinBy: Date.now() + 60000 });
    }
    return reply({}, 404);
  };
  const view = await render(React.createElement(BrowserInvite, { peer, device: { name: "My Mac", roots: [] }, keyPeer: peer, onSetup() {}, onCreated() {} }));
  const c = view.container;
  await dom.waitFor(() => c.querySelector('[aria-label="Screen permission"]')?.disabled === false);
  assert.deepEqual([...c.querySelector('[aria-label="Screen permission"]').options].map((option) => option.value), ["off", "apps"]);
  await value(c.querySelector('[aria-label="Screen permission"]'), "apps");
  assert.equal(c.querySelector('[aria-label="Safari access"]').value, "hidden", "catalog modes never carry over into a new invite");
  assert.equal(c.querySelector('[aria-label="Terminal access"]').disabled, true);
  await value(c.querySelector('[aria-label="Safari access"]'), "control");
  await value(c.querySelector('[aria-label="Notes access"]'), "view");
  await click(button(c, "Create invite link"));
  assert.equal(issued.screen, "apps");
  assert.deepEqual(issued.appAccess, [{ id: "safari", mode: "control" }, { id: "notes", mode: "view" }]);
  const prompt = c.querySelector('[aria-label="AI browser invitation message"]').value;
  assert.match(prompt, /"Safari" \(view and control directly\)/);
  assert.match(prompt, /"Notes" \(view only\)/);
  assert.match(prompt, /Other apps are hidden; ask for access/);
  assert.match(prompt, /Never invite anyone/);
  assert.match(c.textContent, /Reach on this Mac is locked/);
});

test("owner app approval is a simple session decision with no desktop capture or action batch", async () => {
  const calls = []; let resolved = 0;
  const item = pending({ type: "app-access", appId: "notes", appName: "Notes", mode: "control" });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([new URL(url).pathname, init.method, init.body && JSON.parse(init.body)]);
    return reply({ ...item, status: "executed" });
  };
  const view = await render(React.createElement(BrowserApprovalReview, { peer, item, onClose() {}, onResolved() { resolved++; } }));
  const c = view.container;
  assert.match(c.textContent, /Allow Muse to use Notes/);
  assert.match(c.textContent, /signed-in accounts/);
  assert.match(c.textContent, /Access ends at/);
  assert.equal(c.querySelector("img"), null);
  assert.equal(calls.length, 0);
  await click(button(c, "Allow for this session"));
  assert.equal(resolved, 1);
  assert.deepEqual(calls, [["/api/agents/browser-requests/app-request", "POST", { decision: "approve" }]]);
});

test("guest clicks and types directly into an allowed window; hidden apps require owner access", async () => {
  const calls = []; let catalog = apps.map((app) => ({ ...app })); let records = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const parsed = new URL(url), route = parsed.pathname, method = init.method || "GET";
    const body = init.body && JSON.parse(init.body); calls.push([method, route, body, parsed.search]);
    if (route === "/api/browser") return reply({ name: "Muse", expiresAt: Date.now() + 900000, roots: [], terminals: [], screen: "apps" });
    if (route === "/api/browser/apps") return reply({ apps: catalog, requests: records });
    if (route === "/api/browser/apps/windows") return reply({ windows: [{ id: `${parsed.searchParams.get("appId")}-target`, title: "A shared window", width: 1000, height: 500 }] });
    if (route === "/api/browser/apps/screen") return screenshot();
    if (route === "/api/browser/apps/input") return reply({ ok: true });
    if (route === "/api/browser/apps/requests") { const record = pending({ type: "app-access", appId: body.appId, appName: "Notes", mode: body.mode }); records = [record]; return reply(record); }
    return reply({ error: "Unexpected request" }, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  const c = view.container;
  const image = await loadImage(c);
  image.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 70, clientY: 105 }));
  await settle(30);
  c.querySelector(".browser-app-surface").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  await settle(50);
  assert.deepEqual(calls.filter(([method, route]) => method === "POST" && route.endsWith("/input")).map(([, , body]) => body), [
    { target: "safari-target", action: { type: "click", x: 0.25, y: 0.75 } },
    { target: "safari-target", action: { type: "text", text: "a" } },
  ]);
  assert.equal(calls.some(([, route]) => route === "/api/browser/screen" || route === "/api/browser/requests"), false, "app access never requests full desktop capture or batches");
  await value(c.querySelector('[aria-label="Shared app"]'), "notes");
  assert.equal(c.querySelector(".browser-app-surface img"), null);
  assert.equal(calls.some(([, route, , query]) => route.endsWith("/windows") && query.includes("notes")), false, "hidden app titles are not queried");
  await click(button(c, "Ask to control"));
  assert.deepEqual(calls.find(([method, route]) => method === "POST" && route.endsWith("/requests"))[2], { appId: "notes", mode: "control" });
  assert.match(c.textContent, /Waiting for the owner to allow control of Notes/);
  catalog = catalog.map((app) => app.id === "notes" ? { ...app, mode: "view" } : app); records = [];
  await click(button(c, "Refresh apps"));
  const notesImage = await loadImage(c);
  const count = calls.filter(([method]) => method === "POST").length;
  notesImage.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 70, clientY: 105 }));
  await settle(30);
  assert.equal(calls.filter(([method]) => method === "POST").length, count, "view-only grant never sends input");
  await value(c.querySelector('[aria-label="Shared app"]'), "terminal");
  assert.equal(c.querySelector(".browser-app-surface img"), null);
  assert.equal(button(c, "Ask to control"), undefined);
  assert.match(c.textContent, /Command apps are protected/);
});

test("selection change cancels pending image fetch and cannot display the old app", async () => {
  let release, captureSignal;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/browser") return reply({ name: "Muse", expiresAt: Date.now() + 900000, roots: [], terminals: [], screen: "apps" });
    if (route === "/api/browser/apps") return reply({ apps, requests: [] });
    if (route === "/api/browser/apps/windows") return reply({ windows: [{ id: "old-target", title: "Old window", width: 1000, height: 500 }] });
    if (route === "/api/browser/apps/screen") { captureSignal = init.signal; return await new Promise((resolve) => { release = () => resolve(screenshot()); }); }
    return reply({}, 404);
  };
  const view = await render(React.createElement(BrowserWorkspace, { peer, onEnd() {} }));
  const c = view.container;
  await dom.waitFor(() => release);
  await value(c.querySelector('[aria-label="Shared app"]'), "notes");
  assert.equal(captureSignal.aborted, true);
  release(); await settle(50);
  assert.equal(c.querySelector(".browser-app-surface img"), null);
  assert.match(c.textContent, /Notes is hidden/);
});

test("app UI does not emit React warnings", () => assert.deepEqual(dom.errors, []));
