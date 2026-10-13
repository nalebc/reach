import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peer = {
  id: "mac",
  name: "Home Mac",
  platform: "darwin",
  url: "https://reach.test",
  token: "test",
};
const health = ["codex", "claude", "openclaw"].map((agent) => ({
  agent,
  // As the Mac names it (server/agent-sessions KNOWN_AGENTS).
  ...(agent === "openclaw" && { name: "OpenClaw" }),
  installed: true,
  signedIn: true,
  supported: true,
}));
const session = (agent, id, extra = {}) => ({
  agent,
  id,
  title: `${agent} ${id}`,
  cwd: "/work/reach",
  branch: "main",
  origin: "app",
  inApp: true,
  status: "idle",
  archived: false,
  preview: "",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...extra,
});
const notification = (agent, id, extra = {}) => ({
  id: `chat:${agent}:${id}`,
  source: agent,
  icon: agent,
  title: "Permission needed",
  target: { page: "sessions", agent, id },
  ...extra,
});
let dom,
  React,
  EverythingChat,
  NotificationCenter,
  NeedsYouStrip,
  agentNeeds,
  view,
  items,
  calls,
  stale;
const routes = {
  "/api/push": () => ({ key: "test" }),
  "/api/notifications": () => ({ items, unavailable: [] }),
  "/api/sessions/openclaw/overview": () => ({
    connected: true,
    sessions: [],
    approvals: [],
    version: null,
  }),
};
before(async () => {
  dom = await startDom({ routes });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
  ({ NotificationCenter } = await dom.load("/src/Notifications.tsx"));
  ({ NeedsYouStrip, agentNeeds } = await dom.load("/src/NeedsYou.tsx"));
  const fetch = globalThis.fetch;
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === "POST") {
      calls.push({ path, body: JSON.parse(init.body) });
      if (path.endsWith("/actions")) {
        if (stale)
          return Response.json(
            { error: "This request changed. Refresh before answering." },
            { status: 409 },
          );
        items = [];
        return Response.json({ ok: true });
      }
    }
    return fetch(url, init);
  };
});
beforeEach(() => {
  dom.window.localStorage.clear();
  // Each app's own list, Codex first (Chat itself starts on All until an app is picked).
  dom.window.localStorage.setItem("reach.chatAgent", "codex");
  items = [];
  calls = [];
  stale = false;
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  assert.deepEqual(dom.errors, []);
});
after(() => dom?.close());

async function mount(
  sessions,
  { enabled = true, chatPeer = peer, onOpen = () => {} } = {},
) {
  let setSessions, setChanges;
  function Workspace() {
    const [current, update] = React.useState(sessions);
    const [changes, change] = React.useState("initial");
    setSessions = update;
    setChanges = change;
    return React.createElement(
      NotificationCenter,
      { peer, enabled, changes, onOpen },
      React.createElement(EverythingChat, {
        peer: chatPeer,
        feed: {
          sessions: current,
          health,
          errors: {},
          failure: "",
          macPrompts: [],
          reload: async () => {},
          recheck() {},
        },
      }),
    );
  }
  view = await dom.render(React.createElement(Workspace));
  await settle(60);
  return {
    sessions: (next) => dom.update(() => setSessions(next)),
    changes: (next) => dom.update(() => setChanges(next)),
  };
}
const $ = (selector) => view.container.querySelector(selector);
const attention = (agent) =>
  $(`.chat-app-attention button[aria-label^="${agent}"]`);
const mobileApp = (name) => $(`.chat-mobile-app-menu [aria-label="${name}"]`);
const openAppMenu = async () => {
  $(".chat-app-current").click();
  await settle();
};
const bell = () => $(".chat-mobile-tools .notification-bell");

test("incoming requests highlight the phone app picker and other app shortcut without mixing chats or answering", async () => {
  const codex = session("codex", "current");
  const feed = await mount([codex]);
  assert.equal(attention("Claude Code"), null);
  const claude = session("claude", "old", {
    status: "waiting",
    updatedAt: Date.now() - 86400000,
    prompts: [
      {
        id: "command",
        kind: "tool",
        title: "Run checks?",
        decisions: ["allow", "deny"],
      },
      { id: "question", kind: "question", title: "Which option?" },
    ],
  });
  feed.sessions([
    codex,
    claude,
    session("claude", "archived", { archived: true, status: "waiting" }),
  ]);
  await settle();
  assert.equal(
    attention("Claude Code").querySelector(".chat-attention-count").textContent,
    "2",
  );
  assert.equal($(".chat-card[aria-label='claude old, Claude Code']"), null);
  await openAppMenu();
  assert.equal(
    mobileApp("Claude Code").getAttribute("aria-description"),
    "2 requests need you",
  );
  assert.ok(mobileApp("Claude Code").classList.contains("has-pending"));
  assert.equal(
    mobileApp("Claude Code").querySelector(".chat-attention-count").textContent,
    "2",
  );
  mobileApp("Claude Code").click();
  await settle();
  assert.equal(
    $(".chat-app-current").getAttribute("aria-description"),
    "2 requests need you",
  );
  assert.ok($(".chat-card[aria-label='claude old, Claude Code']"));
  assert.equal($(".chat-card[aria-label='codex current, Codex']"), null);
  assert.deepEqual(calls, [], "choosing an app never approves a permission");
  assert.ok($(".chat-review-link, .chat-needs-row"));
  feed.sessions([codex, { ...claude, status: "idle", prompts: [] }]);
  await settle();
  assert.equal($(".chat-app-current .chat-attention-count"), null);
  assert.equal($(".chat-review-link, .chat-needs-row"), null);
  assert.equal(
    $(".chat-app-rail [aria-label='Claude Code'] .chat-app-pending"),
    null,
  );
});

test("the global inbox counts background OpenClaw requests and opens the exact chat from the phone bell", async () => {
  items = [
    notification("openclaw", "agent:main:whatsapp:group:123", {
      id: "openclaw:approval-1",
      title: "OpenClaw needs your approval",
    }),
  ];
  let opened;
  await mount([session("codex", "current")], {
    onOpen: (item) => {
      opened = item.target;
    },
  });
  assert.equal(
    attention("OpenClaw").querySelector(".chat-attention-count").textContent,
    "1",
  );
  assert.match(bell().getAttribute("aria-label"), /1 need your attention/);
  await openAppMenu();
  assert.equal(
    mobileApp("OpenClaw").getAttribute("aria-description"),
    "1 request needs you",
  );
  $(".chat-app-current").click();
  await settle();
  bell().click();
  await dom.waitFor(() => $(".notification-card"));
  const open = [...$(".notification-card").querySelectorAll("button")].find(
    (button) => button.textContent.includes("Open request"),
  );
  open.click();
  await settle();
  assert.deepEqual(opened, {
    page: "sessions",
    agent: "openclaw",
    id: "agent:main:whatsapp:group:123",
  });
  assert.deepEqual(calls, []);
});

test("a request represented in both live feeds counts once, and an inbox wake clears resolved background badges", async () => {
  const claude = session("claude", "native", { status: "waiting" });
  items = [notification("claude", "native")];
  const feed = await mount([session("codex", "current"), claude]);
  assert.equal(
    attention("Claude Code").querySelector(".chat-attention-count").textContent,
    "1",
  );
  feed.sessions([session("codex", "current"), { ...claude, status: "idle" }]);
  items = [];
  feed.changes("resolved");
  await dom.waitFor(() => !attention("Claude Code"));
  assert.equal($(".notification-count"), null);
});

test("Codex stays highlighted while browsing OpenClaw, and double tapping Allow once sends the exact revision once", async () => {
  const id = "chat:codex:current:prompt:command";
  const revision = "a".repeat(64);
  items = [
    notification("codex", "current", {
      id,
      revision,
      kind: "command",
      title: "Run this command?",
      prompt: { command: "npm test", cwd: "/work/reach" },
      actions: [{ id: "approve", label: "Allow once", tone: "primary" }],
      target: {
        page: "sessions",
        agent: "codex",
        id: "current",
        prompt: "command",
      },
    }),
  ];
  // Use the actual app menu so this also covers the transition to OpenClaw.
  await mount([session("codex", "current")]);
  await openAppMenu();
  mobileApp("OpenClaw").click();
  await settle();
  assert.ok($(".claw-library"));
  assert.equal(
    attention("Codex").querySelector(".chat-attention-count").textContent,
    "1",
  );
  assert.deepEqual(calls, []);
  bell().click();
  await dom.waitFor(() => $(".notification-card"));
  const allow = [...$(".notification-card").querySelectorAll("button")].find(
    (button) => button.textContent === "Allow once",
  );
  allow.click();
  allow.click();
  await dom.waitFor(() => view.container.textContent.includes("Allowed once"));
  assert.deepEqual(calls, [
    {
      path: `/api/notifications/${encodeURIComponent(id)}/actions`,
      body: { revision, action: "approve" },
    },
  ]);
  assert.equal(attention("Codex"), null);
  assert.ok($(".claw-library"));
});

test("a stale permission keeps its badge and displays the rejection instead of claiming it was approved", async () => {
  stale = true;
  items = [
    notification("claude", "native", {
      revision: "b".repeat(64),
      actions: [{ id: "deny", label: "Deny" }],
    }),
  ];
  await mount([session("codex", "current")]);
  bell().click();
  await dom.waitFor(() => $(".notification-card"));
  [...$(".notification-card").querySelectorAll("button")]
    .find((button) => button.textContent === "Deny")
    .click();
  await dom.waitFor(() => $(".notification-action-error"));
  assert.match($(".notification-action-error").textContent, /request changed/);
  assert.equal(
    attention("Claude Code").querySelector(".chat-attention-count").textContent,
    "1",
  );
  assert.equal(calls.length, 1);
  assert.doesNotMatch(
    view.container.textContent,
    /Allowed once|Request denied/,
  );
});

test("reviewing a newly arrived native permission immediately does not discard its card", async () => {
  let answer;
  const native = session("claude", "native", {
    status: "waiting",
    live: { where: "claude-app", pid: 1, tty: null },
  });
  routes["/api/sessions/claude/native"] = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  routes["/api/sessions/claude/native/card"] = () => ({
    id: "permission",
    texts: ["Run npm test?"],
    buttons: ["Deny", "Allow once"],
  });
  let clicked = false;
  const observer = new dom.window.MutationObserver(() => {
    const review = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review",
    );
    if (!review || clicked) return;
    clicked = true;
    review.click();
  });
  try {
    view = await dom.render(
      React.createElement(NeedsYouStrip, {
        items: agentNeeds({
          peer,
          sessions: [native],
          logos: {},
          open() {},
          answered() {},
        }),
      }),
    );
    observer.observe(view.container, { childList: true, subtree: true });
    answer({
      session: {
        ...native,
        asking: {
          kind: "permission",
          text: "npm test",
          command: true,
          id: "permission",
        },
      },
    });
    await dom.waitFor(
      () =>
        [...view.container.querySelectorAll("button")].some(
          (button) => button.textContent === "Allow once",
        ),
      2000,
    );
    assert.equal(clicked, true);
    assert.deepEqual(calls, []);
    const allow = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow once",
    );
    allow.click();
    allow.click();
    await dom.waitFor(() =>
      view.container.textContent.includes("Answered in the Claude app"),
    );
    assert.deepEqual(calls, [
      {
        path: "/api/sessions/claude/native/prompts/permission",
        body: { label: "Allow once" },
      },
    ]);
  } finally {
    observer.disconnect();
    delete routes["/api/sessions/claude/native"];
    delete routes["/api/sessions/claude/native/card"];
  }
});

test("guests and chat views for another computer do not inherit inbox app counts", async () => {
  items = [notification("claude", "private")];
  await mount([], { enabled: false });
  assert.equal(bell(), null);
  assert.equal(attention("Claude Code"), null);
  await view.unmount();
  view = null;
  await mount([], {
    chatPeer: {
      ...peer,
      id: "other",
      url: "https://another.test",
      token: "another",
    },
  });
  assert.equal(attention("Claude Code"), null);
});
