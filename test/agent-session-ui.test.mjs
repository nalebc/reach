import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// The Chat screens through the real components (src/EverythingChat.tsx, the
// Chat home; src/AgentSession.tsx, one session). The computer is a stand-in
// that records what the phone sent; each test checks the exact requests and
// that React rendered without warnings.

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
  live: { where: "claude-app", pid: 10, tty: null },
  ...extra,
});
const idleLive = () => ({ version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 });
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
      [`codex:${NEW}`]: { session: codexSession({ id: NEW, title: "Add tests for login" }), items: [] },
      [`claude:${NEW}`]: { session: claudeSession({ id: NEW, title: "Plan the API", live: undefined }), items: [] },
    };
    this.live = idleLive();
    this.signIn = { state: "idle", url: null, code: null, error: null };
  },
  // A change the long poll reports: the screen reloads the transcript.
  bump(change = {}) {
    this.live = { ...this.live, ...change, version: this.live.version + 1, items: this.live.items + 1 };
  },
};
const SIGN_IN_URL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
const record = (route) => (init) => {
  mac.sent.push({ route, body: init?.body ? JSON.parse(init.body) : null });
  return route.endsWith("/messages") ? { turnId: "turn-1" } : route === "/api/sessions" ? { threadId: NEW, turnId: null } : { ok: true };
};
const routes = {
  "/api/sessions/models": () => ({
    models: [
      { id: "gpt-6-astra", name: "GPT-6 Astra", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", images: true, isDefault: true },
      { id: "gpt-6-sol", name: "GPT-6 Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium", images: true, isDefault: false },
    ],
    mode: "guardian-approvals",
  }),
  "/api/sessions/health": () => ({ agents: [] }),
  "/api/sessions/logos": () => ({ version: "v1", logos: mac.logos }),
  "/api/sessions/commands": () => ({
    commands: [
      { name: "compact", description: "Free up context by summarizing the conversation so far", hint: "<instructions>" },
      { name: "context", description: "Show current context usage", hint: "" },
      { name: "init", description: "Initialize a new CLAUDE.md file", hint: "" },
    ],
  }),
  "/api/sessions": (init) => (init?.method === "POST" ? record("/api/sessions")(init) : { sessions: [], errors: {} }),
  "/api/sessions/sign-in": (init) => {
    const method = init?.method || "GET";
    if (method !== "GET") mac.sent.push({ route: `${method} /api/sessions/sign-in`, body: init?.body ? JSON.parse(init.body) : null });
    if (method === "POST") {
      const { agent } = JSON.parse(init.body);
      mac.signIn =
        agent === "claude"
          ? { agent, state: "link", url: SIGN_IN_URL, code: null, error: null }
          : { agent, state: "link", url: "https://auth.example/codex/device", code: "ABCD-1234", error: null };
    }
    if (method === "DELETE") mac.signIn = { ...mac.signIn, state: "cancelled" };
    return mac.signIn;
  },
  "/api/sessions/sign-in/code": (init) => {
    mac.sent.push({ route: "POST /api/sessions/sign-in/code", body: JSON.parse(init.body) });
    mac.signIn = { ...mac.signIn, state: "checking" };
    return mac.signIn;
  },
};
for (const agent of ["codex", "claude"])
  for (const id of [CODEX, CLAUDE, NEW]) {
    routes[`/api/sessions/${agent}/${id}`] = () => mac.pages[`${agent}:${id}`];
    // The real server holds this request until something changes.
    routes[`/api/sessions/${agent}/${id}/live`] = async () => (await settle(60), mac.live);
    for (const action of ["messages", "stop", "prompts/7", "prompts/8"])
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
  mac.logos = { codex: LOGO, claude: LOGO };
  dom.window.localStorage.clear();
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
  $$("button").find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const click = async (element) => {
  assert.ok(element, "button exists");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const open = (session, health = signedIn) =>
  mount(
    React.createElement(AgentSessionView, {
      peer,
      session,
      siblings: [],
      health,
      logos: { codex: LOGO, claude: LOGO },
      onSelect() {},
      onBack() {},
    }),
  );
const home = (sessions, health = signedIn, extra = {}) =>
  mount(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions, errors: {}, health, failure: "", reload: async () => {}, recheck: () => {}, ...extra },
    }),
  );
const radio = (name) => $$(".agent-picker [role=radio]").find((b) => b.getAttribute("aria-label") === name);

test("a Codex chat reads like the Codex app", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    { id: "u1", role: "user", kind: "text", text: "Fix the login bug", turnId: "t1" },
    { id: "f1", role: "tool", kind: "file-change", text: "src/App.tsx", detail: "@@\n+a\n-b\n+c", status: "completed", turnId: "t1" },
    { id: "c1", role: "tool", kind: "command", text: "npm test", detail: "ok", status: "completed", turnId: "t1" },
    { id: "a1", role: "assistant", kind: "text", text: "Done. `npm test` passes.\n\n- one\n- two", turnId: "t1" },
    { id: "t1:error", role: "system", kind: "error", text: "You've hit your usage limit.", detail: "usageLimitExceeded", turnId: "t1" },
  ];
  await open(codexSession());
  await dom.waitFor(() => $(".as-user"));
  assert.equal($(".as-user").textContent, "Fix the login bug");
  assert.equal($(".as-run-head span").textContent, "Edited App.tsx, ran a command");
  assert.deepEqual($$(".as-run-head b").map((b) => b.textContent), ["+2", "-1"]);
  assert.equal($(".as-assistant code").textContent, "npm test");
  assert.deepEqual($$(".as-assistant li").map((li) => li.textContent), ["one", "two"]);
  assert.equal($(".as-error.codex").textContent.trim(), "You've hit your usage limit.");
  assert.equal($("textarea").placeholder, "Do anything");
  await dom.waitFor(() => $(".as-model")?.textContent.includes("GPT-6 Astra"));
  assert.equal($(".as-model span").textContent, "Medium");
  assert.equal($(".as-mode").textContent, "Approve for me");
  // A quiet header: the title, where it lives, and the app's own icon.
  assert.equal($(".as-title strong").textContent, "Fix login");
  assert.equal($(".as-title small").textContent, "app · Codex app");
  assert.equal($(".as-bar img.agent-logo").getAttribute("alt"), "Codex");
  assert.deepEqual(dom.errors, []);
});

test("a sent message shows until the transcript has it, even when it repeats an earlier one", async () => {
  // "continue" was already sent once; the old screen dropped the new bubble at once.
  const items = mac.pages[`codex:${CODEX}`].items;
  items.push({ id: "u1", role: "user", kind: "text", text: "continue", turnId: "t1" });
  await open(codexSession());
  await dom.waitFor(() => $(".as-user"));
  await typeInto($("textarea"), "continue");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/codex/${CODEX}/messages`, body: { text: "continue", images: [] } },
  ]);
  assert.equal($("textarea").value, "");
  assert.equal($$(".as-user.pending").length, 1);
  // The transcript reloads without the new message yet: still pending.
  mac.bump();
  await settle(250);
  assert.equal($$(".as-user.pending").length, 1);
  // Now it's there: the pending copy goes away and nothing is doubled.
  items.push({ id: "u2", role: "user", kind: "text", text: "continue", turnId: "t2" });
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
        questions: [{ id: "q", header: "Deploy", question: "Which target?", options: [{ label: "staging", description: "" }], other: false, secret: false }],
      },
    ],
  };
  await open(codexSession());
  await dom.waitFor(() => $$(".as-prompt").length === 2);
  const [command, question] = $$(".as-prompt");
  assert.equal(command.querySelector("strong").textContent, "Run this command?");
  assert.equal(command.querySelector(".as-prompt-command").textContent, "rm -rf build");
  assert.deepEqual(
    [...command.querySelectorAll(".as-prompt-actions button")].map((b) => b.textContent),
    ["Yes", "Yes, for this session", "No", "No, and stop"],
  );
  // While Codex waits on you, nothing says it's working.
  assert.equal($(".as-working"), null);
  await click([...command.querySelectorAll("button")].find((b) => b.textContent === "Yes"));
  const answer = [...question.querySelectorAll("button")].find((b) => b.textContent === "Answer");
  assert.equal(answer.disabled, true);
  await click([...question.querySelectorAll(".as-choices button")][0]);
  await click(answer);
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/codex/${CODEX}/prompts/7`, body: { decision: "accept" } },
    { route: `/api/sessions/codex/${CODEX}/prompts/8`, body: { answers: { q: ["staging"] } } },
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
      { id: "7", kind: "tool", tool: "Bash", title: "Delete the build folder", command: "rm -rf build", reason: "", decisions: ["allow", "allowAlways", "deny"] },
      { id: "8", kind: "dialog", title: "Claude Code needs your answer on your Mac", decisions: ["cancel"] },
    ],
  };
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $$(".as-prompt").length === 2);
  const [tool, dialog] = $$(".as-prompt");
  assert.deepEqual(
    [...tool.querySelectorAll(".as-prompt-actions button")].map((b) => b.textContent),
    ["Yes", "Yes, and don't ask again", "No"],
  );
  assert.deepEqual([...dialog.querySelectorAll(".as-prompt-actions button")].map((b) => b.textContent), ["Answer on my Mac"]);
  await click([...tool.querySelectorAll("button")].find((b) => b.textContent === "Yes, and don't ask again"));
  await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Answer on my Mac"));
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/claude/${CLAUDE}/prompts/7`, body: { decision: "allowAlways" } },
    { route: `/api/sessions/claude/${CLAUDE}/prompts/8`, body: { decision: "cancel" } },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("while Codex works, the send button stops it; typing turns it back into Send", async () => {
  mac.live = { ...idleLive(), version: 3, status: "running", activity: "Running npm test", streaming: "Looking at" };
  await open(codexSession());
  await dom.waitFor(() => button("Stop"));
  assert.equal($(".as-working span").textContent, "Running npm test");
  assert.equal($(".as-assistant.streaming").textContent, "Looking at");
  await click(button("Stop"));
  assert.deepEqual(mac.sent, [{ route: `/api/sessions/codex/${CODEX}/stop`, body: {} }]);
  await typeInto($("textarea"), "also check signup");
  assert.equal(button("Stop"), undefined);
  assert.ok(button("Send"));
  assert.deepEqual(dom.errors, []);
});

test("a chat open in the Codex app says so and keeps the app's settings", async () => {
  mac.pages[`codex:${CODEX}`].session = codexSession({ held: "codex-app" });
  await open(codexSession({ held: "codex-app" }));
  await dom.waitFor(() => $(".as-hint"));
  assert.match($(".as-hint").textContent, /open in the Codex app on your Mac.*approvals show on your Mac/);
  await dom.waitFor(() => $(".as-model")?.textContent.includes("GPT-6 Astra"));
  assert.equal($(".as-model").disabled, true);
  assert.equal($(".as-title small").textContent, "app · Open in Codex app");
  await typeInto($("textarea"), "hi");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [{ route: `/api/sessions/codex/${CODEX}/messages`, body: { text: "hi", images: [] } }]);
});

test("model and thinking open inline above the composer, never as a popup", async () => {
  await open(codexSession());
  await dom.waitFor(() => $(".as-model") && !$(".as-model").disabled);
  await click($(".as-model"));
  assert.equal($(".as-model").getAttribute("aria-expanded"), "true");
  assert.ok($(".as-composer .as-picker"));
  assert.equal($("[role=dialog]"), null);
  const chip = (label) => $$(".as-picker-row button").find((b) => b.textContent === label);
  assert.equal(chip("GPT-6 Astra").getAttribute("aria-pressed"), "true");
  await click(chip("GPT-6 Sol"));
  // Choosing a model leaves thinking to pick; thinking finishes the choice.
  assert.ok($(".as-picker"));
  assert.deepEqual($$(".as-picker-row[aria-label=Thinking] button").map((b) => b.textContent), ["Low", "Medium", "High"]);
  await click(chip("High"));
  assert.equal($(".as-picker"), null);
  assert.equal($(".as-model").textContent.trim(), "GPT-6 Sol High");
  await typeInto($("textarea"), "go");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/codex/${CODEX}/messages`, body: { text: "go", images: [], model: "gpt-6-sol", effort: "high" } },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("a Claude Code chat reads like Claude Code; one open in the Claude app still takes a reply", async () => {
  mac.pages[`claude:${CLAUDE}`].items = [
    { id: "u1", role: "user", kind: "text", text: "Refactor the auth module" },
    { id: "e1", role: "system", kind: "error", text: "Failed to authenticate: OAuth session expired", detail: "authentication_failed" },
  ];
  await open(claudeSession(), [{ agent: "claude", installed: true, signedIn: false }]);
  await dom.waitFor(() => $(".as-error.claude"));
  assert.ok($(".as-page.claude"));
  assert.equal($(".as-error.claude header").textContent.trim(), "Authentication failed");
  assert.equal($(".as-error.claude p").textContent, "Failed to authenticate: OAuth session expired");
  // It lives in the Claude app: say what sending does; writing stays on.
  assert.equal(
    $(".as-hint").textContent,
    "Same session as in the Claude app: what you send here is there too.",
  );
  assert.equal(button("Sign in"), undefined);
  assert.equal($("textarea").disabled, false);
  assert.equal($(".as-mode").textContent, "Auto");
  assert.equal($(".as-model").textContent.trim(), "Opus 5.5 Max");
  await typeInto($("textarea"), "keep going");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [{ route: `/api/sessions/claude/${CLAUDE}/messages`, body: { text: "keep going", images: [] } }]);
  assert.equal($(".as-title small").textContent, "app · Claude app");
  assert.deepEqual(dom.errors, []);
});

test("a Claude Code session nobody else holds takes replies from here once signed in", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $("textarea") && !$("textarea").disabled);
  assert.equal($(".as-hint"), null);
  assert.equal($("textarea").placeholder, "Type / for commands");
  await typeInto($("textarea"), "Refactor the auth module");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/claude/${CLAUDE}/messages`, body: { text: "Refactor the auth module", images: [] } },
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
  assert.equal(message.querySelector("pre code").textContent, "<script>alert(2)</script>");
});

test("a failed send keeps the message and says why", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).endsWith("/messages")
      ? new Response(JSON.stringify({ error: "Another Codex window has this chat open." }), { status: 409 })
      : fetch(url, init);
  try {
    await open(codexSession());
    await dom.waitFor(() => $(".as-scroll") && !$(".as-note"));
    await typeInto($("textarea"), "please retry");
    await click(button("Send"));
    await dom.waitFor(() => $(".as-hint.bad"));
    assert.equal($(".as-hint.bad").textContent, "Another Codex window has this chat open.");
    assert.equal($("textarea").value, "please retry");
    assert.equal($$(".as-user.pending").length, 0);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("the switch picks the agent, re-skins the page and remembers the choice", async () => {
  const sessions = [codexSession(), claudeSession({ status: "waiting" })];
  const first = await home(sessions);
  assert.ok($(".chat-home.codex"));
  assert.equal(radio("Codex").getAttribute("aria-checked"), "true");
  assert.equal(radio("Codex").querySelector("b").textContent, "Codex");
  assert.equal(radio("Claude Code").querySelector("b"), null);
  // Only this agent's sessions, listed like its app.
  assert.deepEqual($$(".chat-session strong").map((s) => s.textContent), ["Fix login"]);
  // Claude Code is waiting for you over there.
  assert.equal(radio("Claude Code").querySelector(".agent-switch-badge").textContent, "1");
  let told = 0;
  const tell = () => told++;
  dom.window.addEventListener("reach-chat-agent", tell);
  await click(radio("Claude Code"));
  dom.window.removeEventListener("reach-chat-agent", tell);
  // The tab bar hears about it (its icon is the chosen agent's logo).
  assert.equal(told, 1);
  assert.ok($(".chat-home.claude"));
  assert.ok($(".agent-picker.from-left"));
  assert.equal(radio("Claude Code").getAttribute("aria-checked"), "true");
  assert.equal($(".agent-switch-badge"), null);
  assert.deepEqual($$(".chat-session strong").map((s) => s.textContent), ["Refactor auth"]);
  assert.equal($(".chat-session small").textContent, "Waiting for you");
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "claude");
  await first.unmount();
  views.splice(0);
  await home(sessions);
  assert.ok($(".chat-home.claude"));
  assert.deepEqual(dom.errors, []);
});

test("the agents' real logos show, and their names when an app isn't installed", async () => {
  await home([codexSession()]);
  await dom.waitFor(() => $(".agent-picker [aria-checked=true] img.agent-logo"));
  assert.equal($(".agent-picker [aria-checked=true] img.agent-logo").getAttribute("src"), LOGO);
  for (const view of views.splice(0)) await view.unmount();
  // Another Mac without the apps: no request fails, the names stand in.
  mac.logos = {};
  await mount(
    React.createElement(EverythingChat, {
      peer: { ...peer, id: "other-mac" },
      feed: { sessions: [], errors: {}, health: signedIn, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
  await settle(50);
  const mark = $(".agent-picker [aria-checked=true] .agent-logo.text");
  assert.ok(mark);
  assert.equal(mark.getAttribute("aria-label"), "Codex");
  assert.deepEqual(dom.errors, []);
});

test("a new Codex chat starts in the Codex app's own mode, in the most recent folder", async () => {
  await home([codexSession(), claudeSession({ cwd: "/work/site" })]);
  const field = () => $("textarea[aria-label='New Codex chat']");
  assert.equal(field().placeholder, "Do anything");
  assert.equal($(".chat-new-where").textContent, "in app");
  await typeInto(field(), "Add tests for login");
  await dom.waitFor(() => $(".as-mode-pick")?.textContent.includes("Approve for me"));
  // Folder and mode open inline, like the model.
  await click($(".chat-folder"));
  assert.deepEqual($$(".as-picker[aria-label=Folder] button").map((b) => b.textContent), ["app", "site", "Other…"]);
  await click($$(".as-picker[aria-label=Folder] button").find((b) => b.textContent === "app"));
  await click($(".as-mode-pick"));
  assert.deepEqual($$(".as-picker-row button").map((b) => b.textContent), [
    "Ask for approval",
    "Approve for me",
    "Full access",
    "Custom (config.toml)",
  ]);
  await click($$(".as-picker-row button").find((b) => b.textContent === "Approve for me"));
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
  await dom.waitFor(() => $(".as-title strong")?.textContent === "Add tests for login");
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
              { id: "default", name: "Default (recommended)", efforts: ["low", "high", "max"], defaultEffort: null, images: true, isDefault: true },
              { id: "claude-fable-5-1[1m]", name: "Fable 5.1", efforts: ["low", "high", "max"], defaultEffort: null, images: true, isDefault: false },
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
      feed: { sessions: [claudeSession({ live: undefined })], errors: {}, health: signedIn, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
  globalThis.fetch = fetch;
  const field = () => $("textarea[aria-label='New Claude Code chat']");
  assert.equal(field().placeholder, "Type / for commands");
  await typeInto(field(), "Plan the API");
  await click($(".as-mode-pick"));
  assert.deepEqual($$(".as-picker-row button").map((b) => b.textContent), ["Default", "Auto", "Manual", "Accept edits", "Plan"]);
  await click($$(".as-picker-row button").find((b) => b.textContent === "Plan"));
  await dom.waitFor(() => $(".chat-model")?.textContent.includes("Default (recommended)"));
  await click($(".chat-model"));
  await click($$(".as-picker-row button").find((b) => b.textContent === "Fable 5.1"));
  await click($$(".as-picker-row[aria-label=Thinking] button").find((b) => b.textContent === "Max"));
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
      feed: { sessions: [codexSession(), claudeSession()], errors: {}, health: signedIn, failure: "", reload: async () => {}, recheck: () => {} },
      target: { agent: "claude", id: CLAUDE },
      onTargetOpened: () => opened++,
    }),
  );
  await dom.waitFor(() => $(".as-page.claude"));
  assert.equal($(".as-title strong").textContent, "Refactor auth");
  assert.equal(opened, 1);
  assert.equal(dom.window.localStorage.getItem("reach.chatAgent"), "claude");
});

test("Claude Code signs in from Chat: the page opens here, the code goes to the Mac", async () => {
  let rechecked = 0;
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  await home([], [{ agent: "claude", installed: true, signedIn: false }], { recheck: () => rechecked++ });
  assert.equal($(".chat-status.signed-out span").textContent, "Claude Code is signed out on your Mac.");
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
  await dom.waitFor(() => $(".sign-in")?.textContent.includes("Claude Code is signed in on your Mac."), 4000);
  // The status refresh runs just after that paints.
  await dom.waitFor(() => rechecked === 1);
  assert.deepEqual(mac.sent, [
    { route: "POST /api/sessions/sign-in", body: { agent: "claude" } },
    { route: "POST /api/sessions/sign-in/code", body: { agent: "claude", code: "C-123#abc" } },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("Codex signs in with a one-time code and finishes by itself", async () => {
  let rechecked = 0;
  await home([], [{ agent: "codex", installed: true, signedIn: false }], { recheck: () => rechecked++ });
  await click(button("Sign in"));
  await dom.waitFor(() => $(".sign-in-device"));
  assert.equal($(".sign-in-device").textContent, "ABCD-1234");
  assert.equal($(".sign-in-open").getAttribute("href"), "https://auth.example/codex/device");
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
  await dom.waitFor(() => $(".as-hint"));
  assert.equal($(".as-hint").textContent, "Claude Code is signed out on your Mac. Sign in to reply from here.");
  assert.ok(button("Sign in"));
  for (const view of views.splice(0)) await view.unmount();
  // Open in the Claude app: that is what holds it, not the sign-in.
  mac.pages[`claude:${CLAUDE}`].session = claudeSession();
  await open(claudeSession(), signedOut);
  await dom.waitFor(() => $(".as-hint"));
  assert.equal(button("Sign in"), undefined);
});

test("swiping flips to the next session, but scrolling sideways through code doesn't", async () => {
  mac.pages[`codex:${CODEX}`].items = [
    { id: "a1", role: "assistant", kind: "text", text: "Here:\n```\nnpm run build -- --verbose --watch --profile\n```" },
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
      Object.defineProperty(event, type === "touchend" ? "changedTouches" : "touches", { value: point });
      if (type === "touchend") Object.defineProperty(event, "touches", { value: [] });
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
  assert.deepEqual(picked, [NEW]);
  // The first session has nothing before it.
  swipe($(".as-assistant p"), 120);
  await settle();
  assert.deepEqual(picked, [NEW]);
});

test("agents Reach doesn't drive yet get their place in the picker", async () => {
  const health = [...signedIn, { agent: "gemini", name: "Gemini CLI", installed: true, signedIn: false, supported: false }];
  await home([codexSession()], health);
  assert.deepEqual(
    $$(".agent-picker [role=radio]").map((b) => [b.getAttribute("aria-label"), b.classList.contains("soon")]),
    [
      ["Codex", false],
      ["Claude Code", false],
      ["Gemini CLI", true],
    ],
  );
  // No logo for it on the Mac: its initials stand in.
  assert.equal(radio("Gemini CLI").querySelector(".agent-logo.text").textContent, "Ge");
  await click(radio("Gemini CLI"));
  assert.match($(".chat-soon").textContent, /Gemini CLI is on your Mac/);
  assert.equal($("textarea"), null);
  assert.deepEqual(dom.errors, []);
});

test("the permission mode changes from the session, in each agent's own terms", async () => {
  await open(codexSession());
  await dom.waitFor(() => $(".as-mode"));
  assert.equal($(".as-mode").textContent, "Approve for me");
  await click($(".as-mode"));
  assert.deepEqual($$(".as-picker[aria-label=Permissions] button").map((b) => b.textContent), [
    "Ask for approval",
    "Approve for me",
    "Full access",
    "Read only",
  ]);
  await click($$(".as-picker[aria-label=Permissions] button").find((b) => b.textContent === "Full access"));
  assert.equal($(".as-mode").textContent, "Full access");
  await typeInto($("textarea"), "ship it");
  await click(button("Send"));
  for (const view of views.splice(0)) await view.unmount();
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $(".as-mode"));
  await click($(".as-mode"));
  assert.deepEqual($$(".as-picker[aria-label=Permissions] button").map((b) => b.textContent), ["Auto", "Manual", "Accept edits", "Plan"]);
  await click($$(".as-picker[aria-label=Permissions] button").find((b) => b.textContent === "Plan"));
  await typeInto($("textarea"), "think first");
  await click(button("Send"));
  assert.deepEqual(mac.sent, [
    { route: `/api/sessions/codex/${CODEX}/messages`, body: { text: "ship it", images: [], mode: "full-access" } },
    { route: `/api/sessions/claude/${CLAUDE}/messages`, body: { text: "think first", images: [], mode: "plan" } },
  ]);
  assert.deepEqual(dom.errors, []);
});

test("typing / in a Claude Code session offers its commands", async () => {
  mac.pages[`claude:${CLAUDE}`].session = claudeSession({ live: undefined });
  await open(claudeSession({ live: undefined }));
  await dom.waitFor(() => $("textarea"));
  await typeInto($("textarea"), "/co");
  await dom.waitFor(() => $(".as-commands"));
  assert.deepEqual($$(".as-commands b").map((b) => b.textContent), ["/compact", "/context"]);
  await click($$(".as-commands button")[0]);
  assert.equal($("textarea").value, "/compact ");
  assert.equal($(".as-commands"), null);
  assert.deepEqual(dom.errors, []);
});
