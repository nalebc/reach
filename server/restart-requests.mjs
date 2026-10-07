import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fail, isPlainRecord } from "./core.mjs";

// In a source checkout, an agent's `reach restart` asks you first (Needs you
// on the phone) instead of ending Reach's terminals and live screens on its
// own: agents restarted Reach again and again on Oct 6. The command writes a
// request beside Reach's data; Restart opens Terminal and restarts Reach
// there, Not now drops it. Your own restart in Terminal never asks.
export const restartRequestFile = (dataDir) =>
  path.join(dataDir, "restart-request.json");
const LIFETIME = 30 * 60 * 1000;

// The command's side: one request at a time; asking again keeps it.
export function askRestart(dataDir, { app = "", now = Date.now() } = {}) {
  const file = restartRequestFile(dataDir);
  const current = readRequest(file, now);
  if (current) return { request: current, again: true };
  const request = {
    id: crypto.randomUUID(),
    app: String(app).slice(0, 80),
    requestedAt: now,
    expiresAt: now + LIFETIME,
  };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(request), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { request, again: false };
}

function readRequest(file, now = Date.now()) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      isPlainRecord(r) &&
      typeof r.id === "string" &&
      /^[\w-]{1,64}$/.test(r.id) &&
      Number.isFinite(r.requestedAt) &&
      Number.isFinite(r.expiresAt) &&
      r.expiresAt > now
    )
      return { ...r, app: typeof r.app === "string" ? r.app.slice(0, 80) : "" };
  } catch {
    /* none */
  }
  return null;
}

// Reach's side: the open request, answering it, and a nudge when one arrives.
export function restartRequests({ dataDir, restart, onChange = () => {}, watch = fs.watch }) {
  const file = restartRequestFile(dataDir);
  // Reach just started: whatever restart was asked for has happened.
  fs.rmSync(file, { force: true });
  let watcher;
  try {
    watcher = watch(dataDir, (_, name) => {
      if (!name || name === path.basename(file)) onChange();
    });
    // Never what keeps Reach (or a test) from exiting.
    watcher.unref?.();
  } catch {
    /* the regular scan still finds it */
  }
  return {
    list: () => {
      const r = readRequest(file);
      return r ? [r] : [];
    },
    decide(id, action) {
      const r = readRequest(file);
      if (!r || r.id !== id) throw fail(409, "This restart was already answered.");
      fs.rmSync(file, { force: true });
      if (action !== "restart") return { status: "declined" };
      restart();
      return { status: "restarting" };
    },
    close: () => watcher?.close(),
  };
}
