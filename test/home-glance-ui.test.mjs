import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Home prioritizes requests and active presence, without an activity feed.
const peer = { id: "mac", name: "Mac", url: "https://mac.test", token: "t", platform: "darwin" };
let dom, React, HomeLive;
// An existing grant must not become a permanent Home inventory.
let clients = [];
// And the browser agents as the Mac lists them (a Response: it failed).
let agents = [];
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/clients": () => ({ current: "me", clients }),
      "/api/browser/agents": () => (agents instanceof Response ? agents : { agents, at: Date.now() }),
    },
  });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ({ default: HomeLive } = await dom.load("/src/HomeLive.tsx"));
});
after(() => dom?.close());

const minute = 60 * 1000;
const chat = (id, status, ago, extra = {}) => ({
  agent: "codex",
  id,
  title: id,
  status,
  updatedAt: Date.now() - ago,
  preview: "",
  archived: false,
  ...extra,
});
const home = (props = {}) =>
  React.createElement(HomeLive, {
    features: { terminal: false, codex: false, screen: false, desktopTerminals: false, shortcuts: false, owner: false, writeFiles: false },
    device: { name: "Mac", roots: [] },
    peer,
    active: "mac",
    connections: { mac: { state: "connected" } },
    connection: "Direct connection",
    terminals: [],
    chats: [],
    pending: [],
    decide() {},
    navigate() {},
    openChat() {},
    openTerminal() {},
    openMacTab() {},
    openAgentSession() {},
    onShortcuts() {},
    refreshSessions() {},
    toast() {},
    ...props,
  });

test("Home does not repeat active or recent chats as an activity section", async () => {
  const view = await dom.render(
    home({
      agentSessions: [
        chat("Fix login", "idle", 2 * minute),
        chat("Broken build", "error", 1 * minute),
        chat("Long done", "idle", 30 * minute),
        chat("Working", "running", 0),
      ],
    }),
  );
  assert.equal(dom.document.querySelector(".home-section, .home-stories, .home-now"), null);
  assert.doesNotMatch(view.container.textContent, /Fix login|Broken build|Long done|Working/);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

const owner = { terminal: false, codex: false, screen: false, owner: true };
const me = { id: "me", name: "This phone", kind: "phone", self: true, activity: "connected" };

test("Home shows active presence and urgent requests first, with one tap to manage access", async () => {
  const devices = [me,
    { id: "p2", name: "iPad", kind: "tablet", self: false, activity: "viewing" },
    { id: "a1", name: "Helper", kind: "computer", self: false, activity: "controlling" },
  ];
  const went = [];
  const view = await dom.render(home({ features: owner, navigate: to => went.push(to),
    pending: [{ id: "request", name: "Sam", scopes: ["screen"] }],
    connections: { mac: { state: "connected", devices } } }));
  const notice = dom.document.querySelector(".home-presence");
  assert.equal(notice.textContent, "Helper is controlling");
  assert.ok(notice.classList.contains("controlling"));
  assert.deepEqual([...dom.document.querySelector(".home-live").children].slice(0, 3).map(el => el.className),
    ["home-needs", "home-presence controlling", "home-hero"]);
  notice.click();
  assert.deepEqual(went, ["invite"]);
  assert.equal(dom.document.querySelector(".home-access"), null);
  await view.unmount();
  const watching = await dom.render(home({ features: owner,
    connections: { mac: { state: "connected", devices: devices.slice(0, 2) } } }));
  assert.equal(dom.document.querySelector(".home-presence").textContent, "1 other device is connected");
  await watching.unmount();
  assert.deepEqual(dom.errors, []);
});

test("quiet Home has no permanent access inventory, and stale presence stays hidden after disconnect", async () => {
  clients = [{ id: "g", name: "Sam", kind: "guest", status: "accepted", expiresAt: Date.now() + 3600000 }];
  for (const [features, state, devices] of [
    [owner, "connected", [me]],
    [owner, "disconnected", [me, { id: "old", name: "Old device" }]],
    [{ owner: false }, "connected", [me, { id: "guest", name: "Other guest" }]],
  ]) {
    const view = await dom.render(home({ features, connections: { mac: { state, devices } } }));
    assert.equal(dom.document.querySelector(".home-access, .home-presence"), null);
    assert.doesNotMatch(view.container.textContent, /with access|Only you|Sam/);
    await view.unmount();
  }
  clients = [];
  assert.deepEqual(dom.errors, []);
});

test("connection details distinguish lost access from reconnecting and never call a disconnected computer offline", async () => {
  let update;
  function Host() {
    const [state, setState] = React.useState("connecting");
    update = setState;
    return home({ connections: { mac: { state } } });
  }
  const view = await dom.render(React.createElement(Host));
  const summary = () => dom.document.querySelector(".home-connection summary").textContent;
  assert.equal(summary(), "Connecting…");
  for (const [state, label] of [["connected", "Connected"], ["connecting", "Reconnecting…"], ["disconnected", "Connection lost"], ["denied", "Access needed"]]) {
    dom.update(() => update(state));
    await dom.waitFor(() => summary() === label);
    assert.doesNotMatch(view.container.textContent, /Offline/);
  }
  assert.match(view.container.textContent, /Restore this device’s access/);
  await view.unmount();
});
