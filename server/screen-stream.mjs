import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
import { buildNative } from "./native-build.mjs";
import { hostApp, outsideTerminal, processTable } from "../scripts/instances.mjs";
const exec = promisify(execFile);
const native = fileURLToPath(new URL("../scripts/native/", import.meta.url));
const MAX_FRAME = 8 * 1024 * 1024;
const PERMISSION = /Screen Recording/i;
// Why the screen helper has no Screen Recording, when Reach can tell: it runs
// inside an app that isn't Terminal (an agent restarted it from its shell).
export function permissionHint(app = appOf()) {
  return outsideTerminal(app)
    ? `Reach is running inside ${app}, which has no Screen Recording permission. On your Mac, run ./reach restart in Terminal.`
    : "";
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
      // No permission: retrying can't help, so the phone stops and says why
      // instead of "Connecting…" forever.
      const error = Error(
        (PERMISSION.test(said) && permissionHint()) ||
          said ||
          "Screen capture stopped. Reconnect to try again.",
      );
      if (PERMISSION.test(said)) error.permanent = true;
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.stop(
            Error(
              "Live screen capture timed out. Check Screen Recording permission and reconnect.",
            ),
          ),
        15000,
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
  }
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
    return () => new NativeScreenSource(binary);
  }
  if (process.platform === "win32")
    return () =>
      new NativeScreenSource("powershell.exe", [
        "-NoProfile",
        "-File",
        path.join(native, "screen-stream.ps1"),
      ]);
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
