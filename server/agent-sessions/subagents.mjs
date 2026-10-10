// Sub-agents a chat started, as the phone shows them: what each is, whether
// it still runs, what it's doing now, and what it found.
//
// Claude Code keeps each one's files beside the chat's (verified with
// 2.1.291): <project>/<session>/subagents/agent-<id>.meta.json
// ({ agentType, description, toolUseId, requestShape }) and agent-<id>.jsonl
// (its own transcript). A background one's end is a <task-notification> in
// the chat (claude-transcript.mjs taskNotes); a foreground one ends with its
// Agent call's result. Codex reports its own (collabAgentToolCall items, with
// each agent's status: codexSubagents).
// Anything missing or reshaped means fewer details, never an error.
import fs from "node:fs/promises";
import path from "node:path";

const clip = (text, max) => {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const ID = /^[\w-]{1,80}$/;
// A sub-agent's files untouched this long, with no end noted: it went quiet
// (its chat's process ended with it, say).
export const QUIET_MS = 10 * 60 * 1000;
const TAIL_BYTES = 96 * 1024;

const STATUS = {
  completed: "done",
  done: "done",
  failed: "failed",
  error: "failed",
  errored: "failed",
  stopped: "stopped",
  killed: "stopped",
  cancelled: "stopped",
  interrupted: "stopped",
  shutdown: "stopped",
  running: "running",
  pendinginit: "running",
  inprogress: "running",
};
export const subagentStatus = (value) => STATUS[String(value || "").toLowerCase().replace(/[^a-z]/g, "")] || null;

// What a tool call is doing, in a few words.
export function doing(name, input = {}) {
  const file = (p) => path.basename(String(p || "")) || "a file";
  switch (name) {
    case "Bash":
      return `Running ${clip(String(input.command || "").split("\n")[0], 60)}`;
    case "Read":
      return `Reading ${file(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `Editing ${file(input.file_path || input.notebook_path)}`;
    case "Grep":
    case "Glob":
      return input.pattern ? `Searching ${clip(input.pattern, 40)}` : "Searching";
    case "WebFetch":
    case "WebSearch":
      return "Searching the web";
    case "Task":
    case "Agent":
      return `Started ${clip(input.description || "an agent", 50)}`;
    default:
      return name ? `Using ${clip(String(name).replace(/^mcp__/, "").replace(/__/g, " "), 40)}` : "";
  }
}

// The end of a sub-agent's transcript: what it did last, its last words.
async function tail(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift(); // cut mid-line
    let activity = "";
    let said = "";
    let startedAt = 0;
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!startedAt && e?.timestamp) startedAt = Date.parse(e.timestamp) || 0;
      if (e?.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
      for (const b of e.message.content) {
        if (b?.type === "tool_use") activity = doing(b.name, b.input || {});
        else if (b?.type === "text" && b.text?.trim()) {
          said = b.text;
          activity = "Writing";
        }
      }
    }
    return { activity, said, startedAt: length === size ? startedAt : 0 };
  } catch {
    return { activity: "", said: "", startedAt: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The agent-<id>.meta.json / .jsonl pairs in one folder; null if it can't
// be read.
async function agentFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const agents = [];
  for (const name of names) {
    const id = name.match(/^agent-([\w-]{1,80})\.meta\.json$/)?.[1];
    if (!id) continue;
    let meta = {};
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) || {};
    } catch {}
    const log = path.join(dir, `agent-${id}.jsonl`);
    let updatedAt = 0;
    let createdAt = 0;
    try {
      const st = await fs.stat(log);
      updatedAt = st.mtimeMs;
      createdAt = st.birthtimeMs || 0;
    } catch {}
    agents.push({ id, meta, log, updatedAt, createdAt });
  }
  return agents;
}

// A chat's workflow runs, newest first (at most ten).
async function runs(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID.test(e.name)) continue;
    const full = path.join(dir, e.name);
    const st = await fs.stat(full).catch(() => null);
    if (st) found.push({ full, at: st.mtimeMs });
  }
  return found.sort((a, b) => b.at - a.at).slice(0, 10).map((r) => r.full);
}

// Which of a workflow's agents ended, and how, from its journal: its
// "result" entry (Claude Code 2.1.295), or an entry naming it with a status
// word Reach knows. Anything else leaves the agent running (and quiet once
// its files stop changing).
async function journalEnds(file) {
  const ends = new Map();
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return ends;
  }
  for (const line of text.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e?.agentId !== "string" || !ID.test(e.agentId)) continue;
    const status = e.type === "result" ? "done" : subagentStatus(e.type) || subagentStatus(e.status);
    if (status && status !== "running") ends.set(e.agentId, status);
  }
  return ends;
}

// A Claude Code chat's sub-agents, newest first. notes: its task
// notifications ({ id, toolUseId, status, summary }); items: its Agent calls
// (kind "agent"), for foreground ones' ends.
export async function claudeSubagents({ transcript, sessionId, notes = [], items = [], now = Date.now(), limit = 50 }) {
  if (typeof transcript !== "string" || !ID.test(String(sessionId || ""))) return [];
  const dir = path.join(path.dirname(transcript), sessionId, "subagents");
  const agents = await agentFiles(dir);
  if (!agents) return [];
  // A workflow's agents sit one level down, a folder per run, with the run's
  // journal saying which ended (subagents/workflows/<run>/journal.jsonl).
  const ended = new Map();
  for (const run of await runs(path.join(dir, "workflows"))) {
    const found = await agentFiles(run);
    if (!found?.length) continue;
    for (const [id, status] of await journalEnds(path.join(run, "journal.jsonl"))) ended.set(id, status);
    agents.push(...found.map((a) => ({ ...a, workflow: true })));
  }
  const byNote = new Map(notes.map((n) => [n.id, n]));
  const calls = new Map(items.filter((i) => i?.kind === "agent").map((i) => [i.id, i]));
  agents.sort((a, b) => b.updatedAt - a.updatedAt);
  const out = [];
  for (const a of agents.slice(0, limit)) {
    const toolUseId = typeof a.meta.toolUseId === "string" ? a.meta.toolUseId : null;
    const call = toolUseId ? calls.get(toolUseId) : null;
    const background = a.meta.requestShape === "background" || !!call?.background;
    const note = byNote.get(a.id);
    let status = subagentStatus(note?.status) || ended.get(a.id) || null;
    // A foreground one ends with its call's result.
    if (!status && call && !background && call.status !== "running") status = call.status === "failed" ? "failed" : "done";
    status ||= "running";
    const { activity, said, startedAt } = await tail(a.log);
    const quiet = status === "running" && a.updatedAt && now - a.updatedAt > QUIET_MS;
    out.push({
      id: a.id,
      toolUseId,
      name: clip(a.meta.description || call?.text || "Agent", 120),
      // A workflow's agent: not a task stop_task can end.
      ...(a.workflow ? { workflow: true } : {}),
      ...(typeof a.meta.workflowPhase === "string" && a.meta.workflowPhase ? { phase: clip(a.meta.workflowPhase, 60) } : {}),
      type: clip(a.meta.agentType || call?.agentType || "general-purpose", 60),
      background,
      status: quiet ? "quiet" : status,
      activity: status === "running" ? clip(activity, 100) : "",
      result: status === "running" ? "" : clip(said || note?.summary || "", 1200),
      startedAt: startedAt || a.createdAt || 0,
      updatedAt: Math.round(a.updatedAt) || 0,
    });
  }
  return out;
}

// Codex's sub-agents, from its own items: each spawnAgent call names the
// agents it started (receiverThreadIds), with their last known status.
export function codexSubagents(items = []) {
  const out = new Map();
  for (const item of items) {
    if (item?.type !== "collabAgentToolCall") continue;
    const states = item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {};
    const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      const known = out.get(id);
      const state = states[id] || {};
      const status = subagentStatus(state.status) || (item.tool === "spawnAgent" ? subagentStatus(item.status) : null);
      if (item.tool === "spawnAgent" || !known)
        out.set(id, {
          id,
          toolUseId: item.id,
          name: clip(known?.name || item.prompt || "Agent", 120),
          type: clip(item.model || known?.type || "agent", 60),
          background: true,
          status: status || known?.status || "running",
          activity: "",
          result: clip(state.message || known?.result || "", 1200),
          startedAt: known?.startedAt || 0,
          updatedAt: 0,
        });
      else if (status) out.set(id, { ...known, status, result: clip(state.message || known.result, 1200) });
    }
  }
  return [...out.values()].reverse();
}
