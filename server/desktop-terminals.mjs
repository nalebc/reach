import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import os from "node:os";
import { fail } from "./core.mjs";
import { computerWord } from "./computer-word.mjs";
import { windowsLaunch, windowsTerminalProviders, windowsTerminalRunner } from "./windows-terminals.mjs";

const helper = fileURLToPath(
  new URL("../scripts/native/mac-terminals.js", import.meta.url),
);
export const terminalProviders = [
  { id: "terminal", name: "Apple Terminal" },
  { id: "iterm2", name: "iTerm2" },
];
export function runMacTerminal(payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", helper],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error)
          return reject(
            fail(
              502,
              "The terminal app did not respond. Check the Mac for an Automation permission or close-confirmation dialog, then refresh before retrying.",
            ),
          );
        try {
          const result = JSON.parse(stdout);
          if (result.error)
            return reject(fail(result.status || 502, result.error));
          resolve(result);
        } catch {
          reject(fail(502, "Invalid response from the terminal app."));
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export class DesktopTerminals {
  // A Windows PC's terminals come from a helper built into Reach's data
  // folder (windows-terminals.mjs); `reach` is Reach's own process, whose
  // terminals are listed as Reach's already.
  constructor({ platform = process.platform, run, dataDir, reach = process.pid, launch = windowsLaunch, home = os.homedir } = {}) {
    this.platform = platform;
    this.run = run || (platform === "win32" ? windowsTerminalRunner({ dataDir }) : runMacTerminal);
    this.reach = reach;
    this.launch = launch;
    this.home = home;
  }
  get providers() {
    return this.platform === "win32" ? windowsTerminalProviders : terminalProviders;
  }
  targets = new Map();
  // false, "user" (a person's action) or "background" (Reach keeping its
  // list and text current, server/mac-terminal-watch.mjs).
  busy = false;
  current = Promise.resolve();
  async exclusive(authorize, fn, background = false) {
    authorize();
    if (this.platform !== "darwin" && this.platform !== "win32")
      throw fail(409, "Desktop terminal discovery currently supports macOS and Windows.");
    // Background work queues; a person's action waits for it rather than
    // failing, but two of a person's actions still never overlap.
    while (this.busy === "background" || (background && this.busy))
      await this.current;
    if (this.busy)
      throw fail(
        409,
        "Another terminal action is in progress. Try again in a moment.",
      );
    this.busy = background ? "background" : "user";
    const running = (async () => fn())();
    this.current = running.then(
      () => {},
      () => {},
    );
    try {
      return await running;
    } finally {
      this.busy = false;
    }
  }
  async list(authorize, { background = false } = {}) {
    if (this.platform === "win32")
      return this.exclusive(authorize, () => this.listWindows(authorize), background);
    return this.exclusive(authorize, async () => {
      const sessions = [],
        providers = [],
        next = new Map();
      for (const provider of terminalProviders) {
        try {
          authorize();
          const result = await this.run({
            provider: provider.id,
            action: "list",
          });
          authorize();
          for (const session of result.sessions) {
            // Finished: nothing to watch or type into, so not listed.
            if (session.ended) continue;
            const id = crypto
              .createHash("sha256")
              .update(JSON.stringify([provider.id, session.target]))
              .digest("hex");
            next.set(id, { provider: provider.id, target: session.target });
            sessions.push({
              id,
              provider: provider.id,
              name: session.name,
              tty: session.tty,
            });
          }
          providers.push({ ...provider, running: result.running });
        } catch (e) {
          // An unavailable app must not hide sessions from the other provider.
          providers.push({ ...provider, error: e.message });
        }
      }
      authorize();
      this.targets = next;
      return { sessions, providers };
    }, background);
  }
  // One look at every console on the PC; each answer names its app. A
  // helper that can't run says why, rather than showing no terminals.
  async listWindows(authorize) {
    authorize();
    const result = await this.run({ action: "list", exclude: this.reach });
    authorize();
    const sessions = [],
      next = new Map();
    for (const session of Array.isArray(result?.sessions) ? result.sessions : []) {
      if (session.ended || !this.providers.some((p) => p.id === session.provider)) continue;
      const id = crypto
        .createHash("sha256")
        .update(JSON.stringify([session.provider, session.target]))
        .digest("hex");
      next.set(id, { provider: session.provider, target: session.target });
      sessions.push({
        id,
        provider: session.provider,
        name: session.name,
        tty: session.tty,
      });
    }
    const providers = this.providers.map((provider) => ({
      ...provider,
      running: !!result?.running?.[provider.id],
      installed: result?.installed?.[provider.id] !== false,
    }));
    this.targets = next;
    return { sessions, providers };
  }
  async action(id, action, body, authorize, { background = false, beforeDispatch } = {}) {
    let dispatchStarted = false;
    try {
      if (!["read", "send", "focus", "close"].includes(action))
        throw fail(400, "Unknown terminal action.");
      if (
        action === "send" &&
        (typeof body?.text !== "string" ||
          // "" is Return on its own (accepting a prompt, an empty line); a
          // line of only spaces is more likely a slip.
          (body.text !== "" && !body.text.trim()) ||
          body.text.length > 16000 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.text))
      )
        throw fail(
          400,
          "Send up to 16,000 characters of text, without control codes.",
        );
      if (action === "close" && body?.confirm !== true)
        throw fail(
          400,
          "Confirm closing this terminal; running commands will stop.",
        );
      return await this.exclusive(authorize, async () => {
        const target = this.targets.get(id);
        if (!target)
          throw fail(404, `Terminal not found. Refresh the ${computerWord(this.platform)} terminal list.`);
        authorize();
        // Ownership is checked before input starts. Keep authority checks after
        // the result separate so a completed action retains its acknowledgement.
        beforeDispatch?.();
        dispatchStarted = true;
        const result = await this.run({
          ...target,
          action,
          ...(action === "send" ? { text: body.text } : {}),
          // Someone viewing the tab gets its scrollback, not just the screen.
          ...(action === "read" && body?.scrollback === true
            ? { scrollback: true }
            : {}),
        });
        if (action === "close") this.targets.delete(id);
        authorize();
        return result;
      }, background);
    } catch (error) {
      // A refused queued action never entered the native runner. Only an
      // explicit ownership-aware caller uses this no-action retry contract.
      if (beforeDispatch && !dispatchStarted) Object.assign(error, { notDispatched: true });
      throw error;
    }
  }
  // `cwd`: a Windows PC opens its terminal in this folder (a Mac's command
  // starts with its own cd); the owner's home folder without one.
  async create(provider, authorize, command, { cwd } = {}) {
    if (!this.providers.some((p) => p.id === provider))
      throw fail(
        400,
        this.platform === "win32"
          ? "Choose Windows Terminal or a console window."
          : "Choose Apple Terminal or iTerm2.",
      );
    if (
      command !== undefined &&
      (typeof command !== "string" ||
        !command.trim() ||
        command.length > 16000 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command))
    )
      throw fail(400, "Enter a command without control characters.");
    const windows = this.platform === "win32";
    const folder = windows ? (cwd ?? this.home()) : null;
    if (windows) {
      // One line: a shell's argument there, never more lines of a script.
      if (command !== undefined && /[\t\n\r]/.test(command))
        throw fail(400, "Enter a command without control characters.");
      if (typeof folder !== "string" || !/^[A-Za-z]:[\\/]/.test(folder) || /[\x00-\x1f"]/.test(folder))
        throw fail(400, "Choose a folder on this PC.");
    }
    return this.exclusive(authorize, async () => {
      authorize();
      const result = await this.run(
        windows
          ? { provider, action: "create", ...this.launch({ cwd: folder, command }) }
          : {
              provider,
              action: "create",
              ...(command ? { command } : {}),
            },
      );
      authorize();
      return result;
    });
  }
}
