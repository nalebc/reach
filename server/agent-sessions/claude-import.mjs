// Claude sessions Reach starts (or replies in) join the Claude app's list,
// whatever happens in between: Reach restarting, the app closed, someone at
// the Mac. Two ways in, both the app's own:
// - its record, local_<id>.json, written the way the app's own import
//   writes it (adoptCliSession, Claude 1.x): the app reads every record when
//   it opens, so the chat is there from its next launch. Written only while
//   the app's newest record still has the shape Reach knows; otherwise not
//   at all, and the import link below does it.
// - its import link, claude://resume?session=<id>, for an app already open
//   (it reads records only when it opens). The link also switches the app's
//   window to the chat, so it waits until the app isn't in front (or nobody
//   is at the Mac), then the window goes back to the chat it showed.
// Never while Reach's own Claude Code runs the chat: two processes on one
// transcript. Waiting chats are kept in Reach's data folder.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORDS = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");

// Seconds since the last keyboard, mouse or trackpad input on this Mac.
export async function idleSeconds(run = exec) {
  const { stdout } = await run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 5000 });
  const m = stdout.match(/"HIDIdleTime" = (\d+)/);
  return m ? Number(m[1]) / 1e9 : null;
}

// Whether this Mac's screen is locked (its console session says so), null
// when it can't tell. Locked, nothing can be typed into any app.
export async function screenLocked(run = exec) {
  const { stdout } = await run("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"], { timeout: 5000 });
  const m = stdout.match(/"CGSSessionScreenIsLocked"=(Yes|No)/);
  return m ? m[1] === "Yes" : null;
}

// The Claude app's process by its bundle id, as macOS's own app list has it
// (wherever the app lives or whatever it's named); null when it isn't open,
// undefined when that list can't be read.
export const CLAUDE_APP_ID = "com.anthropic.claudefordesktop";
async function claudeAppPid(run) {
  try {
    const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "pid", "-app", CLAUDE_APP_ID], { timeout: 3000 });
    const m = String(stdout).match(/"pid"\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return undefined;
  }
}
// ps prints dates in the Mac's own language and order ("Wed  7 Oct" here):
// read in the C locale, the one fixed format.
const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
// The app's own executable path, for when macOS's list can't say.
const APP_PATH = /\/Claude\.app\/Contents\/MacOS\/Claude$/;

export async function claudeAppRunning(run = exec) {
  if (await claudeAppPid(run)) return true;
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "comm="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.split("\n").some((line) => APP_PATH.test(line.trim()));
  } catch {
    return false;
  }
}

// Whether the Claude app already lists a session: its record is named
// local_<id>.json, under one folder per account and organization.
export function inClaudeApp(
  id,
  records = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
) {
  const name = `local_${id}.json`;
  const dirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  };
  return dirs(records).some((account) => dirs(account).some((org) => fs.existsSync(path.join(org, name))));
}

// The Claude app signs in on its own; Reach never reads its credentials. It
// counts as signed in when it runs Claude Code sessions right now (Claude
// Code's registry lists them as the app's), or keeps an account's session
// folder used in the last month.
export async function claudeAppAccess({
  app = "/Applications/Claude.app",
  records = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  registry = () => new Map(),
  now = Date.now,
} = {}) {
  if (!fs.existsSync(app)) return { installed: false, signedIn: false };
  let running = false;
  try {
    running = [...registry().values()].some((e) => e.where === "claude-app");
  } catch {
    /* no registry: the folder decides */
  }
  if (running) return { installed: true, signedIn: true };
  let recent = false;
  try {
    for (const account of fs.readdirSync(records, { withFileTypes: true }))
      if (account.isDirectory() && now() - fs.statSync(path.join(records, account.name)).mtimeMs < 30 * 86400000)
        recent = true;
  } catch {
    /* never signed in here */
  }
  return { installed: true, signedIn: recent };
}

// When the Claude app was opened (ms), or null while it's closed.
export async function claudeAppStartedAt(run = exec) {
  const START = /^(\w{3} \w{3} +\d+ [\d:]+ \d{4})(?: +(.+))?$/;
  const pid = await claudeAppPid(run);
  if (pid) {
    try {
      const { stdout } = await run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5000, env: PS_ENV });
      const m = String(stdout).trim().match(START);
      if (m && !m[2]) return Date.parse(m[1]) || null;
    } catch {
      /* the listing below */
    }
  }
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "lstart=,comm="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: PS_ENV });
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(START);
      if (m?.[2] && APP_PATH.test(m[2])) return Date.parse(m[1]) || null;
    }
  } catch {
    /* no ps: as if closed */
  }
  return null;
}

// The sessions the Claude app lists, the one on screen first: each record
// notes when its session was last shown (lastFocusedAt).
export function claudeAppShown(
  records = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
) {
  const found = [];
  const dirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const account of dirs(records))
    for (const org of account.isDirectory() ? dirs(path.join(records, account.name)) : [])
      for (const file of org.isDirectory() ? dirs(path.join(records, account.name, org.name)) : []) {
        if (!/^local_.+\.json$/.test(file.name)) continue;
        try {
          const record = JSON.parse(fs.readFileSync(path.join(records, account.name, org.name, file.name), "utf8"));
          if (UUID.test(record.cliSessionId) && /^local_[0-9a-f-]{36}$/i.test(record.sessionId))
            found.push({ id: record.cliSessionId, session: record.sessionId, at: Number(record.lastFocusedAt) || 0 });
        } catch {
          /* being written: next time */
        }
      }
  return found.sort((a, b) => b.at - a.at);
}

// The Claude app's View ▸ Reload, pressed through Accessibility as a person
// would (Reach has it when started from Terminal). The window reads every
// session again; their processes keep running (verified).
export async function reloadClaudeWindow(run = exec) {
  await run(
    "/usr/bin/osascript",
    [
      "-e",
      'tell application "System Events" to tell (first application process whose bundle identifier is "com.anthropic.claudefordesktop") to click menu item "Reload" of menu 1 of menu bar item "View" of menu bar 1',
    ],
    { timeout: 10000 },
  );
}

// The Claude app's window shows a session's messages as it read them the
// first time it showed it since opening; it doesn't see what Reach adds later
// (verified). So after Reach replies in a session the app has shown, its
// window is reloaded once nobody is at the Mac, then put back on the session
// it was showing. Waiting reloads are kept in Reach's data folder.
export function createClaudeRefresh({
  file,
  open,
  idle = idleSeconds,
  startedAt = claudeAppStartedAt,
  shown = () => claudeAppShown(),
  reload = reloadClaudeWindow,
  // A question or permission prompt open in the app: not now.
  asking = () => false,
  awayMs = 2 * 60 * 1000,
  everyMs = 30 * 1000,
  settleMs = 4000,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  desktopAutomation = null,
  resume = true,
}) {
  let pending = new Set();
  try {
    pending = new Set(JSON.parse(fs.readFileSync(file, "utf8")).filter((id) => typeof id === "string" && UUID.test(id)));
  } catch {
    /* nothing waiting */
  }
  let timer = null;
  let running = null;
  let closed = false;
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...pending]), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* kept in memory until Reach restarts */
    }
  };
  const done = () => {
    pending.clear();
    save();
  };
  const later = (ms) => {
    if (closed || timer || !pending.size) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, ms);
    timer.unref?.();
  };
  async function round(guard) {
    if (!pending.size) return;
    // Closed: it reads every session afresh when it opens.
    const launched = await startedAt();
    if (launched == null) return done();
    const list = shown();
    // Not shown since it opened: it reads it afresh when it shows it.
    if (!list.some((s) => pending.has(s.id) && s.at >= launched)) return done();
    const seconds = await Promise.resolve(idle()).catch(() => null);
    if (!Number.isFinite(seconds) || seconds * 1000 < awayMs) return;
    if (await asking()) return;
    const current = shown()[0];
    const before = current?.at ? current.session : null;
    if (closed) return;
    guard();
    await reload();
    done();
    // Only restore a post-reload session we actually observed. A later new
    // selection (or unknown reload destination) is not ours to undo.
    const reloaded = shown()[0]?.session;
    await wait(settleMs);
    if (closed || !before || !reloaded || reloaded === before || shown()[0]?.session !== reloaded) return;
    guard();
    await open(`claude://code/continue?session=${before}`, { background: true });
  }
  function check() {
    if (running) return running;
    running = (desktopAutomation ? desktopAutomation.run(round) : round(() => {}))
      .catch(() => {
        /* try again next round */
      })
      .finally(() => {
        running = null;
        later(everyMs);
      });
    return running;
  }
  if (resume && pending.size) later(0);
  return {
    add(id) {
      if (closed || typeof id !== "string" || !UUID.test(id)) return Promise.resolve();
      if (!pending.has(id)) {
        pending.add(id);
        save();
      }
      return check();
    },
    pending: () => [...pending],
    check,
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

// The account's folder of records the app uses now: the one holding its
// most recently written record, and that record, to check its shape.
export function newestRecords(records = RECORDS) {
  let best = null;
  const dirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return [];
    }
  };
  for (const account of dirs(records))
    for (const org of dirs(path.join(records, account.name))) {
      const dir = path.join(records, account.name, org.name);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => /^local_[0-9a-f-]{36}\.json$/i.test(f));
      } catch {}
      for (const f of files) {
        try {
          const at = fs.statSync(path.join(dir, f)).mtimeMs;
          if (!best || at > best.at) best = { dir, file: path.join(dir, f), at };
        } catch {}
      }
    }
  if (!best) return null;
  try {
    return { dir: best.dir, sample: JSON.parse(fs.readFileSync(best.file, "utf8")) };
  } catch {
    return null;
  }
}
// The fields Reach writes, as the app's own records have them.
export const recordShape = (r) =>
  !!r &&
  typeof r === "object" &&
  /^local_[0-9a-f-]{36}$/i.test(r.sessionId) &&
  UUID.test(r.cliSessionId ?? "") &&
  typeof r.cwd === "string" &&
  typeof r.createdAt === "number" &&
  typeof r.lastActivityAt === "number" &&
  typeof r.isArchived === "boolean" &&
  typeof r.permissionMode === "string";
const APP_MODES = new Set(["default", "acceptEdits", "plan", "auto"]);
const APP_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Writes the app's record for a session; true when the app has a record for
// it now (written here or already there).
export function writeClaudeRecord(id, info, { records = RECORDS, now = Date.now } = {}) {
  if (!UUID.test(id) || !info || typeof info.cwd !== "string" || !path.isAbsolute(info.cwd)) return false;
  if (inClaudeApp(id, records)) return true;
  const target = newestRecords(records);
  if (!target || !recordShape(target.sample)) return false;
  const at = now();
  const record = {
    sessionId: `local_${id}`,
    cliSessionId: id,
    cwd: info.cwd,
    originCwd: info.cwd,
    createdAt: Number(info.createdAt) || at,
    lastActivityAt: Number(info.updatedAt) || at,
    indexedAt: at,
    isArchived: false,
    ...(typeof info.title === "string" && info.title.trim() ? { title: info.title.trim().slice(0, 200), titleSource: "auto" } : {}),
    ...(typeof info.model === "string" && info.model ? { model: info.model } : {}),
    // The app launches the chat with the record's effort (--effort); only a
    // level its menu has, so an unknown word never breaks its launch.
    ...(APP_EFFORTS.has(info.effort) ? { effort: info.effort } : {}),
    permissionMode: APP_MODES.has(info.mode) ? info.mode : "default",
    ...(typeof target.sample.chromePermissionMode === "string" ? { chromePermissionMode: target.sample.chromePermissionMode } : {}),
    sessionPermissionUpdates: [],
    alwaysAllowedReasons: [],
    adoptedFromOtherSurface: true,
  };
  const file = path.join(target.dir, `local_${id}.json`);
  const tmp = path.join(target.dir, `.reach-${id}-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    // Never over a record the app wrote meanwhile.
    fs.linkSync(tmp, file);
  } catch (e) {
    if (e?.code !== "EEXIST") return false;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
  return true;
}

export function createClaudeImports({
  file,
  open,
  idle = idleSeconds,
  appRunning = claudeAppRunning,
  // When the open app was launched (ms), or null.
  startedAt = claudeAppStartedAt,
  imported = (id) => inClaudeApp(id),
  // Reach's own Claude Code still runs this chat: not yet.
  held = () => false,
  // { cwd, title, model, mode, createdAt, updatedAt } of a chat, for its record.
  describe = async () => null,
  // Writes the app's record (writeClaudeRecord); null: the link only.
  write = (id, info) => writeClaudeRecord(id, info),
  // Which chat the app shows, to put its window back after an import.
  shown = () => claudeAppShown(),
  // Away this long, the switch in the app's window bothers nobody.
  awayMs = 2 * 60 * 1000,
  everyMs = 30 * 1000,
  settleMs = 4000,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  desktopAutomation = null,
  // Pick up imports left from before a restart.
  resume = true,
}) {
  // id -> { writtenAt }: when Reach wrote the app's record for it.
  let pending = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    // Before records were written: a list of ids.
    const entries = Array.isArray(saved) ? saved.map((id) => [id, {}]) : Object.entries(saved || {});
    for (const [id, entry] of entries)
      if (typeof id === "string" && UUID.test(id))
        pending.set(id, { writtenAt: Number(entry?.writtenAt) || 0 });
  } catch {
    /* nothing waiting */
  }
  let timer = null;
  let running = null;
  let closed = false;
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(pending)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* kept in memory until Reach restarts */
    }
  };
  const later = (ms) => {
    if (closed || timer || !pending.size) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, ms);
    timer.unref?.();
  };
  // The app's window may switch now: nobody is at the Mac. (Not just "Claude
  // isn't in front": the switch pulled Claude over the app in use.) Unknown
  // physical-input activity never authorizes an automatic switch.
  const clear = async () => {
    const seconds = await Promise.resolve(idle()).catch(() => null);
    if (!Number.isFinite(seconds) || seconds < 0) return false;
    return seconds * 1000 >= awayMs;
  };
  async function one(id, entry, guard) {
    if (held(id)) return "wait";
    if (imported(id)) {
      // The app's own record (its import, or it lists the chat): done.
      if (!entry.writtenAt) return "done";
    } else if (write) {
      const info = await Promise.resolve(describe(id)).catch(() => null);
      if (info && (await Promise.resolve(write(id, info)).catch(() => false)) && !entry.writtenAt) {
        entry.writtenAt = now();
        save();
      }
    }
    if (!(await appRunning())) return entry.writtenAt ? "done" : "wait"; // read when it opens
    if (entry.writtenAt) {
      const launched = await Promise.resolve(startedAt()).catch(() => null);
      if (launched != null && launched > entry.writtenAt) return "done";
    }
    // Open since before the record: its own import, when it's out of the way.
    if (!(await clear())) return "later";
    const before = (() => {
      try {
        return shown()[0]?.session || null;
      } catch {
        return null;
      }
    })();
    if (closed) return "wait";
    guard();
    await open(`claude://resume?session=${id}`, { background: true });
    if (before && before !== `local_${id}`) {
      await wait(settleMs);
      try {
        if (!closed && shown()[0]?.session === `local_${id}`) {
          guard();
          await open(`claude://code/continue?session=${before}`, { background: true });
        }
      } catch {
        /* the window stays on the imported chat */
      }
    }
    return "done";
  }
  function check() {
    if (running) return running;
    running = (async () => {
      let changed = false;
      for (const [id, entry] of [...pending]) {
        if (closed) break;
        let result = "later";
        try {
          const work = (guard) => one(id, entry, guard);
          result = await (desktopAutomation ? desktopAutomation.run(work) : work(() => {}));
        } catch {
          /* try again next round */
        }
        if (result === "done") {
          pending.delete(id);
          changed = true;
        }
        if (result === "later") break;
      }
      if (changed) save();
    })().finally(() => {
      running = null;
      later(everyMs);
    });
    return running;
  }
  if (resume && pending.size) later(0);
  return {
    add(id) {
      if (closed || typeof id !== "string" || !UUID.test(id)) return Promise.resolve();
      if (!pending.has(id)) {
        pending.set(id, { writtenAt: 0 });
        save();
      }
      return check();
    },
    pending: () => [...pending.keys()],
    check,
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}
