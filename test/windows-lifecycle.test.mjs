import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startInConsole } from "../scripts/stop.mjs";
import { windowsProcesses } from "../server/windows-processes.mjs";
import { endWindowsTerminal, isTerminal, useWindowsTerminal, whyNoWindowsTerminal, windowsTerminalTabs } from "./helpers/windows-terminal-portable.mjs";

// One Reach per computer, restarts and updates on a real Windows PC (audit
// #10, #11), on GitHub's Windows runner: the real launcher reads the PC's
// process list through its C# helper. A stand-in Reach from another folder
// (node running a scripts\bootstrap.mjs of its own, which watches for its stop
// request as Reach does) is what it finds. Off Windows, these are covered with
// the process list written out (instances, stop, agent-restart tests).
const windows = process.platform === "win32";
const real = { skip: !windows, timeout: 240000 };
const repo = fileURLToPath(new URL("..", import.meta.url));
const instances = pathToFileURL(path.join(repo, "scripts", "instances.mjs")).href;

function standIn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach lifecycle-"));
  const root = path.join(dir, "other reach");
  const state = path.join(dir, "state");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts", "bootstrap.mjs"),
    `import fs from "node:fs";
import path from "node:path";
import { watchStopRequest } from ${JSON.stringify(instances)};
const state = process.env.REACH_HOME;
fs.mkdirSync(path.join(state, "quick"), { recursive: true });
const status = path.join(state, "host-status.json");
fs.writeFileSync(status, JSON.stringify({ pid: process.pid, startedAt: Date.now(), dataDir: path.join(state, "quick"), origin: "http://127.0.0.1:1", window: false }));
watchStopRequest(state, { every: 100, stop: () => { fs.rmSync(status, { force: true }); console.log("STOPPED AS ASKED"); process.exit(0); } });
setInterval(() => {}, 1000);
console.log("STAND-IN READY");
`,
  );
  const env = { ...process.env, REACH_HOME: state };
  const child = spawn(process.execPath, [path.join(root, "scripts", "bootstrap.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ready = async () => {
    for (const until = Date.now() + 20000; !/STAND-IN READY/.test(output); ) {
      if (child.exitCode !== null || Date.now() > until) throw Error(`The stand-in didn't start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { dir, root, state, env, child, exited, ready, output: () => output };
}
// The real launcher, as `.\reach.cmd <args>` runs it, with no terminal (as an agent's shell).
const reach = (args, env) =>
  new Promise((resolve) =>
    execFile(process.execPath, [path.join(repo, "scripts", "bootstrap.mjs"), ...args], { env, timeout: 180000, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

test("on real Windows, status names a Reach from another folder, and a second Reach is refused with where the first runs", real, async (t) => {
  const other = standIn(t);
  await other.ready();
  // The Windows lane runs two test files at once: another test's Reach may
  // be running too, so its own lines are looked for among them.
  const status = await reach(["status"], other.env);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`Reach: running in the background, with no window, since [^\\n]+, from ${other.root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\r?\\nLink: http://127\\.0\\.0\\.1:1\\r?\\n`));
  // A second one, from this folder: refused, saying where the first runs.
  const second = await reach(["--local"], other.env);
  assert.equal(second.code, 1, second.stdout);
  assert.match(second.stderr, /(already running|copies are running:[\s\S]*·) in the background, with no window, since [^\n]+, from .*other reach(\.|\r?\n)/);
  assert.equal(other.child.exitCode, null, "the first one still runs");
});

test("on real Windows, an agent's restart asks on the phone and stops nothing", real, async (t) => {
  const other = standIn(t);
  await other.ready();
  const asked = await reach(["restart"], other.env);
  assert.equal(asked.code, 0, asked.stderr);
  assert.match(asked.stdout, /^Asked on the phone \(Needs you\): Reach restarts when the user taps Restart\./);
  const request = JSON.parse(fs.readFileSync(path.join(other.state, "quick", "restart-request.json"), "utf8"));
  assert.ok(request.id && request.app, JSON.stringify(request));
  assert.equal(other.child.exitCode, null, "nothing stopped");
});

test("on real Windows, Reach's own window opens from cmd's start in Windows Terminal, titled Reach, never a child of the Reach that asked", real, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach window-"));
  const root = path.join(dir, "reach");
  const state = path.join(dir, "state");
  const nativeDir = path.join(dir, "native");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  t.after(async () => {
    fs.writeFileSync(path.join(state, "stop"), "1");
    await new Promise((r) => setTimeout(r, 1500));
    await endWindowsTerminal({ nativeDir }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  // The process list's helper, built before the window opens (the PC's
  // compiler takes seconds, more under an antivirus).
  await windowsProcesses({ nativeDir });
  // Windows Terminal, as the owner's PC has it: the PC's own wt.exe, else its
  // pinned portable build put first on PATH (test/helpers/windows-terminal-portable.mjs).
  const terminal = await useWindowsTerminal();
  // What the window runs: Reach's entry, here one that says where it ran,
  // then stays until this test says stop (or five minutes pass).
  fs.writeFileSync(
    path.join(root, "bin", "reach.mjs"),
    `import fs from "node:fs";
const here = process.env.REACH_HOME;
fs.writeFileSync(here + "\\\\started.json", JSON.stringify({ pid: process.pid, title: process.title, openedBy: process.env.REACH_OPENED_BY, args: process.argv.slice(2), cwd: process.cwd() }));
const until = Date.now() + 5 * 60 * 1000;
setInterval(() => {
  if (fs.existsSync(here + "\\\\stop") || Date.now() > until) process.exit(0);
}, 250);
`,
  );
  startInConsole(root, { state, args: "restart --yes", env: { ...process.env, REACH_HOME: state } });
  const marker = path.join(state, "started.json");
  for (const until = Date.now() + 60000; !fs.existsSync(marker); ) {
    if (Date.now() > until) assert.fail(`Reach's window never ran it; ${await whyNoWindowsTerminal({ nativeDir })}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 200));
  const started = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.deepEqual(started.args, ["restart", "--yes"]);
  assert.equal(started.openedBy, "restart");
  // In the folder start gave it, never Reach's own (an update replaces that).
  assert.equal(started.cwd.toLowerCase(), state.toLowerCase());
  // cmd may add the command it runs after the title, and an administrator's
  // console puts "Administrator:" before it; Reach sets its own (launch.mjs).
  // Agents' presets find Reach's window by the word (agent-guard.mjs mentionsReach).
  assert.match(started.title, /^(Administrator: +)?Reach\b/);
  // Its parents, while it runs: never this process (the Reach that asked).
  const list = await windowsProcesses({ nativeDir });
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const chain = [];
  for (let p = byPid.get(started.pid); p && chain.length < 32; ) {
    chain.push(p.pid);
    const parent = byPid.get(p.ppid);
    p = parent && (parent.startedAt == null || p.startedAt == null || parent.startedAt <= p.startedAt) ? parent : null;
  }
  assert.ok(chain.length > 0, "it's running");
  assert.ok(!chain.includes(process.pid), `not a child of the Reach that asked: ${chain.join(" < ")}`);
  // In Windows Terminal: the one wt.exe started (its own program, never a
  // console Windows handed over), showing a tab titled Reach.
  const hosts = chain.map((pid) => byPid.get(pid)).filter((p) => /^WindowsTerminal\.exe$/i.test(p.image));
  assert.equal(hosts.length, 1, `Windows Terminal runs it: ${chain.map((pid) => byPid.get(pid).image).join(" < ")}`);
  assert.ok(isTerminal(hosts[0], terminal), `the Windows Terminal Reach found (${terminal.wt}): ${hosts[0].path}`);
  const tabs = (await windowsTerminalTabs()).filter((w) => w.pid === hosts[0].pid);
  assert.ok(tabs.some((w) => w.tabs.some((tab) => /^Reach\b/.test(tab.name))), `a tab titled Reach: ${JSON.stringify(tabs)}`);
});
