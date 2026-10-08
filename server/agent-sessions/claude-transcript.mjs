// Turns a Claude Code transcript (one JSON object per line) into the
// conversation a person saw. Rules verified against real transcripts:
// - The visible history is the parentUuid chain ending at the last message;
//   other branches are superseded. At a compaction boundary the chain
//   continues through logicalParentUuid.
// - Results of parallel tool calls branch off the chain; they are attached to
//   their tool_use by id, wherever they sit in the file.
// - Messages typed while a turn runs are "queued_command" attachments.
// Nothing here executes or follows paths from the transcript.

import { repeatedImages, visibleUserText } from "./message-text.mjs";
import { partLabel, partLabels } from "./message-parts.mjs";

const clip = (text, max) => {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const half = Math.floor((max - 20) / 2);
  return `${value.slice(0, half)}\n… (${value.length - 2 * half} characters omitted) …\n${value.slice(-half)}`;
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b && b.type === "text")
          .map((b) => b.text)
          .join("\n")
      : "";
const relative = (file, cwd) =>
  cwd && typeof file === "string" && file.startsWith(`${cwd}/`)
    ? file.slice(cwd.length + 1)
    : file;

// The Claude app's own consent cards: letting Claude use apps (computer use)
// or a folder. They show in its window while the call waits, with no hook and
// no "waiting" in Claude Code's registry, so the waiting call is the sign.
const CONSENT = /^mcp__(?:computer[-_]use__(request_access|request_full_control|request_teach_access)|ccd_directory__(request_directory))$/;
const appNames = (apps) => (Array.isArray(apps) ? apps : []).map((a) => clip(String(a), 60)).filter(Boolean).slice(0, 8);
const appList = (apps) => {
  const names = appNames(apps);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "apps";
};
export function consentOf(name, input = {}) {
  const m = CONSENT.exec(String(name));
  if (!m) return null;
  const reason = clip(String(input.reason ?? ""), 400);
  // Worded as the app's card (verified for apps: "Allow Claude to use
  // Calculator?", then Deny or Allow for this session).
  switch (m[1] || m[2]) {
    case "request_access":
      return {
        kind: "apps",
        title: `Allow Claude to use ${appList(input.apps)}?`,
        reason,
        apps: appNames(input.apps),
        options: ["Deny", "Allow for this session"],
      };
    case "request_full_control":
      return { kind: "screen", title: "Allow Claude to take over the screen?", reason };
    case "request_teach_access":
      return { kind: "teach", title: `Allow Claude to guide you through ${appList(input.apps)}?`, reason, apps: appNames(input.apps) };
    default:
      return {
        kind: "folder",
        title: input.path ? `Allow Claude to access ${clip(String(input.path), 200)}?` : "Claude wants you to pick a folder",
        reason: "",
      };
  }
}

function toolItem(block, result, cwd) {
  const input = block.input || {};
  const consent = consentOf(block.name, input);
  if (consent)
    return {
      id: block.id,
      role: "tool",
      status: result ? (result.is_error ? "failed" : "completed") : "running",
      kind: "tool",
      text: consent.title,
      detail: result ? result.output : "",
      // Kept while the Claude app waits for an answer. Letting Claude use
      // apps (the card Reach knows word for word) can be answered from the
      // phone; its id names the request.
      ...(result ? {} : { consent: { ...consent, ...(consent.kind === "apps" ? { id: `consent:${block.id}` } : {}) } }),
    };
  const output = result ? result.output : "";
  const base = {
    id: block.id,
    role: "tool",
    status: result ? (result.is_error ? "failed" : "completed") : "running",
  };
  switch (block.name) {
    case "Bash":
      return { ...base, kind: "command", text: String(input.command ?? ""), detail: output };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return {
        ...base,
        kind: "file-change",
        text: relative(input.file_path ?? input.notebook_path ?? "", cwd),
        detail: editDiff(block.name, input, cwd) || (block.name === "Write" ? "Wrote file" : "Edited file"),
      };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { ...base, kind: "tool", text: block.name === "TaskCreate" ? `Added a task: ${String(input.subject ?? "")}`.trim() : "Updated the todo list" };
    case "Read":
      return { ...base, kind: "tool", text: `Read ${relative(input.file_path ?? "", cwd)}` };
    case "Grep":
    case "Glob":
      return { ...base, kind: "tool", text: `${block.name} ${input.pattern ?? ""}`.trim() };
    case "WebFetch":
      return { ...base, kind: "web", text: String(input.url ?? ""), detail: output };
    case "WebSearch":
      return { ...base, kind: "web", text: String(input.query ?? ""), detail: output };
    case "AskUserQuestion": {
      // Claude's question with its choices, kept while it waits for an answer.
      const questions = (Array.isArray(input.questions) ? input.questions : []).slice(0, 4).map((q) => ({
        question: clip(String(q?.question ?? ""), 600),
        header: clip(String(q?.header ?? ""), 40),
        multiSelect: !!q?.multiSelect,
        options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o) => ({
          label: clip(String(o?.label ?? ""), 120),
          description: clip(String(o?.description ?? ""), 400),
        })),
      }));
      return {
        ...base,
        kind: "tool",
        text: questions[0]?.question || "Asked a question",
        detail: output,
        ...(result ? {} : { questions }),
      };
    }
    case "Task":
    case "Agent":
      // A sub-agent: its status and what it's doing join from its own files
      // (subagents.mjs); a background one's call returns at once.
      return {
        ...base,
        kind: "agent",
        text: String(input.description ?? block.name),
        agentType: String(input.subagent_type || "general-purpose").slice(0, 60),
        background: input.run_in_background === true,
        detail: output,
      };
    default:
      return {
        ...base,
        kind: "tool",
        text: block.name,
        detail: block.detail ?? clip(JSON.stringify(input), 600),
      };
  }
}

// What the conversation shows of a tool call, and nothing bulkier (a Write's
// whole file, an Edit's old and new text): kept per line as it is read.
const KEEP = {
  Bash: ["command"],
  // What an edit changed, for its diff (cut short: a transcript can hold
  // whole files).
  Edit: ["file_path", "old_string", "new_string"],
  MultiEdit: ["file_path", "edits"],
  Write: ["file_path", "content"],
  // The todo list, as Claude keeps it.
  TodoWrite: ["todos"],
  TaskCreate: ["subject", "description", "activeForm"],
  TaskUpdate: ["taskId", "status", "subject", "activeForm"],
  NotebookEdit: ["notebook_path"],
  Read: ["file_path"],
  Grep: ["pattern"],
  Glob: ["pattern"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  AskUserQuestion: ["questions"],
  Task: ["description", "subagent_type", "run_in_background"],
  Agent: ["description", "subagent_type", "run_in_background"],
};
function slimToolUse(b) {
  const input = b.input && typeof b.input === "object" ? b.input : {};
  const keep = KEEP[b.name] || (consentOf(b.name, input) ? ["apps", "reason", "path"] : null);
  if (!keep) return { type: "tool_use", id: b.id, name: b.name, input: {}, detail: clip(JSON.stringify(input), 600) };
  const short = (v) => (typeof v === "string" ? clip(v, EDIT_MAX) : v);
  const kept = Object.fromEntries(keep.filter((k) => k in input).map((k) => [k, short(input[k])]));
  if (Array.isArray(kept.edits))
    kept.edits = kept.edits.slice(0, 30).map((e) => ({ old_string: short(e?.old_string ?? ""), new_string: short(e?.new_string ?? "") }));
  return { type: "tool_use", id: b.id, name: b.name, input: kept };
}
const EDIT_MAX = 12000;

// An edit as a unified diff, as Codex reports its own (the phone draws it
// and counts its lines).
export function editDiff(name, input = {}, cwd = "") {
  const file = String(input.file_path ?? input.notebook_path ?? "");
  const shown = relative(file, cwd) || "file";
  const lines = (text) => (String(text ?? "") === "" ? [] : String(text).replace(/\n$/, "").split("\n"));
  const hunk = (before, after) => [`@@`, ...lines(before).map((l) => `-${l}`), ...lines(after).map((l) => `+${l}`)];
  const body =
    name === "Write"
      ? hunk("", input.content)
      : name === "MultiEdit"
        ? (Array.isArray(input.edits) ? input.edits : []).flatMap((e) => hunk(e.old_string, e.new_string))
        : input.old_string !== undefined || input.new_string !== undefined
          ? hunk(input.old_string, input.new_string)
          : [];
  return body.length ? [`--- a/${shown}`, `+++ b/${shown}`, ...body].join("\n") : "";
}

// Claude's todo list as it stands after these calls: TodoWrite gives the
// whole list; TaskCreate adds one (its id in the result), TaskUpdate changes
// one. [{ id, text, status: pending|in_progress|completed }]
export function todoList(calls) {
  let list = [];
  const status = (s) => (["pending", "in_progress", "completed"].includes(s) ? s : "pending");
  for (const { name, input = {}, result } of calls) {
    if (name === "TodoWrite" && Array.isArray(input.todos))
      list = input.todos
        .filter((t) => t && typeof t.content === "string")
        .slice(0, 100)
        .map((t, i) => ({ id: String(t.id ?? i), text: clip(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content, 300), status: status(t.status) }));
    else if (name === "TaskCreate" && typeof input.subject === "string") {
      const id = String(String(result ?? "").match(/#?(\d+)/)?.[1] ?? list.length + 1);
      list = [...list.filter((t) => t.id !== id), { id, text: clip(input.subject, 300), status: "pending" }];
    } else if (name === "TaskUpdate" && input.taskId != null) {
      const id = String(input.taskId);
      if (input.status === "deleted") list = list.filter((t) => t.id !== id);
      else
        list = list.map((t) =>
          t.id === id ? { ...t, status: input.status ? status(input.status) : t.status, text: input.status === "in_progress" && input.activeForm ? clip(input.activeForm, 300) : input.subject ? clip(input.subject, 300) : t.text } : t,
        );
    }
  }
  return list;
}
// Claude Code records a slash command as <command-name>/x</command-name>
// <command-message>…</command-message><command-args>…</command-args>, and
// what it printed as <local-command-stdout>…</local-command-stdout>.
export function slashCommandOf(text) {
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(String(text || ""));
  if (!name) return "";
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() || "";
  return `/${name[1]}${args ? ` ${args}` : ""}`;
}
export function commandOutput(value) {
  const text = String(value ?? "");
  const parts = [...text.matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)(?:<\/local-command-(?:stdout|stderr)>|$)/g)].map((m) => m[1].trim());
  return (parts.length ? parts.filter(Boolean).join("\n\n") : text).replace(/\x1b\[[0-9;]*m/g, "").trim();
}
// The pictures a line holds: a message's, or those of one typed while Claude
// worked (a queued command keeps them in its prompt, not in a message).
export function imageBlocks(e) {
  const pieces = e?.type === "attachment" ? e.attachment?.prompt : e?.message?.content;
  return Array.isArray(pieces) ? pieces.filter((b) => b?.type === "image") : [];
}
const FIELDS = ["uuid", "parentUuid", "logicalParentUuid", "type", "subtype", "isSidechain", "isMeta", "isCompactSummary", "isApiErrorMessage", "error", "timestamp"];
// One transcript line as the conversation needs it; tool results go to
// `results` by their call's id (already cut to what's shown), images stay
// only as a count.
function slimEntry(e, results, maxOutput) {
  const out = {};
  for (const key of FIELDS) if (e[key] !== undefined) out[key] = e[key];
  // Who a user turn came from: a person, or Claude Code itself (a background
  // task's notice).
  if (typeof e.origin?.kind === "string") out.origin = { kind: e.origin.kind };
  // A command's output ("/context"), as Claude Code shows it under the command.
  if (e.type === "system" && e.subtype === "local_command") out.content = clip(String(e.content ?? ""), Math.max(maxOutput, 20000));
  if (e.type === "attachment") {
    const a = e.attachment || {};
    out.attachment = a.type === "queued_command" ? { type: a.type, humanTurn: a.humanTurn, prompt: a.prompt } : { type: a.type };
  }
  if (e.message && (e.type === "user" || e.type === "assistant")) {
    const content = e.message.content;
    let kept = content;
    if (Array.isArray(content)) {
      kept = [];
      for (const b of content) {
        if (!b) continue;
        if (b.type === "tool_result") {
          if (e.type === "user" && b.tool_use_id)
            results.set(b.tool_use_id, { is_error: !!b.is_error, output: clip(textOf(b.content) || String(b.content ?? ""), maxOutput) });
        } else if (b.type === "tool_use") kept.push(slimToolUse(b));
        else if (b.type === "text") kept.push({ type: "text", text: b.text });
        else if (b.type === "image") kept.push({ type: "image" });
        else if (e.type === "user" && partLabel(b)) kept.push({ type: "attachment", label: partLabel(b) });
      }
    }
    out.message = { content: kept, ...(e.message.model ? { model: e.message.model } : {}) };
    // Keep bounded usage on its own entry so rewinds and alternate branches
    // report the selected history, not whichever reply was last in the file.
    if (e.type === "assistant" && !e.isSidechain && e.message.usage && e.message.model !== "<synthetic>") {
      const u = e.message.usage;
      const used = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens]
        .reduce((sum, n) => sum + (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0), 0);
      if (used > 0 && Number.isFinite(used)) out.context = { used, window: /\[1m\]/i.test(e.message.model || "") ? 1000000 : null };
    }
  }
  return out;
}

// A transcript read as it grows: add() takes whole lines (more as they are
// written), view() is the conversation so far. Reading only what was
// appended keeps a 70 MB transcript of a working session from being parsed
// again on every change.
// Claude Code's notes of a background task's end, in the chat:
// <task-notification><task-id>…</task-id><tool-use-id>…</tool-use-id>
// <status>completed</status><summary>…</summary>… (verified with 2.1.291).
export function taskNotes(content) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (typeof b === "string" ? b : b?.text || "")).join("\n") : "";
  const notes = [];
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const all = (name) => [...m[1].matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((t) => t[1].trim());
    // One note can tell of several (agents stopped together).
    const ids = all("task-id");
    const calls = all("tool-use-id");
    const status = (all("status")[0] || "").toLowerCase();
    const summary = clip(all("summary")[0] || "", 300);
    ids.forEach((id, i) => {
      if (/^[\w-]{1,80}$/.test(id)) notes.push({ id, toolUseId: calls[i] || "", status, summary });
    });
  }
  return notes;
}

export function createClaudeTranscript({ maxOutput = 4000 } = {}) {
  const byId = new Map();
  const results = new Map();
  // Background sub-agents' ends, by agent id (subagents.mjs taskNotes).
  const tasks = new Map();
  // mode: the permission mode its latest message was sent in (Claude Code
  // writes it on each of your messages), to resume it in the same one.
  const meta = { title: "", cwd: "", gitBranch: "", entrypoint: "", sessionId: "", mode: "" };
  let last = null;
  let firstAt = null;
  let updatedAt = null;
  // Claude's usage as this session last saw it (see add()).
  let usage = null;
  // Where each line holding pictures sits in the file (when the reader is
  // told where its text starts), so one picture can be read back alone.
  const imageLines = new Map();
  return {
    add(source, { offset } = {}) {
      let position = Number.isFinite(offset) ? offset : null;
      for (const line of String(source).split("\n")) {
        const at = position;
        if (position !== null) position += Buffer.byteLength(line) + 1;
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue; /* A torn final line while the app is writing: skip it. */
        }
        if (!e || typeof e !== "object") continue;
        if (line.includes("<task-notification>"))
          for (const note of taskNotes(e.content ?? e.attachment?.prompt ?? e.message?.content))
            if (!tasks.has(note.id) || e.timestamp >= (tasks.get(note.id).timestamp || "")) tasks.set(note.id, { ...note, timestamp: e.timestamp || "" });
        if (e.type === "custom-title" && e.customTitle) meta.title = e.customTitle;
        if (e.cwd) meta.cwd = e.cwd;
        if (e.gitBranch) meta.gitBranch = e.gitBranch;
        if (e.type === "user" && typeof e.permissionMode === "string" && e.permissionMode) meta.mode = e.permissionMode;
        if (e.sessionId && !meta.sessionId) meta.sessionId = e.sessionId;
        if (e.entrypoint && !meta.entrypoint) meta.entrypoint = e.entrypoint;
        const slim = slimEntry(e, results, maxOutput);
        if (slim.uuid) byId.set(slim.uuid, slim);
        if (at !== null && slim.uuid && imageBlocks(slim).length)
          imageLines.set(slim.uuid, { offset: at, length: Buffer.byteLength(line) });
        // A command's output can be the newest message too.
        // So can a message typed while it works: the app shows it at once,
        // not when Claude next writes.
        const queued = slim.type === "attachment" && slim.attachment?.type === "queued_command" && slim.attachment.humanTurn;
        if (slim.uuid && (slim.type === "user" || slim.type === "assistant" || queued || (slim.type === "system" && slim.subtype === "local_command")) && !slim.isSidechain) last = slim;
        // Claude's usage as this session last saw it: a limit it hit (Claude
        // Code writes it here, with when the limit resets) or an answer since.
        if (e.type === "assistant" && e.timestamp) {
          const when = Date.parse(e.timestamp);
          const quota = e.quotaLimits;
          if (!Number.isFinite(when) || (usage && when < usage.at)) {
            /* older than what's known */
          } else if (e.isApiErrorMessage && e.error === "rate_limit" && quota?.status === "rejected" && Number.isFinite(quota.resetsAt))
            usage = { at: when, limited: true, resetsAt: quota.resetsAt * 1000, text: clip(textOf(e.message?.content).trim(), 300) };
          else if (!e.isApiErrorMessage && e.message?.model && e.message.model !== "<synthetic>") usage = { at: when, limited: false };
        }
        if (e.timestamp) {
          firstAt ??= e.timestamp;
          updatedAt = e.timestamp;
        }
      }
    },
    imageLine: (uuid) => imageLines.get(uuid) || null,
    // The entry before a message (where a rewind to it continues from).
    parentOf: (uuid) => byId.get(uuid)?.parentUuid ?? null,
    has: (uuid) => byId.has(uuid),
    // from: the conversation as it stood at that entry (a rewind waiting for
    // its next message); otherwise as it stands.
    view({ from = null } = {}) {
      const chain = [];
      const seen = new Set();
      for (let cur = from ? byId.get(from) : last; cur && !seen.has(cur.uuid); ) {
        seen.add(cur.uuid);
        chain.push(cur);
        cur = cur.parentUuid
          ? byId.get(cur.parentUuid)
          : cur.logicalParentUuid
            ? byId.get(cur.logicalParentUuid)
            : undefined;
      }
      chain.reverse();
      const items = [];
      // Todo list calls, in order (todoList).
      const todoCalls = [];
      let model = null; // the latest model that answered
      let firstUser = "";
      // What Claude remembers of the chat: its latest summary (written when it
      // compacted) and the items since (moving a chat carries this; move.mjs).
      let memory = null;
      let context = null;
      for (const e of chain) {
        if (e.context) context = e.context;
        const at = e.timestamp ? Date.parse(e.timestamp) : undefined;
        if (e.type === "system" && e.subtype === "compact_boundary") {
          items.push({ id: e.uuid, role: "system", kind: "compaction", text: "Context compacted", at });
        } else if (e.type === "system" && e.subtype === "local_command") {
          const output = commandOutput(e.content);
          if (output) items.push({ id: e.uuid, role: "system", kind: "output", text: output, at });
        } else if (e.type === "attachment") {
          const a = e.attachment || {};
          if (a.type === "queued_command" && a.humanTurn && a.prompt) {
            // Typed while it worked; with a picture, its words and pictures
            // come as pieces (it showed "[object Object],[object Object]").
            const pieces = Array.isArray(a.prompt) ? a.prompt : [{ type: "text", text: String(a.prompt) }];
            const raw = pieces.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
            const words = visibleUserText(raw);
            const pictures = pieces.filter((b) => b?.type === "image").length;
            const repeats = repeatedImages(raw);
            const attachments = partLabels(pieces);
            if (words || pictures || repeats || attachments.length)
              items.push({ id: e.uuid, role: "user", kind: "text", text: words, ...(pictures ? { images: pictures } : {}), ...(repeats ? { repeats } : {}), ...(attachments.length ? { attachments } : {}), queued: true, at });
          }
        } else if (e.type === "user") {
          if (e.isCompactSummary) {
            const summary = textOf(e.message?.content).trim();
            if (summary) memory = { summary, from: items.length };
            continue;
          }
          if (e.isMeta) continue;
          const content = e.message?.content;
          // Words as a string or pieces; anything else is no words at all
          // (an object showed as "[object Object]").
          const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
          // Without what an app put ahead of the person's words (the Claude
          // app's <system-reminder> when a chat moves into it).
          const said = blocks
            .filter((b) => b && b.type === "text" && typeof b.text === "string" && b.text)
            .map((b) => b.text)
            .join("\n");
          const text = visibleUserText(said);
          // Pictures the chat already had, sent as a note (image-repeats.mjs).
          const repeats = repeatedImages(said);
          const images = blocks.filter((b) => b?.type === "image").length;
          // A voice note or document it took as is (slimmed to its label).
          const attachments = blocks.map((b) => (b?.type === "attachment" ? b.label : partLabel(b))).filter(Boolean);
          // A background task's notice (a watcher reporting, a task ending) is
          // written as a user turn but isn't from you: as in the Claude app,
          // only text outside the notice shows, as a quiet line.
          if (e.origin?.kind === "task-notification") {
            const rest = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").trim();
            if (rest) items.push({ id: e.uuid, role: "system", kind: "notice", text: rest, at });
            continue;
          }
          // A slash command, as typed; its output, from older Claude Codes.
          const command = slashCommandOf(text);
          if (command) {
            items.push({ id: e.uuid, role: "user", kind: "text", text: command, slash: true, at });
            continue;
          }
          // Claude Code's mark where a turn was stopped (from Reach or the
          // app), written as a user turn: a quiet "Stopped", as Codex shows.
          if (/^\[Request interrupted by user( for tool use)?\]$/.test(text.trim()) && !images) {
            items.push({ id: e.uuid, role: "system", kind: "notice", text: "Stopped", at });
            continue;
          }
          if (/^\s*<local-command-(stdout|stderr)>/.test(text)) {
            const output = commandOutput(text);
            if (output) items.push({ id: e.uuid, role: "system", kind: "output", text: output, at });
            continue;
          }
          if (!text && !images && !repeats && !attachments.length) continue;
          if (!firstUser && text) firstUser = text;
          items.push({
            id: e.uuid,
            role: "user",
            kind: "text",
            text: text || "",
            ...(images ? { images } : {}),
            ...(repeats ? { repeats } : {}),
            ...(attachments.length ? { attachments } : {}),
            at,
          });
        } else if (e.type === "assistant" && e.isApiErrorMessage) {
          // API failures (sign-in, limits) show as an error card in the app.
          const content = Array.isArray(e.message?.content) ? e.message.content : [];
          const text = content
            .filter((b) => b?.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          items.push({
            id: `${e.uuid}:error`,
            role: "system",
            kind: "error",
            text: text || "Claude Code hit an error.",
            ...(e.error ? { detail: String(e.error) } : {}),
            at,
          });
        } else if (e.type === "assistant") {
          const content = Array.isArray(e.message?.content) ? e.message.content : [];
          if (e.message?.model && e.message.model !== "<synthetic>") model = e.message.model;
          // Ids by the block's place in its own message, never the chat's:
          // one item more or fewer above shifted every id after it, and the
          // phone dropped the older pages it held and redrew the rows.
          for (const [n, b] of content.entries()) {
            if (b?.type === "text" && b.text?.trim())
              items.push({ id: `${e.uuid}:${n}`, role: "assistant", kind: "text", text: b.text, at });
            else if (b?.type === "tool_use") {
              items.push({ ...toolItem(b, results.get(b.id), meta.cwd), at });
              if (b.name === "TodoWrite" || b.name === "TaskCreate" || b.name === "TaskUpdate")
                todoCalls.push({ name: b.name, input: b.input || {}, result: results.get(b.id)?.output });
            }
          }
        }
      }
      return {
        ...meta,
        model,
        title: meta.title || firstUser.split("\n")[0].slice(0, 120),
        // When the session started: matches it to an app process started
        // without --resume (see processes.mjs).
        firstAt: firstAt ? Date.parse(firstAt) : 0,
        updatedAt: updatedAt ? Date.parse(updatedAt) : 0,
        usage,
        ...(memory ? { memory } : {}),
        tasks: [...tasks.values()],
        todos: todoList(todoCalls),
        // Token usage cannot establish a model's capacity. Only explicit
        // capacity metadata permits a percentage; otherwise show the count.
        ...(context ? { context } : {}),
        items,
      };
    },
  };
}

export function parseClaudeTranscript(source, options) {
  const transcript = createClaudeTranscript(options);
  transcript.add(source);
  return transcript.view();
}
