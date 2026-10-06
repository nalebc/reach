import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Continuing a chat with the other agent, on the phone: offered at the agent
// on top of the chat, next to the models, and when an agent runs out of
// usage; the old chat links to where it went; the new one shows the old
// messages above a quiet line, as if forked in the same app.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const CLAUDE = "11111111-2222-4333-8444-555555555555";
const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const NEW = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const base = {
  title: "Login page",
  cwd: "/work/app",
  branch: "main",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
};
const claudeChat = (extra = {}) => ({ ...base, agent: "claude", id: CLAUDE, model: "claude-opus-5-5", effort: "max", mode: "auto", ...extra });
const codexChat = (extra = {}) => ({ ...base, agent: "codex", id: CODEX, model: "gpt-6-astra", effort: "medium", mode: "auto", ...extra });
const both = (extra = {}) => [
  { agent: "codex", installed: true, signedIn: true, ...extra.codex },
  { agent: "claude", installed: true, signedIn: true, ...extra.claude },
];
const said = [
  { id: "u1", role: "user", kind: "text", text: "Build the login page", at: Date.now() - 9000 },
  { id: "a1", role: "assistant", kind: "text", text: "Built it.", at: Date.now() - 8000 },
  { id: "u2", role: "user", kind: "text", text: "Now tests", at: Date.now() - 7000 },
  { id: "a2", role: "assistant", kind: "text", text: "Added them.", at: Date.now() - 6000 },
];
const mac = { pages: {}, moves: [] };
const live = { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 };
let dom, React, AgentSessionView, ChatList;
before(async () => {
  const routes = {
    "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
    "/api/sessions/commands": () => ({ commands: [] }),
    "/api/sessions/models": (init, href) =>
      href?.searchParams.get("agent") === "codex"
        ? {
            models: [{ id: "gpt-6-astra", name: "GPT-6 Astra", description: "", efforts: ["low", "medium", "high"], defaultEffort: "medium", images: true, isDefault: true, speeds: [] }],
            modes: [{ id: "auto", label: "Ask for approval" }],
            mode: "auto",
          }
        : { models: [], modes: [], mode: null },
  };
  for (const [agent, id] of [["claude", CLAUDE], ["codex", CODEX], ["codex", NEW]]) {
    routes[`/api/sessions/${agent}/${id}`] = () => mac.pages[`${agent}:${id}`];
    routes[`/api/sessions/${agent}/${id}/live`] = async () => (await settle(60), live);
    routes[`/api/sessions/${agent}/${id}/move`] = (init) => {
      mac.moves.push({ from: `${agent}:${id}`, body: JSON.parse(init.body) });
      return { agent: JSON.parse(init.body).to, id: NEW };
    };
  }
  dom = await startDom({ mobile: true, routes });
  React = dom.React;
  ({ default: AgentSessionView } = await dom.load("/src/AgentSession.tsx"));
  ({ default: ChatList } = await dom.load("/src/ChatList.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  mac.moves = [];
  // The hint has been seen enough unless a test says otherwise.
  dom.window.localStorage.setItem("reach.moveHint", "99");
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
const open = async (session, health = both(), items = said) => {
  mac.pages[`${session.agent}:${session.id}`] = { session, items, before: null };
  const selected = [];
  const view = await dom.render(
    React.createElement(AgentSessionView, { peer, session, siblings: [], health, logos: {}, onSelect: (s) => selected.push(s), onBack() {} }),
  );
  views.push(view);
  await dom.waitFor(() => $$(".as-user, .as-assistant").length >= Math.min(items.length, 1));
  return selected;
};
const offer = (scope = dom.document) => [...scope.querySelectorAll(".move-offer-row")];

test("only ⋯ offers it: no switcher in the header, nothing beside the models, out of usage or signed out", async () => {
  await open(claudeChat(), both({ claude: { usable: false, resetsAt: Date.now() + 3600000, limit: "You've hit your session limit" } }));
  await dom.waitFor(() => $(".usage-strip"));
  assert.equal(button("Switch conversations"), undefined);
  assert.equal($(".move-offer"), null);
  assert.equal($(".usage-strip .agent-logo"), null);
  for (const view of views.splice(0)) await view.unmount();
  await open(claudeChat(), both({ claude: { signedIn: false } }));
  await settle(100);
  assert.equal($(".move-offer"), null);
  await click(button("More"));
  assert.match((await dom.waitFor(() => $(".as-details .move-item"))).textContent, /^Continue in Codex/);
  assert.deepEqual(dom.errors, []);
});

test("a chat continued elsewhere ends with the way there; the new one shows the old messages above a quiet line", async () => {
  const selected = await open(claudeChat({ movedTo: [{ agent: "codex", id: NEW, at: Date.now() }] }));
  const link = await dom.waitFor(() => $(".move-continued button"));
  assert.match(link.textContent, /Continued in Codex/);
  await click(link);
  assert.equal(selected[0].id, NEW);
  for (const view of views.splice(0)) await view.unmount();
  // The moved chat: the old messages, the line, then its own.
  await open(codexChat({ id: NEW, movedFrom: { agent: "claude", id: CLAUDE, title: "Login page" } }), both(), [
    ...said,
    { id: "moved:claude:x", role: "system", kind: "notice", text: "Continued with Codex · earlier messages are from Claude Code" },
    { id: "n1", role: "user", kind: "text", text: "Ship it" },
  ]);
  await dom.waitFor(() => $$(".as-divider").some((d) => d.textContent.includes("Continued with Codex")));
  assert.match(dom.document.querySelector(".as-scroll").textContent, /Build the login page[\s\S]*Continued with Codex · earlier messages are from Claude Code[\s\S]*Ship it/);
});

test("the chat's ⋯ menu has a row, with the app's logo, to continue it in the other app: one tap says what happens, the next moves it", async () => {
  const selected = await open(claudeChat());
  await click(button("More"));
  const menu = await dom.waitFor(() => $(".as-details"));
  // Just that: no "Open in the app", no card.
  assert.equal(menu.querySelector(".as-details-open"), null);
  assert.equal(offer(menu).length, 0);
  assert.doesNotMatch(menu.textContent, /Open in the/);
  const item = menu.querySelector(".move-item");
  assert.ok(item.querySelector(".agent-logo"), "with the app's logo");
  assert.match(item.textContent, /^Continue in CodexPicks up from here; this chat stays$/);
  await click(item);
  assert.equal(item.querySelector(".move-item-text > span").textContent, "Codex");
  assert.equal(item.querySelector(".move-item-text small").textContent, "gets what Claude Code knows so far");
  assert.equal(item.querySelector(".move-item-go").textContent, "Continue");
  assert.deepEqual(mac.moves, []);
  await click(item);
  await dom.waitFor(() => selected.length);
  assert.equal(selected[0].id, NEW);
  assert.equal(selected[0].agent, "codex");
  assert.deepEqual(mac.moves.map((m) => m.from), [`claude:${CLAUDE}`]);
  assert.equal($(".as-details"), null);
  assert.deepEqual(dom.errors, []);
});

test("a tap outside the ⋯ menu closes it", async () => {
  await open(claudeChat());
  await click(button("More"));
  await dom.waitFor(() => $(".as-details"));
  await click($(".as-details-scrim"));
  assert.equal($(".as-details"), null);
});

test("no row when the other app can't take the chat now", async () => {
  await open(claudeChat(), both({ codex: { usable: false } }));
  await click(button("More"));
  const menu = await dom.waitFor(() => $(".as-details"));
  assert.equal(menu.querySelector(".move-item"), null);
});

test("a quiet line under the header says so twice at most; a tap opens ⋯ where it stays", async () => {
  dom.window.localStorage.setItem("reach.moveHint", "0");
  await open(claudeChat());
  const hint = await dom.waitFor(() => $(".move-hint"));
  assert.match(hint.textContent, /New: continue this chat in Codex$/);
  await click(hint);
  assert.match((await dom.waitFor(() => $(".as-details .move-item"))).textContent, /^Continue in Codex/);
  // Tapped once: never again.
  assert.equal(dom.window.localStorage.getItem("reach.moveHint"), "99");
  for (const view of views.splice(0)) await view.unmount();
  // Not tapped: shown on the second chat opened, not on the third.
  dom.window.localStorage.setItem("reach.moveHint", "1");
  await open(claudeChat());
  await dom.waitFor(() => $(".move-hint"));
  for (const view of views.splice(0)) await view.unmount();
  await open(claudeChat());
  await settle(100);
  assert.equal($(".move-hint"), null);
});

test("in the list, a chat continued from the other app says so, with that app's logo", async () => {
  const view = await dom.render(
    React.createElement(ChatList, {
      compact: true,
      peer,
      sessions: [codexChat({ id: NEW, movedFrom: { agent: "claude", id: CLAUDE, title: "Login page" } })],
      agent: "codex",
      apps: [{ agent: "codex", name: "Codex", supported: true }],
      logos: {},
      onOpen() {},
      onNew() {},
    }),
  );
  views.push(view);
  const row = await dom.waitFor(() => $(".chat-card"));
  assert.match(row.textContent, /From Claude Code · Continues “Login page”/);
});

test("OpenClaw is offered only when it can take the chat (2026.3.13 can't add its history)", async () => {
  const withClaw = (canTakeMoves) => [...both(), { agent: "openclaw", installed: true, signedIn: false, supported: true, canTakeMoves }];
  await open(claudeChat(), withClaw(false));
  await click(button("More"));
  const items = () => [...dom.document.querySelectorAll(".as-details .move-item")].map((b) => b.textContent);
  assert.equal(items().some((t) => t.startsWith("Continue in OpenClaw")), false);
  assert.ok(items().some((t) => t.startsWith("Continue in Codex")));
  for (const view of views.splice(0)) await view.unmount();
  await open(claudeChat(), withClaw(true));
  await click(button("More"));
  assert.ok(items().some((t) => t.startsWith("Continue in OpenClaw")));
});
