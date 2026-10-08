import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// The Chat screens through the real components (src/EverythingChat.tsx, the
// Chat home; src/AgentSession.tsx, one session). The computer is a stand-in
// that records what the phone sent; each test checks the exact requests and
// that React rendered without warnings.

const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "test-token",
  platform: "darwin",
};
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
  live: { where: "claude-app", pid: 10, tty: null },
  ...extra,
});
const idleLive = () => ({
  version: 1,
  status: "idle",
  error: null,
  prompts: [],
  streaming: "",
  activity: null,
  items: 0,
});
const signedIn = [
  { agent: "codex", installed: true, signedIn: true },
  { agent: "claude", installed: true, signedIn: true },
];

// What the computer holds and what the phone sent it.
const mac = {
  sent: [],
  pages: {},
  live: idleLive(),
  logos: {},
  signIn: { state: "idle", url: null, code: null, error: null },
  reset() {
    this.sent = [];
    this.pages = {
      [`codex:${CODEX}`]: { session: codexSession(), items: [] },
      [`claude:${CLAUDE}`]: { session: claudeSession(), items: [] },
      // Codex names a new thread after its first message.
      [`codex:${NEW}`]: {
        session: codexSession({ id: NEW, title: "Add tests for login" }),
        items: [],
      },
      [`claude:${NEW}`]: {
        session: claudeSession({
          id: NEW,
          title: "Plan the API",
          live: undefined,
        }),
        items: [],
      },
    };
    this.live = idleLive();
    this.signIn = { state: "idle", url: null, code: null, error: null };
  },
  // A change the long poll reports: the screen reloads the transcript.
  bump(change = {}) {
    this.live = {
      ...this.live,
      ...change,
      version: this.live.version + 1,
      items: this.live.items + 1,
    };
  },
};
const SIGN_IN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

test("Codex async questions show during work and send choices and free text without consuming the draft", async () => {
  mac.pages[`codex:${CODEX}`].items = [{ id: "async-q", turnId: "turn-1", role: "assistant", kind: "text", text: "", questions: [
    { title: "Which target?", options: ["Mac", "Phone"] }, { title: "Anything else?", options: [] },
  ] }];
  mac.live = { ...idleLive(), status: "running" };
  await open(codexSession({ status: "running" }));
  await dom.waitFor(() => $(".as-async-questions .as-choices button"));
  assert.ok(!$(".as-review-dock"), "an optional question does not become a blocking approval");
  assert.equal(mac.sent.length, 0, "no answer is submitted automatically");
  assert.equal($$(".as-async-questions .as-choices button")[0].getAttribute("aria-pressed"), "true");
  await typeInto($(".as-composer textarea"), "Keep this draft");
  await click($$(".as-async-questions .as-choices button")[1]);
  await typeInto($(".as-async-questions input"), "Include offline mode");
  await click($(".as-async-questions .as-prompt-actions .primary"));
  await dom.waitFor(() => mac.sent.some((m) => m.route.endsWith("/questions/async-q")));
  const message = mac.sent.find((m) => m.route.endsWith("/questions/async-q"));
  assert.deepEqual(message.body, { turnId: "turn-1", answers: [{ index: 0, answer: "Phone" }, { index: 1, answer: "Include offline mode" }] });
  assert.ok(!mac.sent.some((m) => m.route.endsWith("/messages")));
  assert.equal($$(".as-user.pending").length, 0);
  assert.equal($(".as-composer textarea").value, "Keep this draft");
  await dom.waitFor(() => $$(".as-async-questions .as-answered").length === 2);
  assert.deepEqual($$(".as-async-questions .as-answered").map((el) => el.textContent), ["Phone", "Include offline mode"]);
  assert.deepEqual(dom.errors, []);
});

test("Codex async question refusal preserves answers and draft, and retry never becomes a queued message", async (t) => {
  const route = `/api/sessions/codex/${CODEX}/questions/async-q`;
  const original = routes[route];
  let refuse = true;
  routes[route] = (init) => {
    mac.sent.push({ route, body: JSON.parse(init.body) });
    return refuse
      ? new Response(JSON.stringify({ error: "Codex could not accept this answer. Try again." }), { status: 409, headers: { "Content-Type": "application/json" } })
      : { answered: true };
  };
  t.after(() => { routes[route] = original; });
  mac.pages[`codex:${CODEX}`].items = [{ id: "async-q", turnId: "turn-1", role: "assistant", kind: "text", text: "", questions: [
    { title: "Which target?", options: ["Mac", "Phone"] }, { title: "Anything else?", options: [] },
  ] }];
  mac.live = { ...idleLive(), status: "running", turnId: "turn-1" };
  await open(codexSession({ status: "running" }));
  await dom.waitFor(() => $(".as-async-questions .as-choices button"));
  await typeInto($(".as-composer textarea"), "Keep this independent draft");
  await click($$(".as-async-questions .as-choices button")[1]);
  await typeInto($(".as-async-questions input"), "Zoë — offline support");
  await click($(".as-async-questions .as-prompt-actions .primary"));
  await dom.waitFor(() => $(".as-async-questions [role=alert]"));
  assert.match($(".as-async-questions [role=alert]").textContent, /could not accept this answer/);
  assert.equal($(".as-async-questions input").value, "Zoë — offline support");
  await click($$(".as-async-questions .as-steps button")[0]);
  assert.equal($$(".as-async-questions .as-choices button")[1].getAttribute("aria-pressed"), "true");
  await click($$(".as-async-questions .as-steps button")[1]);
  assert.equal($(".as-composer textarea").value, "Keep this independent draft");
  assert.equal($$(".as-user.pending").length, 0);
  assert.deepEqual(mac.sent, [{ route, body: { turnId: "turn-1", answers: [{ index: 0, answer: "Phone" }, { index: 1, answer: "Zoë — offline support" }] } }], "a refused answer has no /messages or queue fallback");
  refuse = false;
  await click($(".as-async-questions .as-prompt-actions .primary"));
  await dom.waitFor(() => $$(".as-async-questions .as-answered").length === 2);
  assert.equal(mac.sent.length, 2);
  assert.deepEqual(mac.sent[1], mac.sent[0], "retry uses the same dedicated question route and answers");
  assert.equal($(".as-async-questions [role=alert]"), null);
  assert.equal($(".as-composer textarea").value, "Keep this independent draft");
  assert.equal($$(".as-user.pending").length, 0);
  assert.deepEqual(dom.errors, []);
});

test("Codex async questions retain native answers after reload without message bubbles", async () => {
  mac.pages[`codex:${CODEX}`].items = [{ id: "async-q", turnId: "turn-1", role: "assistant", kind: "text", text: "", questions: [
    { title: "Which target?", options: ["Mac", "Phone"], answer: "Phone" },
  ] }];
  mac.live = { ...idleLive(), status: "running", turnId: "turn-1" };
  await open(codexSession({ status: "running" }));
  await dom.waitFor(() => $(".as-async-questions .as-answered"));
  assert.equal($(".as-answered").textContent, "Phone");
  assert.equal($$(".as-async-questions button").length, 0);
  assert.equal($$(".as-user").length, 0);
  assert.deepEqual(dom.errors, []);
});

test("Codex async questions from a previous turn cannot be answered into the new turn", async () => {
  mac.pages[`codex:${CODEX}`].items = [{ id: "async-q", turnId: "turn-1", role: "assistant", kind: "text", text: "", questions: [
    { title: "Which target?", options: ["Mac", "Phone"] },
  ] }];
  mac.live = { ...idleLive(), status: "running", turnId: "turn-2" };
  await open(codexSession({ status: "running" }));
  await dom.waitFor(() => $(".as-async-questions .as-asked"));
  assert.equal($$(".as-async-questions button").length, 0);
  assert.equal(mac.sent.length, 0);
  assert.deepEqual(dom.errors, []);
});

test("close to its limit, a chat says so above the message box, and a tap shows each window and its reset", async () => {
  await open(codexSession(), [{ ...signedIn[0], usage: { available: true, updatedAt: Date.now(), windows: [
    { id: "weekly", label: "Weekly", usedPercent: 78, resetsAt: Date.now() + 60000, severity: "normal" },
    { id: "session", label: "5 hours", usedPercent: 95, resetsAt: Date.now() + 120000, severity: "warning" },
  ] } }]);
  await dom.waitFor(() => $(".usage-near"));
  assert.match($(".usage-near").textContent, /95% used · resets/);
  assert.ok($(".usage-near").classList.contains("critical"));
  await click($(".usage-near"));
  await dom.waitFor(() => $(".usage-sheet"));
  assert.equal($$(".as-usage-window progress").length, 2);
  assert.match($(".as-usage-windows").textContent, /5% remaining/);
  assert.match($(".as-usage-windows").textContent, /Resets/);
  assert.ok(!$(".as-review-dock"));
  // Below 90% too, its limits are in the chat's menu.
  await click($(".usage-sheet .chat-sheet-close"));
  await click($("[aria-label='More']"));
  const item = await dom.waitFor(() => $$(".as-details .relay-menu-item").find((b) => /^Usage/.test(b.textContent)));
  assert.match(item.textContent, /95% used · resets/);
  await click(item);
  assert.ok(await dom.waitFor(() => $(".usage-sheet")));
});

test("approval cards keep app images icon-sized instead of filling the sheet", async () => {
  await home([claudeSession({ status: "waiting", prompts: [{ id: "approval", kind: "tool", title: "Run tests?", decisions: ["allow", "deny"] }] })]);
  const icon = $(".need-icon img");
  assert.ok(icon, "test the real image path, not just the fallback SVG");
  assert.equal(icon.style.width, "24px");
  assert.equal(icon.style.height, "24px");
  assert.equal(icon.classList.contains("fill"), false);
  assert.match($(".need-card").textContent, /Run tests/);
  assert.equal($$(".need-actions button").length, 2);
});

test("app-owned Codex turns have Stop; queued messages sit above the composer and can be edited", async () => {
  const session = codexSession({ held: "codex-app", status: "running" });
  mac.pages[`codex:${CODEX}`].session = session;
  mac.live = { ...idleLive(), outbox: [{ id: "q-edit", text: "Then test", images: 0 }] };
  const route = `/api/sessions/codex/${CODEX}/queue/q-edit/edit`;
  const edits = [];
  routes[route] = (init) => (edits.push(JSON.parse(init.body)), { edited: true });
  await open(session);
  await dom.waitFor(() => $(".qm-row"));
  assert.ok(button("Stop"));
  assert.equal($(".as-scroll .qm"), null);
  assert.ok($(".as-composer .qm"));
  // Edit is reachable in the row and changes it where it waits.
  await click(button("Edit queued message"));
  const box = $('textarea[aria-label="Edit queued message"]');
  assert.equal(box.value, "Then test");
  dom.update(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(box, "Then test it all");
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await click($(".qm-edit button.primary"));
  await dom.waitFor(() => edits.length === 1);
  assert.deepEqual(edits, [{ text: "Then test it all" }]);
  assert.ok($(".qm-row"), "still queued, edited where it waits");
  assert.deepEqual(dom.errors, []);
  delete routes[route];
});

test("typing prepares the Claude draft without submitting; Send doesn't write the draft first", async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}/draft`;
  t.after(() => { delete routes[route]; });
  routes[route] = (init) => (mac.sent.push({ route, body: JSON.parse(init.body) }), { synced: true });
  await open(claudeSession());
  await dom.waitFor(() => $("textarea"));
  await typeInto($("textarea"), "h");
  await typeInto($("textarea"), "ello");
  await dom.waitFor(() => mac.sent.some((m) => m.route === route));
  assert.deepEqual(mac.sent.filter((m) => m.route === route).map((m) => m.body.text), ["hello"]);
  assert.ok(!mac.sent.some((m) => m.route.endsWith("/messages")));
  await typeInto($("textarea"), " again");
  await click(button("Send"));
  await dom.waitFor(() => mac.sent.some((m) => m.route.endsWith("/messages")));
  // The message itself replaces the box's text: the draft not yet written
  // ("hello again") isn't sent first (that cost each Send 0.5-1 s).
  const writes = mac.sent.filter((m) => m.route === route || m.route.endsWith("/messages"));
  assert.deepEqual(writes.filter((m) => m.route === route).map((m) => m.body.text), ["hello"]);
  assert.ok(writes.at(-1).route.endsWith("/messages"));
  assert.equal(writes.at(-1).body.text, "hello again");
  assert.deepEqual(dom.errors, []);
  delete routes[route];
});
test("a Claude app chat shows its permission mode in sight, as the app does, and picking one picks it in the app", async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}/mode`;
  t.after(() => { routes[route] = () => ({ applied: false }); });
  routes[route] = (init) => (mac.sent.push({ route, body: JSON.parse(init.body) }), { mode: JSON.parse(init.body).mode, applied: true });
  await open(claudeSession({ inApp: true, mode: "auto" }));
  await dom.waitFor(() => $(".as-mode"));
  // No settings to open first: the mode is right there in the composer.
  assert.equal($(".as-mode").textContent.trim(), "Auto");
  await click($(".as-mode"));
  await click(button("Plan"));
  await dom.waitFor(() => mac.sent.some((m) => m.route === route));
  assert.deepEqual(mac.sent.filter((m) => m.route === route).map((m) => m.body), [{ mode: "plan" }]);
  await dom.waitFor(() => $(".as-mode").textContent.trim() === "Plan");
  assert.deepEqual(dom.errors, []);
});
test("a Claude chat in Claude Code's default mode reads Manual, the Claude app's word for it", async (t) => {
  // Claude Code lists the mode as "Default"; the Claude app's menu calls it Manual.
  const modes = CLAUDE_OFFERS.modes;
  CLAUDE_OFFERS.modes = [{ id: "default", label: "Default" }, ...modes];
  const page = mac.pages[`claude:${CLAUDE}`];
  const before = page.session;
  t.after(() => { CLAUDE_OFFERS.modes = modes; page.session = before; });
  const session = claudeSession({ inApp: true, mode: "default" });
  page.session = session;
  await open(session);
  // Once the offers (with Claude Code's "Default") have arrived, the word is still the app's.
  await dom.waitFor(() => $(".as-mode") && $(".as-mode").textContent.trim() !== "");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal($(".as-mode").textContent.trim(), "Manual");
  assert.deepEqual(dom.errors, []);
});
const record = (route) => (init) => {
  mac.sent.push({ route, body: init?.body ? JSON.parse(init.body) : null });
  if (route.endsWith("/model")) {
    const [, , , agent, id] = route.split("/");
    const choice = JSON.parse(init.body);
    Object.assign(mac.pages[`${agent}:${id}`].session, choice);
    return { ...choice, applied: true };
  }
  return route.endsWith("/messages")
    ? { turnId: "turn-1" }
    : route === "/api/sessions"
      ? { threadId: NEW, turnId: null }
      : { ok: true };
};
// What each agent offers right now, as the Mac reports it (the phone has no list of its own).
const CODEX_OFFERS = {
  models: [
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      images: true,
      isDefault: true,
    },
    {
      id: "gpt-6-sol",
      name: "GPT-6 Sol",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      images: true,
      isDefault: false,
    },
  ],
  modes: [
    { id: "auto", label: "Ask for approval" },
    { id: "guardian-approvals", label: "Approve for me" },
    { id: "full-access", label: "Full access" },
    { id: "read-only", label: "Read only" },
    // A permission profile Codex added that Reach has never heard of.
    { id: "profile::network-only", label: "Network only" },
    { id: "custom", label: "Custom (config.toml)" },
  ],
  mode: "guardian-approvals",
};
const CLAUDE_OFFERS = {
  models: [],
  modes: [
    { id: "manual", label: "Manual" },
    { id: "plan", label: "Plan" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "auto", label: "Auto" },
    { id: "delegate", label: "delegate" },
  ],
  mode: null,
};
const routes = {
  "/api/sessions/models": (init, href) =>
    href?.searchParams.get("agent") === "claude" ? CLAUDE_OFFERS : CODEX_OFFERS,
  "/api/sessions/health": () => ({ agents: [] }),
  "/api/sessions/logos": () => ({ version: "v1", logos: mac.logos }),
  "/api/sessions/commands": () => ({
    commands: [
      {
        name: "compact",
        description: "Free up context by summarizing the conversation so far",
        hint: "<instructions>",
      },
      { name: "context", description: "Show current context usage", hint: "" },
      {
        name: "init",
        description: "Initialize a new CLAUDE.md file",
        hint: "",
      },
    ],
  }),
  "/api/sessions": (init) =>
    init?.method === "POST"
      ? record("/api/sessions")(init)
      : { sessions: [], errors: {} },
  "/api/sessions/sign-in": (init) => {
    const method = init?.method || "GET";
    if (method !== "GET")
      mac.sent.push({
        route: `${method} /api/sessions/sign-in`,
        body: init?.body ? JSON.parse(init.body) : null,
      });
    if (method === "POST") {
      const { agent } = JSON.parse(init.body);
      mac.signIn =
        agent === "claude"
          ? { agent, state: "link", url: SIGN_IN_URL, code: null, error: null }
          : {
              agent,
              state: "link",
              url: "https://auth.example/codex/device",
              code: "ABCD-1234",
              error: null,
            };
    }
    if (method === "DELETE") mac.signIn = { ...mac.signIn, state: "cancelled" };
    return mac.signIn;
  },
  "/api/sessions/sign-in/code": (init) => {
    mac.sent.push({
      route: "POST /api/sessions/sign-in/code",
      body: JSON.parse(init.body),
    });
    mac.signIn = { ...mac.signIn, state: "checking" };
    return mac.signIn;
  },
};
for (const agent of ["codex", "claude"])
  for (const id of [CODEX, CLAUDE, NEW]) {
    routes[`/api/sessions/${agent}/${id}`] = () => mac.pages[`${agent}:${id}`];
    // The real server holds this request until something changes.
    routes[`/api/sessions/${agent}/${id}/live`] = async () => (
      await settle(60),
      mac.live
    );
    for (const action of [
      "messages",
      "questions/async-q",
      "model",
      "stop",
      "prompts/7",
      "prompts/8",
      "prompts/consent%3Atoolu_1",
      "prompts/app-permission%3Atoolu_9",
      "prompts/app-permission%3Acodex%3Ac7",
    ])
      routes[`/api/sessions/${agent}/${id}/${action}`] = record(
        `/api/sessions/${agent}/${id}/${action}`,
      );
  }
  for (const [agent, id] of [["claude", CLAUDE], ["codex", CODEX]])
    routes[`/api/sessions/${agent}/${id}/mode`] ||= () => ({ applied: false });

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
  mac.logos = { codex: LOGO, claude: LOGO };
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  // These start on an app's own list: Codex unless a test picks another
  // (Chat itself starts on All until you pick an app).
  dom.window.localStorage.setItem("reach.chatAgent", "codex");
});
// A failed test must not leave its screen behind for the next one.
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
  $$("button").find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent.trim() === label,
  );
// The permission menu's rows by name (the line under each aside).
const modeNames = () => $$(".as-mode-menu-text > span").map((s) => s.textContent);
const modeRow = (name) =>
  $$(".as-mode-menu button").find((b) => b.querySelector(".as-mode-menu-text > span")?.textContent === name);
const click = async (element) => {
  assert.ok(element, "button exists");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const open = async (session, health = signedIn, on = peer, extra = {}) => {
  const view = await mount(
    React.createElement(AgentSessionView, {
      peer: on,
      session,
      siblings: [],
      health,
      logos: { codex: LOGO, claude: LOGO },
      onSelect() {},
      onBack() {},
      ...extra,
    }),
  );
  return view;
};
const home = async (sessions, health = signedIn, extra = {}, on = peer) => {
  const view = await mount(
    React.createElement(EverythingChat, {
      peer: on,
      feed: {
        sessions,
        errors: {},
        health,
        failure: "",
        reload: async () => {},
        recheck: () => {},
        ...extra,
      },
    }),
  );
  if (
    extra.macPrompts?.length ||
    sessions.some(
      (s) =>
        s.prompts?.length || s.asking || s.consent || s.status === "waiting",
    )
  ) {
    if (!$(".chat-review-link, .chat-needs-row")) {
      const waiting = sessions.find(
        (s) => s.prompts?.length || s.asking || s.consent || s.status === "waiting",
      );
      if (waiting)
        await chooseApp(waiting.agent === "claude" ? "Claude Code" : "Codex");
    }
    await click($(".chat-review-link, .chat-needs-row"));
  } else {
    const selected =
      dom.window.localStorage.getItem("reach.chatAgent") || "codex";
    const status = health.find((h) => h.agent === selected);
    if (
      status &&
      status.installed && status.signedIn && status.usable === false
    )
      await click(button("New chat"));
  }
  return view;
};
const accessRows = () =>
  $$(".access-row").map((r) => [
    r.querySelector(".access-name").textContent,
    r.querySelector(".access-state").textContent,
  ]);
const chooseApp = async (name) => {
  const scope = $("[role=dialog]") || dom.document;
  await click(
    [...scope.querySelectorAll(".chat-app-rail button")].find(
      (b) => b.getAttribute("aria-label") === name,
    ),
  );
};

test("a Codex chat reads like the Codex app", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    {
      id: "u1",
      role: "user",
      kind: "text",
      text: "Fix the login bug",
      turnId: "t1",
    },
    {
      id: "f1",
      role: "tool",
      kind: "file-change",
      text: "src/App.tsx",
      detail: "@@\n+a\n-b\n+c",
      status: "completed",
      turnId: "t1",
    },
    {
      id: "c1",
      role: "tool",
      kind: "command",
      text: "npm test",
      detail: "ok",
      status: "completed",
      turnId: "t1",
    },
    {
      id: "a1",
      role: "assistant",
      kind: "text",
      text: "Done. `npm test` passes.\n\n- one\n- two",
      turnId: "t1",
    },
    {
      id: "t1:error",
      role: "system",
      kind: "error",
      text: "You've hit your usage limit.",
      detail: "usageLimitExceeded",
      turnId: "t1",
    },
  ];
  await open(codexSession());
  await dom.waitFor(() => $(".as-user"));
  assert.equal($(".as-user").textContent, "Fix the login bug");
  assert.equal(
    $(".as-run-head span").textContent,
    "Edited App.tsx, ran a command",
  );
  assert.deepEqual(
    $$(".as-run-head b").map((b) => b.textContent),
    ["+2", "-1"],
  );
  assert.equal($(".as-assistant code").textContent, "npm test");
  assert.deepEqual(
    $$(".as-assistant li").map((li) => li.textContent),
    ["one", "two"],
  );
  assert.equal(
    $(".as-error.codex span").textContent,
    "You've hit your usage limit.",
  );
  assert.equal($("textarea").placeholder, "Do anything");
  await dom.waitFor(() => $(".as-model")?.textContent.includes("GPT-6 Astra"));
  assert.equal($(".as-model-effort").textContent, "Medium");
  assert.equal($(".as-mode").textContent, "Approve for me");
  // ChatGPT's header: round buttons floating over the chat, the title between.
  assert.equal($(".as-title strong").textContent, "Fix login");
  assert.equal($(".as-title small").textContent, "app · Codex app");
  assert.deepEqual(
    $$(".as-bar button").map((b) => b.getAttribute("aria-label")),
    ["Back to all sessions", null, "More"],
  );
  // No agent switcher up there (the user found it useless). The menu with
  // "Continue in…" is a still ⋯: no flipping coin of app logos.
  assert.equal($(".as-app-switch"), null);
  assert.equal($(".as-bar .agent-coin"), null);
  assert.equal($$(".as-bar button[aria-label='More'] img").length, 0);
  assert.ok($(".as-bar button[aria-label='More'] svg"));
  assert.deepEqual(dom.errors, []);
});

test("the Codex composer is one card with its controls inside, and the chat opens on its date", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    {
      id: "u1",
      role: "user",
      kind: "text",
      text: "Fix the login bug",
      turnId: "t1",
      at: Date.now() - 60000,
    },
  ];
  await open(codexSession());
  await dom.waitFor(() => $(".as-user"));
  const box = $(".as-composer .as-box");
  assert.ok(
    box.querySelector("textarea") &&
      box.querySelector(".as-tools .as-mode") &&
      box.querySelector(".as-tools .as-send"),
  );
  assert.match($(".as-when").textContent, /^Today \d/);
  assert.equal($(".as-hint"), null);
  assert.deepEqual(dom.errors, []);
});

test("the working time counts from the message just sent, not from the last one in the transcript (it read 1327m)", async () => {
  mac.pages[`claude:${CLAUDE}`].items = [
    {
      id: "u-old",
      role: "user",
      kind: "text",
      text: "Yesterday's question",
      at: Date.now() - 22 * 60 * 60 * 1000,
    },
    {
      id: "a-old:1",
      role: "assistant",
      kind: "text",
      text: "Yesterday's answer",
      at: Date.now() - 22 * 60 * 60 * 1000,
    },
  ];
  await open(claudeSession());
  await dom.waitFor(() => $(".as-user"));
  await typeInto($("textarea"), "Run the tests");
  await click(button("Send"));
  // Claude Code is now working on it; the transcript doesn't have the message yet.
  mac.bump({ status: "running" });
  await dom.waitFor(() => $(".as-working small"), 7000);
  assert.match($(".as-working small").textContent, /^\d{1,2}s ·$/);
  assert.deepEqual(dom.errors, []);
});

test("a sent message shows until the transcript has it, even when it repeats an earlier one", async () => {
  // "continue" was already sent once; the old screen dropped the new bubble at once.
  const items = mac.pages[`codex:${CODEX}`].items;
  items.push({
    id: "u1",
    role: "user",
    kind: "text",
    text: "continue",
    turnId: "t1",
  });
  await open(codexSession());
  await dom.waitFor(() => $(".as-user"));
  await typeInto($("textarea"), "continue");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/codex/${CODEX}/messages`,
      body: { text: "continue", images: [] },
    },
  ]);
  assert.equal($("textarea").value, "");
  assert.equal($$(".as-user.pending").length, 1);
  // The transcript reloads without the new message yet: still pending.
  mac.bump();
  await settle(250);
  assert.equal($$(".as-user.pending").length, 1);
  // Now it's there: the pending copy goes away and nothing is doubled.
  items.push({
    id: "u2",
    role: "user",
    kind: "text",
    text: "continue",
    turnId: "t2",
  });
  mac.bump();
  await dom.waitFor(() => !$(".as-user.pending"));
  assert.equal($$(".as-user").length, 2);
  assert.deepEqual(dom.errors, []);
});

test("the Computer Use confirmation shows Yes and submits nothing before its tap", async () => {
  const { describePrompt } = await import("../server/agent-sessions/codex-live.mjs");
  const prompt = describePrompt("mcpServer/elicitation/request", {
    threadId: CODEX, serverName: "cua_repl", mode: "form",
    message: 'Allow Computer Use to use "Google Chrome"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use" },
  });
  mac.live = { ...idleLive(), version: 5, status: "waiting", prompts: [{ ...prompt, id: "7" }] };
  await open(codexSession());
  await dom.waitFor(() => $(".as-prompt.elicitation"));
  const card = $(".as-prompt.elicitation");
  const choices = [...card.querySelectorAll(".as-prompt-actions button")];
  assert.deepEqual(choices.map(b => b.textContent.trim()), ["Yes", "No", "No, and stop"]);
  assert.match(card.textContent, /Allow Computer Use to use "Google Chrome"/);
  assert.doesNotMatch(card.textContent, /Complete this request in Codex/);
  assert.deepEqual(mac.sent, []);
  await click(choices[0]);
  assert.deepEqual(mac.sent, [{ route: `/api/sessions/codex/${CODEX}/prompts/7`, body: { decision: "accept" } }]);
});

test("Codex prompts are answered with one tap, with only the offered choices", async () => {
  mac.live = {
    ...idleLive(),
    version: 5,
    status: "waiting",
    prompts: [
      {
        id: "7",
        kind: "command",
        title: "Run this command?",
        command: "rm -rf build",
        cwd: "/work/app",
        decisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
      {
        id: "8",
        kind: "question",
        title: "Codex has a question",
        questions: [
          {
            id: "q",
            header: "Deploy",
            question: "Which target?",
            options: [{ label: "staging", description: "" }],
            other: false,
            secret: false,
          },
        ],
      },
    ],
  };
  await open(codexSession());
  await dom.waitFor(() => $$(".as-prompt").length === 2);
  const [command, question] = $$(".as-prompt");
  assert.equal(
    command.querySelector("strong").textContent,
    "Run this command?",
  );
  assert.equal(
    command.querySelector(".as-prompt-command").textContent,
    "rm -rf build",
  );
  assert.deepEqual(
    [...command.querySelectorAll(".as-prompt-actions button")].map(
      (b) => b.textContent,
    ),
    ["Yes", "Yes, for this session", "No", "No, and stop"],
  );
  // While Codex waits on you, nothing says it's working.
  assert.equal($(".as-working"), null);
  await click(
    [...command.querySelectorAll("button")].find(
      (b) => b.textContent === "Yes",
    ),
  );
  const answer = [...question.querySelectorAll("button")].find(
    (b) => b.textContent === "Submit",
  );
  assert.equal(answer.disabled, true);
  await click([...question.querySelectorAll(".as-choices button")][0]);
  await click(answer);
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/codex/${CODEX}/prompts/7`,
      body: { decision: "accept" },
    },
    {
      route: `/api/sessions/codex/${CODEX}/prompts/8`,
      body: { answers: { q: ["staging"] } },
    },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("Claude Code's prompts say what they'd allow; a dialog cancellation is labelled Cancel request", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  mac.live = {
    ...idleLive(),
    version: 4,
    status: "waiting",
    prompts: [
      {
        id: "7",
        kind: "tool",
        tool: "Bash",
        title: "Delete the build folder",
        command: "rm -rf build",
        reason: "",
        decisions: ["allow", "allowAlways", "deny"],
      },
      {
        id: "8",
        kind: "dialog",
        title: "Claude Code needs your answer on your Mac",
        decisions: ["cancel"],
      },
    ],
  };
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $$(".as-prompt").length === 2);
  const [tool, dialog] = $$(".as-prompt");
  assert.deepEqual(
    [...tool.querySelectorAll(".as-prompt-actions button")].map(
      (b) => b.textContent,
    ),
    ["Yes", "Yes, and don't ask again", "No"],
  );
  assert.deepEqual(
    [...dialog.querySelectorAll(".as-prompt-actions button")].map(
      (b) => b.textContent,
    ),
    ["Cancel request"],
  );
  await click(
    [...tool.querySelectorAll("button")].find(
      (b) => b.textContent === "Yes, and don't ask again",
    ),
  );
  await click(
    [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel request",
    ),
  );
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/claude/${CLAUDE}/prompts/7`,
      body: { decision: "allowAlways" },
    },
    {
      route: `/api/sessions/claude/${CLAUDE}/prompts/8`,
      body: { decision: "cancel" },
    },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("a question asked in the Claude app is answered here: one choice, or several when Claude allows it", async () => {
  // The session lives in the Claude app; its question came through Claude Code's hook.
  mac.live = {
    ...idleLive(),
    version: 5,
    status: "waiting",
    prompts: [
      {
        id: "7",
        kind: "question",
        title: "Claude has a question",
        questions: [
          {
            id: "Which checks?",
            header: "Checks",
            question: "Which checks?",
            multiSelect: true,
            other: true,
            secret: false,
            options: [
              { label: "Lint", description: "" },
              { label: "Tests", description: "" },
              { label: "Types", description: "" },
            ],
          },
          {
            id: "Where?",
            header: "Where",
            question: "Where?",
            multiSelect: false,
            other: true,
            secret: false,
            options: [
              { label: "Here", description: "" },
              { label: "CI", description: "" },
            ],
          },
        ],
      },
    ],
  };
  // Claude Code's registry says it's waiting too, so the read-only card's data comes along.
  const asking = {
    kind: "question",
    questions: [{ question: "Which checks?", options: [{ label: "Lint" }] }],
  };
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({
    status: "waiting",
    asking,
  });
  await open(claudeSession({ status: "waiting", asking }));
  await dom.waitFor(() => $(".as-prompt.question:not(.elsewhere)"));
  // Answered here, so the read-only card for the app's dialog isn't shown too.
  assert.ok(!$(".as-prompt.elsewhere"), "only the card that answers");
  // One question per page, the steps on top, as Claude Code asks them.
  const steps = () =>
    $$(".as-steps button").map((b) => [
      b.textContent,
      b.getAttribute("aria-current") === "step",
    ]);
  assert.deepEqual(steps(), [
    ["Checks", true],
    ["Where", false],
  ]);
  assert.equal($$(".as-prompt.question .as-question").length, 1);
  assert.equal($(".as-question-hint").textContent, "Choose any that apply");
  const choice = (label) =>
    [...$$(".as-prompt.question .as-choices button")].find(
      (b) => b.firstChild.textContent === label,
    );
  const action = (label) =>
    [...$$(".as-prompt.question .as-prompt-actions button")].find(
      (b) => b.textContent === label,
    );
  assert.equal(action("Next").disabled, true);
  await click(choice("Lint"));
  await click(choice("Types"));
  await click(choice("Tests"));
  await click(choice("Tests")); // picked again: unpicked
  assert.deepEqual(
    $$(".as-prompt.question .as-choices button").map((b) =>
      b.getAttribute("aria-pressed"),
    ),
    ["true", "false", "true"],
  );
  await click(action("Next"));
  assert.deepEqual(steps(), [
    ["Checks", false],
    ["Where", true],
  ]);
  assert.ok($(".as-steps button.done"), "the answered step is marked");
  await click(choice("Here"));
  await click(choice("CI")); // one answer: CI replaces Here
  assert.deepEqual(
    $$(".as-prompt.question .as-choices button").map((b) =>
      b.getAttribute("aria-pressed"),
    ),
    ["false", "true"],
  );
  // Back to a step and forward again keeps what was picked.
  await click($$(".as-steps button")[0]);
  assert.equal(choice("Types").getAttribute("aria-pressed"), "true");
  await click($$(".as-steps button")[1]);
  await click(action("Submit"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/claude/${CLAUDE}/prompts/7`,
      body: {
        answers: { "Which checks?": ["Lint", "Types"], "Where?": ["CI"] },
      },
    },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("picking the one answer of a question moves on to the next, like Claude Code", async () => {
  const single = (id, header, labels) => ({
    id,
    header,
    question: id,
    multiSelect: false,
    other: false,
    secret: false,
    options: labels.map((label) => ({ label, description: "" })),
  });
  mac.live = {
    ...idleLive(),
    version: 6,
    status: "waiting",
    prompts: [
      {
        id: "8",
        kind: "question",
        title: "Claude has a question",
        questions: [
          single("Which DB?", "DB", ["Postgres", "SQLite"]),
          single("Which ORM?", "ORM", ["Prisma", "None"]),
        ],
      },
    ],
  };
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-steps"));
  await click(
    [...$$(".as-choices button")].find(
      (b) => b.firstChild.textContent === "SQLite",
    ),
  );
  assert.equal($(".as-question p").textContent, "Which ORM?");
  await click(
    [...$$(".as-choices button")].find(
      (b) => b.firstChild.textContent === "None",
    ),
  );
  // The last page waits for Submit.
  assert.equal($(".as-question p").textContent, "Which ORM?");
  await click(
    [...$$(".as-prompt-actions button")].find(
      (b) => b.textContent === "Submit",
    ),
  );
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/claude/${CLAUDE}/prompts/8`,
      body: { answers: { "Which DB?": ["SQLite"], "Which ORM?": ["None"] } },
    },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("while Codex works, the send button stops it; typing turns it back into Send", async () => {
  mac.live = {
    ...idleLive(),
    version: 3,
    status: "running",
    activity: "Running npm test",
    streaming: "Looking at",
  };
  await open(codexSession());
  await dom.waitFor(() => button("Stop"));
  assert.equal($(".as-working span").textContent, "Running npm test");
  // Reach's mascot types at its laptop while the agent works.
  assert.ok($(".as-working svg.mascot-typing[aria-hidden='true']"));
  assert.equal($(".as-assistant.streaming").textContent, "Looking at");
  await click(button("Stop"));
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/codex/${CODEX}/stop`, body: {} },
  ]);
  await typeInto($("textarea"), "also check signup");
  assert.equal(button("Stop"), undefined);
  assert.ok(button("Send"));
  assert.deepEqual(dom.errors, []);
});

test("a chat open in the Codex app says so and keeps the app's settings", async () => {
  mac.pages[`codex:${CODEX}`].session = codexSession({ held: "codex-app" });
  await open(codexSession({ held: "codex-app" }));
  // Where it lives is in the header, as a word; no paragraph about it.
  await dom.waitFor(() => $(".as-model")?.textContent.includes("GPT-6 Astra"));
  assert.equal($$(".as-hint").length, 0);
  assert.equal($(".as-title small").textContent, "app · Open in Codex app");
  // A holder hint must not disable the selector. The actual native update
  // decides whether this connection can apply the choice.
  await click($(".as-model"));
  assert.ok($(".ms-strip"));
  assert.equal($$(".as-hint").length, 0);
  assert.equal($$(".as-composer .as-picker").length, 0);
  await click($(".as-mode"));
  const menu = await dom.waitFor(() => $(".as-mode-menu"));
  assert.equal(menu.querySelector(".as-mode-menu-locked"), null);
  assert.ok($$(".as-mode-menu button").every((b) => !b.disabled));
  assert.equal($$(".as-mode-menu button[aria-checked=true]").length, 1);
  await click($(".as-mode-scrim"));
  await typeInto($("textarea"), "hi");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/codex/${CODEX}/messages`,
      body: { text: "hi", images: [] },
    },
  ]);
});

// The model and effort, as the ChatGPT and Claude phone apps have you pick
// them (Oct 6). Before, every model and then every effort sat in one list.
const modelRow = (name) => $$(".ms-card[aria-label=Models] > button").find((b) => b.querySelector(".ms-text > span").textContent === name);
const checkedModel = () => $(".ms-card[aria-label=Models] [aria-checked=true] .ms-text > span")?.textContent;
test("an unlisted selected model stays visible, never checks the default, and a refresh recovers its native entry", async (t) => {
  const selected = codexSession({ model: "gpt-6.1-sol", effort: "high" });
  mac.pages[`codex:${CODEX}`].session = selected;
  const original = routes["/api/sessions/models"];
  let reads = 0;
  const offers = { ...CODEX_OFFERS, models: [...CODEX_OFFERS.models] };
  routes["/api/sessions/models"] = () => { reads++; return offers; };
  t.after(() => { routes["/api/sessions/models"] = original; });
  await open(selected, signedIn, { ...peer, url: "https://unlisted-model.test" });
  await dom.waitFor(() => reads && !$(".as-model").disabled);
  assert.match($(".as-model").textContent, /GPT-6.1 Sol High/);
  await click($(".as-model"));
  assert.match($(".ms-strip-label").textContent, /GPT-6.1 Sol High/);
  assert.equal($(".ms-dots"), null, "another model's effort choices must not replace the selected model's");
  await click($(".ms-strip-label"));
  assert.equal(checkedModel(), "GPT-6.1 Sol");
  assert.equal(modelRow("GPT-6.1 Sol").disabled, true, "the unlisted entry describes the current selection without inventing availability");
  assert.match(modelRow("GPT-6.1 Sol").textContent, /Not in this connection’s model list/);
  assert.equal(modelRow("GPT-6 Astra").getAttribute("aria-checked"), "false");
  assert.deepEqual(mac.sent, [], "opening settings never changes the native model");
  offers.models.push({ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium" });
  await click(button("Refresh model list"));
  await dom.waitFor(() => reads === 2 && modelRow("GPT-6.1 Sol") && !modelRow("GPT-6.1 Sol").disabled);
  assert.equal(checkedModel(), "GPT-6.1 Sol");
  assert.equal($(".ms-current-unlisted"), null);
  assert.deepEqual(mac.sent, [], "refreshing the catalog preserves the actual selected model and effort");
  await click($(".ms-done"));
  assert.match($(".as-model").textContent, /GPT-6.1 Sol High/);
  assert.deepEqual(dom.errors, []);
});

test("Codex: the model and effort as words and dots over the composer, the models in Configure", async () => {
  const view = await open(codexSession());
  await dom.waitFor(() => $(".as-model") && !$(".as-model").disabled);
  await click($(".as-model"));
  assert.equal($(".as-model").getAttribute("aria-expanded"), "true");
  const strip = $(".ms-strip");
  assert.ok(strip.closest(".as-page"), "on the page, not clipped inside the composer");
  assert.equal($(".ms-strip-label").textContent.trim(), "GPT-6 Astra Medium");
  assert.deepEqual($$(".ms-dots button").map((b) => b.getAttribute("aria-label")), ["Low", "Medium", "High", "Extra High"]);
  // The track fills up to the level in use.
  assert.deepEqual($$(".ms-dots button").map((b) => b.classList.contains("filled")), [true, true, false, false]);
  // The words open Configure: the models, the one in use checked, and Done.
  await click($(".ms-strip-label"));
  assert.equal($(".ms-sheet").getAttribute("aria-label"), "Configure");
  assert.equal(checkedModel(), "GPT-6 Astra");
  await click(modelRow("GPT-6 Sol"));
  // A pick stays in the sheet, as the app's; Done closes it.
  await dom.waitFor(() => checkedModel() === "GPT-6 Sol");
  await click($$(".ms-done")[0]);
  assert.equal($$(".ms-sheet").length, 0);
  assert.equal($(".as-model").textContent.trim(), "GPT-6 Sol Medium");
  // A dot picks the effort at once; the dots stay for another.
  await click($(".as-model"));
  await click($$(".ms-dots button").find((b) => b.getAttribute("aria-label") === "High"));
  await dom.waitFor(() => $(".as-model").textContent.trim() === "GPT-6 Sol High");
  assert.ok($(".ms-strip"));
  assert.equal($(".ms-dots button[aria-checked=true]").getAttribute("aria-label"), "High");
  await click($(".as-mode-scrim"));
  await typeInto($("textarea"), "go");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/codex/${CODEX}/model`, body: { model: "gpt-6-sol", effort: "medium" } },
    { route: `/api/sessions/codex/${CODEX}/model`, body: { model: "gpt-6-sol", effort: "high" } },
    {
      route: `/api/sessions/codex/${CODEX}/messages`,
      body: { text: "go", images: [] },
    },
  ]);
  // Sending drops local picks: the native read still returns the saved one.
  await dom.waitFor(() => $(".as-model").textContent.includes("GPT-6 Sol"));
  await view.unmount();
  await open(codexSession());
  await dom.waitFor(() => $(".as-model").textContent.includes("GPT-6 Sol"));
  assert.match($(".as-model").textContent, /High/);
  assert.deepEqual(dom.errors, []);
});

test("Codex: Speed in Configure uses the phone's own menu and changes the chat's speed at once, as in the Codex app", async (t) => {
  const astra = CODEX_OFFERS.models[0];
  const before = { ...astra };
  // As Codex really lists them: only the extra tier, no standard one.
  Object.assign(astra, { speeds: [{ id: "priority", name: "Fast", note: "2x speed, increased usage" }], defaultSpeed: null });
  t.after(() => { for (const k of Object.keys(astra)) delete astra[k]; Object.assign(astra, before); });
  await open(codexSession(), signedIn, { ...peer, url: "https://codex-speed.test" });
  await dom.waitFor(() => $(".as-model") && !$(".as-model").disabled);
  await click($(".as-model"));
  await click($(".ms-strip-label"));
  const row = await dom.waitFor(() => $(".ms-select"));
  assert.match(row.textContent, /^Speed\s*Standard/);
  const select = row.querySelector("select");
  assert.deepEqual([...select.options].map((o) => o.textContent), ["Standard", "Fast"]);
  select.value = "priority";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await dom.waitFor(() => mac.sent.some((m) => m.route.endsWith("/model")));
  // The chat's own speed, changed now (with its model), not on the next message.
  const change = mac.sent.find((m) => m.route.endsWith("/model"));
  assert.equal(change.route, `/api/sessions/codex/${CODEX}/model`);
  assert.equal(change.body.speed, "priority");
  assert.equal(typeof change.body.model, "string");
  await click($(".ms-done"));
  await typeInto($("textarea"), "go");
  await click(button("Send"));
  assert.equal(mac.sent.at(-1).body.speed, undefined);
});

test("Claude: Select model with what each is for, and Effort as its own row that opens the levels", async (t) => {
  const offers = CLAUDE_OFFERS.models;
  CLAUDE_OFFERS.models = [
    { id: "claude-fable-5-1", name: "Fable 5.1", description: "For your toughest challenges", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null },
    { id: "claude-opus-5-5", name: "Opus 5.5", description: "For complex work and everyday tasks", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, isDefault: true },
    { id: "claude-haiku-4-5", name: "Haiku 4.5", description: "Fastest for quick answers", efforts: [], defaultEffort: null },
  ];
  t.after(() => { CLAUDE_OFFERS.models = offers; });
  await open(claudeSession(), signedIn, { ...peer, url: "https://claude-sheet.test" });
  await dom.waitFor(() => $(".as-model")?.textContent.includes("Opus"));
  await click($(".as-model"));
  const sheet = await dom.waitFor(() => $(".ms-sheet.ms-claude"));
  assert.equal(sheet.querySelector("h2").textContent, "Select model");
  assert.ok(sheet.querySelector("button[aria-label=Close]"));
  assert.equal(checkedModel(), "Opus 5.5");
  assert.match(modelRow("Fable 5.1").textContent, /For your toughest challenges/);
  // Effort: a row of its own, its levels one tap further.
  const row = $(".ms-row");
  assert.match(row.textContent, /^Effort/);
  await click(row);
  assert.equal($(".ms-sheet h2").textContent, "Effort");
  assert.deepEqual($$(".ms-card[aria-label=Effort] .ms-text > span").map((s) => s.textContent), ["Low", "Medium", "High", "Extra high", "Max"]);
  await click($$(".ms-card[aria-label=Effort] button").find((b) => b.textContent.includes("Extra high")));
  await dom.waitFor(() => !$(".ms-sheet"));
  assert.match($(".as-model").textContent, /Opus 5\.5\s*Extra/);
  // The level alone: a Claude app chat changes only its effort.
  assert.deepEqual(mac.sent.at(-1), { route: `/api/sessions/claude/${CLAUDE}/model`, body: { effort: "xhigh" } });
  // A model without effort levels has no Effort row.
  await click($(".as-model"));
  await click(await dom.waitFor(() => modelRow("Haiku 4.5")));
  await dom.waitFor(() => !$(".ms-sheet"));
  await click($(".as-model"));
  await dom.waitFor(() => $(".ms-sheet"));
  assert.equal($(".ms-row"), null);
  await click($(".ms-sheet button[aria-label=Close]"));
  assert.equal($(".ms-sheet"), null);
});

test("a model change on a working app-labelled chat waits for native confirmation", async () => {
  mac.pages[`codex:${CODEX}`].session = codexSession({ held: "codex-app", status: "running" });
  mac.live = { ...idleLive(), status: "running" };
  const route = `/api/sessions/codex/${CODEX}/model`;
  const previous = routes[route];
  let finish;
  routes[route] = (init) => {
    mac.sent.push({ route, body: JSON.parse(init.body) });
    return new Promise(resolve => { finish = resolve; });
  };
  try {
    await open(codexSession({ held: "codex-app", status: "running" }));
    await dom.waitFor(() => $(".as-model")?.textContent.includes("Astra"));
    await click($(".as-model"));
    await click($(".ms-strip-label"));
    await click(modelRow("GPT-6 Sol"));
    assert.match($(".ms-sheet").textContent, /Applies to the next turn/);
    assert.match($(".ms-sheet").textContent, /Changing model/);
    assert.match($(".as-model").textContent, /Astra/);
    assert.ok($$(".ms-card button").every(b => b.disabled));
    finish({ applied: true, model: "gpt-6-sol", effort: "medium" });
    await dom.waitFor(() => /Sol/.test($(".as-model").textContent));
    assert.equal(mac.sent.length, 1);
  } finally { routes[route] = previous; }
});

test("a confirmed model selection follows later native changes and never resends the old choice", async () => {
  await open(codexSession());
  await dom.waitFor(() => $(".as-model")?.textContent.includes("Astra"));
  await click($(".as-model"));
  await click($(".ms-strip-label"));
  await click(modelRow("GPT-6 Sol"));
  await dom.waitFor(() => checkedModel() === "GPT-6 Sol");
  await click($(".ms-done"));
  // Another device changes the same native chat before the next message.
  Object.assign(mac.pages[`codex:${CODEX}`].session, { model: "gpt-6-astra", effort: "low" });
  mac.bump();
  await dom.waitFor(() => /Astra Low/.test($(".as-model").textContent));
  await typeInto($("textarea"), "use the current native settings");
  await click(button("Send"));
  assert.deepEqual(mac.sent.at(-1).body, { text: "use the current native settings", images: [] });
  assert.deepEqual(dom.errors, []);
});

test("a rejected native model change stays visible beside the choices and keeps the actual model", async () => {
  const route = `/api/sessions/codex/${CODEX}/model`;
  const previous = routes[route];
  routes[route] = () => Response.json({ error: "Codex didn't confirm the model change. Check its model before trying again." }, { status: 409 });
  try {
    await open(codexSession());
    await dom.waitFor(() => $(".as-model")?.textContent.includes("Astra"));
    await click($(".as-model"));
    await click($(".ms-strip-label"));
    await click(modelRow("GPT-6 Sol"));
    await dom.waitFor(() => $(".ms-sheet [role=alert]"));
    assert.match($(".ms-sheet [role=alert]").textContent, /didn't confirm the model change/);
    assert.match($(".as-model").textContent, /Astra/);
    assert.equal(checkedModel(), "GPT-6 Astra");
  } finally { routes[route] = previous; }
});

// Oct 6: a tapped effort level seemed to do nothing (the sheet went back to
// the models at once, and a refusal was easy to miss).
test("a tapped effort level turns until Claude confirms, and a refusal stays on that page", async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}/model`, previous = routes[route];
  const offers = CLAUDE_OFFERS.models;
  CLAUDE_OFFERS.models = [{ id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: null, isDefault: true }];
  let finish;
  routes[route] = () => new Promise((resolve) => { finish = resolve; });
  t.after(() => { routes[route] = previous; CLAUDE_OFFERS.models = offers; });
  await open(claudeSession(), signedIn, { ...peer, url: "https://claude-effort-wait.test" });
  await dom.waitFor(() => $(".as-model")?.textContent.includes("Opus"));
  await click($(".as-model"));
  await click(await dom.waitFor(() => $(".ms-row")));
  const row = () => $$(".ms-card[aria-label=Effort] button").find((b) => b.textContent.startsWith("Extra high"));
  await click(row());
  // Still on the levels, the tapped one turning.
  assert.equal($(".ms-sheet h2").textContent, "Effort");
  assert.equal(row().getAttribute("aria-busy"), "true");
  assert.ok(row().querySelector(".spin"));
  finish(Response.json({ error: "Open this chat in the Claude app on your Mac to change its effort from here." }, { status: 409 }));
  await dom.waitFor(() => $(".ms-sheet [role=alert]"));
  assert.equal($(".ms-sheet h2").textContent, "Effort");
  assert.match($(".ms-sheet [role=alert]").textContent, /Open this chat in the Claude app/);
  assert.equal(row().querySelector(".spin"), null);
});

test("a Claude desktop model refusal keeps the current model and the error in its sheet", async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}/model`, previous = routes[route];
  const offers = CLAUDE_OFFERS.models;
  CLAUDE_OFFERS.models = [
    { id: "claude-opus-5-5", name: "Opus", efforts: ["max"], defaultEffort: "max" },
    { id: "claude-haiku-4-5", name: "Haiku", efforts: [], defaultEffort: null },
  ];
  routes[route] = () => Response.json({ error: "Reach can't change the model or thinking level in Claude desktop yet. Your current selection is unchanged." }, { status: 409 });
  t.after(() => { routes[route] = previous; CLAUDE_OFFERS.models = offers; });
  await open(claudeSession(), signedIn, { ...peer, url: "https://claude-model.test" });
  await dom.waitFor(() => $(".as-model")?.textContent.includes("Opus"));
  await click($(".as-model"));
  await click(await dom.waitFor(() => modelRow("Haiku")));
  await dom.waitFor(() => $(".ms-sheet [role=alert]"));
  assert.match($(".ms-sheet [role=alert]").textContent, /current selection is unchanged/);
  assert.match($(".as-model").textContent, /Opus/);
  assert.equal(checkedModel(), "Opus");
});

test("retrying an empty model list fetches new offers instead of reusing the empty cache", async (t) => {
  const route = "/api/sessions/models", previous = routes[route];
  let reads = 0;
  routes[route] = () => (++reads === 1 ? { models: [], mode: null } : CODEX_OFFERS);
  t.after(() => { routes[route] = previous; });
  await open(codexSession(), signedIn, { ...peer, url: "https://model-retry.test" });
  await dom.waitFor(() => $(".as-model"));
  await click($(".as-model"));
  const retry = await dom.waitFor(() => $(".ms-retry"));
  assert.equal(retry.textContent, "Try loading models again");
  await click(retry);
  await dom.waitFor(() => $(".ms-strip") || modelRow("GPT-6 Sol"));
  assert.equal(reads, 2);
  assert.equal($(".ms-sheet [role=alert]"), null);
});

test("a desktop-owned permission pick waits for confirmation and a failure keeps the old mode", async () => {
  const route = `/api/sessions/codex/${CODEX}/mode`, previous = routes[route];
  let finish;
  routes[route] = () => new Promise(resolve => { finish = resolve; });
  try {
    await open(codexSession({ held: "codex-app" }));
    await dom.waitFor(() => $(".as-mode"));
    await click($(".as-mode"));
    await click($$(".as-mode-menu button").find(b => b.textContent.includes("Ask for approval")));
    assert.equal($(".as-mode").textContent, "Approve for me");
    assert.ok($$(".as-mode-menu button").every(b => b.disabled));
    finish(Response.json({ error: "Codex did not confirm permissions." }, { status: 409 }));
    await dom.waitFor(() => $(".as-mode-menu [role=alert]"));
    assert.equal($(".as-mode").textContent, "Approve for me");
    assert.ok($$(".as-mode-menu button").every(b => !b.disabled));
  } finally { routes[route] = previous; }
});

test("an unconfirmed approval is read-only in both the conversation and Needs you", async () => {
  const prompt = { id: "7", kind: "command", title: "Allow command?", decisions: ["accept", "decline"], attempted: true };
  mac.live = { ...idleLive(), status: "waiting", prompts: [prompt] };
  await open(codexSession());
  await dom.waitFor(() => $(".as-prompt.command"));
  assert.ok($$(".as-prompt-actions button").every(b => b.disabled));
  assert.match($(".as-prompt").textContent, /previous answer could not be confirmed/);
  await home([codexSession({ status: "waiting", prompts: [prompt] })]);
  assert.deepEqual($$(".need-actions button").map(b => b.textContent), ["Open"]);
  assert.deepEqual(mac.sent, []);
});

test("a Claude Code chat reads like Claude Code; one open in the Claude app still takes a reply", async () => {
  mac.pages[`claude:${CLAUDE}`].items = [
    { id: "u1", role: "user", kind: "text", text: "Refactor the auth module" },
    {
      id: "e1",
      role: "system",
      kind: "error",
      text: "Failed to authenticate: OAuth session expired",
      detail: "authentication_failed",
    },
  ];
  await open(claudeSession(), [
    { agent: "claude", installed: true, signedIn: false },
  ]);
  await dom.waitFor(() => $(".as-error.claude"));
  assert.ok($(".as-page.claude"));
  assert.equal(
    $(".as-error.claude header").textContent.trim(),
    "Authentication failed",
  );
  assert.equal(
    $(".as-error.claude p").textContent,
    "Failed to authenticate: OAuth session expired",
  );
  // Replies go through the Claude Code CLI, which signs in on its own: one clear row, with Sign in.
  assert.deepEqual(accessRows(), [["Claude Code CLI", "Not signed in"]]);
  assert.equal(
    $(".access-note").textContent,
    "Reach replies through the CLI, so only the CLI needs signing in.",
  );
  assert.equal($(".as-hint"), null);
  assert.ok($(".access-row .access-action button"));
  assert.equal($("textarea").disabled, false);
  assert.equal($(".as-mode").textContent, "Auto");
  assert.equal($(".as-model").textContent.trim(), "Opus 5.5 Max");
  await typeInto($("textarea"), "keep going");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/claude/${CLAUDE}/messages`,
      body: { text: "keep going", images: [] },
    },
  ]);
  assert.equal($(".as-title small").textContent, "app · Claude app");
  assert.deepEqual(dom.errors, []);
});

test("out of usage, each agent's own way to more usage opens here, and nothing else becomes a link", async () => {
  const codexLimit =
    "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 9th, 2026 9:25 PM.";
  mac.pages[`codex:${CODEX}`].items = [
    {
      id: "u1",
      role: "user",
      kind: "text",
      text: "Fix the login bug",
      turnId: "t1",
    },
    {
      id: "t1:error",
      role: "system",
      kind: "error",
      text: codexLimit,
      detail: "usageLimitExceeded",
      turnId: "t1",
    },
    { id: "u2", role: "user", kind: "text", text: "again", turnId: "t2" },
    // Worded some other way: shown as Codex wrote it.
    {
      id: "t2:error",
      role: "system",
      kind: "error",
      text: "You’ve hit your usage limit.",
      detail: "usageLimitExceeded",
      turnId: "t2",
    },
  ];
  // Codex's window now ends later than this old error's: each line keeps its own date.
  const resetsAt = Date.UTC(2026, 9, 16, 21, 25);
  const codexHealth = [
    {
      agent: "codex",
      installed: true,
      signedIn: true,
      usable: false,
      resetsAt,
      resetCredits: 1,
    },
  ];
  let view = await open(codexSession(), codexHealth);
  await dom.waitFor(() => $(".as-error.codex"));
  // The Codex app's own line: its words, the message's own date, no web address, no button.
  assert.deepEqual(
    $$(".as-error.codex span").map((e) => e.textContent),
    [
      "You’ve hit your usage limit. Upgrade your plan or add credits to continue, or try again at Oct 9, 2026, 9:25 PM.",
      "You’ve hit your usage limit.",
    ],
  );
  assert.equal($(".as-error.codex a, .as-error.codex button"), null);
  // One slim line, not a card: until when, Reset (asks first, spends nothing
  // until confirmed) and Upgrade.
  assert.equal($(".as-banner"), null);
  const strip = $(".usage-strip");
  assert.match(strip.querySelector(".usage-strip-text").textContent, /^Out of Codex usage until Oct 16/);
  const upgrade = [...strip.querySelectorAll("a")].find(
    (a) => a.textContent.trim() === "Upgrade",
  );
  assert.equal(
    upgrade.getAttribute("href"),
    "https://chatgpt.com/codex/settings/usage",
  );
  assert.equal(upgrade.getAttribute("target"), "_blank");
  assert.equal(upgrade.getAttribute("rel"), "noopener noreferrer");
  await click(
    [...strip.querySelectorAll("button")].find((b) => b.textContent === "Reset"),
  );
  assert.match(strip.querySelector(".usage-strip-text").textContent, /can’t be undone/);
  await click(
    [...strip.querySelectorAll("button")].find((b) => b.textContent === "Cancel"),
  );
  assert.match(strip.querySelector(".usage-strip-text").textContent, /^Out of Codex usage/);
  assert.deepEqual(mac.sent, [], "nothing spent");
  await view.unmount();
  views.length = 0;

  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  mac.pages[`claude:${CLAUDE}`].items = [
    {
      id: "e1",
      role: "system",
      kind: "error",
      text: "API Error: Request rejected (429) · the request was rate limited · send a message to retry",
      detail: "rate_limit",
    },
    {
      id: "e2",
      role: "system",
      kind: "error",
      text: "You've hit your limit · resets 5pm (Europe/Paris)",
      detail: "rate_limit",
    },
  ];
  view = await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $$(".as-error.claude").length === 2);
  const [slow, limit] = $$(".as-error.claude");
  // A brief slowdown is only an error; a used-up limit says so and links Claude's usage page.
  assert.equal(slow.querySelector("header").textContent.trim(), "Rate limit");
  assert.equal(slow.querySelector("a"), null);
  assert.equal(
    limit.querySelector("header").textContent.trim(),
    "Usage limit reached",
  );
  assert.equal(
    limit.querySelector("p").textContent,
    "You've hit your limit · resets 5pm (Europe/Paris)",
  );
  assert.equal(limit.querySelector("a.as-usage").textContent, "Get more usage");
  assert.equal(
    limit.querySelector("a.as-usage").getAttribute("href"),
    "https://claude.ai/settings/usage",
  );
  await view.unmount();
  views.length = 0;

  // A limit hit by a turn running from here shows before the transcript has it.
  mac.pages[`claude:${CLAUDE}`].items = [];
  mac.live = {
    ...idleLive(),
    error:
      "You've hit your weekly limit · ask your admin to raise it at claude.ai/admin-settings/usage",
  };
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-error.claude a.as-usage"));
  assert.equal(
    $(".as-error.claude a.as-usage").getAttribute("href"),
    "https://claude.ai/admin-settings/usage",
  );
  assert.deepEqual(dom.errors, []);
});

test("an error the transcript already shows isn't shown a second time", async () => {
  const limit = "You've hit your limit · resets 5pm (Europe/Paris)";
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  mac.pages[`claude:${CLAUDE}`].items = [
    { id: "u1", role: "user", kind: "text", text: "keep going" },
    {
      id: "e1",
      role: "system",
      kind: "error",
      text: limit,
      detail: "rate_limit",
    },
  ];
  // The turn Reach ran ended on that error; its live state still holds it.
  mac.live = { ...idleLive(), error: limit };
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-error"));
  await settle(120);
  assert.equal($$(".as-error").length, 1);
  assert.equal($$("a.as-usage").length, 1);
  assert.deepEqual(dom.errors, []);
});

test("Chat home says Codex is out of usage and where to get more", async () => {
  await home(
    [],
    [
      {
        agent: "codex",
        installed: true,
        signedIn: true,
        usable: false,
        resetsAt: null,
      },
      { agent: "claude", installed: true, signedIn: true },
    ],
  );
  await dom.waitFor(() => $(".chat-status.out-of-usage"));
  assert.equal(
    $(".chat-status.out-of-usage span").textContent,
    "You’re out of Codex usage.",
  );
  const upgrade = $(".chat-status.out-of-usage a");
  assert.equal(upgrade.textContent.trim(), "Upgrade");
  assert.equal(
    upgrade.getAttribute("href"),
    "https://chatgpt.com/codex/settings/usage",
  );
  assert.deepEqual(dom.errors, []);
});

test("a question already held by Claude offers a working live-screen fallback", async () => {
  const asking = {
    kind: "question",
    questions: [
      {
        question:
          "About 19 Terminal windows have finished but stay open. What should I do?",
        header: "Terminals",
        multiSelect: false,
        options: [
          {
            label: "Setting + close now (Recommended)",
            description: "Close finished windows from now on",
          },
          { label: "Leave them", description: "" },
        ],
      },
    ],
  };
  const session = claudeSession({ status: "waiting", asking });
  mac.pages[`claude:${CLAUDE}`].session = session;
  let opened = 0;
  await open(session, signedIn, peer, { onScreen: () => opened++ });
  await dom.waitFor(() => $(".as-prompt.elsewhere"));
  const card = $(".as-prompt.elsewhere");
  // Already showing on the Mac: said so, with the choices as words, never as buttons.
  assert.equal(
    card.querySelector("header strong").textContent,
    "Waiting for your answer in the Claude app on your Mac",
  );
  assert.equal(
    card.querySelector(".as-question p").textContent,
    asking.questions[0].question,
  );
  assert.equal(
    card.querySelector(".as-asked").textContent,
    "Setting + close now (Recommended) · Leave them",
  );
  await click([...card.querySelectorAll("button")].find((b) => b.textContent === "Open screen to answer"));
  assert.equal(opened, 1);
  assert.equal(mac.sent.length, 0, "opening the screen does not choose an answer");
  assert.equal(
    $(".as-hint").textContent,
    "Claude is waiting for your answer in the Claude app. What you send goes after it, in this same session.",
  );
  assert.deepEqual(dom.errors, []);
});

test("the Claude app's own consent card (letting Claude use apps) shows here too, as the app says it", async () => {
  const asking = {
    kind: "consent",
    title: "Allow Claude to use Calculator?",
    reason: "Add up the receipts.",
    options: ["Deny", "Allow for this session"],
  };
  const session = claudeSession({ status: "waiting", asking });
  mac.pages[`claude:${CLAUDE}`].session = session;
  await open(session);
  await dom.waitFor(() => $(".as-prompt.elsewhere"));
  const card = $(".as-prompt.elsewhere");
  assert.equal(
    card.querySelector("header strong").textContent,
    "Waiting for your answer in the Claude app on your Mac",
  );
  assert.deepEqual(
    [...card.querySelectorAll("p")].map((p) => p.textContent),
    [
      "Allow Claude to use Calculator?",
      "Add up the receipts.",
      "Deny · Allow for this session",
      "This request is already open in the Claude app. Answer it on your Mac.",
    ],
  );
  // Answered on the Mac: its choices as words, no buttons here.
  assert.equal(card.querySelector("button, li, [role=button]"), null);
  assert.deepEqual(dom.errors, []);
});

test("the Claude app's consent card shows as the app draws it, is answered here with its own buttons, and goes once answered", async () => {
  const asking = {
    kind: "consent",
    id: "consent:toolu_1",
    about: "apps",
    title: "Allow Claude to use Calculator?",
    reason: "Add up the receipts.",
    apps: [
      { name: "Calculator", appId: "/System/Applications/Calculator.app" },
    ],
    options: ["Deny", "Allow for this session"],
  };
  const session = claudeSession({ status: "waiting", asking });
  mac.pages[`claude:${CLAUDE}`].session = session;
  await open(session);
  await dom.waitFor(() => $(".as-consent"));
  const card = $(".as-consent");
  assert.equal(
    card.querySelector("strong").textContent,
    "Allow Claude to use Calculator?",
  );
  assert.equal(card.querySelector("p").textContent, "Add up the receipts.");
  assert.equal(
    card.querySelector("small").textContent,
    "Claude will work in these apps in the background while you keep using your Mac.",
  );
  assert.deepEqual(
    [...card.querySelectorAll("li")].map((li) => li.textContent),
    ["Calculator"],
  );
  const buttons = [...card.querySelectorAll(".as-consent-actions button")];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ["Deny", "Allow for this session"],
  );
  assert.ok(buttons[1].classList.contains("primary"));
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ status: "running" });
  await click(buttons[1]);
  await dom.waitFor(() => mac.sent.length === 1);
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/claude/${CLAUDE}/prompts/consent%3Atoolu_1`,
      body: { decision: "allow" },
    },
  ]);
  await dom.waitFor(() => !$(".as-consent"));
  assert.deepEqual(dom.errors, []);
});

test("pictures sent in a Claude session show in their message, above its text, as in the Claude app", async () => {
  const asked = [];
  for (const n of [0, 1]) {
    const route = `/api/sessions/claude/${CLAUDE}/images/u-pic/${n}`;
    routes[route] = (init) => (
      asked.push([route, new Headers(init?.headers).get("Authorization")]),
      {}
    );
  }
  mac.pages[`claude:${CLAUDE}`].items = [
    {
      id: "u-pic",
      role: "user",
      kind: "text",
      text: "What flower is this?",
      images: 2,
      at: Date.now() - 60000,
    },
    {
      id: "a-pic:1",
      role: "assistant",
      kind: "text",
      text: "Ice plants.",
      at: Date.now() - 50000,
    },
  ];
  await open(claudeSession());
  await dom.waitFor(() => $$(".as-user-images img").length === 2);
  const bubble = $(".as-user");
  assert.ok(
    [...bubble.children].indexOf(bubble.querySelector(".as-user-images")) <
      [...bubble.children].indexOf(
        bubble.querySelector("p")?.parentElement || bubble.lastElementChild,
      ),
  );
  assert.ok(
    $$(".as-user-images img").every((img) =>
      img.getAttribute("src").startsWith("blob:"),
    ),
  );
  assert.deepEqual(asked.map(([route]) => route).sort(), [
    `/api/sessions/claude/${CLAUDE}/images/u-pic/0`,
    `/api/sessions/claude/${CLAUDE}/images/u-pic/1`,
  ]);
  assert.ok(
    asked.every(([, auth]) => auth === `Bearer ${peer.token}`),
    "fetched with this device's key",
  );
  assert.equal($(".as-user .as-tag"), null, "pictures, not a count");
  // Tapped: full screen, the next one an arrow away, closed by Escape.
  await click($(".as-image-open"));
  await dom.waitFor(() => $(".as-viewer img"));
  assert.equal($(".as-viewer").getAttribute("aria-label"), "Image 1 of 2");
  assert.equal($(".as-viewer img").getAttribute("src"), $$(".as-user-images img")[0].getAttribute("src"));
  await click($("[aria-label='Next image']"));
  await dom.waitFor(() => $(".as-viewer").getAttribute("aria-label") === "Image 2 of 2");
  assert.equal($("[aria-label='Next image']"), null, "the last one");
  dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert.equal($(".as-viewer"), null);
  assert.deepEqual(dom.errors, []);
});

test("messages waiting on the Mac for their turn show after the page reloads, saying why one can't go yet", async () => {
  // A fresh page (nothing sent from it): what the Mac's outbox holds.
  mac.live = {
    ...idleLive(),
    status: "running",
    outbox: [
      { id: "m1", text: "Run the tests", images: 1, at: 1 },
      {
        id: "m2",
        text: "Then commit",
        images: 0,
        at: 2,
        error: "Claude Code is signed out on your Mac.",
      },
    ],
  };
  await open(claudeSession({ status: "running" }));
  // Claude's queue folds into a stack, as in the Claude app: a tap opens it.
  await dom.waitFor(() => $(".qm-head"));
  assert.match($(".qm-head").textContent, /2 queued/);
  await click($(".qm-head"));
  await dom.waitFor(() => $$(".qm-row").length === 2);
  const [first, second] = $$(".qm-row");
  assert.equal(first.querySelector(".qm-open").textContent, "Run the tests");
  assert.equal(first.querySelector(".qm-images").getAttribute("aria-label"), "1 image");
  assert.equal(second.querySelector(".qm-why").textContent, "Claude Code is signed out on your Mac.");
  // Handed over: it leaves the outbox (and shows from the transcript).
  mac.bump({ outbox: [mac.live.outbox[1]] });
  await dom.waitFor(() => $$(".qm-row").length === 1);
  assert.deepEqual(dom.errors, []);
});

test("a question asked in the Claude app while this chat is open shows as soon as the Mac tells, and goes once answered", async () => {
  const asking = {
    kind: "question",
    questions: [
      {
        question: "Which database?",
        header: "Database",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
      },
    ],
  };
  const page = mac.pages[`claude:${CLAUDE}`];
  page.session = claudeSession({ status: "idle" });
  await open(claudeSession({ status: "idle" }));
  await dom.waitFor(() => $("textarea"));
  assert.equal($(".as-prompt.elsewhere"), null);
  // Claude stops on a question in the app: Claude Code's status file changes
  // and the Mac wakes the open chat (its live view), which reads it again; no
  // refresh on a beat.
  page.session = claudeSession({ status: "waiting", asking });
  mac.bump();
  await dom.waitFor(() => $(".as-prompt.elsewhere"), 2000);
  assert.match(
    $(".as-hint").textContent,
    /^Claude is waiting for your answer in the Claude app\./,
  );
  page.session = claudeSession({ status: "running" });
  mac.bump();
  await dom.waitFor(() => !$(".as-prompt.elsewhere"), 2000);
  assert.deepEqual(dom.errors, []);
});

test("a Claude Code session nobody else holds takes replies from here once signed in", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $("textarea") && !$("textarea").disabled);
  assert.equal($(".as-hint"), null);
  assert.equal($("textarea").placeholder, "Reply to Claude");
  await typeInto($("textarea"), "Refactor the auth module");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/claude/${CLAUDE}/messages`,
      body: { text: "Refactor the auth module", images: [] },
    },
  ]);
  assert.deepEqual(dom.errors, []);
});

// Web links open in a new tab, as in both apps (Oct 6); anything else a link
// could be (a script, a path, an address inside Reach) stays text.
test("agent text is shown as text: no markup; only web links open, in a new tab", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    {
      id: "a1",
      role: "assistant",
      kind: "text",
      text: 'Try <img src=x onerror="alert(1)"> and **this** or [the docs](https://example.com) [bad](javascript:alert(3)) [file](src/App.tsx) [inside](/api/clients)\n# Big\n## Medium\n#### Small\n```\n<script>alert(2)</script>\n```',
    },
  ];
  await open(codexSession());
  await dom.waitFor(() => $(".as-assistant"));
  const message = $(".as-assistant");
  assert.equal(message.querySelector("img, script"), null);
  assert.match(message.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.equal(message.querySelector("strong").textContent, "this");
  const links = [...message.querySelectorAll("a")];
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, "the docs");
  assert.equal(links[0].getAttribute("href"), "https://example.com");
  assert.equal(links[0].getAttribute("target"), "_blank");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual([...message.querySelectorAll("u")].map((u) => u.textContent), ["bad", "file", "inside"]);
  assert.deepEqual([...message.querySelectorAll("h4")].map((h) => h.className), ["md-h1", "md-h2", "md-h3"]);
  assert.equal(
    message.querySelector("pre code").textContent,
    "<script>alert(2)</script>",
  );
});

test("a failed send keeps the message and says why", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).endsWith("/messages")
      ? new Response(
          JSON.stringify({ error: "Another Codex window has this chat open." }),
          { status: 409 },
        )
      : fetch(url, init);
  try {
    await open(codexSession());
    await dom.waitFor(() => $(".as-scroll") && !$(".as-note"));
    await typeInto($("textarea"), "please retry");
    await click(button("Send"));
    await dom.waitFor(() => $(".as-hint.bad"));
    assert.equal(
      $(".as-hint.bad").textContent,
      "Another Codex window has this chat open.",
    );
    assert.equal($("textarea").value, "please retry");
    assert.equal($$(".as-user.pending").length, 0);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("each app has its own chat space selected by its logo", async () => {
  await home([codexSession(), claudeSession()]);
  assert.equal($$(".chat-card").length, 1);
  assert.equal($(".chat-card strong").textContent, "Fix login");
  assert.equal($("textarea"), null);
  assert.equal($(".needs-you"), null);
  assert.equal(button("All apps"), undefined);
  await chooseApp("Claude Code");
  assert.equal($$(".chat-card").length, 1);
  assert.equal($(".chat-card strong").textContent, "Refactor auth");
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "claude");
  await chooseApp("Codex");
  assert.equal($$(".chat-card").length, 1);
  assert.equal($(".chat-card strong").textContent, "Fix login");
  assert.deepEqual(dom.errors, []);
});

test("the phone chat list groups working and idle chats under their project", async () => {
  await home([
    codexSession({ id: CODEX, cwd: "/work/app", title: "Fix login", status: "running" }),
    codexSession({ id: NEW, cwd: "/work/app", title: "Write tests", status: "idle", updatedAt: Date.now() - 1000 }),
    codexSession({ id: "other", cwd: "/work/other", title: "Other project", status: "idle", updatedAt: Date.now() - 2000 }),
  ]);
  assert.equal($(".chat-projects-title").textContent, "Projects");
  const app = $('[aria-label="app conversations"]');
  assert.deepEqual([...app.querySelectorAll(".chat-card strong")].map((el) => el.textContent), ["Fix login", "Write tests"]);
  assert.equal(app.querySelector(".chat-project-parent").textContent, "work");
  assert.ok(app.querySelector(".chat-card.running .chat-row-status"));
  assert.equal($$(".chat-project-group").length, 2);
  assert.ok(button("New chat in app"));
  assert.ok(button("New Codex chat"));
  assert.deepEqual(dom.errors, []);
});

test("the phone list's app menu and search icon keep app switching and search available", async () => {
  await home([codexSession(), claudeSession()]);
  await click(button("Choose an app, Codex selected"));
  // All (every agent's chats) comes first, then each app.
  assert.deepEqual($$("[role=menuitemradio]").map((b) => b.getAttribute("aria-label")), ["All", "Codex", "Claude Code"]);
  await click($('[role=menuitemradio][aria-label="Claude Code"]'));
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "claude");
  assert.equal($(".chat-card strong").textContent, "Refactor auth");
  await click(button("Search chats"));
  await typeInto($('.chat-library input[aria-label="Search chats"]'), "no match");
  assert.match($(".chat-list-empty").textContent, /No conversations found/);
  await click(button("Search chats"));
  assert.equal($(".chat-card strong").textContent, "Refactor auth");
  assert.deepEqual(dom.errors, []);
});

test("changing the new-chat app preserves the draft and remembers the app", async () => {
  await home([codexSession(), claudeSession()]);
  await click(button("New chat"));
  await typeInto($("textarea"), "Keep this thought");
  await chooseApp("Claude Code");
  assert.equal($("textarea").value, "Keep this thought");
  assert.equal(
    $("textarea").getAttribute("aria-label"),
    "New Claude Code chat",
  );
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "claude");
  assert.deepEqual(dom.errors, []);
});

test("real app logos appear on conversations and in the app chooser", async () => {
  await home([codexSession(), claudeSession()], [...signedIn, { agent: "openclaw", installed: true, signedIn: false, supported: true }]);
  await dom.waitFor(() => $(".chat-card img.agent-logo"));
  assert.equal($(".chat-card img.agent-logo").getAttribute("src"), LOGO);
  await click(button("New chat"));
  assert.equal($$("[role=dialog] .chat-app-rail img.agent-logo").length, 3);
  assert.ok($('[role=dialog] img[alt="OpenClaw"]'), "OpenClaw has its bundled logo");
  assert.deepEqual(dom.errors, []);
});

test("only discovered upcoming apps are visible and never start unsupported sessions", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, init) => {
    requests.push(String(url));
    return original(url, init);
  };
  try {
    await home([codexSession()], [
      ...signedIn,
      { agent: "gemini", name: "Gemini CLI", installed: true, signedIn: true, supported: false },
      { agent: "future-agent", name: "Future app", installed: true, signedIn: false, supported: false },
    ]);
    const names = $$(".chat-app-rail button").map((b) => b.getAttribute("aria-label"));
    for (const name of ["Gemini CLI", "Future app"])
      assert.ok(names.includes(name), `${name} was discovered`);
    for (const name of ["Cursor", "Antigravity", "OpenClaw"]) assert.ok(!names.includes(name), `${name} was not discovered`);
    await chooseApp("Gemini CLI");
    assert.match($("[role=status]").textContent, /Gemini CLI.*Coming soon/s);
    assert.equal($("textarea"), null);
    assert.equal($$(".chat-card").length, 0);
    await chooseApp("Future app");
    assert.match($("[role=status]").textContent, /Future app.*Coming soon/s);
    assert.equal($("textarea"), null);
    assert.equal(mac.sent.length, 0);
    assert.ok(!requests.some((url) => /agent=(gemini|future-agent)/.test(url)));
    assert.deepEqual(dom.errors, []);
  } finally {
    globalThis.fetch = original;
  }
});

test("exploring upcoming apps in a new conversation preserves the supported app's draft", async () => {
  await home([codexSession()], [...signedIn, ...["gemini", "cursor", "antigravity"].map((agent) => ({ agent, name: { gemini: "Gemini CLI", cursor: "Cursor", antigravity: "Antigravity" }[agent], installed: true, signedIn: false, supported: false }))]);
  await click(button("New chat"));
  await typeInto($("textarea"), "Keep this while I look at the other apps");
  for (const name of ["Gemini CLI", "Cursor", "Antigravity"]) {
    await chooseApp(name);
    assert.match($("[role=dialog] [role=status]").textContent, /Coming soon/);
    assert.equal($("[role=dialog] textarea"), null);
    assert.equal($("[role=dialog] [aria-label=Start]"), null);
  }
  await chooseApp("Codex");
  assert.equal($("textarea").value, "Keep this while I look at the other apps");
  assert.equal(mac.sent.length, 0);
  assert.deepEqual(dom.errors, []);
});

test("refreshing a new chat's model list discovers new models without resetting its draft or settings", async (t) => {
  const original = routes["/api/sessions/models"];
  const offers = { ...CODEX_OFFERS, models: [...CODEX_OFFERS.models] };
  let reads = 0;
  routes["/api/sessions/models"] = () => { reads++; return offers; };
  t.after(() => { routes["/api/sessions/models"] = original; });
  await home([codexSession()], signedIn, {}, { ...peer, url: "https://new-model-refresh.test" });
  await click(button("New chat"));
  await dom.waitFor(() => $(".chat-model").getAttribute("aria-label").includes("GPT-6 Astra"));
  await typeInto($("textarea"), "Keep these choices");
  await click($(".as-mode-pick"));
  await click(modeRow("Full access"));
  await click($(".chat-model"));
  await click($(".ms-dots [aria-label=High]"));
  await click($(".ms-strip-label"));
  await click(modelRow("GPT-6 Sol"));
  offers.models = [
    ...offers.models.map(m => ({ ...m, isDefault: false })),
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true },
  ];
  await click(button("Refresh model list"));
  await dom.waitFor(() => reads === 2 && modelRow("GPT-6.1 Sol") && !modelRow("GPT-6.1 Sol").disabled);
  assert.equal(checkedModel(), "GPT-6 Sol");
  assert.equal($("textarea").value, "Keep these choices");
  assert.equal($(".chat-folder").getAttribute("aria-label"), "Folder: /work/app");
  assert.equal($(".as-mode-pick").getAttribute("aria-label"), "Permissions: Full access");
  assert.match($(".chat-model").getAttribute("aria-label"), /GPT-6 Sol.*High/);
  assert.deepEqual(mac.sent, []);
  await click(modelRow("GPT-6.1 Sol"));
  await click($(".ms-done"));
  await click($(".chat-model"));
  await click(button("Start"));
  await dom.waitFor(() => mac.sent.some(m => m.route === "/api/sessions"));
  assert.deepEqual(mac.sent.find(m => m.route === "/api/sessions").body, {
    agent: "codex", cwd: "/work/app", text: "Keep these choices", images: [],
    model: "gpt-6.1-sol", effort: "high", mode: "full-access",
  });
  assert.deepEqual(dom.errors, []);
});

test("a failed new-chat model catalog can be retried without losing the draft", async (t) => {
  const original = routes["/api/sessions/models"];
  let fail = true;
  routes["/api/sessions/models"] = () => fail
    ? Response.json({ error: "Codex catalog disconnected" }, { status: 503 })
    : CODEX_OFFERS;
  t.after(() => { routes["/api/sessions/models"] = original; });
  await home([codexSession()], signedIn, {}, { ...peer, url: "https://new-model-retry.test" });
  await click(button("New chat"));
  await typeInto($("textarea"), "Keep this draft");
  await click($(".chat-model"));
  await dom.waitFor(() => $(".ms-sheet [role=alert]"));
  assert.match($(".ms-sheet [role=alert]").textContent, /catalog disconnected/);
  fail = false;
  await click(button("Try loading models again"));
  await dom.waitFor(() => $(".chat-model").getAttribute("aria-label").includes("GPT-6 Astra"));
  assert.equal($("textarea").value, "Keep this draft");
  assert.equal($(".as-mode-pick").getAttribute("aria-label"), "Permissions: Approve for me");
  assert.deepEqual(mac.sent, []);
  assert.deepEqual(dom.errors, []);
});

test("a new Codex chat starts in the Codex app's own mode, in the most recent folder", async () => {
  await home([codexSession(), claudeSession({ cwd: "/work/site" })]);
  assert.equal($("textarea"), null);
  await click(button("New chat"));
  const field = () => $("textarea[aria-label='New Codex chat']");
  assert.equal(dom.document.activeElement, field());
  assert.equal(field().placeholder, "What would you like to work on?");
  // Open, it names the folder it will start in (the most recent one).
  assert.match($(".chat-folder").textContent, /app/);
  assert.equal($(".chat-new-computer").textContent, "Mac");
  assert.ok(!$(".as-box .chat-folder"), "the folder has its own context row above the composer");
  await typeInto(field(), "Add tests for login");
  await dom.waitFor(() =>
    $(".as-mode-pick")?.getAttribute("aria-label") === "Permissions: Approve for me",
  );
  assert.equal($(".as-mode-pick").textContent, "", "permissions have an icon and an accessible name");
  assert.equal($(".chat-model").textContent, "", "a long model name does not crowd the toolbar");
  assert.match($(".chat-model").getAttribute("aria-label"), /Model and thinking:.*GPT-6 Astra.*Medium/);
  // Folder and mode open inline, like the model.
  await click($(".chat-folder"));
  assert.deepEqual(
    $$(".as-picker[aria-label=Folder] button").map((b) => b.textContent),
    ["app", "site", "Browse…"],
  );
  await click(
    $$(".as-picker[aria-label=Folder] button").find(
      (b) => b.textContent === "app",
    ),
  );
  await click($(".as-mode-pick"));
  // Codex's own menu as it reports it now, as in a chat.
  assert.deepEqual(
    modeNames(),
    [
      "Ask for approval",
      "Approve for me",
      "Full access",
      "Read only",
      "Network only",
      "Custom (config.toml)",
    ],
  );
  await click(modeRow("Approve for me"));
  await click(button("Start"));
  await dom.waitFor(() => $(".as-page"));
  assert.deepEqual(mac.sent[0], {
    route: "/api/sessions",
    body: {
      agent: "codex",
      cwd: "/work/app",
      text: "Add tests for login",
      images: [],
      model: "gpt-6-astra",
      effort: "medium",
      mode: "guardian-approvals",
    },
  });
  // It opens the new chat right away.
  await dom.waitFor(
    () => $(".as-title strong")?.textContent === "Add tests for login",
  );
  assert.deepEqual(dom.errors, []);
});

test("a new Claude Code chat uses Claude Code's own models and permission modes", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  // Claude Code's own list (from its handshake), with a bracketed id.
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes("/api/sessions/models?agent=claude")
      ? new Response(
          JSON.stringify({
            models: [
              {
                id: "default",
                name: "Default (recommended)",
                efforts: ["low", "high", "max"],
                defaultEffort: null,
                images: true,
                isDefault: true,
                autoMode: true,
              },
              {
                id: "claude-fable-5-1[1m]",
                name: "Fable 5.1",
                efforts: ["low", "high", "max"],
                defaultEffort: null,
                images: true,
                isDefault: false,
                autoMode: false,
              },
            ],
            modes: [
              { id: "manual", label: "Manual" },
              { id: "plan", label: "Plan" },
              { id: "acceptEdits", label: "Accept edits" },
              { id: "bypassPermissions", label: "Bypass Permissions" },
              { id: "auto", label: "Auto" },
            ],
            mode: null,
          }),
          { status: 200 },
        )
      : fetch(url, init);
  const claudePeer = { ...peer, url: "https://claude-models.test" };
  await mount(
    React.createElement(EverythingChat, {
      peer: claudePeer,
      feed: {
        sessions: [claudeSession({ live: undefined })],
        errors: {},
        health: signedIn,
        failure: "",
        reload: async () => {},
        recheck: () => {},
      },
    }),
  );
  await click(button("New chat"));
  globalThis.fetch = fetch;
  const field = () => $("textarea[aria-label='New Claude Code chat']");
  assert.equal(field().placeholder, "What would you like to work on?");
  await typeInto(field(), "Plan the API");
  await dom.waitFor(() =>
    $(".chat-model")?.getAttribute("aria-label").includes("Default (recommended)"),
  );
  assert.equal($(".chat-model").textContent, "");
  assert.equal($(".as-mode-pick").getAttribute("aria-label"), "Permissions: Default");
  await click($(".as-mode-pick"));
  // Claude Code's own modes, in the Claude app's order and words (as in a
  // chat), after the settings' default.
  assert.deepEqual(modeNames(), ["Default", "Manual", "Accept edits", "Plan", "Auto", "Bypass permissions"]);
  await click(modeRow("Plan"));
  assert.equal($(".as-mode-pick").getAttribute("aria-label"), "Permissions: Plan");
  await click($(".chat-model"));
  await click(await dom.waitFor(() => modelRow("Fable 5.1")));
  await click($(".chat-model"));
  await click(await dom.waitFor(() => $(".ms-row")));
  await click(
    $$(".ms-card[aria-label=Effort] button").find((b) =>
      b.textContent.startsWith("Max"),
    ),
  );
  assert.match($(".chat-model").getAttribute("aria-label"), /Fable 5.1.*Max/);
  assert.equal($(".chat-model").getAttribute("data-custom"), "true");
  // A model that doesn't take Auto mode isn't offered it.
  await click($(".as-mode-pick"));
  assert.ok(!modeNames().includes("Auto"));
  await click(modeRow("Plan"));
  await click(button("Start"));
  await dom.waitFor(() => $(".as-page.claude"));
  assert.deepEqual(mac.sent[0].body, {
    agent: "claude",
    cwd: "/work/app",
    text: "Plan the API",
    images: [],
    model: "claude-fable-5-1[1m]",
    effort: "max",
    mode: "plan",
  });
  assert.deepEqual(dom.errors, []);
});

test("opening a session from Home lands in it, on its agent's side", async () => {
  let opened = 0;
  await mount(
    React.createElement(EverythingChat, {
      peer,
      feed: {
        sessions: [codexSession(), claudeSession()],
        errors: {},
        health: signedIn,
        failure: "",
        reload: async () => {},
        recheck: () => {},
      },
      target: { agent: "claude", id: CLAUDE },
      onTargetOpened: () => opened++,
    }),
  );
  await dom.waitFor(() => $(".as-page.claude"));
  assert.equal($(".as-title strong").textContent, "Refactor auth");
  assert.equal(opened, 1);
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "claude");
});

test("each agent shows what it needs signed in, one row each with its logo, and nothing when all is signed in", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  // The Claude app is signed in, its CLI isn't: both said, only the CLI offered.
  let view = await home(
    [],
    [
      {
        agent: "claude",
        installed: true,
        signedIn: false,
        app: { installed: true, signedIn: true },
      },
    ],
  );
  assert.deepEqual(accessRows(), [
    ["Claude Code CLI", "Not signed in"],
    ["Claude app", "Signed in"],
  ]);
  assert.ok(
    $(".access-row .claude-spark"),
    "the CLI wears Claude Code's spark",
  );
  await dom.waitFor(() => $(".access-row:nth-child(2) img.agent-logo"));
  assert.equal(
    $(".access-row:nth-child(2) img.agent-logo").getAttribute("alt"),
    "Claude app",
  );
  assert.equal($$(".access-row .access-action").length, 1);
  assert.equal(
    $(".access-note").textContent,
    "Reach replies through the CLI, so only the CLI needs signing in.",
  );
  await view.unmount();
  views.length = 0;
  // Codex: its app and CLI share one sign-in, so one row.
  dom.window.localStorage.setItem("reach.chatAgent", "codex");
  view = await home([], [{ agent: "codex", installed: true, signedIn: false }]);
  assert.deepEqual(accessRows(), [["Codex", "Not signed in"]]);
  assert.equal(
    $(".access-note").textContent,
    "The Codex app and CLI share this sign-in.",
  );
  await view.unmount();
  views.length = 0;
  // All signed in: nothing to say.
  await home([], signedIn);
  assert.equal($(".access"), null);
  assert.deepEqual(dom.errors, []);
});

test("the focused review sheet includes macOS requests", async () => {
  await home([codexSession()], signedIn, {
    macPrompts: [
      {
        id: "1",
        kind: "security",
        title: "“Tool” is an app downloaded from the internet.",
        detail: "",
        app: "Tool",
      },
    ],
  });
  // One card in the strip above the chats: said, to be answered at the Mac.
  const card = $(".chat-home .need-card");
  assert.equal(
    card.querySelector("strong").textContent,
    "“Tool” is an app downloaded from the internet.",
  );
  assert.equal(
    card.querySelector(".need-note").textContent,
    "Answer on your Mac",
  );
  assert.equal($(".chat-home .need-dots"), null, "no dots for one");
  await click(card);
  assert.equal(
    $(".chat-home .need-more .mac-dialog-message").textContent,
    "“Tool” is an app downloaded from the internet.",
  );
  assert.equal($(".chat-home .need-more .mac-dialog button"), null);
  assert.deepEqual(dom.errors, []);
});

test("a Mac prompt's card opens its System Settings page on the Mac with one tap, and says what to switch on", async () => {
  routes["/api/sessions/mac-prompts/5/setting"] = (init) => (
    mac.sent.push({ route: "/api/sessions/mac-prompts/5/setting", body: null }),
    { opened: "Accessibility", app: "claude" }
  );
  await home([codexSession()], signedIn, {
    macPrompts: [
      {
        id: "5",
        kind: "privacy",
        title:
          "“claude” would like to control this computer using accessibility features.",
        detail: "",
        app: "claude",
        lines: [
          "“claude” would like to control this computer using accessibility features.",
        ],
        setting: {
          name: "Accessibility",
          url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        },
      },
    ],
  });
  const card = $(".chat-home .need-card");
  const open = [...card.querySelectorAll(".need-actions button")];
  assert.deepEqual(
    open.map((b) => b.textContent),
    ["Open setting on Mac"],
  );
  await click(open[0]);
  assert.deepEqual(mac.sent, [
    { route: "/api/sessions/mac-prompts/5/setting", body: null },
  ]);
  await dom.waitFor(() => card.querySelector("small.said"));
  assert.equal(
    card.querySelector("small.said").textContent,
    "Opened on your Mac: switch on “claude” in Accessibility.",
  );
  assert.deepEqual(dom.errors, []);
});

test("a Mac prompt's card can open the live screen on the dialog itself, a password one too", async () => {
  const shown = [];
  const accessibility = {
    id: "6",
    kind: "privacy",
    title:
      "“claude” would like to control this computer using accessibility features.",
    detail: "",
    app: "claude",
    lines: [
      "“claude” would like to control this computer using accessibility features.",
    ],
    setting: {
      name: "Accessibility",
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    },
    bounds: { x: 600, y: 300, width: 260, height: 314 },
  };
  const password = {
    id: "9",
    kind: "password",
    title: "Your Mac is asking for your password",
    detail: "",
    app: null,
    bounds: { x: 1, y: 1, width: 300, height: 200 },
  };
  await mount(
    React.createElement(EverythingChat, {
      peer,
      feed: {
        sessions: [codexSession()],
        errors: {},
        health: signedIn,
        failure: "",
        reload: async () => {},
        recheck: () => {},
        macPrompts: [accessibility, password],
      },
      showOnScreen: (p) => shown.push(p.id),
    }),
  );
  await click($(".chat-review-link, .chat-needs-row"));
  const [first, second] = $$(".chat-home .need-card");
  assert.deepEqual(
    [...first.querySelectorAll(".need-actions button")].map((b) => [
      b.textContent,
      b.className,
    ]),
    [
      ["Open setting on Mac", ""],
    ],
  );
  await click(
    [...first.querySelectorAll("button")].find(
      (b) => b.textContent === "Open live screen",
    ),
  );
  assert.deepEqual(shown, ["6"]);
  await click(second.querySelector(".need-screen button"));
  assert.deepEqual(shown, ["6", "9"]);
  // A password: entered right here, sent only to the Mac's password dialog; the field empties at once.
  routes["/api/sessions/mac-prompts/9/password"] = (init) => (
    mac.sent.push({ route: "password", body: JSON.parse(init.body) }),
    { done: true }
  );
  const field = second.querySelector(".mac-password input[type=password]");
  assert.ok(field, "a password field");
  const setValue = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set;
  setValue.call(field, "correct horse");
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle(10);
  second
    .querySelector(".mac-password")
    .dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  await dom.waitFor(() => mac.sent.some((m) => m.route === "password"));
  assert.deepEqual(mac.sent.find((m) => m.route === "password").body, {
    password: "correct horse",
  });
  assert.equal(second.querySelector(".mac-password input").value, "");
  assert.deepEqual(dom.errors, []);
});

test("a Mac dialog is answered right here with its own buttons, in its order, its default marked", async () => {
  routes["/api/sessions/mac-prompts/51/press"] = (init) => (
    mac.sent.push({ route: "press", body: JSON.parse(init.body) }),
    { pressed: "Allow" }
  );
  await home([codexSession()], signedIn, {
    macPrompts: [
      {
        id: "51",
        kind: "privacy",
        title: "“Terminal” wants access to control “Finder”.",
        detail: "",
        app: "Terminal",
        lines: [
          "“Terminal” wants access to control “Finder”. Allowing control will provide access to documents and data in “Finder”.",
        ],
        buttons: ["Don’t Allow", "Allow"],
        default: "Allow",
      },
    ],
  });
  const card = $(".chat-home .need-card");
  assert.deepEqual(
    [...card.querySelectorAll(".need-actions button")].map((b) => [
      b.textContent,
      b.className,
    ]),
    [
      ["Don’t Allow", ""],
      ["Allow", "primary"],
    ],
  );
  await click(
    [...card.querySelectorAll(".need-actions button")].find(
      (b) => b.textContent === "Allow",
    ),
  );
  assert.deepEqual(mac.sent, [{ route: "press", body: { button: "Allow" } }]);
  assert.deepEqual(dom.errors, []);
});

test("reviews stay with their app, retain device dialogs, and send each app's exact decision", async () => {
  const fixChart = claudeSession({
    title: "Fix the chart",
    status: "waiting",
    consent: {
      id: "consent:toolu_1",
      kind: "apps",
      title: "Allow Claude to use Calculator?",
      options: ["Deny", "Allow for this session"],
    },
  });
  const runTests = codexSession({
    title: "Run the suite",
    status: "waiting",
    prompts: [
      {
        id: "7",
        kind: "command",
        title: "Run this command?",
        command: "npm test",
        decisions: ["accept", "decline"],
      },
    ],
  });
  const asking = claudeSession({
    id: NEW,
    title: "Plan the API",
    status: "waiting",
  });
  await home([asking, fixChart, runTests], signedIn, {
    macPrompts: [
      {
        id: "1",
        kind: "privacy",
        title: "“Claude” wants access to control “Finder”.",
        detail: "",
        app: "Claude",
        lines: [],
      },
    ],
  });
  const codexCards = $$(".chat-home .need-card");
  assert.deepEqual(
    codexCards.map((c) => c.querySelector("strong").textContent),
    [
      "Run this command?",
      "“Claude” wants access to control “Finder”.",
    ],
  );
  assert.equal($$(".chat-home .need-dots button").length, 2);
  assert.equal($(".chat-home .need-dots").getAttribute("aria-label"), "1 of 2");
  // Each in its agent's own words, answered where it is.
  const buttons = (card) =>
    [...card.querySelectorAll(".need-actions button")].map(
      (b) => b.textContent,
    );
  assert.deepEqual(buttons(codexCards[0]), ["No", "Yes"]);
  assert.match(
    codexCards[0].querySelector("small").textContent,
    /Run the suite · npm test/,
  );
  await click(
    [...codexCards[0].querySelectorAll("button")].find(
      (b) => b.textContent === "No",
    ),
  );
  await click(button("Close needs you"));
  await chooseApp("Claude Code");
  await click($(".chat-review-link, .chat-needs-row"));
  const cards = $$(".chat-home .need-card");
  assert.deepEqual(
    cards.map((c) => c.querySelector("strong").textContent),
    ["Allow Claude to use Calculator?", "Plan the API", "“Claude” wants access to control “Finder”."],
  );
  assert.equal($$(".chat-home .need-dots button").length, 3);
  assert.deepEqual(buttons(cards[0]), ["Deny", "Allow for this session"]);
  assert.deepEqual(buttons(cards[1]), ["Open chat"]);
  await click(
    [...cards[0].querySelectorAll("button")].find(
      (b) => b.textContent === "Allow for this session",
    ),
  );
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/codex/${CODEX}/prompts/7`,
      body: { decision: "decline" },
    },
    {
      route: `/api/sessions/claude/${CLAUDE}/prompts/consent%3Atoolu_1`,
      body: { decision: "allow" },
    },
  ]);
  // A question opens its chat to be answered there.
  await click(
    [...cards[1].querySelectorAll("button")].find(
      (b) => b.textContent === "Open chat",
    ),
  );
  await dom.waitFor(() => $(".as-page") || $(".agent-session"));
  assert.deepEqual(dom.errors, []);
});

test("Claude Code signs in from Chat: the page opens here, the code goes to the Mac", async () => {
  let rechecked = 0;
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  await home([], [{ agent: "claude", installed: true, signedIn: false }], {
    recheck: () => rechecked++,
  });
  assert.deepEqual(accessRows(), [["Claude Code CLI", "Not signed in"]]);
  // No composer while signed out: signing in comes first.
  assert.equal($("textarea[aria-label='New Claude Code chat']"), null);
  await click(button("Sign in"));
  await dom.waitFor(() => $(".sign-in-open"));
  const link = $(".sign-in-open");
  assert.equal(link.getAttribute("href"), SIGN_IN_URL);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(button("Continue").disabled, true);
  await typeInto($("input[aria-label='Sign-in code']"), "C-123#abc");
  await click(button("Continue"));
  await dom.waitFor(() => $(".sign-in")?.textContent.includes("Signing in…"));
  // The Mac's login finishes: the screen follows it and refreshes the status.
  mac.signIn = { ...mac.signIn, state: "done" };
  await dom.waitFor(
    () =>
      $(".sign-in")?.textContent.includes(
        "Claude Code is signed in on your Mac.",
      ),
    4000,
  );
  // The status refresh runs just after that paints.
  await dom.waitFor(() => rechecked === 1);
  assert.deepEqual(mac.sent, [
    { route: "POST /api/sessions/sign-in", body: { agent: "claude" } },
    {
      route: "POST /api/sessions/sign-in/code",
      body: { agent: "claude", code: "C-123#abc" },
    },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("Codex signs in with a one-time code and finishes by itself", async () => {
  let rechecked = 0;
  await home([], [{ agent: "codex", installed: true, signedIn: false }], {
    recheck: () => rechecked++,
  });
  await click(button("Sign in"));
  await dom.waitFor(() => $(".sign-in-device"));
  assert.equal($(".sign-in-device").textContent, "ABCD-1234");
  assert.equal(
    $(".sign-in-open").getAttribute("href"),
    "https://auth.example/codex/device",
  );
  assert.equal($("input[aria-label='Sign-in code']"), null);
  assert.match($(".sign-in").textContent, /Waiting for you to finish…/);
  mac.signIn = { ...mac.signIn, state: "done" };
  await dom.waitFor(() => rechecked === 1, 4000);
  assert.deepEqual(dom.errors, []);
});

test("a session offers sign-in only when signing in is what's missing", async () => {
  const signedOut = [{ agent: "claude", installed: true, signedIn: false }];
  // Not running anywhere: signing in Claude Code is the way to reply.
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }), signedOut);
  await dom.waitFor(() => $(".access"));
  assert.deepEqual(accessRows(), [["Claude Code CLI", "Not signed in"]]);
  assert.ok(button("Sign in"));
  for (const view of views.splice(0)) await view.unmount();
  // Open in the Claude app: Reach takes over through the CLI, so signing in is still what's missing.
  mac.pages[`claude:${CLAUDE}`].session = claudeSession();
  await open(claudeSession(), signedOut);
  await dom.waitFor(() => $(".access"));
  assert.ok(button("Sign in"));
  for (const view of views.splice(0)) await view.unmount();
  // Running in a terminal: that's what holds it, not the sign-in.
  const inTerminal = claudeSession({
    live: { where: "terminal", pid: 7, tty: "/dev/ttys003" },
  });
  mac.pages[`claude:${CLAUDE}`].session = inTerminal;
  await open(inTerminal, signedOut);
  await dom.waitFor(() => $(".as-hint"));
  assert.match($(".as-hint").textContent, /terminal/);
  assert.equal($(".access"), null);
  assert.equal(button("Sign in"), undefined);
});

test("only swiping the header switches sessions; messages and code keep their scroll", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    {
      id: "a1",
      role: "assistant",
      kind: "text",
      text: "Here:\n```\nnpm run build -- --verbose --watch --profile\n```",
    },
  ];
  const picked = [];
  const next = codexSession({ id: NEW, title: "Next one" });
  await mount(
    React.createElement(AgentSessionView, {
      peer,
      session: codexSession(),
      siblings: [codexSession(), next],
      health: signedIn,
      logos: { codex: LOGO },
      onSelect: (s) => picked.push(s.id),
      onBack() {},
    }),
  );
  await dom.waitFor(() => $(".as-assistant pre"));
  const swipe = (target, dx) => {
    const touch = (type, x) => {
      const event = new dom.window.Event(type, { bubbles: true });
      const point = [{ clientX: x, clientY: 300 }];
      Object.defineProperty(
        event,
        type === "touchend" ? "changedTouches" : "touches",
        { value: point },
      );
      if (type === "touchend")
        Object.defineProperty(event, "touches", { value: [] });
      else Object.defineProperty(event, "changedTouches", { value: point });
      target.dispatchEvent(event);
    };
    touch("touchstart", 300);
    touch("touchend", 300 + dx);
  };
  swipe($(".as-assistant pre code"), -120);
  await settle();
  assert.deepEqual(picked, []);
  swipe($(".as-assistant p"), -120);
  await settle();
  assert.deepEqual(picked, []);
  swipe($(".as-bar"), -120);
  await settle();
  assert.deepEqual(picked, [NEW]);
  // The first session has nothing before it.
  swipe($(".as-assistant p"), 120);
  await settle();
  assert.deepEqual(picked, [NEW]);
});

test("the upcoming app chooser honors the connected computer's app names", async () => {
  await home(
    [codexSession()],
    [
      ...signedIn,
      {
        agent: "gemini",
        name: "Gemini",
        supported: false,
        installed: true,
        signedIn: false,
      },
    ],
  );
  assert.equal(button("All apps"), undefined);
  await chooseApp("Gemini");
  assert.equal($("[role=status] strong").textContent, "Gemini");
  assert.match($("[role=status]").textContent, /Coming soon/);
  assert.equal($("textarea"), null);
  assert.deepEqual(dom.errors, []);
});

test("the permission mode changes from the session, in each agent's own terms, in a small menu as the apps open it", async () => {
  // The mode's choices opened as a scrolling row of chips; both apps open a
  // small menu over the button, the one in force checked.
  const names = () => $$(".as-mode-menu button .as-mode-menu-text > span").map((s) => s.textContent);
  const pick = (name) => $$(".as-mode-menu button").find((b) => b.querySelector(".as-mode-menu-text > span").textContent === name);
  await open(codexSession());
  await dom.waitFor(() => $(".as-mode"));
  assert.equal($(".as-mode").textContent, "Approve for me");
  await click($(".as-mode"));
  assert.equal($$(".as-picker[aria-label=Permissions]").length, 0, "no row of chips");
  // The Codex app's own title and lines under its choices.
  // On the chat's page, not inside the composer, which scrolls its own
  // contents and clipped the menu out of sight.
  assert.equal($(".as-mode-menu").closest(".as-composer"), null);
  assert.ok($(".as-mode-menu").parentElement.classList.contains("as-page"));
  assert.equal($(".as-mode-menu-title").textContent, "How should ChatGPT actions be approved?");
  // What Codex offers now, a profile Reach has no name for included.
  assert.deepEqual(names(), ["Ask for approval", "Approve for me", "Full access", "Read only", "Network only", "Custom (config.toml)"]);
  assert.equal(pick("Full access").querySelector("small").textContent, "Unrestricted access to the internet and any file on your computer");
  assert.equal(pick("Approve for me").getAttribute("aria-checked"), "true");
  // A tap outside closes it, nothing changed.
  await click($(".as-mode-scrim"));
  assert.equal($$(".as-mode-menu").length, 0);
  await click($(".as-mode"));
  await click(pick("Full access"));
  assert.equal($$(".as-mode-menu").length, 0);
  assert.equal($(".as-mode").textContent, "Full access");
  await typeInto($("textarea"), "ship it");
  await click(button("Send"));
  for (const view of views.splice(0)) await view.unmount();
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-mode"));
  await click($(".as-mode"));
  await dom.waitFor(() => $$(".as-mode-menu button").length === 5);
  // The Claude app's names, in its order; one Reach has no name for at the end.
  assert.deepEqual(names(), ["Manual", "Accept edits", "Plan", "Auto", "delegate"]);
  assert.equal($$(".as-mode-menu-title").length, 0);
  await click(pick("Plan"));
  await typeInto($("textarea"), "think first");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/codex/${CODEX}/messages`,
      body: { text: "ship it", images: [], mode: "full-access" },
    },
    {
      route: `/api/sessions/claude/${CLAUDE}/messages`,
      body: { text: "think first", images: [], mode: "plan" },
    },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("typing / in a Claude Code session offers its commands", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $("textarea"));
  await typeInto($("textarea"), "/co");
  await dom.waitFor(() => $(".as-commands"));
  assert.deepEqual(
    $$(".as-commands b").map((b) => b.textContent),
    ["/compact", "/context"],
  );
  await click($$(".as-commands button")[0]);
  assert.equal($("textarea").value, "/compact ");
  assert.equal($(".as-commands"), null);
  assert.deepEqual(dom.errors, []);
});

test("a Claude chat wears the Claude app's floating buttons; New chat and More work", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  const calls = [];
  await mount(
    React.createElement(AgentSessionView, {
      peer,
      session: claudeSession({ live: undefined }),
      siblings: [],
      health: signedIn,
      logos: { codex: LOGO, claude: LOGO },
      onSelect() {},
      onBack: () => calls.push("back"),
      onNew: () => calls.push("new"),
    }),
  );
  await dom.waitFor(() => $("textarea"));
  // The list of chats on the left; where it runs, a new chat and more on the right.
  assert.deepEqual(
    $$(".as-bar button").map((b) => b.getAttribute("aria-label")),
    ["Back to all sessions", null, "New chat", "More"],
  );
  assert.ok($(".as-bar .as-bar-pill [aria-label='New chat']"));
  // No logos up there, not even on More (a still ⋯, no flipping coin).
  assert.equal($$(".as-bar .agent-logo").length, 0);
  assert.equal($(".as-bar .agent-coin"), null);
  // The title isn't on screen, as in the app; More shows it with the details.
  assert.equal($(".as-details"), null);
  await click(button("More"));
  assert.equal($(".as-details-title").textContent, "Refactor auth");
  await click(button("New chat"));
  await click(button("Back to all sessions"));
  assert.deepEqual(calls, ["new", "back"]);
  assert.deepEqual(dom.errors, []);
});

test("the newest reply gets copy and share, and Claude's note; not while it works", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  mac.pages[`claude:${CLAUDE}`].items = [
    { id: "u1", role: "user", kind: "text", text: "Hey", turnId: "t1" },
    {
      id: "a1",
      role: "assistant",
      kind: "text",
      text: "Hey! What's **on** your mind?",
      turnId: "t1",
    },
  ];
  const copied = [];
  const shared = [];
  const nav = dom.window.navigator;
  Object.defineProperty(nav, "clipboard", {
    configurable: true,
    value: { writeText: async (t) => copied.push(t) },
  });
  Object.defineProperty(nav, "share", {
    configurable: true,
    value: async (data) => shared.push(data),
  });
  try {
    await open(claudeSession({ live: undefined }));
    await dom.waitFor(() => $(".as-reply-actions"));
    assert.equal(
      $(".as-disclaimer").textContent,
      "Claude is AI and can make mistakes.",
    );
    await click(button("Copy"));
    assert.deepEqual(
      copied,
      ["Hey! What's **on** your mind?"],
      "the reply as written",
    );
    assert.ok(button("Copied"));
    await click(button("Share"));
    assert.deepEqual(shared, [{ text: "Hey! What's **on** your mind?" }]);
  } finally {
    delete nav.share;
  }
  // No Share where the phone can't share; Codex has no note.
  mac.pages[`codex:${CODEX}`].items = [
    { id: "a2", role: "assistant", kind: "text", text: "Done.", turnId: "t1" },
  ];
  for (const v of views.splice(0)) await v.unmount();
  await open(codexSession());
  await dom.waitFor(() => $(".as-reply-actions"));
  assert.equal(button("Share"), undefined);
  assert.equal($(".as-disclaimer"), null);
  // While it works, the actions wait.
  for (const v of views.splice(0)) await v.unmount();
  mac.live = {
    ...idleLive(),
    version: 3,
    status: "running",
    activity: "Thinking",
  };
  await open(codexSession());
  await dom.waitFor(() => button("Stop"));
  assert.equal($(".as-reply-actions"), null);
  assert.deepEqual(dom.errors, []);
});

// Every message can be copied, yours and the agent's, not just the newest
// reply: tap one on a phone and its copy button shows beneath it.
test("any message, yours or the agent's, can be copied", async () => {
  for (const v of views.splice(0)) await v.unmount();
  mac.live = idleLive();
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  mac.pages[`claude:${CLAUDE}`].items = [
    { id: "u1", role: "user", kind: "text", text: "Rename the **button**", turnId: "t1" },
    { id: "a1", role: "assistant", kind: "text", text: "Renamed it to `Save`.", turnId: "t1" },
    { id: "u2", role: "user", kind: "text", text: "Thanks", turnId: "t2" },
    { id: "a2", role: "assistant", kind: "text", text: "Anytime.", turnId: "t2" },
  ];
  const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (t) => copied.push(t) },
  });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-reply-actions"));
  const msgs = $$(".as-msg");
  assert.deepEqual(msgs.map((m) => m.className.split(" ")[1]), ["user", "assistant", "user", "assistant"]);
  assert.equal($$(".as-msg.shown").length, 0, "hidden until tapped");
  // The newest reply keeps its own row; no second copy button on it.
  assert.equal(msgs[3].querySelector(".as-msg-actions"), null);
  await click(msgs[0].querySelector(".as-user"));
  assert.ok(msgs[0].classList.contains("shown"));
  await click(msgs[0].querySelector('[aria-label="Copy message"]'));
  await click(msgs[1].querySelector(".as-assistant"));
  await click(msgs[1].querySelector('[aria-label="Copy message"]'));
  assert.deepEqual(copied, ["Rename the **button**", "Renamed it to `Save`."], "as written");
  assert.deepEqual(dom.errors, []);
});

test("Claude's composer has one round button: Stop while it works, Send once you type", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  mac.live = {
    ...idleLive(),
    version: 3,
    status: "running",
    activity: "Thinking",
  };
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => button("Stop"));
  assert.equal(button("Send"), undefined);
  assert.equal($(".as-enter"), null, "no second send button in the field");
  await typeInto($("textarea"), "also add tests");
  assert.equal(button("Stop"), undefined);
  assert.ok(button("Send").classList.contains("ready"));
  assert.deepEqual(dom.errors, []);
});

// A Windows (or Linux) computer: what the agent screens say about where things
// happen names "your computer"; a Mac keeps "your Mac" (the tests above).
const pc = { ...peer, id: "pc", name: "Desk", platform: "win32" };
// Every word on the page and every spoken label that says "Mac".
const saidMac = () =>
  [
    dom.document.body.textContent,
    ...$$("[aria-label]").map((el) => el.getAttribute("aria-label")),
  ].filter((t) => /\bMac\b/.test(t));

test("on a Windows computer, a Claude Code session says Windows PC, never Mac", async () => {
  // Waiting for an answer in a terminal there.
  const inTerminal = claudeSession({
    status: "waiting",
    live: { where: "terminal", pid: 7, tty: null },
    asking: { kind: "permission", text: "Run the tests?", command: false },
  });
  mac.pages[`claude:${CLAUDE}`].session = inTerminal;
  await open(inTerminal, signedIn, pc);
  await dom.waitFor(() => $(".as-prompt.elsewhere"));
  assert.equal(
    $(".as-prompt.elsewhere header strong").textContent,
    "Waiting for your answer in the terminal on your Windows PC",
  );
  assert.equal(
    $(".as-hint").textContent,
    "Running in a terminal on your Windows PC. Reply there or from the Terminal tab.",
  );
  assert.deepEqual(saidMac(), []);
  for (const view of views.splice(0)) await view.unmount();
  // Open in another Claude Code process.
  const background = claudeSession({
    live: { where: "background", pid: 8, tty: null },
  });
  mac.pages[`claude:${CLAUDE}`].session = background;
  await open(background, signedIn, pc);
  await dom.waitFor(() => $(".as-hint"));
  assert.equal(
    $(".as-hint").textContent,
    "Open in another Claude Code process on your Windows PC.",
  );
  assert.deepEqual(saidMac(), []);
  for (const view of views.splice(0)) await view.unmount();
  // The Claude app's consent card.
  const consent = claudeSession({
    status: "waiting",
    asking: {
      kind: "consent",
      id: "consent:toolu_1",
      about: "apps",
      title: "Allow Claude to use Calculator?",
      apps: [{ name: "Calculator" }],
      options: ["Deny", "Allow for this session"],
    },
  });
  mac.pages[`claude:${CLAUDE}`].session = consent;
  await open(consent, signedIn, pc);
  await dom.waitFor(() => $(".as-consent"));
  assert.equal(
    $(".as-consent small").textContent,
    "Claude will work in these apps in the background while you keep using your Windows PC.",
  );
  assert.deepEqual(saidMac(), []);
  for (const view of views.splice(0)) await view.unmount();
  // A dialog Claude Code can't show here.
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  mac.live = {
    ...idleLive(),
    version: 4,
    status: "waiting",
    prompts: [
      {
        id: "8",
        kind: "dialog",
        title: "Claude Code needs your answer",
        decisions: ["cancel"],
      },
    ],
  };
  await open(claudeSession({ live: undefined }), signedIn, pc);
  await dom.waitFor(() => $(".as-prompt.dialog"));
  assert.deepEqual(
    $$(".as-prompt.dialog .as-prompt-actions button").map((b) => b.textContent),
    ["Cancel request"],
  );
  assert.deepEqual(saidMac(), []);
  assert.deepEqual(dom.errors, []);
});

test("on a Windows computer, a Codex session says Windows PC: signed out, sent to the app, opened in the app", async () => {
  await open(
    codexSession(),
    [{ agent: "codex", installed: true, signedIn: false }],
    pc,
  );
  await dom.waitFor(() => $(".access"));
  assert.equal(
    $(".as-hint").textContent,
    "Codex is signed out on your Windows PC.",
  );
  assert.equal(
    $(".access").getAttribute("aria-label"),
    "Sign-ins on your Windows PC",
  );
  assert.deepEqual(saidMac(), []);
  for (const view of views.splice(0)) await view.unmount();
  // Held by the Codex app: what's sent goes to the app.
  const held = codexSession({ held: "codex-app" });
  mac.pages[`codex:${CODEX}`].session = held;
  const route = `/api/sessions/codex/${CODEX}/messages`;
  const saved = routes[route];
  routes[route] = (init) => (saved(init), { queued: true, delivered: true });
  try {
    await open(held, signedIn, pc);
    await dom.waitFor(() => $("textarea"));
    await typeInto($("textarea"), "hi");
    await click(button("Send"));
    await dom.waitFor(() => mac.sent.some((s) => s.route === route));
    await settle();
    assert.equal($(".as-hint"), null, "delivery does not add transport commentary to the chat");
  } finally {
    routes[route] = saved;
  }
  // The title's details: no "Open in the app" (the user found it useless).
  await click($(".as-title"));
  assert.ok(await dom.waitFor(() => $(".as-details")));
  assert.equal($(".as-details-open"), null);
  assert.deepEqual(saidMac(), []);
  assert.deepEqual(dom.errors, []);
});

test("new-chat availability uses the connected computer's platform", async () => {
  await home(
    [],
    [{ agent: "codex", installed: false, signedIn: false }],
    {},
    { ...peer, name: "PC", platform: "win32" },
  );
  assert.match($(".chat-setup").textContent, /Windows PC/);
  assert.doesNotMatch($(".chat-setup").textContent, /Mac/);
  assert.equal($("textarea"), null);
  assert.deepEqual(dom.errors, []);
});

test("missing app logos use accessible line icons in the library", async () => {
  mac.logos = {};
  await home(
    [codexSession(), claudeSession()],
    signedIn,
    {},
    { ...peer, id: "no-art" },
  );
  assert.ok($(".chat-card .agent-logo.glyph svg"));
  assert.equal($(".chat-card .agent-logo.glyph").textContent, "");
  assert.deepEqual(dom.errors, []);
});

test("a Claude conversation remains identifiable without its app artwork", async () => {
  mac.logos = {};
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  await home([claudeSession()], signedIn, {}, { ...peer, id: "no-claude-art" });
  assert.match($(".chat-card").getAttribute("aria-label"), /Claude Code/);
  assert.ok($(".chat-card .agent-logo.glyph svg"));
  assert.deepEqual(dom.errors, []);
});

test("Claude's new-chat button is the app's filled bubble", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await mount(
    React.createElement(AgentSessionView, {
      peer,
      session: claudeSession({ live: undefined }),
      siblings: [],
      health: signedIn,
      logos: { codex: LOGO, claude: LOGO },
      onSelect() {},
      onBack() {},
      onNew() {},
    }),
  );
  await dom.waitFor(() => button("New chat"));
  const mark = button("New chat").querySelector("svg path");
  assert.equal(mark.getAttribute("fill"), "currentColor");
  assert.equal(
    mark.getAttribute("fill-rule"),
    "evenodd",
    "the plus is cut out of the bubble",
  );
  assert.deepEqual(dom.errors, []);
});

test("the model and the permission mode are always in sight in the box, as in the apps", async () => {
  await mount(
    React.createElement(AgentSessionView, {
      peer,
      session: codexSession(),
      siblings: [],
      health: signedIn,
      onSelect() {},
      onBack() {},
    }),
  );
  await dom.waitFor(() => $(".as-model"));
  assert.equal($(".as-mode").textContent, "Approve for me");
  assert.ok(!button("Chat settings"));
  assert.deepEqual(dom.errors, []);
});

test("separate app drafts survive navigation", async () => {
  let view = await mount(
    React.createElement(AgentSessionView, {
      peer,
      session: codexSession(),
      siblings: [codexSession(), codexSession({ id: NEW, title: "Add tests" }), claudeSession()],
      health: signedIn,
      onSelect() {},
      onBack() {},
    }),
  );
  await typeInto($("textarea"), "Keep the Codex draft");
  await view.unmount();
  view = await open(claudeSession());
  assert.equal($("textarea").value, "");
  await typeInto($("textarea"), "Keep the Claude draft");
  await view.unmount();
  await open(codexSession());
  assert.equal($("textarea").value, "Keep the Codex draft");
  assert.equal(mac.sent.length, 0);
  assert.deepEqual(dom.errors, []);
});

test("new conversation sheets close with Escape and restore the draft on reopening", async () => {
  await home([codexSession()]);
  button("New chat").focus();
  await click(button("New chat"));
  await typeInto($("textarea"), "An unfinished thought");
  dom.document.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await settle();
  assert.equal($("[role=dialog]"), null);
  assert.equal(dom.document.activeElement?.textContent.trim(), "New chat");
  await click(button("New chat"));
  assert.equal($("textarea").value, "An unfinished thought");
  assert.equal(dom.document.activeElement?.getAttribute("aria-label"), "New Codex chat");
  assert.deepEqual(dom.errors, []);
});

test("pending decisions show one request at a time without hiding the command's scope", async () => {
  mac.live = {
    ...idleLive(),
    status: "waiting",
    prompts: [
      {
        id: "7",
        kind: "command",
        title: "Run tests?",
        command: "npm test",
        cwd: "/work/app",
        decisions: ["accept", "decline"],
      },
      {
        id: "8",
        kind: "permissions",
        title: "Allow network?",
        reason: "Download the dependency",
        decisions: ["accept", "decline"],
      },
    ],
  };
  await open(codexSession());
  await dom.waitFor(() => $$(".as-review-item").length === 2);
  assert.equal($$(".as-review-item").filter((el) => !el.hidden).length, 1);
  assert.equal(
    $(".as-review-item:not([hidden]) .as-prompt-command").textContent,
    "npm test",
  );
  await click($$(".as-review-tabs button")[1]);
  assert.equal(
    $(".as-review-item:not([hidden]) strong").textContent,
    "Allow network?",
  );
  assert.equal(mac.sent.length, 0);
  assert.deepEqual(dom.errors, []);
});

test("a pending request is the agent's own card above the box, with no wrapper of Reach's around it", async () => {
  mac.live = {
    ...idleLive(),
    status: "waiting",
    prompts: [{ id: "7", kind: "command", title: "Run tests?", command: "npm test", decisions: ["accept", "decline"] }],
  };
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-review-item .as-prompt"));
  // Straight to the card: its logo and title, then its buttons.
  assert.equal($(".as-review-dock .as-prompt header strong").textContent, "Run tests?");
  assert.ok(!$(".as-review-toggle"), "no fold-away header of its own");
  assert.doesNotMatch($(".as-review-dock").textContent, /decision is needed|decisions need you/);
  assert.equal($(".as-review-body").hidden, false);
  // One short command: nothing to open.
  assert.ok(!$(".as-command-toggle"));
  assert.deepEqual(dom.errors, []);
});

test("a long command shows its first lines; Show all opens the rest and the buttons stay in place", async () => {
  const script = ["cd /work/app", "python3 - <<'EOF'", "p='test/move-chat-ui.test.mjs'", "s=open(p).read()", "assert old in s", "EOF"].join("\n");
  mac.live = {
    ...idleLive(),
    status: "waiting",
    prompts: [{ id: "9", kind: "command", title: "Add tests and run them", command: script, decisions: ["accept", "decline"] }],
  };
  await open(claudeSession({ live: undefined }));
  const pre = await dom.waitFor(() => $(".as-review-item .as-prompt-command"));
  // All of it is there to read, folded to a preview until asked.
  assert.equal(pre.textContent, script);
  assert.ok(pre.classList.contains("clipped"));
  const toggle = $(".as-command-toggle");
  assert.equal(toggle.textContent, "Show all");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  // The buttons come right after the preview, not after the whole script.
  assert.ok($(".as-review-item .as-prompt-actions button"));
  await click(toggle);
  assert.ok($(".as-review-item .as-prompt-command").classList.contains("open"));
  assert.equal($(".as-command-toggle").textContent, "Show less");
  await click($(".as-command-toggle"));
  assert.ok($(".as-review-item .as-prompt-command").classList.contains("clipped"));
  assert.equal(mac.sent.length, 0);
  assert.deepEqual(dom.errors, []);
});

test("an app's pending badge exposes its old pending work without mixing other apps' chats", async () => {
  const sessions = Array.from({ length: 15 }, (_, i) =>
    codexSession({ id: "recent-" + i, title: "Recent " + i }),
  );
  sessions.push(
    claudeSession({
      title: "Older pending chat",
      status: "waiting",
      updatedAt: Date.now() - 86400000,
    }),
  );
  await mount(
    React.createElement(EverythingChat, {
      peer,
      feed: {
        sessions,
        health: signedIn,
        errors: {},
        failure: "",
        reload: async () => {},
        recheck() {},
      },
    }),
  );
  assert.equal($(".chat-card[aria-label='Older pending chat, Claude Code']"), null);
  const claude = $(".chat-app-rail [aria-label='Claude Code']");
  assert.match(claude.getAttribute("aria-description"), /1.*request/);
  assert.equal(claude.querySelector(".chat-app-pending").textContent, "1");
  await chooseApp("Claude Code");
  assert.equal($(".chat-card strong").textContent, "Older pending chat");
  assert.equal($(".needs-you"), null);
  assert.ok($(".chat-review-link, .chat-needs-row"));
  assert.deepEqual(dom.errors, []);
});

test("reading history stays put when older messages load, with an explicit way back to latest", async () => {
  const route = `/api/sessions/codex/${CODEX}`;
  const original = routes[route];
  const recent = {
    id: "recent",
    role: "assistant",
    kind: "text",
    text: "Recent message",
  };
  mac.pages[`codex:${CODEX}`] = {
    session: codexSession(),
    items: [recent],
    before: "older",
  };
  routes[route] = (init, url) =>
    url.searchParams.get("before")
      ? {
          session: codexSession(),
          items: [
            {
              id: "earlier",
              role: "assistant",
              kind: "text",
              text: "Earlier message",
            },
          ],
          before: null,
        }
      : mac.pages[`codex:${CODEX}`];
  try {
    await mount(
      React.createElement(AgentSessionView, {
        peer,
        session: codexSession(),
        siblings: [codexSession()],
        health: signedIn,
        onSelect() {},
        onBack() {},
      }),
    );
    await dom.waitFor(() => $(".as-older"));
    const scroll = $(".as-scroll");
    let top = 40;
    Object.defineProperties(scroll, {
      scrollHeight: {
        configurable: true,
        get: () => scroll.querySelectorAll(".as-assistant").length * 200,
      },
      clientHeight: { configurable: true, value: 80 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (v) => {
          top = v;
        },
      },
    });
    scroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    await dom.waitFor(() => $(".as-latest"));
    $(".as-older").click();
    await dom.waitFor(() => scroll.textContent.includes("Earlier message"));
    assert.equal(
      top,
      240,
      "the visible message stays at its previous position after prepending",
    );
    $(".as-latest").click();
    await settle();
    assert.equal(top, 400);
    assert.equal($(".as-latest"), null);
  } finally {
    routes[route] = original;
  }
});

test("failed Mac approval keeps a visible live-screen handoff even without dialog coordinates", async () => {
  const request = { id: "blocked", kind: "privacy", title: "Finder access", detail: "", app: "Reach", buttons: ["Allow"], default: "Allow" };
  const shown = [];
  routes["/api/sessions/mac-prompts/blocked/press"] = () => Response.json({ error: "macOS blocked this action" }, { status: 409 });
  await mount(React.createElement(EverythingChat, {
    peer,
    feed: { sessions: [], health: signedIn, errors: {}, failure: "", macPrompts: [request], reload: async () => {}, recheck: () => {} },
    showOnScreen: (p) => shown.push(p),
  }));
  await click($(".chat-review-link, .chat-needs-row"));
  const card = $(".need-card");
  assert.ok(card.querySelector(".need-screen button"), "handoff is visible without expanding details");
  await click(button("Allow"));
  await dom.waitFor(() => card.querySelector("small.problem"));
  assert.match(card.textContent, /macOS blocked this action/);
  assert.match(card.textContent, /approve on the Mac itself/);
  await click(card.querySelector(".need-screen button"));
  assert.deepEqual(shown, [request]);
  assert.ok($(".need-card"), "a failed answer does not dismiss the request");
  assert.deepEqual(dom.errors, []);
});

test("Mac authentication clears the password, prevents duplicate sends, and promotes live screen on failure", async () => {
  let finish;
  const shown = [];
  const route = "/api/sessions/mac-prompts/auth-flow/password";
  routes[route] = (init) => {
    mac.sent.push({ route, body: JSON.parse(init.body) });
    return new Promise((resolve) => { finish = resolve; });
  };
  let refreshed = 0;
  await mount(React.createElement(EverythingChat, {
    peer,
    feed: { sessions: [], health: signedIn, errors: {}, failure: "", macPrompts: [{ id: "auth-flow", kind: "password", title: "Password", detail: "", app: null }], reload: async () => refreshed++, recheck: () => {} },
    showOnScreen: (p) => shown.push(p.id),
  }));
  await click($(".chat-review-link, .chat-needs-row"));
  const field = $(".mac-password input");
  assert.equal(field.type, "password");
  const form = $(".mac-password");
  const submit = () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await typeInto(field, "sample-secret");
  submit(); submit();
  await dom.waitFor(() => mac.sent.length === 1);
  assert.equal(field.value, "");
  assert.equal(field.disabled, true);
  assert.equal($(".need-screen button").disabled, true);
  assert.match(form.textContent, /Authenticating/);
  finish(Response.json({ error: "macOS refused authentication" }, { status: 409 }));
  await dom.waitFor(() => form.querySelector('[role="alert"]'));
  assert.equal(field.value, "");
  assert.equal(field.disabled, false);
  assert.equal($(".need-screen button").className, "primary");
  assert.equal(refreshed, 0);
  await click($(".need-screen button"));
  assert.deepEqual(shown, ["auth-flow"]);
  // A retry always needs new input. No password was saved in either storage.
  submit();
  await settle(10);
  assert.equal(mac.sent.length, 1);
  assert.ok(!JSON.stringify(dom.window.localStorage).includes("sample-secret"));
  assert.ok(!JSON.stringify(dom.window.sessionStorage).includes("sample-secret"));
  await typeInto(field, "another-sample");
  submit();
  await dom.waitFor(() => mac.sent.length === 2);
  finish({ done: true });
  await dom.waitFor(() => form.querySelector('[role="status"]'));
  assert.equal(refreshed, 1);
  assert.equal(field.value, "");
  assert.equal(field.disabled, true);
  assert.match(form.textContent, /Authentication submitted/);
  assert.doesNotMatch(form.textContent, /Approved/);
  assert.deepEqual(dom.errors, []);
  delete routes[route];
});

test("an active conversation can review Mac authentication without losing its draft", async () => {
  await mount(React.createElement(EverythingChat, {
    peer,
    feed: { sessions: [codexSession()], health: signedIn, errors: {}, failure: "", macPrompts: [{ id: "active-auth", kind: "password", title: "Password", detail: "", app: null }], reload: async () => {}, recheck: () => {} },
    showOnScreen: () => {},
  }));
  await click($(".chat-card"));
  await dom.waitFor(() => $("textarea"));
  await typeInto($("textarea"), "Keep this draft");
  await click(button("Your Mac needs you"));
  assert.ok($(".mac-password input"));
  assert.ok(button("Authenticate on Mac"));
  await click($("[aria-label='Close needs you']"));
  assert.equal($("textarea").value, "Keep this draft");
  assert.deepEqual(dom.errors, []);
});

test("Codex and Claude stay available for setup while absent optional apps are hidden", async () => {
  let checks = 0;
  await home([], [
    { agent: "codex", installed: false, signedIn: false },
    { agent: "claude", installed: false, signedIn: false },
    { agent: "gemini", name: "Gemini CLI", installed: false, signedIn: false, supported: false },
    { agent: "openclaw", name: "OpenClaw", installed: false, signedIn: false, supported: true },
  ], { recheck: () => checks++ });
  assert.deepEqual($$(".chat-app-rail button").map(b => b.getAttribute("aria-label")), ["Codex", "Claude Code"]);
  assert.match($(".chat-setup").textContent, /Set up Codex on Mac/);
  // Installed from here: its maker's command on the Mac (agent-install-ui).
  assert.equal($$(".chat-setup button").filter((b) => b.textContent === "Install on Mac").length, 1);
  assert.equal(button("New chat"), undefined);
  assert.equal($(".chat-list-empty"), null);
  await click(button("Check again")); assert.equal(checks, 1);
  await chooseApp("Claude Code");
  assert.match($(".chat-setup").textContent, /Set up Claude Code/);
  assert.equal($$(".chat-setup button").filter((b) => b.textContent === "Install on Mac").length, 1);
  assert.equal(mac.sent.length, 0);
});

test("an installed signed-out app offers sign-in directly in its chat space", async () => {
  await home([], [{ agent: "codex", installed: true, signedIn: false }]);
  assert.ok($(".chat-library .sign-in-start"));
  assert.equal($("[role=dialog]"), null);
  assert.equal(button("New chat"), undefined);
  await click(button("Sign in"));
  assert.deepEqual(mac.sent[0], { route: "POST /api/sessions/sign-in", body: { agent: "codex" } });
});

test("failed discovery offers retry without claiming an app is missing", async () => {
  await home([], [{ agent: "codex", installed: false, signedIn: false, error: "Computer unavailable" }]);
  assert.match($(".chat-setup").textContent, /Couldn’t check Codex/);
  assert.equal($(".chat-setup a"), null);
  assert.equal(button("New chat"), undefined);
});

test("an unavailable remembered optional app falls back to All on this computer", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "openclaw");
  await home([codexSession()], signedIn);
  await dom.waitFor(() => $(".chat-hub"));
  assert.equal($(".chat-current-name").textContent, "All");
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "all");
  assert.equal($$(".chat-card").length, 1);
  assert.equal(button("OpenClaw"), undefined);
});

test("a permission the Codex app asks for shows here as Codex's, answered in the Codex app", async () => {
  // The Codex app holds the chat and shows its own approval card; Reach reads
  // the question from the chat's file (codex-asks.mjs).
  const asking = {
    kind: "permission",
    text: "May I apply and build the restored Reach screen and verified typing fix in the running checkout?",
  };
  const session = codexSession({ status: "waiting", held: "codex-app", asking });
  mac.pages[`codex:${CODEX}`].session = session;
  await open(session, signedIn, peer, { onScreen() {} });
  await dom.waitFor(() => $(".as-prompt.elsewhere"));
  const card = $(".as-prompt.elsewhere");
  assert.equal(
    card.querySelector("header strong").textContent,
    "Waiting for your answer in the Codex app on your Mac",
  );
  // Codex's own logo, not Claude's.
  const logo = card.querySelector("header [alt], header [aria-label]");
  assert.equal(logo.getAttribute("alt") || logo.getAttribute("aria-label"), "Codex");
  assert.match(card.textContent, /May I apply and build the restored Reach screen/);
  assert.match(card.textContent, /already open in the Codex app/);
  assert.deepEqual(dom.errors, []);
});

test("a Claude chat opened while the keyboard is already visible uses the compact layout immediately", async () => {
  const previous = Object.getOwnPropertyDescriptor(dom.window, "visualViewport");
  const viewport = new dom.window.EventTarget();
  Object.assign(viewport, { height: 330, width: 390, offsetTop: 0, offsetLeft: 0 });
  Object.defineProperty(dom.window, "visualViewport", { configurable: true, value: viewport });
  try {
    const view = await mount(React.createElement(AgentSessionView, {
      peer, session: claudeSession(), siblings: [], health: signedIn, onSelect() {}, onBack() {},
    }));
    assert.ok($(".as-page.kb-open"));
    assert.equal($(".as-page").style.getPropertyValue("--vv-height"), "330px");
    viewport.height = dom.window.innerHeight;
    viewport.dispatchEvent(new dom.window.Event("resize"));
    await dom.waitFor(() => !$(".as-page.kb-open"));
    await view.unmount();
  } finally {
    if (previous) Object.defineProperty(dom.window, "visualViewport", previous);
    else delete dom.window.visualViewport;
  }
});

test("a small upward scroll and an active touch are not pulled back by Claude updates", async () => {
  await mount(React.createElement(AgentSessionView, {
    peer, session: claudeSession(), siblings: [], health: signedIn, onSelect() {}, onBack() {},
  }));
  await dom.waitFor(() => $(".as-scroll") && !$(".as-note"));
  const scroller = $(".as-scroll");
  let top = 590;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, get: () => top, set: (value) => { top = Math.min(600, value); } },
  });
  scroller.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
  mac.bump({ streaming: "New streamed text" });
  await dom.waitFor(() => $(".streaming")?.textContent.includes("New streamed text"));
  assert.equal(top, 590, "even 10px into history is kept stable");
  await click(button("Jump to latest message"));
  assert.equal(top, 600);
  scroller.dispatchEvent(new dom.window.Event("touchstart", { bubbles: true }));
  top = 580; // A native gesture has started; its scroll event hasn't arrived yet.
  mac.bump({ streaming: "Update during a swipe" });
  await dom.waitFor(() => $(".streaming")?.textContent.includes("Update during a swipe"));
  assert.equal(top, 580, "don't cancel an in-progress touch with scrollTop writes");
  scroller.dispatchEvent(new dom.window.Event("touchcancel", { bubbles: true }));
  mac.bump({ streaming: "Follow after cancellation" });
  await dom.waitFor(() => $(".streaming")?.textContent.includes("Follow after cancellation"));
  assert.equal(top, 600, "cancelled touches don't disable following forever");
});

// Safari reloads a tab left in the background, and Reach came back on Home
// instead of the chat that was open.
test("a reload comes back to the chat that was open, in this tab, on this computer", async () => {
  const link = await dom.load("/src/deep-link.ts");
  link.rememberPlace(peer.id, { page: "sessions" });
  const feed = { sessions: [claudeSession()], errors: {}, health: signedIn, failure: "", reload: async () => {}, recheck: () => {} };
  await mount(React.createElement(EverythingChat, { peer, feed, target: { agent: "claude", id: CLAUDE } }));
  await dom.waitFor(() => button("Back to all sessions"));
  await dom.waitFor(() => link.lastPlace(peer.id)?.id === CLAUDE);
  assert.deepEqual(link.lastPlace(peer.id), { page: "sessions", agent: "claude", id: CLAUDE });
  assert.equal(link.lastPlace("another-mac"), null, "another computer's place isn't this one's");
  // Back to the list: a reload shows the list.
  await click(button("Back to all sessions"));
  await dom.waitFor(() => !link.lastPlace(peer.id)?.id);
  assert.deepEqual(link.lastPlace(peer.id), { page: "sessions" });
  link.rememberPlace(peer.id, { page: "files" });
  assert.deepEqual(link.lastPlace(peer.id), { page: "files" });
  // A new tab, or Reach opened from the Home Screen, starts on Home.
  dom.window.sessionStorage.clear();
  assert.equal(link.lastPlace(peer.id), null);
  assert.deepEqual(dom.errors, []);
});

// Several taps on Send in the same instant posted the message several times.
test("taps on Send in the same instant send the message once", async () => {
  await open(codexSession());
  await dom.waitFor(() => $("textarea"));
  await typeInto($("textarea"), "ship it");
  const send = button("Send");
  for (let i = 0; i < 3; i++) send.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => mac.sent.some((m) => m.route.endsWith("/messages")));
  await settle(50);
  assert.deepEqual(mac.sent.filter((m) => m.route.endsWith("/messages")).map((m) => m.body.text), ["ship it"]);
  assert.deepEqual(dom.errors, []);
});

// A send that couldn't reach the Mac said only "Failed to fetch".
test("a send that can't reach the Mac says so in plain words and keeps the text", async (t) => {
  const route = `/api/sessions/codex/${CODEX}/messages`;
  const before = routes[route];
  t.after(() => (routes[route] = before));
  routes[route] = () => Promise.reject(new TypeError("Failed to fetch"));
  await open(codexSession());
  await dom.waitFor(() => $("textarea"));
  await typeInto($("textarea"), "ship it");
  await click(button("Send"));
  await dom.waitFor(() => /Couldn.t reach your Mac/.test(dom.document.body.textContent));
  assert.ok(!/Failed to fetch/.test(dom.document.body.textContent));
  assert.equal($("textarea").value, "ship it");
});

// An 8,000-character message took about eleven screens.
test("a long message you sent folds to its first lines; Show more opens it", async () => {
  const long = Array.from({ length: 200 }, (_, n) => `Line ${n} of the pasted log, with some words.`).join("\n");
  mac.pages[`codex:${CODEX}`].items = [
    { id: "u1", role: "user", kind: "text", text: long, at: Date.now() - 2000 },
    { id: "u2", role: "user", kind: "text", text: "short one", at: Date.now() - 1000 },
  ];
  await open(codexSession());
  await dom.waitFor(() => $$(".as-user").length === 2);
  const [first, second] = $$(".as-user");
  assert.ok(first.querySelector(".as-fold.folded"), "folded");
  assert.ok(!second.querySelector(".as-fold"), "a short one isn't");
  const more = first.querySelector(".as-fold-toggle");
  assert.equal(more.textContent, "Show more");
  await click(more);
  assert.ok(!first.querySelector(".as-fold.folded"));
  assert.equal(first.querySelector(".as-fold-toggle").textContent, "Show less");
  assert.match(first.textContent, /Line 199 of the pasted log/);
  assert.deepEqual(dom.errors, []);
});

// A new chat defaulted to a temporary worktree (zen-haibt-050e63), and two
// folder chips both said "reach".
test("a new chat's folders: each project once, worktrees as their project, same names told apart", async () => {
  const chat = await dom.load("/src/EverythingChat.tsx");
  const folders = chat.chatFolders([
    { cwd: "/Users/me/code/reach/.claude/worktrees/zen-haibt-050e63" },
    { cwd: "/Users/me/.codex/worktrees/a1b2/reach" },
    { cwd: "/Users/me/code/reach" },
    { cwd: "/Users/me/old/reach" },
    { cwd: "/Users/me/code/site" },
    { cwd: "" },
  ]);
  assert.deepEqual(folders, ["/Users/me/code/reach", "/Users/me/old/reach", "/Users/me/code/site"]);
  assert.deepEqual(folders.map((f) => chat.folderLabel(f, folders)), ["code/reach", "old/reach", "site"]);
  // The folder button says what it is to a screen reader.
  await home([codexSession({ cwd: "/Users/me/code/site" })]);
  await click(button("New chat"));
  const folder = await dom.waitFor(() => $(".chat-folder"));
  assert.equal(folder.getAttribute("aria-label"), "Folder: /Users/me/code/site");
  assert.deepEqual(dom.errors, []);
});

// In Codex chats a sent picture showed as a "1 image" label.
test("pictures sent in a Codex chat show too; one no longer on the Mac says so", async (t) => {
  const asked = [];
  const ok = `/api/sessions/codex/${CODEX}/images/u-pic/0`;
  const gone = `/api/sessions/codex/${CODEX}/images/u-old/0`;
  routes[ok] = () => (asked.push(ok), {});
  routes[gone] = () => (asked.push(gone), new Response(JSON.stringify({ error: "That picture isn't in this session." }), { status: 404 }));
  t.after(() => (delete routes[ok], delete routes[gone]));
  mac.pages[`codex:${CODEX}`].items = [
    { id: "u-old", role: "user", kind: "text", text: "An old one", images: 1, at: Date.now() - 90000 },
    { id: "u-pic", role: "user", kind: "text", text: "What flower is this?", images: 1, at: Date.now() - 60000 },
  ];
  await open(codexSession());
  await dom.waitFor(() => $$(".as-user-images img").length === 1 && $$(".as-user .as-tag").length === 1);
  const [old, sent] = $$(".as-user");
  assert.equal(old.querySelector(".as-tag").textContent, "1 image");
  assert.ok(sent.querySelector(".as-user-images img").getAttribute("src").startsWith("blob:"));
  assert.deepEqual(asked.sort(), [gone, ok]);
  assert.deepEqual(dom.errors, []);
});

// "It does not send instantly" (2026-10-06): a message on its way faded to
// 60% and moved into "1 queued · Sending…" for the seconds the Mac took to
// hand it over, though Claude was idle. Now it shows as sent in the
// conversation at once, and goes to the queue only when it has to wait.
test("a message on its way to an idle chat shows in the conversation at once; the queue only says why one waits", async () => {
  mac.live = { ...idleLive(), outbox: [{ id: "m1", text: "Ship it", images: 0, sending: true }] };
  await open(claudeSession());
  await dom.waitFor(() => $$(".as-user.pending").some((b) => /Ship it/.test(b.textContent)));
  assert.equal($(".qm-head"), null, "no queue while it's handed over");
  assert.equal($(".qm-row"), null);
  // Held up (another chat on screen): it moves to the queue, saying why.
  mac.bump({ outbox: [{ id: "m1", text: "Ship it", images: 0, error: "Goes in when you open this chat in the Claude app." }] });
  await dom.waitFor(() => $(".qm-head") || $(".qm-row"));
  assert.ok(!$$(".as-user.pending").some((b) => /Ship it/.test(b.textContent)));
  assert.deepEqual(dom.errors, []);
});

test("while the agent works, a message waits in the queue, as in the agent's app", async () => {
  mac.live = { ...idleLive(), status: "running", outbox: [{ id: "m1", text: "Then commit", images: 0, sending: true }] };
  await open(claudeSession({ status: "running" }));
  await dom.waitFor(() => $(".qm-head") || $(".qm-row"));
  assert.ok(!$$(".as-user.pending").some((b) => /Then commit/.test(b.textContent)));
  assert.deepEqual(dom.errors, []);
});

// A Claude app chat's permission card said "Open screen to answer": the phone
// couldn't allow it. Now it's drawn as the app draws it, read from the app
// (its words, its buttons, in order), and answered with those same buttons;
// a terminal's request is still answered there.
test("a Claude app permission card shows as the app draws it and is answered with its own buttons", async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}/card`;
  t.after(() => delete routes[route]);
  routes[route] = () => ({
    id: "app-permission:toolu_9",
    texts: ["Allow Claude to run this command?", "npm run build"],
    buttons: ["Deny", "Always allow for this project", "Allow once"],
  });
  const asking = { kind: "permission", text: "npm run build", command: true, id: "app-permission:toolu_9" };
  const session = claudeSession({ status: "waiting", asking, live: { where: "claude-app", busy: false, waiting: "permission prompt" } });
  mac.pages[`claude:${CLAUDE}`].session = session;
  await open(session);
  const card = await dom.waitFor(() => $(".as-prompt.elsewhere .as-app-card") && $(".as-prompt.elsewhere"));
  assert.equal(card.querySelector(".as-app-card-title").textContent, "Allow Claude to run this command?");
  assert.equal(card.querySelector(".as-prompt-command").textContent, "npm run build");
  const buttons = [...card.querySelectorAll(".as-prompt-actions button")];
  // The app's own buttons, in its order, its main one first in weight.
  assert.deepEqual(buttons.map((b) => b.textContent), ["Deny", "Always allow for this project", "Allow once"]);
  assert.deepEqual(buttons.map((b) => b.classList.contains("primary")), [false, false, true]);
  assert.equal($$("button").filter((b) => b.textContent === "Open screen to answer").length, 0);
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ status: "running" });
  await click(buttons[1]);
  await dom.waitFor(() => mac.sent.length === 1);
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/claude/${CLAUDE}/prompts/app-permission%3Atoolu_9`, body: { label: "Always allow for this project" } },
  ]);
  await dom.waitFor(() => !$(".as-prompt.elsewhere"));
  for (const view of views.splice(0)) await view.unmount();
  // A terminal's request (no id): said here, answered there.
  const terminal = claudeSession({ status: "waiting", asking: { kind: "permission", text: "npm test", command: true }, live: { where: "terminal", busy: false, waiting: "permission prompt" } });
  mac.pages[`claude:${CLAUDE}`].session = terminal;
  await open(terminal);
  const said = await dom.waitFor(() => $(".as-prompt.elsewhere"));
  assert.equal([...said.querySelectorAll("button")].filter((b) => /Allow|Deny/.test(b.textContent)).length, 0);
  assert.match(said.textContent, /Answer it on your Mac/);
  assert.deepEqual(dom.errors, []);
});

test("an unconfirmed app-card answer removes its approval buttons and explains the failure", async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}/card`;
  const answerRoute = `/api/sessions/claude/${CLAUDE}/prompts/app-permission%3Ap1`;
  t.after(() => { delete routes[route]; delete routes[answerRoute]; });
  routes[route] = () => ({ id: "app-permission:p1", texts: ["Run example?"], buttons: ["Allow once", "Deny"] });
  let attempts = 0;
  routes[answerRoute] = () => { attempts++; return Response.json({ error: "Answer delivery unknown. Check Claude." }, { status: 409 }); };
  const session = claudeSession({ status: "waiting", asking: { kind: "permission", text: "example", id: "app-permission:p1" } });
  mac.pages[`claude:${CLAUDE}`].session = session;
  await open(session);
  const approve = await dom.waitFor(() => $(".as-app-card-actions button"));
  await click(approve);
  await dom.waitFor(() => !$(".as-app-card-actions"));
  assert.match($(".as-prompt.elsewhere").textContent, /Answer delivery unknown/);
  assert.equal(attempts, 1);
});

test("a Codex app approval shows as the Codex app draws it; a card that can't be read offers the live screen", async (t) => {
  const route = `/api/sessions/codex/${CODEX}/card`;
  let answer = {
    id: "app-permission:codex:c7",
    texts: ["Do you want ChatGPT to run this command?", "npm run build"],
    buttons: ["Allow once", "Deny"],
    more: ["Allow this conversation", "Always allow"],
  };
  t.after(() => delete routes[route]);
  routes[route] = () => answer;
  const asking = { kind: "permission", text: "npm run build", command: true, id: "app-permission:codex:c7" };
  const session = codexSession({ status: "waiting", held: "codex-app", asking });
  mac.pages[`codex:${CODEX}`].session = session;
  await open(session);
  const card = await dom.waitFor(() => $(".as-prompt.elsewhere .as-app-card") && $(".as-prompt.elsewhere"));
  assert.match(card.textContent, /Codex app/);
  const buttons = [...card.querySelectorAll(".as-prompt-actions button")];
  assert.deepEqual(buttons.map((b) => b.textContent), ["Allow once", "Deny"]);
  // The card's menu, folded as the app folds it.
  const more = card.querySelector(".as-app-card-more");
  assert.equal(more.textContent, "More choices");
  await click(more);
  const all = [...card.querySelectorAll(".as-prompt-actions button")].map((b) => b.textContent);
  assert.deepEqual(all, ["Allow once", "Deny", "Allow this conversation", "Always allow"]);
  mac.pages[`codex:${CODEX}`].session = codexSession({ status: "running", held: "codex-app" });
  await click([...card.querySelectorAll(".as-prompt-actions button")].find((b) => b.textContent === "Allow this conversation"));
  await dom.waitFor(() => mac.sent.length === 1);
  assert.deepEqual(mac.sent, [{ route: `/api/sessions/codex/${CODEX}/prompts/app-permission%3Acodex%3Ac7`, body: { label: "Allow this conversation" } }]);
  for (const view of views.splice(0)) await view.unmount();
  // The card couldn't be read: no buttons made up, the live screen instead.
  answer = new Response(JSON.stringify({ error: "The Codex app isn't showing this request. Answer it on your Mac." }), { status: 409 });
  mac.pages[`codex:${CODEX}`].session = session;
  await open(session, signedIn, peer, { onScreen() {} });
  const said = await dom.waitFor(() => $$(".as-prompt.elsewhere").find((el) => /isn.t showing this request/.test(el.textContent)));
  assert.equal([...said.querySelectorAll("button")].filter((b) => /Allow|Deny/.test(b.textContent)).length, 0);
  assert.ok([...said.querySelectorAll("button")].some((b) => b.textContent === "Open screen to answer"));
  assert.deepEqual(dom.errors, []);
});

// "Chat sometimes shows can't reach your Mac" (2026-10-06): a chat read that
// failed for a moment left the message up until the next 30 s look.
test("an open chat's read that fails for a moment is tried again by itself, without saying the Mac is out of reach", async () => {
  const route = `/api/sessions/codex/${CODEX}`;
  const real = routes[route];
  let unreachable = 0;
  routes[route] = (...args) => {
    if (unreachable > 0 && unreachable--) throw new TypeError("Load failed");
    return real(...args);
  };
  try {
    await open(codexSession());
    await dom.waitFor(() => $("textarea"));
    unreachable = 1;
    mac.pages[`codex:${CODEX}`].items = [{ id: "a1", role: "assistant", kind: "text", text: "Back again", turnId: "t1" }];
    mac.bump();
    await dom.waitFor(() => /Back again/.test(dom.document.body.textContent), 4000);
    assert.equal(/Couldn.t reach/.test(dom.document.body.textContent), false);
    assert.deepEqual(dom.errors, []);
  } finally {
    routes[route] = real;
  }
});

// Oct 6: Claude's questions in the Claude app said "Answer it on your Mac
// through live screen". Their options are tapped here now, one question per
// page, and answered in the app.
test("Claude's question in the Claude app is answered here: options tapped, then Submit", async (t) => {
  const answerRoute = `/api/sessions/claude/${CLAUDE}/prompts/${encodeURIComponent("app-question:toolu_q")}`;
  const sent = [];
  t.after(() => { delete routes[answerRoute]; });
  routes[answerRoute] = (init) => (sent.push(JSON.parse(init.body)), { answered: true });
  const asking = {
    kind: "question",
    id: "app-question:toolu_q",
    questions: [
      { question: "How should an agent get your folders?", options: [{ label: "Real folder, read-only (Recommended)" }, { label: "Keep private copy only" }] },
      { question: "Which layout for the new invite screen?", multiSelect: true, options: [{ label: "One page, 3 switches (Recommended)" }, { label: "Step by step" }] },
    ],
  };
  const session = claudeSession({ status: "waiting", asking, live: { where: "claude-app", busy: false, waiting: "input needed" } });
  mac.pages[`claude:${CLAUDE}`].session = session;
  await open(session);
  const card = await dom.waitFor(() => $(".as-prompt.question"));
  assert.equal($(".as-prompt.elsewhere"), null, "no live-screen card");
  assert.doesNotMatch(card.textContent, /live screen/);
  const choice = (label) => $$(".as-choices button").find((b) => b.textContent.includes(label));
  await click(choice("Real folder, read-only (Recommended)"));
  // Next page: several may be picked.
  await click(await dom.waitFor(() => choice("Step by step")));
  await click(choice("One page, 3 switches (Recommended)"));
  await click($$(".as-prompt-actions button").find((b) => b.textContent === "Submit"));
  await dom.waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0], {
    answers: { q0: ["Real folder, read-only (Recommended)"], q1: ["Step by step", "One page, 3 switches (Recommended)"] },
  });
});


for (const outcome of ["failure", "success"]) test(`a linked chat ignores a departed transcript ${outcome} and its queued reread`, async (t) => {
  const local = "local_4ff35923-e6eb-432e-9e43-ba980333dcde";
  const first = claudeSession({ inApp: false });
  const second = claudeSession({ id: NEW, title: "Linked target", appSessionId: local, inApp: false });
  const page = { session: first, items: [{ id: "link-1", role: "assistant", kind: "text", text: `[Open linked target](#${local})` }] };
  mac.pages[`claude:${CLAUDE}`] = page;
  mac.pages[`claude:${NEW}`] = { session: second, items: [{ id: "new-1", role: "assistant", kind: "text", text: "Target content" }] };
  const route = `/api/sessions/claude/${CLAUDE}`;
  const original = routes[route];
  let reads = 0, finish;
  routes[route] = () => {
    reads++;
    if (reads === 2) return new Promise((resolve, reject) => {
      finish = () => outcome === "failure" ? reject(new Error("Synthetic old chat disconnected")) : resolve(page);
    });
    return page;
  };
  t.after(() => { routes[route] = original; });
  const feed = { sessions: [first, second], errors: {}, health: signedIn, failure: "", reload: async () => {}, recheck() {} };
  await mount(React.createElement(EverythingChat, { peer, feed, target: { agent: "claude", id: CLAUDE } }));
  await dom.waitFor(() => $("button.md-session-link"));
  await typeInto($(".as-composer textarea"), "Unsent source draft");
  dom.window.dispatchEvent(new dom.window.Event("online"));
  await dom.waitFor(() => finish);
  dom.window.dispatchEvent(new dom.window.Event("online")); // queued behind that read
  await click($("button.md-session-link"));
  await dom.waitFor(() => dom.document.body.textContent.includes("Target content"));
  assert.equal($(".as-composer textarea").value, "", "the target keeps its own draft");
  assert.equal(dom.window.sessionStorage.getItem(`reach-chat-draft:${peer.id}:claude:${CLAUDE}`), "Unsent source draft");
  finish();
  await settle(1200);
  assert.equal(reads, 2, "the departed chat must not retry or drain its queued reread");
  assert.match(dom.document.body.textContent, /Target content/);
});

for (const outcome of ["failure", "success"]) test(`a replaced chat credential ignores the previous transcript ${outcome}`, async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}`;
  const original = routes[route];
  let finish, replace, oldReads = 0, newReads = 0;
  const fresh = { session: claudeSession({ title: "Fresh pairing", inApp: false }), items: [{ id: "fresh", role: "assistant", kind: "text", text: "Fresh pairing content" }] };
  routes[route] = (init) => {
    if (init.headers.get("Authorization") === "Bearer replacement-token") {
      newReads++;
      return fresh;
    }
    oldReads++;
    if (oldReads > 1) return mac.pages[`claude:${CLAUDE}`];
    return new Promise((resolve, reject) => {
      finish = () => outcome === "failure"
        ? reject(new Error("Synthetic old credential failed"))
        : resolve({ session: claudeSession({ title: "Old pairing", inApp: false }), items: [{ id: "old", role: "assistant", kind: "text", text: "Old pairing content" }] });
    });
  };
  t.after(() => { routes[route] = original; });
  function Host() {
    const [current, setCurrent] = React.useState(peer);
    replace = () => dom.update(() => setCurrent({ ...peer, token: "replacement-token" }));
    return React.createElement(AgentSessionView, {
      peer: current, session: claudeSession({ inApp: false }), siblings: [], health: signedIn,
      onSelect() {}, onBack() {},
    });
  }
  await mount(React.createElement(Host));
  await dom.waitFor(() => finish);
  replace();
  await dom.waitFor(() => dom.document.body.textContent.includes("Fresh pairing content"));
  finish();
  await settle(1200);
  assert.equal(oldReads, 1, "the old credential must not be used again");
  assert.equal(newReads, 1, "the old failure must not schedule a read under the replacement credential");
  assert.match(dom.document.body.textContent, /Fresh pairing content/);
  assert.doesNotMatch(dom.document.body.textContent, /Old pairing content/);
});


test("a replaced chat credential drops a pending older page without blocking the new history button", async (t) => {
  const route = `/api/sessions/claude/${CLAUDE}`;
  const original = routes[route];
  let finish, replace;
  routes[route] = (init, href) => {
    if (init.headers.get("Authorization") === "Bearer replacement-token") return {
      session: claudeSession({ title: "Fresh pairing", inApp: false }),
      items: [{ id: "fresh", role: "assistant", kind: "text", text: "Fresh pairing content" }], before: "fresh-older",
    };
    if (href.searchParams.get("before")) return new Promise(resolve => {
      finish = () => resolve({ session: claudeSession({ inApp: false }), items: [{ id: "old", role: "assistant", kind: "text", text: "Old pairing history" }], before: null });
    });
    return { session: claudeSession({ inApp: false }), items: [], before: "old-older" };
  };
  t.after(() => { routes[route] = original; });
  function Host() {
    const [current, setCurrent] = React.useState(peer);
    replace = () => dom.update(() => setCurrent({ ...peer, token: "replacement-token" }));
    return React.createElement(AgentSessionView, {
      peer: current, session: claudeSession({ inApp: false }), siblings: [], health: signedIn,
      onSelect() {}, onBack() {},
    });
  }
  await mount(React.createElement(Host));
  await dom.waitFor(() => $(".as-older"));
  await click($(".as-older"));
  await dom.waitFor(() => finish);
  replace();
  await dom.waitFor(() => dom.document.body.textContent.includes("Fresh pairing content"));
  assert.equal($(".as-older").disabled, false, "the previous page's wait does not disable new history");
  finish();
  await settle(30);
  assert.match(dom.document.body.textContent, /Fresh pairing content/);
  assert.doesNotMatch(dom.document.body.textContent, /Old pairing history/);
  assert.ok($(".as-older"), "the old page cannot replace the new pagination cursor");
});

test("an answered Codex question stays answered when its older page is loaded", async (t) => {
  const route = `/api/sessions/codex/${CODEX}`;
  const previous = routes[route];
  t.after(() => { routes[route] = previous; });
  const question = { id: "paged-question", turnId: "turn-1", role: "assistant", kind: "text", text: "", questions: [{ title: "Which target?", options: ["Mac", "Phone"] }] };
  const reply = { id: "paged-answer", turnId: "turn-1", role: "user", kind: "text", text: "Phone", replies: [{ questionItemId: '["request_user_input_async","paged-question",0]', question: "Which target?", answer: "Phone" }] };
  routes[route] = (init, url) => ({ session: codexSession({ status: "running" }), items: url.searchParams.get("before") ? [question] : [reply], before: url.searchParams.get("before") ? null : "older" });
  mac.live = { ...idleLive(), status: "running", turnId: "turn-1" };
  await open(codexSession({ status: "running" }));
  await click(await dom.waitFor(() => $(".as-older")));
  await dom.waitFor(() => $(".as-async-questions .as-answered"));
  assert.equal($(".as-answered").textContent, "Phone");
  assert.equal($$(".as-async-questions button").length, 0);
  assert.equal($$(".as-user").length, 0, "no duplicate answer bubble remains");
  assert.deepEqual(dom.errors, []);
});

for (const [context, label, text] of [
  [{ used: 200001, window: null }, "200,001 tokens reported; context capacity unknown", "200,001 tokens"],
  [{ used: 64000, window: 258000 }, "25% of context used", "25%"],
]) test(`the context display reports ${label}`, async () => {
  mac.pages[`claude:${CLAUDE}`].session.context = context;
  await open(claudeSession({ context }));
  const meter = await dom.waitFor(() => $(".as-context"));
  assert.equal(meter.getAttribute("aria-label"), label);
  assert.equal(meter.textContent, text);
  assert.equal(!!meter.querySelector("svg"), context.window !== null);
  assert.deepEqual(dom.errors, []);
});

for (const agent of ["codex", "claude"]) test(`${agent}: cancelling an acknowledged queue entry elsewhere removes its optimistic copy`, async (t) => {
  const session = agent === "codex" ? codexSession({ status: "running" }) : claudeSession({ status: "running" });
  mac.pages[`${agent}:${session.id}`].session = session;
  mac.live = { ...idleLive(), status: "running" };
  const route = `/api/sessions/${agent}/${session.id}/messages`, previous = routes[route];
  let sends = 0;
  routes[route] = () => {
    sends++;
    mac.bump({ outbox: [{ id: "native-queued", text: "Cancel me in the app", images: 0 }] });
    return { queued: true, delivered: false, messageId: "native-queued" };
  };
  t.after(() => { routes[route] = previous; });
  await open(session);
  await dom.waitFor(() => $(".as-composer textarea"));
  await typeInto($(".as-composer textarea"), "Cancel me in the app");
  await click(button("Send"));
  await dom.waitFor(() => $(".qm-row") || $(".qm-head"));
  assert.equal(sends, 1);
  mac.bump({ outbox: [] }); // authoritative external cancellation, no transcript message
  await dom.waitFor(() => !$(".qm-row") && !$(".qm-head"));
  assert.equal($$(".as-user.pending").length, 0, "the acknowledged queue owns the message; no ghost bubble survives cancellation");
  assert.equal(mac.pages[`${agent}:${session.id}`].items.length, 0);
  assert.equal(sends, 1, "cancellation must never resend");
  assert.deepEqual(dom.errors, []);
});

for (const agent of ["codex", "claude"]) test(`${agent}: a transcript read begun before effort confirmation cannot restore the old effort`, async (t) => {
  const session = agent === "codex" ? codexSession({ effort: "medium" }) : claudeSession({ effort: "medium" });
  mac.pages[`${agent}:${session.id}`].session = session;
  const readRoute = `/api/sessions/${agent}/${session.id}`, previousRead = routes[readRoute];
  const offers = CLAUDE_OFFERS.models;
  if (agent === "claude") CLAUDE_OFFERS.models = [{ id: session.model, name: "Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true }];
  t.after(() => { routes[readRoute] = previousRead; CLAUDE_OFFERS.models = offers; });
  await open(session, signedIn, { ...peer, url: `https://${agent}-effort-read-race.test` });
  await dom.waitFor(() => $(".as-model-effort")?.textContent === "Medium");
  let finish;
  const stale = { session: { ...session }, items: [{ id: "during-pick", role: "assistant", kind: "text", text: "Arrived while choosing effort" }] };
  routes[readRoute] = () => new Promise(resolve => { finish = resolve; });
  dom.window.dispatchEvent(new dom.window.Event("online"));
  await dom.waitFor(() => finish);
  await click($(".as-model"));
  if (agent === "claude") await click($$(".ms-row").find(el => el.textContent.includes("Effort")));
  const high = agent === "codex" ? $('.ms-dots [aria-label="High"]') : $$('.ms-card[aria-label="Effort"] button').find(el => el.textContent.trim() === "High");
  await click(high);
  await dom.waitFor(() => $(".as-model-effort")?.textContent === "High");
  let finishFresh;
  routes[readRoute] = () => new Promise(resolve => { finishFresh = resolve; });
  finish(stale);
  await dom.waitFor(() => $(".as-scroll")?.textContent.includes("Arrived while choosing effort"));
  assert.equal($(".as-model-effort").textContent, "High", "a stale read must not undo the acknowledged selection before any fresh read finishes");
  await dom.waitFor(() => finishFresh);
  routes[readRoute] = previousRead;
  finishFresh(mac.pages[`${agent}:${session.id}`]);
  mac.pages[`${agent}:${session.id}`].session.effort = "low";
  mac.bump();
  await dom.waitFor(() => $(".as-model-effort")?.textContent === "Low");
  assert.deepEqual(dom.errors, []);
});

test("Claude's resolved native model uses that catalog alias's effort options", async (t) => {
  const offers = CLAUDE_OFFERS.models;
  CLAUDE_OFFERS.models = [
    { id: "default", resolvedModel: "claude-opus-5-5", name: "Default", efforts: ["low", "medium", "high", "max"], defaultEffort: "medium", isDefault: true },
    { id: "sonnet", resolvedModel: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: ["low", "high"], defaultEffort: "low" },
  ];
  t.after(() => { CLAUDE_OFFERS.models = offers; });
  const session = claudeSession({ model: "claude-sonnet-5-5", effort: "low" });
  mac.pages[`claude:${CLAUDE}`].session = session;
  await open(session, signedIn, { ...peer, url: "https://claude-resolved-effort.test" });
  await dom.waitFor(() => $(".as-model")?.textContent.includes("Sonnet"));
  await click($(".as-model"));
  assert.equal(checkedModel(), "Sonnet 5.5");
  await click($$(".ms-row").find(el => el.textContent.includes("Effort")));
  assert.deepEqual($$('.ms-card[aria-label="Effort"] button').map(el=>el.textContent.trim()), ["Low", "High"]);
  await click($$('.ms-card[aria-label="Effort"] button').find(el=>el.textContent.trim()==="High"));
  await dom.waitFor(() => mac.sent.some(m=>m.route.endsWith("/model")));
  assert.deepEqual(mac.sent.find(m=>m.route.endsWith("/model")).body, { effort: "high" });
});

test("an unlisted current Codex model never changes to the default through an effort dot", async () => {
  const session = codexSession({ model: "unlisted-native-model", effort: "high" });
  mac.pages[`codex:${CODEX}`].session = session;
  await open(session);
  await dom.waitFor(() => $(".as-model")?.textContent.includes("unlisted-native-model"));
  await click($(".as-model"));
  assert.equal($$(".ms-dots button").length, 0, "no effort control for a different fallback model");
  assert.match($(".ms-strip-label").textContent, /unlisted-native-model/i);
  await click($(".ms-strip-label"));
  // Only the chat's own model is checked (shown as not in the list), never a listed one.
  assert.deepEqual($$('.ms-card[aria-label="Models"] [aria-checked="true"]').map((el) => el.className), ["ms-current-unlisted"]);
  assert.equal(mac.sent.length, 0);
});

// Voice. A message of only a voice note or a PDF vanished from the chat; now
// it says what was sent. A memo recorded here becomes words in the box, to
// read over before sending; when the Mac can't make words of it, the
// recording is attached and the reason shown.
test("a voice note or PDF sent to an agent shows on its message", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    { id: "u-voice", role: "user", kind: "text", text: "", attachments: ["Voice message"], at: Date.now() - 60000 },
    { id: "u-pdf", role: "user", kind: "text", text: "Summarize", attachments: ["PDF"], at: Date.now() - 30000 },
  ];
  await open(codexSession());
  await dom.waitFor(() => $$(".as-attachment").length === 2);
  assert.deepEqual($$(".as-attachment").map((t) => t.textContent.trim()), ["Voice message", "PDF"]);
  assert.match($$(".as-user")[1].textContent, /Summarize/);
  assert.deepEqual(dom.errors, []);
});

test("a voice memo becomes words in the box; one the Mac can't hear is attached, saying why", async (t) => {
  const tracks = [];
  class FakeRecorder {
    static isTypeSupported = (type) => type === "audio/mp4";
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options?.mimeType || "";
      this.state = "inactive";
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["\0\0\0\x18ftypM4A "], { type: "audio/mp4" }) });
      this.onstop?.();
    }
  }
  const stream = { getTracks: () => [{ stop: () => tracks.push("stopped") }] };
  globalThis.MediaRecorder = FakeRecorder;
  Object.defineProperty(dom.window.navigator, "mediaDevices", { value: { getUserMedia: async () => stream }, configurable: true });
  let answer = { text: "Run the tests" };
  const sent = [];
  routes["/api/sessions/voice"] = (init, href) => (sent.push(href.searchParams.get("locale")), answer);
  t.after(() => {
    delete globalThis.MediaRecorder;
    delete dom.window.navigator.mediaDevices;
    delete routes["/api/sessions/voice"];
  });
  await open(codexSession());
  const field = await dom.waitFor(() => $("textarea"));
  await typeInto(field, "Please");
  await click(button("Record a voice memo"));
  await dom.waitFor(() => button("Stop recording"));
  await click(button("Stop recording"));
  await dom.waitFor(() => field.value === "Please Run the tests");
  assert.equal(sent.length, 1);
  assert.deepEqual(tracks, ["stopped"], "the microphone is let go");
  // The Mac couldn't: the recording goes as a file, and the box says why.
  answer = { problem: "Transcribing needs macOS 26 or later.", file: { id: "f/Voice memo.m4a", name: "Voice memo.m4a" } };
  await click(button("Record a voice memo"));
  await click(await dom.waitFor(() => button("Stop recording")));
  await dom.waitFor(() => /attached instead/.test($(".as-hint")?.textContent || ""));
  assert.match($(".as-hint").textContent, /macOS 26/);
  // The Mac didn't answer at all: the recording is still kept, as a file.
  const files = [];
  routes["/api/sessions/files"] = () => (files.push(1), { id: "g/voice-memo.m4a", name: "voice-memo.m4a" });
  t.after(() => delete routes["/api/sessions/files"]);
  answer = new Response(JSON.stringify({ error: "Reach stopped." }), { status: 500 });
  await click(button("Record a voice memo"));
  await click(await dom.waitFor(() => button("Stop recording")));
  await dom.waitFor(() => files.length === 1 && /Reach stopped\..*attached instead/.test($(".as-hint")?.textContent || ""));
  // Discarded: nothing is sent to the Mac.
  await click(button("Record a voice memo"));
  await click(await dom.waitFor(() => button("Discard memo")));
  await dom.waitFor(() => button("Record a voice memo"));
  assert.equal(sent.length, 3);
  assert.deepEqual(dom.errors, []);
});

test("without a microphone the memo says so and nothing breaks", async (t) => {
  globalThis.MediaRecorder = class { static isTypeSupported = () => false; };
  Object.defineProperty(dom.window.navigator, "mediaDevices", {
    value: { getUserMedia: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } },
    configurable: true,
  });
  t.after(() => {
    delete globalThis.MediaRecorder;
    delete dom.window.navigator.mediaDevices;
  });
  await open(codexSession());
  await click(await dom.waitFor(() => button("Record a voice memo")));
  await dom.waitFor(() => /microphone/.test($(".as-hint")?.textContent || ""));
  assert.ok(button("Record a voice memo"), "ready to try again");
  assert.deepEqual(dom.errors, []);
});
