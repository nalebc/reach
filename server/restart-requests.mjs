import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fail, isPlainRecord } from "./core.mjs";

// In a source checkout, an agent's `reach restart` asks you first (Needs you
// on the phone) instead of ending Reach's terminals and live screens on its
// own: agents restarted Reach again and again on Oct 6. The command writes a
// request beside Reach's data; Restart opens Terminal and restarts Reach
// there, Not now drops it. Your own restart in Terminal never asks.
export const restartRequestFile = (dataDir) =>
  path.join(dataDir, "restart-request.json");
const LIFETIME = 30 * 60 * 1000;
// "Restart when done" waits this long at most (a background dev server
// counts as working and would hold it forever).
const WAIT_LIMIT = 4 * 60 * 60 * 1000;

// The chat that asked, from its agent's own environment (Claude Code gives
// each command it runs CLAUDE_CODE_SESSION_ID; Codex, CODEX_THREAD_ID), so
// the card opens it. Anything else: no chat, the card opens on Home.
export function askingChat(env = process.env) {
  for (const [agent, name] of [["claude", "CLAUDE_CODE_SESSION_ID"], ["codex", "CODEX_THREAD_ID"]])
    if (CHAT_ID.test(String(env[name] || ""))) return { agent, id: env[name] };
  return null;
}
const CHAT_ID = /^[\w-]{1,80}$/;
const chatOf = (value) =>
  isPlainRecord(value) && ["claude", "codex"].includes(value.agent) && CHAT_ID.test(String(value.id || ""))
    ? { agent: value.agent, id: value.id }
    : null;

// The command's side: one request at a time; asking again keeps it.
export function askRestart(dataDir, { app = "", chat = null, now = Date.now() } = {}) {
  const file = restartRequestFile(dataDir);
  const current = readRequest(file, now);
  if (current) return { request: current, again: true };
  const request = {
    id: crypto.randomUUID(),
    app: String(app).slice(0, 80),
    ...(chatOf(chat) ? { chat: chatOf(chat) } : {}),
    requestedAt: now,
    expiresAt: now + LIFETIME,
  };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(request), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { request, again: false };
}

function readRequest(file, now = Date.now()) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      isPlainRecord(r) &&
      typeof r.id === "string" &&
      /^[\w-]{1,64}$/.test(r.id) &&
      Number.isFinite(r.requestedAt) &&
      Number.isFinite(r.expiresAt) &&
      r.expiresAt > now
    )
      return { ...r, app: typeof r.app === "string" ? r.app.slice(0, 80) : "", chat: chatOf(r.chat), after: r.after === true };
  } catch {
    /* none */
  }
  return null;
}

// Reach's side: the open request, answering it, and a nudge when one arrives.
// A restart ends the Claude chats Reach runs mid-turn (Oct 8, "Claw UI
// rebuild" stopped mid-step): with any working, the card names them and
// "Restart when they finish" waits for the last one.
export function restartRequests({ dataDir, restart, working = () => [], onChange = () => {}, watch = fs.watch, everyMs = 3000 }) {
  const file = restartRequestFile(dataDir);
  // Reach just started: whatever restart was asked for has happened.
  fs.rmSync(file, { force: true });
  let watcher;
  try {
    watcher = watch(dataDir, (_, name) => {
      if (!name || name === path.basename(file)) onChange();
    });
    // Never what keeps Reach (or a test) from exiting.
    watcher.unref?.();
  } catch {
    /* the regular scan still finds it */
  }
  const chats = () => {
    try {
      return working() || [];
    } catch {
      throw fail(503, "Reach couldn't check working chats. The restart is still waiting.");
    }
  };
  // A restart waiting for chats: checked on a beat, restarts once none work.
  let timer = null;
  const wait = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      const r = readRequest(file);
      if (!r?.after) return void clearInterval(timer);
      try { if (chats().length) return; }
      catch { return; }
      clearInterval(timer);
      fs.rmSync(file, { force: true });
      restart();
      onChange();
    }, everyMs);
    timer.unref?.();
  };
  return {
    list: () => {
      const r = readRequest(file);
      return r ? [{ ...r, working: chats() }] : [];
    },
    decide(id, action) {
      const r = readRequest(file);
      if (!r || r.id !== id) throw fail(409, "This restart was already answered.");
      if (action === "after" && chats().length) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...r, after: true, expiresAt: Date.now() + WAIT_LIMIT }), { mode: 0o600 });
        fs.renameSync(tmp, file);
        wait();
        onChange();
        return { status: "waiting" };
      }
      fs.rmSync(file, { force: true });
      clearInterval(timer);
      if (action !== "restart" && action !== "after") return { status: "declined" };
      restart();
      return { status: "restarting" };
    },
    close: () => {
      clearInterval(timer);
      watcher?.close();
    },
  };
}
