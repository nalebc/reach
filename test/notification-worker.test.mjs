import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
function worker({ maxActions = 2 } = {}) {
  const events = {},
    shown = [],
    messages = [],
    opened = [],
    buckets = new Map();
  const caches = {
    open: async (name) => {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const data = buckets.get(name);
      const key = (v) => (typeof v === "string" ? v : v.url || v.href);
      return {
        put: async (k, v) => data.set(key(k), v.clone()),
        match: async (k) => data.get(key(k))?.clone(),
        delete: async (k) => data.delete(key(k)),
        keys: async () => [...data.keys()],
      };
    },
  };
  const client = {
    url: "https://reach.test/",
    focus: async () => client,
    postMessage: (value) => messages.push(value),
    navigate: async (url) => opened.push(url),
  };
  const self = {
    Notification: maxActions === undefined ? undefined : { maxActions },
    location: { origin: "https://reach.test" },
    addEventListener: (name, callback) => (events[name] = callback),
    registration: {
      showNotification: async (title, options) =>
        shown.push({ title, ...options }),
    },
    clients: {
      matchAll: async () => [client],
      openWindow: async (url) => opened.push(url),
    },
  };
  vm.runInNewContext(
    fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    {
      self,
      caches,
      URL,
      Response,
      Uint8Array,
      atob,
      crypto: webcrypto,
      fetch: async () => new Response("icon"),
    },
  );
  const emit = async (name, value) => {
    let done;
    events[name]({ ...value, waitUntil: (promise) => (done = promise) });
    await done;
  };
  return { events, shown, messages, opened, self, emit, caches };
}
test("push includes rich text, provider icon and explicit action buttons", async () => {
  const w = worker();
  await w.emit("push", {
    data: {
      json: () => ({
        title: "Codex · Approval needed",
        body: "Review a command",
        icon: "codex",
        url: "/?page=sessions&agent=codex&id=chat&prompt=p1",
        actions: [
          { action: "open", title: "Review" },
          { action: "deny", title: "Deny" },
        ],
        notification: { id: "chat:1", revision: "a".repeat(64) },
      }),
    },
  });
  const notice = w.shown[0];
  assert.equal(notice.body, "Review a command");
  assert.equal(notice.icon, "/notification-icons/codex.png");
  assert.equal(notice.actions.length, 2);
  await w.emit("notificationclick", {
    notification: { data: notice.data, close() {} },
    action: "",
  });
  assert.equal(w.messages[0].type, "reach-open");
  assert.match(w.messages[0].url, /prompt=p1/);
});
test("OS Deny produces a one-use intent, scoped to the same origin and never a bearer credential", async () => {
  const w = worker();
  const data = {
    url: "/?page=overview&needs=browser:123",
    actions: ["open", "deny"],
    notification: { id: "browser:123", revision: "b".repeat(64) },
  };
  await w.emit("notificationclick", {
    notification: { data, close() {} },
    action: "deny",
  });
  const intent = new URL(w.opened[0]).searchParams.get("notificationIntent");
  assert.match(intent, /^[a-f0-9-]{36}$/);
  assert.match(w.opened[0], /needs=browser%3A123/);
  const received = [];
  const request = {
    data: { type: "take-notification-intent", id: intent },
    ports: [{ postMessage: (value) => received.push(value) }],
  };
  await w.emit("message", {
    ...request,
    source: { url: "https://other.test/" },
  });
  assert.equal(received.length, 0);
  await w.emit("message", {
    ...request,
    source: { url: "https://reach.test/" },
  });
  assert.equal(received[0].id, "browser:123");
  assert.equal(received[0].action, "deny");
  assert.equal(received[0].token, undefined);
  await w.emit("message", {
    ...request,
    source: { url: "https://reach.test/" },
  });
  assert.equal(received[1], null);
});
test("an unoffered action or a forged intent does not cause a decision; icons cannot intercept workspace fetches", async () => {
  const w = worker();
  await w.emit("notificationclick", {
    notification: {
      data: {
        url: "//evil.test/",
        actions: ["open"],
        notification: { id: "x", revision: "c".repeat(64) },
      },
      close() {},
    },
    action: "deny",
  });
  assert.equal(w.messages[0].type, "reach-notifications");
  let reply;
  await w.emit("message", {
    source: { url: "https://reach.test/" },
    data: { type: "take-notification-intent", id: webcrypto.randomUUID() },
    ports: [{ postMessage: (value) => (reply = value) }],
  });
  assert.equal(reply, null);
  let intercepted = false;
  w.events.fetch({
    request: { url: "https://reach.test/api/files", method: "GET" },
    respondWith: () => (intercepted = true),
  });
  assert.equal(intercepted, false);
});

test("iPhone-style actionless notifications retain their content and exact tap destination", async () => {
  const w = worker({ maxActions: 0 });
  await w.emit("push", {
    data: {
      json: () => ({
        title: "✦ Muse · Connection request",
        body: "Tap to compare the connection code and review access.",
        url: "/?page=overview&needs=agent-admission:123&computer=mac",
        actions: [
          { action: "open", title: "Review" },
          { action: "deny", title: "Deny" },
        ],
      }),
    },
  });
  assert.equal(w.shown[0].actions.length, 0);
  assert.equal(w.shown[0].title, "✦ Muse · Connection request");
  assert.match(w.shown[0].body, /compare the connection code/);
  await w.emit("notificationclick", {
    notification: { data: w.shown[0].data, close() {} },
    action: "",
  });
  assert.equal(w.messages[0].type, "reach-open");
  const url = new URL(w.messages[0].url);
  assert.equal(url.searchParams.get("needs"), "agent-admission:123");
  assert.equal(url.searchParams.get("computer"), "mac");
});
