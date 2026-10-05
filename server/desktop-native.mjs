import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
const exec = promisify(execFile),
  native =fileURLToPath(new URL("../scripts/native/", import.meta.url));
const builds = new Map();
export async function desktopBinary(config, kind) {
  // Name the cached build after its source, so any helper edit recompiles.
  const source = await fs.readFile(path.join(native, `${kind}.swift`));
  const file = path.join(
    config.dataDir,
    `reach-${kind}-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
  );
  if (!builds.has(file)) {
    const build = (async () => {
      try {
        await fs.access(file);
      } catch {
        const tmp = `${file}-${process.pid}.tmp`;
        try {
          await exec(
            "/usr/bin/xcrun",
            [
              "swiftc",
              "-parse-as-library",
              "-O",
              path.join(native, `${kind}.swift`),
              "-o",
              tmp,
            ],
            { timeout: 120000, maxBuffer: 1024 * 1024 },
          );
          await fs.chmod(tmp, 0o700);
          await fs.rename(tmp, file);
        } catch (e) {
          await fs.rm(tmp, { force: true });
          throw fail(
            503,
            `Could not prepare the ${kind} helper. Install Apple Command Line Tools and check macOS permissions.`,
          );
        }
      }
    })();
    builds.set(file, build);
    build.catch(() => builds.delete(file));
  }
  await builds.get(file);
  return file;
}
export async function desktopDisplays(config) {
  let result;
  if (process.platform === "darwin")
    result = await exec(
      await desktopBinary(config, "screen-stream"),
      ["--list"],
      { timeout: 10000, maxBuffer: 65536 },
    );
  else if (process.platform === "win32")
    result = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-STA",
        "-File",
        path.join(native, "desktop-input.ps1"),
        "--list",
      ],
      { timeout: 15000, maxBuffer: 65536 },
    );
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
          value.error ? p.reject(fail(403, value.error)) : p.resolve(value);
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
      args = [
        "-NoProfile",
        "-STA",
        "-File",
        path.join(native, "desktop-input.ps1"),
        display,
      ];
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
    this.child.stdin.end();
    const child = this.child;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      force.unref();
      child.once("exit", () => clearTimeout(force));
    }, 500);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }
}
