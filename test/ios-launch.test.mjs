import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { launchIosSmokeApp } from "./helpers/ios-launch.mjs";
import { createIosLifecycleEvidence, installIosLifecycleProbe } from "./helpers/ios-lifecycle.mjs";
import { collectIosFailureDiagnostics, commandFailureOutput, startIosLaunchLogs } from "./helpers/ios-diagnostics.mjs";

const device = "disposable-simulator", bundle = "test.reach.smoke";

test("only native background entry after arming and becoming active after pause report lifecycle progress", () => {
  const listeners = new Map(), calls = [], events = [];
  const lifecycle = installIosLifecycleProbe({ nativeCallback(plugin, method, options, callback) {
    calls.push([plugin, method, options]);
    listeners.set(options.eventName, callback);
  } }, kind => events.push(kind));
  assert.deepEqual(calls, [["App", "addListener", { eventName: "pause" }], ["App", "addListener", { eventName: "appStateChange" }]]);
  listeners.get("pause")();
  listeners.get("appStateChange")({ isActive: true });
  assert.deepEqual(events, [], "initial launch or an earlier pause cannot certify the download transition");
  lifecycle.armDownload();
  for (const state of [undefined, { isActive: false }, { isActive: true }, { isActive: "true" }])
    listeners.get("appStateChange")(state);
  assert.deepEqual(events, [], "resigning active or foregrounding without pause is insufficient");
  listeners.get("pause")({ token: "must never be retained" });
  listeners.get("pause")();
  listeners.get("appStateChange")({ isActive: false });
  assert.deepEqual(events, ["native-backgrounded"]);
  listeners.get("appStateChange")({ isActive: true, token: "must never be retained" });
  listeners.get("appStateChange")({ isActive: true });
  assert.deepEqual(events, ["native-backgrounded", "native-active"], "each native transition reports once, without payload data");
});

test("native lifecycle evidence requires download, pause and active in that order", async () => {
  const lifecycle = createIosLifecycleEvidence();
  let backgrounded = false, active = false;
  lifecycle.background.then(() => { backgrounded = true; });
  lifecycle.active.then(() => { active = true; });
  for (const kind of ["native-backgrounded", "native-active", { kind: "native-backgrounded" }]) lifecycle.event(kind);
  lifecycle.beginDownload();
  lifecycle.event("native-active");
  await Promise.resolve();
  assert.equal(backgrounded, false);
  assert.equal(active, false);
  lifecycle.event("native-backgrounded");
  await lifecycle.background;
  assert.equal(backgrounded, true);
  assert.equal(active, false);
  const snapshot = lifecycle.snapshot();
  snapshot.activeAfterBackground = true;
  assert.equal(lifecycle.snapshot().activeAfterBackground, false);
  lifecycle.event("native-active");
  await lifecycle.active;
  assert.equal(active, true);
  assert.deepEqual(lifecycle.snapshot(), { downloadRequested: true, backgrounded: true, activeAfterBackground: true });
});

// No simulator or app is started. Commands model the observed iOS behavior:
// openurl exits successfully at an Open/Cancel prompt without loading a page.
function fixture({ failures = 1, observed = false, springBoard = true, startLogs } = {}) {
  const commands = [], phases = [];
  let seen = observed, confirmation = false, launches = 0, options;
  let observe;
  const appPage = new Promise(resolve => { observe = resolve; });
  if (seen) observe();
  const sim = async (name, args, supplied = {}) => {
    if (name !== "launch") {
      commands.push({ name, args });
      return { stdout: springBoard ? "123\t0\tcom.apple.SpringBoard\n" : "" };
    }
    options = supplied;
    let last;
    // Stand in for ios-simulator.test.mjs's bounded sim() retry wrapper.
    // The orchestration under test still chooses each actual command.
    for (let attempt = 1; attempt <= supplied.attempts; attempt++) {
      if (attempt > 1) await supplied.beforeRetry?.(attempt);
      const command = typeof args === "function" ? args(attempt) : args;
      commands.push({ name, args: command });
      if (command[0] === "openurl") {
        confirmation = true;
        return { stdout: "" };
      }
      launches++;
      if (launches <= failures) {
        last = Error("did not finish within 75 s");
        continue;
      }
      seen = true;
      observe();
      return { stdout: `${bundle}: 456\n` };
    }
    throw last;
  };
  return {
    start: () => launchIosSmokeApp({ sim, device, bundle, appPage,
      pageSeen: () => seen, reached: phase => phases.push(phase), ...(startLogs ? { startLogs } : {}) }),
    commands, phases, appPage,
    state: () => ({ seen, confirmation, launches, options }),
  };
}

test("a successful initial direct launch needs no recovery reboot", async () => {
  const f = fixture({ failures: 0 });
  await f.start();
  assert.equal(f.state().seen, true);
  assert.equal(f.state().confirmation, false);
  assert.deepEqual(f.commands.map(item => item.args), [["launch", device, bundle]]);
  assert.deepEqual(f.phases, []);
});

test("a timed-out first launch reboots once and directly launches the app instead of opening a confirmation", async () => {
  const f = fixture();
  await f.start();
  assert.equal(f.state().seen, true, "successful recovery reaches the app page");
  assert.equal(f.state().confirmation, false, "a successful URL-open is only a confirmation prompt");
  assert.deepEqual(f.commands.map(item => item.args), [
    ["launch", device, bundle],
    ["shutdown", device],
    ["boot", device],
    ["bootstatus", device, "-b"],
    ["spawn", device, "launchctl", "list"],
    ["launch", "--terminate-running-process", device, bundle],
  ]);
  assert.deepEqual(f.phases, ["isolated simulator rebooted after stalled launch"]);
  assert.equal(f.state().options.limit, 75000);
  assert.equal(f.state().options.attempts, 3);
  assert.equal(f.state().options.progress, f.appPage, "the unique app page still releases a stuck simctl");
});

test("three failed launches exhaust the existing limit instead of accepting a URL confirmation", async () => {
  const f = fixture({ failures: 3 });
  await assert.rejects(f.start(), /did not finish within 75 s/);
  assert.equal(f.state().seen, false);
  assert.equal(f.state().confirmation, false);
  assert.equal(f.state().launches, 3);
  assert.equal(f.commands.filter(item => item.args[0] === "shutdown").length, 1);
});

test("a second failed launch uses the third direct attempt without another reboot", async () => {
  const f = fixture({ failures: 2 });
  await f.start();
  assert.equal(f.state().seen, true);
  assert.equal(f.state().launches, 3);
  assert.equal(f.commands.filter(item => item.args[0] === "shutdown").length, 1);
  assert.deepEqual(f.commands.filter(item => item.name === "launch").map(item => item.args), [
    ["launch", device, bundle],
    ["launch", "--terminate-running-process", device, bundle],
    ["launch", "--terminate-running-process", device, bundle],
  ]);
});

test("a page already observed prevents a recovery reboot", async () => {
  const f = fixture({ observed: true });
  await f.start();
  assert.equal(f.commands.some(item => item.args[0] === "shutdown"), false);
  assert.deepEqual(f.phases, []);
});

test("a reboot without SpringBoard fails before another app launch", async () => {
  const f = fixture({ springBoard: false });
  await assert.rejects(f.start(), /our rebooted simulator runs SpringBoard/);
  assert.equal(f.state().launches, 1);
  assert.equal(f.state().confirmation, false);
  assert.deepEqual(f.phases, []);
});

test("launch observation stops on success and preserves the original failed launch", async () => {
  for (const fails of [false, true]) {
    const stops = [], original = Error("original launch failure");
    const operation = launchIosSmokeApp({ device, bundle,
      startLogs: identities => {
        assert.deepEqual(identities, { device, bundle });
        return { stop: options => stops.push(options) };
      },
      sim: async () => { if (fails) throw original; return { stdout: "started" }; },
    });
    if (fails) await assert.rejects(operation, error => error === original);
    else assert.deepEqual(await operation, { stdout: "started" });
    assert.deepEqual(stops, fails ? [{ retain: true }, undefined] : [undefined]);
  }
});

test("each existing launch retry gets a fresh observer after recovery", async () => {
  const observers = [];
  const f = fixture({ startLogs: () => {
    const stops = [];
    observers.push(stops);
    return { stop: options => stops.push(options) };
  } });
  await f.start();
  assert.deepEqual(observers, [[{ retain: true }], [undefined]]);
  assert.equal(f.state().launches, 2);
});

// Diagnostic checks use fake commands and disposable files only. They never
// connect to the host's Simulator service or read its real log directories.
const diagnosticDevice = "11111111-2222-4333-8444-555555555555";
async function diagnosticHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ios-diagnostics-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test("failure diagnostics query only the exact simulator and bundle within the existing deadline", async t => {
  const home = await diagnosticHome(t);
  for (const budget of [5000, 60000]) {
    const calls = [], deadline = Date.now() + budget;
    const result = await collectIosFailureDiagnostics({ home, device: diagnosticDevice, bundle, deadline,
      run: async (command, args, limit) => {
        calls.push({ command, args, limit });
        return { stdout: args.includes("log") ? "l".repeat(70000) : `12\t0\tUIKitApplication:${bundle}\n34\t0\tother.bundle\n` };
      },
    });
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.command, "xcrun");
      if (call.args[1] === "appinfo") assert.deepEqual(call.args, ["simctl", "appinfo", diagnosticDevice, bundle]);
      else assert.deepEqual(call.args.slice(0, 3), ["simctl", "spawn", diagnosticDevice]);
      assert.ok(call.limit > 0 && call.limit <= Math.min(budget, 10000));
      assert.ok(!call.args.some(arg => ["all", "booted", "diagnose", "launch", "shutdown"].includes(arg)));
    }
    assert.equal(calls.find(call => call.args.includes("log")).args.at(-1), `eventMessage CONTAINS[c] "${bundle}"`);
    assert.equal(result.logs.stdout.length, 65536);
    assert.equal(result.processes.stdout, `12\t0\tUIKitApplication:${bundle}`);
    assert.equal(result.installedApp.ok, true);
  }
});

test("crash evidence must match both bundle and simulator and never scans host crash reports", async t => {
  const home = await diagnosticHome(t);
  const folder = path.join(home, "Library", "Developer", "CoreSimulator", "Devices", diagnosticDevice, "data", "Library", "Logs", "CrashReporter");
  const hostFolder = path.join(home, "Library", "Logs", "DiagnosticReports");
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(hostFolder, { recursive: true });
  const report = (owner, device, note) => JSON.stringify({ bundleID: owner }) + "\n" + JSON.stringify({
    bundleInfo: { CFBundleIdentifier: owner }, coalitionName: `com.apple.CoreSimulator.SimDevice.${device}`,
    exception: { signal: "SIGABRT" }, note,
  });
  await fs.writeFile(path.join(folder, "App-owned.ips"), report(bundle, diagnosticDevice, "x".repeat(70000)));
  await fs.writeFile(path.join(folder, "App-other-bundle.ips"), report("another.bundle", diagnosticDevice, "UNRELATED BUNDLE"));
  await fs.writeFile(path.join(folder, "App-other-device.ips"), report(bundle, "99999999-2222-4333-8444-555555555555", "UNRELATED DEVICE"));
  await fs.writeFile(path.join(hostFolder, "App-host.ips"), report(bundle, diagnosticDevice, "HOST CRASH REPORT"));
  const result = await collectIosFailureDiagnostics({ home, device: diagnosticDevice, bundle, deadline: Date.now() + 5000, run: async () => ({ stdout: "" }) });
  assert.equal(result.crashes.reports.length, 1);
  assert.match(result.crashes.reports[0].file, /App-owned\.ips$/);
  assert.match(result.crashes.reports[0].content, /SIGABRT/);
  assert.equal(result.crashes.reports[0].content.length, 65536);
  assert.equal(result.crashes.reports[0].truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /UNRELATED BUNDLE|UNRELATED DEVICE|HOST CRASH REPORT/);
});

test("missing identities, unsafe selectors and an exhausted budget never start diagnostics", async () => {
  for (const input of [
    { device: undefined, bundle },
    { device: "booted", bundle },
    { device: diagnosticDevice, bundle: 'bad" OR TRUEPREDICATE' },
    { device: diagnosticDevice, bundle, deadline: Date.now() - 1 },
  ]) {
    const result = await collectIosFailureDiagnostics({ deadline: Date.now() + 1000, ...input, run: () => assert.fail("no command may run") });
    assert.ok(result.skipped);
  }
});

test("stalled diagnostic commands return partial evidence at the existing deadline", async t => {
  const home = await diagnosticHome(t);
  const result = await collectIosFailureDiagnostics({ home, device: diagnosticDevice, bundle, deadline: Date.now() + 100,
    run: () => new Promise(() => {}),
  });
  assert.equal(result.timedOut, true);
  for (const field of ["logs", "processes", "installedApp"]) {
    assert.equal(result[field].timedOut, true);
    assert.match(result[field].error, /did not finish within the existing time budget/);
    assert.equal(result[field].pending, undefined);
  }
});

test("diagnostic collection errors stay evidence and do not throw over the original launch failure", async t => {
  const home = await diagnosticHome(t), original = Error("original simctl launch timed out");
  const problem = Object.assign(Error("diagnostic service refused"), { stdout: "o".repeat(9000), stderr: "e".repeat(9000) });
  let result;
  await assert.rejects(Promise.reject(original).finally(async () => {
    result = await collectIosFailureDiagnostics({ home, device: diagnosticDevice, bundle, deadline: Date.now() + 5000,
      run: async () => { throw problem; },
    });
  }), error => error === original);
  assert.equal(result.logs.error, "diagnostic service refused");
  assert.equal(result.processes.error, "diagnostic service refused");
  assert.equal(result.logs.stdout.length, 8192);
  assert.equal(result.logs.stderr.length, 8192);
  assert.deepEqual(commandFailureOutput(problem), { stdout: "o".repeat(8192), stderr: "e".repeat(8192) });
});

// Modeled log processes test the evidence harness only, not an iOS launch.
function logProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    queueMicrotask(() => { child.signalCode = signal; child.emit("close", null, signal); });
  };
  return child;
}

test("live launch evidence is scoped, bounded and retained only for its failed launch", async t => {
  const home = await diagnosticHome(t), child = logProcess(), calls = [];
  const logs = startIosLaunchLogs({ device: diagnosticDevice, bundle, start: (...args) => { calls.push(args); return child; } });
  assert.deepEqual(calls[0], ["xcrun", ["simctl", "spawn", diagnosticDevice, "log", "stream", "--style", "compact", "--level", "info", "--predicate", `eventMessage CONTAINS[c] "${bundle}"`], { stdio: ["ignore", "pipe", "pipe"] }]);
  child.stdout.write("x".repeat(70000) + " exact launch error");
  child.stderr.write("e".repeat(9000));
  logs.stop({ retain: true });
  logs.stop();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  const result = await collectIosFailureDiagnostics({ home, device: diagnosticDevice, bundle, deadline: Date.now() - 1, run: () => assert.fail("no new commands after deadline") });
  assert.equal(result.liveLogs.stdout.length, 65536);
  assert.match(result.liveLogs.stdout, /exact launch error$/);
  assert.equal(result.liveLogs.stderr.length, 8192);
  assert.equal(result.liveLogs.truncated, true);
  assert.equal(result.liveLogs.stopped, true);
  const consumed = await collectIosFailureDiagnostics({ home, device: diagnosticDevice, bundle, deadline: Date.now() - 1 });
  assert.equal(consumed.liveLogs, undefined);
});

test("a log observer failure remains diagnostic evidence and cannot hide a launch failure", async () => {
  const original = Error("observer unavailable");
  const logs = startIosLaunchLogs({ device: diagnosticDevice, bundle, start: () => { throw original; } });
  logs.stop({ retain: true });
  const result = await collectIosFailureDiagnostics({ device: diagnosticDevice, bundle, deadline: Date.now() - 1 });
  assert.equal(result.liveLogs.error, original.message);
  for (const input of [{ device: "booted", bundle }, { device: diagnosticDevice, bundle: 'bad" OR TRUEPREDICATE' }]) {
    startIosLaunchLogs({ ...input, start: () => assert.fail("unsafe identities cannot start a log process") }).stop();
  }
});

test("restarting the observer preserves earlier launch evidence within the same bounds", async () => {
  const first = logProcess();
  const logs = startIosLaunchLogs({ device: diagnosticDevice, bundle, start: () => first });
  first.stdout.write("first failed attempt\n");
  logs.stop({ retain: true });
  const second = logProcess();
  const retry = startIosLaunchLogs({ device: diagnosticDevice, bundle, start: () => second });
  second.stdout.write("second failed attempt\n");
  retry.stop({ retain: true });
  const result = await collectIosFailureDiagnostics({ device: diagnosticDevice, bundle, deadline: Date.now() - 1 });
  assert.equal(result.liveLogs.stdout, "first failed attempt\nsecond failed attempt\n");
  assert.equal(result.liveLogs.captures, 2);
});

test("a live log observer stops at its own bound without changing launch limits", async () => {
  const child = logProcess();
  const logs = startIosLaunchLogs({ device: diagnosticDevice, bundle, limit: 10, start: () => child });
  await new Promise(resolve => setTimeout(resolve, 30));
  logs.stop({ retain: true });
  assert.deepEqual(child.signals, ["SIGTERM"]);
  const result = await collectIosFailureDiagnostics({ device: diagnosticDevice, bundle, deadline: Date.now() - 1 });
  assert.equal(result.liveLogs.timedOut, true);
});
