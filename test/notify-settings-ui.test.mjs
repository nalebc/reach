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
  let preferences = {
    chat: true,
    done: true,
    computer: true,
    handoffs: true,
    access: true,
    pausedUntil: 0,
  };
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
    if (u.pathname === "/api/push" && method === "PATCH") {
      const body = JSON.parse(init.body);
      preferences = {
        ...preferences,
        ...body.preferences,
        ...(body.pauseMinutes !== undefined && {
          pausedUntil: body.pauseMinutes
            ? Date.now() + body.pauseMinutes * 60000
            : 0,
        }),
      };
      return reply(200, { preferences });
    }
    if (u.pathname === "/api/push" && method === "GET")
      return reply(200, {
        key: KEY,
        preferences,
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
      requestPermission: async () => {
        window.Notification.permission = "granted";
        return "granted";
      },
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
// The main switch, and the category switches once it's on.
const mainSwitch = (view) => view.container.querySelector('[role="switch"][aria-label="Notifications"]');
const categories = (view) => [...view.container.querySelectorAll('[role="group"] [role="switch"]')];
const tap = async (el, ms = 60) => {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(ms);
};
const buttonNamed = (view, text) => [...view.container.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const render = async () => {
  const view = await dom.render(React.createElement(NotifySettings, { peer }));
  await settle(60);
  return view;
};

test("the switch subscribes this browser with the computer's key, then turns it off", async () => {
  const log = browser();
  const view = await render();
  // One switch, off, with what it's for; nothing else to read.
  assert.equal(mainSwitch(view).checked, false);
  assert.match(view.container.textContent, /A ping when an agent or your Mac needs you/);
  await tap(mainSwitch(view));
  assert.equal(mainSwitch(view).checked, true);
  assert.match(view.container.textContent, /On for this device/);
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
  await tap(mainSwitch(view));
  assert.equal(mainSwitch(view).checked, false);
  assert.deepEqual(log.filter(([m]) => m !== "GET").slice(-2), [
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
  assert.match(view.container.textContent, /Add to Home Screen/);
  assert.equal(view.container.querySelectorAll('[role="switch"]').length, 0);
  await view.unmount();
});

test("on iPhone, Add to Home Screen opens the Share sheet for this page, then shows the two steps", async () => {
  browser({ capable: false, ios: true });
  const shared = [];
  dom.window.navigator.share = async (data) => {
    shared.push(data);
  };
  try {
    const view = await render();
    // One button, no instruction wall before it.
    assert.equal(view.container.querySelector(".ns-steps"), null);
    await tap(buttonNamed(view, "Add to Home Screen"));
    assert.equal(shared.length, 1);
    assert.equal(shared[0].title, "Reach");
    assert.equal(shared[0].url, dom.window.location.origin + dom.window.location.pathname);
    assert.match(view.container.querySelector(".ns-steps").textContent, /In the sheet, tap Add to Home Screen[\s\S]*Open Reach from your Home Screen and sign in\s+there once/);
    await view.unmount();
  } finally {
    delete dom.window.navigator.share;
  }
});

test("where the browser offers an install prompt, one tap on Add installs Reach", async () => {
  browser();
  const view = await render();
  // No prompt offered: no row.
  assert.equal(buttonNamed(view, "Add"), undefined);
  const calls = [];
  const offer = new dom.window.Event("beforeinstallprompt", { cancelable: true });
  offer.prompt = async () => calls.push("prompt");
  offer.userChoice = Promise.resolve({ outcome: "accepted" });
  dom.window.dispatchEvent(offer);
  await settle(40);
  assert.equal(offer.defaultPrevented, true);
  assert.match(view.container.textContent, /Add to Home Screen/);
  await tap(buttonNamed(view, "Add"));
  assert.deepEqual(calls, ["prompt"]);
  // Used once: the browser won't prompt again with it.
  assert.equal(buttonNamed(view, "Add"), undefined);
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

test("Home Screen mode enables push and sends a real server test for this subscription", async () => {
  const log = browser({ ios: true, standalone: true });
  const view = await render();
  await tap(mainSwitch(view));
  const testButton = buttonNamed(view, "Send a test notification");
  assert.ok(testButton);
  testButton.click();
  await settle(60);
  assert.ok(
    log.some(
      ([method, route, body]) =>
        method === "POST" &&
        route === "/api/push/test" &&
        body.endpoint === "https://fcm.googleapis.com/fcm/send/abc",
    ),
  );
  assert.match(view.container.textContent, /Test sent/);
  await view.unmount();
});

test("an iPhone browser always gets install guidance, even if push interfaces exist", async () => {
  browser({ ios: true, capable: true, standalone: false });
  const view = await render();
  assert.match(view.container.textContent, /Add to Home Screen/);
  assert.equal(view.container.querySelectorAll("button").length, 0);
  await view.unmount();
});

test("returning from iOS Settings refreshes denied permission without reloading Reach", async () => {
  browser({ ios: true, standalone: true, permission: "denied" });
  const view = await render();
  assert.match(view.container.textContent, /Settings → Notifications → Reach/);
  assert.equal(view.container.querySelectorAll("button").length, 0);
  window.Notification.permission = "default";
  window.dispatchEvent(new window.Event("focus"));
  await settle(60);
  assert.equal(mainSwitch(view).checked, false);
  await view.unmount();
});

test("declining notifications doesn't leave a nonworking enable button", async () => {
  browser({ ios: true, standalone: true });
  window.Notification.requestPermission = async () => {
    window.Notification.permission = "denied";
    return "denied";
  };
  const view = await render();
  await tap(mainSwitch(view));
  assert.match(view.container.textContent, /Notifications are blocked/);
  assert.equal(view.container.querySelectorAll("button").length, 0);
  assert.equal(view.container.querySelectorAll('[role="switch"]').length, 0);
  await view.unmount();
});

test("enabled devices can mute categories, pause, resume and keep their choices after reopening", async () => {
  const log = browser();
  let view = await render();
  await tap(mainSwitch(view), 80);
  const switches = () => categories(view);
  // Chats finished, agent questions, Mac prompts, apps handed over, access.
  assert.equal(switches().length, 5);
  assert.ok(switches().every((input) => input.checked));
  switches()[0].click();
  await settle(80);
  assert.equal(switches()[0].checked, false);
  assert.ok(
    switches()
      .slice(1)
      .every((input) => input.checked),
  );
  // Pause is two chips, not a select.
  assert.equal(view.container.querySelector("select"), null);
  await tap(buttonNamed(view, "1 hour"), 80);
  assert.match(view.container.textContent, /Paused until/);
  await view.unmount();
  view = await render();
  assert.equal(switches()[0].checked, false);
  assert.match(view.container.textContent, /Paused until/);
  await tap(buttonNamed(view, "Resume"), 80);
  assert.ok(buttonNamed(view, "1 hour"));
  assert.equal(switches()[0].checked, false);
  assert.equal(log.filter(([method]) => method === "PATCH").length, 3);
  await view.unmount();
});

test("failed preference saves retain the previous choice and show an error", async () => {
  browser();
  const view = await render();
  await tap(mainSwitch(view), 80);
  const original = globalThis.fetch;
  globalThis.fetch = dom.window.fetch = async (url, init) =>
    init?.method === "PATCH"
      ? new Response(JSON.stringify({ error: "Computer disconnected" }), {
          status: 503,
        })
      : original(url, init);
  await tap(categories(view)[0], 80);
  assert.equal(categories(view)[0].checked, true);
  assert.match(view.container.textContent, /Computer disconnected/);
  await view.unmount();
});
