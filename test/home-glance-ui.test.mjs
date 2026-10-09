import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Home at a glance: the Ask bar, usage under the computer's name, and chats
// that just finished keeping their circle.
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
const health = [
  {
    agent: "codex",
    installed: true,
    signedIn: true,
    usable: true,
    usage: { available: true, windows: [{ id: "5h", label: "5 hours", usedPercent: 62, resetsAt: null, severity: "" }] },
  },
  {
    agent: "claude",
    installed: true,
    signedIn: true,
    usable: false,
    resetsAt: Date.now() + 3600000,
    usage: { available: true, windows: [] },
  },
  // Usage unknown: no chip, never shown as having usage.
  { agent: "gemini", installed: true, signedIn: false },
];
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
    agentHealth: health,
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

test("usage chips show known usage only, and open the usage sheet", async () => {
  const view = await dom.render(home({ agentSessions: [] }));
  await dom.waitFor(() => dom.document.querySelector(".home-usage"));
  const chips = [...dom.document.querySelectorAll(".home-usage-chip")].map((c) => [c.className, c.textContent]);
  assert.deepEqual(chips, [
    ["home-usage-chip rest", "62%"],
    ["home-usage-chip out", "Out"],
  ]);
  dom.document.querySelector(".home-usage").click();
  await dom.waitFor(() => dom.document.querySelector(".usage-sheet"));
  await view.unmount();
});

test("the Ask bar opens New conversation in the app last picked in Chat", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  const asked = [];
  const view = await dom.render(home({ agentSessions: [], compose: (agent) => asked.push(agent) }));
  const bar = await dom.waitFor(() => dom.document.querySelector(".home-ask"));
  assert.match(bar.textContent, /Ask Claude Code/);
  bar.click();
  assert.deepEqual(asked, ["claude"]);
  await view.unmount();
  // Without Chat (a guest), no Ask bar.
  const guest = await dom.render(home({ agentSessions: [] }));
  await dom.waitFor(() => dom.document.querySelector(".home-usage"));
  assert.equal(dom.document.querySelector(".home-ask"), null);
  await guest.unmount();
});
