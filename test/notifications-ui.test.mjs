import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, React, NotificationCenter, NotificationBell;
const peer = {
  id: "p",
  name: "MacBook Pro",
  platform: "darwin",
  url: "https://reach.test",
  token: "test",
};
let items = [],
  fail = false,
  refuse = false,
  asked = 0;
before(async (t) => {
  // Emit Node 22's one-time MockTimers warning before capturing React errors.
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.mock.timers.reset();
  await new Promise(resolve => setImmediate(resolve));
  dom = await startDom({
    routes: {
      "/api/push": () => ({ key: "test" }),
      "/api/notifications": () => (
        asked++,
        refuse
          ? new Response('{"error":"This action is not available."}', {
              status: 403,
            })
          : fail
            ? new Response('{"error":"Offline"}', { status: 503 })
            : { items, unavailable: [] }
      ),
    },
  });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "iPhone",
  });
  globalThis.matchMedia = dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  ({ NotificationCenter, NotificationBell } = await dom.load(
    "/src/Notifications.tsx",
  ));
});
after(() => dom.close());
const mount = (onOpen = () => {}, enabled = true) =>
  dom.render(
    React.createElement(
      NotificationCenter,
      { peer, enabled, onOpen },
      React.createElement(NotificationBell),
    ),
  );

test("the bell opens setup instructions, counts live requests and opens their actual destination", async () => {
  items = [
    {
      id: "ask",
      title: "Claude Code needs your answer",
      detail: "Fix the page",
      target: { page: "sessions", agent: "claude", id: "chat" },
    },
  ];
  let opened;
  const view = await mount((item) => {
    opened = item;
  });
  await settle(60);
  const bell = view.container.querySelector(".notification-bell");
  assert.match(bell.getAttribute("aria-label"), /1 need your attention/);
  bell.click();
  await settle(60);
  assert.match(view.container.textContent, /Add to Home Screen/);
  assert.equal(view.container.querySelectorAll("dialog[open]").length, 1);
  view.container.querySelector(".notification-row").click();
  await settle();
  assert.deepEqual(opened, items[0]);
  assert.equal(view.container.querySelectorAll("dialog[open]").length, 0);
  await view.unmount();
});

test("resolved requests disappear on reopening, and a lost connection never says caught up", async () => {
  items = [];
  const view = await mount();
  await settle(60);
  view.container.querySelector(".notification-bell").click();
  await settle(60);
  assert.match(view.container.textContent, /You're all caught up/);
  view.container.querySelector('[aria-label="Close panel"]').click();
  await settle();
  fail = true;
  view.container.querySelector(".notification-bell").click();
  await settle(60);
  assert.match(view.container.textContent, /Couldn't check for requests/);
  assert.doesNotMatch(view.container.textContent, /You're all caught up/);
  await view.unmount();
  fail = false;
});

test("a push tap opens the notification panel after sign-in; guests have no bell or panel", async () => {
  dom.window.history.replaceState({}, "", "/?notifications=1");
  let view = await mount();
  await settle(60);
  assert.equal(view.container.querySelectorAll("dialog[open]").length, 1);
  assert.equal(dom.window.location.search, "");
  await view.unmount();
  view = await mount(() => {}, false);
  await settle();
  assert.equal(view.container.querySelectorAll("button,dialog").length, 0);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

// A device the computer won't show its requests to was asked again every
// 5 seconds, forever (403 after 403).
test("a refused device isn't asked again every few seconds; a change on the computer reads the list at once", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let setChanges;
  function Center() {
    const [changes, set] = React.useState("a");
    setChanges = (c) => dom.update(() => set(c));
    return React.createElement(
      NotificationCenter,
      { peer, enabled: true, changes, onOpen() {} },
      React.createElement(NotificationBell),
    );
  }
  refuse = true;
  asked = 0;
  const view = await dom.render(React.createElement(Center));
  await settle(60);
  assert.equal(asked, 1);
  t.mock.timers.tick(30000);
  await settle(60);
  assert.equal(asked, 1, "not asked again while refused");
  setChanges("b");
  await settle(60);
  assert.equal(asked, 1, "nor on each change");
  await view.unmount();
  // Allowed: a change on the computer (a new request) reads the list at once.
  refuse = false;
  asked = 0;
  const fresh = await dom.render(React.createElement(Center));
  await settle(60);
  assert.equal(asked, 1);
  setChanges("c");
  await settle(60);
  assert.equal(asked, 2);
  await fresh.unmount();
  assert.deepEqual(dom.errors, []);
});

test("notification cards show agent identity, exact commands, and answer directly without opening the board again", async () => {
  const calls = [];
  const original = globalThis.fetch;
  items = [
    {
      id: "chat:codex:one:prompt:p",
      revision: "a".repeat(64),
      title: "Run this command?",
      sender: "Codex",
      icon: "codex",
      kind: "command",
      detail: "Fix navigation",
      prompt: { command: "npm test", cwd: "/workspace" },
      actions: [
        { id: "deny", label: "Deny" },
        { id: "approve", label: "Allow once", tone: "primary" },
      ],
      target: { page: "sessions", agent: "codex", id: "one", prompt: "p" },
    },
  ];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (new URL(url).pathname.endsWith("/actions")) {
      calls.push(JSON.parse(init.body));
      items = [];
      return new Response('{"ok":true}');
    }
    return original(url, init);
  };
  let opened = false;
  const view = await mount(() => {
    opened = true;
  });
  await dom.waitFor(() => view.container.querySelector(".notification-count"));
  view.container.querySelector(".notification-bell").click();
  await dom.waitFor(() => view.container.querySelector(".notification-card"));
  assert.match(view.container.textContent, /Codex.*Run this command\?/s);
  assert.equal(view.container.querySelector("pre").textContent, "npm test");
  const allow = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Allow once",
  );
  allow.click();
  allow.click();
  await dom.waitFor(() => view.container.textContent.includes("Allowed once"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { revision: "a".repeat(64), action: "approve" });
  assert.equal(opened, false);
  await view.unmount();
  globalThis.fetch = dom.window.fetch = original;
});

test("an outdated request stays reviewable and displays the server error", async () => {
  const original = globalThis.fetch;
  items = [
    {
      id: "agent",
      revision: "b".repeat(64),
      title: "Connect?",
      sender: "Muse",
      icon: "agent",
      kind: "connection",
      actions: [{ id: "deny", label: "Deny" }],
      target: { page: "overview", needs: "agent-admission:123" },
    },
  ];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) =>
    new URL(url).pathname.endsWith("/actions")
      ? new Response(
          '{"error":"This request changed or was already answered."}',
          { status: 409 },
        )
      : original(url, init);
  const view = await mount();
  await dom.waitFor(() => view.container.querySelector(".notification-count"));
  view.container.querySelector(".notification-bell").click();
  await dom.waitFor(() => view.container.querySelector(".notification-card"));
  [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent === "Deny")
    .click();
  await dom.waitFor(() => view.container.querySelector('[role="alert"]'));
  assert.match(view.container.textContent, /Review access/);
  assert.equal(
    view.container.querySelector(".notification-avatar.agent") !== null,
    true,
  );
  await view.unmount();
  globalThis.fetch = dom.window.fetch = original;
});
