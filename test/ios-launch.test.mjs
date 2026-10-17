import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchIosSmokeApp } from "./helpers/ios-launch.mjs";
import { collectIosFailureDiagnostics, commandFailureOutput } from "./helpers/ios-diagnostics.mjs";

const device = "disposable-simulator", bundle = "test.reach.smoke";

// No simulator or app is started. Commands model the observed iOS behavior:
// openurl exits successfully at an Open/Cancel prompt without loading a page.
function fixture({ failures = 1, observed = false, springBoard = true } = {}) {
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
      pageSeen: () => seen, reached: phase => phases.push(phase) }),
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
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.command, "xcrun");
      assert.deepEqual(call.args.slice(0, 3), ["simctl", "spawn", diagnosticDevice]);
      assert.ok(call.limit > 0 && call.limit <= Math.min(budget, 10000));
      assert.ok(!call.args.some(arg => ["all", "booted", "diagnose", "launch", "shutdown"].includes(arg)));
    }
    assert.equal(calls.find(call => call.args.includes("log")).args.at(-1), `eventMessage CONTAINS[c] "${bundle}"`);
    assert.equal(result.logs.stdout.length, 65536);
    assert.equal(result.processes.stdout, `12\t0\tUIKitApplication:${bundle}`);
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
  assert.equal(result.logs.pending, true);
  assert.equal(result.processes.pending, true);
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
