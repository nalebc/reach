import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Home at a glance: who else is on the computer, and chats that just
// finished keeping their circle.
const peer = { id: "mac", name: "Mac", url: "https://mac.test", token: "t", platform: "darwin" };
let dom, React, HomeLive;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
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

test("who else is on the computer: a pill under its name, and who does what", async () => {
  const devices = [
    { id: "me", name: "This phone", kind: "phone", self: true, activity: "connected" },
    { id: "p2", name: "iPad", kind: "tablet", self: false, activity: "viewing" },
    { id: "a1", name: "Helper", kind: "computer", self: false, activity: "controlling", access: [{ kind: "agent", expiresAt: 0 }] },
  ];
  const view = await dom.render(
    home({
      agentSessions: [],
      features: { terminal: false, codex: false, screen: false, desktopTerminals: false, shortcuts: false, owner: true, writeFiles: false },
      connections: { mac: { state: "connected", devices } },
    }),
  );
  const pill = await dom.waitFor(() => dom.document.querySelector(".home-here"));
  assert.ok(pill.classList.contains("controlling"));
  assert.match(pill.textContent, /Helper is controlling/);
  pill.click();
  await dom.waitFor(() => dom.document.querySelectorAll(".home-here-row").length === 2);
  const rows = [...dom.document.querySelectorAll(".home-here-row")].map((r) => r.textContent);
  assert.deepEqual(rows, ["iPadWatching the screen", "HelperControlling the screen · Agent"]);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
  // Alone on it: no pill.
  const alone = await dom.render(home({ agentSessions: [], connections: { mac: { state: "connected", devices: [devices[0]] } } }));
  await dom.waitFor(() => dom.document.querySelector(".home-live"));
  assert.equal(dom.document.querySelector(".home-here"), null);
  await alone.unmount();
});
