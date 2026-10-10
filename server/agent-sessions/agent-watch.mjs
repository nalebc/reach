import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// News the moment an agent's app writes it, from the agents' own files:
// - the Codex app keeps its queue and history in SQLite databases in WAL mode
//   (~/.codex/queue_<n>.sqlite, thread_history_<n>.sqlite, state_<n>.sqlite;
//   verified with Codex 0.160): a write there is a Codex chat or its queue
//   changing, though not which one;
// - Claude Code writes each session to ~/.claude/projects/<folder>/<id>.jsonl:
//   a write there is that session changing;
// - Codex writes each chat to ~/.codex/sessions/<date>/rollout-…-<id>.jsonl
//   (which chat, unlike its databases);
// - Claude Code's registry, ~/.claude/sessions/<pid>.json, says when a session
//   turns busy, waits on you or goes idle; the Claude app's records
//   (claude-code-sessions) say which chat it shows, what it's called and its
//   permission mode;
// - the Codex app's ~/.codex/.codex-global-state.json holds the permission
//   mode its composer is in.
// The first write is told at once; more in the next `debounceMs` are told
// once when it's up (a reply streams in as Claude Code writes it: a trailing
// wait put every block 120 ms late, and a steady stream of writes later still).
const CODEX_DB = /^(queue|thread_history|state)_\d+\.sqlite(-wal)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAgentWatch({
  codexHome = path.join(os.homedir(), ".codex"),
  claudeProjects = path.join(os.homedir(), ".claude", "projects"),
  claudeSessions = path.join(os.homedir(), ".claude", "sessions"),
  claudeAppRecords = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  geminiHome = path.join(os.homedir(), ".gemini"),
  watch = (dir, options, listener) => fs.watch(dir, options, listener),
  debounceMs = 120,
  retryMs = 5000,
} = {}) {
  const retries = new Set();
  const listeners = new Set();
  const timers = new Map();
  const watchers = [];
  // key -> { timer, news (more came while it ran) }
  const say = (news) => {
    for (const listener of listeners) listener(news);
  };
  const tell = (key, news) => {
    const held = timers.get(key);
    if (held) {
      held.news = news;
      return;
    }
    say(news);
    const window = { news: null, timer: null };
    const close = () => {
      if (!window.news) return timers.delete(key);
      const next = window.news;
      window.news = null;
      say(next);
      window.timer = setTimeout(close, debounceMs);
      window.timer.unref?.();
    };
    window.timer = setTimeout(close, debounceMs);
    window.timer.unref?.();
    timers.set(key, window);
  };
  // A watch that fails (the folder isn't there yet: the agent installed
  // later) or dies (the folder replaced, macOS dropping it) starts again
  // after retryMs: a dead one left every chat waiting for the phone's 30 s
  // look until Reach restarted.
  let closed = false;
  const start = (dir, options, listener) => {
    const again = () => {
      if (closed) return;
      const timer = setTimeout(() => {
        retries.delete(timer);
        start(dir, options, listener);
      }, retryMs);
      timer.unref?.();
      retries.add(timer);
    };
    try {
      const watcher = watch(dir, options, listener);
      watcher.on?.("error", () => {
        watcher.close?.();
        watchers.splice(watchers.indexOf(watcher) >>> 0, 1);
        again();
      });
      watcher.unref?.();
      watchers.push(watcher);
    } catch {
      again();
    }
  };
  start(codexHome, {}, (event, file) => {
    const name = String(file || "");
    // The Codex app's saved choices: the permission mode its composer is in.
    if (name === ".codex-global-state.json") return tell("codex:settings", { agent: "codex", kind: "settings" });
    if (!CODEX_DB.test(name)) return;
    const kind = name.startsWith("queue_") ? "queue" : "history";
    tell(`codex:${kind}`, { agent: "codex", kind });
  });
  start(claudeProjects, { recursive: true }, (event, file) => {
    const name = path.basename(String(file || ""));
    if (!name.endsWith(".jsonl")) return;
    // A sub-agent's own transcript (<session>/subagents/agent-….jsonl, or
    // a workflow's: <session>/subagents/workflows/<run>/…) is its chat
    // changing: what the agent does shows there.
    const parent = /([0-9a-f-]{36})[\\/]subagents[\\/](?:workflows[\\/][\w-]{1,80}[\\/])?[^\\/]+\.jsonl$/i.exec(String(file || ""))?.[1];
    const id = parent || name.slice(0, -6);
    if (UUID.test(id)) tell(`claude:${id}`, { agent: "claude", kind: "history", id });
  });
  start(path.join(codexHome, "sessions"), { recursive: true }, (event, file) => {
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(String(file || ""))?.[1];
    if (id) tell(`codex:rollout:${id}`, { agent: "codex", kind: "rollout", id });
  });
  start(claudeSessions, {}, (event, file) => {
    if (/^\d+\.json$/.test(String(file || ""))) tell("claude:status", { agent: "claude", kind: "status" });
  });
  start(claudeAppRecords, { recursive: true }, (event, file) => {
    if (/local_[^/]*\.json$/.test(String(file || ""))) tell("claude:app", { agent: "claude", kind: "app" });
  });
  // Gemini rewrites JSON sessions or appends JSONL records while its CLI
  // runs. Its filename has only eight id characters: wake open Gemini
  // histories, which resolve the complete native session id themselves.
  start(path.join(geminiHome, "tmp"), { recursive: true }, (event, file) => {
    if (/(?:^|[\\/])chats[\\/]session-[^\\/]+\.jsonl?$/.test(String(file || "")))
      tell("gemini:history", { agent: "gemini", kind: "history" });
  });
  start(geminiHome, {}, (event, file) => {
    if (String(file || "") === "projects.json") tell("gemini:projects", { agent: "gemini", kind: "projects" });
  });
  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      for (const watcher of watchers.splice(0)) watcher.close?.();
      for (const held of timers.values()) clearTimeout(held.timer);
      timers.clear();
      listeners.clear();
    },
  };
}
