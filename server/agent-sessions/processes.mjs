import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { windowsProcesses } from "../windows-processes.mjs";

const exec = promisify(execFile);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_FLAG = new RegExp(`(?:--resume[= ]|(?:^|\\s)-r\\s|--session-id[= ])(${UUID})`, "i");

// "[[dd-]hh:]mm:ss" (macOS ps etime) -> seconds.
export function elapsedSeconds(etime) {
  const m = String(etime).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + +m[3] * 60 + +m[4];
}

// `ps -axo pid=,ppid=,etime=,tty=,command=` -> processes with start times.
export function parsePs(text, now = Date.now()) {
  const procs = new Map();
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const secs = elapsedSeconds(m[3]);
    procs.set(+m[1], {
      pid: +m[1],
      ppid: +m[2],
      startedAt: secs === null ? null : now - secs * 1000,
      tty: m[4] === "??" ? null : m[4],
      command: m[5],
    });
  }
  return procs;
}

// The claude executable itself; the Claude app's "disclaimer" wrapper merely
// passes it as an argument and is skipped (verified).
const isClaude = (command) =>
  !/\/Helpers\/disclaimer\b/.test(command) &&
  /^(?:\S*\/|.*\/MacOS\/)?claude(?:\s|$)/.test(command);

// The settings a claude process was started with (the Claude app passes
// --model, --effort and --permission-mode; verified in ps). The app can change
// effort later without restarting, so its own record wins when it has one.
const flag = (command, name) => command.match(new RegExp(`--${name}[= ]([^\\s]+)`))?.[1] || null;
export function claudeSettings(command) {
  return { model: flag(command, "model"), effort: flag(command, "effort"), mode: flag(command, "permission-mode") };
}

export function claudeProcesses(procs) {
  const out = [];
  for (const p of procs.values()) {
    if (!isClaude(p.command)) continue;
    let host = p.tty ? "terminal" : "background";
    for (let a = procs.get(p.ppid), seen = 0; a && seen < 12; a = procs.get(a.ppid), seen++)
      if (a.command.includes("/Claude.app/")) {
        host = "claude-app";
        break;
      }
    out.push({ ...p, host, sessionId: p.command.match(SESSION_FLAG)?.[1] || null });
  }
  return out;
}

// Matches live claude processes to sessions. With --resume/--session-id the id
// is explicit; a session started fresh is the transcript in the process's
// folder whose first entry follows the process start within two minutes
// (verified: a fresh app session began 1 s after its process).
export function matchClaude(processes, cwds, starts) {
  const live = new Map();
  for (const p of processes) {
    let id = p.sessionId;
    if (!id && p.startedAt) {
      const cwd = cwds.get(p.pid);
      const candidates = starts
        .filter((s) => s.cwd === cwd && s.firstAt >= p.startedAt - 5000 && s.firstAt <= p.startedAt + 120000)
        .sort((a, b) => a.firstAt - b.firstAt);
      id = candidates[0]?.id || null;
    }
    if (id && !live.has(id))
      // exact: the process names the session (not matched by its start time).
      live.set(id, { where: p.host, pid: p.pid, tty: p.tty, exact: !!p.sessionId, ...claudeSettings(p.command) });
  }
  return live;
}

// lsof -nP -a -d cwd -p 1,2 -Fpn -> Map(pid -> cwd). -n/-P keep it fast.
export function parseLsofCwd(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("p")) pid = +line.slice(1);
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}

// When each process started, as Claude Code writes it in its registry
// ("procStart": ps's lstart in UTC). A record whose process ended can name a
// pid the system has since given to another app (it read as a busy chat for
// hours): it's that session's only while the start times match. Kept a few
// seconds; ps that can't run never hides a session.
let startsSeen = { at: 0, key: "", starts: null };
export function processStarts(pids, { now = Date.now(), platform = process.platform, run = execFileSync } = {}) {
  // Windows does not provide the Unix ps/lstart contract used by this registry.
  // An unrelated ps on PATH must not make live sessions look like ended ones.
  if (platform === "win32") return null;
  const key = pids.join(",");
  if (run === execFileSync && startsSeen.key === key && now - startsSeen.at < 5000) return startsSeen.starts;
  let starts = null;
  try {
    const out = run("ps", ["-o", "pid=,lstart=", "-p", key], {
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 2000,
    });
    starts = new Map();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) starts.set(Number(m[1]), m[2].replace(/\s+/g, " ").trim());
    }
  } catch (e) {
    // ps exits 1 when none of them runs: all ended.
    if (e?.status === 1) starts = new Map();
  }
  if (run === execFileSync) startsSeen = { at: now, key, starts };
  return starts;
}

// Claude Code's own registry of running sessions: ~/.claude/sessions/<pid>.json
// names the session, its host (the Claude app's sessions say
// entrypoint "claude-desktop"), and whether it's busy or idle right now
// (verified with 2.1.286). Exact, unlike matching processes by start time.
export function readSessionRegistry({
  dir = path.join(os.homedir(), ".claude", "sessions"),
  alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  started = processStarts,
} = {}) {
  const found = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return found;
  }
  const records = [];
  for (const file of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (r.sessionId && Number.isInteger(r.pid) && alive(r.pid)) records.push(r);
    } catch {
      /* a record being rewritten */
    }
  }
  const dated = records.filter((r) => typeof r.procStart === "string").map((r) => r.pid);
  const starts = dated.length ? started(dated) : null;
  // Newest last: of two records for one session, the live one wins.
  records.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  for (const r of records) {
    if (starts && typeof r.procStart === "string" && starts.get(r.pid) !== r.procStart.replace(/\s+/g, " ").trim()) continue;
    const where =
      r.entrypoint === "claude-desktop" ? "claude-app" : r.kind && r.kind !== "interactive" ? "background" : "terminal";
    found.set(r.sessionId, {
      where,
      pid: r.pid,
      tty: null,
      exact: true,
      // Only "idle" is idle: Reach may end an idle app process to take its
      // chat over, so a state word a newer Claude Code adds counts as busy
      // (never interrupted). No word at all: not Claude Code's say (the
      // transcript's age decides, as without a registry).
      busy: r.status === "idle" || r.status === "waiting" ? false : typeof r.status === "string" ? true : undefined,
      // Stopped on you: "input needed" (a question) or "permission prompt".
      waiting: r.status === "waiting" ? String(r.waitingFor || "input needed") : null,
      ...(r.hostSessionId ? { appSessionId: r.hostSessionId } : {}),
      // A Windows PC's Claude Code notes its process's start as Windows keeps
      // it (GetProcessTimes, 100 ns since 1601), for liveClaudeSessions.
      ...(typeof r.procStartFt === "string" ? { procStartFt: r.procStartFt } : {}),
    });
  }
  return found;
}

// A Windows start as Claude Code notes it, in ms since 1970 as the PC's
// process list gives it (windows-processes.mjs); null when it isn't one.
// Claude Code reads a value past 3e17 as another encoding and never as a
// different process (2.1.299): Reach doesn't either, or a live chat would
// read as let go and be written into.
const FILETIME_1970 = 116444736000000000n;
const OTHER_ENCODING = 300000000000000000n;
export function windowsStart(procStartFt) {
  if (typeof procStartFt !== "string" || !/^\d{1,20}$/.test(procStartFt)) return null;
  const ticks = BigInt(procStartFt);
  return ticks > FILETIME_1970 && ticks <= OTHER_ENCODING ? Number((ticks - FILETIME_1970) / 10000n) : null;
}

export async function liveClaudeSessions(starts, { run = exec, now = Date.now, registry = readSessionRegistry, self = process.pid, platform = process.platform, ours = () => false, processList = () => windowsProcesses() } = {}) {
  // Windows has no ps or lsof: Claude Code's own registry says which sessions
  // run and where, and Reach knows its own processes (ours). Failing there
  // read as "nobody holds it", and Reach wrote into chats a terminal or the
  // Claude app still had open (docs/parity/AUDIT.md #8).
  if (platform === "win32") {
    // Windows reuses pids: a record counts while its pid still runs Claude
    // Code (claude.exe; node.exe for npm's) and, when both say when, started
    // when the process Claude Code noted did (a pid given since to another
    // Claude Code or Node read as a held chat until its record went). The
    // PC's process list says both; tasklist, only the program. If neither
    // can say, it counts.
    let images = null;
    let started = new Map();
    try {
      const rows = await processList();
      images = new Map(rows.map((p) => [p.pid, p.image.toLowerCase()]));
      started = new Map(rows.map((p) => [p.pid, p.startedAt]));
      // A list without Reach itself isn't the whole list.
      if (!images.has(process.pid)) images = null;
    } catch {
      /* tasklist, below */
    }
    if (!images)
      try {
        started = new Map();
        const { stdout } = await run("tasklist", ["/FO", "CSV", "/NH"], { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        images = new Map();
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = line.match(/^"([^"]*)","(\d+)"/);
          if (m) images.set(Number(m[2]), m[1].toLowerCase());
        }
        if (!images.has(process.pid)) images = null;
      } catch {
        /* unknown: every record stands */
      }
    const live = new Map();
    for (const [id, entry] of registry()) {
      if (images && !["claude.exe", "node.exe"].includes(images.get(entry.pid))) continue;
      const noted = windowsStart(entry.procStartFt);
      const since = started.get(entry.pid);
      if (images && noted != null && Number.isFinite(since) && since !== noted) continue;
      live.set(id, ours(entry.pid) ? { ...entry, where: "reach" } : entry);
    }
    return live;
  }
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,etime=,tty=,command="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const procs = parsePs(stdout, now());
  const processes = claudeProcesses(procs);
  const unknown = processes.filter((p) => !p.sessionId).map((p) => p.pid);
  let cwds = new Map();
  if (unknown.length) {
    try {
      const r = await run("lsof", ["-nP", "-a", "-d", "cwd", "-p", unknown.join(","), "-Fpn"], {
        timeout: 5000,
      });
      cwds = parseLsofCwd(r.stdout);
    } catch (e) {
      cwds = parseLsofCwd(e.stdout || "");
    }
  }
  // The registry's word wins; process matching fills in older versions.
  // The registry has no terminal: its process's own (a terminal's tab is
  // found by it, to answer what it asks there).
  const live = matchClaude(processes, cwds, starts);
  const ttys = new Map(processes.map((p) => [p.pid, p.tty]));
  for (const [id, entry] of registry())
    live.set(id, { ...live.get(id), ...entry, tty: entry.tty || live.get(id)?.tty || ttys.get(entry.pid) || null });
  // Reach's own Claude Code (its replies) says "interactive" on the tty Reach
  // runs in: it read as a terminal's while it exited after a turn (the chat
  // went Reach → Terminal → Claude app). Its parent says whose it is.
  for (const entry of live.values()) if (procs.get(entry.pid)?.ppid === self) entry.where = "reach";
  return live;
}
