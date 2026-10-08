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
  const journal = [];
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
    // The away report is gone: nothing asks for it.
    "/api/sessions/journal": () => (journal.push(1), { events: [], waiting: [], now }),
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
  // No "while you were away" card, and nothing asked for one.
  assert.equal($(".hub-away"), null);
  assert.deepEqual(journal, []);
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

// The All page across every paired computer (src/fleet-chats.ts). Stand-ins:
// Studio answers; Attic is away; Lab keeps its chats from this phone (403);
// Office's live connection turned this phone away. Each stand-in is told
// apart by the address the phone asked.
const STUDIO = "22222222-3333-4444-8555-666666666666";
const studio = { id: "studio", name: "Studio", url: "https://studio.test", token: "studio-token", platform: "darwin" };
const attic = { id: "attic", name: "Attic", url: "https://attic.test", token: "attic-token", platform: "darwin" };
const lab = { id: "lab", name: "Lab", url: "https://lab.test", token: "lab-token", platform: "linux" };
const office = { id: "office", name: "Office", url: "https://office.test", token: "office-token", platform: "darwin" };
const tokenAt = Object.fromEntries([peer, studio, attic, lab, office].map((p) => [p.url, `Bearer ${p.token}`]));
// A route as each computer answers it: Attic fails the way a browser does
// when a computer is away; Lab says no.
const byComputer = (answers) => (init, href) => {
  if (href.origin === attic.url) throw new TypeError("Failed to fetch");
  if (href.origin === lab.url) return Response.json({ error: "This credential does not grant admin access." }, { status: 403 });
  return answers[href.origin]?.(init, href) ?? {};
};
// Every request the phone made: where to, and the credentials it carried.
const watchRequests = (t) => {
  const plain = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, init = {}) => {
    const href = new URL(url, dom.window.location.href);
    requests.push({ origin: href.origin, path: href.pathname, authorization: new Headers(init.headers).get("Authorization") });
    return plain(url, init);
  };
  t.after(() => (globalThis.fetch = plain));
  return requests;
};
// No computer ever gets another's credentials.
const ownCredentialsOnly = (requests) => {
  for (const { origin, authorization } of requests) if (authorization) assert.equal(authorization, tokenAt[origin], `credentials sent to ${origin}`);
};

test("the All page covers every paired computer: one search and one projects list, each row on its computer", async (t) => {
  const now = Date.now();
  // Studio's clock runs a little ahead of this one.
  const later = now + 7000;
  const requests = watchRequests(t);
  const opened = [];
  const plainList = routes["/api/sessions"];
  Object.assign(routes, {
    "/api/sessions": byComputer({
      [studio.url]: () => ({
        version: "s1",
        errors: {},
        sessions: [
          claudeSession({ id: STUDIO, title: "Tune the build", cwd: "/work/app", updatedAt: now - 500 }),
          codexSession({ id: NEW, title: "Draft release notes", cwd: "/work/site", updatedAt: now - 90000 }),
        ],
      }),
    }),
    "/api/sessions/activity": byComputer({
      [peer.url]: () => ({
        chats: [],
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
      [studio.url]: () => ({ chats: [{ agent: "claude", id: STUDIO, title: "Tune the build", cwd: "/work/app", files: [{ file: "/work/app/build.mjs", at: later }] }], overlaps: [] }),
    }),
    "/api/sessions/search": byComputer({
      [peer.url]: () => ({
        partial: false,
        results: [{ agent: "codex", id: CODEX, role: "user", at: now - 6000, snippet: "…clear the cache first…", title: "Fix login", cwd: "/work/app", listed: true }],
      }),
      [studio.url]: () => ({
        partial: false,
        results: [{ agent: "claude", id: STUDIO, role: "assistant", at: later - 3000, snippet: "…the build cache was stale…", title: "Tune the build", cwd: "/work/app", listed: true }],
      }),
    }),
  });
  t.after(() => {
    for (const r of ["/api/sessions/activity", "/api/sessions/search"]) delete routes[r];
    routes["/api/sessions"] = plainList;
  });
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  await mount(
    React.createElement(EverythingChat, {
      peer,
      feed: {
        sessions: [codexSession({ updatedAt: now - 1000 }), claudeSession({ updatedAt: now - 2000 })],
        errors: {},
        health: both(),
        failure: "",
        relays: [],
        reload: async () => {},
        recheck: () => {},
      },
      computers: [peer, studio, attic, lab, office],
      connections: { [office.id]: { state: "denied", devices: [] } },
      onOpenOn: (computer, chat) => opened.push([computer.id, chat.agent, chat.id]),
    }),
  );
  // Who isn't here, and why; the page names the computers it covers.
  const note = await dom.waitFor(() => $(".hub-fleet-note"));
  await dom.waitFor(() => note.textContent === "Attic didn’t answer. Office needs this phone paired again. Lab doesn’t share its chats with this phone.");
  assert.equal($(".hub-lead").textContent, "Every agent’s chats on Mac, Studio, Attic and Office, together.");
  // One projects list: the same folder on two computers is two projects.
  const projects = await dom.waitFor(() => ($$(".hub-project").length === 3 ? $$(".hub-project") : null));
  assert.deepEqual(
    projects.map((p) => p.getAttribute("aria-label")),
    ["app conversations on Studio", "app conversations on Mac", "site conversations on Studio"],
  );
  assert.deepEqual(projects.map((p) => p.querySelector("h2 .hub-computer").textContent), ["Studio", "Mac", "Studio"]);
  await dom.waitFor(() => /Tune the build.*Changed build\.mjs/.test(projects[0].textContent));
  // Two chats changing one file is the Mac's warning only: Studio's folder is on another disk.
  await dom.waitFor(() => projects[1].querySelector(".hub-overlap"));
  assert.match(projects[1].querySelector(".hub-overlap").textContent, /src\/auth\.ts changed by Codex \(“Fix login”\) and Claude Code \(“Refactor auth”\)/);
  assert.equal(projects[0].querySelector(".hub-overlap"), null);
  // One search: every computer's chats, newest first, each on its computer.
  await typeInto($('input[aria-label="Search all chats"]'), "cache");
  const hits = await dom.waitFor(() => ($$(".hub-hit").length === 2 && $(".hub-results .hub-note.bad") ? $$(".hub-hit") : null));
  assert.deepEqual(hits.map((h) => h.querySelector(".hub-computer").textContent), ["Studio", "Mac"]);
  assert.match(hits[0].textContent, /Tune the build.*Claude Code: …the build cache was stale…/);
  assert.equal($(".hub-results .hub-note.bad").textContent, "Attic didn’t answer.");
  // A chat on Studio goes to Studio (App switches computers); one here opens here.
  await click(hits[0]);
  assert.deepEqual(opened, [["studio", "claude", STUDIO]]);
  await click(hits[1]);
  await dom.waitFor(() => $(".as-page"));
  assert.match($(".as-title strong").textContent, /Fix login/);
  // Each computer was asked with its own credentials only; Office, which
  // turned this phone away, wasn't asked at all.
  ownCredentialsOnly(requests);
  assert.ok(requests.some((r) => r.origin === studio.url) && requests.some((r) => r.origin === attic.url) && requests.some((r) => r.origin === lab.url));
  assert.ok(!requests.some((r) => r.origin === office.url));
  // Lab said no once per question, and wasn't asked again; no computer was asked for a journal.
  assert.ok(requests.filter((r) => r.origin === lab.url).length <= 2, "Lab: asked once each for its list and activity");
  assert.ok(!requests.some((r) => r.path === "/api/sessions/journal"));
  assert.deepEqual(dom.errors, []);
});

test("a chat on another computer, opened from the All page, switches Reach to that computer and opens there", async (t) => {
  const now = Date.now();
  const requests = watchRequests(t);
  const computers = [peer, studio];
  const at = (href) => computers.find((p) => p.url === href.origin);
  const device = (p) => ({
    id: p.id,
    name: p.name,
    platform: "darwin",
    arch: "arm64",
    release: "25.0",
    roots: [],
    memory: { total: 1, free: 1 },
    uptime: 1,
    network: { connected: true, peers: [] },
    capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
  });
  const saved = { ...routes };
  t.after(() => {
    for (const key of Object.keys(routes)) if (!(key in saved)) delete routes[key];
    Object.assign(routes, saved);
  });
  // Studio's Reach stops answering for a while (its chats were listed just before).
  let studioAway = false;
  Object.assign(routes, {
    "/api/device": (init, href) =>
      at(href) === studio && studioAway ? Response.json({ error: "Reach is restarting." }, { status: 503 }) : device(at(href)),
    "/api/terminals": () => ({ sessions: [] }),
    "/api/codex": () => ({ sessions: [] }),
    "/api/activity": () => ({ activities: [] }),
    "/api/sessions/health": () => ({ agents: both() }),
    "/api/sessions": (init, href) => ({
      version: at(href).id,
      errors: {},
      sessions:
        at(href) === studio
          ? [claudeSession({ id: STUDIO, title: "Tune the build", cwd: "/work/site", updatedAt: now })]
          : [codexSession({ updatedAt: now - 1000 }), claudeSession({ updatedAt: now - 2000 })],
    }),
    "/api/sessions/journal": () => ({ events: [], waiting: [], now }),
    "/api/sessions/activity": () => ({ chats: [], overlaps: [] }),
    [`/api/sessions/claude/${STUDIO}`]: (init, href) =>
      at(href) === studio
        ? { session: claudeSession({ id: STUDIO, title: "Tune the build", cwd: "/work/site" }), items: [] }
        : Response.json({ error: "No such chat on this computer." }, { status: 404 }),
    // A long poll, as the others here: answered at once, it would be asked again at once.
    [`/api/sessions/claude/${STUDIO}/live`]: async () => (await settle(60), idleLive()),
  });
  // Live connections are beside the point here; none may leave this harness.
  const socket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    close() {}
    send() {}
  };
  t.after(() => (globalThis.WebSocket = socket));
  dom.window.localStorage.setItem("reach.devices", JSON.stringify(computers));
  dom.window.localStorage.setItem("reach.active", "mac");
  dom.window.localStorage.setItem("reach.chatAgent", "all");
  dom.window.sessionStorage.setItem("reach.place", JSON.stringify({ peer: "mac", page: "sessions" }));
  const { default: App } = await dom.load("/src/App.tsx");
  await mount(React.createElement(App));
  // Studio's chat is on the Mac's All page, marked as Studio's.
  const studioCard = () => $('.chat-card[aria-label="Tune the build, Claude Code, on Studio"]');
  // Tapped while Studio doesn't answer: Reach goes to Studio and says so. Picking
  // the Mac then keeps you on the Mac; the chat waiting for Studio doesn't
  // pull you back once the Mac has loaded.
  studioAway = true;
  await click(await dom.waitFor(studioCard, 15000));
  await dom.waitFor(() => dom.window.localStorage.getItem("reach.active") === "studio" && /out of reach/.test(dom.document.body.textContent));
  await click($('nav.fleet-switcher button[title="Mac"]'));
  await dom.waitFor(() => $(".chat-hub") && studioCard());
  await settle(300);
  assert.equal(dom.window.localStorage.getItem("reach.active"), "mac");
  assert.equal($(".as-page"), null);
  // Studio back: the same tap switches and opens the chat there.
  studioAway = false;
  await click(studioCard());
  // Reach is on Studio now, with the chat open there.
  await dom.waitFor(() => /Tune the build/.test($(".as-page .as-title strong")?.textContent || ""), 15000);
  assert.equal(dom.window.localStorage.getItem("reach.active"), "studio");
  // The chat opens from Studio's list at once, then reads itself from Studio.
  const reads = await dom.waitFor(() => {
    const found = requests.filter((r) => r.path === `/api/sessions/claude/${STUDIO}`);
    return found.length ? found : null;
  });
  assert.deepEqual([...new Set(reads.map((r) => r.origin))], [studio.url], "read from Studio only");
  ownCredentialsOnly(requests);
  assert.deepEqual(dom.errors, []);
});

test("Chat starts on All until you pick an app, then keeps the one you picked", async () => {
  const shownApp = () => $(".chat-current-name")?.textContent;
  // Nothing picked yet: every agent's chats together.
  await home([codexSession(), claudeSession()]);
  await dom.waitFor(() => $(".chat-hub"));
  assert.equal(shownApp(), "All");
  // Claude Code picked (the app menu at the top): Chat opens there next time.
  await click($(".chat-app-current"));
  await click($$('[role="menuitemradio"]').find((b) => b.getAttribute("aria-label") === "Claude Code"));
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "claude");
  await views.splice(0)[0].unmount();
  await home([codexSession(), claudeSession()]);
  await dom.waitFor(() => $(".chat-library") && !$(".chat-hub"));
  assert.equal(shownApp(), "Claude");
  await views.splice(0)[0].unmount();
  // The app picked isn't here anymore: back to All.
  dom.window.localStorage.setItem("reach.chatAgent", "gemini");
  await home([codexSession(), claudeSession()]);
  await dom.waitFor(() => $(".chat-hub"));
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "all");
  assert.deepEqual(dom.errors, []);
});

test("two chats with the same name changing one file read as two chats, not one name twice", async (t) => {
  const now = Date.now();
  routes["/api/sessions/activity"] = () => ({
    chats: [],
    overlaps: [
      {
        file: "/work/app/docs/notes.md",
        chats: [
          { agent: "claude", id: CLAUDE, title: "Refactor auth", at: now },
          { agent: "claude", id: NEW, title: "Refactor auth", at: now },
        ],
      },
    ],
  });
  t.after(() => delete routes["/api/sessions/activity"]);
  await home([claudeSession(), claudeSession({ id: NEW }), codexSession()]);
  const warning = await dom.waitFor(() => $(".hub-overlap"));
  assert.equal(warning.textContent, "docs/notes.md changed by two Claude Code chats named “Refactor auth” in the last half hour.");
  assert.deepEqual(dom.errors, []);
});
