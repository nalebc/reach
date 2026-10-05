import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Claude out of usage, inside a Claude chat on the phone: Claude's card above
// the composer, in Claude Code's own words, with where to get more (Codex's
// chats had their banner; Claude's showed nothing until a message failed).
// Once only: the chat that hit the limit already ends on that card.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const ID = "11111111-2222-4333-8444-555555555555";
const LIMIT = "You've hit your session limit · resets 3:20pm (America/Vancouver)";
const session = {
  agent: "claude",
  id: ID,
  title: "Refactor auth",
  cwd: "/work/app",
  branch: "main",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
  model: "claude-opus-5-5",
  effort: "max",
  mode: "auto",
  live: { where: "claude-app", pid: 10, tty: null },
};
const page = { session, items: [] };
const live = { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 };
let dom, React, AgentSessionView;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      [`/api/sessions/claude/${ID}`]: () => page,
      // The real server holds this request until something changes.
      [`/api/sessions/claude/${ID}/live`]: async () => (await settle(60), live),
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/models": () => ({ models: [] }),
      "/api/sessions/commands": () => ({ commands: [] }),
    },
  });
  React = dom.React;
  ({ default: AgentSessionView } = await dom.load("/src/AgentSession.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const open = async (health) => {
  const view = await dom.render(
    React.createElement(AgentSessionView, { peer, session, siblings: [], health, logos: {}, onSelect() {}, onBack() {} }),
  );
  views.push(view);
  return view;
};
const outOfUsage = [
  { agent: "codex", installed: true, signedIn: true },
  { agent: "claude", installed: true, signedIn: true, usable: false, resetsAt: Date.parse("2026-10-05T22:20:00Z"), limit: LIMIT },
];
const cards = () => [...dom.document.querySelectorAll(".as-error.claude")];
const composerCard = () => dom.document.querySelector(".as-composer .as-error.claude");

test("Claude out of usage: its card above the composer, in its own words, with where to get more", async () => {
  page.items = [{ id: "u1", role: "user", kind: "text", text: "Refactor the auth module", at: Date.now() - 60000 }];
  await open(outOfUsage);
  await dom.waitFor(() => composerCard());
  const card = composerCard();
  assert.match(card.querySelector("header").textContent, /Usage limit reached/);
  assert.equal(card.querySelector("p").textContent, LIMIT);
  const more = card.querySelector("a.as-usage");
  assert.equal(more.textContent, "Get more usage");
  assert.equal(more.getAttribute("href"), "https://claude.ai/settings/usage");
  assert.deepEqual(dom.errors, []);
});

test("the chat that hit the limit shows its card once, not again above the composer", async () => {
  page.items = [
    { id: "u1", role: "user", kind: "text", text: "Try again", at: Date.now() - 60000 },
    { id: "e1", role: "system", kind: "error", text: LIMIT, detail: "rate_limit", at: Date.now() - 50000 },
  ];
  await open(outOfUsage);
  await dom.waitFor(() => cards().length > 0);
  await settle(100);
  assert.equal(cards().length, 1);
  assert.equal(composerCard(), null);
  assert.deepEqual(dom.errors, []);
});

test("with usage left, no card", async () => {
  page.items = [{ id: "u1", role: "user", kind: "text", text: "Hi", at: Date.now() }];
  await open([
    { agent: "codex", installed: true, signedIn: true },
    { agent: "claude", installed: true, signedIn: true, usable: true },
  ]);
  await dom.waitFor(() => dom.document.querySelector(".as-composer"));
  await settle(100);
  assert.equal(cards().length, 0);
  assert.deepEqual(dom.errors, []);
});
