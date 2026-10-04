import * as pty from "node-pty";
import os from "node:os";
import { id, fail } from "./core.mjs";
export class Terminals {
  sessions = new Map();
  create({ cwd, name, clientId, cols = 90, rows = 28 }) {
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
    proc.onExit(({ exitCode }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      for (const fn of session.listeners) fn({ type: "exit", exitCode });
    });
    this.sessions.set(session.id, session);
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
    if (s.status === "running") s.proc.kill();
  }
  dispose() {
    for (const s of this.sessions.values())
      if (s.status === "running") s.proc.kill();
  }
}
