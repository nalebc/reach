import os from "node:os";
import { spawn as spawnChild } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Reach started from `reach` (an npm install) or reach.cmd (Windows) starts
// again in the same window when it stopped by itself, as ./reach does in a
// checkout (server/crash-guard.mjs exits 70; 134 is Node out of memory):
// after 1, 5, 15, then 30 seconds, at most 5 times in 10 minutes. Same
// window, same Screen Recording and Accessibility. Ctrl+C, `reach stop`, a
// closed window and errors Reach reported itself end it. Other commands and
// the background service (launchd starts it again) run once, as before.
export const RELAUNCH_CODES = new Set([70, 134]);
const ONCE = new Set(["--service", "--background", "--stop-background", "--help", "-h", "--version", "-v"]);
const DELAYS = [1000, 5000, 15000];

// A command that runs Reach itself (no command, flags only, or restart).
export function runsReach(args) {
  const first = args[0];
  if (!(first === undefined || first.startsWith("-") || first === "restart")) return false;
  return !args.some((arg) => ONCE.has(arg));
}

const exitCode = (code, signal) => (code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1));

export async function superviseReach({
  script,
  args = [],
  node = process.execPath,
  env = process.env,
  spawn = spawnChild,
  now = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  log = (line) => console.error(line),
  signals = process,
} = {}) {
  let child = null, stopping = false, wake = null;
  // Ctrl+C reaches Reach itself through the terminal; this waits for it to
  // stop. A stop sent here (`reach stop`, a closed window) is handed on.
  const onSignal = (signal) => {
    stopping = true;
    if (child && signal !== "SIGINT") {
      try { child.kill(signal); } catch {}
    }
    wake?.();
  };
  const names = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of names) signals.on(name, onSignal);
  let runArgs = args;
  let starts = [];
  try {
    for (;;) {
      const code = await new Promise((resolve) => {
        child = spawn(node, [script, ...runArgs], { stdio: "inherit", env: { ...env, REACH_SUPERVISED: "1" } });
        child.once("error", () => resolve(1));
        child.once("exit", (code, signal) => resolve(exitCode(code, signal)));
      });
      child = null;
      if (stopping || !RELAUNCH_CODES.has(code)) return code;
      const at = now();
      starts = starts.filter((t) => at - t < 600000);
      if (starts.length >= 5) {
        log("Reach stopped unexpectedly 5 times in 10 minutes, so it isn't starting again by itself. What happened is in crash.log in Reach's data folder. Run reach to start it.");
        return code;
      }
      const delay = DELAYS[starts.length] ?? 30000;
      starts.push(at);
      log(`Reach: starting again in ${delay / 1000}s…`);
      const waiting = new AbortController();
      try {
        await Promise.race([wait(delay, waiting.signal), new Promise((resolve) => { wake = resolve; })]);
      } finally {
        // Waking the race alone leaves its timeout referenced: after a stop,
        // the command would stay alive until the whole backoff had elapsed.
        waiting.abort();
        wake = null;
      }
      if (stopping) return code;
      // It starts Reach again; what a restart stops is already stopped.
      const restartAt = ["--yes", "-y"].includes(runArgs[0]) ? 1 : 0;
      if (runArgs[restartAt] === "restart")
        runArgs = runArgs.filter((arg, index) => index !== restartAt && !["--yes", "-y"].includes(arg));
    }
  } finally {
    for (const name of names) signals.off(name, onSignal);
  }
}
