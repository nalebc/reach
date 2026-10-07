import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { fail } from "./core.mjs";

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
  constructor({ platform = process.platform, run = runMacTerminal } = {}) {
    this.platform = platform;
    this.run = run;
  }
  targets = new Map();
  // false, "user" (a person's action) or "background" (Reach keeping its
  // list and text current, server/mac-terminal-watch.mjs).
  busy = false;
  current = Promise.resolve();
  async exclusive(authorize, fn, background = false) {
    authorize();
    if (this.platform !== "darwin")
      throw fail(409, "Desktop terminal discovery currently supports macOS.");
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
  async action(id, action, body, authorize, { background = false } = {}) {
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
    return this.exclusive(authorize, async () => {
      const target = this.targets.get(id);
      if (!target)
        throw fail(404, "Terminal not found. Refresh the Mac terminal list.");
      authorize();
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
  }
  async create(provider, authorize, command) {
    if (!terminalProviders.some((p) => p.id === provider))
      throw fail(400, "Choose Apple Terminal or iTerm2.");
    if (
      command !== undefined &&
      (typeof command !== "string" ||
        !command.trim() ||
        command.length > 16000 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command))
    )
      throw fail(400, "Enter a command without control characters.");
    return this.exclusive(authorize, async () => {
      authorize();
      const result = await this.run({
        provider,
        action: "create",
        ...(command ? { command } : {}),
      });
      authorize();
      return result;
    });
  }
}
