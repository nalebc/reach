import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findReach, startInTerminal, startService, stopReach } from "../scripts/stop.mjs";
import { parseOptions } from "../scripts/launcher-options.mjs";

// `reach stop` and `reach restart`: every Reach from this folder stops (any
// terminal, detached, or the background service), as Ctrl+C stops it, then
// what it left behind; never another folder's, never this command itself.
const ROOT = "/Users/me/reach";
const OTHER = "/Users/me/other-reach";
const node = "/opt/homebrew/bin/node";
const table = () => [
  { pid: 100, ppid: 50, tty: "ttys007", command: `${node} ${ROOT}/scripts/bootstrap.mjs` },
  { pid: 101, ppid: 100, tty: "ttys007", command: `${ROOT}/.reach/quick/reach-mac-prompts-abc` },
  { pid: 102, ppid: 100, tty: "ttys007", command: "tailscale serve --https=8443 unix:/tmp/s" },
  { pid: 103, ppid: 100, tty: "ttys012", command: "/bin/zsh -l" },
  { pid: 104, ppid: 103, tty: "ttys012", command: "npm run dev" },
  { pid: 200, ppid: 1, tty: "??", command: `${node} ${ROOT}/scripts/bootstrap.mjs --folder /Users/me` },
  { pid: 300, ppid: 1, tty: "??", command: `${node} ${OTHER}/scripts/bootstrap.mjs` },
  { pid: 400, ppid: 60, tty: "ttys009", command: `${node} ${ROOT}/scripts/bootstrap.mjs approve` },
  { pid: 500, ppid: 60, tty: "ttys009", command: `${node} ${ROOT}/scripts/bootstrap.mjs stop` },
];

test("it finds every Reach from this folder (a terminal one, a detached one), with what each started and its terminals", () => {
  const found = findReach(ROOT, table(), 500);
  assert.deepEqual(found.map((h) => h.pid), [100, 200]);
  assert.deepEqual(found[0].descendants.map((d) => d.pid), [101, 102, 103, 104]);
  assert.deepEqual(found[0].terminals, [{ pid: 103, tty: "ttys012", shell: "zsh", running: ["npm"] }]);
  assert.deepEqual(found[1].terminals, []);
});

// Processes that end when told: hosts on Ctrl+C (unless `hung`), the rest on SIGTERM.
const world = ({ hung = [], helpersLinger = true } = {}) => {
  const alive = new Set(table().map((p) => p.pid));
  const signals = [];
  const kill = (pid, signal) => {
    if (signal === 0) {
      if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return;
    }
    signals.push([pid, signal]);
    if (signal === "SIGINT" && hung.includes(pid)) return;
    if (signal === "SIGINT" && [100, 200].includes(pid)) {
      alive.delete(pid);
      if (!helpersLinger) for (const p of [101, 102, 103, 104]) alive.delete(p);
      return;
    }
    if (signal === "SIGINT") return;
    alive.delete(pid);
  };
  return { alive, signals, kill };
};
const base = (w, extra = {}) => ({
  table,
  kill: w.kill,
  self: 500,
  wait: async () => {},
  graceMs: 30,
  termMs: 30,
  platform: "linux",
  print: () => {},
  ...extra,
});

test("stop: each the way Ctrl+C stops it, then the helpers it left; another folder's and this command left alone", async () => {
  const w = world();
  const done = await stopReach(ROOT, base(w, { yes: true }));
  assert.deepEqual(done, { stopped: 2, service: false, terminals: 1, serviceInstalled: false });
  assert.deepEqual(w.signals.filter(([, s]) => s === "SIGINT").map(([p]) => p), [100, 200]);
  // Helpers left behind get SIGTERM; nothing of the other folder's or ours.
  assert.deepEqual(w.signals.filter(([, s]) => s === "SIGTERM").map(([p]) => p).sort(), [101, 102, 103, 104]);
  assert.ok(w.alive.has(300) && w.alive.has(400) && w.alive.has(500));
});

test("a Reach that hangs on Ctrl+C is ended harder, step by step", async () => {
  const w = world({ hung: [200], helpersLinger: false });
  await stopReach(ROOT, base(w, { yes: true }));
  assert.deepEqual(w.signals.filter(([p]) => p === 200).map(([, s]) => s), ["SIGINT", "SIGTERM"]);
  assert.ok(!w.alive.has(200));
});

test("its terminals close with it: said first and asked; without a terminal to ask in, it needs --yes", async () => {
  const printed = [];
  const asked = world();
  const cancelled = await stopReach(ROOT, base(asked, { interactive: true, ask: async () => "n", print: (t) => printed.push(t) }));
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(asked.signals, []);
  assert.match(printed[0], /These terminals in Reach close with it:\n {2}zsh \(running npm\)/);
  const unattended = world();
  await assert.rejects(stopReach(ROOT, base(unattended, { interactive: false })), /Reach has 1 terminal open\. Run again with --yes to close them too\./);
  assert.deepEqual(unattended.signals, []);
  const agreed = world();
  assert.equal((await stopReach(ROOT, base(agreed, { interactive: true, ask: async () => "y" }))).stopped, 2);
});

const serviceHome = (root = ROOT) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-stop-"));
  fs.mkdirSync(path.join(home, "Library/LaunchAgents"), { recursive: true });
  fs.writeFileSync(path.join(home, "Library/LaunchAgents/com.reach.companion.plist"), `<plist><dict><key>WorkingDirectory</key><string>${root}</string></dict></plist>`);
  return home;
};
const launchd = (loaded) => {
  const calls = [];
  return {
    calls,
    launchctl: (args) => {
      calls.push(args);
      if (args[0] === "print") {
        if (!loaded) throw new Error("not loaded");
        return "state = running\n\tpid = 200\n";
      }
      return "";
    },
  };
};

test("the background service stops through launchd (it would come back otherwise); restart starts it again in one step", async () => {
  const home = serviceHome();
  const stopping = launchd(true);
  const w = world();
  const stopped = await stopReach(ROOT, base(w, { yes: true, platform: "darwin", home, uid: 501, launchctl: stopping.launchctl }));
  assert.deepEqual(stopping.calls.at(-1), ["bootout", "gui/501/com.reach.companion"]);
  assert.equal(stopped.service, true);
  // Only the one in the terminal was sent Ctrl+C; launchd ends the service.
  assert.deepEqual(w.signals.filter(([, s]) => s === "SIGINT").map(([p]) => p), [100]);
  const restarting = launchd(true);
  const r = world();
  await stopReach(ROOT, base(r, { yes: true, restarting: true, platform: "darwin", home, uid: 501, launchctl: restarting.launchctl }));
  assert.deepEqual(restarting.calls.at(-1), ["kickstart", "-k", "gui/501/com.reach.companion"]);
  assert.ok(r.alive.has(200), "the service is restarted by launchd, not killed");
  // Another folder's service is left to that folder.
  const elsewhere = launchd(true);
  const theirs = await stopReach(ROOT, base(world(), { yes: true, platform: "darwin", home: serviceHome(OTHER), uid: 501, launchctl: elsewhere.launchctl }));
  assert.equal(theirs.service, false);
  assert.ok(!elsewhere.calls.some(([verb]) => verb === "bootout" || verb === "kickstart"));
  // Installed but stopped: started again.
  const stoppedService = launchd(false);
  startService(ROOT, { launchctl: stoppedService.launchctl, home, uid: 501 });
  assert.deepEqual(stoppedService.calls.at(-1), ["bootstrap", "gui/501", path.join(home, "Library/LaunchAgents/com.reach.companion.plist")]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("nothing running: it says so", async () => {
  const printed = [];
  const done = await stopReach(ROOT, { ...base(world()), table: () => [], print: (t) => printed.push(t) });
  assert.deepEqual(printed, ["Reach isn't running from this folder."]);
  assert.equal(done.stopped, 0);
});

test("restarted without a terminal (as agents do), Reach opens in Terminal, where it keeps its permissions", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "reach-stop-state-"));
  const opened = [];
  const file = startInTerminal("/Users/me/it's reach", { state, nodeDir: "/opt/node/bin", open: (f) => opened.push(f) });
  assert.deepEqual(opened, [file]);
  const script = fs.readFileSync(file, "utf8");
  assert.match(script, /^#!\/bin\/bash\n# Reach: opened in Terminal by \.\/reach restart\.\n/);
  assert.ok(script.includes("cd '/Users/me/it'\\''s reach' || exit 1\n./reach\n"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o700);
  fs.rmSync(state, { recursive: true, force: true });
});

test("the commands: stop and restart, with --yes; --yes means nothing to other commands", () => {
  assert.deepEqual([parseOptions(["stop"]).command, parseOptions(["stop"]).yes], ["stop", undefined]);
  assert.deepEqual([parseOptions(["restart", "--yes"]).command, parseOptions(["restart", "-y"]).yes], ["restart", true]);
  assert.throws(() => parseOptions(["status", "--yes"]), /Unknown option: --yes/);
  assert.throws(() => parseOptions(["stop", "--folder", "/x"]), /does not accept setup options/);
});
