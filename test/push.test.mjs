import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import {
  createPush,
  encryptPush,
  pushServiceAllowed,
  vapidJwt,
  vapidKeys,
} from "../server/push.mjs";

// Notifications on the phone (server/push.mjs): encrypted per RFC 8291,
// signed per RFC 8292, sent only to the browsers' own push services and only
// to your own devices.
const unb64 = (s) => Buffer.from(s.replace(/\s/g, ""), "base64url");

test("encryption matches RFC 8291's worked example byte for byte", () => {
  const body = encryptPush(
    unb64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
    {
      salt: "DGv6ra1nlYgDCS1FRnbzlw",
      local: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    },
  );
  const header =
    unb64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`);
  const ciphertext =
    unb64(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
    bI_0LpXMuGvnzQ`);
  assert.equal(header.length, 86);
  assert.deepEqual(body, Buffer.concat([header, ciphertext]));
});

// Decrypt as the phone does (RFC 8291 section 3.4, RFC 8188).
function decrypt(body, phone, auth) {
  const salt = body.subarray(0, 16),
    keyLength = body[20],
    serverKey = body.subarray(21, 21 + keyLength),
    sealed = body.subarray(21 + keyLength);
  assert.equal(body.readUInt32BE(16), 4096);
  const secret = phone.computeSecret(serverKey);
  const ikm = crypto.hkdfSync(
    "sha256",
    secret,
    auth,
    Buffer.concat([
      Buffer.from("WebPush: info\0"),
      phone.getPublicKey(),
      serverKey,
    ]),
    32,
  );
  const cek = crypto.hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = crypto.hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: nonce\0"),
    12,
  );
  const decipher = crypto.createDecipheriv(
    "aes-128-gcm",
    Buffer.from(cek),
    Buffer.from(nonce),
  );
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, -16)),
    decipher.final(),
  ]);
  assert.equal(plain.at(-1), 2, "last-record delimiter");
  return plain.subarray(0, -1).toString();
}

test("the receiving phone can decrypt it (a fresh key and salt each time)", () => {
  const phone = crypto.createECDH("prime256v1");
  phone.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = {
    p256dh: phone.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
  };
  const a = encryptPush('{"title":"Claude needs you in Notes"}', keys);
  const b = encryptPush('{"title":"Claude needs you in Notes"}', keys);
  assert.notDeepEqual(a, b);
  assert.equal(
    decrypt(a, phone, auth),
    '{"title":"Claude needs you in Notes"}',
  );
  assert.equal(
    decrypt(b, phone, auth),
    '{"title":"Claude needs you in Notes"}',
  );
});

test("the VAPID token is ES256 with a raw signature, for the push service, from the computer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-vapid-"));
  const file = path.join(dir, "vapid.json");
  const { privateKey, publicKey } = vapidKeys(file);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(vapidKeys(file).publicKey, publicKey, "made once, then kept");
  const jwt = vapidJwt({
    audience: "https://web.push.apple.com",
    subject: "https://mac.tail1.ts.net",
    privateKey,
    now: Date.UTC(2026, 9, 5),
  });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(unb64(h)), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(unb64(c)), {
    aud: "https://web.push.apple.com",
    exp: Date.UTC(2026, 9, 5) / 1000 + 12 * 3600,
    sub: "https://mac.tail1.ts.net",
  });
  assert.equal(unb64(s).length, 64, "r||s, not DER");
  const key = crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: unb64(publicKey).subarray(1, 33).toString("base64url"),
      y: unb64(publicKey).subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key, dsaEncoding: "ieee-p1363" },
      unb64(s),
    ),
  );
});

test("only the browsers' push services are ever contacted", () => {
  for (const ok of [
    "https://web.push.apple.com/QGuQ",
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ])
    assert.equal(pushServiceAllowed(ok), true, ok);
  for (const bad of [
    "http://web.push.apple.com/x",
    "https://web.push.apple.com.evil.test/x",
    "https://127.0.0.1/x",
    "https://mac.tail1.ts.net:8443/api/files",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "not a url",
  ])
    assert.equal(pushServiceAllowed(bad), false, bad);
});

// A browser's subscription, with what the phone keeps to decrypt.
function subscription(endpoint = "https://web.push.apple.com/QGuQ") {
  const phone = crypto.createECDH("prime256v1");
  phone.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = {
    endpoint,
    keys: {
      p256dh: phone.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
  Object.defineProperty(sub, "open", {
    value: (body) => decrypt(body, phone, auth),
  });
  return sub;
}

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-push-"));
  const sent = [];
  let status = 201;
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    agentSessions: { list: async () => ({ sessions: [] }), close() {} },
    openClaw: { overview: async () => ({ connected: false }), close() {} },
    screen: true,
    appPlatform: "darwin",
    agentIdle: async () => 600,
    appDisplays: async ({ onExit }) => ({
      stopped: false,
      async request(cmd, payload) {
        if (cmd === "open")
          return {
            thread: payload.thread,
            display: "901",
            size: { w: 852, h: 1130 },
            region: { x: 0, y: 0, w: 393, h: 852 },
            scale: 2,
            app: { name: "Notes" },
          };
        return { closed: true };
      },
      async stop() {
        onExit();
      },
    }),
    appList: async () => [
      { id: "/System/Applications/Notes.app", name: "Notes" },
    ],
    push: {
      post: async (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body });
        return { status, ok: status < 300 };
      },
      log: () => {},
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const call = (route, { token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  t.after(() => reach.close());
  const saved = () =>
    JSON.parse(
      fs.readFileSync(path.join(dir, "private", "push.json"), "utf8"),
    ).subscriptions.map((s) => s.endpoint);
  return { reach, call, sent, saved, setStatus: (s) => (status = s) };
}

test("your phone subscribes; a handoff includes safe context, identity and its destination", async (t) => {
  const { reach, call, sent } = await start(t);
  const owner = reach.auth.issue("iPhone", ALL_SCOPES);
  const agent = reach.auth.issue("Claude", ["device", "apps:drive"], "agent");
  const key = (await call("/api/push", { token: owner.token })).body;
  assert.equal(unb64(key.key).length, 65);
  assert.equal(key.subscribed, false);
  const sub = subscription();
  assert.equal(
    (
      await call("/api/push", {
        token: owner.token,
        method: "POST",
        body: { subscription: sub },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/api/push?endpoint=${encodeURIComponent(sub.endpoint)}`, {
        token: owner.token,
      })
    ).body.subscribed,
    true,
  );
  const { id } = (
    await call("/api/drive/apps", {
      token: agent.token,
      method: "POST",
      body: { appId: "/System/Applications/Notes.app" },
    })
  ).body;
  await call(`/api/drive/apps/${id}/handoff`, {
    token: agent.token,
    method: "POST",
    body: { reason: "Type the code we texted you: 482913." },
  });
  const until = Date.now() + 2000;
  while (!sent.length && Date.now() < until)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, sub.endpoint);
  assert.match(
    sent[0].headers.Authorization,
    /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/,
  );
  assert.equal(sent[0].headers["Content-Encoding"], "aes128gcm");
  assert.equal(sent[0].headers.Urgency, "high");
  // What the phone reads: who needs you, where. Never the agent's words.
  const message = JSON.parse(sub.open(sent[0].body));
  assert.deepEqual(Object.keys(message).sort(), [
    "actions",
    "body",
    "icon",
    "tag",
    "title",
    "url",
  ]);
  assert.equal(message.icon, "claude");
  assert.deepEqual(message.actions, [{ action: "open", title: "Open app" }]);
  assert.doesNotMatch(message.body, /482913/);
  // One tap opens the app handed to you, not the list (src/deep-link.ts).
  const destination = new URL(message.url, "https://reach.test");
  assert.equal(destination.searchParams.get("page"), "apps");
  assert.match(destination.searchParams.get("threadId"), /^[\w-]+$/);
  assert.ok(destination.searchParams.get("computer"));
  assert.equal(message.title, "Claude needs you in Notes");
  assert.equal(message.body, "Open Notes to continue where Claude left off.");
  assert.match(message.tag, /^handoff-[0-9a-f]{8}$/);
});

test("guests and agents can't subscribe; a revoked phone and a gone subscription get nothing more", async (t) => {
  const { reach, call, sent, saved, setStatus } = await start(t);
  const owner = reach.auth.issue("iPhone", ALL_SCOPES);
  const old = reach.auth.issue("Old phone", ALL_SCOPES);
  const guest = reach.auth.redeemGuest(
    reach.auth.inviteGuest({ name: "Sam", full: true, ttlSeconds: 600 })
      .invitation,
  );
  const agent = reach.auth.issue("Claude", ["device", "apps:drive"], "agent");
  for (const token of [guest.token, agent.token])
    assert.equal(
      (
        await call("/api/push", {
          token,
          method: "POST",
          body: { subscription: subscription() },
        })
      ).status,
      403,
    );
  // Never an address that isn't a push service.
  assert.equal(
    (
      await call("/api/push", {
        token: owner.token,
        method: "POST",
        body: { subscription: subscription("https://169.254.169.254/latest") },
      })
    ).status,
    400,
  );
  const mine = subscription("https://web.push.apple.com/mine");
  const theirs = subscription("https://web.push.apple.com/old");
  await call("/api/push", {
    token: owner.token,
    method: "POST",
    body: { subscription: mine },
  });
  await call("/api/push", {
    token: old.token,
    method: "POST",
    body: { subscription: theirs },
  });
  assert.equal(
    (
      await call(`/api/clients/${old.clientId}`, {
        token: owner.token,
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.deepEqual(
    saved(),
    [mine.endpoint],
    "the revoked phone's subscription is deleted",
  );
  const ask = () =>
    fetch(
      `http://127.0.0.1:${reach.server.address().port}/api/agents/requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Helper", scopes: ["files:read"] }),
      },
    );
  assert.equal((await ask()).status, 202);
  let until = Date.now() + 2000;
  while (!sent.length && Date.now() < until)
    await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    sent.map((s) => s.url),
    [mine.endpoint],
    "only the phone still allowed",
  );
  // The push service says the subscription is gone: it's dropped.
  setStatus(410);
  assert.equal((await ask()).status, 202);
  until = Date.now() + 2000;
  while (sent.length < 2 && Date.now() < until)
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    (
      await call(`/api/push?endpoint=${encodeURIComponent(mine.endpoint)}`, {
        token: owner.token,
      })
    ).body.subscribed,
    false,
  );
});

test("a subscription is checked and kept per device", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-push-store-"));
  const push = createPush({
    dataDir: dir,
    subject: () => "https://mac.test",
    post: async () => ({ status: 201, ok: true }),
  });
  assert.throws(
    () =>
      push.subscribe("a", {
        endpoint: "https://web.push.apple.com/x",
        keys: { p256dh: "AA", auth: "AA" },
      }),
    /Invalid push subscription keys/,
  );
  const sub = subscription();
  push.subscribe("a", sub);
  // The same browser subscribed again by another device of yours moves to it.
  push.subscribe("b", sub);
  assert.equal(push.subscribed("a"), false);
  assert.equal(push.subscribed("b", sub.endpoint), true);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(path.join(dir, "push.json")).mode & 0o777, 0o600);
  const again = createPush({ dataDir: dir, subject: () => "https://mac.test" });
  assert.equal(
    again.subscribed("b", sub.endpoint),
    true,
    "kept across restarts",
  );
});

test("the service worker shows every push and only handles notification icons and intents", async () => {
  const vm = await import("node:vm");
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: "https://mac.tail1.ts.net:8443" },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
    registration: {
      showNotification: async (title, options) => shown.push([title, options]),
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async (url) => opened.push(url),
    },
  };
  vm.runInNewContext(
    fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    { self, URL },
  );
  assert.deepEqual(Object.keys(listeners).sort(), [
    "activate",
    "fetch",
    "install",
    "message",
    "notificationclick",
    "push",
  ]);
  const push = async (data) => {
    const waits = [];
    listeners.push({ data, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  await push({
    json: () => ({
      title: "Claude needs you in Notes",
      tag: "handoff-1",
      url: "//evil.test/x",
    }),
  });
  await push({
    json: () => {
      throw Error("not JSON");
    },
  });
  await push(null);
  assert.deepEqual(
    shown.map(([title, o]) => [title, o.tag, o.data.url]),
    [
      ["Claude needs you in Notes", "handoff-1", "/"],
      ["Reach", "reach", "/"],
      ["Reach", "reach", "/"],
    ],
  );
  const waits = [];
  listeners.notificationclick({
    notification: { close() {}, data: { url: "/" } },
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
  // Whatever a notification carries, a tap opens Reach, never another site.
  listeners.notificationclick({
    notification: { close() {}, data: { url: "//evil.test/x" } },
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
  assert.deepEqual(opened, [
    "https://mac.tail1.ts.net:8443/",
    "https://mac.tail1.ts.net:8443/",
  ]);
  const messages = [];
  const client = {
    url: "https://mac.tail1.ts.net:8443/",
    focus: async () => client,
    postMessage: (message) => messages.push(message.type),
  };
  self.clients.matchAll = async () => [client];
  listeners.notificationclick({
    notification: { close() {}, data: { url: "/?notifications=1" } },
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
  assert.deepEqual(messages, ["reach-notifications"]);
  assert.equal(
    opened.length,
    2,
    "reuse Reach without navigating away from its current work",
  );
});

test("a live agent wait notifies with every browser closed, once, without hooks", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-push-asks-"));
  const sent = [];
  let sessions = [];
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    agentSessions: { list: async () => ({ sessions }), close() {} },
    openClaw: { overview: async () => ({ connected: false }), close() {} },
    notifications: { intervalMs: 25 },
    push: {
      post: async (url, init) => (sent.push(init), { status: 201, ok: true }),
      log: () => {},
    },
  });
  t.after(() => reach.close());
  const owner = reach.auth.issue("iPhone", ALL_SCOPES);
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const sub = subscription();
  const r = await fetch(
    `http://127.0.0.1:${reach.server.address().port}/api/push`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subscription: sub }),
    },
  );
  assert.equal(r.status, 200);
  sessions = [
    {
      agent: "claude",
      id: "session1",
      status: "waiting",
      prompts: [{ id: "p1" }],
      title: "PRIVATE CHAT",
    },
  ];
  const end = Date.now() + 2000;
  while (!sent.length && Date.now() < end)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 1);
  sessions = [];
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 1);
  const message = JSON.parse(sub.open(sent[0].body));
  // The chat's name says which chat; the agent and its request follow.
  assert.equal(message.title, "PRIVATE CHAT");
  assert.equal(message.body, "Claude Code · Your answer is needed");
  assert.equal(
    new URL(message.url, "https://reach.test").searchParams.get("page"),
    "sessions",
  );
  assert.equal(
    new URL(message.url, "https://reach.test").searchParams.get("id"),
    "session1",
  );
  assert.equal(
    new URL(message.url, "https://reach.test").searchParams.get("prompt"),
    "p1",
  );
  assert.match(message.tag, /^need-[a-f0-9]{24}$/);
  assert.doesNotMatch(
    JSON.stringify({ title: message.title, body: message.body }),
    /session1|p1/,
  );
});

test("test push reaches only the requesting browser and reports provider failure", async (t) => {
  const { reach, call, sent, setStatus } = await start(t);
  const owner = reach.auth.issue("iPhone", ALL_SCOPES);
  const other = reach.auth.issue("iPad", ALL_SCOPES);
  const agent = reach.auth.issue("Agent", ["device", "apps:drive"], "agent");
  const phone = subscription("https://web.push.apple.com/phone");
  const desktop = subscription("https://web.push.apple.com/desktop");
  for (const subscription of [phone, desktop])
    await call("/api/push", {
      token: owner.token,
      method: "POST",
      body: { subscription },
    });
  for (const token of [agent.token]) {
    assert.equal((await call("/api/push", { token })).status, 403);
    assert.equal((await call("/api/notifications", { token })).status, 403);
  }
  assert.equal(
    (
      await call("/api/push/test", {
        token: other.token,
        method: "POST",
        body: { endpoint: phone.endpoint },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/push/test", {
        token: owner.token,
        method: "POST",
        body: { endpoint: phone.endpoint },
      })
    ).status,
    200,
  );
  assert.deepEqual(
    sent.map((s) => s.url),
    [phone.endpoint],
  );
  assert.equal(
    JSON.parse(phone.open(sent[0].body)).title,
    "Reach notifications are working",
  );
  assert.equal(
    (
      await call("/api/push/test", {
        token: owner.token,
        method: "POST",
        body: { endpoint: phone.endpoint },
      })
    ).status,
    429,
  );
  const failing = subscription("https://web.push.apple.com/failing");
  await call("/api/push", {
    token: other.token,
    method: "POST",
    body: { subscription: failing },
  });
  setStatus(410);
  assert.equal(
    (
      await call("/api/push/test", {
        token: other.token,
        method: "POST",
        body: { endpoint: failing.endpoint },
      })
    ).status,
    502,
  );
  assert.equal(
    (await call("/api/push", { token: other.token })).body.subscribed,
    false,
  );
  const response = await call("/api/notifications", { token: owner.token });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, []);
});

test("notification preferences persist per browser, suppress categories and pause without blocking tests", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-push-preferences-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  let clock = Date.now();
  const options = {
    dataDir: dir,
    subject: () => "https://localhost",
    now: () => clock,
    post: async (url) => (sent.push(url), { status: 201, ok: true }),
  };
  let push = createPush(options);
  const phone = subscription("https://web.push.apple.com/phone");
  const desktop = subscription("https://web.push.apple.com/desktop");
  push.subscribe("owner", phone);
  push.subscribe("owner", desktop);
  push.updatePreferences("owner", phone.endpoint, { chat: false }, 60);
  assert.throws(
    () => push.updatePreferences("other", phone.endpoint, { chat: true }),
    /Enable notifications/,
  );
  assert.throws(
    () => push.updatePreferences("owner", phone.endpoint, { chat: "no" }),
    /Invalid/,
  );
  assert.throws(
    () => push.updatePreferences("owner", phone.endpoint, {}, -1),
    /Invalid/,
  );
  push = createPush(options);
  push.subscribe("owner", phone); // Re-subscribing must preserve preferences.
  assert.equal(push.preferences("owner", phone.endpoint).chat, false);
  assert.equal(push.preferences("owner", desktop.endpoint).chat, true);
  assert.equal(push.preferences("other", phone.endpoint), null);
  await push.notify(["owner"], { title: "Attention", category: "computer" });
  assert.deepEqual(sent.splice(0), [desktop.endpoint]);
  await push.notify(
    ["owner"],
    { title: "Test" },
    { endpoint: phone.endpoint, test: true },
  );
  assert.deepEqual(sent.splice(0), [phone.endpoint]);
  clock += 3600001;
  await push.notify(["owner"], { title: "Attention", category: "computer" });
  assert.deepEqual(
    sent.splice(0).sort(),
    [phone.endpoint, desktop.endpoint].sort(),
  );
  assert.deepEqual(
    await push.notify(
      ["owner"],
      { title: "Question", category: "chat" },
      { endpoint: phone.endpoint },
    ),
    { sent: 0, suppressed: 1 },
  );
  for (const category of ["computer", "handoffs", "access"]) {
    push.updatePreferences("owner", phone.endpoint, { [category]: false });
    assert.equal(
      (
        await push.notify(
          ["owner"],
          { title: "Attention", category },
          { endpoint: phone.endpoint },
        )
      ).suppressed,
      1,
    );
  }
  push.updatePreferences("owner", phone.endpoint, { chat: true }, 0);
  assert.equal(
    (
      await push.notify(
        ["owner"],
        { title: "Question", category: "chat" },
        { endpoint: phone.endpoint },
      )
    ).sent,
    1,
  );
});

test("preference API edits only an owned subscription and preserves other switches", async (t) => {
  const { reach, call } = await start(t);
  const owner = reach.auth.issue("Phone", ALL_SCOPES);
  const other = reach.auth.issue("Other", ALL_SCOPES);
  const guest = reach.auth.issue("Guest", ["device"]);
  const sub = subscription();
  await call("/api/push", {
    token: owner.token,
    method: "POST",
    body: { subscription: sub },
  });
  const edit = (token, preferences, pauseMinutes) =>
    call("/api/push", {
      token,
      method: "PATCH",
      body: { endpoint: sub.endpoint, preferences, pauseMinutes },
    });
  assert.equal((await edit(guest.token, {})).status, 403);
  assert.equal((await edit(other.token, {})).status, 409);
  assert.equal((await edit(owner.token, { surprise: false })).status, 400);
  assert.equal((await edit(owner.token, { chat: false }, 60)).status, 200);
  assert.equal((await edit(owner.token, { access: false })).status, 200);
  const prefs = (
    await call(`/api/push?endpoint=${encodeURIComponent(sub.endpoint)}`, {
      token: owner.token,
    })
  ).body.preferences;
  assert.equal(prefs.chat, false);
  assert.equal(prefs.access, false);
  assert.equal(prefs.handoffs, true);
  assert.ok(prefs.pausedUntil > Date.now());
  assert.equal(
    (await edit(owner.token, {}, 0)).body.preferences.pausedUntil,
    0,
  );
});
