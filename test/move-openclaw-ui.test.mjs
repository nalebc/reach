import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Moving chats to and from OpenClaw on the phone: a Claude Code chat offers
// every app that can take it; moved to OpenClaw, the OpenClaw space opens on
// the new session (its history there as OpenClaw's notes); an OpenClaw chat
// offers to continue in Codex or Claude Code.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const CLAUDE = "11111111-2222-4333-8444-555555555555";
const NEW = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const KEY = "agent:main:reach-1a2b3c4d";
const claudeChat = {
  agent: "claude",
  id: CLAUDE,
  title: "Login page",
  cwd: "/work/app",
  branch: "main",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "Built it.",
  archived: false,
  model: "claude-opus-5-5",
  effort: "max",
  mode: "auto",
};
const health = [
  { agent: "codex", installed: true, signedIn: true, supported: true },
  { agent: "claude", installed: true, signedIn: true, supported: true },
  { agent: "openclaw", installed: true, signedIn: false, supported: true },
  { agent: "gemini", installed: true, signedIn: false, supported: false },
];
const claw = { listed: [], moves: [] };
let dom, React, EverythingChat;
before(async () => {
  const live = { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 };
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      [`/api/sessions/claude/${CLAUDE}`]: () => ({
        session: claudeChat,
        items: [
          { id: "u1", role: "user", kind: "text", text: "Build the login page" },
          { id: "a1", role: "assistant", kind: "text", text: "Built it." },
        ],
        before: null,
      }),
      [`/api/sessions/claude/${CLAUDE}/live`]: async () => (await settle(60), live),
      [`/api/sessions/claude/${CLAUDE}/fork`]: (init) => {
        claw.moves.push(["claude", JSON.parse(init.body).to]);
        claw.listed = [{ key: KEY, title: "Login page", agentId: "main", channel: "webchat", updatedAt: Date.now(), model: "claude-opus-4-6", status: "idle" }];
        return { agent: "openclaw", id: KEY };
      },
      "/api/sessions/openclaw/overview": () => ({ connected: true, sessions: claw.listed, approvals: [], revision: 1 }),
      "/api/sessions/openclaw/history": () => ({
        session: claw.listed[0],
        items: [{ id: "n1", role: "assistant", text: "[Moved from Claude Code]\n\n**You:** Build the login page\n\n**Claude Code:** Built it.", tool: false }],
        streaming: "",
        error: "",
        approvals: [],
        revision: 1,
        mayHaveOlder: false,
      }),
      // The Codex chat a move opens (its page, and its held live request).
      [`/api/sessions/codex/${NEW}`]: () => ({
        session: { ...claudeChat, agent: "codex", id: NEW, model: "gpt-6-astra", movedFrom: { agent: "openclaw", id: KEY, title: "Login page" } },
        items: [{ id: "moved:openclaw", role: "system", kind: "notice", text: "Continued with Codex · earlier messages are from OpenClaw" }],
        before: null,
      }),
      [`/api/sessions/codex/${NEW}/live`]: async () => (await settle(60), live),
      [`/api/sessions/openclaw/${encodeURIComponent(KEY)}/fork`]: (init) => {
        claw.moves.push(["openclaw", JSON.parse(init.body).to]);
        return { agent: "codex", id: NEW };
      },
    },
  });
  React = dom.React;
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  claw.listed = [];
  claw.moves = [];
  dom.window.localStorage.setItem("reach.moveHint", "99");
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const $ = (s) => dom.document.querySelector(s);
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const button = (label) => $$("button").find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const rowFor = (name) => $$(".claw-move .move-item:not(.move-section-back)").find(r => r.querySelector(".move-item-text > span")?.textContent === name);

test("a chat offers every app that can take it, and moved to OpenClaw, opens there on the new session", async () => {
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions: [claudeChat], errors: {}, health, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
  views.push(view);
  await click(await dom.waitFor(() => $$("button").find((b) => b.getAttribute("aria-label")?.startsWith("Login page"))));
  await click(await dom.waitFor(() => button("More")));
  await click(await dom.waitFor(() => $(".as-details .move-continue")));
  const apps = () => $$(".as-details .move-item:not(.move-section-back)");
  const itemFor = (name) => apps().find((r) => r.textContent.startsWith(name));
  await dom.waitFor(() => itemFor("OpenClaw"));
  // Codex and OpenClaw; Gemini CLI listed too, greyed: Reach only reads it.
  assert.deepEqual(
    apps().map((r) => [r.querySelector(".move-item-text > span").textContent, r.disabled]),
    [["Codex", false], ["OpenClaw", false], ["Gemini CLI", true], ["Claude Code", false]],
  );
  await click(itemFor("OpenClaw"));
  // One tap says what happens; the next one moves it.
  await click($(".as-details .move-item.asking"));
  assert.deepEqual(claw.moves, [["claude", "openclaw"]]);
  // The OpenClaw space, on the new session, its moved history in it.
  await dom.waitFor(() => $(".claw-conversation"));
  await dom.waitFor(() => $(".claw-conversation").textContent.includes("Moved from Claude Code"));
  assert.match($(".claw-conversation h1").textContent, /Login page/);
  assert.deepEqual(dom.errors, []);
});

test("an OpenClaw chat continues in Codex or Claude Code from its header", async () => {
  claw.listed = [{ key: KEY, title: "Login page", agentId: "main", channel: "webchat", updatedAt: Date.now(), model: "claude-opus-4-6", status: "idle" }];
  dom.window.localStorage.setItem("reach.chatAgent", "openclaw");
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions: [], errors: {}, health, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
  views.push(view);
  await click(await dom.waitFor(() => $$("button").find((b) => b.textContent.includes("Login page"))));
  await click(await dom.waitFor(() => button("Fork chat…")));
  await dom.waitFor(() => rowFor("Codex"));
  assert.deepEqual(
    $$(".claw-move .move-item:not(.move-section-back) .move-item-text > span").map((s) => s.textContent),
    ["Codex", "Claude Code", "Gemini CLI", "OpenClaw"],
  );
  await click(rowFor("Codex"));
  await click(rowFor("Codex"));
  await dom.waitFor(() => claw.moves.length === 1);
  assert.deepEqual(claw.moves, [["openclaw", "codex"]]);
  // The Codex chat opens, continuing the OpenClaw one.
  await dom.waitFor(() => $$(".as-divider").some((d) => d.textContent.includes("earlier messages are from OpenClaw")));
  // And stays open: OpenClaw's own back entry, left as it closed, never
  // takes the new chat's entry with it (the chat closed itself, Oct 13).
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok($$(".as-divider").some((d) => d.textContent.includes("earlier messages are from OpenClaw")), "the Codex chat is still open");
  assert.equal(dom.window.history.state?.reachChat, true, "the open chat has its back entry");
});
