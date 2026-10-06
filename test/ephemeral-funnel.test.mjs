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
  const runs = [], workers = [], reports = [];
  const link = new EphemeralFunnel({
    origin, target, file,
    window: () => active,
    inspect: async () => config,
    run: async (args) => { runs.push(args); config = structuredClone(privateRoute); },
    spawnWorker: () => {
      const child = fakeChild();
      child.connected = true;
      child.messages = [];
      child.send = (message, done) => {
        child.messages.push(message);
        if (message.type === "init") config = { ...privateRoute, Foreground: { lease: route() } };
        done?.(null);
      };
      child.disconnect = () => {
        child.connected = false;
        config = structuredClone(privateRoute);
        queueMicrotask(() => child.finish());
      };
      workers.push(child);
      return child;
    },
    now: timer.now,
    every: (run) => { monitor = run; return { unref() {} }; },
    clearEvery: () => { monitor = null; },
    delay: async (ms) => { timer.advance(ms); },
    report: (message) => reports.push(message),
    ...options,
  });
  t.after(async () => { await link.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    link, file, runs, workers, reports, timer,
    setWindow: (value) => { active = value; },
    setConfig: (value) => { config = value; },
    getConfig: () => config,
    getMonitor: () => monitor,
  };
}

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

test("active invitation waits for its verified foreground route and closes on revocation", async (t) => {
  const f = fixture(t);
  await f.link.start();
  const until = f.timer.now() + 60000;
  f.setWindow({ open: true, until, reason: "invitation" });
  assert.equal(await f.link.ensure(), true);
  assert.equal(f.workers.length, 1);
  const child = f.workers[0];
  assert.equal(child.messages[0].type, "init");
  assert.equal(child.messages[0].target, target);
  assert.equal(child.messages[0].windowUntil, until);
  assert.equal(child.messages[0].leaseUntil, 105000);
  assert.deepEqual(f.runs, [], "foreground worker owns route lifetime");
  f.setWindow(closed);
  assert.equal(await f.link.sync(), false);
  assert.equal(child.connected, false);
  assert.equal(child.messages.at(-1).type, "stop");
  assert.deepEqual(f.getConfig(), privateRoute);
  assert.equal(f.link.live, false);
});

test("expiry stops Funnel and leases never outlive the active credential deadline", async (t) => {
  const f = fixture(t);
  const until = f.timer.now() + 1200;
  f.setWindow({ open: true, until, reason: "session" });
  await f.link.start();
  await f.link.ensure();
  assert.equal(f.workers[0].messages[0].leaseUntil, until);
  f.timer.advance(1200);
  await f.link.sync();
  assert.equal(f.workers[0].connected, false);
  assert.equal(f.link.live, false);
  await assert.rejects(f.link.ensure(), /ended/);
});

test("stop removes the monitor and route without touching private Serve", async (t) => {
  const f = fixture(t);
  f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "session" });
  await f.link.start();
  await f.link.ensure();
  await f.link.stop();
  assert.equal(f.getMonitor(), null);
  assert.deepEqual(f.getConfig(), privateRoute);
  assert.deepEqual(f.runs, []);
  await assert.rejects(f.link.ensure(), /stopped/);
});

test("startup removes only the exact recorded old background Funnel", async (t) => {
  const f = fixture(t);
  const oldTarget = "unix:/tmp/reach-old/public";
  f.setConfig({ ...route(oldTarget), TCP: { ...route().TCP, ...privateRoute.TCP }, Web: { ...route(oldTarget).Web, ...privateRoute.Web } });
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, origin, target: oldTarget }));
  assert.equal(await f.link.start(), false);
  assert.deepEqual(f.runs, [["funnel", "--https=443", "off"]]);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.getConfig(), privateRoute);
  assert.equal(f.workers.length, 0);
});

test("same-target recorded persistent Funnel is also retired at startup", async (t) => {
  const f = fixture(t);
  f.setConfig(route());
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, origin, target }));
  await f.link.start();
  assert.deepEqual(f.runs, [["funnel", "--https=443", "off"]]);
  assert.equal(f.workers.length, 0);
});

test("unrecorded, foreground, extra-handler, and unrelated routes are never changed", async (t) => {
  const variants = [
    { config: route(), record: null },
    { config: { Foreground: { other: route() } }, record: { version: 1, origin, target } },
    { config: route("http://127.0.0.1:9000"), record: { version: 1, origin, target } },
    { config: route(), record: { version: 1, origin: "https://other.tail1.ts.net", target } },
    { config: { ...route(), Web: { [host]: { Handlers: { "/": { Proxy: target }, "/other": { Proxy: target } } } } }, record: { version: 1, origin, target } },
    { config: { ...route(), TCP: { 443: { HTTPS: true, TerminateTLS: "other" } } }, record: { version: 1, origin, target } },
  ];
  for (const variant of variants) {
    const f = fixture(t);
    f.setConfig(variant.config);
    if (variant.record) fs.writeFileSync(f.file, JSON.stringify(variant.record));
    f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "invitation" });
    await f.link.start();
    await assert.rejects(f.link.ensure(), /another service/);
    assert.deepEqual(f.runs, []);
    assert.equal(f.workers.length, 0);
    assert.deepEqual(f.getConfig(), variant.config);
  }
});

test("background ownership rejects foreground duplicates and preserves port 8443", () => {
  assert.equal(exactBackgroundFunnel(route(), origin, target), true);
  assert.equal(exactBackgroundFunnel({ ...route(), Foreground: { other: route() } }, origin, target), false);
  assert.equal(exactBackgroundFunnel({ Foreground: { other: route() } }, origin, target), false);
  assert.equal(exactBackgroundFunnel({ ...route(), Foreground: { private: privateRoute } }, origin, target), true);
});

test("an authentication window ending during route inspection cannot spawn Funnel", async (t) => {
  let finish;
  const f = fixture(t, { inspect: () => new Promise((resolve) => { finish = resolve; }) });
  await f.link.start();
  f.setWindow({ open: true, until: f.timer.now() + 60000, reason: "invitation" });
  const pending = f.link.sync();
  f.setWindow(closed);
  finish({});
  assert.equal(await pending, false);
  assert.equal(f.workers.length, 0);
});

test("watchdog expires without parent renewal and escalates after one second", async () => {
  const timer = clock();
  const child = fakeChild();
  const args = [];
  const worker = new FunnelLeaseWorker({
    target, spawnFunnel: (value) => { args.push(value); return child; },
    now: timer.now, monotonic: timer.now, later: timer.later, cancel: timer.cancel,
  });
  assert.equal(worker.renew({ leaseUntil: timer.now() + 50000, windowUntil: timer.now() + 90000 }), true);
  assert.deepEqual(args, [["funnel", "--https=443", target]]);
  timer.advance(4999);
  assert.deepEqual(child.signals, []);
  timer.advance(1);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: timer.now() + 90000 }), false);
  timer.advance(1000);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.finish();
  await worker.closed;
});

test("a queued renewal cannot revive an expired lease before its timer runs", async () => {
  for (const expired of ["lease", "session"]) {
    let wall = 100000, mono = 0;
    const child = fakeChild();
    const worker = new FunnelLeaseWorker({
      target, spawnFunnel: () => child,
      now: () => wall, monotonic: () => mono,
      later: () => 1, cancel: () => {},
    });
    worker.renew({ leaseUntil: wall + 5000, windowUntil: wall + 10000 });
    // Deliberately do not run the old timer: simulate a queued IPC callback
    // winning the event-loop race after the deadline has already elapsed.
    if (expired === "lease") mono = 5000;
    else wall += 10000;
    assert.equal(worker.renew({ leaseUntil: wall + 5000, windowUntil: wall + 60000 }), false);
    assert.deepEqual(child.signals, ["SIGTERM"]);
    child.finish();
    await worker.closed;
  }
});

test("watchdog obeys absolute expiry and can renew only while live", async () => {
  const timer = clock();
  const child = fakeChild();
  const worker = new FunnelLeaseWorker({ target, spawnFunnel: () => child, now: timer.now, monotonic: timer.now, later: timer.later, cancel: timer.cancel });
  const until = timer.now() + 2500;
  worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: until });
  timer.advance(1000);
  worker.renew({ leaseUntil: timer.now() + 5000, windowUntil: until });
  timer.advance(1500);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.finish();
  await worker.closed;
});

test("an invalid or expired initial lease never spawns a foreground process", async () => {
  for (const lease of [{}, { leaseUntil: 0, windowUntil: 0 }, { leaseUntil: Infinity, windowUntil: Infinity }]) {
    let spawned = false;
    const worker = new FunnelLeaseWorker({ target, spawnFunnel: () => { spawned = true; } });
    assert.equal(worker.renew(lease), false);
    assert.equal(spawned, false);
    await worker.closed;
  }
});

async function realWatchdog(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-worker-"));
  const cli = path.join(dir, "tailscale-test");
  const marker = path.join(dir, "closed.txt");
  fs.writeFileSync(cli, `#!${process.execPath}\nimport fs from 'node:fs';\nprocess.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'closed');process.exit(0)});\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n');\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const child = fork(fileURLToPath(new URL("../scripts/funnel-lease-worker.mjs", import.meta.url)), [], {
    env: { ...process.env, REACH_TAILSCALE: cli }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const ended = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Watchdog did not close: " + errors.join(""))), 4000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
  const output = new Promise((resolve) => child.on("message", (message) => { if (message.type === "output") resolve(message.text); }));
  child.send({ type: "init", target, leaseUntil: Date.now() + (mode === "disconnect" ? 3000 : 700), windowUntil: Date.now() + 10000 });
  assert.deepEqual(JSON.parse(await output), ["funnel", "--https=443", target]);
  if (mode === "disconnect") child.disconnect();
  await ended;
  assert.equal(fs.readFileSync(marker, "utf8"), "closed");
}

test("actual watchdog process closes its foreground child on IPC disconnect", { skip: process.platform === "win32" ? "POSIX executable and SIGTERM fixture" : false }, (t) => realWatchdog(t, "disconnect"));
test("actual watchdog process closes when a frozen parent stops renewing", { skip: process.platform === "win32" ? "POSIX executable and SIGTERM fixture" : false }, (t) => realWatchdog(t, "freeze"));
