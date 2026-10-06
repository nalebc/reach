// What a Codex chat that another engine holds (the Codex app, a terminal)
// waits on you for. That engine shows its approval card itself and tells no
// one else: nothing reaches the shared daemon and the chat's file has no
// "waiting" entry (verified 2026-10-05). But the file records the command
// asking for more permission, with Codex's question, as it's made, and its
// output only once it was answered and ran.
import fs from "node:fs/promises";

const ESCALATED = /["']?sandbox_permissions["']?\s*:\s*["']require_escalated["']/;
const JUSTIFICATION = /["']?justification["']?\s*:\s*"((?:[^"\\]|\\.)*)"/;
const COMMAND = /["']?(?:cmd|command)["']?\s*:\s*"((?:[^"\\]|\\.)*)"/;
const unescape = (s) => {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
};

export async function codexWaitingApproval(file, { tail = 256 * 1024 } = {}) {
  let text;
  try {
    const handle = await fs.open(file, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - tail);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const answered = new Set();
  for (const line of text.split("\n").reverse()) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // the cut first line, or one being written
    }
    // Where this turn began (or the last one ended): nothing older waits.
    if (e?.type === "event_msg" && (e.payload?.type === "task_started" || e.payload?.type === "task_complete")) return null;
    if (e?.type !== "response_item") continue;
    const p = e.payload || {};
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      answered.add(p.call_id);
      continue;
    }
    if ((p.type !== "function_call" && p.type !== "custom_tool_call") || answered.has(p.call_id)) continue;
    const call = String(p.arguments ?? p.input ?? "");
    if (!ESCALATED.test(call)) continue;
    const why = JUSTIFICATION.exec(call)?.[1];
    if (why) return { kind: "permission", text: unescape(why) };
    const command = COMMAND.exec(call)?.[1];
    return command
      ? { kind: "permission", text: unescape(command), command: true }
      : { kind: "permission", text: "Codex asks to run a command outside its sandbox." };
  }
  return null;
}
