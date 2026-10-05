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
