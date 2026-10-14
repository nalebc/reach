import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseLaunchStatus, serviceLabel } from "./background-service.mjs";
import { command } from "./home.mjs";
import { loginScript } from "./login-start.mjs";
import { windowsPath } from "../server/app-identity.mjs";
import { windowsTerminalExe } from "../server/windows-shell.mjs";
import { handoffPersistentRoute } from "./persistent-serve.mjs";

// `reach stop` / `reach restart`: every Reach running on this computer (one
// should; any folder), in a terminal tab, started detached, or the background
// service, stops the way
// Ctrl+C stops it (its terminals and jobs end with it), then any helper it
// left behind. Restart starts it again: the background service if that's how
// it ran, otherwise right here in this terminal.

// The processes and every Reach among them (instances.mjs): one Reach per
// computer, so stop and restart reach it whichever folder it came from.
import { personalStopFile, processTable, reachHosts, stateOf, stopRequestFile, windowsHost, windowsImage, windowsReaches, windowsStarters } from "./instances.mjs";
import { windowsProcesses } from "../server/windows-processes.mjs";
import { backgroundTask, windowsTask } from "./windows-task.mjs";
export { processTable };
// Every Reach running (never this command itself); `root` limits it to one folder's.
export const findReach = (root, table, self = process.pid) => reachHosts(table, { self, root });

// The background service (./reach install), and whether it's this folder's.
export function serviceState(root, { run, home = os.homedir(), uid = process.getuid?.() } = {}) {
  const plist = path.join(home, "Library/LaunchAgents", `${serviceLabel}.plist`);
  const installed = fs.existsSync(plist);
  const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // This folder's job: by its program path (older plists also named the
  // folder as the working directory). Same test as background-service.mjs.
  const text = installed ? fs.readFileSync(plist, "utf8") : "";
  const ours = installed && (text.includes(`<string>${xml(path.join(root, "scripts/bootstrap.mjs"))}</string>`) ||
    text.includes(`<key>WorkingDirectory</key><string>${xml(root)}</string>`));
  let loaded = false;
  let pid = null;
  try {
    const status = parseLaunchStatus(run(["print", `gui/${uid}/${serviceLabel}`]));
    loaded = true;
    pid = status.pid || null;
  } catch {
    /* not loaded */
  }
  return { installed, ours, loaded, pid, plist, target: `gui/${uid}/${serviceLabel}`, domain: `gui/${uid}` };
}

const alive = (kill, pid) => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

export async function stopReach(
  root,
  {
    yes = false,
    restarting = false,
    interactive = !!process.stdin.isTTY,
    print = console.log,
    ask = async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    table = () => processTable(),
    launchctl = (args) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    kill = (pid, signal) => process.kill(pid, signal),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    self = process.pid,
    home,
    uid,
    platform = process.platform,
    graceMs = 15000,
    termMs = 5000,
    state = stateOf,
    handoffRoute = handoffPersistentRoute,
    windows = {},
  } = {},
) {
  if (platform === "win32")
    return stopWindows(root, { yes, restarting, interactive, print, ask, wait, state, self, ...windows });
  const hosts = findReach(null, table(), self);
  const service = platform === "darwin" ? serviceState(root, { run: launchctl, home, uid }) : { loaded: false, ours: false };
  // Reach's one background service, whichever folder installed it.
  const serviceRunning = service.loaded;
  if (!hosts.length && !serviceRunning) {
    if (!restarting) print("Reach isn't running.");
    return { stopped: 0, service: false, terminals: 0, serviceInstalled: !!service.ours };
  }
  // What closes with it: said first, and asked about.
  const terminals = hosts.flatMap((h) => h.terminals);
  if (terminals.length && !yes) {
    print(
      `These terminals in Reach close with it:\n${terminals
        .map((t) => `  ${t.shell}${t.running.length ? ` (running ${t.running.join(", ")})` : ""}`)
        .join("\n")}`,
    );
    if (!interactive)
      throw Error(`Reach has ${terminals.length} terminal${terminals.length > 1 ? "s" : ""} open. Run again with --yes to close them too.`);
    const answer = await ask(`${restarting ? "Restart" : "Stop"} Reach anyway? [y/N] `);
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      print("Nothing was stopped.");
      return { cancelled: true, stopped: 0, service: false, terminals: 0 };
    }
  }
  // The background service goes through launchd (it would come back
  // otherwise); a restart starts it again in one step.
  const serviceHost = (h) => serviceRunning && (h.service || h.pid === service.pid);
  // A restart starts the service again only after the other hosts exited, so
  // two Reaches never run at once.
  if (serviceRunning && !restarting) launchctl(["bootout", service.target]);
  // Another user's Reach can't be signalled (EPERM): said, never "Stopped".
  const foreign = new Set();
  const send = (pid, signal) => {
    try {
      kill(pid, signal);
    } catch (error) {
      if (error.code === "EPERM") foreign.add(pid);
    }
  };
  // The others the way Ctrl+C stops them; harder only if they hang.
  const others = hosts.filter((h) => !serviceHost(h));
  for (const host of others) send(host.pid, "SIGINT");
  const waitGone = async (pids, ms) => {
    pids = pids.filter((pid) => !foreign.has(pid));
    for (const until = Date.now() + ms; pids.some((pid) => alive(kill, pid)) && Date.now() < until; ) await wait(200);
    return pids.filter((pid) => alive(kill, pid));
  };
  // A stopped service exits on launchd's word; it's waited for too.
  const gone = restarting ? others : hosts;
  const hostPids = gone.map((h) => h.pid);
  let left = await waitGone(hostPids, graceMs);
  for (const pid of left) send(pid, "SIGTERM");
  left = await waitGone(left, termMs);
  for (const pid of left) send(pid, "SIGKILL");
  if (serviceRunning && restarting) launchctl(["kickstart", "-k", service.target]);
  // Helpers a stopped Reach left running (its tunnel, stay-awake, …).
  const leftovers = gone.flatMap((h) => h.descendants.map((d) => d.pid)).filter((pid) => alive(kill, pid));
  for (const pid of leftovers)
    try {
      kill(pid, "SIGTERM");
    } catch {}
  for (const pid of await waitGone(leftovers, 2000))
    try {
      kill(pid, "SIGKILL");
    } catch {}
  if (restarting && !serviceRunning) {
    if ((await waitGone(hostPids, 2000)).length || others.some((h) => foreign.has(h.pid)))
      throw Error("Reach did not stop. Its route was not transferred; try again after it exits.");
    const file = path.join(state(root), "serve-owner.json");
    const sources = [...new Set(others.flatMap((host) =>
      // The caller's REACH_HOME may be a new destination. Also inspect the
      // old checkout's default state; handoff verifies exact route ownership.
      [state(host.root), state(host.root, undefined, {})].map((dir) => path.join(dir, "serve-owner.json")),
    ))];
    await handoffRoute({ file, sources });
  }
  const stopped = others.filter((h) => !foreign.has(h.pid)).length;
  for (const pid of foreign) print(`Reach (process ${pid}) is owned by another user; it can't be stopped from here.`);
  if (serviceRunning && !restarting)
    print(`The background service stopped; it starts again at your next sign-in, or with ${command} restart.`);
  if (stopped) print(`Stopped ${stopped === 1 ? "Reach" : `${stopped} Reaches`}${terminals.length ? ` and ${terminals.length} terminal${terminals.length > 1 ? "s" : ""} in it` : ""}.`);
  return { stopped, service: serviceRunning, terminals: terminals.length, serviceInstalled: !!service.ours };
}

// Windows: no signals to ask with. Every Reach on the PC (its process list:
// instances.mjs) is asked through a file it watches (launch.mjs) and stops
// as Ctrl+C stops it, terminals and all. Only one that doesn't is ended, and
// only while it's still the very process that was asked (same id, same
// start: Windows hands ids out again); then what it left running, the same
// way. Where the process list can't be read, the Reach this folder runs, as
// FIRST_RUN_MATRIX H20 had it, said as such.
// The background task (`task`: scripts/windows-task.mjs) starts its Reach
// again when that Reach ends: told not to first, as launchd's bootout does
// on a Mac.
const living = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
async function stopWindows(
  root,
  {
    yes,
    restarting,
    interactive,
    print,
    ask,
    wait,
    state,
    self = process.pid,
    env = process.env,
    list = () => windowsProcesses({ nativeDir: path.join(state(root), "native") }),
    reaches = () => windowsReaches({ root, state: state(root), self, list }),
    alive = living,
    end = (pid) => process.kill(pid),
    graceMs = 15000,
    task = backgroundTask({ env }),
    // How long a held starter gets to end by itself, and a started task to show.
    starterMs = 3000,
    startMs = 10000,
    ...thisFolder
  },
) {
  const found = await reaches();
  if (found.partial) {
    print(`Reach couldn't read this PC's process list (${found.partial}), so only the Reach run from this folder is stopped.`);
    return stopThisFolder(root, { yes, restarting, interactive, print, ask, wait, state, alive, graceMs, host: found.hosts[0] || null, ...thisFolder });
  }
  const { hosts, processes } = found;
  const service = task.state(root);
  const serviceRunning = hosts.some((h) => h.service) || windowsStarters(processes).length > 0;
  if (!hosts.length && !serviceRunning) {
    if (!restarting) print("Reach isn't running.");
    return { stopped: 0, service: false, terminals: 0, serviceInstalled: !!service.ours };
  }
  // What closes with it: said first, and asked about.
  const terminals = hosts.flatMap((h) => h.terminals);
  if (terminals.length && !yes) {
    print(`These terminals in Reach close with it:\n${terminals.map((t) => `  ${t.shell}${t.running.length ? ` (running ${t.running.join(", ")})` : ""}`).join("\n")}`);
    if (!interactive) throw Error(`Reach has ${terminals.length} terminal${terminals.length > 1 ? "s" : ""} open. Run again with --yes to close them too.`);
    const answer = await ask(`${restarting ? "Restart" : "Stop"} Reach anyway? [y/N] `);
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      print("Nothing was stopped.");
      return { cancelled: true, stopped: 0, service: false, terminals: 0 };
    }
  }
  if (serviceRunning) task.hold(root);
  // Each in its own folder's file, and by its id in your app data (a Reach
  // with another REACH_HOME, or whose folder its command line doesn't name).
  const files = new Set();
  for (const host of hosts) {
    const dirs = host.root ? [state(host.root), state(host.root, undefined, {})] : [];
    for (const file of [...dirs.map(stopRequestFile), personalStopFile(host.pid, env)].filter(Boolean)) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify({ pid: host.pid, at: Date.now() }), { mode: 0o600 });
        files.add(file);
      } catch {}
    }
  }
  const waitGone = async (left, ms) => {
    for (const until = Date.now() + ms; left.some((h) => alive(h.pid)) && Date.now() < until; ) await wait(200);
    return left.filter((h) => alive(h.pid));
  };
  const same = (now, p) => p.startedAt != null && !!now?.some((q) => q.pid === p.pid && q.startedAt === p.startedAt);
  const endAll = async (left) => {
    const now = await list().catch(() => null);
    for (const p of left) if (same(now, p)) try { end(p.pid); } catch {}
  };
  // Polled from the process list: whether a starter of yours is left, and
  // whether the task started one (or its Reach) again.
  const poll = async (ms, done) => {
    for (const until = Date.now() + ms; ; await wait(200)) {
      const now = await list().catch(() => null);
      if (now && done(now)) return true;
      if (Date.now() >= until) return false;
    }
  };
  const startersGone = (ms) => poll(ms, (now) => !windowsStarters(now).length);
  const before = new Set(windowsStarters(processes).map((p) => p.pid));
  const started = (ms) => poll(ms, (now) => windowsStarters(now).some((p) => !before.has(p.pid)));
  let left;
  try {
    left = await waitGone(hosts, graceMs);
    if (left.length) {
      await endAll(left);
      left = await waitGone(left, 3000);
    }
    // Held, the starter ends by itself once its Reach has. Task Scheduler's
    // End, which may end everything the task started (a window it opened for
    // this very restart included), only for one that doesn't.
    if (serviceRunning && !(await startersGone(starterMs))) task.end(root);
    // Helpers a stopped Reach left running (its tunnel, stay-awake, …).
    await endAll(hosts.filter((h) => !left.includes(h)).flatMap((h) => h.descendants));
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
    if (serviceRunning) task.release(root);
  }
  if (left.length) throw Error(`Reach (process ${left[0].pid}) did not stop by itself. Close its window, or end it in Task Manager.`);
  // A restart starts the background task again once every Reach and its
  // starter are gone (a task still running would ignore the start), and
  // checks it did start.
  if (serviceRunning && restarting) {
    await startersGone(starterMs);
    task.run(root);
    if (!(await started(startMs))) print(`Reach's background task didn't start again. Run ${command} restart once more, or sign out and back in.`);
  }
  const stopped = hosts.filter((h) => !(serviceRunning && h.service)).length;
  if (serviceRunning && !restarting)
    print(`The background service stopped; it starts again at your next sign-in, or with ${command} restart.`);
  if (stopped) print(`Stopped ${stopped === 1 ? "Reach" : `${stopped} Reaches`}${terminals.length ? ` and ${terminals.length} terminal${terminals.length > 1 ? "s" : ""} in it` : ""}.`);
  return { stopped, service: serviceRunning, terminals: terminals.length, serviceInstalled: !!service.ours };
}

// Only the Reach this folder runs (its status file), when the PC's process
// list can't be read: asked first (which terminals are open isn't known),
// then through its file; ended with its process tree only while its id is
// still Node.
async function stopThisFolder(
  root,
  {
    yes,
    restarting,
    print,
    ask,
    wait,
    state,
    interactive,
    alive,
    graceMs,
    host = windowsHost(state(root)),
    taskkill = (pid) =>
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }),
    image = windowsImage,
  },
) {
  if (!host) {
    if (!restarting) print("Reach isn't running from this folder.");
    return { stopped: 0, service: false, terminals: 0, serviceInstalled: false };
  }
  // Which terminals are open isn't known from here: asked about every time.
  if (!yes) {
    if (!interactive)
      throw Error("Reach's terminals, if any are open, close with it. Run again with --yes to close them too.");
    const answer = await ask(`${restarting ? "Restart" : "Stop"} Reach? Any terminals open in it close too. [y/N] `);
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      print("Nothing was stopped.");
      return { cancelled: true, stopped: 0, service: false, terminals: 0 };
    }
  }
  const file = stopRequestFile(state(root));
  fs.writeFileSync(file, JSON.stringify({ pid: host.pid, at: Date.now() }), { mode: 0o600 });
  const gone = async (ms) => {
    for (const until = Date.now() + ms; alive(host.pid) && Date.now() < until; ) await wait(200);
    return !alive(host.pid);
  };
  try {
    if (!(await gone(graceMs))) {
      // Ended outright only while that id is still Node: never a program
      // that got Reach's old id after it ended.
      if (image(host.pid) !== "node.exe")
        throw Error(`Reach (process ${host.pid}) did not stop by itself. Close its PowerShell window, or end it in Task Manager.`);
      try {
        taskkill(host.pid);
      } catch {}
      if (!(await gone(3000))) throw Error(`Reach (process ${host.pid}) did not stop.`);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  print("Stopped Reach.");
  return { stopped: 1, service: false, terminals: 0, serviceInstalled: false };
}

// The background service started again (stopped earlier, still installed).
// Windows: its task, run now.
export function startService(root, { launchctl = (args) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), home, uid, platform = process.platform, task = platform === "win32" ? windowsTask() : null } = {}) {
  if (platform === "win32") {
    if (!task.state(root).ours) throw Error("Reach's background service isn't installed from this folder.");
    return task.run();
  }
  const service = serviceState(root, { run: launchctl, home, uid });
  if (!service.ours) throw Error("Reach's background service isn't installed from this folder.");
  if (service.loaded) launchctl(["kickstart", "-k", service.target]);
  else launchctl(["bootstrap", service.domain, service.plist]);
}

// Reach started where it keeps its permissions: Terminal holds Reach's Screen
// Recording and Accessibility, and gives device approvals a place. Asked for
// without a terminal (an agent's restart), it opens one, as at sign-in.
// `args`: what it runs (`restart --yes` once you allowed an agent's restart).
export function startInTerminal(root, { state, args = "", env = process.env, nodeDir = path.dirname(process.execPath), open = (file) => execFileSync("/usr/bin/open", ["-a", "Terminal", file]) } = {}) {
  const file = path.join(state, "start-in-terminal.command");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, loginScript(root, nodeDir, { args, env, restart: true }), { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  open(file);
  return file;
}

// Windows' twin: Reach in a window of its own, titled Reach (the window
// agents' presets know as Reach's), where you see it and approve new phones.
// The script it runs carries what Reach needs (Windows Terminal starts new
// tabs with your sign-in environment, not the caller's). Anything cmd would
// read as a variable or a quote end in a path is refused, never mangled.
const ENV_KEPT = ["REACH_HOME", "REACH_DATA"];
const windowsFolder = (env) => {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  return windowsPath(root) ? root : "";
};
export function consoleScript(root, node, { args = "", env = process.env } = {}) {
  // The server names its folder with a trailing \ (new URL("../")).
  root = String(root).replace(/(?<=[^:\\/])[\\/]+$/, "");
  const values = [root, node, ...ENV_KEPT.map((key) => env[key]).filter((value) => value !== undefined)];
  const odd = values.find((value) => /[%"\r\n]/.test(String(value)));
  if (odd !== undefined) throw Error(`Reach can't open a window of its own from ${odd}: its path has a % sign or a quote. Start it yourself with ${command}.`);
  return [
    "@echo off",
    "rem Reach: opened in a window of its own by a restart or an update.",
    "title Reach",
    `set "PATH=${path.win32.dirname(node)};%PATH%"`,
    ...ENV_KEPT.filter((key) => env[key] !== undefined).map((key) => `set "${key}=${env[key]}"`),
    // Started for you (a restart from the phone): nobody is reading this
    // window's QR, so no pairing window opens by itself.
    'set "REACH_OPENED_BY=restart"',
    // It works in the folder start gave it, never Reach's own: an update
    // replaces Reach's folder, and Windows won't while a program works in it.
    `"${node}" "${path.win32.join(root, "bin", "reach.mjs")}"${args ? ` ${args}` : ""}`,
    // What went wrong stays on screen; Ctrl+C (130) closes it.
    "if errorlevel 1 if not errorlevel 130 pause",
    "",
  ].join("\r\n");
}
// Through cmd's `start`, which returns at once: the window is never a child
// of the Reach it restarts (stopping that Reach ends what it started). In
// Windows Terminal when it's installed, else a console window.
export function startInConsole(root, {
  state,
  args = "",
  env = process.env,
  node = process.execPath,
  exists = fs.existsSync,
  run = (file, argv, options) => execFileSync(file, argv, options),
} = {}) {
  const system = windowsFolder(env);
  if (!system) throw Error("Reach couldn't find the Windows folder on this PC to open a window of its own.");
  if (/[%"\r\n]/.test(state)) throw Error(`Reach can't open a window of its own from ${state}: its path has a % sign or a quote. Start it yourself with ${command}.`);
  const script = consoleScript(root, node, { args, env });
  const file = path.join(state, "start-in-console.cmd");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, script, { mode: 0o700 });
  const cmd = path.win32.join(system, "System32", "cmd.exe");
  // Found as the PC's own terminals are (windows-shell.mjs): its alias, else
  // PATH; one whose path cmd would read as a variable or a quote isn't used.
  const found = windowsTerminalExe({ env, exists });
  const terminal = /[%"]/.test(found) ? "" : found;
  const tab = `"${cmd}" /d /v:off /c start-in-console.cmd`;
  // Windows Terminal reads ; as "and then"; \; is a plain one.
  const line = terminal
    ? `start "Reach" /D "${state}" "${terminal}" -w new new-tab --title Reach --suppressApplicationTitle -d "${state.replace(/;/g, "\\;")}" ${tab}`
    : `start "Reach" /D "${state}" ${tab}`;
  run(cmd, ["/d", "/v:off", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true, stdio: "ignore", timeout: 15000 });
  return file;
}
// Reach in a window of its own, the way this computer has one.
export const startInWindow = (root, options = {}, platform = process.platform) =>
  platform === "win32" ? startInConsole(root, options) : startInTerminal(root, options);
