import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Settings → Notifications: only on your own devices, only from the computer
// serving the page; on iPhone, only from the Home Screen. The switch
// subscribes this browser and tells the computer.
let dom, React, NotifySettings;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ NotifySettings } = await dom.load("/src/NotifySettings.tsx"));
});
after(async () => dom?.close());

const peer = {
  id: "a",
  name: "Mac A",
  url: "https://reach.test:8443",
  token: "T",
  platform: "darwin",
};
const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString(
  "base64url",
);
const set = (name, value) => {
  Object.defineProperty(dom.window, name, {
    configurable: true,
    writable: true,
    value,
  });
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
};
function browser({
  capable = true,
  ios = false,
  standalone = false,
  permission = "default",
  owner = true,
} = {}) {
  const log = [];
  let subscription = null;
  const reply = (status, v) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    log.push([
      method,
      u.pathname + u.search,
      init.body ? JSON.parse(init.body) : undefined,
    ]);
    if (!owner)
      return reply(403, {
        error: "This credential does not grant admin access.",
      });
    if (u.pathname === "/api/push" && method === "GET")
      return reply(200, {
        key: KEY,
        subscribed:
          !!subscription &&
          u.searchParams.get("endpoint") === subscription.endpoint,
      });
    return reply(200, { subscribed: method === "POST" });
  };
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: ios
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)"
      : "Mozilla/5.0 (Linux; Android 15)",
  });
  dom.window.matchMedia = globalThis.matchMedia = (q) => ({
    matches: q.includes("standalone") ? standalone : true,
    addEventListener() {},
    removeEventListener() {},
  });
  const registration = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async (options) => {
        log.push([
          "subscribe",
          Buffer.from(options.applicationServerKey).toString("base64url"),
        ]);
        subscription = {
          endpoint: "https://fcm.googleapis.com/fcm/send/abc",
          options,
          toJSON: () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            keys: { p256dh: "P", auth: "A" },
          }),
          unsubscribe: async () => (
            (subscription = null),
            log.push(["unsubscribe"]),
            true
          ),
        };
        return subscription;
      },
    },
  };
  if (capable) {
    Object.defineProperty(dom.window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async (url) => (log.push(["register", url]), registration),
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
      },
    });
    set("PushManager", function () {});
    set("Notification", {
      permission,
      requestPermission: async () => ((permission = "granted"), "granted"),
    });
  } else {
    delete dom.window.navigator.serviceWorker;
    set("PushManager", undefined);
    delete dom.window.PushManager;
    delete globalThis.PushManager;
    delete dom.window.Notification;
    delete globalThis.Notification;
  }
  return log;
}
const render = async () => {
  const view = await dom.render(React.createElement(NotifySettings, { peer }));
  await settle(60);
  return view;
};

test("the switch subscribes this browser with the computer's key, then turns it off", async () => {
  const log = browser();
  const view = await render();
  const toggle = view.container.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(60);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.deepEqual(
    log.filter(([m]) => m !== "GET"),
    [
      ["register", "/sw.js"],
      ["subscribe", KEY],
      [
        "POST",
        "/api/push",
        {
          subscription: {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            keys: { p256dh: "P", auth: "A" },
          },
        },
      ],
    ],
  );
  toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(60);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.deepEqual(log.slice(-2), [
    [
      "DELETE",
      "/api/push",
      { endpoint: "https://fcm.googleapis.com/fcm/send/abc" },
    ],
    ["unsubscribe"],
  ]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("on iPhone outside the Home Screen it says how, with no switch", async () => {
  browser({ capable: false, ios: true });
  const view = await render();
  assert.match(
    view.container.textContent,
    /Add Reach to your Home Screen to get them\./,
  );
  assert.equal(view.container.querySelectorAll('[role="switch"]').length, 0);
  await view.unmount();
});

test("guests and browsers that can't get notifications see nothing", async () => {
  browser({ owner: false });
  let view = await render();
  assert.equal(view.container.textContent, "");
  await view.unmount();
  browser({ capable: false, ios: false });
  view = await render();
  assert.equal(view.container.textContent, "");
  await view.unmount();
});
