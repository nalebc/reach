import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { stopReach } from "../scripts/stop.mjs";
import { startCleanReach } from "./helpers/clean-machine.mjs";
import { fakeTailscale, tailnetPreload, sessionAlive, HOST } from "./helpers/fake-tailscale.mjs";
import { foregroundTask, onlyReach, scopeWindowsStop } from "./helpers/windows-stop.mjs";
import { privateWindowsInstall } from "./helpers/private-windows-install.mjs";

// First-run matrix H20, wired end to end: a real Reach that takes its Windows
// paths (test/helpers/as-windows.mjs), `.\reach.cmd status` naming it, and
// `stop` asking it through the file it watches, so it stops itself as Ctrl+C
// stops it. Real processes; only process.platform is Windows. On this Mac the
// PC's process list can't be read (no C# compiler), so status and stop fall
// back to the Reach this folder runs, and say so; on a real Windows runner
// they find it in the process list (its entry is a scripts\bootstrap.mjs of
// its own). Stopping is limited to this test's Reach either way, so it can
// never reach a Reach that really runs on this computer.
const AS_WINDOWS = pathToFileURL(path.resolve("test/helpers/as-windows.mjs")).href;
const UNREAD = /^Reach couldn't read this PC's process list \(Windows' C# compiler isn't on this PC\), so it only knows the Reach run from this folder\.\n/;

// These cases exercise an installed artifact's lifecycle. Prepare its
// immutable private byte-copy once, with a separate bounded setup budget;
// every Reach launch, status, stop and cleanup remains inside its case.
let privateInstall;
before(async (t) => {
  const started = performance.now();
  let ready = false;
  t.diagnostic(JSON.stringify({ fixturePhase: "private-install:start", elapsedMs: 0 }));
  try {
    privateInstall = await privateWindowsInstall();
    ready = true;
  } finally {
    if (!t.signal.aborted) t.diagnostic(JSON.stringify({ fixturePhase: "private-install:finished", ready, elapsedMs: Math.round(performance.now() - started) }));
  }
}, { timeout: 60000 });

// Synthetic process/task dependencies and a disposable filesystem exercise
// the real stop controller; this does not qualify Windows token behavior.
test("modeled Windows stop inventory: another fixture's background starter stays outside a foreground stop", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-stop-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = { pid: 4000001, startedAt: 1, image: "node.exe" };
  const otherStarter = { pid: 4000002, startedAt: 2, image: "reach-background-0123456789ab.exe", commandLine: '"C:\\other\\reach-background-0123456789ab.exe"' };
  const found = scopeWindowsStop({ hosts: [{ ...own, root, terminals: [], descendants: [] }], processes: [own, otherStarter], partial: "" }, own.pid);
  const printed = [], taskCalls = [], ended = [];
  let running = true;
  const result = await stopReach(root, {
    platform: "win32", yes: true, print: (line) => printed.push(line), state: () => root, wait: async () => {},
    windows: {
      env: {}, graceMs: 0, starterMs: 0, reaches: async () => found, list: async () => found.processes,
      alive: (pid) => pid === own.pid && running,
      end: (pid) => { ended.push(pid); running = false; },
      task: {
        state: () => ({ installed: false, ours: false }),
        hold: () => taskCalls.push("hold"), end: () => taskCalls.push("end"),
        release: () => taskCalls.push("release"), run: () => taskCalls.push("run"),
      },
    },
  });
  assert.deepEqual(printed, ["Stopped Reach."]);
  assert.equal(result.service, false);
  assert.deepEqual(taskCalls, []);
  assert.deepEqual(ended, [own.pid]);
  assert.equal(fs.existsSync(path.join(root, "stop-request.json")), false);
});

// Only the existing Windows-on-Mac/Linux model substitutes the unavailable
// native preflight. A genuine Windows run uses production checks unchanged.
const modeledPrivateFolders = process.platform === "win32" ? "" : `privateFolders: async () => ({ ok: true, helper: () => async () => { throw Error("Windows native helpers unavailable in this modeled host"); } })`;

async function windowsReach(t, phase = () => {}) {
  const install = privateInstall;
  assert.notEqual(install, undefined, "the bounded private artifact setup completed");
  phase("private-artifact:ready");
  const dir = fs.mkdtempSync(path.join(install?.work || os.tmpdir(), "reach-as-windows-"));
  const state = path.join(dir, "state");
  fs.mkdirSync(path.join(dir, "share"));
  // This fixture invokes the source launcher as .\reach.cmd; a parent
  // Terminal opened through the global `reach` link must not change its hints.
  const env = { ...process.env, REACH_COMMAND: "", REACH_HOME: state, REACH_DATA: path.join(state, "quick") };
  const entry = pathToFileURL(path.resolve(install?.root || ".", "scripts/launch.mjs")).href;
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(
    path.join(dir, "scripts", "bootstrap.mjs"),
    `import { launch } from ${JSON.stringify(entry)}; await launch({ local: true, folders: [${JSON.stringify(path.join(dir, "share"))}], port: 0, ${modeledPrivateFolders} }, ${JSON.stringify(dir)}); console.log("REACH ENDED");\n`,
  );
  const child = spawn(process.execPath, ["--import", AS_WINDOWS, path.join(dir, "scripts", "bootstrap.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  phase("launch:spawned");
  child.once("exit", (exitCode, signalCode) => phase("child:exit", { exitCode, signalCode }));
  child.once("close", (exitCode, signalCode) => phase("child:close", { exitCode, signalCode }));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  // "close", not "exit": only then has all it printed arrived here.
  const exited = once(child, "close");
  t.after(async () => {
    phase("cleanup:start", { exitCode: child.exitCode, signalCode: child.signalCode }, true);
    if (child.exitCode === null && child.signalCode === null) {
      phase("cleanup-kill:start", {}, true);
      child.kill("SIGKILL");
      phase("cleanup-close:start", {}, true);
      await exited;
      phase("cleanup-close:finished", { exitCode: child.exitCode, signalCode: child.signalCode }, true);
    }
    phase("cleanup-remove:start", {}, true);
    fs.rmSync(dir, { recursive: true, force: true });
    phase("cleanup-remove:finished", {}, true);
  });
  const statusFile = path.join(state, "host-status.json");
  // Ready once it both noted itself and printed its pairing code. The file
  // and the pipe are separate channels: the file can be seen before the
  // printed lines arrive here (macOS), so wait for the line we assert too.
  const ready = async () => {
    phase("launch-ready:start");
    for (const until = Date.now() + 20000; !fs.existsSync(statusFile) || !/Pairing code: \d{4} \d{4}/.test(output); ) {
      if (child.exitCode !== null || Date.now() > until) throw Error(`Reach did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    phase("launch-ready:finished");
  };
  return { dir, state, env, child, exited, statusFile, ready, packageRoot: install?.root || process.cwd(), output: () => output };
}

const status = (env, packageRoot) =>
  new Promise((resolve, reject) =>
    execFile(process.execPath, ["--import", AS_WINDOWS, "scripts/bootstrap.mjs", "status"], { env, cwd: packageRoot, timeout: 20000 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout.trim()),
    ),
  );

test("Windows, wired: status names the running Reach; stop asks it through its file and it stops itself", { timeout: 60000 }, async (t) => {
  // Bounded phase names/times only: no paths, account data or pairing output.
  // Keep the last awaited phase on timeout as well as on normal completion.
  const started = performance.now();
  let lastPhase = "start", inventoryCalls = 0;
  const phase = (name, details = {}, duringCleanup = false) => {
    lastPhase = name;
    if (duringCleanup || !t.signal.aborted) t.diagnostic(JSON.stringify({ wiredPhase: name, elapsedMs: Math.round(performance.now() - started), ...details }));
  };
  t.after(() => t.diagnostic(JSON.stringify({ wiredPhase: "cleanup", lastPhase, inventoryCalls, elapsedMs: Math.round(performance.now() - started) })));
  const reach = await windowsReach(t, (name, ...args) => phase(`first:${name}`, ...args));
  await reach.ready();
  // A Windows Reach approves phones with a pairing code (T23).
  assert.match(reach.output(), /Pairing code: \d{4} \d{4}/);
  const host = JSON.parse(fs.readFileSync(reach.statusFile, "utf8"));
  assert.equal(host.pid, reach.child.pid);
  assert.ok(Number.isFinite(host.startedAt), "it says when it started");
  const other = process.platform === "win32" ? await windowsReach(t, (name, ...args) => phase(`second:${name}`, ...args)) : null;
  if (other) await other.ready();
  // `.\reach.cmd status`, through the real launcher: the Mac's lines.
  phase("status-before:start");
  const said = await status(reach.env, reach.packageRoot);
  phase("status-before:finished");
  assert.equal(UNREAD.test(said), process.platform !== "win32", said);
  // A real Windows runner runs two test files at once: another test's Reach
  // may be listed too; this one's lines are among them.
  if (process.platform === "win32") {
    assert.ok(said.includes(`Link: ${host.origin}`) && /Reach: running in the background, with no window, since /.test(said), said);
    assert.ok(said.includes(`from ${other.dir}`), "both fixtures are in the PC's inventory");
  } else assert.match(
    said.replace(UNREAD, ""),
    // Its sleep prevention too: here its helper can't be built.
    new RegExp(`^Reach: running in the background, with no window, since [^\\n]+\\nLink: http://127\\.0\\.0\\.1:\\d+\\nSleep prevention: always · not active · Could not enable sleep prevention\\. Reach will retry in 10 minutes\\.\\nIt has no window: it can't take device approvals\\. Run \\.\\\\reach\\.cmd restart to run it in a window of its own\\.$`),
  );
  const killed = [];
  const { windowsReaches } = await import("../scripts/instances.mjs");
  const { windowsProcesses } = await import("../server/windows-processes.mjs");
  const list = async () => {
    const call = ++inventoryCalls;
    if (call <= 4) phase(`inventory-${call}:start`);
    try { return await windowsProcesses({ nativeDir: path.join(reach.state, "native") }); }
    finally { if (call <= 4) phase(`inventory-${call}:finished`); }
  };
  phase("stop:start");
  const result = await stopReach(reach.dir, {
    platform: "win32",
    yes: true,
    print() {},
    state: () => reach.state,
    table: () => [],
    launchctl: () => "",
    windows: {
      task: foregroundTask,
      list,
      taskkill: (pid) => killed.push(pid),
      // What it left running may be ended; never the Reach itself.
      end: (pid) => pid === reach.child.pid && killed.push(pid),
      // This test's Reach only, never another on this computer.
      reaches: async () => {
        const found = await windowsReaches({ root: reach.dir, state: reach.state, list });
        return scopeWindowsStop(found, reach.child.pid);
      },
    },
  });
  phase("stop:finished");
  assert.equal(result.stopped, 1);
  phase("child-close:start");
  const [code] = await reach.exited;
  phase("child-close:finished");
  assert.deepEqual(killed, [], "it stopped itself; nothing was ended");
  assert.equal(code, 0, "stopped as Ctrl+C stops it");
  assert.match(reach.output(), /REACH ENDED/);
  assert.equal(fs.existsSync(reach.statusFile), false, "its status goes with it");
  assert.equal(fs.existsSync(path.join(reach.state, "stop-request.json")), false);
  // And now it isn't running, as status says.
  phase("status-after:start");
  const endedStatus = await status(reach.env, reach.packageRoot);
  phase("status-after:finished");
  if (process.platform === "win32") {
    // Status is PC-wide. Concurrent lifecycle tests may still have their
    // own instances; this command must stop only its fixture, as above.
    assert.ok(!endedStatus.includes(`Link: ${host.origin}`), "the stopped fixture no longer has a link");
    assert.ok(!endedStatus.includes(reach.dir), "the stopped fixture is absent from the PC's list");
    // The inventory has the other process's folder, but cannot discover its
    // custom REACH_HOME from a command line. Its live state is checked here.
    assert.ok(endedStatus.includes(`from ${other.dir}`), "the other fixture remains in the PC's inventory");
    assert.equal(other.child.exitCode, null, "the other fixture is still running");
    assert.equal(fs.existsSync(other.statusFile), true, "the other fixture keeps its live status");
  } else assert.match(endedStatus, /(^|\n)Reach isn't running( from this folder)?\. Start it with \.\\reach\.cmd\.$/);
});

// First-run matrix T23, in Tailscale mode: a Windows Reach, through a
// stand-in Tailscale (this computer's own is never asked or changed). Its
// route goes to its local address (no Unix socket there), phones join with
// the pairing code, and it opens no public link. On a real Windows runner
// the stand-in is a tailscale.exe, and Windows itself ends a route's
// process with Reach (Node's kill-on-close job).
const tailscaleWindows = { timeout: 90000 };
const ORIGIN = `https://${HOST}:8443`;
const backgroundRoute = (target) => ({ TCP: { 8443: { HTTPS: true } }, Web: { [`${HOST}:8443`]: { Handlers: { "/": { Proxy: target } } } } });
// `serve` and `record`: what an earlier Reach or another service left.
function windowsTailscaleReach(t, { serve, record, savedPort } = {}) {
  const seen = {};
  const started = (async () => {
    const install = privateInstall;
    assert.notEqual(install, undefined, "the bounded private artifact setup completed");
    const fixtureRoot = install ? fs.mkdtempSync(path.join(install.work, "reach-clean-")) : undefined;
    return startCleanReach(t, {
      ...(install ? { fixtureRoot, packageRoot: install.root } : {}),
      launchCode: modeledPrivateFolders,
      args: { local: false, stayAwake: false },
      preloads: [AS_WINDOWS],
      // The guidance is printed after the pairing code in a separate stdout
      // write. Wait for the line we assert, not an earlier output chunk.
      ready: /No public internet tunnel is enabled/,
      pair: false,
      prepare: async (root) => {
        seen.root = root;
        seen.fake = await fakeTailscale(root, serve ? { serve } : {});
        if (record) {
          fs.mkdirSync(path.join(root, ".reach"), { recursive: true });
          fs.writeFileSync(path.join(root, ".reach", "serve-owner.json"), JSON.stringify({ version: 1, ...record }));
        }
        if (savedPort) {
          fs.mkdirSync(path.join(root, ".reach"), { recursive: true });
          fs.writeFileSync(path.join(root, ".reach/https-port.json"), JSON.stringify({ version: 1, port: savedPort }));
        }
        return { env: { REACH_TAILSCALE: seen.fake.cli }, preloads: [tailnetPreload(seen.fake.state)] };
      },
    });
  })();
  return { seen, started };
}
const until = async (check, what, ms = 10000) => {
  for (const end = Date.now() + ms; !(await check()); ) {
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
// Its one route on the port: a foreground session (held by its own
// `tailscale serve`, no --bg), never a background route left in Tailscale.
const heldRoute = async (fake) => {
  const state = await fake.read();
  assert.equal(state.serve.TCP?.[8443], undefined, "no background route");
  assert.equal(state.serve.Web?.[`${HOST}:8443`], undefined, "no background route");
  assert.ok(!state.calls.some((args) => args.includes("--bg")), "no --bg on Windows");
  const sessions = await fake.sessions();
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  const target = session.config.Web[`${HOST}:8443`].Handlers["/"].Proxy;
  assert.deepEqual(session.args, ["serve", "--https=8443", target]);
  assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/, "its local address, not a socket");
  return session;
};
const routeGone = async (fake, session) => {
  await until(async () => !(await fake.sessions()).length && !sessionAlive(session), "the session to end with Reach");
  const state = await fake.read();
  assert.equal(state.serve.Foreground, undefined);
  assert.equal(state.serve.TCP?.[8443], undefined, "nothing left behind on the port");
  assert.ok(!state.calls.some((args) => args.includes("--bg")));
};

test("Windows, Tailscale mode: the private link to its local address, and a pairing code; no socket, no public link", tailscaleWindows, async (t) => {
  const { seen, started } = windowsTailscaleReach(t);
  const reach = await started;
  const text = reach.output();
  assert.ok(text.includes(`Open on your phone: https://${HOST}:8443\n`), text);
  assert.match(text, /Pairing code: \d{4} \d{4}/);
  // What the phone needs comes before the code and its QR, where a first-time
  // user looks (Oct 11: scanned without the app, "can't connect"), with the
  // account to sign in as. Not set up with your account here: no reason to
  // give, and never "not on Windows".
  const first = text.indexOf("First, on your phone: install the Tailscale app, sign in as ");
  assert.ok(first > 0 && first < text.indexOf("Code works once"), text);
  assert.match(text, /sign in as \S+@\S+ and turn it on\.\n/);
  assert.doesNotMatch(text, /can't sign in from the browser|On Windows, phones/);
  assert.match(text, /Private Tailscale link: only your Tailscale devices open it/);
  const session = await heldRoute(seen.fake);
  const state = await seen.fake.read();
  assert.ok(!state.calls.some(([command]) => command === "funnel"), "no public link on Windows");
  assert.ok(!state.calls.some((args) => args.some((a) => String(a).startsWith("unix:"))));
  // `stop`, through its file: the route ends with Reach.
  const killed = [];
  const result = await stopReach(seen.root, {
    platform: "win32",
    yes: true,
    print() {},
    state: () => path.join(seen.root, ".reach"),
    table: () => [],
    launchctl: () => "",
    windows: { task: foregroundTask, taskkill: (pid) => killed.push(pid), end: (pid) => killed.push(pid), reaches: onlyReach({ pid: reach.child.pid, root: seen.root }) },
  });
  const [code] = await reach.exited;
  assert.equal(result.stopped, 1);
  assert.deepEqual(killed, [], "it stopped itself");
  assert.equal(code, 0);
  await routeGone(seen.fake, session);
});

test("Windows, Tailscale mode: Reach ended outright (a crash), its route ends too; while it runs, a lost route comes back", tailscaleWindows, async (t) => {
  const { seen, started } = windowsTailscaleReach(t);
  const reach = await started;
  const first = await heldRoute(seen.fake);
  // Its `tailscale serve` ends by itself: Reach holds the route again.
  process.kill(first.pid, "SIGKILL");
  await until(async () => (await seen.fake.sessions()).some((s) => s.pid !== first.pid), "a new session", 40000);
  const second = await heldRoute(seen.fake);
  assert.match(reach.output(), /Private Tailscale connection restored|Private link interrupted/);
  // No stop, no cleanup: the process is gone at once.
  reach.child.kill("SIGKILL");
  await reach.exited;
  await routeGone(seen.fake, second);
});

// A Reach that doesn't stop by itself (it never sees the request here: none
// is left in its folder or by its id) is ended outright, once Windows' own
// process list still names it as started then; Windows then ends its route
// with it (Node's kill-on-close job), with nothing else ended for it.
test("Windows, Tailscale mode: a Reach that doesn't stop by itself is ended outright, and its route with it", { ...tailscaleWindows, skip: process.platform !== "win32" && "Windows' own process list" }, async (t) => {
  const { seen, started } = windowsTailscaleReach(t);
  const reach = await started;
  const session = await heldRoute(seen.fake);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "reach-no-request-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const { windowsProcesses } = await import("../server/windows-processes.mjs");
  const list = async () => (await windowsProcesses({ nativeDir: path.join(elsewhere, "native") })).filter((entry) => entry.pid === reach.child.pid);
  const listed = (await list()).find((p) => p.pid === reach.child.pid);
  assert.ok(Number.isFinite(listed?.startedAt), "Windows' process list names it, with when it started");
  const said = [];
  const result = await stopReach(seen.root, {
    platform: "win32",
    yes: true,
    print: (line) => said.push(line),
    state: () => elsewhere,
    windows: {
      env: {},
      task: foregroundTask,
      list,
      graceMs: 500,
      // This test's Reach only; what it started is left to Windows.
      reaches: async () => ({ hosts: [{ pid: listed.pid, startedAt: listed.startedAt, root: null, terminals: [], descendants: [] }], partial: "", processes: await list() }),
    },
  });
  assert.equal(result.stopped, 1);
  assert.deepEqual(said, ["Stopped Reach."]);
  assert.equal(result.service, false, "only the foreground fixture was stopped");
  const [code] = await reach.exited;
  assert.equal(code, 1, "ended outright");
  await routeGone(seen.fake, session);
});

test("Windows, Tailscale mode: an older Reach's background route, recorded as its own, is replaced by the foreground one", tailscaleWindows, async (t) => {
  const old = "http://127.0.0.1:1";
  const { seen, started } = windowsTailscaleReach(t, { serve: backgroundRoute(old), record: { origin: ORIGIN, target: old } });
  await started;
  const state = await seen.fake.read();
  assert.deepEqual(state.calls.filter(([command, flag]) => command === "serve" && flag === "--https=8443")[0], ["serve", "--https=8443", "off"], "switched off first");
  const session = await heldRoute(seen.fake);
  assert.notEqual(session.config.Web[`${HOST}:8443`].Handlers["/"].Proxy, old);
  assert.equal(fs.existsSync(path.join(seen.root, ".reach", "serve-owner.json")), false, "nothing left to record");
});

test("Windows, Tailscale mode: someone else's route is left alone and setup continues on another port", tailscaleWindows, async (t) => {
  const theirs = backgroundRoute("http://127.0.0.1:3000");
  // Even beside a record of Reach's own (another target): not Reach's route.
  const { seen, started } = windowsTailscaleReach(t, { serve: theirs, record: { origin: ORIGIN, target: "http://127.0.0.1:1" } });
  const reach = await started;
  assert.match(reach.output(), /port 8443 is unavailable; using port 9443 automatically/);
  assert.ok(reach.output().includes(`Open on your phone: https://${HOST}:9443\n`));
  assert.match(reach.output(), /Pairing code: \d{4} \d{4}/);
  const state = await seen.fake.read();
  assert.deepEqual(state.serve.TCP, theirs.TCP, "never replaced");
  assert.deepEqual(state.serve.Web, theirs.Web, "never replaced");
  assert.ok(!state.calls.some((args) => args.includes("--https=8443") || args.includes("--bg") || args[0] === "funnel"), "no changes to the occupied port or public routes");
  const [session] = await seen.fake.sessions();
  assert.deepEqual(session.args.slice(0, 2), ["serve", "--https=9443"]);
  const saved = JSON.parse(fs.readFileSync(path.join(seen.root, ".reach/https-port.json")));
  assert.equal(saved.port, 9443, "Windows remembers the new link without account settings");
  const host = JSON.parse(fs.readFileSync(path.join(seen.root, ".reach/host-status.json")));
  assert.equal(host.origin, `https://${HOST}:9443`);
});

test("Windows, Tailscale mode: later starts keep the saved link even when port 8443 is free again", tailscaleWindows, async (t) => {
  const { seen, started } = windowsTailscaleReach(t, { savedPort: 9443 });
  const reach = await started;
  assert.ok(reach.output().includes(`Open on your phone: https://${HOST}:9443\n`));
  assert.doesNotMatch(reach.output(), /using port .* automatically/);
  const [session] = await seen.fake.sessions();
  assert.deepEqual(session.args.slice(0, 2), ["serve", "--https=9443"]);
});

test("Windows: an occupied launcher lock names restart without starting anything", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-lock-windows-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, "state");
  fs.mkdirSync(state);
  const lock = path.join(state, "launcher.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  // Another test may have a Reach fixture in the real PC inventory. Model
  // that ambient inventory without starting or stopping another process.
  const ambientInventory = path.join(home, "other-processes.json");
  fs.writeFileSync(ambientInventory, JSON.stringify({ processes: [{
    pid: process.pid, ppid: 4, image: "node.exe", path: "C:\\node\\node.exe",
    commandLine: '"C:\\node\\node.exe" "C:\\other reach\\scripts\\bootstrap.mjs"', startedAt: Date.now() - 60000,
  }] }));
  const ambient = { ...process.env, REACH_TEST_WINDOWS_PROCESSES: ambientInventory };
  // This case owns a launcher lock, not a running Reach. Real process-list
  // coverage lives below and in windows-lifecycle/windows-processes tests.
  const inventory = path.join(home, "lock-processes.json");
  fs.writeFileSync(inventory, JSON.stringify({ processes: [] }));
  const result = await new Promise(resolve => execFile(process.execPath,
    ["--import", AS_WINDOWS, "scripts/bootstrap.mjs", "--local"],
    { env: { ...ambient, HOME: home, REACH_HOME: state, REACH_DATA: path.join(state, "quick"), REACH_COMMAND: "", REACH_TEST_WINDOWS_PROCESSES: inventory }, timeout: 30000 },
    (error, stdout, stderr) => resolve({ error, text: stdout + stderr })));
  assert.equal(result.error?.code, 1);
  assert.match(result.text, /already starting or running/);
  assert.ok(result.text.includes(".\\reach.cmd restart"), result.text);
  assert.equal(JSON.parse(fs.readFileSync(lock)).pid, process.pid);
});

// One Reach per computer, through the real launcher (audit #10): the PC's
// process list here is written out (REACH_TEST_WINDOWS_PROCESSES, tests
// only), naming a Reach from another folder; this test process stands in for
// it. status names it, a second start is refused, and an agent's restart (no
// terminal) asks on the phone. Nothing is stopped: stop would end this process.
test("Windows, from the process list: status names a Reach from another folder, a second is refused, an agent's restart asks", { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-win-list-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, "state");
  const dataDir = path.join(state, "quick");
  fs.mkdirSync(dataDir, { recursive: true });
  const other = "C:\\Users\\Me\\other reach";
  const startedAt = Date.now() - 60000;
  fs.writeFileSync(path.join(state, "host-status.json"), JSON.stringify({ pid: process.pid, startedAt, dataDir, origin: "http://127.0.0.1:1", window: true, awake: { mode: "always", active: true } }));
  const list = path.join(home, "processes.json");
  fs.writeFileSync(list, JSON.stringify({ processes: [
    { pid: 4, ppid: 0, image: "System", path: null, commandLine: null, startedAt: null },
    { pid: process.pid, ppid: 4, image: "node.exe", path: "C:\\node\\node.exe", commandLine: `"C:\\node\\node.exe" "${other}\\scripts\\bootstrap.mjs"`, startedAt },
  ] }));
  const env = { ...process.env, REACH_HOME: state, REACH_DATA: dataDir, REACH_COMMAND: "", REACH_TEST_WINDOWS_PROCESSES: list };
  const reach = (args) => new Promise((resolve) => execFile(process.execPath, ["--import", AS_WINDOWS, "scripts/bootstrap.mjs", ...args], { env, timeout: 30000 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  const status = await reach(["status"]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`^Reach: running in a terminal window \\(process ${process.pid}\\), since [^\\n]+, from C:\\\\Users\\\\Me\\\\other reach\\nLink: http://127\\.0\\.0\\.1:1\\nSleep prevention: always · active\\n$`));
  const second = await reach(["--local"]);
  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`Reach: already running in a terminal window \\(process ${process.pid}\\), since [^\\n]+, from C:\\\\Users\\\\Me\\\\other reach\\.\\nUse that window, or:\\n {2}\\.\\\\reach\\.cmd restart`));
  const restart = await reach(["restart"]);
  assert.equal(restart.code, 0, restart.stderr);
  assert.match(restart.stdout, /^Asked on the phone \(Needs you\): Reach restarts when the user taps Restart\. Nothing restarted yet; don't run this again\./);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, "restart-request.json"), "utf8")).id, "the request the phone shows");
});

test("Windows: service guidance uses the active command, and related hints have no hard-coded launcher", async () => {
  const result = await new Promise((resolve, reject) => execFile(process.execPath,
    ["--import", AS_WINDOWS, "--input-type=module", "-e", `
      import { privateNodePath } from './scripts/background-service.mjs';
      try { privateNodePath('/missing-reach-fixture'); } catch (error) { console.log(error.message); }
    `], { env: { ...process.env, REACH_COMMAND: "" }, timeout: 10000 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.ok(result.includes(".\\reach.cmd install"), result);
  for (const name of ["invites", "stop", "background-service", "link"]) {
    const source = fs.readFileSync(`scripts/${name}.mjs`, "utf8").split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n");
    assert.doesNotMatch(source, /\.\/reach(?: |\.)|["` ]reach (?:link|setup|restart)/, name);
  }
});
