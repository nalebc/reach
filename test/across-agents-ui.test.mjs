import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// Working across agents (docs/ACROSS_AGENTS.md), through the real
// components: continuing in another agent when one runs out of usage, a
// second opinion, hand-offs, mentioning a chat and the All page. The computer
// is a stand-in that records what the phone sent.

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "test-token", platform: "darwin" };
const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const CLAUDE = "11111111-2222-4333-8444-555555555555";
const NEW = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const LOGO = "data:image/png;base64,iVBORw0KGgo=";

const codexSession = (extra = {}) => ({
  agent: "codex",
  id: CODEX,
  title: "Fix login",
  cwd: "/work/app",
  branch: "main",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
  model: "gpt-6-astra",
  effort: "medium",
  mode: "guardian-approvals",
  held: null,
  ...extra,
});
const claudeSession = (extra = {}) => ({
  ...codexSession(),
  agent: "claude",
  id: CLAUDE,
  title: "Refactor auth",
  model: "claude-opus-5-5",
  effort: "max",
  mode: "auto",
  ...extra,
});
const idleLive = () => ({ version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 });
const both = (codex = {}, claude = {}) => [
  { agent: "codex", installed: true, signedIn: true, usable: true, ...codex },
  { agent: "claude", installed: true, signedIn: true, usable: true, ...claude },
];

const mac = {
  sent: [],
  pages: {},
  live: idleLive(),
  answers: {},
  reset() {
    this.sent = [];
    this.answers = {};
    this.pages = {
      [`codex:${CODEX}`]: { session: codexSession(), items: [] },
      [`claude:${CLAUDE}`]: { session: claudeSession(), items: [] },
      [`claude:${NEW}`]: { session: claudeSession({ id: NEW, title: "Fix login" }), items: [] },
      [`codex:${NEW}`]: { session: codexSession({ id: NEW, title: "Plan the API" }), items: [] },
    };
    this.live = idleLive();
  },
};
// What the phone sent: the route, and its body.
const record = (route) => (init) => {
  mac.sent.push({ route, body: init?.body ? JSON.parse(init.body) : null });
  return mac.answers[route] ?? { ok: true };
};
const routes = {
  "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
  "/api/sessions/health": () => ({ agents: [] }),
  "/api/sessions/logos": () => ({ version: "v1", logos: { codex: LOGO, claude: LOGO } }),
  "/api/sessions/commands": () => ({ commands: [] }),
  "/api/sessions": () => ({ sessions: [], errors: {} }),
};
for (const agent of ["codex", "claude"])
  for (const id of [CODEX, CLAUDE, NEW]) {
    routes[`/api/sessions/${agent}/${id}`] = () => mac.pages[`${agent}:${id}`] || { session: codexSession({ agent, id }), items: [] };
    routes[`/api/sessions/${agent}/${id}/live`] = async () => (await settle(60), mac.live);
    for (const action of ["messages", "move", "mode"])
      routes[`/api/sessions/${agent}/${id}/${action}`] = record(`/api/sessions/${agent}/${id}/${action}`);
  }

let dom, React, AgentSessionView, EverythingChat;
before(async () => {
  dom = await startDom({ mobile: true, routes });
  React = dom.React;
  ({ default: AgentSessionView } = await dom.load("/src/AgentSession.tsx"));
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  mac.reset();
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const mount = async (element) => {
  const view = await dom.render(element);
  views.push(view);
  return view;
};
const $ = (selector) => dom.document.querySelector(selector);
const $$ = (selector) => [...dom.document.querySelectorAll(selector)];
const button = (label) =>
  $$("button").find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const click = async (element) => {
  assert.ok(element, "button exists");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const open = async (session, health, extra = {}) =>
  mount(
    React.createElement(AgentSessionView, {
      peer,
      session,
      siblings: [],
      health,
      logos: { codex: LOGO, claude: LOGO },
      onSelect() {},
      onBack() {},
      ...extra,
    }),
  );
const limitError = (at = Date.now()) => ({
  id: "t2:error",
  role: "system",
  kind: "error",
  text: "You’ve hit your usage limit.",
  detail: "usageLimitExceeded",
  turnId: "t2",
  at,
});

test("out of Codex usage, the chat continues in Claude Code in two taps and keeps working", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    { id: "u1", role: "user", kind: "text", text: "Fix the login bug", turnId: "t2" },
    limitError(),
  ];
  mac.answers[`/api/sessions/codex/${CODEX}/move`] = { agent: "claude", id: NEW, resumed: true };
  const opened = [];
  await open(codexSession(), both({ usable: false, resetsAt: Date.UTC(2026, 9, 16, 21, 25) }), { onSelect: (s) => opened.push(s) });
  const offer = await dom.waitFor(() => $(".usage-continue-offer"));
  assert.equal(offer.textContent.trim(), "Continue in Claude Code");
  // The first tap says what happens; nothing is sent yet.
  await click(offer);
  assert.match($(".usage-continue-text").textContent, /Claude Code picks up where Codex stopped and keeps working/);
  assert.deepEqual(mac.sent, []);
  await click(button("Continue"));
  await dom.waitFor(() => opened.length === 1);
  assert.deepEqual(mac.sent, [{ route: `/api/sessions/codex/${CODEX}/move`, body: { to: "claude", resume: true } }]);
  assert.deepEqual([opened[0].agent, opened[0].id], ["claude", NEW]);
  assert.deepEqual(opened[0].movedFrom, { agent: "codex", id: CODEX, title: "Fix login" });
  assert.deepEqual(dom.errors, []);
});

test("an agent that is also out of usage isn't offered, and an old limit with usage back offers nothing", async () => {
  mac.pages[`codex:${CODEX}`].items = [limitError()];
  await open(codexSession(), both({ usable: false }, { usable: false }));
  await dom.waitFor(() => $(".usage-strip"));
  assert.equal($(".usage-continue"), null, "Claude Code is out too");
  await views.splice(0)[0].unmount();
  // A day-old limit, Codex usable again: no strip at all.
  mac.pages[`codex:${CODEX}`].items = [limitError(Date.now() - 86400000)];
  await open(codexSession(), both());
  await dom.waitFor(() => $(".as-error.codex"));
  assert.equal($(".usage-strip"), null);
  assert.deepEqual(dom.errors, []);
});

test("a move whose continue message couldn't go opens the new chat with it in the box", async () => {
  mac.pages[`codex:${CODEX}`].items = [limitError()];
  mac.answers[`/api/sessions/codex/${CODEX}/move`] = { agent: "claude", id: NEW, resumed: false, resumeError: "Claude Code is signed out." };
  const opened = [];
  await open(codexSession(), both({ usable: false }), { onSelect: (s) => opened.push(s) });
  await click(await dom.waitFor(() => $(".usage-continue-offer")));
  await click(button("Continue"));
  await dom.waitFor(() => opened.length === 1);
  assert.equal(dom.window.sessionStorage.getItem(`reach-chat-draft:mac:claude:${NEW}`), "Continue where you left off.");
  assert.deepEqual(dom.errors, []);
});


const relayOf = (extra = {}) => ({
  id: "r1",
  state: "waiting",
  problem: "",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  next: 0,
  steps: [{ kind: "build", agent: "claude" }],
  chain: [{ agent: "codex", id: CODEX, title: "Fix login" }],
  sent: [],
  ...extra,
});
const turn = () => [
  { id: "u1", role: "user", kind: "text", text: "Fix the login bug" },
  { id: "a1", role: "assistant", kind: "text", text: "Fixed: the token was compared as a number." },
];

const routeLabels = (sheet) => [...sheet.querySelectorAll(".relay-route .relay-node:not(.add)")].map((n) => n.querySelector(".relay-node-label").textContent);

test("a second opinion from a reply starts a review in the other agent, sent back here when done", async (t) => {
  mac.pages[`codex:${CODEX}`].items = turn();
  routes["/api/sessions/relays"] = record("/api/sessions/relays");
  t.after(() => delete routes["/api/sessions/relays"]);
  mac.answers["/api/sessions/relays"] = {
    relay: relayOf({ next: 1, steps: [{ kind: "review", agent: "claude" }, { kind: "back" }], chain: [{ agent: "codex", id: CODEX, title: "Fix login" }, { agent: "claude", id: NEW, title: "Review: Fix login" }] }),
    opened: { agent: "claude", id: NEW },
  };
  const opened = [];
  await open(codexSession(), both(), { onSelect: (s) => opened.push(s) });
  await click(await dom.waitFor(() => $(".relay-opinion")));
  const sheet = await dom.waitFor(() => $(".relay-sheet"));
  assert.ok(sheet.classList.contains("reach-native"), "Reach's own look, not either app's");
  // The route: Codex replied, Claude Code reviews, Codex gets it back.
  assert.deepEqual(routeLabels(sheet), ["replied", "reviews", "gets it back"]);
  assert.match(sheet.querySelector(".relay-say").textContent, /Claude Code reads what Codex was asked.*reads only, and asks you before anything more/);
  // The reviewer's tile switches reviewer; back to Claude Code.
  await click(sheet.querySelector('.relay-node[aria-label="Claude Code reviews"]'));
  assert.equal(sheet.querySelector(".relay-go").textContent, "Ask a new Codex chat");
  await click(sheet.querySelector('.relay-node[aria-label="Codex reviews"]'));
  assert.equal(sheet.querySelector(".relay-go").textContent, "Ask Claude Code");
  assert.equal(sheet.querySelector(".relay-switch input").checked, true, "sent back by default");
  await click(sheet.querySelector(".relay-go"));
  await dom.waitFor(() => !$(".relay-sheet"));
  assert.deepEqual(mac.sent, [
    { route: "/api/sessions/relays", body: { from: { agent: "codex", id: CODEX }, steps: [{ kind: "review", agent: "claude" }, { kind: "back" }], now: true, item: "a1" } },
  ]);
  // Here, it says where the review is, with the way there; nothing opened by itself.
  const row = await dom.waitFor(() => $(".relay-row"));
  assert.match(row.textContent, /Claude Code is on it in “Review: Fix login”\. Then the review goes back to Codex/);
  assert.equal(opened.length, 0);
  await click([...row.querySelectorAll("button")].find((b) => b.textContent === "Open"));
  assert.deepEqual([opened[0].agent, opened[0].id], ["claude", NEW]);
  assert.deepEqual(dom.errors, []);
});

test("while the agent works, a relay is drawn as a route, grows a step at a time, and can be cancelled", async (t) => {
  mac.pages[`codex:${CODEX}`].items = [{ id: "u1", role: "user", kind: "text", text: "Plan the login" }];
  mac.live = { ...mac.live, status: "running" };
  routes["/api/sessions/relays"] = record("/api/sessions/relays");
  routes["/api/sessions/relays/r1/cancel"] = record("/api/sessions/relays/r1/cancel");
  t.after(() => {
    delete routes["/api/sessions/relays"];
    delete routes["/api/sessions/relays/r1/cancel"];
  });
  mac.answers["/api/sessions/relays"] = { relay: relayOf({ steps: [{ kind: "build", agent: "claude", instructions: "Add tests too" }, { kind: "review", agent: "codex" }, { kind: "back" }] }) };
  mac.answers["/api/sessions/relays/r1/cancel"] = { cancelled: true };
  mac.pages[`codex:${CODEX}`].session = codexSession({ status: "running" });
  await open(codexSession({ status: "running" }), both());
  await dom.waitFor(() => $(".as-working"));
  await click(button("Relay when done"));
  const sheet = await dom.waitFor(() => $(".relay-sheet"));
  assert.equal(sheet.querySelector("h2").textContent, "Relay");
  assert.equal(sheet.querySelector(".relay-when-line").textContent, "When Codex finishes");
  assert.equal($(".relay-when"), null, "only when it finishes: nothing to send yet");
  // One route, one sentence: Claude Code builds it.
  assert.deepEqual(routeLabels(sheet).slice(0, 2), ["now", "builds"]);
  assert.equal(sheet.querySelector(".relay-say").textContent, "Claude Code builds what Codex wrote, in a new chat here.");
  // The next step is offered where the route ends: a review, then the fixes.
  await click(sheet.querySelector('.relay-node.add[aria-label="Add: Codex reviews"]'));
  await click(sheet.querySelector('.relay-node.add[aria-label="Add: Claude Code fixes"]'));
  assert.deepEqual(routeLabels(sheet), ["now", "builds", "reviews", "fixes"]);
  assert.equal(sheet.querySelector(".relay-node.add"), null, "three steps at most");
  assert.equal(
    sheet.querySelector(".relay-say").textContent,
    "Claude Code builds what Codex wrote, in a new chat here, then Codex reviews the work, then Claude Code fixes what the review found.",
  );
  await click([...sheet.querySelectorAll(".relay-extras button")].find((b) => /Note/.test(b.textContent)));
  await typeInto(sheet.querySelector(".relay-instructions"), "Add tests too");
  await click(button("Start relay"));
  await dom.waitFor(() => !$(".relay-sheet"));
  assert.deepEqual(mac.sent[0], {
    route: "/api/sessions/relays",
    body: {
      from: { agent: "codex", id: CODEX },
      steps: [{ kind: "build", agent: "claude", instructions: "Add tests too" }, { kind: "review", agent: "codex" }, { kind: "back" }],
      now: false,
    },
  });
  const row = await dom.waitFor(() => $(".relay-row"));
  assert.match(row.textContent, /When Codex finishes: Claude Code builds it, then Codex reviews it, then the review goes back to Claude Code/);
  await click(button("Cancel relay"));
  assert.equal(mac.sent[1].route, "/api/sessions/relays/r1/cancel");
  await dom.waitFor(() => !$(".relay-row"));
  assert.deepEqual(dom.errors, []);
});

test("an idle chat's reply can go now into a chat you pick", async (t) => {
  mac.pages[`codex:${CODEX}`].items = turn();
  routes["/api/sessions/relays"] = record("/api/sessions/relays");
  t.after(() => delete routes["/api/sessions/relays"]);
  mac.answers["/api/sessions/relays"] = { relay: relayOf({ state: "done", next: 1, steps: [{ kind: "send", to: { agent: "claude", id: CLAUDE, title: "Refactor auth" } }] }), opened: { agent: "claude", id: CLAUDE } };
  await open(codexSession(), both(), { everyone: [codexSession(), claudeSession(), claudeSession({ id: NEW, title: "Old", archived: true })] });
  assert.equal(button("Relay when done"), undefined, "idle: no chip above the box");
  await click(await dom.waitFor(() => button("Relay this reply")));
  const sheet = await dom.waitFor(() => $(".relay-sheet"));
  assert.equal(sheet.querySelector('.relay-when [aria-checked="true"]').textContent, "Its reply now");
  // The step's tile opens what it can be instead: a chat you pick.
  await click(sheet.querySelector('.relay-node[aria-label="Claude Code builds"]'));
  await click([...sheet.querySelectorAll(".relay-edit button")].find((b) => b.textContent === "to a chat…"));
  assert.equal(button("Relay now").disabled, true, "a chat first");
  const chats = [...sheet.querySelectorAll(".relay-chat")];
  assert.deepEqual(chats.map((c) => c.querySelector("span").textContent), ["Refactor auth"], "not this chat, not archived ones");
  await click(chats[0]);
  assert.equal(sheet.querySelector(".relay-say").textContent, "It goes into “Refactor auth”.".replace("It", "it"));
  await click(button("Relay now"));
  await dom.waitFor(() => mac.sent.length === 1);
  assert.deepEqual(mac.sent[0].body, { from: { agent: "codex", id: CODEX }, steps: [{ kind: "send", to: { agent: "claude", id: CLAUDE } }], now: true });
  assert.deepEqual(dom.errors, []);
});

test("@ offers chats from any agent; one picked goes along with the message, shown by its name", async () => {
  mac.pages[`codex:${CODEX}`].items = turn();
  await open(codexSession(), both(), {
    everyone: [codexSession(), claudeSession(), claudeSession({ id: NEW, title: "Plan the API", updatedAt: Date.now() - 1000 })],
  });
  const box = await dom.waitFor(() => $(".as-composer textarea"));
  await typeInto(box, "Like @ref");
  const option = await dom.waitFor(() => $(".as-mention-chat"));
  assert.equal($$(".as-mention-chat").length, 1, "only the chats whose name has the words, never this one");
  assert.match(option.textContent, /Refactor auth.*Claude Code · app/);
  await click(option);
  assert.equal(box.value, "Like ");
  assert.equal($(".as-mention-chip").textContent.trim(), "Refactor auth");
  await typeInto(box, "this, please.");
  await click(button("Send"));
  await dom.waitFor(() => mac.sent.length === 1);
  assert.deepEqual(mac.sent[0].body.chats, [{ agent: "claude", id: CLAUDE }]);
  assert.equal(mac.sent[0].body.text, "Like this, please.");
  assert.equal($(".as-mention-chip"), null, "sent: the box is clear");
  // The transcript holds the blocks Reach put ahead of it; the bubble shows the words.
  mac.pages[`codex:${CODEX}`].items = [
    ...turn(),
    { id: "u2", role: "user", kind: "text", text: '<reach-chat from="Claude Code" chat="Refactor auth">\n## Note\nQuoted.\n</reach-chat>\n\n## My request:\nLike this, please.' },
  ];
  mac.live = { ...mac.live, version: mac.live.version + 1, items: mac.live.items + 1 };
  await dom.waitFor(() => $$(".as-user").some((u) => /Like this, please/.test(u.textContent) && /Refactor auth/.test(u.textContent)));
  const bubble = $$(".as-user").find((u) => /Like this, please/.test(u.textContent));
  assert.doesNotMatch(bubble.textContent, /Quoted|reach-chat|My request/);
  assert.equal($$(".as-user.pending").length, 0, "the sent copy gave way to the transcript's");
  assert.deepEqual(dom.errors, []);
});

const home = (sessions, health = both(), extra = {}) =>
  mount(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions, errors: {}, health, failure: "", relays: [], reload: async () => {}, recheck: () => {}, ...extra },
    }),
  );

test("the All page groups every agent's chats by project, warns of files two chats changed, and searches them all", async (t) => {
  const now = Date.now();
  const sessions = [
    codexSession({ title: "Fix login", cwd: "/work/app", status: "running", updatedAt: now - 1000 }),
    claudeSession({ title: "Refactor auth", cwd: "/work/app/.claude/worktrees/bold-fox", updatedAt: now - 2000 }),
    claudeSession({ id: NEW, title: "Plan the API", cwd: "/work/api", status: "waiting", updatedAt: now - 60000 }),
  ];
  const asked = [];
  Object.assign(routes, {
    "/api/sessions/activity": () => ({
      chats: [
        { agent: "codex", id: CODEX, title: "Fix login", cwd: "/work/app", files: [{ file: "/work/app/src/auth.ts", at: now }, { file: "/work/app/src/login.ts", at: now }] },
      ],
      overlaps: [
        {
          file: "/work/app/src/auth.ts",
          chats: [
            { agent: "codex", id: CODEX, title: "Fix login", at: now },
            { agent: "claude", id: CLAUDE, title: "Refactor auth", at: now },
          ],
        },
      ],
    }),
    "/api/sessions/journal": (init, href) => (
      asked.push(href.searchParams.get("since")),
      {
        events: [
          { id: "e1", kind: "finished", agent: "claude", chat: CLAUDE, title: "Refactor auth", files: 3, at: now - 5000 },
          { id: "e2", kind: "usage", agent: "codex", chat: CODEX, title: "Fix login", text: "You’ve hit your usage limit.", at: now - 4000 },
        ],
        waiting: [{ agent: "claude", id: NEW, title: "Plan the API" }],
        now,
      }
    ),
    "/api/sessions/search": (init, href) => ({
      partial: false,
      results:
        href.searchParams.get("q") === "token"
          ? [{ agent: "claude", id: CLAUDE, role: "assistant", at: now - 3000, snippet: "…the token was compared as a number…", title: "Refactor auth", cwd: "/work/app", listed: true }]
          : [],
    }),
  });
  t.after(() => {
    for (const r of ["/api/sessions/activity", "/api/sessions/journal", "/api/sessions/search"]) delete routes[r];
  });
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  await home(sessions, both(), {
    relays: [
      {
        id: "r1",
        state: "waiting",
        problem: "",
        createdAt: now,
        updatedAt: now,
        next: 0,
        steps: [{ kind: "build", agent: "claude" }],
        chain: [{ agent: "codex", id: CODEX, title: "Fix login" }],
        sent: [],
      },
    ],
  });
  const hub = await dom.waitFor(() => $(".chat-hub"));
  assert.equal(hub.querySelector(".chat-current-name").textContent, "All");
  // Projects across agents: the Claude worktree belongs to its project.
  const projects = await dom.waitFor(() => ($$(".hub-project").length === 2 ? $$(".hub-project") : null));
  assert.deepEqual(projects.map((p) => p.querySelector(".chat-project-name").textContent), ["app", "api"]);
  assert.deepEqual([...projects[0].querySelectorAll(".chat-card strong")].map((e) => e.textContent), ["Fix login", "Refactor auth"]);
  assert.match(projects[0].textContent, /Changed auth\.ts, login\.ts/);
  const warning = await dom.waitFor(() => $(".hub-overlap"));
  assert.match(warning.textContent, /src\/auth\.ts changed by Codex \(“Fix login”\) and Claude Code \(“Refactor auth”\) in the last half hour/);
  // While you were away: what needs a look first.
  const away = await dom.waitFor(() => $(".hub-away"));
  assert.match(away.querySelector(".hub-away-sum").textContent, /1 chat finished · 1 waiting on you · Claude Code changed 3 files/);
  assert.deepEqual([...away.querySelectorAll("li")].map((li) => li.textContent), [
    "Waiting on you: “Plan the API”",
    "Codex ran out of usage in “Fix login”",
    "“Refactor auth” finished · 3 files changed",
  ]);
  await click(button("Got it"));
  assert.equal(dom.window.localStorage.getItem("reach.lastSeen:mac"), String(now));
  await dom.waitFor(() => asked.at(-1) === String(now));
  // Relays under way, with Cancel.
  assert.match($(".hub-relays").textContent, /Fix login.*When Codex finishes: Claude Code builds it/);
  // One search: names at once, what was said from the Mac.
  await typeInto($('input[aria-label="Search all chats"]'), "token");
  const hit = await dom.waitFor(() => $$(".hub-hit").find((h) => /compared as a number/.test(h.textContent)));
  assert.match(hit.textContent, /Refactor auth.*Claude Code: …the token was compared as a number…/);
  await click(hit);
  await dom.waitFor(() => $(".as-page"));
  assert.match($(".as-title strong").textContent, /Refactor auth/);
  assert.deepEqual(dom.errors, []);
});

test("with one agent, there's no All page; a new chat from All starts in a real app", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  await home([codexSession()], [{ agent: "codex", installed: true, signedIn: true, usable: true }]);
  await dom.waitFor(() => $(".chat-library"));
  assert.equal($(".chat-hub"), null);
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "codex");
  await views.splice(0)[0].unmount();
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  await home([codexSession(), claudeSession()]);
  await dom.waitFor(() => $(".chat-hub"));
  await click(button("New chat"));
  const sheet = await dom.waitFor(() => $(".chat-create-sheet"));
  assert.equal(sheet.querySelector("textarea").getAttribute("aria-label"), "New Codex chat");
  assert.ok(![...sheet.querySelectorAll("button")].some((b) => b.textContent.trim() === "All"), "All isn't an app to start in");
  assert.deepEqual(dom.errors, []);
});

const teamOf = (extra = {}) => ({
  id: "team-1",
  state: "active",
  lead: { agent: "codex", id: CODEX },
  helpers: ["claude"],
  cwd: "/work/app",
  title: "Ship pagination",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  left: 10,
  tasks: [
    { id: "t1", helper: "claude", kind: "build", title: "Add pagination", chat: { agent: "claude", id: CLAUDE, title: "Team · Add pagination" }, state: "working", startedAt: Date.now(), updatedAt: Date.now() },
    { id: "t2", helper: "claude", kind: "review", title: "Check the tests", chat: { agent: "claude", id: NEW }, state: "done", startedAt: Date.now(), updatedAt: Date.now() },
  ],
  ...extra,
});

test("a new chat can be a team: the lead and its helpers drawn as a route, started in one tap", async (t) => {
  routes["/api/sessions/teams"] = record("/api/sessions/teams");
  t.after(() => delete routes["/api/sessions/teams"]);
  mac.answers["/api/sessions/teams"] = { team: teamOf({ tasks: [] }), threadId: NEW };
  await home([codexSession(), claudeSession()]);
  await click(await dom.waitFor(() => button("New chat")));
  const sheet = await dom.waitFor(() => $(".chat-create-sheet"));
  await click(button("Team"));
  const picker = sheet.querySelector(".team-picker");
  assert.ok(picker.classList.contains("reach-native"));
  assert.deepEqual(routeLabels(picker), ["leads", "helps"]);
  assert.equal(picker.querySelector(".team-say").textContent, "Codex leads. It hands work to Claude Code and checks what comes back.");
  // A second Codex can help too; a helper's tile takes it off again.
  await click(picker.querySelector('.relay-node.add[aria-label="Add Codex as a helper"]'));
  assert.deepEqual(routeLabels(picker), ["leads", "helps", "a second one"]);
  await click(picker.querySelector('.relay-node[aria-label="Codex a second one"]'));
  assert.deepEqual(routeLabels(picker), ["leads", "helps"]);
  await typeInto(sheet.querySelector("textarea"), "Ship pagination with tests");
  assert.equal(sheet.querySelector("textarea").getAttribute("aria-label"), "New team led by Codex");
  await click(button("Start team"));
  await dom.waitFor(() => mac.sent.length === 1);
  assert.equal(mac.sent[0].route, "/api/sessions/teams");
  assert.deepEqual(
    { lead: mac.sent[0].body.lead, helpers: mac.sent[0].body.helpers, cwd: mac.sent[0].body.cwd, text: mac.sent[0].body.text },
    { lead: "codex", helpers: ["claude"], cwd: "/work/app", text: "Ship pagination with tests" },
  );
  // The lead's chat opens.
  await dom.waitFor(() => $(".as-page"));
  assert.deepEqual(dom.errors, []);
});

test("the lead's chat shows its team at work, a helper's chat the way back, and Stop asks first", async (t) => {
  routes["/api/sessions/teams/team-1/stop"] = record("/api/sessions/teams/team-1/stop");
  t.after(() => delete routes["/api/sessions/teams/team-1/stop"]);
  mac.answers["/api/sessions/teams/team-1/stop"] = { stopped: true };
  mac.pages[`codex:${CODEX}`].items = [
    { id: "u1", role: "user", kind: "text", text: "Ship pagination" },
    { id: "tool1", role: "tool", kind: "tool", text: "reach_team: team_delegate", status: "completed" },
    { id: "a1", role: "assistant", kind: "text", text: "Claude Code is building it." },
  ];
  const opened = [];
  await open(codexSession(), both(), { teams: [teamOf()], onSelect: (s) => opened.push(s) });
  const strip = await dom.waitFor(() => $(".team-strip"));
  assert.match(strip.querySelector("small").textContent, /1 working · 10 left/);
  assert.deepEqual([...strip.querySelectorAll("li button")].map((b) => b.getAttribute("aria-label")), [
    "Check the tests, Claude Code, Done",
    "Add pagination, Claude Code, Working",
  ]);
  // The lead's hand-off reads as one, not as a tool's name.
  assert.match($(".as-run-head").textContent, /Handed off a task/);
  await click([...strip.querySelectorAll("li button")].find((b) => /Add pagination/.test(b.textContent)));
  assert.deepEqual([opened[0].agent, opened[0].id], ["claude", CLAUDE]);
  await click(strip.querySelector(".team-strip-stop"));
  assert.match(strip.textContent, /Stops its helpers at work/);
  assert.deepEqual(mac.sent, [], "nothing until the second tap");
  await click([...strip.querySelectorAll("button")].find((b) => b.textContent === "Stop team"));
  assert.equal(mac.sent[0].route, "/api/sessions/teams/team-1/stop");
  await views.splice(0)[0].unmount();
  // The helper's own chat: whose team, and the way back.
  const back = [];
  await open(claudeSession(), both(), { teams: [teamOf()], onSelect: (s) => back.push(s) });
  const badge = await dom.waitFor(() => $(".team-helper-badge"));
  assert.match(badge.textContent, /Working for Codex’s team.*Open lead/);
  await click(badge);
  assert.deepEqual([back[0].agent, back[0].id], ["codex", CODEX]);
  assert.deepEqual(dom.errors, []);
});

test("the All page lists teams at work, and their reports stay out of Relays", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  const report = { ...relayOf({ id: "r9", steps: [{ kind: "report", to: { agent: "codex", id: CODEX } }], chain: [{ agent: "claude", id: CLAUDE, title: "Team · Add pagination" }] }) };
  await home([codexSession(), claudeSession()], both(), { teams: [teamOf()], relays: [report] });
  const card = await dom.waitFor(() => $(".hub-teams"));
  assert.match(card.textContent, /Ship pagination.*Codex leads · 1 helper working/);
  assert.equal($(".hub-relays"), null);
  assert.deepEqual(dom.errors, []);
});
