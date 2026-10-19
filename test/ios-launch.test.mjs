import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parse } from "yaml";
import { launchIosSmokeApp } from "./helpers/ios-launch.mjs";
import { createIosLifecycleEvidence, installIosLifecycleProbe } from "./helpers/ios-lifecycle.mjs";
import { collectIosFailureDiagnostics, commandFailureOutput, startIosLaunchLogs, iosLaunchPredicate } from "./helpers/ios-diagnostics.mjs";
import { startIosHostDiagnostics, iosHostPredicate } from "./helpers/ios-host-diagnostics.mjs";
import { iosComparisonConfiguration, iosComparisonRuntime, iosFileIdentity, iosDaemonIdentities, collectIosToolchainProvenance, captureIosBoundary } from "./helpers/ios-toolchain-provenance.mjs";

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
    assert.equal(calls.find(call => call.args.includes("log")).args.at(-1), iosLaunchPredicate(bundle));
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
  assert.deepEqual(calls[0], ["xcrun", ["simctl", "spawn", diagnosticDevice, "log", "stream", "--style", "compact", "--level", "info", "--predicate", iosLaunchPredicate(bundle)], { stdio: ["ignore", "pipe", "pipe"] }]);
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
  assert.ok(result.liveLogs.sessions[0].events.some(event => event.event === "close"), "late observer close remains in the retained evidence object");
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

test("simulator service evidence includes launch services without widening the device selector", async t => {
  const home = await diagnosticHome(t);
  const result = await collectIosFailureDiagnostics({ home, device: diagnosticDevice, bundle, deadline: Date.now() + 1000,
    run: async (command, args) => ({ stdout: args.includes("launchctl") ? `1\t0\tcom.apple.SpringBoard\n2\t0\tcom.apple.runningboardd\n3\t0\tunrelated.app\n` : "" }),
  });
  assert.match(result.processes.stdout, /SpringBoard/);
  assert.match(result.processes.stdout, /runningboardd/);
  assert.doesNotMatch(result.processes.stdout, /unrelated/);
  for (const process of ["launchd", "runningboardd", "SpringBoard", "installd", "lsd"]) assert.ok(iosLaunchPredicate(bundle).includes(`"${process}"`));
});

test("launch observations survive success and an observer callback cannot replace the launch outcome", async () => {
  const evidence = { sessions: [{ events: [{ event: "exit", code: 0 }] }] };
  let observed;
  const args = { device, bundle, sim: async () => ({ stdout: "started" }),
    startLogs: () => ({ stop() {}, snapshot: () => evidence }) };
  assert.deepEqual(await launchIosSmokeApp({ ...args, observeLogs: value => { observed = value; } }), { stdout: "started" });
  assert.equal(observed, evidence);
  assert.deepEqual(await launchIosSmokeApp({ ...args, observeLogs: () => { throw Error("observer failed"); } }), { stdout: "started" });
});

test("host runtime diagnostics are narrow, capped, bounded and cannot launch or generate pressure", async () => {
  const child = logProcess(), calls = [], starts = [];
  const host = startIosHostDiagnostics({ deadline: Date.now() + 10000, start: (...args) => { starts.push(args); return child; },
    run: async (command, args, limit, options) => {
      calls.push({ command, args, limit, options });
      return { stdout: command === "/bin/ps" ? "1 0 S 00:01 0.0 12 /usr/libexec/simdiskimaged\n2 0 S 00:01 0.0 99 /private/user-secret-app\n3 0 S 00:01 0.0 12 /com.apple.CoreSimulator.CoreSimulatorService.xpc/Contents/MacOS/com.apple.CoreSimulator.CoreSimulatorService\n4 0 S 00:01 0.0 12 simdiskimaged\n" : "Mach Virtual Memory Statistics: " + "m".repeat(9000) };
    },
  });
  assert.deepEqual(starts, [["/usr/bin/log", ["stream", "--style", "compact", "--level", "info", "--predicate", iosHostPredicate], { stdio: ["ignore", "pipe", "pipe"] }]]);
  child.stdout.write("r".repeat(40000)); child.stderr.write("e".repeat(5000));
  await host.sample("start"); await host.sample("finish"); await host.sample("ignored");
  host.stop(); host.stop();
  await Promise.resolve();
  const value = host.snapshot();
  assert.equal(value.samples.length, 2);
  assert.equal(calls.length, 4);
  for (const call of calls) { assert.ok(call.limit > 0 && call.limit <= 2000); assert.equal(call.options.captureLifecycle, true); }
  assert.ok(calls.every(call => ["/bin/ps", "/usr/bin/vm_stat"].includes(call.command)));
  assert.match(value.samples[0].processes.stdout, /simdiskimaged/);
  assert.match(value.samples[0].processes.stdout, /com\.apple\.CoreSimulator\.CoreSimulatorService$/m);
  assert.match(value.samples[0].processes.stdout, /12 simdiskimaged$/m);
  assert.doesNotMatch(JSON.stringify(value), /user-secret-app/);
  assert.equal(value.samples[0].memory.stdout.length, 8192);
  assert.equal(value.logs.stdout.length, 32768); assert.equal(value.logs.stderr.length, 4096);
  assert.equal(value.logs.truncated, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.ok(value.logs.events.some(event => event.event === "close"));
});

test("expired host diagnostic budgets and observer failures remain evidence", async () => {
  const expired = startIosHostDiagnostics({ deadline: Date.now() - 1,
    start: () => assert.fail("expired collector cannot start"), run: () => assert.fail("expired collector cannot sample") });
  await expired.sample("expired"); expired.stop();
  assert.ok(expired.snapshot().logs.skipped);
  assert.ok(expired.snapshot().samples[0].skipped);
  const unavailable = startIosHostDiagnostics({ deadline: Date.now() + 5000, start: () => { throw Error("host log unavailable"); },
    run: async () => { throw Error("snapshot unavailable"); } });
  await unavailable.sample("failed"); unavailable.stop();
  assert.equal(unavailable.snapshot().logs.error, "host log unavailable");
  assert.equal(unavailable.snapshot().samples[0].processes.error, "snapshot unavailable");
});

test("toolchain comparison declares exactly six fresh machines and retains original native policy", async () => {
  const load = async name => parse(await fs.readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
  const diagnostic = await load("ios-launch-diagnostic"), required = (await load("ci")).jobs.ios;
  assert.deepEqual(diagnostic.on, { push: { branches: ["validation/ios-toolchain-0.4.1"] }, workflow_dispatch: null });
  assert.deepEqual(diagnostic.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(diagnostic.jobs), ["ios"]);
  const { strategy, ...job } = diagnostic.jobs.ios;
  assert.equal(strategy["fail-fast"], false);
  assert.deepEqual(strategy.matrix.trial, [1, 2]);
  assert.deepEqual(strategy.matrix.configuration, [
    { id: "A", os: "macos-15", simulator: "/Applications/Xcode_26.2.app/Contents/Developer" },
    { id: "B", os: "macos-26", simulator: "/Applications/Xcode_26.2.app/Contents/Developer" },
    { id: "C", os: "macos-26", simulator: "/Applications/Xcode_26.4.1.app/Contents/Developer" },
  ]);
  assert.deepEqual(Object.keys(strategy.matrix).sort(), ["configuration", "trial"]);
  assert.equal(strategy.matrix.trial.length * strategy.matrix.configuration.length, 6);
  assert.equal(job.env.DEVELOPER_DIR, required.env.DEVELOPER_DIR);
  assert.equal(job.env.REACH_TEST_IOS_RUNTIME, "26.2");
  assert.equal(job["timeout-minutes"], required["timeout-minutes"]);
  const native = job.steps.find(step => step.run?.includes("test/ios-simulator.test.mjs"));
  const baseline = required.steps.find(step => step.run?.includes("test/ios-simulator.test.mjs"));
  assert.equal(native.run, baseline.run);
  assert.deepEqual(native.env, { ...baseline.env, DEVELOPER_DIR: "${{ matrix.configuration.simulator }}" });
  assert.deepEqual(job.steps.find(step => step.run?.startsWith("xcodebuild ")), required.steps.find(step => step.run?.startsWith("xcodebuild ")));
  assert.equal(job.steps.filter(step => step.run?.includes("test/ios-simulator.test.mjs")).length, 1);
  assert.equal(job.steps.at(-1).with.name, "tests-ios-toolchain-${{ matrix.configuration.id }}-trial-${{ matrix.trial }}");
  assert.equal(job.steps.at(-1).if, "always()");
  assert.equal(job.steps.at(-1).uses, required.steps.at(-1).uses);
  assert.equal(job.steps.find(step => step.uses?.startsWith("actions/setup-node@")).with["node-version"], "22.23.2");
  assert.doesNotMatch(JSON.stringify(job), /runFirstLaunch|downloadPlatform|shutdown all|continue-on-error/);
});

test("later simulator-service verbosity cannot erase all first-attempt evidence", async () => {
  const first = logProcess();
  const initial = startIosLaunchLogs({ device: diagnosticDevice, bundle, start: () => first });
  first.stdout.write("first-attempt-boundary\n" + "a".repeat(80000));
  initial.stop({ retain: true });
  const second = logProcess();
  const retry = startIosLaunchLogs({ device: diagnosticDevice, bundle, start: () => second });
  second.stdout.write("b".repeat(80000) + "second-attempt-tail");
  retry.stop({ retain: true });
  const result = await collectIosFailureDiagnostics({ device: diagnosticDevice, bundle, deadline: Date.now() - 1 });
  assert.doesNotMatch(result.liveLogs.stdout, /first-attempt-boundary/);
  const [a, b] = result.liveLogs.sessions;
  assert.match(a.stdoutFirst, /^first-attempt-boundary/);
  assert.equal(a.stdoutFirst.length, 8192);
  assert.equal(a.stdoutTail.length, 16384);
  assert.match(b.stdoutTail, /second-attempt-tail$/);
  assert.ok(result.liveLogs.sessions.length <= 3);
});

test("success-path host sampling is outside the original screenshot and final assertions", async () => {
  const source = await fs.readFile(new URL("./ios-simulator.test.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('t.after(async () => {'));
  const beforeCleanupEnd = source.slice(source.indexOf('t.after(async () => {'), source.indexOf('  const reach = await startCleanReach'));
  assert.match(beforeCleanupEnd, /hostObservation\.sample\("after original test body"\)/);
  const originalBody = source.slice(source.indexOf('  const reach = await startCleanReach'));
  assert.doesNotMatch(originalBody, /await hostObservation\.sample/);
  assert.match(originalBody, /assert\.equal\(report\.checks\.length, 8\)/);
});

test("runtime/device comparison preflight fails explicitly instead of changing the runtime or device", () => {
  const type = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation", name: "iPhone SE (3rd generation)" };
  const runtime = { isAvailable: true, identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2", version: "26.2", buildversion: "23C54", supportedDeviceTypes: [type] };
  for (const id of ["A", "B", "C"]) {
    assert.equal(iosComparisonRuntime(id, runtime, type, true).build, "23C54");
    assert.equal(iosComparisonConfiguration(id).buildVersion, "26.2");
  }
  for (const bad of [undefined, { ...runtime, version: "26.4.1" }, { ...runtime, buildversion: undefined }, { ...runtime, supportedDeviceTypes: [] }])
    assert.throws(() => iosComparisonRuntime("C", bad), /UNQUALIFIED_IOS_SETUP/);
  assert.throws(() => iosComparisonRuntime("C", runtime, undefined, true), /UNQUALIFIED_IOS_SETUP/);
  assert.throws(() => iosComparisonRuntime("C", runtime, { identifier: "another-phone" }, true), /UNQUALIFIED_IOS_SETUP/);
  assert.throws(() => iosComparisonConfiguration("fallback"), /UNQUALIFIED_IOS_SETUP/);
  assert.equal(iosComparisonRuntime(undefined, undefined), undefined, "normal CI keeps its original selection policy");
});

test("tool preflight binds declared SDK/client/source and uses no simctl warmup", async () => {
  for (const id of ["A", "B", "C"]) {
    const cfg = iosComparisonConfiguration(id), calls = [], head = "a".repeat(40), tree = "b".repeat(40);
    const run = async (file, args, limit) => {
      calls.push({ file, args, limit });
      let stdout;
      if (file === "/usr/bin/sw_vers") stdout = cfg.hostMajor + ".7.9\n";
      else if (file === "git") stdout = head + "\n" + tree + "\n";
      else if (file === "/usr/libexec/PlistBuddy") stdout = "1234\n";
      else if (args.includes("--show-sdk-version")) stdout = "26.2\n";
      else if (args.includes("--show-sdk-path")) stdout = cfg.build + "/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator26.2.sdk\n";
      else if (args.includes("--find")) stdout = cfg.simulator + "/usr/bin/simctl\n";
      else stdout = args[0] === `DEVELOPER_DIR=${cfg.simulator}` ? `Xcode ${cfg.simulatorVersion}\nBuild version ${cfg.simulatorBuild}\n` : "Xcode 26.2\nBuild version 17C52\n";
      return { stdout };
    };
    const options = { env: { REACH_TEST_IOS_COMPARISON: id, REACH_TEST_IOS_SOURCE_SHA: head }, run, arch: "arm64", identify: async file => ({ path: file, sha256: "c".repeat(64) }), isTool: async () => true };
    const result = await collectIosToolchainProvenance(options);
    assert.equal(result.head, head); assert.equal(result.tree, tree);
    assert.ok(calls.every(call => call.limit > 0 && call.limit <= 10000));
    assert.ok(calls.filter(call => call.args.includes("simctl")).every(call => call.args.at(-2) === "--find"), "only find the tool, never invoke a simulator in preflight");
    assert.ok(result.limits.some(value => value.includes("Identical B/C")));
    await assert.rejects(collectIosToolchainProvenance({ ...options, env: { ...options.env, REACH_TEST_IOS_SOURCE_SHA: tree } }), /checkout\/source binding differs/);
    await assert.rejects(collectIosToolchainProvenance({ ...options, run: async () => { throw Error("tool missing"); } }), /tool missing/);
    await assert.rejects(collectIosToolchainProvenance({ ...options, isTool: async () => false }), /declared tool is missing/);
    await assert.rejects(collectIosToolchainProvenance({ ...options, run: async (...args) => args[1].includes("--show-sdk-version") ? { stdout: "26.4\n" } : run(...args) }), /build simulator SDK differs/);
    await assert.rejects(collectIosToolchainProvenance({ ...options, run: async (...args) => args[1].includes("--find") ? { stdout: "/wrong/simctl\n" } : run(...args) }), /selected simctl path differs/);
  }
});

test("normal-file hashes identify built and changed installed executables separately and reject nonfiles/oversize", async t => {
  const dir = await diagnosticHome(t), file = path.join(dir, "App");
  await fs.writeFile(file, "original executable");
  const before = await iosFileIdentity(file);
  await fs.writeFile(file, "existing codesign changed executable");
  const after = await iosFileIdentity(file);
  assert.notEqual(before.sha256, after.sha256);
  await assert.rejects(iosFileIdentity(dir), /bounded normal file/);
  await assert.rejects(iosFileIdentity(file, { maximum: 2 }), /bounded normal file/);
  await assert.rejects(iosFileIdentity(file, { deadline: Date.now() - 1 }), /deadline exhausted/);
  const rows = "1 1 S 00:01 0 12 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/simdiskimaged\n2 1 S 00:01 0 12 /private/unrelated/simdiskimaged\n";
  const observed = await iosDaemonIdentities(rows, {}, async target => ({ path: target, sha256: "d".repeat(64) }));
  assert.equal(observed.length, 1); assert.ok(observed[0].path.startsWith("/Library/Developer/PrivateFrameworks/"));
});

test("only the declared existing startup boundaries gain lifecycle evidence and copied hashing cannot delay install", async () => {
  for (const name of ["launch", "runtime shared cache ready", "bootstatus", "readiness (launchctl list in the device)", "stalled launch bootstatus", "stalled launch readiness"]) assert.equal(captureIosBoundary(name), true);
  for (const name of ["screenshot", "install", "launch Settings", "reopen the app", "delete", "boot"]) assert.equal(captureIosBoundary(name), false);
  const source = await fs.readFile(new URL("./ios-simulator.test.mjs", import.meta.url), "utf8");
  const betweenSignAndInstall = source.slice(source.indexOf('await exec("codesign"'), source.indexOf('await sim("install"'));
  assert.match(betweenSignAndInstall, /void iosAppIdentity/);
  assert.doesNotMatch(betweenSignAndInstall, /await iosAppIdentity/);
});
