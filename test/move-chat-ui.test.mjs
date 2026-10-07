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
const mac = { pages: {}, moves: [], archives: [] };
// A folder's chats on the Chats list (MoveSection).
const FOLDER = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000004"];
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
  for (const [agent, id] of [["claude", CLAUDE], ["codex", CODEX], ["codex", NEW], ...FOLDER.map((id) => ["claude", id])]) {
    routes[`/api/sessions/${agent}/${id}`] = () => mac.pages[`${agent}:${id}`];
    routes[`/api/sessions/${agent}/${id}/live`] = async () => (await settle(60), live);
    routes[`/api/sessions/${agent}/${id}/archive`] = (init) => {
      mac.archives.push([`${agent}:${id}`, JSON.parse(init.body).archived]);
      return { archived: JSON.parse(init.body).archived };
    };
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
  mac.archives = [];
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

// Every app found shows, the same each time: one that can't take the chat
// now is greyed with why (it was left out, and seemed undetected).
test("an app that can't take the chat now shows greyed, saying why", async () => {
  await open(claudeChat(), both({ codex: { usable: false } }));
  await click(button("More"));
  const menu = await dom.waitFor(() => $(".as-details"));
  const rows = [...menu.querySelectorAll(".move-item")];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].classList.contains("blocked"));
  assert.equal(rows[0].disabled, true);
  assert.equal(rows[0].textContent, "Continue in CodexCodex is out of usage.");
});

test("a quiet line under the header says so twice at most; a tap opens ⋯ where it stays", async () => {
  dom.window.localStorage.setItem("reach.moveHint", "0");
  await open(claudeChat());
  const hint = await dom.waitFor(() => $(".move-hint"));
  assert.match(hint.textContent, /New: continue this chat in Codex$/);
  await click(hint);
  assert.match((await dom.waitFor(() => $(".as-details .move-item"))).textContent, /^Continue in Codex/);
  // Tapped once: never again.
  for (const view of views.splice(0)) await view.unmount();
  await open(claudeChat());
  await settle(100);
  assert.equal($(".move-hint"), null, "a dismissed hint stays dismissed on the next chat");
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

test("every app found is listed in the same order; OpenClaw when its Gateway can't add history says so", async () => {
  const apps = (canTakeMoves) => [
    ...both(),
    { agent: "gemini", name: "Gemini CLI", installed: true, signedIn: true, supported: true },
    { agent: "antigravity", name: "Antigravity", installed: true, supported: false },
    { agent: "openclaw", installed: true, signedIn: false, supported: true, canTakeMoves },
  ];
  const rows = () =>
    [...dom.document.querySelectorAll(".as-details .move-item")].map((b) => [
      b.querySelector(".move-item-text > span").textContent,
      b.classList.contains("blocked") ? b.querySelector("small").textContent : "ready",
    ]);
  await open(claudeChat(), apps(false));
  await click(button("More"));
  assert.deepEqual(rows(), [
    ["Continue in Codex", "ready"],
    ["Continue in OpenClaw", "Update OpenClaw on your Mac to move chats there."],
    ["Continue in Antigravity", "Reach can't continue chats in Antigravity yet."],
    ["Continue in Gemini CLI", "Reach only reads Gemini CLI chats."],
  ]);
  for (const view of views.splice(0)) await view.unmount();
  await open(claudeChat(), apps(true));
  await click(button("More"));
  assert.deepEqual(rows().slice(0, 2), [["Continue in Codex", "ready"], ["Continue in OpenClaw", "ready"]]);
});

// "Continued in Codex" stayed pinned under the messages written after it.
test("the way to where a chat went sits where it moved, not under what came after", async () => {
  const movedAt = said[1].at + 500; // after "Built it.", before "Now tests"
  await open(claudeChat({ movedTo: [{ agent: "codex", id: NEW, at: movedAt }] }));
  const link = await dom.waitFor(() => $(".move-continued"));
  const order = [...dom.document.querySelectorAll(".as-user, .as-assistant, .move-continued")].map((el) =>
    el.classList.contains("move-continued") ? "→ Codex" : el.textContent.trim(),
  );
  assert.deepEqual(order, ["Build the login page", "Built it.", "→ Codex", "Now tests", "Added them."]);
  assert.equal($$(".move-continued").length, 1, "shown once");
  assert.match(link.textContent, /Continued in Codex/);
  assert.deepEqual(dom.errors, []);
});

// Moving from a folder on the Chats list, said plainly either way: the whole
// project ("Move project app to Codex") or one chat ("Move one chat…").
const folderChats = () => [
  claudeChat({ id: FOLDER[0], title: "Login page", updatedAt: Date.now() - 1000 }),
  claudeChat({ id: FOLDER[1], title: "Sign up", updatedAt: Date.now() - 2000 }),
  // At work: stays out of a project move (its turn isn't over).
  claudeChat({ id: FOLDER[2], title: "Payments", status: "running", updatedAt: Date.now() - 3000 }),
  // Already continued in Codex: not moved twice.
  claudeChat({ id: FOLDER[3], title: "Old one", updatedAt: Date.now() - 4000, movedTo: [{ agent: "codex", id: NEW }] }),
  // Another folder.
  claudeChat({ cwd: "/work/other", title: "Elsewhere", updatedAt: Date.now() - 5000 }),
];
const list = async (extra = {}) => {
  const moved = [];
  const opened = [];
  const view = await dom.render(
    React.createElement(ChatList, {
      peer,
      sessions: folderChats(),
      agent: "claude",
      apps: [{ agent: "claude", name: "Claude Code", supported: true }, { agent: "codex", name: "Codex", supported: true }],
      health: both(),
      logos: {},
      onOpen: (s) => opened.push(s),
      onNew() {},
      onAgentChange: (a) => moved.push(a),
      ...extra,
    }),
  );
  views.push(view);
  return { moved, opened };
};
const folderMenu = async (name) => {
  await dom.waitFor(() => $(".move-section-open"));
  await click(button(`Move project ${name} or one of its chats to another app`));
  return $(".chat-popover");
};
const menuRows = () => $$(".chat-popover .move-item .move-item-text > span").map((el) => el.textContent);

test("a whole folder moves as 'Move project app to Codex': its idle chats once each, then Codex's list shows", async () => {
  dom.window.localStorage.removeItem("reach.sectionMoved");
  const { moved } = await list();
  await folderMenu("app");
  assert.deepEqual(menuRows(), ["Move project app to Codex", "Move one chat…"]);
  const row = $$(".chat-popover .move-item").find((b) => b.textContent.includes("Move project app to Codex"));
  assert.match(row.textContent, /The whole folder: 2 chats/);
  await click(row);
  assert.equal(mac.moves.length, 0, "the first tap only says what goes");
  assert.match(row.textContent, /2 chats pick up where they are in Codex/);
  await click(row);
  await dom.waitFor(() => moved.length === 1);
  assert.deepEqual(
    mac.moves.map((m) => [m.from, m.body.to]),
    [[`claude:${FOLDER[0]}`, "codex"], [`claude:${FOLDER[1]}`, "codex"]],
  );
  assert.deepEqual(moved, ["codex"]);
  // Again: nothing left to send there.
  await folderMenu("app");
  const again = $$(".chat-popover .move-item").find((b) => b.textContent.includes("Move project app to Codex"));
  assert.ok(again.disabled);
  assert.match(again.textContent, /Already in Codex/);
  assert.deepEqual(dom.errors, []);
});

test("one chat from a folder: 'Move one chat…', pick it, then 'Move this chat to Codex' opens the new chat", async () => {
  const { opened, moved } = await list();
  await folderMenu("app");
  await click($$(".chat-popover .move-item").find((b) => b.textContent.includes("Move one chat…")));
  assert.deepEqual(menuRows(), ["Which chat?", "Login page", "Sign up", "Old one"]);
  await click($$(".chat-popover .move-item").find((b) => b.textContent.includes("Sign up")));
  assert.deepEqual(menuRows(), ["Sign up", "Move this chat to Codex"]);
  const row = $$(".chat-popover .move-item").find((b) => b.textContent.includes("Move this chat to Codex"));
  await click(row);
  await click(row);
  await dom.waitFor(() => opened.length === 1);
  assert.deepEqual(mac.moves.map((m) => [m.from, m.body.to]), [[`claude:${FOLDER[1]}`, "codex"]]);
  assert.equal(opened[0].agent, "codex");
  assert.equal(opened[0].movedFrom.id, FOLDER[1]);
  assert.deepEqual(moved, [], "stays on this list until the chat opens");
});

test("working chats stay in their project, and an app that can't take chats says why", async () => {
  await list({ health: both({ codex: { signedIn: false } }) });
  const project = $('[aria-label="app conversations"]');
  assert.ok(project.querySelector('.chat-card.running'), "the working chat stays under its folder");
  assert.ok(project.querySelector('.chat-card.running .chat-row-status'), "working status is on the chat row");
  await folderMenu("app");
  const row = $$(".chat-popover .move-item").find((b) => b.textContent.includes("Move project app to Codex"));
  assert.ok(row.disabled);
  assert.match(row.textContent, /Codex is signed out on your Mac/);
});

// The folder's menu floats by its ⋯ instead of pushing the list down.
test("a folder's ⋯ opens a small floating menu, not a block in the list; a tap outside closes it", async () => {
  await list();
  const menu = await folderMenu("app");
  assert.equal(menu.parentElement, dom.document.body, "over the page, not inside the list");
  assert.equal($(".chat-library .chat-popover"), null);
  await click($(".chat-popover-scrim"));
  assert.equal($(".chat-popover"), null);
});

// Touch and hold a chat on the list: its options, by it.
test("holding a chat shows its menu (Open, New chat in its folder, Continue in…); the tap that ends the hold opens nothing", async () => {
  const news = [];
  const { opened } = await list({ onNew: (cwd) => news.push(cwd) });
  const card = $$(".chat-card").find((c) => c.textContent.includes("Sign up"));
  card.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
  await settle(600);
  card.dispatchEvent(new dom.window.PointerEvent("pointerup", { bubbles: true }));
  await click(card);
  assert.deepEqual(opened, [], "the hold doesn't open the chat");
  const menu = $(".chat-popover");
  assert.ok(menu, "menu shows");
  assert.match(menu.querySelector(".chat-popover-head").textContent, /Sign up/);
  assert.deepEqual(menuRows(), ["Open", "New chat in app", "Continue in Codex", "Archive"]);
  await click($$(".chat-popover .move-item").find((b) => b.textContent.includes("New chat in app")));
  assert.deepEqual(news, ["/work/app"]);
  assert.equal($(".chat-popover"), null);
  // A plain tap still opens the chat.
  await click(card);
  assert.equal(opened.length, 1);
  assert.deepEqual(dom.errors, []);
});

test("right-clicking a chat shows the same menu; Open opens it", async () => {
  const { opened } = await list();
  const card = $$(".chat-card").find((c) => c.textContent.includes("Login page"));
  card.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await settle();
  await click($$(".chat-popover .move-item").find((b) => b.textContent.trim() === "Open"));
  assert.equal(opened[0]?.id, FOLDER[0]);
});

// Archive from a chat's menu: in its own app too (the Mac's list follows),
// gone from here at once, with a moment to undo it.
const holdOpen = async (title) => {
  const card = $$(".chat-card").find((c) => c.textContent.includes(title));
  card.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await settle();
  return card;
};
test("Archive in a chat's menu archives it in its app, hides it here, and Undo brings it back", async () => {
  let reloads = 0;
  await list({ onArchived: () => reloads++ });
  await holdOpen("Login page");
  const row = $$(".chat-popover .move-item").find((b) => b.textContent.includes("Archive"));
  assert.match(row.textContent, /In Claude Code too/);
  await click(row);
  await dom.waitFor(() => mac.archives.length === 1);
  assert.deepEqual(mac.archives, [[`claude:${FOLDER[0]}`, true]]);
  assert.ok(!$$(".chat-card").some((c) => c.textContent.includes("Login page")), "gone from the list at once");
  const bar = $(".chat-undo");
  assert.equal(bar.parentElement, dom.document.body);
  assert.match(bar.textContent, /Archived “Login page” in Claude Code/);
  await click([...bar.querySelectorAll("button")].find((b) => b.textContent === "Undo"));
  await dom.waitFor(() => mac.archives.length === 2);
  assert.deepEqual(mac.archives[1], [`claude:${FOLDER[0]}`, false]);
  assert.ok($$(".chat-card").some((c) => c.textContent.includes("Login page")), "back in the list");
  assert.equal(reloads, 2);
  assert.deepEqual(dom.errors, []);
});

test("a Claude chat the app doesn't have can't be archived, and says why", async () => {
  await list({ sessions: [claudeChat({ id: FOLDER[0], title: "Terminal only", inApp: false, origin: "cli" })] });
  await holdOpen("Terminal only");
  const row = $$(".chat-popover .move-item").find((b) => b.textContent.includes("Archive"));
  assert.ok(row.disabled);
  assert.match(row.textContent, /Open it in the Claude app to archive it/);
});
