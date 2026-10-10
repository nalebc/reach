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

// The processes now: id, parent, terminal, command line.
export function processTable(run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 32 << 20 })) {
  return String(run("/bin/ps", ["-axo", "pid=,ppid=,tty=,command="]))
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, tty, command]) => ({ pid: Number(pid), ppid: Number(ppid), tty, command }));
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

// Where it runs, in words.
export function whereItRuns(host) {
  if (host.service) return "as the background service";
  if (!host.tty || host.tty === "??" || host.tty === "?") return "in the background, with no window";
  if (outsideTerminal(host.app)) return `inside ${host.app} (${host.tty}), not a Terminal window`;
  return `in a Terminal window (${host.tty})`;
}

// Its saved state: a source folder keeps .reach inside; an npm install, ~/.reach.
export const stateOf = (root, exists = fs.existsSync, env = process.env) => stateDir(root, { installed: !exists(path.join(root, "src/main.tsx")), env });

// What its server reports while it runs: its link, and whether it keeps the Mac awake.
export function runtimeOf(host, { state = stateOf, read = (f) => JSON.parse(fs.readFileSync(f, "utf8")) } = {}) {
  try {
    return read(path.join(state(host.root), "host-status.json")) || {};
  } catch {
    return {};
  }
}

export function describe(host, { started, now, dir } = {}) {
  const since = clock(started, now);
  return `${whereItRuns(host)}${since ? `, since ${since}` : ""}, from ${home(host.root, dir)}`;
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
  return [
    `already running ${lines[0]}.`,
    hidden
      ? "With no window it can't show or control your screen, and it can't take device approvals."
      : outsideTerminal(host.app)
        ? `${host.app} has no Screen Recording or Accessibility for Reach, so it can't show or control your screen.`
        : host.service
        ? "It runs on its own; nothing more to start."
        : "Use that window, or:",
    `  ${command} restart   stop it and start Reach here`,
    `  ${command} stop      stop it`,
  ].join("\n");
}

// `reach status`: what runs, where, since when, and its link.
export function statusText(hosts, { command = "reach", started = new Map(), now, dir, runtime = runtimeOf, state = stateOf } = {}) {
  if (!hosts.length) return `Reach isn't running. Start it with ${command}.`;
  const blocks = hosts.map((h) => {
    const { link, origin, awake, routes } = runtime(h);
    const url = link || origin;
    const since = (route) => (route.since ? ` since ${clock(route.since, now)}` : "");
    const interruptions = routes?.private?.interruptions || 0;
    return [
      `Reach: running ${describe(h, { started: started.get(h.pid), now, dir })}`,
      ...(url ? [`Link: ${url}`] : []),
      // Its routes in Tailscale: the private one phones use, the public one
      // open while an invitation or agent session is live.
      ...(routes?.private ? [`Private route: ${routes.private.up ? `up${since(routes.private)}` : "down"}${interruptions ? ` · ${interruptions} interruption${interruptions === 1 ? "" : "s"}` : ""}`] : []),
      ...(routes?.public ? [`Public link: ${routes.public.open ? `on${since(routes.public)}, blocked until an invite` : "off"}`] : []),
      ...(awake?.mode ? [`Sleep prevention: ${awake.mode} · ${awake.active ? "active" : "not active"}${awake.error ? ` · ${awake.error}` : ""}`] : []),
      // The service writes its output to files; a window shows it.
      ...(h.service ? [`Logs: ${home(path.join(state(h.root), "logs"), dir)}`] : []),
    ].join("\n");
  });
  if (hosts.length > 1)
    blocks.push(`${hosts.length} copies are running; only one should. Run ${command} stop to stop them all, or ${command} restart.`);
  else if (whereItRuns(hosts[0]).startsWith("in the background, with no"))
    blocks.push(`It has no window: it can't show or control your screen, or take device approvals. Run ${command} restart to run it in Terminal.`);
  else if (!hosts[0].service && outsideTerminal(hosts[0].app))
    blocks.push(`${hosts[0].app} has no Screen Recording or Accessibility for Reach: the live screen won't load and it can't be controlled. Run ${command} restart to move it to a Terminal window.`);
  return blocks.join("\n");
}
