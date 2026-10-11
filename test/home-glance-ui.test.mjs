import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Home at a glance: who else is on the computer, and chats that just
// finished keeping their circle.
const peer = { id: "mac", name: "Mac", url: "https://mac.test", token: "t", platform: "darwin" };
let dom, React, HomeLive;
// Who the computer says may use it (for the Access card).
let clients = [];
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/clients": () => ({ current: "me", clients }),
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

test("chats that just finished keep their circle a few minutes, marked done or failed", async () => {
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
  const ring = (name) => dom.document.querySelector(`.story[aria-label^="${name}"] .story-ring`);
  await dom.waitFor(() => ring("Fix login"));
  assert.ok(ring("Fix login").classList.contains("done"));
  assert.ok(ring("Fix login").querySelector(".story-mark"));
  assert.ok(ring("Broken build").classList.contains("failed"));
  assert.ok(ring("Working").classList.contains("active"));
  assert.equal(ring("Long done"), null);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("Access on Home: who's here or may come in, one tap to Agents & people, one to Invite", async () => {
  const devices = [
    { id: "me", name: "This phone", kind: "phone", self: true, activity: "connected" },
    { id: "p2", name: "iPad", kind: "tablet", self: false, activity: "viewing" },
    { id: "a1", name: "Helper", kind: "computer", self: false, activity: "controlling", access: [{ kind: "agent", expiresAt: 0 }] },
  ];
  const later = Date.now() + 3600 * 1000;
  clients = [
    { id: "a1", name: "Helper", kind: "agent", status: "accepted", expiresAt: later },
    { id: "g1", name: "Sam", kind: "guest", status: "invited", expiresAt: later },
    { id: "a2", name: "Claude", kind: "agent", status: "pending", expiresAt: later },
    { id: "old", name: "Old", kind: "guest", expiresAt: Date.now() - 1000 },
  ];
  const went = [];
  const owner = { terminal: false, codex: false, screen: false, desktopTerminals: false, shortcuts: false, owner: true, writeFiles: false };
  const view = await dom.render(
    home({ agentSessions: [], features: owner, navigate: (to) => went.push(to), connections: { mac: { state: "connected", devices } } }),
  );
  const card = await dom.waitFor(() => dom.document.querySelector(".home-access"));
  assert.ok(card.classList.contains("controlling"));
  await dom.waitFor(() => card.querySelectorAll(".home-access-faces i").length === 4);
  assert.match(card.querySelector("strong").textContent, /Helper is controlling/);
  assert.equal(card.querySelector("small").textContent, "1 waiting for you");
  // Here now first (a green dot), then who else may come in; Helper once.
  assert.deepEqual(
    [...card.querySelectorAll(".home-access-faces i")].map((i) => i.className.trim()),
    ["here", "here agent", "", "agent"],
  );
  card.querySelector(".home-access-who").click();
  card.querySelector('[aria-label="Invite an agent or someone"]').click();
  assert.deepEqual(went, ["invite", "invite:new"]);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
  // Alone, nobody invited: the card still says so, and still invites.
  clients = [];
  const alone = await dom.render(home({ agentSessions: [], features: owner, connections: { mac: { state: "connected", devices: [devices[0]] } } }));
  const only = await dom.waitFor(() => dom.document.querySelector(".home-access"));
  assert.equal(only.querySelector("strong").textContent, "Only you");
  assert.equal(only.querySelector("small").textContent, "Agents & people");
  assert.ok(only.querySelector('[aria-label="Invite an agent or someone"]'));
  await alone.unmount();
  // Not the owner: no Access card.
  const guest = await dom.render(home({ agentSessions: [] }));
  await dom.waitFor(() => dom.document.querySelector(".home-live"));
  assert.equal(dom.document.querySelector(".home-access"), null);
  await guest.unmount();
});
