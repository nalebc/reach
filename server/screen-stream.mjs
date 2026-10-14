import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
import { buildNative } from "./native-build.mjs";
import { COLD_START_MS, SCRIPT_BLOCKED, powershellFile, scriptBlocked } from "./powershell.mjs";
import { hostApp, outsideTerminal, processTable } from "../scripts/instances.mjs";
import {
  PROTECTED_APP_IDS,
  PROTECTED_APP_NAMES,
  PROTECTED_TITLE_WORDS,
  REACH_WORDS,
} from "./agent-guard.mjs";
const exec = promisify(execFile);
// The windows a guest's live screen leaves out, for the screen helper
// (scripts/native/screen-stream.swift): the ones agents never see either.
export const privateWindows = () =>
  JSON.stringify({
    ids: PROTECTED_APP_IDS,
    names: PROTECTED_APP_NAMES,
    words: REACH_WORDS,
    titles: PROTECTED_TITLE_WORDS,
  });
const native = fileURLToPath(new URL("../scripts/native/", import.meta.url));
const MAX_FRAME = 8 * 1024 * 1024;
const KILL_AFTER_MS = 5000;
const PERMISSION = /Screen Recording/i;
// Why the screen helper has no Screen Recording, and what to do. The
// permission belongs to the app Reach runs inside, never to the helper: run
// inside another app (an agent restarted it from its shell), Reach goes back
// to Terminal; in Terminal (or when the app can't be told), Terminal is
// allowed and reopened, as macOS only applies it to a restarted app (the
// same steps as server/platform.mjs's screenshot refusal).
export function permissionHint(app = appOf()) {
  if (outsideTerminal(app))
    return `Reach is running inside ${app}, which has no Screen Recording permission. On your Mac, run ./reach restart in Terminal.`;
  const who = app || "the app running Reach, such as Terminal";
  return `Screen Recording is off for ${app || "Reach"}. On your Mac, open System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording on older macOS). Allow ${who}, then quit and reopen ${app || "that app"} and restart Reach.`;
}
// The Mac app Reach runs inside (Terminal, iTerm, an agent's app): the one
// macOS asks about in its privacy settings. "" when it can't be told.
export function hostAppName() {
  return appOf();
}
function appOf() {
  if (process.platform !== "darwin") return "";
  try {
    return hostApp(processTable(), process.pid);
  } catch {
    return "";
  }
}

// Length-prefixed frames over a pipe; the helper never opens a network port.
export class NativeScreenSource {
  constructor(executable, args = []) {
    this.child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.failure = null;
    let diagnostic = "";
    this.child.stderr.on("data", (b) => {
      diagnostic = (diagnostic + b.toString()).slice(-4096);
    });
    this.child.stdin.on("error", () =>
      this.stop(Error("Screen capture disconnected. Reconnect to try again.")),
    );
    this.child.on("error", () =>
      this.stop(Error("Could not start live screen capture.")),
    );
    this.child.on("exit", () => {
      const said = diagnostic.trim();
      // No permission (macOS) or scripts refused by policy (Windows):
      // retrying can't help, so the phone stops and says why instead of
      // "Connecting…" forever.
      const blocked = process.platform === "win32" && scriptBlocked(said);
      const error = Error(
        (blocked
          ? SCRIPT_BLOCKED
          : PERMISSION.test(said) && process.platform === "darwin"
            ? permissionHint()
            : said) || "Screen capture stopped. Reconnect to try again.",
      );
      if (blocked || PERMISSION.test(said)) error.permanent = true;
      this.stop(error);
    });
    this.child.stdout.on("data", (chunk) => {
      if (this.failure) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_FRAME + 4)
        return this.stop(Error("Screen frame exceeded the size limit."));
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32BE();
      if (!length || length > MAX_FRAME)
        return this.stop(Error("Invalid screen frame."));
      if (this.buffer.length < length + 4) return;
      if (!this.pending || this.buffer.length !== length + 4)
        return this.stop(Error("Unexpected screen frame."));
      const frame = this.buffer.subarray(4);
      this.buffer = Buffer.alloc(0);
      const pending = this.pending;
      this.pending = null;
      this.answered = true;
      clearTimeout(pending.timer);
      pending.resolve(frame);
    });
  }
  setBitrate(value) {
    if (
      Number.isSafeInteger(value) &&
      value >= 750000 &&
      value <= 24000000 &&
      !this.failure &&
      this.child.stdin.writable
    )
      this.child.stdin.write(`bitrate ${value}\n`);
  }

  next(command = "frame") {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending)
      return Promise.reject(Error("Screen capture is already pending."));
    // A cold Windows helper compiles before its first picture
    // (server/powershell.mjs); retried at 15 s, it would only start cold again.
    const wait =
      !this.answered && process.platform === "win32" ? COLD_START_MS : 15000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.stop(
            Error(
              "Live screen capture didn’t answer in time. Reconnecting…",
            ),
          ),
        wait,
      );
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(command + "\n");
    });
  }
  stop(error = Error("Screen capture stopped.")) {
    if (this.failure) return;
    this.failure = error;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.child.stdin.destroy();
    this.child.kill();
    // The helper stops its capture and exits within a couple of seconds
    // (scripts/native/screen-stream.swift finish); one that doesn't is ended
    // outright, so no capture outlives what it was for (Oct 12: a stream
    // left running kept the Mac's screen-sharing mark on for hours).
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const force = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      }, KILL_AFTER_MS);
      force.unref?.();
      this.child.once("exit", () => clearTimeout(force));
    }
  }
}
// Screen helpers an earlier Reach left running (it was killed, or crashed
// mid-stream): this data folder's own picture and sound helpers whose parent
// isn't this Reach. Ended on start and on Pause, so a paused Mac captures
// nothing.
export function sweepScreenHelpers({
  dataDir,
  self = process.pid,
  table = processTable,
  kill = (pid, signal) => process.kill(pid, signal),
  platform = process.platform,
} = {}) {
  if (platform !== "darwin" || !dataDir) return [];
  // A Mac's paths, whichever computer runs this (its tests run on Windows).
  const prefixes = ["reach-screen-stream-", "reach-screen-sound-"].map((name) => path.posix.join(dataDir, name));
  let rows;
  try {
    rows = table();
  } catch {
    return [];
  }
  const ended = [];
  for (const row of rows) {
    if (row.pid === self || row.ppid === self) continue;
    if (!prefixes.some((prefix) => row.command.startsWith(prefix))) continue;
    try {
      kill(row.pid, "SIGTERM");
      ended.push(row.pid);
    } catch {}
  }
  return ended;
}

export async function createScreenSource(config) {
  if (process.platform === "darwin") {
    // Name the cached build after its source, so upgrades never reuse a
    // stale helper.
    const source = await fs.readFile(path.join(native, "screen-stream.swift"));
    const binary = path.join(
      config.dataDir,
      `reach-screen-stream-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
    );
    try {
      await buildNative(binary, ["swiftc", "-parse-as-library", "-O", path.join(native, "screen-stream.swift")]);
    } catch {
      throw fail(
        503,
        "Live screen needs Apple Command Line Tools. Run xcode-select --install on your Mac, then reconnect. macOS 12.3 or newer is required.",
      );
    }
    // Construction is delayed until the broadcaster rechecks active viewers.
    // The first protocol's one shared picture (no phone of yours speaks it
    // any more; a guest still can): the primary display as still images,
    // with password managers and Reach's own windows left out.
    return () =>
      new NativeScreenSource(binary, [
        "primary",
        "jpeg",
        "15",
        "1600",
        "6000000",
        "auto",
        "",
        privateWindows(),
      ]);
  }
  if (process.platform === "win32")
    return () =>
      new NativeScreenSource(
        "powershell.exe",
        powershellFile(path.join(native, "screen-stream.ps1")),
      );
  throw fail(501, "Live screen currently supports macOS and Windows.");
}

// One OS capture session for all viewers. Each viewer must acknowledge a displayed
// frame before receiving another, so a slow phone never accumulates stale frames.
export class ScreenBroadcast {
  constructor(prepare) {
    this.prepare = prepare;
  }
  viewers = new Map();
  generation = 0;
  source = null;
  timer = null;
  add(ws, authorize) {
    if (this.viewers.size >= 4)
      throw fail(429, "Four screen viewers are already connected.");
    this.viewers.set(ws, { authorize, waiting: false, sentAt: 0 });
    if (this.viewers.size === 1) void this.start();
  }
  ack(ws) {
    const viewer = this.viewers.get(ws);
    if (viewer) viewer.waiting = false;
  }
  remove(ws) {
    this.viewers.delete(ws);
    if (!this.viewers.size) this.halt();
  }
  halt() {
    this.generation++;
    clearTimeout(this.timer);
    this.source?.stop();
    this.source = null;
  }
  stop(message = "Screen viewing is off.") {
    for (const ws of this.viewers.keys()) this.fail(ws, message);
    this.halt();
  }
  fail(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", error: message }));
      ws.close(4001, "Screen stream stopped");
    }
    this.remove(ws);
  }
  async start() {
    const generation = ++this.generation;
    try {
      const factory = await this.prepare();
      if (generation !== this.generation || !this.viewers.size) return;
      for (const [ws, v] of this.viewers) if (!v.authorize()) this.remove(ws);
      if (!this.viewers.size) return;
      this.source = factory();
      const tick = async () => {
        if (generation !== this.generation) return;
        const started = Date.now();
        try {
          let ready = false;
          for (const [ws, v] of this.viewers) {
            if (!v.authorize() || ws.readyState !== 1) {
              this.remove(ws);
              continue;
            }
            if (v.waiting && Date.now() - v.sentAt > 15000) {
              this.fail(
                ws,
                "Screen viewer stopped responding. Reconnect to continue.",
              );
              continue;
            }
            if (!v.waiting && ws.bufferedAmount === 0) ready = true;
          }
          if (ready && this.source) {
            const frame = await this.source.next();
            if (generation !== this.generation) return;
            // One byte from the helper: nothing changed on screen.
            if (frame.length > 1)
              for (const [ws, v] of this.viewers) {
                if (!v.authorize()) {
                  this.remove(ws);
                  continue;
                }
                if (
                  ws.readyState === 1 &&
                  !v.waiting &&
                  ws.bufferedAmount === 0
                ) {
                  v.waiting = true;
                  v.sentAt = Date.now();
                  ws.send(frame);
                }
              }
          }
          if (generation === this.generation && this.viewers.size)
            this.timer = setTimeout(
              tick,
              Math.max(1, 1000 / 15 - (Date.now() - started)),
            );
        } catch (e) {
          if (generation === this.generation) this.stop(e.message);
        }
      };
      void tick();
    } catch (e) {
      if (generation === this.generation) this.stop(e.message);
    }
  }
}
