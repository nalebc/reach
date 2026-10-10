import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicJson } from "./core.mjs";
import { trimLog } from "../scripts/housekeeping.mjs";

// What happens when Reach stops by itself (reliability audit, Oct 10). Any
// error nothing caught used to end Reach silently, and a Reach in a Terminal
// window stayed down until someone was at the Mac.
//
// Now: the error is written to the Terminal and crash.log, its first line is
// kept for the next start, and Reach exits with CRASH_EXIT, never carrying on
// half-updated (that would itself be a way to fail open). ./reach starts it
// again in the same window (the background service: launchd). The next start
// reads what happened (previousRun), pauses agents that can use the Mac, and
// tells the owner why.
export const CRASH_EXIT = 70;
const RUN = "run.json";
const CRASH = "last-crash.json";
const clean = (text, max) => String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, max);
const firstLine = (error) => clean(String(error?.message ?? error ?? "an unknown error").split("\n")[0], 300);
const stackOf = (error) => clean(error instanceof Error ? error.stack || error.message : String(error), 8000);

export function installCrashGuard({
  dataDir,
  // Started by ./reach or the background service, which start it again.
  supervised = false,
  exit = (code) => process.exit(code),
  write = (text) => process.stderr.write(text),
  now = Date.now,
  target = process,
} = {}) {
  let stopping = false;
  const fatal = (error, origin) => {
    if (stopping) return;
    stopping = true;
    try {
      write(`\nReach stopped unexpectedly (${origin}): ${stackOf(error)}\n${supervised ? "It starts again by itself in a moment." : "Run ./reach to start it again."}\n`);
    } catch {}
    try {
      const log = path.join(dataDir, "crash.log");
      fs.appendFileSync(log, `${new Date(now()).toISOString()} ${origin}: ${stackOf(error)}\n\n`, { mode: 0o600 });
      trimLog(log, { max: 256 * 1024, keep: 64 * 1024 });
    } catch {}
    try {
      atomicJson(path.join(dataDir, CRASH), { at: now(), pid: process.pid, origin, reason: firstLine(error) });
    } catch {}
    exit(CRASH_EXIT);
  };
  // A write to a pipe or terminal that went away (its window closed, a
  // helper gone) leaves nothing half-done: not a reason to stop.
  const harmless = (error) => error?.syscall === "write" && (error.code === "EPIPE" || error.code === "EIO");
  const onException = (error) => (harmless(error) ? undefined : fatal(error, "uncaught exception"));
  const onRejection = (reason) => fatal(reason, "unhandled rejection");
  target.on("uncaughtException", onException);
  target.on("unhandledRejection", onRejection);
  return () => {
    target.off("uncaughtException", onException);
    target.off("unhandledRejection", onRejection);
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// How the last Reach in this folder ended. null: stopped cleanly (or never
// ran). { unclean: true, reason }: it ended without stopping, a crash (its
// reason) or a kill / running out of memory (no reason). A Mac restarted
// since isn't Reach ending by itself.
export function previousRun(dataDir, { bootedAt = Date.now() - os.uptime() * 1000, isAlive = alive, self = process.pid } = {}) {
  const run = read(path.join(dataDir, RUN));
  const crash = read(path.join(dataDir, CRASH));
  fs.rmSync(path.join(dataDir, CRASH), { force: true });
  if (!run || !Number.isInteger(run.pid) || !Number.isFinite(run.at)) return null;
  // This process, or another Reach still running here.
  if (run.pid === self || isAlive(run.pid)) return null;
  if (run.at < bootedAt) return null;
  const reason = crash && crash.pid === run.pid && crash.at >= run.at && typeof crash.reason === "string" ? crash.reason : "";
  return { unclean: true, at: run.at, reason };
}

export function markRunning(dataDir, { now = Date.now } = {}) {
  try {
    atomicJson(path.join(dataDir, RUN), { pid: process.pid, at: now() });
  } catch (error) {
    console.warn(`Reach: couldn't note that it's running (${error.code || error.message}); an unexpected stop won't pause agents.`);
  }
}

// Asked to stop: the next start isn't after an unexpected end.
export function markStopped(dataDir) {
  const file = path.join(dataDir, RUN);
  if (read(file)?.pid === process.pid) fs.rmSync(file, { force: true });
}

// What the owner is told after Reach ended unexpectedly.
export function restartReason(run) {
  return run.reason
    ? `Reach stopped unexpectedly (${run.reason}) and started again.`
    : "Reach ended unexpectedly (it was stopped from outside or ran out of memory) and started again.";
}
