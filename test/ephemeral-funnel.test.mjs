import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EphemeralFunnel, exactBackgroundFunnel } from "../scripts/ephemeral-funnel.mjs";
import { FunnelLeaseWorker } from "../scripts/funnel-lease-worker.mjs";

const origin = "https://mac.tail1.ts.net";
const target = "unix:/tmp/reach-test/agent";
const host = "mac.tail1.ts.net:443";
const route = (proxy = target) => ({
  TCP: { 443: { HTTPS: true } },
  Web: { [host]: { Handlers: { "/": { Proxy: proxy } } } },
  AllowFunnel: { [host]: true },
});
const privateRoute = {
  TCP: { 8443: { HTTPS: true } },
  Web: { "mac.tail1.ts.net:8443": { Handlers: { "/": { Proxy: "unix:/tmp/reach-test/private" } } } },
};
const closed = { open: false, until: 0, reason: null };
function clock() {
  let current = 100000;
  let next = 0;
  const timers = new Map();
  const later = (run, ms) => { const id = ++next; timers.set(id, { run, at: current + ms }); return id; };
  return {
    now: () => current,
    later, cancel: (id) => timers.delete(id),
    advance(ms) {
      const until = current + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        current = next[1].at;
        timers.delete(next[0]);
        next[1].run();
      }
      current = until;
    },
  };
}
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  child.finish = () => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); };
  return child;
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ephemeral-"));
  const file = path.join(dir, "funnel-owner.json");
  const timer = clock();
  let active = closed, config = structuredClone(privateRoute), monitor;
  const runs = [], workers = [], reports = [], changes = [];
  // The daemon: a background Funnel appears when switched on and goes when switched off.
  const withFunnel = () => ({ TCP: { ...privateRoute.TCP, ...route().TCP }, Web: { ...privateRoute.Web, ...route().Web }, AllowFunnel: route().AllowFunnel });
  const link = new EphemeralFunnel({
    origin, target, file,
    window: () => active,
    inspect: async () => config,
    run: async (args) => { runs.push(args); config = args.includes("off") ? structuredClone(privateRoute) : withFunnel(); },
    spawnWorker: () => {
      const child = fakeChild();
      child.connected = true;
      child.messages = [];
      child.send = (message, done) => { child.messages.push(message); done?.(null); };
      child.disconnect = () => { child.connected = false; queueMicrotask(() => child.finish()); };
      workers.push(child);
      return child;
    },
    now: timer.now,
    every: (run) => { monitor = run; return { unref() {} }; },
    clearEvery: () => { monitor = null; },
    delay: async (ms) => { timer.advance(ms); },
    report: (message) => reports.push(message),
    changed: (open) => changes.push(open),
    ...options,
  });
  t.after(async () => { await link.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    link, file, runs, workers, reports, changes, timer, withFunnel,
    setWindow: (value) => { active = value; },
    setConfig: (value) => { config = value; },
    getConfig: () => config,
    getMonitor: () => monitor,
  };
}
const on = ["funnel", "--bg", "--https=443", target], off = ["funnel", "--https=443", "off"];

test("idle startup never opens Funnel or creates a persistent route", async (t) => {
  const f = fixture(t);
  assert.equal(await f.link.start(), false);
  await f.link.sync();
  assert.equal(f.workers.length, 0);
  assert.deepEqual(f.runs, []);
  assert.equal(fs.existsSync(f.file), false);
  await assert.rejects(f.link.ensure(), /ended/);
  assert.deepEqual(f.getConfig(), privateRoute);
});

test("an active invitation switches the background route on, leases the janitor, and switches it off on revocation", async (t) => {
  const f = fixture(t);
  await f.link.start();
  const until = f.timer.now() + 60000;
  f.setWindow({ open: true, until, reason: "invitation" });
  assert.equal(await f.link.ensure(), true);
  assert.deepEqual(f.runs, [on], "the route is daemon state, switched on once");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { version: 1, origin, target });
  assert.equal(f.workers.length, 1);
  const child = f.workers[0];
  assert.equal(child.messages[0].type, "init");
  assert.equal(child.messages[0].target, target);
  assert.equal(child.messages[0].origin, origin);
  assert.equal(child.messages[0].windowUntil, until);
  assert.equal(child.messages[0].leaseUntil, 105000);
  assert.ok(f.reports.some((m) => /Public link open/.test(m)));
  // Ticks while live renew the lease without asking the daemon each time.
  const inspections = [];
  f.link.inspect = async () => { inspections.push(f.timer.now()); return f.getConfig(); };
  for (let i = 0; i < 5; i++) { f.timer.advance(1000); await f.link.sync(); }
  assert.equal(child.messages.filter((m) => m.type === "lease").length >= 5, true);
  assert.equal(inspections.length, 0, "no status read for ten seconds while live");
  f.timer.advance(6000);
  await f.link.sync();
  assert.equal(inspections.length, 1, "then one read");
  f.setWindow(closed);
  assert.equal(await f.link.sync(), false);
  assert.equal(child.connected, false);
  assert.equal(child.messages.at(-1).type, "stop");
  assert.deepEqual(f.runs, [on, off]);
  assert.deepEqual(f.getConfig(), privateRoute);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.link.live, false);
  assert.deepEqual(f.changes, [true, false], "the launcher hears the route come up and go, once each");
});

test("a failed status read while live never tears the route down", async (t) => {
  const f = fixture(t);
  f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "session" });
  await f.link.start();
  await f.link.ensure();
  f.link.inspect = async () => { throw Error("tailscale: unexpected EOF"); };
  f.timer.advance(11000);
  assert.equal(await f.link.sync(), true, "still live");
  assert.deepEqual(f.runs, [on]);
  assert.ok(f.reports.includes("tailscale: unexpected EOF"));
  assert.equal(f.workers[0].connected, true);
});

test("a route that vanished from the daemon is switched on again, once a second at most", async (t) => {
  const f = fixture(t);
  f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "session" });
  await f.link.start();
  await f.link.ensure();
  f.setConfig(structuredClone(privateRoute));
  f.timer.advance(11000);
  await f.link.sync();
  assert.deepEqual(f.runs, [on, on]);
  assert.equal(f.link.live, true);
});

test("expiry switches the route off and leases never outlive the active credential deadline", async (t) => {
  const f = fixture(t);
  const until = f.timer.now() + 1200;
  f.setWindow({ open: true, until, reason: "session" });
  await f.link.start();
  await f.link.ensure();
  assert.equal(f.workers[0].messages[0].leaseUntil, until);
  f.timer.advance(1200);
  await f.link.sync();
  assert.equal(f.workers[0].connected, false);
  assert.deepEqual(f.runs.at(-1), off);
  assert.equal(f.link.live, false);
  await assert.rejects(f.link.ensure(), /ended/);
});

test("stop removes the monitor and switches the route off without touching private Serve", async (t) => {
  const f = fixture(t);
  f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "session" });
  await f.link.start();
  await f.link.ensure();
  await f.link.stop();
  assert.equal(f.getMonitor(), null);
  assert.deepEqual(f.getConfig(), privateRoute);
  assert.deepEqual(f.runs, [on, off]);
  assert.equal(fs.existsSync(f.file), false);
  await assert.rejects(f.link.ensure(), /stopped/);
});

test("startup removes only the exact recorded old background Funnel", async (t) => {
  const f = fixture(t);
  const oldTarget = "unix:/tmp/reach-old/public";
  f.setConfig({ ...route(oldTarget), TCP: { ...route().TCP, ...privateRoute.TCP }, Web: { ...route(oldTarget).Web, ...privateRoute.Web } });
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, origin, target: oldTarget }));
  assert.equal(await f.link.start(), false);
  assert.deepEqual(f.runs, [off]);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.getConfig(), privateRoute);
  assert.equal(f.workers.length, 0);
});

test("a recorded route of our own is kept across a restart while a window is open, retired when none is", async (t) => {
  const kept = fixture(t);
  kept.setConfig(kept.withFunnel());
  fs.writeFileSync(kept.file, JSON.stringify({ version: 1, origin, target }));
  kept.setWindow({ open: true, until: kept.timer.now() + 60000, reason: "session" });
  assert.equal(await kept.link.start(), true, "no blink on restart");
  assert.deepEqual(kept.runs, []);
  assert.equal(kept.workers.length, 1, "the janitor is leased again");
  const retired = fixture(t);
  retired.setConfig(retired.withFunnel());
  fs.writeFileSync(retired.file, JSON.stringify({ version: 1, origin, target }));
  await retired.link.start();
  assert.deepEqual(retired.runs, [off]);
  assert.equal(retired.workers.length, 0);
});

test("an exact route of our own is used as is; foreground, extra-handler and unrelated routes are never changed", async (t) => {
  const variants = [
    // Exactly ours, recorded or not: used, never recreated.
    { config: route(), record: null, outcome: "opened" },
    { config: route(), record: { version: 1, origin: "https://other.tail1.ts.net", target }, outcome: "opened" },
    // Somebody else's, or not exactly ours: left alone, reported as a conflict.
    { config: { Foreground: { other: route() } }, record: { version: 1, origin, target }, outcome: /another service/ },
    { config: route("http://127.0.0.1:9000"), record: { version: 1, origin, target }, outcome: /another service/ },
    { config: { ...route(), Web: { [host]: { Handlers: { "/": { Proxy: target }, "/other": { Proxy: target } } } } }, record: { version: 1, origin, target }, outcome: /another service/ },
    { config: { ...route(), TCP: { 443: { HTTPS: true, TerminateTLS: "other" } } }, record: { version: 1, origin, target }, outcome: /another service/ },
  ];
  for (const variant of variants) {
    const f = fixture(t, { run: async (args) => { f.runs.push(args); } });
    f.setConfig(variant.config);
    if (variant.record) fs.writeFileSync(f.file, JSON.stringify(variant.record));
    f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "invitation" });
    await f.link.start();
    const outcome = await f.link.ensure().then(() => "opened", (error) => error.message);
    if (variant.outcome === "opened") assert.equal(outcome, "opened", JSON.stringify(variant.config));
    else assert.match(outcome, variant.outcome, JSON.stringify(variant.config));
    assert.deepEqual(f.runs, [], "nothing on the port is ever changed in these cases");
    assert.deepEqual(f.getConfig(), variant.config);
  }
});

test("background ownership rejects foreground duplicates and preserves port 8443", () => {
  assert.equal(exactBackgroundFunnel(route(), origin, target), true);
  assert.equal(exactBackgroundFunnel({ ...route(), Foreground: { other: route() } }, origin, target), false);
  assert.equal(exactBackgroundFunnel({ Foreground: { other: route() } }, origin, target), false);
  assert.equal(exactBackgroundFunnel({ ...route(), Foreground: { private: privateRoute } }, origin, target), true);
});

test("an authentication window ending during route inspection cannot switch Funnel on", async (t) => {
  let finish, inspections = 0;
  const f = fixture(t, { inspect: () => new Promise((resolve) => { inspections++; finish = resolve; }) });
  await f.link.start();
  f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "invitation" });
  const pending = f.link.sync();
  f.setWindow(closed);
  finish(structuredClone(privateRoute));
  assert.equal(await pending, false);
  assert.deepEqual(f.runs, []);
  assert.equal(inspections, 1, "the state just read decides the release; no second read");
  assert.equal(f.workers[0].connected, false, "the janitor is dismissed");
  // Nothing of Reach's was ever on the port: stopping asks the daemon nothing.
  await f.link.stop();
  assert.equal(inspections, 1);
  assert.deepEqual(f.runs, []);
});

test("stopping or closing a window that never opened a route leaves the daemon alone", async (t) => {
  let inspections = 0;
  const f = fixture(t, { inspect: async () => { inspections++; return structuredClone(privateRoute); } });
  await f.link.start();
  f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "invitation" });
  f.link.run = async () => { throw Error("tailscale: unexpected EOF"); };
  assert.equal(await f.link.sync(), false, "the route could not be switched on");
  const after = inspections;
  f.setWindow(closed);
  assert.equal(await f.link.sync(), false);
  assert.equal(inspections, after + 1, "the record written before the attempt is checked against the daemon");
  assert.equal(fs.existsSync(f.file), false, "a record with no route behind it is dropped");
  await f.link.stop();
  assert.equal(inspections, after + 1, "no record and never live: nothing to release");
});

// The janitor: a lease that is not renewed switches Reach's own route off.
function janitor(timer, { ours = true } = {}) {
  const runs = [], sent = [];
  const worker = new FunnelLeaseWorker({
    target, origin,
    inspect: async () => (ours ? { TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: target } } } }, AllowFunnel: { [host]: true } } : privateRoute),
    run: async (args) => { runs.push(args); },
    send: (message) => sent.push(message),
    now: timer.now, monotonic: timer.now, later: timer.later, cancel: timer.cancel,
  });
  return { worker, runs, sent };
}

test("janitor: a lease nobody renews switches the route off after five seconds", async () => {
  const timer = clock();
  const { worker, runs, sent } = janitor(timer);
  assert.equal(worker.renew({ leaseUntil: timer.now() + 50000, windowUntil: timer.now() + 90000 }), true);
  assert.deepEqual(runs, []);
  timer.advance(4999);
  assert.deepEqual(runs, []);
  timer.advance(1);
  await worker.closed;
  assert.deepEqual(runs, [off]);
  assert.equal(worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: timer.now() + 90000 }), false);
  assert.deepEqual(sent.map((m) => m.type), ["started", "stopping", "off", "closed"]);
});

test("janitor: a quiet stop from Reach leaves the route to Reach", async () => {
  const timer = clock();
  const { worker, runs } = janitor(timer);
  worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: timer.now() + 60000 });
  await worker.stop("parent stopped");
  assert.deepEqual(runs, []);
});

test("janitor: never switches off a route that is not exactly Reach's", async () => {
  const timer = clock();
  const { worker, runs, sent } = janitor(timer, { ours: false });
  worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: timer.now() + 60000 });
  timer.advance(5000);
  await worker.closed;
  assert.deepEqual(runs, []);
  assert.ok(sent.some((m) => m.type === "off" && m.changed === false));
});

test("janitor: a queued renewal cannot revive an expired lease before its timer runs", async () => {
  for (const expired of ["lease", "session"]) {
    let wall = 100000, mono = 0;
    const runs = [];
    const worker = new FunnelLeaseWorker({
      target, origin,
      inspect: async () => ({ TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: target } } } }, AllowFunnel: { [host]: true } }),
      run: async (args) => { runs.push(args); },
      now: () => wall, monotonic: () => mono,
      later: () => 1, cancel: () => {},
    });
    worker.renew({ leaseUntil: wall + 5000, windowUntil: wall + 10000 });
    if (expired === "lease") mono = 5000;
    else wall += 10000;
    assert.equal(worker.renew({ leaseUntil: wall + 5000, windowUntil: wall + 60000 }), false);
    await worker.closed;
    assert.deepEqual(runs, [off]);
  }
});

test("janitor: obeys the absolute window end and renews only while live", async () => {
  const timer = clock();
  const { worker, runs } = janitor(timer);
  const until = timer.now() + 2500;
  worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: until });
  timer.advance(1000);
  worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: until });
  timer.advance(1500);
  await worker.closed;
  assert.deepEqual(runs, [off]);
});

test("janitor: an invalid or expired initial lease ends without touching any route", async () => {
  for (const lease of [{}, { leaseUntil: 0, windowUntil: 0 }, { leaseUntil: Infinity, windowUntil: Infinity }]) {
    const runs = [];
    const worker = new FunnelLeaseWorker({ target, origin, run: async (args) => { runs.push(args); }, inspect: async () => route() });
    assert.equal(worker.renew(lease), false);
    await worker.closed;
    assert.deepEqual(runs, []);
  }
});

// The real janitor process, with a stand-in Tailscale command line that
// reports the route as Reach's own and records being asked to switch it off.
async function realJanitor(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-worker-"));
  const cli = path.join(dir, "tailscale-test");
  const marker = path.join(dir, "calls.txt");
  const status = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: target } } } }, AllowFunnel: { [host]: true } });
  fs.writeFileSync(cli, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args) + '\\n');\nif (args.includes('status')) process.stdout.write(${JSON.stringify(status)});\nprocess.exit(0);\n`, { mode: 0o755 });
  const child = fork(fileURLToPath(new URL("../scripts/funnel-lease-worker.mjs", import.meta.url)), [], {
    env: { ...process.env, REACH_TAILSCALE: cli }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const ended = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Janitor did not close: " + errors.join(""))), 6000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
  const started = new Promise((resolve) => child.on("message", (message) => { if (message.type === "started") resolve(); }));
  child.send({ type: "init", target, origin, leaseUntil: Date.now() + (mode === "disconnect" ? 3000 : 700), windowUntil: Date.now() + 10000 });
  await started;
  if (mode === "disconnect") child.disconnect();
  await ended;
  const calls = fs.readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, [["serve", "status", "--json"], off]);
}

test("actual janitor process switches the route off on IPC disconnect", { skip: process.platform === "win32" ? "POSIX executable fixture" : false }, (t) => realJanitor(t, "disconnect"));
test("actual janitor process switches the route off when a frozen parent stops renewing", { skip: process.platform === "win32" ? "POSIX executable fixture" : false }, (t) => realJanitor(t, "frozen"));
