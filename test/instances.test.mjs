import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alreadyRunning, describe, processTable, reachHosts, runtimeOf, sameBoot, stateOf, statusText, whereItRuns, windowsBootTime, windowsImage, windowsReachAlive, withoutHandover } from "../scripts/instances.mjs";
import { stopReach } from "../scripts/stop.mjs";

test("process discovery distinguishes an unavailable inventory from no running Reach", () => {
  for (const code of ["EPERM", "EACCES", "ENOENT", "ETIMEDOUT", "ENOBUFS"]) {
    const denied = Object.assign(Error("private process output must not become the user message"), { code });
    assert.throws(() => processTable(() => { throw denied; }), error => {
      assert.equal(error.code, "REACH_PROCESS_INVENTORY_UNAVAILABLE");
      assert.equal(error.cause, denied);
      assert.match(error.message, /Can't determine whether Reach is running/);
      assert.match(error.message, /Terminal or allow process inspection/);
      assert.doesNotMatch(error.message, /private process output|isn't running|Start it/);
      return true;
    });
  }
  assert.throws(() => processTable(() => "inventory denied"), { code: "REACH_PROCESS_INVENTORY_UNAVAILABLE" });
  assert.deepEqual(processTable(() => ""), []);
  const empty = processTable(() => "  1 0 ? /sbin/init\n  2 1 ? unrelated-process\n");
  assert.deepEqual(reachHosts(empty), []);
  assert.equal(statusText(reachHosts(empty)), "Reach isn't running. Start it with reach.");
});

test("stop and restart abort before signals or service operations when process discovery fails", async () => {
  for (const restarting of [false, true]) {
    const effects = [];
    await assert.rejects(stopReach("/synthetic-reach", {
      restarting, platform: "darwin", yes: true,
      table: () => processTable(() => { throw Object.assign(Error("denied"), { code: "EPERM" }); }),
      kill: () => effects.push("signal"), launchctl: () => effects.push("service"),
      handoffRoute: () => effects.push("route"), print: () => effects.push("output"),
    }), { code: "REACH_PROCESS_INVENTORY_UNAVAILABLE" });
    assert.deepEqual(effects, []);
  }
});

test("CLI discovery failure cannot report stopped, start another Reach, or remove an inaccessible lock", { skip: process.platform === "win32" }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-inventory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin"), state = path.join(dir, "state"), effects = path.join(dir, "effects");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  // Satisfy the launcher's runtime check without installing anything.
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });
  const preload = path.join(dir, "inventory.mjs");
  fs.writeFileSync(preload, `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const denied = () => Object.assign(Error('sensitive fixture output'), { code: 'EPERM' });
    const effect = action => { fs.appendFileSync(${JSON.stringify(effects)}, action + '\\n'); throw Error('unexpected effect: ' + action); };
    cp.execFileSync = (file, args) => {
      if (file === '/bin/ps') {
        if (process.env.REACH_TEST_INVENTORY === 'empty' || (process.env.REACH_TEST_INVENTORY === 'lock' && args[0] === '-axo')) return '';
        throw denied();
      }
      if (file === '/usr/sbin/sysctl' && process.env.REACH_TEST_INVENTORY === 'lock') return 'fixture-boot-session';
      return effect('execFileSync');
    };
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile']) cp[method] = () => effect(method);
    process.kill = (_pid, signal) => {
      if (signal === 0 && process.env.REACH_TEST_INVENTORY === 'lock') throw denied();
      return effect('signal');
    };
    syncBuiltinESMExports();
  `);
  const guard = new URL("./helpers/runaway-guard.mjs", import.meta.url).href;
  const cli = fileURLToPath(new URL("../reach", import.meta.url));
  const run = (args, mode = "denied") => {
    const options = {
      encoding: "utf8", timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, REACH_HOME: state,
        REACH_TEST_INVENTORY: mode, NODE_OPTIONS: `--import=${guard} --import=${pathToFileURL(preload).href}` },
    };
    try { return { status: 0, stdout: execFileSync("/bin/sh", [cli, ...args], options), stderr: "" }; }
    catch (error) { return { status: error.status, stdout: error.stdout || "", stderr: error.stderr || "" }; }
  };
  for (const args of [["status"], ["stop"], ["restart"], ["--local"]]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /Can't determine whether Reach is running/);
    assert.doesNotMatch(result.stdout + result.stderr, /sensitive fixture output|isn't running|starting in a new|Stopped Reach|already running/);
    assert.equal(fs.existsSync(state), false, "discovery failure cannot create launch state");
    assert.equal(fs.existsSync(effects), false, "no subprocesses, service calls, or signals");
  }
  const empty = run(["status"], "empty");
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /Reach isn't running\. Start it with \.\/reach\./);
  for (const args of [["--help"], ["--version"]]) assert.equal(run(args).status, 0, "informational commands do not need process access");
  fs.mkdirSync(state);
  const lock = path.join(state, "launcher.lock"), original = JSON.stringify({ pid: 424242 });
  fs.writeFileSync(lock, original);
  const inaccessible = run(["--local"], "lock");
  assert.equal(inaccessible.status, 1, inaccessible.stderr);
  assert.match(inaccessible.stderr, /Can't determine whether Reach is running/);
  assert.equal(fs.readFileSync(lock, "utf8"), original, "unreadable lock owner remains protected");
  assert.equal(fs.existsSync(effects), false);
});

// One Reach per computer. Agents restarted Reach in the background three times
// in a day (no window: no screen permissions, no device approvals), and the
// user's own ./reach then said only "already starting or running from this
// folder". Every Reach is found from the process list, whatever its folder,
// and a second start says where the first runs and what to do.
const HOME = "/Users/me";
const node = "/opt/homebrew/bin/node";
const table = [
  { pid: 10, ppid: 5, tty: "ttys007", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs` },
  { pid: 11, ppid: 10, tty: "ttys007", command: "tailscale serve --https=8443 unix:/tmp/s" },
  { pid: 20, ppid: 1, tty: "??", command: `${node} ${HOME}/My Projects/reach copy/scripts/bootstrap.mjs --port 4318` },
  { pid: 30, ppid: 1, tty: "??", command: `${node} /usr/local/lib/node_modules/@nalebc/reach/bin/reach.mjs --service` },
  { pid: 40, ppid: 9, tty: "ttys009", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs approve` },
  { pid: 50, ppid: 9, tty: "ttys009", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs status` },
  { pid: 60, ppid: 9, tty: "ttys009", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs --background --port 4318` },
  { pid: 70, ppid: 9, tty: "ttys009", command: `${node} /usr/local/lib/node_modules/@nalebc/reach/bin/reach.mjs -v` },
];
const exists = (p) => p.startsWith("/");

test("every Reach running, whatever its folder (spaces too), and how it runs; commands beside them are not Reaches", () => {
  const hosts = reachHosts(table, { self: 50, exists });
  assert.deepEqual(hosts.map((h) => [h.pid, h.root]), [
    [10, `${HOME}/reach`],
    [20, `${HOME}/My Projects/reach copy`],
    [30, "/usr/local/lib/node_modules/@nalebc/reach"],
  ]);
  assert.deepEqual(hosts.map(whereItRuns), [
    "in a Terminal window (ttys007)",
    "in the background, with no window",
    "as the background service",
  ]);
  assert.deepEqual(hosts[0].descendants.map((d) => d.pid), [11]);
});

test("a second start says where Reach runs and what to run instead", () => {
  const [terminal, hidden] = reachHosts(table, { self: 50, exists });
  const started = new Map([[terminal.pid, new Date(2026, 9, 5, 18, 9).getTime()]]);
  const now = new Date(2026, 9, 5, 19, 0).getTime();
  const one = alreadyRunning([terminal], { command: "reach", started, now, dir: HOME });
  assert.match(one, /^already running in a Terminal window \(ttys007\), since [^,]*:09[^,]*, from ~\/reach\./);
  assert.match(one, /Use that window, or:/);
  assert.match(one, /reach restart +stop it and start Reach here/);
  assert.match(one, /reach stop +stop it/);
  // Hidden in the background: what that costs.
  assert.match(alreadyRunning([hidden], { dir: HOME }), /With no window it can't show or control your screen/);
  // Two at once: all listed, and how to end up with one.
  const two = alreadyRunning([terminal, hidden], { command: "reach", dir: HOME });
  assert.match(two, /^2 copies are running:\n {2}· in a Terminal window[^\n]*\n {2}· in the background, with no window, from ~\/My Projects\/reach copy\nOnly one should run\. Run reach stop/);
});

test("reach status tells what really runs, with its link", { skip: process.platform === "win32" ? "POSIX process discovery" : false }, () => {
  const hosts = reachHosts(table, { self: 50, exists });
  const runtime = () => ({ link: "https://mac.tail.ts.net", awake: { mode: "always", active: true } });
  const text = statusText([hosts[0]], { command: "reach", dir: HOME, runtime });
  assert.equal(text, "Reach: running in a Terminal window (ttys007), from ~/reach\nLink: https://mac.tail.ts.net\nSleep prevention: always · active");
  // Its routes: the private one phones use (and how often it dropped), the public one.
  const now = new Date(2026, 9, 5, 19, 0).getTime();
  const routes = { private: { up: true, since: new Date(2026, 9, 5, 18, 9).getTime(), interruptions: 2 }, public: { open: true, since: new Date(2026, 9, 5, 18, 20).getTime() } };
  assert.match(
    statusText([hosts[0]], { dir: HOME, now, runtime: () => ({ link: "https://mac.tail.ts.net", routes }) }),
    /\nLink: https:\/\/mac\.tail\.ts\.net\nPrivate route: up since [^\n]*:09[^\n]* · 2 interruptions\nPublic link: on since [^\n]*:20[^\n]*, blocked until an invite$/,
  );
  assert.match(
    statusText([hosts[0]], { dir: HOME, runtime: () => ({ routes: { private: { up: false, since: 0, interruptions: 0 }, public: { open: false, since: 0 } } }) }),
    /\nPrivate route: down\nPublic link: off$/,
  );
  assert.match(statusText([hosts[1]], { dir: HOME, runtime: () => ({}) }), /It has no window/);
  assert.match(statusText(hosts, { dir: HOME, runtime: () => ({}) }), /3 copies are running; only one should\./);
  assert.equal(statusText([], { command: "reach" }), "Reach isn't running. Start it with reach.");
  assert.equal(describe(hosts[2], { dir: HOME }), "as the background service, from /usr/local/lib/node_modules/@nalebc/reach");
  // The service writes to files: where they are (an npm install keeps them in ~/.reach).
  assert.match(
    statusText([hosts[2]], { dir: HOME, runtime: () => ({}), state: () => `${HOME}/.reach` }),
    /\nLogs: ~\/\.reach\/logs$/,
  );
  assert.equal(stateOf("/opt/reach", () => false), path.join(os.homedir(), ".reach"));
  assert.equal(stateOf("/src/reach", () => true), "/src/reach/.reach");
});

test("runtime status belongs to the observed process on every supported host", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-runtime-pid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "host-status.json");
  const saved = { link: "https://fixture.invalid", origin: "https://private.invalid:8443",
    routes: { private: { up: true, since: 1, interruptions: 2 }, public: { open: true, since: 1 } },
    awake: { mode: "always", active: true }, signInOff: "from an earlier run",
    browserLink: { ready: false, reason: "from an earlier run" } };
  for (const platform of [undefined, "darwin", "linux", "win32"]) {
    const host = { pid: 7000, root: dir, tty: "ttys003", app: "", ...(platform && { platform }) };
    const runtime = h => runtimeOf(h, { state: () => dir });
    const started = new Map([[host.pid, Date.parse("2026-10-18T18:00:00Z")]]);
    const text = () => statusText([host], { runtime, started, now: Date.parse("2026-10-18T19:00:00Z") });
    for (const pid of [6000, undefined, "7000"]) {
      fs.writeFileSync(file, JSON.stringify({ ...saved, ...(pid !== undefined && { pid }) }));
      assert.deepEqual(runtime(host), {}, `${platform || "POSIX discovery"}: stale, absent or differently typed PID is not this run`);
      const output = text();
      assert.match(output, platform === "win32" ? /^Reach: running in a terminal window \(process 7000\), since / : /^Reach: running in a Terminal window \(ttys003\), since /);
      assert.doesNotMatch(output, /Link:|Private link|Browser link|Private route:|Public link:|Sleep prevention:|Browser sign-in|fixture\.invalid|private\.invalid/);
    }
    fs.writeFileSync(file, JSON.stringify({ ...saved, pid: host.pid }));
    assert.deepEqual(runtime(host), { ...saved, pid: host.pid }, "matching PID retains this process's runtime fields");
    assert.match(text(), /Private link \(same Tailscale network\): https:\/\/private\.invalid:8443/);
    assert.match(text(), /Private route: up/);
    assert.match(text(), /Public link: on/);
    assert.match(text(), /Sleep prevention: always · active/);
    fs.unlinkSync(file);
    assert.deepEqual(runtime(host), {}, "a missing status file does not hide the observed process");
    assert.match(text(), /^Reach: running /);
  }
});

test("runtime status requires a positive safe-integer observed process identity", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-runtime-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "host-status.json");
  const saved = { link: "https://fixture.invalid", routes: { public: { open: true } }, awake: { active: true } };
  for (const platform of [undefined, "darwin", "linux", "win32"]) {
    for (const pid of [undefined, null, 0, -1, 1.5, "7000", Number.MAX_SAFE_INTEGER + 1, true]) {
      const identity = pid === undefined ? {} : { pid };
      fs.writeFileSync(file, JSON.stringify({ ...saved, ...identity }));
      const host = { root: dir, tty: "ttys003", ...(platform && { platform }), ...identity };
      assert.deepEqual(runtimeOf(host, { state: () => dir }), {},
        `${platform || "POSIX discovery"}: equally invalid observed and saved PID ${String(pid)} cannot identify this run`);
    }
  }
});

test("a Reach handing itself to the background service doesn't stop that service from starting", () => {
  // First-run setup picks background mode: ./reach installs the service and
  // stays open until the phone connects. The service must start anyway.
  const hosts = reachHosts(table, { self: 50, exists });
  const files = { [path.join("/state", "handover.pid")]: "10" };
  const read = (f) => {
    if (!(f in files)) throw Object.assign(Error("missing"), { code: "ENOENT" });
    return files[f];
  };
  assert.deepEqual(withoutHandover(hosts, "/state", read).map((h) => h.pid), [20, 30]);
  assert.deepEqual(withoutHandover(hosts, "/elsewhere", read).map((h) => h.pid), [10, 20, 30]);
});

test("a reach restart run in a terminal is the running Reach once it holds its folder's lock", () => {
  // `reach restart` without the service starts Reach in the same process:
  // reach status and reach stop missed it ("Reach isn't running").
  const t = [
    { pid: 70, ppid: 9, tty: "ttys000", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs restart` },
    { pid: 71, ppid: 70, tty: "ttys000", command: "caffeinate -d -i -s" },
  ];
  const hosts = (holder) => reachHosts(t, { self: 1, exists, locked: () => holder });
  // Still stopping the old one (or building): not yet a Reach.
  assert.deepEqual(hosts(null), []);
  // Holding the lock: it is the running Reach, with what it started.
  const [h] = hosts(70);
  assert.equal(h.pid, 70);
  assert.equal(whereItRuns(h), "in a Terminal window (ttys000)");
  assert.deepEqual(h.descendants.map((d) => d.pid), [71]);
});

test("a Reach started with a relative script path (npm run go) is found through its working directory", async () => {
  const { reachHosts } = await import("../scripts/instances.mjs");
  const table = [{ pid: 700, ppid: 1, tty: "ttys001", command: "node scripts/bootstrap.mjs" }];
  const found = reachHosts(table, { self: 1, cwdOf: (pid) => (pid === 700 ? "/Users/me/reach" : "") });
  // Resolved as this computer resolves a path (a drive in front, on Windows).
  assert.deepEqual(found.map((h) => [h.pid, h.root]), [[700, path.resolve("/Users/me/reach")]]);
});

// First-run matrix H20, now only where Windows' process list can't be read:
// `status` names the Reach this folder runs from its own status file, while
// that process lives, with the Mac's lines (audit #32), and the running Reach
// stops when `stop` leaves it a request (no signals there).
test("Windows status from the status file: only while its process lives, with the Mac's lines", async () => {
  const { windowsHost, windowsStatusText } = await import("../scripts/instances.mjs");
  const status = { pid: 4242, startedAt: Date.parse("2026-10-10T09:05:00"), origin: "https://pc.t.ts.net:8443", window: true };
  const read = () => JSON.stringify(status);
  // Its process, as tasklist would name it (this test may run on a real PC).
  const live = { image: () => "node.exe", boot: () => undefined };
  const host = windowsHost("/state", { read, alive: (pid) => pid === 4242, ...live });
  assert.equal(host.pid, 4242);
  const text = windowsStatusText(host, { command: ".\\reach.cmd", now: Date.parse("2026-10-10T12:00:00") });
  assert.match(text, /^Reach: running in a terminal window \(process 4242\), since [^\n]*9:05[^\n]*\nLink: https:\/\/pc\.t\.ts\.net:8443$/);
  const routes = { private: { up: true, since: Date.parse("2026-10-10T09:06:00"), interruptions: 1 }, public: { open: false, since: 0 } };
  assert.match(
    windowsStatusText({ ...status, routes, awake: { mode: "ac", active: false }, window: false }, { command: ".\\reach.cmd", now: Date.parse("2026-10-10T12:00:00") }),
    /^Reach: running in the background, with no window, since [^\n]*\nLink: https:\/\/pc\.t\.ts\.net:8443\nPrivate route: up since [^\n]*9:06[^\n]* · 1 interruption\nPublic link: off\nSleep prevention: ac · not active\nIt has no window: it can't take device approvals\. Run \.\\reach\.cmd restart to run it in a window of its own\.$/,
  );
  // A status file a stopped (or force-ended) Reach left: not running.
  assert.equal(windowsHost("/state", { read, alive: () => false, ...live }), null);
  assert.equal(windowsHost("/state", { read: () => { throw Object.assign(Error("gone"), { code: "ENOENT" }); }, ...live }), null);
  assert.equal(windowsHost("/state", { read: () => "{\"pid\":\"x\"}", alive: () => true, ...live }), null);
  assert.equal(windowsStatusText(null, { command: ".\\reach.cmd" }), "Reach isn't running from this folder. Start it with .\\reach.cmd.");
});

test("Windows: a running Reach stops on a request for it, and only for it", async (t) => {
  const fs = await import("node:fs");
  const { watchStopRequest, stopRequestFile } = await import("../scripts/instances.mjs");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "reach-win-watch-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  let stops = 0;
  const unwatch = watchStopRequest(state, { pid: 77, stop: () => stops++, every: 10 });
  t.after(unwatch);
  // An earlier Reach's request, not this one's.
  fs.writeFileSync(stopRequestFile(state), JSON.stringify({ pid: 76 }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stops, 0);
  fs.writeFileSync(stopRequestFile(state), JSON.stringify({ pid: 77 }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stops, 1);
  assert.equal(fs.existsSync(stopRequestFile(state)), false, "taken, so it's acted on once");
  fs.writeFileSync(stopRequestFile(state), JSON.stringify({ pid: 77 }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stops, 1, "it stopped watching once it was stopping");
});

test("Windows: a recorded Reach is the one running only in the same boot and while its id is still Node", () => {
  // Oct 12: Windows reuses process ids within minutes. A status file or lock
  // left by a crash or a restart of the PC named an unrelated program.
  const tasklist = (rows) => (cmd, args) => {
    assert.equal(cmd, "tasklist");
    assert.deepEqual(args.slice(0, 2), ["/FI", `PID eq ${args[1].split(" ").pop()}`]);
    return rows;
  };
  assert.equal(windowsImage(4242, tasklist('"node.exe","4242","Console","1","61,234 K"\r\n')), "node.exe");
  assert.equal(windowsImage(4242, tasklist('"Chrome.exe","4242","Console","1","1,234 K"\r\n')), "chrome.exe");
  assert.equal(windowsImage(4242, tasklist("INFO: No tasks are running which match the specified criteria.\r\n")), "");
  assert.equal(windowsImage(4242, tasklist('"node.exe","14242","Console","1","1 K"\r\n')), "", "another id");
  assert.equal(windowsImage(4242, () => { throw Error("not on Windows"); }), null);

  assert.equal(windowsBootTime(1_000_000_000, 3600), 996_400);
  assert.equal(sameBoot(996_400, 996_460), true, "the same boot, read a minute apart");
  assert.equal(sameBoot(996_400, 1_200_000), false, "rebooted since");
  assert.equal(sameBoot("a1", "a1"), true, "macOS and Linux boot ids are compared as they are");

  const record = { pid: 4242, boot: 996_400 };
  const live = { alive: () => true, image: () => "node.exe", boot: () => 996_430 };
  assert.equal(windowsReachAlive(record, live), true);
  assert.equal(windowsReachAlive(record, { ...live, alive: () => false }), false, "ended");
  assert.equal(windowsReachAlive(record, { ...live, boot: () => 1_200_000 }), false, "a file from before the PC restarted");
  assert.equal(windowsReachAlive(record, { ...live, image: () => "chrome.exe" }), false, "its id now names another program");
  assert.equal(windowsReachAlive(record, { ...live, image: () => null }), true, "tasklist can't say: the living id counts");
  assert.equal(windowsReachAlive({ pid: 4242 }, live), true, "an older file without a boot");
  assert.equal(windowsReachAlive({ pid: "x" }, live), false);
});

// One Reach per computer on Windows (audit #10): every Reach on the PC from
// its process list (server/windows-processes.mjs), as ps lists them on a Mac.
// A parent is one only if it started first: Windows hands ids out again.
const NODEJS = String.raw`"C:\Program Files\nodejs\node.exe"`;
const PC = [
  { pid: 100, ppid: 4, image: "explorer.exe", commandLine: String.raw`C:\Windows\Explorer.EXE`, startedAt: 1000 },
  { pid: 200, ppid: 100, image: "WindowsTerminal.exe", commandLine: "wt", startedAt: 2000 },
  { pid: 300, ppid: 200, image: "powershell.exe", commandLine: "powershell.exe", startedAt: 3000 },
  { pid: 310, ppid: 300, image: "powershell.exe", commandLine: String.raw`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Me\reach\scripts\bootstrap.ps1"`, startedAt: 3100 },
  { pid: 320, ppid: 310, image: "node.exe", commandLine: String.raw`${NODEJS} C:\Users\Me\reach\bin\reach.mjs`, startedAt: 3200 },
  { pid: 330, ppid: 320, image: "node.exe", commandLine: String.raw`${NODEJS} C:\Users\Me\reach\scripts\bootstrap.mjs`, startedAt: 3300 },
  { pid: 341, ppid: 330, image: "powershell.exe", commandLine: "powershell.exe -NoLogo", startedAt: 3410 },
  { pid: 342, ppid: 341, image: "claude.exe", commandLine: "claude", startedAt: 3420 },
  { pid: 343, ppid: 341, image: "conhost.exe", commandLine: String.raw`\??\C:\Windows\system32\conhost.exe 0x4`, startedAt: 3411 },
  { pid: 350, ppid: 330, image: "powershell.exe", commandLine: String.raw`powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File C:\Users\Me\reach\scripts\native\desktop-input.ps1 0`, startedAt: 3500 },
  { pid: 351, ppid: 330, image: "reach-stay-awake-0123456789ab.exe", commandLine: "reach-stay-awake-0123456789ab.exe always", startedAt: 3510 },
  // An id Windows gave again: 330's "child" that started before 330 did.
  { pid: 360, ppid: 330, image: "chrome.exe", commandLine: "chrome.exe", startedAt: 900 },
  { pid: 400, ppid: 100, image: "Code.exe", commandLine: "Code.exe", startedAt: 4000 },
  { pid: 410, ppid: 400, image: "pwsh.exe", commandLine: "pwsh.exe", startedAt: 4100 },
  { pid: 420, ppid: 410, image: "node.exe", commandLine: String.raw`node "C:\My Projects\reach copy\scripts\bootstrap.mjs" --port 4318`, startedAt: 4200 },
  { pid: 500, ppid: 600, image: "reach-background-0123456789ab.exe", commandLine: "reach-background-0123456789ab.exe --log x --hold y -- node", startedAt: 5000 },
  { pid: 510, ppid: 500, image: "node.exe", commandLine: String.raw`"C:\Users\Me\.reach\runtime\node-v22.23.3-win-x64\node.exe" "C:\Users\Me\AppData\Roaming\npm\\node_modules\@nalebc\reach\scripts\bootstrap.mjs" --service --port 4318`, startedAt: 5100 },
  { pid: 600, ppid: 4, image: "svchost.exe", commandLine: null, startedAt: 500 },
  // Beside them, never a Reach: commands that print, an editor, code for node -e.
  { pid: 700, ppid: 300, image: "node.exe", commandLine: String.raw`${NODEJS} C:\Users\Me\reach\scripts\bootstrap.mjs status`, startedAt: 7000 },
  { pid: 710, ppid: 300, image: "node.exe", commandLine: String.raw`node C:\Users\Me\reach\bin\reach.mjs -v`, startedAt: 7100 },
  { pid: 720, ppid: 300, image: "notepad.exe", commandLine: String.raw`notepad.exe C:\Users\Me\reach\scripts\bootstrap.mjs`, startedAt: 7200 },
  { pid: 730, ppid: 300, image: "node.exe", commandLine: String.raw`node -e "import('C:/Users/Me/reach/scripts/bootstrap.mjs')"`, startedAt: 7300 },
  // npm run go: a path relative to a folder its command line doesn't name.
  { pid: 900, ppid: 300, image: "node.exe", commandLine: String.raw`node scripts\bootstrap.mjs`, startedAt: 9000 },
  // Another account's: Windows says nothing of it.
  { pid: 950, ppid: 4, image: "node.exe", commandLine: null, startedAt: null },
];
test("Windows: every Reach on the PC from its process list, whatever its folder, and how each runs", async () => {
  const { windowsReachHosts } = await import("../scripts/instances.mjs");
  const hosts = windowsReachHosts(PC, { self: 700, runtime: () => ({}) });
  assert.deepEqual(hosts.map((h) => [h.pid, h.root]), [
    [330, String.raw`C:\Users\Me\reach`],
    [420, String.raw`C:\My Projects\reach copy`],
    [510, String.raw`C:\Users\Me\AppData\Roaming\npm\node_modules\@nalebc\reach`],
    [900, null],
  ]);
  assert.deepEqual(hosts.map(whereItRuns), [
    "in a terminal window (process 330)",
    "inside VS Code (process 420), not a window of its own",
    "as the background service",
    "in a terminal window (process 900)",
  ]);
  const [reach] = hosts;
  assert.deepEqual(reach.descendants.map((d) => d.pid).sort(), [341, 342, 343, 350, 351], "never what got an old id");
  assert.deepEqual(reach.terminals, [{ pid: 341, tty: "", shell: "powershell", running: ["claude"] }], "its terminal, not its PowerShell helper");
  assert.deepEqual(hosts.map((h) => h.startedAt), [3300, 4200, 5100, 9000]);
  // A Reach with no window of its own, by its status file.
  const hidden = windowsReachHosts(PC, { self: 700, runtime: (root, pid) => (pid === 330 ? { pid, window: false } : {}) });
  assert.equal(whereItRuns(hidden[0]), "in the background, with no window");
  // One folder's.
  assert.deepEqual(windowsReachHosts(PC, { self: 700, root: String.raw`c:\users\me\REACH`, runtime: () => ({}) }).map((h) => h.pid), [330]);
});

test("Windows: a second start says where Reach runs and what that costs there; status gives the Mac's lines", async () => {
  const { windowsReachHosts, startedOf } = await import("../scripts/instances.mjs");
  const [reach, inCode, service] = windowsReachHosts(PC, { self: 700, runtime: () => ({}) });
  const started = startedOf([reach, inCode]);
  assert.deepEqual([...started], [[330, 3300], [420, 4200]], "Windows' list says when each started");
  const now = new Date(1970, 0, 1, 12, 0).getTime();
  const one = alreadyRunning([reach], { command: ".\\reach.cmd", now, started: new Map([[330, new Date(1970, 0, 1, 9, 5).getTime()]]) });
  assert.match(one, /^already running in a terminal window \(process 330\), since [^,]+, from C:\\Users\\Me\\reach\.\nUse that window, or:\n {2}\.\\reach\.cmd restart {3}stop it and start Reach here/);
  assert.match(alreadyRunning([inCode]), /\nIt ends when VS Code closes\.\n/);
  assert.doesNotMatch(alreadyRunning([{ ...reach, tty: "" }]), /show or control your screen/, "Windows gives every program in your session the screen");
  assert.match(alreadyRunning([{ ...reach, tty: "" }]), /\nWith no window it can't take device approvals\.\n/);
  const runtime = () => ({
    pid: 330,
    link: "https://pc.tail.ts.net",
    routes: { private: { up: true, since: 0, interruptions: 0 }, public: { open: true, since: 0 } },
    awake: { mode: "always", active: true },
    signInOff: "Tailscale is older than 1.104; update Tailscale.",
  });
  assert.equal(
    statusText([reach], { command: ".\\reach.cmd", runtime }),
    "Reach: running in a terminal window (process 330), from C:\\Users\\Me\\reach\nLink: https://pc.tail.ts.net\nPrivate route: up\nPublic link: on, blocked until an invite\nSleep prevention: always · active\nBrowser sign-in is off for now: Tailscale is older than 1.104; update Tailscale.",
  );
  assert.match(statusText([inCode], { command: ".\\reach.cmd", runtime: () => ({}) }), /\nIt ends when VS Code closes\. Run \.\\reach\.cmd restart to move it to a window of its own\.$/);
  assert.match(statusText([service], { command: "reach", runtime: () => ({}), state: () => "C:\\Users\\Me\\.reach" }), /^Reach: running as the background service, from [^\n]+\nLogs: C:\\Users\\Me\\\.reach[\\/]logs$/);
  // A file another run left: not this Reach's link.
  assert.equal(runtimeOf({ ...reach }, { read: () => ({ pid: 1, link: "https://old" }) }).link, undefined);
  // Only this folder's known: said first.
  assert.match(statusText([], { command: ".\\reach.cmd", partial: "Windows' C# compiler isn't on this PC" }), /^Reach couldn't read this PC's process list \(Windows' C# compiler isn't on this PC\), so it only knows the Reach run from this folder\.\nReach isn't running from this folder\. Start it with \.\\reach\.cmd\.$/);
});

test("Windows: the app a command runs inside, from its parents: a terminal is none, an editor or an agent is one", async () => {
  const { windowsHostApp } = await import("../scripts/instances.mjs");
  const chain = (...images) => images.map((image, i) => ({ pid: 1000 + i, ppid: 1001 + i, image, commandLine: image, startedAt: 1000 + (images.length - i) }));
  // Nearest first: this node, then its parents.
  const appOf = (...images) => windowsHostApp(chain(...images), 1000);
  assert.equal(appOf("node.exe", "powershell.exe", "cmd.exe", "WindowsTerminal.exe", "explorer.exe"), "");
  assert.equal(appOf("node.exe", "powershell.exe", "explorer.exe"), "", "a console window");
  for (const terminal of ["warp.exe", "Far.exe", "MobaXterm.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe"])
    assert.equal(appOf("node.exe", "pwsh.exe", terminal), "", terminal);
  assert.equal(appOf("node.exe", "powershell.exe", "bash.exe", "claude.exe", "pwsh.exe", "WindowsTerminal.exe"), "Claude", "Claude Code's shell");
  assert.equal(appOf("node.exe", "cmd.exe", "pwsh.exe", "Code.exe", "explorer.exe"), "VS Code");
  assert.equal(appOf("node.exe", "powershell.exe", "Codex.exe"), "Codex");
  assert.equal(appOf("node.exe", "reach-background-0123456789ab.exe", "svchost.exe"), "", "the background task");
  assert.equal(appOf("node.exe", "powershell.exe", "TOTALCMD64.exe"), "TOTALCMD64");
  assert.equal(appOf("node.exe", "cmd.exe"), "", "a parent that's gone: no app");
  assert.equal(appOf("node.exe", "cmd.exe", "System"), "", "Windows itself is nobody's app");
  assert.equal(appOf("node.exe", "cmd.exe", "smss.exe", "csrss.exe"), "");
  // A parent that started after its child is another program with an old id.
  const reused = chain("node.exe", "Code.exe");
  reused[1].startedAt = 999999;
  assert.equal(windowsHostApp(reused, 1000), "");
});

test("Windows: the process list unreadable: the Reach this folder runs, with why", async () => {
  const { windowsReaches } = await import("../scripts/instances.mjs");
  const record = { pid: 4242, startedAt: 1, window: true, service: false };
  for (const [error, why] of [
    [Object.assign(Error("no csc"), { compiler: false }), "Windows' C# compiler isn't on this PC"],
    [Object.assign(Error("blocked"), { refused: true }), "Windows wouldn't build or run Reach's helper"],
    [Object.assign(Error("spawn UNKNOWN"), { code: "UNKNOWN", syscall: "spawn C:\\x.exe" }), "Windows wouldn't build or run Reach's helper"],
    [Error("it took too long"), "it took too long"],
    [Error("The process list said something Reach can't read."), "Windows wouldn't say"],
  ]) {
    const found = await windowsReaches({ root: "C:\\reach", state: "C:\\reach\\.reach", list: async () => { throw error; }, host: () => record });
    assert.equal(found.partial, why);
    assert.deepEqual(found.hosts.map((h) => [h.pid, h.root, h.platform]), [[4242, "C:\\reach", "win32"]]);
    assert.equal(found.processes, null);
  }
  const none = await windowsReaches({ root: "C:\\reach", state: "x", list: async () => { throw Error("x"); }, host: () => null });
  assert.deepEqual(none.hosts, []);
  const read = await windowsReaches({ root: "C:\\reach", state: "x", self: 700, list: async () => PC, host: () => assert.fail("not when the list is read") });
  assert.equal(read.partial, "");
  assert.deepEqual(read.hosts.map((h) => h.pid), [330, 420, 510, 900]);
});

test("Windows: a Reach watches for its stop request in its folder and, by its id, in your app data", async (t) => {
  const { watchStopRequest, personalStopFile } = await import("../scripts/instances.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-win-personal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: path.join(dir, "local") };
  const personal = personalStopFile(77, env);
  assert.equal(personal, path.join(dir, "local", "Reach", "stop", "77.json"));
  assert.equal(personalStopFile(77, {}), null);
  fs.mkdirSync(path.dirname(personal), { recursive: true });
  let stops = 0;
  const unwatch = watchStopRequest(path.join(dir, "state"), { pid: 77, stop: () => stops++, every: 10, personal });
  t.after(unwatch);
  // Left minutes ago by a stop that didn't finish: not acted on, and gone.
  fs.writeFileSync(personal, JSON.stringify({ pid: 77, at: Date.now() - 10 * 60 * 1000 }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stops, 0);
  assert.equal(fs.existsSync(personal), false);
  fs.writeFileSync(personal, JSON.stringify({ pid: 77, at: Date.now() }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stops, 1);
  assert.equal(fs.existsSync(personal), false);
});
