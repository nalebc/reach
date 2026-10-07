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

test("the agent on top of a chat offers to continue it in the other app: one tap says what happens, the next moves it", async () => {
  const selected = await open(claudeChat());
  await click(button("Switch conversations"));
  const row = await dom.waitFor(() => offer()[0]);
  assert.match(row.textContent, /Continue in Codex/);
  assert.match(row.textContent, /Fork this chat and keep going with Codex\./);
  await click(row);
  assert.match(offer()[0].textContent, /Codex continues with what Claude Code knows so far; this chat stays as it is\./);
  assert.deepEqual(mac.moves, []);
  await click(offer()[0]);
  await dom.waitFor(() => selected.length === 1);
  assert.deepEqual(mac.moves, [{ from: `claude:${CLAUDE}`, body: { to: "codex" } }]);
  // The new chat opens, said to continue this one.
  assert.equal(selected[0].agent, "codex");
  assert.equal(selected[0].id, NEW);
  assert.deepEqual(selected[0].movedFrom, { agent: "claude", id: CLAUDE, title: "Login page" });
  assert.deepEqual(dom.errors, []);
});

test("when the other app can't take it, the offer says why and does nothing", async () => {
  await open(claudeChat(), both({ codex: { signedIn: false } }));
  await click(button("Switch conversations"));
  const row = await dom.waitFor(() => offer()[0]);
  assert.equal(row.disabled, true);
  assert.match(row.textContent, /Codex is signed out on your Mac\./);
});

test("next to the models, the other agent is one more choice", async () => {
  const selected = await open(codexChat());
  await click(button("Chat settings"));
  await click(await dom.waitFor(() => $(".as-model:not([disabled])")));
  const row = await dom.waitFor(() => $(".move-offer.picker .move-offer-row"));
  assert.match(row.textContent, /Continue in Claude Code/);
  await click(row);
  await click($(".move-offer.picker .move-offer-row"));
  await dom.waitFor(() => selected.length === 1);
  assert.deepEqual(mac.moves, [{ from: `codex:${CODEX}`, body: { to: "claude" } }]);
});

test("out of usage, the chat offers to keep going in the other app, even when it already ends on the limit", async () => {
  const limit = "You've hit your session limit · resets 3:20pm (America/Vancouver)";
  await open(
    claudeChat(),
    both({ claude: { usable: false, resetsAt: Date.now() + 3600000, limit } }),
    [...said, { id: "e1", role: "system", kind: "error", text: limit, detail: "rate_limit" }],
  );
  const row = await dom.waitFor(() => $(".move-offer.usage .move-offer-row"));
  assert.match(row.textContent, /Continue in Codex/);
  assert.match(row.textContent, /Keep going: Codex picks up this chat where it is\./);
});

test("signed out on the Mac, the chat offers to keep going with the other agent too", async () => {
  await open(claudeChat(), both({ claude: { signedIn: false } }));
  const row = await dom.waitFor(() => $(".move-offer.usage .move-offer-row"));
  assert.match(row.textContent, /Continue in Codex/);
  assert.equal(row.disabled, false);
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

test("the first few times, a quiet line under the header says it's possible; it opens the choice", async () => {
  dom.window.localStorage.setItem("reach.moveHint", "0");
  await open(claudeChat());
  const hint = await dom.waitFor(() => $(".move-hint"));
  assert.match(hint.textContent, /New: continue this chat in Codex, as if forked here/);
  await click(hint);
  await dom.waitFor(() => offer()[0]);
  for (const view of views.splice(0)) await view.unmount();
  // Seen three times: no more.
  dom.window.localStorage.setItem("reach.moveHint", "3");
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
