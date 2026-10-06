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
  fail = false;
before(async () => {
  dom = await startDom({
    routes: {
      "/api/push": () => ({ key: "test" }),
      "/api/notifications": () =>
        fail
          ? new Response('{"error":"Offline"}', { status: 503 })
          : { items, unavailable: [] },
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
