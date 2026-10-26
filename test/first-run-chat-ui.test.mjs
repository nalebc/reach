import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDom, settle } from "./dom/harness.mjs";
import { cleanSessions } from "./helpers/clean-machine.mjs";

// First-run matrix A2 and A12: the Chat tab on a computer with no agents.
// What the phone renders comes from Reach's real Chat adapter on a clean
// computer (test/helpers/clean-machine.mjs), not from a hand-written answer:
// a hand-written `errors: {}` is how a red "Codex is not installed" alert
// went unseen.
const peer = { id: "mac", name: "Studio", url: "https://reach.test", token: "t", platform: "darwin" };
const MAC_OPENCLAW = { agent: "openclaw", name: "OpenClaw", command: "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard" };
let openclawPlan = MAC_OPENCLAW;
let dir, clean, dom, React, EverythingChat, HomeLive;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-clean-chat-"));
  const sessions = await cleanSessions(dir);
  try {
    clean = { list: await sessions.list({ fresh: true }), health: await sessions.health({ fresh: true }) };
  } finally {
    sessions.close();
  }
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      "/api/sessions/agent-install/claude": () => ({ agent: "claude", name: "Claude Code", command: "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash" }),
      "/api/sessions/agent-install/codex": () => ({ agent: "codex", name: "Codex", command: "npm install -g @openai/codex" }),
      "/api/sessions/agent-install/openclaw": () => openclawPlan,
      "/api/terminals": () => [],
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/clients": () => ({ current: "me", clients: [] }),
    },
  });
  dom.window.HTMLDialogElement.prototype.showModal ??= function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close ??= function () {
    this.open = false;
  };
  React = dom.React;
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
  ({ default: HomeLive } = await dom.load("/src/HomeLive.tsx"));
});
after(async () => {
  await dom?.close();
  await fs.rm(dir, { recursive: true, force: true });
});
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const text = () => dom.document.body.textContent;
const feed = (over = {}) => ({
  sessions: clean.list.sessions,
  errors: clean.list.errors,
  health: clean.health,
  healthChecked: true,
  failure: "",
  reload: async () => {},
  recheck: () => {},
  ...over,
});

test("nothing installed: Chat offers agents to add, with no error and no Start button", async () => {
  dom.window.localStorage.removeItem("reach.chatAgent");
  const view = await dom.render(React.createElement(EverythingChat, { peer, feed: feed() }));
  await settle(50);
  const alerts = $$("[role=alert]").map((a) => a.textContent);
  assert.deepEqual(alerts, [], "a missing agent isn't an error");
  const add = await dom.waitFor(() => dom.document.querySelector('[aria-label="Add an agent"]'));
  for (const name of ["Claude Code", "Codex", "OpenClaw"]) {
    const row = [...add.querySelectorAll("li")].find((li) => li.textContent.includes(name));
    assert.ok(row, `${name} is offered`);
    assert.ok([...row.querySelectorAll("button")].some((b) => /Install/.test(b.textContent)), `${name} can be installed`);
  }
  const gemini = [...add.querySelectorAll("li")].find((li) => li.textContent.includes("Gemini"));
  assert.ok(gemini?.querySelector("a[href^='https://']"), "Gemini CLI links to its maker");
  assert.ok(!$$("button").some((b) => /Start a conversation/.test(b.textContent)), "nothing to start a chat with");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("Install on a row shows that agent's own command first", async () => {
  const view = await dom.render(React.createElement(EverythingChat, { peer, feed: feed() }));
  const add = await dom.waitFor(() => dom.document.querySelector('[aria-label="Add an agent"]'));
  const row = [...add.querySelectorAll("li")].find((li) => li.textContent.includes("OpenClaw"));
  [...row.querySelectorAll("button")].find((b) => /Install/.test(b.textContent)).click();
  const command = await dom.waitFor(() => dom.document.querySelector(".chat-setup-command"));
  assert.equal(command.textContent, MAC_OPENCLAW.command);
  await view.unmount();
});

// A Windows PC (owner, Oct 13: OpenClaw "installed, set up and given keys
// from the phone on both, natively"): OpenClaw is offered there too, with
// its own installer, and what Reach adds first is said before the tap.
test("a Windows PC offers OpenClaw too: its own installer, what it needs first, and no Mac", async () => {
  const pc = { ...peer, id: "pc", name: "Desk", platform: "win32" };
  openclawPlan = {
    agent: "openclaw",
    name: "OpenClaw",
    command: "& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard",
    note: "OpenClaw needs Node 24.16 or newer, and this Windows PC has Node 22.12.0. Reach adds a Node for OpenClaw only first, with OpenClaw's own installer, and keeps this Windows PC's Node as it is.",
  };
  try {
    dom.window.localStorage.removeItem("reach.chatAgent");
    const view = await dom.render(React.createElement(EverythingChat, { peer: pc, feed: feed() }));
    const add = await dom.waitFor(() => dom.document.querySelector('[aria-label="Add an agent"]'));
    const row = [...add.querySelectorAll("li")].find((li) => li.textContent.includes("OpenClaw"));
    assert.ok(row, "OpenClaw is offered on Windows");
    [...row.querySelectorAll("button")].find((b) => /Install/.test(b.textContent)).click();
    const command = await dom.waitFor(() => dom.document.querySelector(".chat-setup-command"));
    assert.equal(command.textContent, openclawPlan.command);
    assert.ok([...row.querySelectorAll("p")].some((p) => p.textContent === openclawPlan.note), "the Node it adds is said first");
    assert.match(add.textContent, /Windows PC/);
    assert.doesNotMatch(add.textContent, /\bMac\b|macOS/);
    await view.unmount();
  } finally {
    openclawPlan = MAC_OPENCLAW;
  }
});

test("before the computer has said what it has, Chat doesn't offer to start one", async () => {
  const view = await dom.render(
    React.createElement(EverythingChat, { peer, feed: feed({ health: [], healthChecked: false }) }),
  );
  await settle(50);
  assert.ok(!$$("button").some((b) => /Start a conversation/.test(b.textContent)), text());
  await view.unmount();
});

// A10: Home with nothing running names no agent the computer doesn't have.
test("Home with no agents or actions hides the empty activity section", async () => {
  const view = await dom.render(
    React.createElement(HomeLive, {
      features: { terminal: true, codex: false, screen: false, desktopTerminals: false, shortcuts: false, owner: true, writeFiles: false },
      device: { name: "Studio", roots: [] },
      peer,
      active: "mac",
      connections: { mac: { state: "connected" } },
      connection: "Direct connection",
      terminals: [],
      chats: [],
      agentSessions: [],
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
    }),
  );
  await settle();
  assert.equal(dom.document.querySelector(".home-section"), null);
  assert.equal(dom.document.querySelector(".home-plus"), null);
  await view.unmount();
});

// N3: signed in from the browser, Home's line links to the Tailscale app.
test("Home's connection line links to the Tailscale app when signed in from the browser", async () => {
  const view = await dom.render(
    React.createElement(HomeLive, {
      features: { terminal: true, codex: false, screen: false, desktopTerminals: false, shortcuts: false, owner: true, writeFiles: false },
      device: { name: "Studio", roots: [] },
      peer,
      active: "mac",
      connections: { mac: { state: "connected" } },
      connection: "Tailscale in browser",
      appLink: "https://apps.apple.com/app/tailscale/id1470499037",
      terminals: [],
      chats: [],
      agentSessions: [],
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
    }),
  );
  const link = await dom.waitFor(() => dom.document.querySelector(".home-app-link"));
  assert.equal(link.textContent, "Tailscale app · optional, potentially faster");
  assert.equal(link.getAttribute("href"), "https://apps.apple.com/app/tailscale/id1470499037");
  // No menu to open: the route is in Settings; Home says only how it is.
  assert.equal(link.closest(".home-connection").querySelector(".home-connection-line").textContent.trim(), "Connected");
  assert.equal(dom.document.querySelector(".home-connection details, .home-connection summary"), null);
  await view.unmount();
});
