import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBrowserHostGuard } from "../server/browser-host-guard.mjs";
import { identityHold, gone, settled } from "../server/identity-hold.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { RemoteBroadcast } from "../server/remote-screen.mjs";
import { ScreenControl } from "../server/screen.mjs";

// The owner's live screen kept reconnecting ("Checking this Mac's
// connection"), its control, sound and terminals with it: this Mac's
// Tailscale identity, kept 5 s while an agent has app access, was refreshed
// only when some check asked (as little as 1 s before it lapsed), while
// `tailscale status` takes up to 1.7 s; and any failed lookup cleared it.
// Fake clocks, timers, lookups and helpers only: no Tailscale, no screen,
// no input.

// A clock and timers the test moves by hand, in order.
function clock(start = 1000) {
  let time = start;
  const timers = [];
  const setTimer = (fn, ms) => {
    const timer = { at: time + Math.max(0, ms), fn, cleared: false };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer) => {
    if (timer) timer.cleared = true;
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  // Moves time to `end`, running each timer at its time, and `each` every
  // `every` ms of it.
  const run = async (ms, { every = 100, each = () => {} } = {}) => {
    const end = time + ms;
    let next = time + every;
    for (;;) {
      const due = timers.filter((t) => !t.cleared).sort((a, b) => a.at - b.at)[0];
      const at = Math.min(due?.at ?? Infinity, next);
      if (at > end) break;
      time = at;
      if (due && due.at === at) {
        due.cleared = true;
        due.fn();
        await flush();
      } else {
        await flush();
        each(time);
        next += every;
      }
    }
    time = end;
    await flush();
  };
  const pending = () => timers.filter((t) => !t.cleared).length;
  return { now: () => time, setTimer, clearTimer, run, flush, pending };
}
const status = (extra = {}) => ({
  BackendState: "Running",
  Self: { ID: "nHost" },
  Peer: { phone: { ID: "nPhone", UserID: 42, OS: "iOS" } },
  ...extra,
});
function world({ latency = 170, maxAgeMs } = {}) {
  const c = clock();
  let active = true, answer = "ok", lookups = 0;
  const owner = { id: "owner", kind: "device", scopes: ["admin"], expiresAt: 1e12, tailscale: { nodeId: "nPhone", userId: "42" } };
  const agent = { id: "agent", kind: "agent", policy: { browser: true, screen: "apps" }, expiresAt: 1e12,
    browserAppApprover: { nodeId: "nPhone", userId: "42", clientId: "owner" } };
  const trusted = new WeakSet();
  const guard = createBrowserHostGuard({
    clients: () => [owner, ...(active ? [agent] : [])],
    trusted: (req) => trusted.has(req),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...(maxAgeMs ? { maxAgeMs } : {}),
    lookup: () => {
      lookups++;
      const reply = answer;
      return new Promise((resolve, reject) =>
        c.setTimer(() => {
          if (reply === "fail") reject(Error("tailscale status timed out"));
          else if (reply === "stopped") resolve(status({ BackendState: "Stopped" }));
          else resolve(status());
        }, typeof latency === "function" ? latency() : latency),
      );
    },
  });
  const phone = () => {
    const req = { method: "GET", originalUrl: "/ws/screen", headers: {},
      reachIdentity: { nodeId: "nPhone", userId: "42", validUntil: 1e12, tagged: false } };
    trusted.add(req);
    return req;
  };
  // What a live connection asks with every frame: is the owner's phone let in?
  const allowed = () => guard.allows(phone(), owner);
  const start = async () => {
    const first = guard.refresh();
    await c.run(2000);
    await first;
  };
  return { c, guard, allowed, start, lookups: () => lookups,
    setActive: (v) => { active = v; }, setAnswer: (v) => { answer = v; } };
}

test("lookups as slow as 1.7 s never let the host identity lapse between them", async () => {
  // Measured on the owner's Mac: median 171 ms, p90 802 ms, max 1711 ms.
  const pattern = [171, 802, 1711, 171, 1711, 400, 1711, 1711];
  let n = 0;
  const w = world({ latency: () => pattern[n++ % pattern.length] });
  await w.start();
  let checks = 0;
  await w.c.run(60000, {
    every: 50,
    each: (t) => {
      checks++;
      assert.equal(w.guard.fresh(), true, `fresh at ${t}`);
      assert.equal(w.allowed(), true, `the phone let in at ${t}`);
    },
  });
  assert.ok(checks >= 1199);
  // About one lookup every 2 s (3 s before each 5 s copy lapses).
  assert.ok(w.lookups() >= 20 && w.lookups() <= 40, `${w.lookups()} lookups in a minute`);
});

test("a failed lookup keeps a copy still within its lifetime, tries again soon, and never serves past it", async () => {
  const w = world();
  await w.start();
  w.setAnswer("fail");
  let lapsedAt = 0;
  await w.c.run(8000, {
    every: 50,
    each: (t) => {
      if (!w.guard.fresh() && !lapsedAt) lapsedAt = t;
      // Stale identity never lets anyone in.
      if (lapsedAt) assert.equal(w.allowed(), false, `refused at ${t}`);
      else assert.equal(w.allowed(), true, `served at ${t}`);
    },
  });
  assert.ok(lapsedAt > 0, "the copy lapses at its own expiry");
  const failedTries = w.lookups();
  assert.ok(failedTries >= 8, `tried again ${failedTries} times`);
  // Non-forced callers get nothing once it lapsed; a refresh then fails.
  await assert.rejects(Promise.all([w.guard.refresh(), w.c.run(500)]), { status: 503 });
  // Tailscale answers again: back within a retry.
  w.setAnswer("ok");
  await w.c.run(2500);
  assert.equal(w.guard.fresh(), true);
  assert.equal(w.allowed(), true);
});

test("Tailscale's own answer that the identity is gone clears the copy at once", async () => {
  const w = world();
  await w.start();
  assert.equal(w.guard.fresh(), true);
  w.setAnswer("stopped");
  // The next lookup (on the guard's timer) says Tailscale stopped: refused
  // from that moment, though the copy had time left.
  let refusedAt = 0;
  const lookupsBefore = w.lookups();
  await w.c.run(3000, { every: 20, each: (t) => { if (!refusedAt && !w.allowed()) refusedAt = t; } });
  assert.ok(w.lookups() > lookupsBefore);
  assert.ok(refusedAt > 0);
  assert.equal(w.guard.fresh(), false);
});

test("a forced refresh (an invitation) needs a new answer; others get the still-valid copy", async () => {
  const w = world();
  await w.start();
  await w.c.run(500); // the timer's lookup lands
  w.setAnswer("fail");
  await w.c.run(2000); // the next ones fail; the copy still has time
  assert.equal(w.guard.fresh(), true);
  const plain = w.guard.refresh();
  const forced = w.guard.refresh({ force: true }).then(() => "answered", (e) => e.status);
  await w.c.run(500);
  assert.equal(await plain, "nHost");
  assert.equal(await forced, 503);
});

test("the guard's timer runs only while an agent has app access, and stops with Reach", async () => {
  const w = world();
  await w.start();
  const before = w.lookups();
  w.setActive(false);
  await w.c.run(20000);
  assert.ok(w.lookups() <= before + 1, "no agent: no more lookups");
  assert.equal(w.c.pending(), 0);
  w.setActive(true);
  const again = w.guard.refresh();
  await w.c.run(1000);
  await again;
  await w.c.run(10000);
  assert.ok(w.lookups() >= before + 4, "an agent again: on its timer again");
  w.guard.stop();
  const stopped = w.lookups();
  await w.c.run(20000);
  assert.equal(w.lookups(), stopped);
});

test("a hold says how long it may wait, and its end", () => {
  let time = 0, rechecks = 0;
  const hold = identityHold({ within: 5000, now: () => time, recheck: () => rechecks++ });
  assert.equal(hold.held, false);
  assert.equal(hold.hold("Checking this Mac's connection. Reconnecting…"), true);
  time = 4999;
  assert.equal(hold.hold("again"), true);
  assert.deepEqual(hold.lapse, { ms: 4999, why: "Checking this Mac's connection. Reconnecting…" });
  time = 5000;
  assert.equal(hold.hold(), false, "over at the deadline");
  assert.deepEqual(hold.clear(), { ms: 5000, why: "Checking this Mac's connection. Reconnecting…" });
  assert.equal(hold.clear(), null);
  assert.equal(gone(true), false);
  assert.equal(gone(null), false, "held is kept");
  assert.equal(gone(false), true);
  assert.equal(gone(undefined), true);
});

test("settled waits out a hold for its answer, or for the connection to go", async () => {
  let answer = null, alive = true;
  const waiting = settled(() => answer, () => alive, 5);
  await new Promise((r) => setTimeout(r, 30));
  answer = true;
  assert.equal(await waiting, true);
  answer = null;
  const leaving = settled(() => answer, () => alive, 5);
  alive = false;
  assert.equal(await leaving, null);
});

// Desktop control, with Tailscale's word late on the Mac for a moment.
const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out waiting for state");
};
const phoneClient = { id: "phone", kind: "device", name: "Phone", scopes: ["admin", "screen"] };
function control({ holdFor = 5000 } = {}) {
  const lease = new ScreenControl();
  lease.acquire(phoneClient, true);
  const state = { client: phoneClient, interruption: "", rechecks: 0 };
  const helped = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, sent: [],
    send(m) { this.sent.push(JSON.parse(m)); },
    close(code) { this.readyState = 2; this.closedWith = code; },
  });
  desktopConnection(ws, {
    config: { screen: true },
    auth: {
      verify: () => state.client,
      interruption: () => state.interruption,
      recheck: () => { state.rechecks++; },
    },
    control: lease, scanner: null, holdFor,
    create: async () => ({ async send(action) { helped.push(action); return { ok: true }; }, stop() {} }),
  });
  const message = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  message({ type: "auth", token: "T", display: "primary" });
  let id = 0;
  const input = (action) => message({ type: "input", id: ++id, action });
  const ack = (n) => ws.sent.find((m) => m.type === "ack" && m.id === n);
  const lapse = () => {
    state.client = null;
    state.interruption = "Checking this Mac's connection. Reconnecting…";
  };
  const confirm = () => {
    state.client = phoneClient;
    state.interruption = "";
  };
  const end = () => { ws.readyState = 3; ws.emit("close", 1000); };
  return { ws, state, helped, input, ack, lapse, confirm, end, lease };
}

test("desktop control held through a 1.7 s lapse: nothing runs on the stale identity, nothing closes", async () => {
  const c = control();
  await until(() => c.ws.sent.some((m) => m.type === "ready"));
  c.lapse();
  c.input({ type: "click", x: 0.5, y: 0.5 }); // 1
  c.input({ type: "text", text: "hi" }); // 2
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(c.ws.closedWith, undefined, "not closed");
  assert.deepEqual(c.helped.map((a) => a.type), ["heartbeat"], "nothing ran while held");
  assert.equal(c.ack(1), undefined);
  assert.ok(c.state.rechecks >= 1, "Tailscale was asked again");
  c.confirm();
  await until(() => c.ack(2));
  // They waited past a second: dropped, not run late (a tap at a screen
  // that changed). Control goes on.
  assert.equal(c.ack(1).ok, false);
  assert.equal(c.ack(2).ok, false);
  assert.deepEqual(c.helped.map((a) => a.type), ["heartbeat"]);
  c.input({ type: "click", x: 0.5, y: 0.5 }); // 3
  await until(() => c.ack(3));
  assert.equal(c.ack(3).ok, true);
  assert.equal(c.ws.closedWith, undefined);
  assert.equal(c.lease.holder()?.clientId, "phone");
  c.end();
});

test("a lapse that doesn't end closes control after the hold, retryable, having run nothing", async () => {
  const c = control({ holdFor: 400 });
  await until(() => c.ws.sent.some((m) => m.type === "ready"));
  c.lapse();
  c.input({ type: "click", x: 0.5, y: 0.5 });
  c.input({ type: "key", key: "enter" });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(c.ws.closedWith, undefined, "held, not closed yet");
  await until(() => c.ws.closedWith !== undefined, 2000);
  assert.equal(c.ws.closedWith, 1012);
  assert.deepEqual(c.ws.sent.at(-1), {
    type: "error",
    error: "Checking this Mac's connection. Reconnecting…",
    retryable: true,
  });
  assert.deepEqual(c.helped.map((a) => a.type), ["heartbeat"], "nothing ran");
  // A refusal on a fresh answer still ends control at once.
  const d = control();
  await until(() => d.ws.sent.some((m) => m.type === "ready"));
  d.state.client = null;
  d.input({ type: "click", x: 0.5, y: 0.5 });
  await until(() => d.ws.closedWith !== undefined, 500);
  assert.equal(d.ws.closedWith, 4001);
  d.end();
});

test("a live screen viewer held a moment is kept, sent nothing, and goes on", async () => {
  const asks = [];
  const group = new RemoteBroadcast(
    async () => () => ({ next: async (c) => (asks.push(c), Buffer.from(c === "key" ? "KEY" : "delta")), stop() {} }),
    { fps: 60, format: "jpeg", quality: "high", bitrate: 1e6 },
  );
  let held = false;
  const socket = () => ({ readyState: 1, bufferedAmount: 0, sent: [], send(m) { this.sent.push(m); }, close() { this.readyState = 3; } });
  const viewer = socket();
  const frames = () => viewer.sent.filter((m) => Buffer.isBuffer(m));
  group.add(viewer, () => (held ? null : true));
  await until(() => frames().length > 0);
  const ack = () => { for (const m of frames()) try { group.ack(viewer, m.readUInt32BE(0)); } catch {} };
  ack();
  held = true;
  await new Promise((r) => setTimeout(r, 30));
  const before = frames().length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(frames().length, before, "nothing sent while held");
  assert.ok(group.viewers.has(viewer), "kept");
  held = false;
  await until(() => frames().length > before);
  group.remove(viewer);
});
