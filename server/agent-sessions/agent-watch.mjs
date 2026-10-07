import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// News the moment an agent's app writes it, from the agents' own files:
// - the Codex app keeps its queue and history in SQLite databases in WAL mode
//   (~/.codex/queue_<n>.sqlite, thread_history_<n>.sqlite, state_<n>.sqlite;
//   verified with Codex 0.160): a write there is a Codex chat or its queue
//   changing, though not which one;
// - Claude Code writes each session to ~/.claude/projects/<folder>/<id>.jsonl:
//   a write there is that session changing.
// Bursts of writes are told once (`debounceMs`).
const CODEX_DB = /^(queue|thread_history|state)_\d+\.sqlite(-wal)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAgentWatch({
  codexHome = path.join(os.homedir(), ".codex"),
  claudeProjects = path.join(os.homedir(), ".claude", "projects"),
  watch = (dir, options, listener) => fs.watch(dir, options, listener),
  debounceMs = 120,
} = {}) {
  const listeners = new Set();
  const timers = new Map();
  const watchers = [];
  // One word per kind of news per burst.
  const tell = (key, news) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        for (const listener of listeners) listener(news);
      }, debounceMs),
    );
  };
  const start = (dir, options, listener) => {
    try {
      const watcher = watch(dir, options, listener);
      watcher.on?.("error", () => {});
      watcher.unref?.();
      watchers.push(watcher);
    } catch {
      /* not there (the agent isn't installed): nothing to watch */
    }
  };
  start(codexHome, {}, (event, file) => {
    const name = String(file || "");
    if (!CODEX_DB.test(name)) return;
    const kind = name.startsWith("queue_") ? "queue" : "history";
    tell(`codex:${kind}`, { agent: "codex", kind });
  });
  start(claudeProjects, { recursive: true }, (event, file) => {
    const name = path.basename(String(file || ""));
    if (!name.endsWith(".jsonl")) return;
    const id = name.slice(0, -6);
    if (UUID.test(id)) tell(`claude:${id}`, { agent: "claude", kind: "history", id });
  });
  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      for (const watcher of watchers.splice(0)) watcher.close?.();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      listeners.clear();
    },
  };
}
