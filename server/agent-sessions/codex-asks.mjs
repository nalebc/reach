// What a Codex chat that another engine holds (the Codex app, a terminal)
// waits on you for. That engine shows its approval card itself and tells no
// one else: nothing reaches the shared daemon and the chat's file has no
// "waiting" entry (verified 2026-10-05). But the file records the command
// asking for more permission, with Codex's question, as it's made, and its
// output only once it ran.
//
// Not every such command asks you (2026-10-06: "Codex needs your answer"
// flashed on the phone and was gone): in "Approve for me" (approvals_reviewer
// "auto_review") Codex's own reviewer decides, and a command a saved rule
// allows runs at once. So a chat in that mode never counts from its file, and
// a command counts only once it has gone `settleMs` without an output.
import fs from "node:fs/promises";

const ESCALATED = /["']?sandbox_permissions["']?\s*:\s*["']require_escalated["']/;
// The parsed field, not the whole string: command text may quote the phrase.
// Arguments that aren't JSON keep the old text match.
const escalated = (call) => {
  try {
    const args = JSON.parse(call);
    if (args && typeof args === "object" && !Array.isArray(args)) return args.sandbox_permissions === "require_escalated";
  } catch {}
  return ESCALATED.test(call);
};
const JUSTIFICATION = /["']?justification["']?\s*:\s*"((?:[^"\\]|\\.)*)"/;
const COMMAND = /["']?(?:cmd|command)["']?\s*:\s*"((?:[^"\\]|\\.)*)"/;
const unescape = (s) => {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
};
// The reviewer a turn's settings name (turn_context, or settings changed
// mid-turn); "user" is you.
const reviewerOf = (e) =>
  e?.type === "turn_context"
    ? e.payload?.approvals_reviewer
    : e?.type === "event_msg" && e.payload?.type === "thread_settings_applied"
      ? e.payload?.thread_settings?.approvals_reviewer
      : undefined;

// Requests answered from the phone (Allow once or Deny pressed on the Codex
// app's card, app-cards.mjs): an allowed command runs on and writes nothing
// to the file until it ends, so it would read as still waiting on you.
const answeredHere = new Map(); // call_id -> when
export function markCodexAnswered(callId, now = Date.now()) {
  for (const [id, at] of answeredHere) if (now - at > 6 * 60 * 60 * 1000) answeredHere.delete(id);
  if (callId) answeredHere.set(String(callId), now);
}

// The newest turn, read backwards: its newest unanswered escalated command,
// the reviewer in force, and whether the turn's start was reached.
function scan(text) {
  const answered = new Set();
  let pending = null;
  let reviewer;
  for (const line of text.split("\n").reverse()) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // the cut first line, or one being written
    }
    // The newest settings are the ones in force.
    reviewer ??= reviewerOf(e);
    // Where this turn began (or the last one ended): nothing older waits.
    if (e?.type === "event_msg" && (e.payload?.type === "task_started" || e.payload?.type === "task_complete"))
      return { pending, reviewer, whole: true };
    if (pending || e?.type !== "response_item") continue;
    const p = e.payload || {};
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      answered.add(p.call_id);
      continue;
    }
    if ((p.type !== "function_call" && p.type !== "custom_tool_call") || answered.has(p.call_id) || answeredHere.has(String(p.call_id)))
      continue;
    const call = String(p.arguments ?? p.input ?? "");
    if (escalated(call)) pending = { call, at: Date.parse(e.timestamp), callId: p.call_id ? String(p.call_id) : null };
  }
  return { pending, reviewer, whole: false };
}

async function readTail(file, bytes) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8"), all: start === 0 };
  } finally {
    await handle.close();
  }
}

// onLater(ms): a request still too new to count, to look at again then (a
// request waiting on you writes nothing more to the file).
export async function codexWaitingApproval(
  file,
  { tails = [256 * 1024, 4 * 1024 * 1024], now = Date.now, settleMs = 10000, onLater } = {},
) {
  let found;
  try {
    // A long turn: read further back until its start (and its settings).
    for (const bytes of tails) {
      const { text, all } = await readTail(file, bytes);
      found = scan(text);
      if (found.whole || found.reviewer !== undefined || all) break;
    }
  } catch {
    return null;
  }
  const { pending, reviewer } = found;
  if (!pending || (reviewer && reviewer !== "user")) return null;
  // Just asked: a saved rule may be letting it run; only a request still
  // unanswered a while later is one the Codex app shows you.
  if (!Number.isFinite(pending.at)) return null;
  if (now() - pending.at < settleMs) {
    onLater?.(settleMs - (now() - pending.at));
    return null;
  }
  const why = JUSTIFICATION.exec(pending.call)?.[1];
  const command = COMMAND.exec(pending.call)?.[1];
  // callId names the request; match is the command its card shows, for
  // answering it from the phone (app-cards.mjs); since is when it asked, so
  // the list doesn't hold it back a second time.
  const ids = {
    ...(pending.callId ? { callId: pending.callId } : {}),
    ...(command ? { match: unescape(command) } : {}),
    since: pending.at,
  };
  if (why) return { kind: "permission", text: unescape(why), ...ids };
  return command
    ? { kind: "permission", text: unescape(command), command: true, ...ids }
    : { kind: "permission", text: "Codex asks to run a command outside its sandbox.", ...ids };
}
