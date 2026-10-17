// One Reach per computer. Every Reach running here, whichever folder it was
// started from, read from the process list itself (nothing to go stale): where
// it runs (a Terminal window, the background with no window, the background
// service), since when, from which folder, and its link. Starting a second one
// says where the first is and what to run instead; `reach status`, `reach stop`
// and `reach restart` work on whichever one runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stateDir } from "./home.mjs";

export class ProcessInventoryError extends Error {
  constructor(cause) {
    super("Can't determine whether Reach is running: the system process list is unavailable. Run this command in Terminal or allow process inspection in this shell.", { cause });
    this.code = "REACH_PROCESS_INVENTORY_UNAVAILABLE";
  }
}

// The processes now: id, parent, terminal, command line. An unavailable
// inventory is unknown, never evidence that it is safe to start another Reach.
export function processTable(run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 32 << 20, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })) {
  let output;
  try {
    output = String(run("/bin/ps", ["-axo", "pid=,ppid=,tty=,command="]));
  } catch (error) {
    throw new ProcessInventoryError(error);
  }
  const table = output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, tty, command]) => ({ pid: Number(pid), ppid: Number(ppid), tty, command }));
  if (output.trim() && !table.length) throw new ProcessInventoryError(Error("Unrecognized process inventory."));
  return table;
}

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "tcsh", "csh", "ksh", "dash", "nu", "pwsh"]);
const nameOf = (command) => path.basename(command.split(/\s+/)[0]).replace(/^-/, "");
// How a Reach is launched: ./reach (scripts/bootstrap.mjs) or the installed
// `reach` (bin/reach.mjs).
const ENTRIES = ["/scripts/bootstrap.mjs", "/bin/reach.mjs"];
// Flags that make it a one-off command (it hands over or prints), not a Reach.
const ONE_OFF = new Set(["--background", "--stop-background", "--help", "-h", "--version", "-v"]);

// The Reach folder a command runs from, and what follows the script.
function entryOf(command, exists = fs.existsSync) {
  for (const entry of ENTRIES) {
    const at = command.indexOf(`${entry} `) >= 0 ? command.indexOf(`${entry} `) : command.endsWith(entry) ? command.length - entry.length : -1;
    if (at < 0) continue;
    const end = at + entry.length;
    // The script's path: after the interpreter (paths may hold spaces).
    const start = command.indexOf(" /");
    let script = start >= 0 && start < at ? command.slice(start + 1, end) : "";
    if (!script || !exists(script)) script = (command.slice(0, end).match(/(\S+)$/) || [""])[0];
    return { root: path.dirname(path.dirname(script)), rest: command.slice(end).trim() };
  }
  // Relative to the working directory: `node scripts/bootstrap.mjs`.
  for (const entry of ENTRIES) {
    const rel = entry.slice(1);
    const found = command.match(new RegExp(`^\\S*node\\s+${rel.replace(/[.]/g, "\\.")}(?=\\s|$)`));
    if (found) return { root: path.dirname(path.dirname(rel)), rest: command.slice(found[0].length).trim() };
  }
  return null;
}

// The Mac app a process runs inside: the outermost .app among its ancestors.
// macOS gives Screen Recording and Accessibility to that app, so a Reach
// started from an agent's shell (Codex in ChatGPT, Claude, an editor) has a
// terminal but neither permission: the live screen never loads (Oct 6).
export function hostApp(table, pid) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  let app = "";
  for (let p = byPid.get(pid), hops = 0; p && hops < 64; p = byPid.get(p.ppid), hops++) {
    const found = p.command.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
    if (found) app = found[1];
    if (p.ppid <= 1) break;
  }
  return app;
}
// Run from a Mac app other than Terminal (which holds Reach's permissions).
export const outsideTerminal = (app) => !!app && app !== "Terminal";

// The pid holding a folder's launcher lock (the Reach running from it).
const lockHolder = (root) => {
  try {
    return Number(JSON.parse(fs.readFileSync(path.join(stateOf(root), "launcher.lock"), "utf8")).pid) || null;
  } catch {
    return null;
  }
};

// Every Reach running (never `self`), each with everything it started and the
// terminals among those. `root` limits it to one folder's.
// A Reach started as `node scripts/bootstrap.mjs` (npm run go) shows a path
// relative to its working directory; that directory is read for it alone.
const cwdOfPid = (pid) => {
  try {
    const out = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").find((l) => l.startsWith("n"))?.slice(1) || "";
  } catch {
    return "";
  }
};
export function reachHosts(table, { self = process.pid, root = null, exists, locked = lockHolder, cwdOf = cwdOfPid } = {}) {
  const children = new Map();
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) || []), p]);
  const below = (pid) => (children.get(pid) || []).flatMap((c) => [c, ...below(c.pid)]);
  const resolved = (p, entry) => {
    if (!entry || path.isAbsolute(entry.root) || !/(^|\s)node(\s|$)|\/node\s/.test(p.command)) return entry;
    const cwd = cwdOf(p.pid);
    return cwd ? { ...entry, root: path.resolve(cwd, entry.root) } : entry;
  };
  const runsReach = (p, entry) => {
    if (!entry) return false;
    // A host runs with no command (flags only); `reach approve` and the
    // like running beside it are left alone.
    const args = entry.rest.split(/\s+/).filter(Boolean);
    // `reach restart` run in a terminal goes on to run Reach itself: a
    // Reach once it holds its folder's lock.
    if (args[0] === "restart") return locked(entry.root) === p.pid;
    return (!args.length || args[0].startsWith("-")) && !args.some((a) => ONE_OFF.has(a));
  };
  // `reach` from an npm install runs Reach as its own child, to start it
  // again after a crash (scripts/supervise.mjs): that child is the Reach,
  // whichever of the two asks (the child itself included).
  const supervisor = (p) => /\/bin\/reach\.mjs(\s|$)/.test(p.command) &&
    (children.get(p.pid) || []).some((c) => /\/scripts\/bootstrap\.mjs(\s|$)/.test(c.command) && runsReach(c, resolved(c, entryOf(c.command, exists))));
  return table
    .map((p) => ({ p, entry: p.pid === self ? null : entryOf(p.command, exists) }))
    .map(({ p, entry }) => ({ p, entry: resolved(p, entry) }))
    .filter(({ p, entry }) => runsReach(p, entry) && !supervisor(p))
    .filter(({ entry }) => !root || path.resolve(entry.root) === path.resolve(root))
    .map(({ p: host, entry }) => {
      const descendants = below(host.pid);
      const terminals = descendants
        .filter((p) => SHELLS.has(nameOf(p.command)))
        .map((shell) => {
          const inside = (children.get(shell.pid) || []).map((c) => nameOf(c.command)).filter(Boolean);
          return { pid: shell.pid, tty: shell.tty, shell: nameOf(shell.command), running: inside };
        });
      return {
        pid: host.pid,
        tty: host.tty,
        root: entry.root,
        service: /\s--service(\s|$)/.test(host.command),
        app: hostApp(table, host.pid),
        descendants,
        terminals,
      };
    });
}

// A Reach handing itself over to the background service (first-run setup)
// stays open until the phone connects; the service it starts isn't a second copy.
export const handoverFile = (state) => path.join(state, "handover.pid");
export function withoutHandover(hosts, state, read = (f) => fs.readFileSync(f, "utf8")) {
  let pid = 0;
  try {
    pid = Number(read(handoverFile(state)));
  } catch {}
  return pid ? hosts.filter((h) => h.pid !== pid) : hosts;
}

// When each started (one ps call for all of them).
// (ps writes dates in the Mac's own language and order: the C locale's is the
// one Date.parse reads.)
export function startTimes(pids, run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } })) {
  if (!pids.length) return new Map();
  try {
    const out = String(run("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]));
    return new Map(
      out
        .split("\n")
        .map((line) => line.match(/^\s*(\d+)\s+(.+?)\s*$/))
        .filter(Boolean)
        .map(([, pid, when]) => [Number(pid), Date.parse(when)]),
    );
  } catch {
    return new Map();
  }
}

const home = (folder, dir = os.homedir()) => (folder.startsWith(`${dir}/`) ? `~${folder.slice(dir.length)}` : folder);
const clock = (ms, now = Date.now()) => {
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === at.toDateString()
    ? time
    : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};

// Where it runs, in words. Windows names no terminal as ps does on a Mac:
// there, the process.
export function whereItRuns(host) {
  if (host.service) return "as the background service";
  if (!host.tty || host.tty === "??" || host.tty === "?") return "in the background, with no window";
  if (host.platform === "win32")
    return outsideTerminal(host.app) ? `inside ${host.app} (process ${host.pid}), not a window of its own` : `in a terminal window (process ${host.pid})`;
  if (outsideTerminal(host.app)) return `inside ${host.app} (${host.tty}), not a Terminal window`;
  return `in a Terminal window (${host.tty})`;
}

// Its saved state: a source folder keeps .reach inside; an npm install, ~/.reach.
export const stateOf = (root, exists = fs.existsSync, env = process.env) => stateDir(root, { installed: !exists(path.join(root, "src/main.tsx")), env });

// What its server reports while it runs: its link, and whether it keeps the Mac awake.
// A Windows Reach's own file only (no ps to ask there): a file another run
// left behind names another process.
export function runtimeOf(host, { state = stateOf, read = (f) => JSON.parse(fs.readFileSync(f, "utf8")) } = {}) {
  if (!host.root) return {};
  try {
    const status = read(path.join(state(host.root), "host-status.json")) || {};
    return host.platform === "win32" && status.pid !== host.pid ? {} : status;
  } catch {
    return {};
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
// When Windows last started, in seconds (it has no boot id to read, as macOS
// and Linux do). Two readings within two minutes are the same boot.
export const windowsBootTime = (now = Date.now(), uptime = os.uptime()) => Math.round(now / 1000 - uptime);
export const sameBoot = (a, b) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 120 : a === b;
// A Windows process's program ("node.exe"), from tasklist: "" when no process
// has that id, null when tasklist can't say. Windows hands a finished
// process's id to the next one within minutes, so an id alone names nothing.
export function windowsImage(
  pid,
  run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }),
) {
  let out;
  try {
    out = String(run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]));
  } catch {
    return null;
  }
  const row = out.match(/^"([^"]+)","(\d+)"/m);
  return row && Number(row[2]) === pid ? row[1].toLowerCase() : "";
}
// Whether a recorded Windows Reach still runs: its process lives, in the same
// boot, and is still Node (Oct 12: after a crash or reboot, an unrelated
// program with a reused id was "Reach", and stop would have ended it).
export function windowsReachAlive(record, { alive = pidAlive, image = windowsImage, boot = windowsBootTime } = {}) {
  if (!Number.isInteger(record?.pid) || record.pid <= 0 || !alive(record.pid)) return false;
  if (typeof record.boot === "number" && !sameBoot(record.boot, boot())) return false;
  const name = image(record.pid);
  return name === null || name === "node.exe";
}
// The Reach this folder runs, from its own status file (written as it
// starts, removed as it stops), while that process lives: what Windows
// knows when its process list can't be read (FIRST_RUN_MATRIX H20).
export function windowsHost(state, { read = (f) => fs.readFileSync(f, "utf8"), alive = pidAlive, image = windowsImage, boot = windowsBootTime } = {}) {
  let host = null;
  try {
    host = JSON.parse(read(path.join(state, "host-status.json")));
  } catch {}
  return windowsReachAlive(host, { alive, image, boot }) ? host : null;
}
// That status file as a Reach for status, lock, stop and restart.
export const recordedHost = (record, root = null) => ({
  pid: record.pid,
  root,
  service: !!record.service,
  tty: record.window === false ? "" : "console",
  app: "",
  descendants: [],
  terminals: [],
  startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
  platform: "win32",
});
// Its lines, as `status` prints any Reach's.
export function windowsStatusText(record, { command = "reach", now, root = null } = {}) {
  if (!record) return `Reach isn't running from this folder. Start it with ${command}.`;
  const host = recordedHost(record, root);
  return statusText([host], { command, now, started: new Map([[host.pid, host.startedAt]]), runtime: () => record });
}

// Windows: every Reach on the PC from its process list (server/
// windows-processes.mjs), as ps lists them on a Mac: whichever folder, how
// it runs, what it started. A command line, split as Windows programs split
// theirs (the C runtime's rules: quotes group, backslashes escape only a
// quote).
export function windowsArgv(commandLine) {
  const line = String(commandLine || "");
  const args = [];
  let i = 0;
  // The program: up to the closing quote, or the first space; no escapes.
  if (line[0] === '"') {
    const end = line.indexOf('"', 1);
    args.push(line.slice(1, end < 0 ? line.length : end));
    i = end < 0 ? line.length : end + 1;
  } else {
    while (i < line.length && !/\s/.test(line[i])) i++;
    args.push(line.slice(0, i));
  }
  for (;;) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let arg = "";
    let quoted = false;
    while (i < line.length && (quoted || !/\s/.test(line[i]))) {
      let slashes = 0;
      while (line[i] === "\\") (slashes++, i++);
      if (line[i] === '"') {
        arg += "\\".repeat(slashes >> 1);
        if (slashes % 2) arg += '"';
        else if (quoted && line[i + 1] === '"') (arg += '"', i++);
        else quoted = !quoted;
        i++;
      } else {
        arg += "\\".repeat(slashes);
        if (i < line.length && (quoted || !/\s/.test(line[i]))) arg += line[i++];
      }
    }
    args.push(arg);
  }
  return args;
}
// How a Windows Reach is launched (node.exe running one of its entries) and
// its folder: null when the entry's path is relative (its working directory
// isn't read). Code given to node -e or -p is never one.
const ENTRY = /(?:^|\\)(scripts\\bootstrap|bin\\reach)\.mjs$/i;
export function windowsEntry(argv) {
  for (let i = 1; i < argv.length; i++) {
    if (/^(-e|--eval|-p|--print)$/.test(argv[i])) return null;
    const script = argv[i].replace(/\//g, "\\");
    const found = ENTRY.exec(script);
    if (!found) continue;
    const full = path.win32.isAbsolute(script) && /^[A-Za-z]:\\/.test(script) ? path.win32.normalize(script) : "";
    return { root: full ? path.win32.dirname(path.win32.dirname(full)) : null, entry: found[1].toLowerCase().replace(/\\/g, "/"), rest: argv.slice(i + 1) };
  }
  return null;
}
const stem = (image) => String(image || "").replace(/\.exe$/i, "").toLowerCase();
// What a process runs inside on Windows: the first program among its parents
// that isn't a shell or Node, named; "" for a terminal, the desktop, Task
// Scheduler or Reach's own background starter. A Reach inside another app
// (an editor, an agent's app or CLI) ends when that app does, and its window
// isn't one of its own.
const PLUMBING = new Set(["node", "cmd", "powershell", "pwsh", "conhost", "openconsole", "bash", "sh", "zsh", "fish", "nu", "dash", "wsl", "wslhost", "wslrelay", "winpty-agent", "busybox"]);
const HOSTS = new Set([
  // Terminals: Reach has a tab or window of its own there.
  "windowsterminal", "wt", "mintty", "git-bash", "alacritty", "wezterm", "wezterm-gui", "conemu", "conemu64", "conemuc", "conemuc64",
  "cmder", "tabby", "hyper", "fluentterminal", "fluentterminal.app", "terminus", "warp", "far", "mobaxterm", "rio", "extraterm",
  // The desktop, Task Scheduler and Windows' own sign-in.
  "explorer", "taskhostw", "taskeng", "svchost", "services", "wininit", "winlogon", "userinit", "sihost", "runtimebroker", "smss", "csrss", "lsass", "dwm",
]);
const STARTER = /^reach-background-[0-9a-f]{12}$/;
const NAMES = { code: "VS Code", "code - insiders": "VS Code", cursor: "Cursor", windsurf: "Windsurf", claude: "Claude", codex: "Codex", chatgpt: "ChatGPT" };
// A process's parent, only while it started before its child (ids come back).
const parents = (processes) => {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  return (p) => {
    const q = byPid.get(p.ppid);
    return q && q !== p && !(q.startedAt != null && p.startedAt != null && q.startedAt > p.startedAt) ? q : null;
  };
};
export function windowsHostApp(processes, pid) {
  const parentOf = parents(processes);
  const seen = new Set();
  for (let p = processes.find((x) => x.pid === pid); p && !seen.has(p.pid) && seen.size < 64; p = parentOf(p)) {
    seen.add(p.pid);
    // Windows itself (System, Registry…: no program file) is nobody's app.
    if (p.pid <= 4 || !/\.exe$/i.test(p.image || "")) return "";
    const name = stem(p.image);
    if (PLUMBING.has(name)) continue;
    if (HOSTS.has(name) || STARTER.test(name)) return "";
    return NAMES[name] || String(p.image || "").replace(/\.exe$/i, "");
  }
  return "";
}
// Reach's own terminals: shells it started as terminal.mjs starts them
// (PowerShell with -NoLogo, a bare cmd or Unix shell), not its PowerShell
// helpers (-File, -Command) or anything run once (/c, -c).
const SHELL_IMAGES = new Set(["powershell", "pwsh", "cmd", "bash", "sh", "zsh", "fish", "nu"]);
function interactiveShell(p) {
  const name = stem(p.image);
  if (!SHELL_IMAGES.has(name) || !p.commandLine) return false;
  const args = windowsArgv(p.commandLine).slice(1);
  if (name === "powershell" || name === "pwsh")
    return args.some((a) => /^-nologo$/i.test(a)) && !args.some((a) => /^-(file|f|command|c|encodedcommand|enc|e|ec)$/i.test(a));
  if (name === "cmd") return !args.some((a) => /^\/[ckr]/i.test(a));
  return args.every((a) => /^-(l|i|-login|-interactive)$/.test(a));
}
// Every Reach in a Windows process list (never `self`), with everything it
// started and its terminals: the hosts reachHosts finds on a Mac.
export function windowsReachHosts(processes, { self = process.pid, root = null, locked = lockHolder, runtime = (folder, pid) => runtimeOf({ root: folder, pid, platform: "win32" }) } = {}) {
  const parentOf = parents(processes);
  const children = new Map();
  for (const p of processes) {
    const q = parentOf(p);
    if (q) children.set(q.pid, [...(children.get(q.pid) || []), p]);
  }
  const below = (pid, seen = new Set([pid])) =>
    (children.get(pid) || []).filter((c) => !seen.has(c.pid) && seen.add(c.pid)).flatMap((c) => [c, ...below(c.pid, seen)]);
  const entryOf = (p) => (stem(p.image) === "node" && p.commandLine ? windowsEntry(windowsArgv(p.commandLine)) : null);
  const runsReach = (p, entry) => {
    if (!entry) return false;
    const args = entry.rest;
    if (args[0] === "restart") return !!entry.root && locked(entry.root) === p.pid;
    return (!args.length || args[0].startsWith("-")) && !args.some((a) => ONE_OFF.has(a));
  };
  // `reach` runs Reach as its own child, to start it again after a crash
  // (scripts/supervise.mjs): that child is the Reach.
  const supervisor = (p, entry) => entry?.entry === "bin/reach" &&
    (children.get(p.pid) || []).some((c) => { const e = entryOf(c); return e?.entry === "scripts/bootstrap" && runsReach(c, e); });
  return processes
    .map((p) => ({ p, entry: p.pid === self ? null : entryOf(p) }))
    .filter(({ p, entry }) => runsReach(p, entry) && !supervisor(p, entry))
    .filter(({ entry }) => !root || (entry.root && path.win32.resolve(entry.root).toLowerCase() === path.win32.resolve(root).toLowerCase()))
    .map(({ p: host, entry }) => {
      const descendants = below(host.pid);
      const terminals = descendants.filter(interactiveShell).map((shell) => ({
        pid: shell.pid,
        tty: "",
        shell: stem(shell.image),
        running: (children.get(shell.pid) || []).map((c) => stem(c.image)).filter((name) => name && !["conhost", "openconsole"].includes(name)),
      }));
      const status = runtime(entry.root, host.pid);
      return {
        pid: host.pid,
        tty: status.window === false ? "" : "console",
        root: entry.root,
        service: entry.rest.includes("--service"),
        app: windowsHostApp(processes, host.pid),
        descendants,
        terminals,
        startedAt: host.startedAt,
        platform: "win32",
      };
    });
}
// When each started: Windows' list says it; a Mac asks ps.
export const startedOf = (hosts, times = startTimes) =>
  hosts.every((h) => h.platform === "win32") ? new Map(hosts.map((h) => [h.pid, h.startedAt])) : times(hosts.map((h) => h.pid));
// Why Windows' process list couldn't be read, in a few words.
const unreadable = (error) =>
  error?.compiler === false
    ? "Windows' C# compiler isn't on this PC"
    : error?.refused || (/^spawn/.test(error?.syscall || "") && ["EACCES", "EPERM", "UNKNOWN"].includes(error?.code))
      ? "Windows wouldn't build or run Reach's helper"
      : /took too long|ETIMEDOUT/.test(`${error?.message} ${error?.code}`)
        ? "it took too long"
        : "Windows wouldn't say";
// Every Reach on this Windows PC: { hosts, partial, processes }. Where the
// process list can't be read (no C# compiler, a policy that blocks Reach's
// helpers), the Reach this folder runs, with why (`partial`), as FIRST_RUN_
// MATRIX H20 had it.
export async function windowsReaches({ root, state, self = process.pid, list, host = windowsHost } = {}) {
  let processes;
  try {
    processes = await list();
  } catch (error) {
    const record = host(state);
    return { hosts: record && record.pid !== self ? [recordedHost(record, root)] : [], partial: unreadable(error), processes: null };
  }
  return { hosts: windowsReachHosts(processes, { self }), partial: "", processes };
}
// Reach's background starters that are yours: Windows names every
// account's programs, but only shows you your own command lines.
export const windowsStarters = (processes) => (processes || []).filter((p) => STARTER.test(stem(p.image)) && p.commandLine != null);

// Windows has no signals to ask with (Node ends a process there outright):
// `stop` leaves this file, and the running Reach stops as Ctrl+C stops it.
// Also in your own app data, by process: what a Reach started with another
// REACH_HOME, or from a folder its command line doesn't name, watches too.
export const stopRequestFile = (state) => path.join(state, "stop-request.json");
export const personalStopFile = (pid, env = process.env) => {
  const local = env.LOCALAPPDATA;
  return typeof local === "string" && local ? path.join(local, "Reach", "stop", `${pid}.json`) : null;
};
const STALE_REQUEST_MS = 2 * 60 * 1000;
export function watchStopRequest(state, { pid = process.pid, stop, every = 1000, read = (f) => JSON.parse(fs.readFileSync(f, "utf8")), personal = process.platform === "win32" ? personalStopFile(pid) : null, now = Date.now } = {}) {
  const files = [stopRequestFile(state), ...(personal ? [personal] : [])];
  const timer = setInterval(() => {
    for (const file of files) {
      let request = null;
      try {
        request = read(file);
      } catch {}
      // Meant for another (an earlier) Reach: not this one's to act on.
      if (request?.pid !== pid) continue;
      fs.rmSync(file, { force: true });
      // Left by a stop that ended before it was done, minutes ago.
      if (Number.isFinite(request.at) && now() - request.at > STALE_REQUEST_MS) continue;
      clearInterval(timer);
      stop();
      return;
    }
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function describe(host, { started, now, dir } = {}) {
  const since = clock(started, now);
  // A Windows Reach started with a relative path: its folder isn't known.
  return `${whereItRuns(host)}${since ? `, since ${since}` : ""}${host.root ? `, from ${home(host.root, dir)}` : ""}`;
}

// Starting a second Reach: where the first one runs, and what to run instead.
export function alreadyRunning(hosts, { command = "reach", started = new Map(), now, dir } = {}) {
  const lines = hosts.map((h) => describe(h, { started: started.get(h.pid), now, dir }));
  if (hosts.length > 1)
    return [
      `${hosts.length} copies are running:`,
      ...lines.map((l) => `  · ${l}`),
      `Only one should run. Run ${command} stop to stop them all, or ${command} restart to stop them and start one here.`,
    ].join("\n");
  const [host] = hosts;
  const hidden = !host.service && whereItRuns(host).startsWith("in the background");
  // Windows gives every program in your session the screen: what a window
  // of its own changes there is approvals, and how long it lives.
  const windows = host.platform === "win32";
  return [
    `already running ${lines[0]}.`,
    hidden
      ? windows ? "With no window it can't take device approvals." : "With no window it can't show or control your screen, and it can't take device approvals."
      : outsideTerminal(host.app)
        ? windows ? `It ends when ${host.app} closes.` : `${host.app} has no Screen Recording or Accessibility for Reach, so it can't show or control your screen.`
        : host.service
        ? "It runs on its own; nothing more to start."
        : "Use that window, or:",
    `  ${command} restart   stop it and start Reach here`,
    `  ${command} stop      stop it`,
  ].join("\n");
}

// `reach status`: what runs, where, since when, and its link. `partial`:
// why only this folder's Reach is known (Windows, its process list unread).
export function statusText(hosts, { command = "reach", started = new Map(), now, dir, runtime = runtimeOf, state = stateOf, partial = "" } = {}) {
  const note = partial ? `Reach couldn't read this PC's process list (${partial}), so it only knows the Reach run from this folder.\n` : "";
  if (!hosts.length) return `${note}Reach isn't running${partial ? " from this folder" : ""}. Start it with ${command}.`;
  const blocks = hosts.map((h) => {
    const { link, origin, awake, routes, signInOff, browserLink } = runtime(h);
    const url = link || origin;
    const since = (route) => (route.since ? ` since ${clock(route.since, now)}` : "");
    const interruptions = routes?.private?.interruptions || 0;
    return [
      `Reach: running ${describe(h, { started: started.get(h.pid), now, dir })}`,
      ...(browserLink?.ready === false
        ? [`Private link (same Tailscale network): ${origin}`, `Browser link: preparing — ${browserLink.reason}`]
        : url ? [`Link: ${url}`] : []),
      // Its routes in Tailscale: the private one phones use, the public one
      // open while an invitation or agent session is live.
      ...(routes?.private ? [`Private route: ${routes.private.up ? `up${since(routes.private)}` : "down"}${interruptions ? ` · ${interruptions} interruption${interruptions === 1 ? "" : "s"}` : ""}`] : []),
      ...(routes?.public ? [`Public link: ${routes.public.open ? `on${since(routes.public)}, blocked until an invite` : "off"}`] : []),
      ...(awake?.mode ? [`Sleep prevention: ${awake.mode} · ${awake.active ? "active" : "not active"}${awake.error ? ` · ${awake.error}` : ""}`] : []),
      // Set up for browser sign-in, on pairing codes for now (Windows: scripts/launch.mjs).
      ...(typeof signInOff === "string" && signInOff ? [`Browser sign-in is off for now: ${signInOff}`] : []),
      // The service writes its output to files; a window shows it.
      ...(h.service && h.root ? [`Logs: ${home(path.join(state(h.root), "logs"), dir)}`] : []),
    ].join("\n");
  });
  const windows = hosts[0].platform === "win32";
  if (hosts.length > 1)
    blocks.push(`${hosts.length} copies are running; only one should. Run ${command} stop to stop them all, or ${command} restart.`);
  else if (whereItRuns(hosts[0]).startsWith("in the background, with no"))
    blocks.push(windows
      ? `It has no window: it can't take device approvals. Run ${command} restart to run it in a window of its own.`
      : `It has no window: it can't show or control your screen, or take device approvals. Run ${command} restart to run it in Terminal.`);
  else if (!hosts[0].service && outsideTerminal(hosts[0].app))
    blocks.push(windows
      ? `It ends when ${hosts[0].app} closes. Run ${command} restart to move it to a window of its own.`
      : `${hosts[0].app} has no Screen Recording or Accessibility for Reach: the live screen won't load and it can't be controlled. Run ${command} restart to move it to a Terminal window.`);
  return note + blocks.join("\n");
}
