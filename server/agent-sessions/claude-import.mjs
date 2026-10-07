// Claude sessions started from Reach join the Claude app's list through the
// app's own import link, claude://resume?session=<id>. Opening that link also
// switches the app's window to the session and starts a process for it
// (verified), and would open the app if it's closed; so an import waits until
// nobody is using the Mac and the Claude app is running. Waiting imports are
// kept in Reach's data folder, so a restart doesn't lose them.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Seconds since the last keyboard, mouse or trackpad input on this Mac.
export async function idleSeconds(run = exec) {
  const { stdout } = await run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 5000 });
  const m = stdout.match(/"HIDIdleTime" = (\d+)/);
  return m ? Number(m[1]) / 1e9 : null;
}

export async function claudeAppRunning(run = exec) {
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "comm="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.split("\n").some((line) => /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(line.trim()));
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
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "lstart=,comm="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\w{3} \w{3} +\d+ [\d:]+ \d{4}) +(.+)$/);
      if (m && /\/Claude\.app\/Contents\/MacOS\/Claude$/.test(m[2])) return Date.parse(m[1]) || null;
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
      fs.writeFileSync(file, JSON.stringify([...pending]), { mode: 0o600 });
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
  async function round() {
    if (!pending.size) return;
    // Closed: it reads every session afresh when it opens.
    const launched = await startedAt();
    if (launched == null) return done();
    const list = shown();
    // Not shown since it opened: it reads it afresh when it shows it.
    if (!list.some((s) => pending.has(s.id) && s.at >= launched)) return done();
    const seconds = await Promise.resolve(idle()).catch(() => null);
    if (seconds != null && seconds * 1000 < awayMs) return;
    if (await asking()) return;
    const before = list[0]?.at ? list[0].session : null;
    await reload();
    done();
    await new Promise((r) => setTimeout(r, settleMs));
    if (closed || !before) return;
    // The reload opens a session of its own choosing: back to the one shown.
    if (shown()[0]?.session !== before) await open(`claude://code/continue?session=${before}`);
  }
  function check() {
    if (running) return running;
    running = round()
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

export function createClaudeImports({
  file,
  open,
  idle = idleSeconds,
  appRunning = claudeAppRunning,
  imported = inClaudeApp,
  // Away this long, the switch in the app's window bothers nobody.
  awayMs = 2 * 60 * 1000,
  everyMs = 30 * 1000,
  // Pick up imports left from before a restart.
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
      fs.writeFileSync(file, JSON.stringify([...pending]), { mode: 0o600 });
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
  const away = async () => {
    // No reading at all (never seen on macOS): import rather than never.
    const seconds = await Promise.resolve(idle()).catch(() => null);
    return seconds == null || seconds * 1000 >= awayMs;
  };
  function check() {
    if (running) return running;
    running = (async () => {
      const before = pending.size;
      for (const id of [...pending]) {
        if (closed) break;
        if (imported(id)) {
          pending.delete(id);
          continue;
        }
        if (!(await appRunning()) || !(await away())) break;
        try {
          await open(`claude://resume?session=${id}`, { background: true });
          pending.delete(id);
        } catch {
          /* try again next round */
        }
      }
      if (pending.size !== before) save();
    })().finally(() => {
      running = null;
      later(everyMs);
    });
    return running;
  }
  if (resume && pending.size) later(0);
  return {
    add(id) {
      if (closed || typeof id !== "string" || !UUID.test(id) || pending.has(id)) return Promise.resolve();
      pending.add(id);
      save();
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
