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
  const route = `/api/sessions/codex/${CODEX}/queue/q-edit/cancel`;
  routes[route] = () => ({ deleted: true });
  await open(session);
  await dom.waitFor(() => $(".as-queue-row"));
  assert.ok(button("Stop"));
  assert.equal($(".as-scroll .as-queue"), null);
  assert.ok($(".as-composer .as-queue"));
  await click(button("Edit queued message"));
  await dom.waitFor(() => $("textarea").value === "Then test");
  assert.equal($(".as-queue-row"), null);
  assert.deepEqual(dom.errors, []);
  delete routes[route];
});

test("typing prepares the Claude draft without submitting and send waits for it", async (t) => {
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
  const writes = mac.sent.filter((m) => m.route === route || m.route.endsWith("/messages"));
  assert.equal(writes.at(-2).body.text, "hello again");
  assert.ok(writes.at(-1).route.endsWith("/messages"));
  assert.deepEqual(dom.errors, []);
  delete routes[route];
});
const record = (route) => (init) => {
  mac.sent.push({ route, body: init?.body ? JSON.parse(init.body) : null });
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
      "stop",
      "prompts/7",
      "prompts/8",
      "prompts/consent%3Atoolu_1",
    ])
      routes[`/api/sessions/${agent}/${id}/${action}`] = record(
        `/api/sessions/${agent}/${id}/${action}`,
      );
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
  mac.logos = { codex: LOGO, claude: LOGO };
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
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
const click = async (element) => {
  assert.ok(element, "button exists");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const open = async (session, health = signedIn, on = peer) => {
  const view = await mount(
    React.createElement(AgentSessionView, {
      peer: on,
      session,
      siblings: [],
      health,
      logos: { codex: LOGO, claude: LOGO },
      onSelect() {},
      onBack() {},
    }),
  );
  // Legacy protocol tests inspect model/mode controls; the rebuilt UI opens them explicitly.
  await click(button("Chat settings"));
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
      (!status.installed || !status.signedIn || status.usable === false)
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
  assert.equal($(".as-model span").textContent, "Medium");
  assert.equal($(".as-mode").textContent, "Approve for me");
  // ChatGPT's header: round buttons floating over the chat, the title between.
  assert.equal($(".as-title strong").textContent, "Fix login");
  assert.equal($(".as-title small").textContent, "app · Codex app");
  assert.deepEqual(
    $$(".as-bar button").map((b) => b.getAttribute("aria-label")),
    ["Back to all sessions", null, "Switch conversations", "More"],
  );
  assert.ok($(".as-bar img.agent-logo"));
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

test("Claude Code's prompts say what they'd allow; dialogs it can't show go back to the Mac", async () => {
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
    ["Answer on my Mac"],
  );
  await click(
    [...tool.querySelectorAll("button")].find(
      (b) => b.textContent === "Yes, and don't ask again",
    ),
  );
  await click(
    [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "Answer on my Mac",
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
  assert.equal($(".as-hint"), null);
  assert.equal($(".as-model").disabled, true);
  assert.equal($(".as-title small").textContent, "app · Open in Codex app");
  await typeInto($("textarea"), "hi");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/codex/${CODEX}/messages`,
      body: { text: "hi", images: [] },
    },
  ]);
});

test("model and thinking open inline above the composer, never as a popup", async () => {
  await open(codexSession());
  await dom.waitFor(() => $(".as-model") && !$(".as-model").disabled);
  await click($(".as-model"));
  assert.equal($(".as-model").getAttribute("aria-expanded"), "true");
  assert.ok($(".as-composer .as-picker"));
  assert.equal($("[role=dialog]"), null);
  const chip = (label) =>
    $$(".as-picker-row button").find((b) => b.textContent === label);
  assert.equal(chip("GPT-6 Astra").getAttribute("aria-pressed"), "true");
  await click(chip("GPT-6 Sol"));
  // Choosing a model leaves thinking to pick; thinking finishes the choice.
  assert.ok($(".as-picker"));
  assert.deepEqual(
    $$(".as-picker-row[aria-label=Thinking] button").map((b) => b.textContent),
    ["Low", "Medium", "High"],
  );
  await click(chip("High"));
  assert.equal($(".as-picker"), null);
  assert.equal($(".as-model").textContent.trim(), "GPT-6 Sol High");
  await typeInto($("textarea"), "go");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    {
      route: `/api/sessions/codex/${CODEX}/messages`,
      body: { text: "go", images: [], model: "gpt-6-sol", effort: "high" },
    },
  ]);
  assert.deepEqual(dom.errors, []);
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
  // Its card: Reset usage (asks first, spends nothing until confirmed) and Upgrade.
  assert.equal($(".as-banner strong").textContent, "You’re out of Codex usage");
  assert.match(
    $(".as-banner span").textContent,
    /Upgrade or use one of your rate limit resets now\./,
  );
  const upgrade = [...$$(".as-banner a")].find(
    (a) => a.textContent.trim() === "Upgrade",
  );
  assert.equal(
    upgrade.getAttribute("href"),
    "https://chatgpt.com/codex/settings/usage",
  );
  assert.equal(upgrade.getAttribute("target"), "_blank");
  assert.equal(upgrade.getAttribute("rel"), "noopener noreferrer");
  await click(
    [...$$(".as-banner button")].find((b) => b.textContent === "Reset usage"),
  );
  assert.match($(".as-banner-actions span").textContent, /can’t be undone/);
  await click(
    [...$$(".as-banner button")].find((b) => b.textContent === "Cancel"),
  );
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

test("a question Claude asks in the Claude app shows here too, with its choices", async () => {
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
  await open(session);
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
  assert.equal(card.querySelector("button, li, [role=button]"), null);
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
  await dom.waitFor(() => $$(".as-queue-row").length === 2);
  const [first, second] = $$(".as-queue-row");
  assert.equal(first.querySelector("p").textContent, "Run the tests");
  assert.deepEqual(
    [...first.querySelectorAll("small")].map((t) => t.textContent),
    ["1 image"],
  );
  assert.equal(
    second.querySelector("[role=status]").textContent,
    "Claude Code is signed out on your Mac.",
  );
  // Handed over: it leaves the outbox (and shows from the transcript).
  mac.bump({ outbox: [mac.live.outbox[1]] });
  await dom.waitFor(() => $$(".as-queue-row").length === 1);
  assert.deepEqual(dom.errors, []);
});

test("a question asked in the Claude app while this chat is open shows within one refresh, and goes once answered", async () => {
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
  // Claude stops on a question in the app; nothing wakes the live view, the
  // open chat's regular refresh brings it.
  page.session = claudeSession({ status: "waiting", asking });
  await dom.waitFor(() => $(".as-prompt.elsewhere"), 7000);
  assert.match(
    $(".as-hint").textContent,
    /^Claude is waiting for your answer in the Claude app\./,
  );
  page.session = claudeSession({ status: "running" });
  await dom.waitFor(() => !$(".as-prompt.elsewhere"), 7000);
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

test("agent text is shown as text: no markup, no links that navigate", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    {
      id: "a1",
      role: "assistant",
      kind: "text",
      text: 'Try <img src=x onerror="alert(1)"> and **this** or [the docs](https://example.com)\n```\n<script>alert(2)</script>\n```',
    },
  ];
  await open(codexSession());
  await dom.waitFor(() => $(".as-assistant"));
  const message = $(".as-assistant");
  assert.equal(message.querySelector("img, script, a"), null);
  assert.match(message.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.equal(message.querySelector("strong").textContent, "this");
  assert.equal(message.querySelector("u").textContent, "the docs");
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
  await home([codexSession(), claudeSession()]);
  await dom.waitFor(() => $(".chat-card img.agent-logo"));
  assert.equal($(".chat-card img.agent-logo").getAttribute("src"), LOGO);
  await click(button("New chat"));
  assert.equal($$("[role=dialog] .chat-app-rail img.agent-logo").length, 2);
  assert.deepEqual(dom.errors, []);
});

test("upcoming logos stay visible and do not start unsupported sessions", async () => {
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
      { agent: "future-agent", name: "Future app", installed: false, signedIn: false, supported: false },
    ]);
    const names = $$(".chat-app-rail button").map((b) => b.getAttribute("aria-label"));
    for (const name of ["Gemini CLI", "Cursor", "Antigravity", "Future app"])
      assert.ok(names.includes(name), `${name} remains discoverable`);
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
  await home([codexSession()]);
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

test("a new Codex chat starts in the Codex app's own mode, in the most recent folder", async () => {
  await home([codexSession(), claudeSession({ cwd: "/work/site" })]);
  assert.equal($("textarea"), null);
  await click(button("New chat"));
  await click(button("Chat settings"));
  const field = () => $("textarea[aria-label='New Codex chat']");
  assert.equal(dom.document.activeElement, field());
  assert.equal(field().placeholder, "What would you like to work on?");
  // Open, it names the folder it will start in (the most recent one).
  assert.match($(".chat-folder").textContent, /app/);
  await typeInto(field(), "Add tests for login");
  await dom.waitFor(() =>
    $(".as-mode-pick")?.textContent.includes("Approve for me"),
  );
  // Folder and mode open inline, like the model.
  await click($(".chat-folder"));
  assert.deepEqual(
    $$(".as-picker[aria-label=Folder] button").map((b) => b.textContent),
    ["app", "site", "Other…"],
  );
  await click(
    $$(".as-picker[aria-label=Folder] button").find(
      (b) => b.textContent === "app",
    ),
  );
  await click($(".as-mode-pick"));
  // Codex's own menu as it reports it now.
  assert.deepEqual(
    $$(".as-picker-row button").map((b) => b.textContent),
    [
      "Ask for approval",
      "Approve for me",
      "Full access",
      "Read only",
      "Network only",
      "Custom (config.toml)",
    ],
  );
  await click(
    $$(".as-picker-row button").find((b) => b.textContent === "Approve for me"),
  );
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
  await click(button("Chat settings"));
  globalThis.fetch = fetch;
  const field = () => $("textarea[aria-label='New Claude Code chat']");
  assert.equal(field().placeholder, "What would you like to work on?");
  await typeInto(field(), "Plan the API");
  await dom.waitFor(() =>
    $(".chat-model")?.textContent.includes("Default (recommended)"),
  );
  await click($(".as-mode-pick"));
  // Claude Code's own modes, in its order and words, after the settings' default.
  assert.deepEqual(
    $$(".as-picker-row button").map((b) => b.textContent),
    ["Default", "Manual", "Plan", "Accept edits", "Bypass Permissions", "Auto"],
  );
  await click(
    $$(".as-picker-row button").find((b) => b.textContent === "Plan"),
  );
  await click($(".chat-model"));
  await click(
    $$(".as-picker-row button").find((b) => b.textContent === "Fable 5.1"),
  );
  await click(
    $$(".as-picker-row[aria-label=Thinking] button").find(
      (b) => b.textContent === "Max",
    ),
  );
  // A model that doesn't take Auto mode isn't offered it.
  await click($(".as-mode-pick"));
  assert.ok(!$$(".as-picker-row button").some((b) => b.textContent === "Auto"));
  await click(
    $$(".as-picker-row button").find((b) => b.textContent === "Plan"),
  );
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
  assert.deepEqual(buttons(cards[1]), ["Open"]);
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
      (b) => b.textContent === "Open",
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

test("the permission mode changes from the session, in each agent's own terms", async () => {
  await open(codexSession());
  await dom.waitFor(() => $(".as-mode"));
  assert.equal($(".as-mode").textContent, "Approve for me");
  await click($(".as-mode"));
  // What Codex offers now, a profile Reach has no name for included.
  assert.deepEqual(
    $$(".as-picker[aria-label=Permissions] button").map((b) => b.textContent),
    [
      "Ask for approval",
      "Approve for me",
      "Full access",
      "Read only",
      "Network only",
      "Custom (config.toml)",
    ],
  );
  await click(
    $$(".as-picker[aria-label=Permissions] button").find(
      (b) => b.textContent === "Full access",
    ),
  );
  assert.equal($(".as-mode").textContent, "Full access");
  await typeInto($("textarea"), "ship it");
  await click(button("Send"));
  for (const view of views.splice(0)) await view.unmount();
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-mode"));
  await click($(".as-mode"));
  await dom.waitFor(
    () => $$(".as-picker[aria-label=Permissions] button").length === 5,
  );
  assert.deepEqual(
    $$(".as-picker[aria-label=Permissions] button").map((b) => b.textContent),
    ["Manual", "Plan", "Accept edits", "Auto", "delegate"],
  );
  await click(
    $$(".as-picker[aria-label=Permissions] button").find(
      (b) => b.textContent === "Plan",
    ),
  );
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
    ["Back to all sessions", null, "Switch conversations", "New chat", "More"],
  );
  assert.ok($(".as-bar .as-bar-pill [aria-label='New chat']"));
  assert.ok($(".as-bar img.agent-logo"));
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

test("Claude's greeting follows the moment", async () => {
  const { greeting } = await dom.load("/src/EverythingChat.tsx");
  assert.equal(greeting(new Date(2026, 9, 5, 9)), "New week", "Monday morning");
  assert.equal(greeting(new Date(2026, 9, 6, 9)), "Good morning");
  assert.equal(greeting(new Date(2026, 9, 6, 14)), "Good afternoon");
  assert.equal(greeting(new Date(2026, 9, 6, 21)), "Good evening");
  assert.equal(greeting(new Date(2026, 9, 6, 2)), "Good evening");
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

test("on a Windows computer, a Claude Code session says computer, never Mac", async () => {
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
    "Waiting for your answer in the terminal on your computer",
  );
  assert.equal(
    $(".as-hint").textContent,
    "Running in a terminal on your computer. Reply there or from the Terminal tab.",
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
    "Open in another Claude Code process on your computer.",
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
    "Claude will work in these apps in the background while you keep using your computer.",
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
    ["Answer on my computer"],
  );
  assert.deepEqual(saidMac(), []);
  assert.deepEqual(dom.errors, []);
});

test("on a Windows computer, a Codex session says computer: signed out, sent to the app, opened in the app", async () => {
  await open(
    codexSession(),
    [{ agent: "codex", installed: true, signedIn: false }],
    pc,
  );
  await dom.waitFor(() => $(".access"));
  assert.equal(
    $(".as-hint").textContent,
    "Codex is signed out on your computer.",
  );
  assert.equal(
    $(".access").getAttribute("aria-label"),
    "Sign-ins on your computer",
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
  // Opened in the app from the title's details.
  await click($(".as-title"));
  await click($(".as-details-open"));
  await dom.waitFor(() => $(".as-hint")?.textContent.startsWith("Opened"));
  assert.equal(
    $(".as-hint").textContent,
    "Opened in the Codex app on your computer.",
  );
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
  assert.match($(".chat-status").textContent, /computer/);
  assert.doesNotMatch($(".chat-status").textContent, /Mac/);
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

test("settings stay out of the conversation until opened", async () => {
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
  assert.equal($(".as-mode"), null);
  assert.equal($(".as-model"), null);
  await click(button("Chat settings"));
  await dom.waitFor(() => $(".as-model"));
  assert.equal($(".as-mode").textContent, "Approve for me");
  await click(button("Chat settings"));
  assert.equal($(".as-mode"), null);
  assert.deepEqual(dom.errors, []);
});

test("the conversation switcher stays within an app and separate app drafts survive navigation", async () => {
  const seen = [];
  let view = await mount(
    React.createElement(AgentSessionView, {
      peer,
      session: codexSession(),
      siblings: [codexSession(), codexSession({ id: NEW, title: "Add tests" }), claudeSession()],
      health: signedIn,
      onSelect(s) {
        seen.push(s.agent + ":" + s.id);
      },
      onBack() {},
    }),
  );
  await typeInto($("textarea"), "Keep the Codex draft");
  await click(button("Switch conversations"));
  assert.equal(
    $("[role=dialog]").getAttribute("aria-label"),
    "Switch conversation",
  );
  assert.equal($(".chat-card[aria-label='Refactor auth, Claude Code']"), null);
  assert.equal($$(".chat-card").length, 2);
  await click($(".chat-card[aria-label='Add tests, Codex']"));
  assert.deepEqual(seen, ["codex:" + NEW]);
  assert.equal($("[role=dialog]"), null);
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
  await click($(".as-review-toggle"));
  assert.equal($(".as-review-body").hidden, true);
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
