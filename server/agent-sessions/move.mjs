// Continuing a chat with the other agent, as if it had been forked in the
// same app and carried on there. The new chat gets what the old one's agent
// knows so far, in the new agent's own native form:
// - Codex: history its model sees (thread/inject_items, verified: a thread
//   given a short history answered from it; the Codex app doesn't show it);
// - Claude Code: a transcript of its own, which `claude --resume` loads
//   (verified) and the Claude app lists once imported.
// Reach shows the old messages above the new ones (index.mjs read()).
// Nothing is ever too big to move: the newest messages go verbatim, older
// ones shorter, the oldest as the summary the agent wrote when it compacted,
// within the room the new agent has.
import fs from "node:fs";
import { randomUUID } from "node:crypto";

// Room for the moved history in the new agent's context, in characters
// (about 120k tokens): enough for the work at hand, with room to keep going.
export const MOVE_BUDGET = 480_000;
// Per call to Codex's thread/inject_items (one request each).
export const INJECT_BATCH = 120_000;

export const agentName = (agent) => (agent === "codex" ? "Codex" : agent === "claude" ? "Claude Code" : agent);

const oneLine = (text, max) => {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
// Long text keeps its start and end, with how much was left out between.
export const clipMiddle = (text, max) => {
  const value = String(text || "");
  if (value.length <= max) return value;
  const half = Math.max(0, Math.floor((max - 60) / 2));
  return `${value.slice(0, half)}\n… (${value.length - 2 * half} characters left out) …\n${value.slice(-half)}`;
};

// What a tool did, in one line (its output stays in the original chat).
function toolLine(item) {
  const what =
    item.kind === "command"
      ? `Ran \`${oneLine(item.text, 300)}\``
      : item.kind === "file-change"
        ? `Changed ${oneLine(item.text, 300)}`
        : item.kind === "web"
          ? `Looked up ${oneLine(item.text, 300)}`
          : `Used ${oneLine(item.text, 200)}`;
  const how = item.status === "failed" ? " (failed)" : item.status === "running" ? " (still running when the chat moved)" : "";
  return `• ${what}${how}`;
}

// Same-role turns next to each other become one (Claude Code's transcript
// alternates; Codex takes either).
function merge(turns) {
  const out = [];
  for (const t of turns) {
    if (!t.text) continue;
    const last = out.at(-1);
    if (last && last.role === t.role) last.text += `\n\n${t.text}`;
    else out.push({ ...t });
  }
  return out;
}

// The conversation as turns: what each side said, with tool use as short
// lines; within `budget` characters (see above), never refused.
export function moveTurns(items, { summary = "", from = "the other app", budget = MOVE_BUDGET } = {}) {
  const raw = [];
  let tools = [];
  const flush = () => {
    if (tools.length) raw.push({ role: "assistant", text: tools.join("\n") });
    tools = [];
  };
  for (const item of items || []) {
    if (item.role === "user" && item.kind === "text") {
      flush();
      const pictures = item.images ? `[${item.images} image${item.images > 1 ? "s" : ""}]` : "";
      raw.push({ role: "user", text: [item.text, pictures].filter(Boolean).join("\n") });
    } else if (item.role === "assistant" && item.kind === "text") {
      flush();
      raw.push({ role: "assistant", text: item.text });
    } else if (item.role === "tool") tools.push(toolLine(item));
  }
  flush();
  let turns = merge(raw);
  const head = [];
  let room = budget;
  if (summary) {
    const clipped = clipMiddle(summary, Math.floor(budget * 0.25));
    head.push({ role: "user", text: `Summary of the conversation before the messages below, written by ${from} when it compacted:\n\n${clipped}` });
    room -= head[0].text.length;
  }
  const size = (list) => list.reduce((n, t) => n + t.text.length, 0);
  if (size(turns) > room) {
    // The newest verbatim, then older ones shorter, then left out.
    const recent = [];
    let used = 0;
    let i = turns.length - 1;
    for (; i >= 0 && used + turns[i].text.length <= room * 0.75; i--) {
      used += turns[i].text.length;
      recent.unshift(turns[i]);
    }
    if (!recent.length && i >= 0) {
      // One message bigger than all the room: its start and end.
      recent.unshift({ ...turns[i], text: clipMiddle(turns[i].text, Math.floor(room * 0.75)) });
      used += recent[0].text.length;
      i--;
    }
    const older = [];
    for (; i >= 0; i--) {
      const t = turns[i];
      const short =
        t.role === "user"
          ? oneLine(t.text, 600)
          : oneLine(
              t.text
                .split("\n")
                .filter((l) => !l.startsWith("• "))
                .join("\n"),
              400,
            );
      if (!short) continue;
      if (used + short.length > room) break;
      used += short.length;
      older.unshift({ role: t.role, text: short });
    }
    const left = i + 1;
    if (left > 0)
      head.push({ role: "user", text: `[${left} earlier message${left > 1 ? "s are" : " is"} in the original chat in ${from}, not repeated here.]` });
    turns = [...older, ...recent];
  }
  return merge([...head, ...turns]);
}

// What the new agent is told about the move.
export function handoff({ from, title = "", cwd = "" }) {
  const where = [title && `“${oneLine(title, 120)}”`, cwd && `in ${cwd}`].filter(Boolean).join(", ");
  return (
    `This conversation was moved here from ${from}${where ? ` (${where})` : ""}. ` +
    `Everything before the next message happened there: what ${from} said and did, with each tool use in one line ` +
    `(its output isn't included; look at files again when you need the details). ` +
    `Continue it from where it left off, as if it had happened here.`
  );
}

// Codex: the turns as Responses API messages, in batches for inject_items.
export function codexHistoryItems(turns) {
  return turns.map((t) => ({
    type: "message",
    role: t.role,
    content: [{ type: t.role === "user" ? "input_text" : "output_text", text: t.text }],
  }));
}
export function batches(items, max = INJECT_BATCH) {
  const out = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const n = JSON.stringify(item).length;
    if (current.length && size + n > max) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length) out.push(current);
  return out;
}

// Claude Code: a transcript of its own (the shape of the lines Claude Code
// 2.1.28x writes), chained message to message, ending now. The note about
// the move opens the first message, which is always the person's.
export function claudeLines({ id, cwd, title = "", turns, note = "", version, model = "", gitBranch = "", now = Date.now() }) {
  const list = merge(turns);
  if (!list.length || list[0].role !== "user") list.unshift({ role: "user", text: note || "(continued)" });
  else if (note) list[0] = { ...list[0], text: `${note}\n\n${list[0].text}` };
  const base = { isSidechain: false, userType: "external", entrypoint: "sdk-cli", cwd, sessionId: id, version, gitBranch };
  const lines = [];
  if (title) lines.push({ type: "custom-title", customTitle: oneLine(title, 200), sessionId: id });
  let parent = null;
  list.forEach((t, n) => {
    const uuid = randomUUID();
    const timestamp = new Date(now - (list.length - n)).toISOString();
    lines.push(
      t.role === "user"
        ? { ...base, parentUuid: parent, type: "user", uuid, timestamp, message: { role: "user", content: t.text } }
        : {
            ...base,
            parentUuid: parent,
            type: "assistant",
            uuid,
            timestamp,
            message: {
              ...(model ? { model } : {}),
              id: `msg_${uuid.replace(/-/g, "")}`,
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: t.text }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
    );
    parent = uuid;
  });
  return lines;
}

// Which chats continued where: both ways, kept in Reach's data folder.
export function createMoves({ file = null, now = Date.now } = {}) {
  const valid = (m) =>
    m && typeof m === "object" && ["from", "to"].every((k) => typeof m[k]?.agent === "string" && typeof m[k]?.id === "string");
  let moves = [];
  if (file)
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) moves = saved.filter(valid);
    } catch {
      /* none yet */
    }
  const save = () => {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(moves), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const is = (end, agent, id) => end.agent === agent && end.id === id;
  return {
    add(move) {
      const saved = { ...move, at: now() };
      moves.push(saved);
      save();
      return saved;
    },
    // The move a chat came from, and the moves out of a chat.
    into: (agent, id) => moves.find((m) => is(m.to, agent, id)) || null,
    outOf: (agent, id) => moves.filter((m) => is(m.from, agent, id)),
  };
}
