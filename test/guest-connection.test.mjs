import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
import { tskey } from "./helpers/fake-keys.mjs";

async function load(file) {
  const outputText = transpile(await fs.readFile(new URL(`../src/${file}`, import.meta.url), "utf8"));
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}
const { guestConnection } = await load("guest-connection.ts");
const flow = await load("start-flow.ts");
function clock() {
  let now = 0,
    id = 0;
  const timers = new Map();
  return {
    later(fn, ms) {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...timers])
        if (task.at <= now) {
          timers.delete(id);
          task.fn();
        }
    },
  };
}

test("a slow one-time-key login never becomes a false expired-invitation error", () => {
  const time = clock(),
    shown = [];
  let ready = 0;
  const join = guestConnection({
    ...time,
    show: (n) => shown.push(n),
    ready: () => ready++,
  });
  join.state("NeedsLogin");
  time.advance(8000);
  assert.deepEqual(shown, []);
  join.state("Starting");
  time.advance(22000);
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /taking longer/);
  assert.equal(shown[0].retry, true);
  join.state("Running");
  join.state("Running");
  time.advance(60000);
  assert.equal(ready, 1);
  assert.equal(shown.length, 1);
});

test("successful startup cancels delayed notices; explicit failures and network approval are distinct", () => {
  const time = clock(),
    shown = [];
  let ready = 0;
  const join = guestConnection({
    ...time,
    show: (n) => shown.push(n),
    ready: () => ready++,
  });
  join.state("NeedsLogin");
  join.state("Running");
  time.advance(60000);
  join.error("key");
  assert.equal(ready, 1);
  assert.deepEqual(shown, []);
  const pending = guestConnection({
    ...time,
    show: (n) => shown.push(n),
    ready() {},
  });
  pending.state("NeedsLogin");
  pending.state("NeedsMachineAuth");
  time.advance(60000);
  assert.equal(shown.length, 1);
  assert.match(shown[0].title, /Network approval/);
  pending.error("network");
  assert.match(shown.at(-1).title, /connection could not finish/);
  assert.equal(shown.at(-1).retry, true);
  pending.error("key");
  assert.match(shown.at(-1).title, /key was not accepted/);
});

test("a stalled handshake identifies HTTPS, WebSocket and registration separately", () => {
  const time = clock(),
    shown = [];
  const join = guestConnection({
    ...time,
    show: (n) => shown.push(n),
    ready() {},
  });
  join.state("NeedsLogin");
  join.network("https-connecting");
  time.advance(30000);
  assert.match(shown.at(-1).detail, /waiting for Tailscale/);
  assert.match(shown.at(-1).diagnostics, /Network step: https-connecting/);
  join.network("https-ready");
  join.network("socket-connecting");
  assert.match(shown.at(-1).detail, /WebSocket channel has not opened/);
  join.network("socket-failed");
  assert.match(shown.at(-1).detail, /WebSocket connection to Tailscale failed/);
  assert.match(shown.at(-1).diagnostics, /Owner approval: not reached/);
  join.network("socket-ready");
  assert.match(shown.at(-1).detail, /secure channel is open/);
  join.state("Running");
  const count = shown.length;
  join.network("socket-failed");
  time.advance(60000);
  assert.equal(shown.length, count);
});

const memory = (initial = {}) =>
  Object.assign(
    Object.create({
      getItem(key) {
        return this[key] ?? null;
      },
      setItem(key, value) {
        this[key] = String(value);
      },
      removeItem(key) {
        delete this[key];
      },
    }),
    initial,
  );
const link = {
  key: tskey("auth-test123456-abcdef"),
  hostname: "rg-ab12-abcdefghij",
  invites: [{ origin: "https://mac.tail.ts.net:8443", secret: "a".repeat(43) }],
};

test("reload before network registration preserves the tab's pending key after URL cleanup", () => {
  const session = memory(),
    local = memory({ "reach.tailnet:owner": "keep-owner" });
  assert.deepEqual(flow.resumeGuestStart(link, session, local), link);
  const cleaned = flow.parseGuestLink(flow.guestHash(link.invites));
  assert.equal(cleaned.key, "");
  assert.deepEqual(flow.resumeGuestStart(cleaned, session, local), link);
  assert.equal(local.getItem("reach.tailnet:owner"), "keep-owner");
});

test("reopening the same link keeps its joined device; a different invite clears only guest state", () => {
  const session = memory(),
    local = memory({ "reach.tailnet:owner": "keep-owner" });
  flow.resumeGuestStart(link, session, local);
  local.setItem("reach.guest:_current-profile", "joined-device");
  flow.guestStartConnected(session);
  assert.equal(JSON.parse(session.getItem("reach.guest-start")).key, "");
  flow.resumeGuestStart(link, session, local);
  assert.equal(local.getItem("reach.guest:_current-profile"), "joined-device");
  const next = {
    ...link,
    hostname: "rg-ab12-klmnopqrst",
    key: tskey("auth-replacement123456-abcdef"),
    invites: [{ ...link.invites[0], secret: "b".repeat(43) }],
  };
  assert.deepEqual(flow.resumeGuestStart(next, session, local), next);
  assert.equal(local.getItem("reach.guest:_current-profile"), null);
  assert.equal(local.getItem("reach.tailnet:owner"), "keep-owner");
});

test("different invitation secrets never reuse a saved pending network key", () => {
  const session = memory(),
    local = memory();
  flow.resumeGuestStart(link, session, local);
  const other = {
    key: "",
    hostname: "",
    invites: [{ ...link.invites[0], secret: "b".repeat(43) }],
  };
  assert.deepEqual(flow.resumeGuestStart(other, session, local), other);
});
