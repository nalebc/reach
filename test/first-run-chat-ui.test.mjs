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
      "/api/sessions/agent-install/openclaw": () => ({ agent: "openclaw", name: "OpenClaw", command: "npm install -g openclaw@latest" }),
      "/api/terminals": () => [],
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
  assert.equal(command.textContent, "npm install -g openclaw@latest");
  await view.unmount();
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
test("Home's empty hint doesn't name agents that aren't installed", async () => {
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
  const hint = await dom.waitFor(() => dom.document.querySelector(".home-stories-hint"));
  assert.doesNotMatch(hint.textContent, /Codex|Claude/);
  assert.match(hint.textContent, /Start an agent or a terminal on Studio/);
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
  assert.equal(link.textContent, "faster with the app");
  assert.equal(link.getAttribute("href"), "https://apps.apple.com/app/tailscale/id1470499037");
  assert.match(link.closest("p").textContent, /Online · Tailscale in browser · faster with the app/);
  await view.unmount();
});
