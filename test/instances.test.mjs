import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alreadyRunning, describe, processTable, reachHosts, sameBoot, stateOf, statusText, whereItRuns, windowsBootTime, windowsImage, windowsReachAlive, withoutHandover } from "../scripts/instances.mjs";
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
  assert.deepEqual(found.map((h) => [h.pid, h.root]), [[700, "/Users/me/reach"]]);
});

// First-run matrix H20: Windows has no ps. `status` names the Reach this
// folder runs from its own status file, while that process lives, and the
// running Reach stops when `stop` leaves it a request (no signals there).
test("Windows status: from the status file, only while its process lives", async () => {
  const { windowsHost, windowsStatusText } = await import("../scripts/instances.mjs");
  const status = { pid: 4242, startedAt: Date.parse("2026-10-10T09:05:00"), origin: "https://pc.t.ts.net:8443" };
  const read = () => JSON.stringify(status);
  const host = windowsHost("/state", { read, alive: (pid) => pid === 4242 });
  assert.equal(host.pid, 4242);
  const text = windowsStatusText(host, { command: ".\\reach.cmd", now: Date.parse("2026-10-10T12:00:00") });
  assert.match(text, /^Reach: running in a terminal \(process 4242\), since [^\n]*9:05[^\n]*\nLink: https:\/\/pc\.t\.ts\.net:8443$/);
  // A status file a stopped (or force-ended) Reach left: not running.
  assert.equal(windowsHost("/state", { read, alive: () => false }), null);
  assert.equal(windowsHost("/state", { read: () => { throw Object.assign(Error("gone"), { code: "ENOENT" }); } }), null);
  assert.equal(windowsHost("/state", { read: () => "{\"pid\":\"x\"}", alive: () => true }), null);
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
