import * as pty from "node-pty";
import os from "node:os";
import { id, fail } from "./core.mjs";
// The last lines a shell printed, as plain text, for the Home cards. Full-screen
// programs (Codex, vim) redraw with cursor moves, so they get no preview.
export function terminalPreview(buffer, lines = 2) {
  const tail = String(buffer || "").slice(-8000);
  const left = tail.lastIndexOf("\x1b[?1049l");
  if (tail.lastIndexOf("\x1b[?1049h") > left) return null;
  // Only what the shell printed after a full-screen program closed.
  return (left >= 0 ? tail.slice(left + 8) : tail)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .split("\n")
    .map((line) =>
      // A carriage return redraws the line; keep what is left visible.
      (line.split("\r").filter((part) => part.trim()).pop() || "")
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trimEnd(),
    )
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .slice(-lines)
    .map((line) => line.slice(0, 120));
}
export class Terminals {
  sessions = new Map();
  create({ cwd, name, clientId, cols = 90, rows = 28, command = "", input = "" }) {
    if (
      [...this.sessions.values()].filter((s) => s.status === "running")
        .length >= 12
    )
      throw fail(
        409,
        "You already have 12 running terminals. Close one first.",
      );
    for (const [key, session] of this.sessions) {
      if (this.sessions.size < 50) break;
      if (session.status !== "running" && session.listeners.size === 0)
        this.sessions.delete(key);
    }
    if (this.sessions.size >= 50)
      throw fail(
        409,
        "Too many terminal sessions. Disconnect completed sessions first.",
      );
    // Shells inherit the user's login environment, never the companion's pairing configuration.
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    for (const k of Object.keys(env)) if (k.startsWith("REACH_")) delete env[k];
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL || "/bin/zsh";
    const proc = pty.spawn(
      shell,
      process.platform === "win32" ? ["-NoLogo"] : ["-l"],
      { name: "xterm-256color", cols, rows, cwd, env },
    );
    const session = {
      id: id(),
      clientId,
      name: String(name || `Terminal ${this.sessions.size + 1}`).slice(0, 80),
      cwd,
      createdAt: new Date().toISOString(),
      status: "running",
      closing: false,
      buffer: "",
      proc,
      listeners: new Set(),
      seq: 0,
    };
    proc.onData((data) => {
      session.buffer = (session.buffer + data).slice(-256000);
      session.seq++;
      for (const fn of session.listeners)
        fn({ type: "data", data, seq: session.seq });
    });
    let finished;
    session.ended = new Promise((resolve) => { finished = resolve; });
    proc.onExit(({ exitCode }) => {
      finished();
      session.status = "exited";
      session.exitCode = exitCode;
      for (const fn of session.listeners) fn({ type: "exit", exitCode });
    });
    this.sessions.set(session.id, session);
    // Server-resolved agent command (never client text), run once the shell starts.
    if (command) proc.write(`${command}\r`);
    // Or text the person chose to run (a chat's play button), typed as they
    // would type it: each line ends with Enter.
    else if (input) proc.write(`${input.replace(/\r?\n/g, "\r")}\r`);
    return this.meta(session);
  }
  meta(s) {
    return {
      id: s.id,
      clientId: s.clientId,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      createdAt: s.createdAt,
      exitCode: s.exitCode,
      preview: terminalPreview(s.buffer),
    };
  }
  list() {
    return [...this.sessions.values()].map((s) => this.meta(s)).reverse();
  }
  get(id) {
    const s = this.sessions.get(id);
    if (!s)
      throw fail(
        404,
        "Terminal not found. Sessions end when the companion restarts.",
      );
    return s;
  }
  close(id) {
    const s = this.get(id);
    // DELETE followed immediately by shutdown must not kill the same native
    // ConPTY handle twice. That can crash the Windows companion.
    if (s.status === "running" && !s.closing) {
      s.closing = true;
      s.proc.kill();
    }
    return s.ended;
  }
  async dispose() {
    const ended = [...this.sessions.keys()].map((id) => this.close(id));
    let timer;
    try {
      await Promise.race([
        Promise.all(ended),
        new Promise((resolve) => { timer = setTimeout(resolve, 6000); timer.unref(); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
