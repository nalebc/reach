import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
import { buildNative } from "./native-build.mjs";
import { COLD_START_MS, SCRIPT_BLOCKED, powershellFile, scriptBlocked } from "./powershell.mjs";
const exec = promisify(execFile),
  native =fileURLToPath(new URL("../scripts/native/", import.meta.url));
export async function desktopBinary(config, kind, { signal } = {}) {
  signal?.throwIfAborted();
  // Name the cached build after its source, so any helper edit recompiles.
  const source = await fs.readFile(path.join(native, `${kind}.swift`));
  const file = path.join(
    config.dataDir,
    `reach-${kind}-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
  );
  try {
    await buildNative(file, ["swiftc", "-parse-as-library", "-O", path.join(native, `${kind}.swift`)], { signal });
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw error;
    // Said as the owner can act on it, without Reach's own part names.
    if (error.developerTools === false)
      throw Object.assign(
        fail(503, "This needs Apple's Command Line Tools. Run xcode-select --install on your Mac, then try again."),
        { developerTools: false },
      );
    console.warn(`Reach: building ${kind} failed: ${error.message}`);
    throw fail(503, "Reach couldn't prepare this on your Mac. Check macOS permissions, then try again.");
  }
  return file;
}
export async function desktopDisplays(config, { run = exec, platform = process.platform } = {}) {
  let result;
  if (platform === "darwin")
    result = await run(
      await desktopBinary(config, "screen-stream"),
      ["--list"],
      { timeout: 10000, maxBuffer: 65536 },
    );
  else if (platform === "win32")
    result = await run(
      "powershell.exe",
      powershellFile(path.join(native, "desktop-input.ps1"), ["--list"], { sta: true }),
      { timeout: COLD_START_MS, maxBuffer: 65536, windowsHide: true },
    ).catch((error) => {
      // Said in words, not as PowerShell's raw command line and stack.
      const said = String(error.stderr || "").trim();
      if (scriptBlocked(said)) throw Object.assign(fail(503, SCRIPT_BLOCKED), { permanent: true });
      throw fail(
        503,
        error.killed
          ? "Windows took too long to list its displays. Keep the PC signed in and unlocked, then reconnect."
          : `Windows couldn't list its displays${said ? `: ${said.split(/\r?\n/)[0].slice(0, 200)}` : "."} Keep the PC signed in and unlocked, and run Reach in your desktop session.`,
      );
    });
  else throw fail(501, "Remote desktop currently supports macOS and Windows.");
  const list = JSON.parse(result.stdout);
  if (!Array.isArray(list) || !list.length || list.length > 32)
    throw fail(503, "No desktop displays are available.");
  return list;
}
// One helper per control connection, never one process per pointer movement.
// The helper releases every held button on EOF, SIGTERM or its own watchdog.
export class DesktopInput {
  constructor(child) {
    this.child = child;
    this.pending = null;
    this.stopped = false;
    this.exited = false;
    // Pending requests reject as soon as stop starts, but the native process
    // can still finish an action or release held buttons until it really exits.
    this.terminated = new Promise((resolve) => {
      const finished = () => { this.exited = true; resolve(); };
      child.once("exit", finished);
      child.once("error", () => { if (!child.pid) finished(); });
    });
    let buffer = "";
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.stop());
    child.on("error", () => this.stop());
    child.on("exit", () => this.stop());
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 3 * 1024 * 1024) return this.stop();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const value = JSON.parse(line);
          const p = this.pending;
          if (!p) return this.stop();
          this.pending = null;
          clearTimeout(p.timer);
          // refused: the helper turned down this one action (a typing target
          // that moved, a key it doesn't know); control goes on.
          value.error
            ? p.reject(Object.assign(fail(403, value.error), value.fatal ? {} : { refused: true }))
            : p.resolve(value);
        } catch {
          this.stop();
        }
      }
    });
  }
  static async create(config, display) {
    let executable, args;
    if (config.desktopInputCommand) {
      [executable, ...args] = config.desktopInputCommand;
    } else if (process.platform === "darwin") {
      executable = await desktopBinary(config, "desktop-input");
      args = [display];
    } else if (process.platform === "win32") {
      executable = "powershell.exe";
      args = powershellFile(path.join(native, "desktop-input.ps1"), [display], { sta: true });
    } else throw fail(501, "Desktop input supports macOS and Windows.");
    return new DesktopInput(
      spawn(executable, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  }
  send(action) {
    if (this.stopped)
      return Promise.reject(
        fail(403, "Desktop input disconnected. Enable control again."),
      );
    if (this.pending)
      return Promise.reject(fail(429, "Wait for the previous desktop action."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(), 10000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(action) + "\n");
    });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(fail(403, "Desktop input disconnected."));
      this.pending = null;
    }
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const child = this.child;
    if (this.exited || !child.pid) return;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (this.exited) return;
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      force.unref();
      child.once("exit", () => clearTimeout(force));
    }, 500);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }
}
