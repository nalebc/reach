// Codex sessions through the shared daemon (see codex-daemon.mjs). Reading
// never loads a thread or touches its file (verified); sub-agent threads are
// not listed by the daemon and stay hidden here too.
import { codexSubagents, subagentStatus } from "./subagents.mjs";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { visibleUserText } from "./message-text.mjs";
import { codexWaitingApproval } from "./codex-asks.mjs";
import { codexUsage } from "./account-usage.mjs";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCKS = path.join(os.homedir(), ".codex", "thread-writer-locks");
const clip = (text, max) => {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const half = Math.floor((max - 20) / 2);
  return `${value.slice(0, half)}\n… (${value.length - 2 * half} characters omitted) …\n${value.slice(-half)}`;
};
const origins = {
  "Codex Desktop": "app",
  "codex-tui": "cli",
  codex_cli_rs: "cli",
  codex_exec: "cli",
  reach: "reach",
};

export function codexSession(thread) {
  const firstLine = visibleUserText(thread.preview || "").split("\n")[0];
  return {
    agent: "codex",
    id: thread.id,
    title: thread.name || firstLine.slice(0, 120) || "Untitled Codex session",
    cwd: thread.cwd || "",
    branch: thread.gitInfo?.branch || "",
    // Threads made through the shared daemon (Reach included) report the
    // daemon's own originator, "codex-tui", with source "vscode"; terminal
    // sessions have source "cli" (verified). Daemon threads live in the app.
    origin:
      thread.originator === "reach"
        ? "reach"
        : thread.source === "vscode" || thread.originator === "Codex Desktop"
          ? "app"
          : origins[thread.originator] || "cli",
    inApp: true, // Every daemon thread is listed in the Codex app (verified).
    updatedAt: (thread.updatedAt || thread.createdAt || 0) * 1000,
    createdAt: (thread.createdAt || 0) * 1000,
    // ThreadStatus: notLoaded | idle | systemError | active{activeFlags}.
    status:
      thread.status?.type === "active"
        ? thread.status.activeFlags?.some((f) => f === "waitingOnApproval" || f === "waitingOnUserInput")
          ? "waiting"
          : "running"
        : thread.status?.type === "systemError"
          ? "error"
          : "idle",
    preview: firstLine.slice(0, 200),
    archived: false,
    // `codex exec` runs: nobody to ask while they run.
    ...(thread.source === "exec" || thread.originator === "codex_exec" ? { headless: true } : {}),
  };
}

export function codexItem({ item, turnId, startedAtMs }, { maxOutput = 4000 } = {}) {
  const at = startedAtMs || undefined;
  switch (item?.type) {
    case "userMessage": {
      const text = visibleUserText((item.content || [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n"));
      const images = (item.content || []).filter((c) => c?.type === "image" || c?.type === "localImage").length;
      // Skills picked from "/" go with the message, as the Codex app shows them.
      const skills = (item.content || []).filter((c) => c?.type === "skill" && c.name).map((c) => String(c.name));
      return text || images || skills.length
        ? { id: item.id, role: "user", kind: "text", text, ...(images ? { images } : {}), ...(skills.length ? { skills } : {}), at, turnId }
        : null;
    }
    case "agentMessage": {
      // Async questions are message content, not a blocking server request.
      // Keep them even when Codex sends no accompanying prose.
      const questions = Array.isArray(item.questions) ? item.questions
        .filter((q) => typeof q?.title === "string" && q.title.trim())
        .map((q) => ({ title: q.title, options: (Array.isArray(q.options) ? q.options : []).filter((o) => typeof o === "string") })) : [];
      return item.text?.trim() || questions.length
        ? { id: item.id, role: "assistant", kind: "text", text: item.text || "", ...(questions.length ? { questions } : {}), at, turnId }
        : null;
    }
    case "commandExecution":
      return {
        id: item.id,
        role: "tool",
        kind: "command",
        text: String(item.command ?? ""),
        detail: clip(item.aggregatedOutput, maxOutput),
        status: item.status === "completed" ? (item.exitCode ? "failed" : "completed") : item.status,
        at,
        turnId,
      };
    case "fileChange":
      return {
        id: item.id,
        role: "tool",
        kind: "file-change",
        text: (item.changes || []).map((c) => c.path).join(", "),
        detail: clip((item.changes || []).map((c) => c.diff || "").join("\n"), maxOutput),
        status: item.status,
        at,
        turnId,
      };
    case "webSearch":
      return { id: item.id, role: "tool", kind: "web", text: String(item.query ?? ""), status: "completed", at, turnId };
    case "mcpToolCall":
      return {
        id: item.id,
        role: "tool",
        kind: "tool",
        text: `${item.server}: ${item.tool}`,
        ...(maxOutput === Infinity ? { detail: JSON.stringify({ arguments: item.arguments, result: item.result, error: item.error }) } : {}),
        status: item.status,
        at,
        turnId,
      };
    // Codex's own sub-agents (its collab tools): a spawn shows as the agent,
    // with its last known status; waits and messages to them as steps.
    case "collabAgentToolCall": {
      const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((t) => typeof t === "string") : [];
      const state = (ids.length && item.agentsStates?.[ids[0]]) || {};
      if (item.tool === "spawnAgent")
        return {
          id: item.id,
          role: "tool",
          kind: "agent",
          text: String(item.prompt || "Agent").split("\n")[0].slice(0, 200),
          agentType: String(item.model || "agent").slice(0, 60),
          background: true,
          ...(ids[0] ? { agentId: ids[0] } : {}),
          agentStatus: subagentStatus(state.status) || subagentStatus(item.status) || "running",
          detail: String(state.message || ""),
          status: item.status,
          at,
          turnId,
        };
      const words = { wait: "Waiting for agents", sendInput: "Told an agent", sendMessage: "Told an agent", followupTask: "Gave an agent more to do", resumeAgent: "Resumed an agent", closeAgent: "Closed an agent", interruptAgent: "Stopped an agent", listAgents: "Checked on agents" };
      return { id: item.id, role: "tool", kind: "tool", text: words[item.tool] || "Worked with agents", status: item.status, at, turnId };
    }
    case "contextCompaction":
      return { id: item.id, role: "system", kind: "compaction", text: "Context compacted", at, turnId };
    // /review: where it began, then what it found.
    case "enteredReviewMode":
      return { id: item.id, role: "system", kind: "notice", text: "Code review started", at, turnId };
    case "exitedReviewMode":
      return item.review?.trim()
        ? { id: item.id, role: "assistant", kind: "text", text: item.review, at, turnId }
        : { id: item.id, role: "system", kind: "notice", text: "Code review finished", at, turnId };
    default:
      return null; // reasoning and internal items stay hidden
  }
}

// The Codex app's permission modes and what each one sends (copied from the
// app's own table); "custom" leaves config.toml in charge.
export const CODEX_MODES = {
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" },
  "guardian-approvals": { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" },
  custom: {},
};

// The Codex app's permission menu, built from what Codex offers right now:
// its permission profiles (only those allowed here) and whether "Approve for
// me" (the guardian reviewer) is switched on. A profile Codex adds later shows
// under its own name. Names and notes are the Codex app's.
const PROFILE_MODES = {
  ":workspace": [
    { id: "auto", label: "Ask for approval", note: "Always ask to edit external files and use the internet" },
    { id: "guardian-approvals", label: "Approve for me", note: "Only ask for actions detected as potentially unsafe", guardian: true },
  ],
  ":danger-full-access": [{ id: "full-access", label: "Full access", note: "" }],
  ":read-only": [{ id: "read-only", label: "Read only", note: "" }],
};
const named = (id) => {
  const words = String(id).replace(/^:/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(id);
};
// The app's order: the workspace's two, full access, read only, then others.
const ORDER = Object.keys(PROFILE_MODES);
export function codexModes(profiles = [], { guardian = true } = {}) {
  const rank = (p) => (ORDER.includes(p.id) ? ORDER.indexOf(p.id) : ORDER.length);
  const modes = [];
  for (const p of [...profiles].filter((p) => p?.id && p.allowed !== false).sort((a, b) => rank(a) - rank(b))) {
    const known = PROFILE_MODES[p.id];
    if (known) modes.push(...known.filter((m) => guardian || !m.guardian).map(({ guardian: _, ...m }) => m));
    else modes.push({ id: `profile:${p.id}`, label: named(p.id), note: p.description || "" });
  }
  return modes;
}

// A thread's permissions as the Codex app saved them, named like its menu.
export function codexMode(p) {
  if (!p) return null;
  const profile = p.activePermissionProfile?.id;
  if (p.approvalPolicy === "never" && profile === ":danger-full-access") return "full-access";
  if (p.approvalsReviewer === "auto_review" || p.approvalsReviewer === "guardian_subagent") return "guardian-approvals";
  if (profile === ":read-only") return "read-only";
  if (profile === ":workspace" && p.approvalPolicy === "on-request") return "auto";
  // Preserve named profiles exactly as the model catalog offers them. Calling
  // every named profile "custom" drops its identity when building the next turn.
  if (typeof profile === "string" && /^:?[\w.-]+$/.test(profile) &&
      !ORDER.includes(profile) && p.approvalPolicy === "on-request" &&
      (!p.approvalsReviewer || p.approvalsReviewer === "user")) return `profile:${profile}`;
  return "custom";
}

// The Codex app's saved choices: its mode for new chats and each thread's
// permissions. Best effort: the file is the app's own.
const APP_STATE = path.join(os.homedir(), ".codex", ".codex-global-state.json");
export function codexAppState(file = APP_STATE) {
  let cached = null;
  return () => {
    try {
      const { mtimeMs } = fs.statSync(file);
      if (cached?.mtimeMs !== mtimeMs) {
        const atoms = JSON.parse(fs.readFileSync(file, "utf8"))["electron-persisted-atom-state"] || {};
        cached = {
          mtimeMs,
          mode: atoms["agent-mode-by-host-id"]?.local || null,
          threads: atoms["heartbeat-thread-permissions-by-id"] || {},
        };
      }
      return cached;
    } catch {
      return { mode: null, threads: {} };
    }
  };
}

// The apps write "GPT-6 Astra" for the catalog's "GPT-6-Astra".
export const modelName = (name) => String(name || "").replace(/^(GPT-[\d.]+)-/i, "$1 ");

// Failed or stopped turns show where they happened, as in the Codex app. The
// last item of an older page may belong to a turn that continues in the
// newer page, so no marker is placed after it.
export function withTurnNotes(items, turns, { olderPage = false, runningTurn = null } = {}) {
  const info = new Map((turns || []).map((t) => [t.id, t]));
  const out = [];
  items.forEach((item, i) => {
    out.push(item);
    const next = items[i + 1];
    if (!item.turnId || item.turnId === runningTurn || next?.turnId === item.turnId || (olderPage && !next)) return;
    const turn = info.get(item.turnId);
    if (turn?.status === "failed" && turn.error?.message)
      out.push({
        id: `${item.turnId}:error`,
        role: "system",
        kind: "error",
        text: turn.error.message,
        ...(turn.error.codexErrorInfo ? { detail: String(turn.error.codexErrorInfo) } : {}),
        turnId: item.turnId,
      });
    else if (turn?.status === "interrupted")
      out.push({ id: `${item.turnId}:stopped`, role: "system", kind: "notice", text: "Stopped", turnId: item.turnId });
  });
  return out;
}

// Which engine holds a thread right now. A hint for the phone ("open in the
// Codex app"); sending finds out for real. Codex removes the lock file when
// it lets go (verified), so most threads cost one stat.
export async function codexHolder(id, { run = exec, locks = LOCKS } = {}) {
  if (!UUID.test(id) || !fs.existsSync(path.join(locks, `${id}.lock`))) return null;
  try {
    // Only Codex's own processes can hold it (the app's, its daemon, a
    // terminal's): lsof asked about those few, not about every process on the
    // Mac (0.3-2.6 s on each read of an open Codex chat; this ~40 ms).
    const { stdout: found } = await run("/usr/bin/pgrep", ["-i", "-f", "codex"], { timeout: 4000 });
    const pids = String(found).split("\n").filter((p) => /^\d+$/.test(p.trim())).map((p) => p.trim());
    if (!pids.length) return null;
    const { stdout } = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","), "-Fp", path.join(locks, `${id}.lock`)], { timeout: 4000 });
    const pid = stdout.match(/^p(\d+)/m)?.[1];
    if (!pid) return null;
    const { stdout: own } = await run("/bin/ps", ["-o", "ppid=,tty=,command=", "-p", pid], { timeout: 4000 });
    const [, ppid, tty, command] = own.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/) || [];
    if (/app-server-daemon/.test(command || "")) return "daemon";
    const { stdout: parent } = await run("/bin/ps", ["-o", "command=", "-p", ppid], { timeout: 4000 });
    if (/ChatGPT\.app\/Contents\/MacOS\//.test(parent)) return "codex-app";
    return tty && tty !== "??" ? "terminal" : "other";
  } catch {
    return null; // lsof exits 1 when nothing holds the file
  }
}

// Threads the Codex app (or a terminal) is running read "notLoaded" from the
// daemon. For recently active threads another engine holds, the latest turn
// on disk says it: no end time means it's still running there (verified).
// One check per thread every few seconds, a handful at a time.
export function codexRunningElsewhere({
  daemon,
  locks = LOCKS,
  now = Date.now,
  // The list is rebuilt when something changes, not on a beat: keep a
  // thread's answer only briefly.
  ttl = 1000,
  recent = 15 * 60 * 1000,
  max = 6,
  waiting = codexWaitingApproval,
}) {
  const cache = new Map(); // id -> { at, running, asking, since }
  // `files`: each thread's file, where a running one shows it waits on you.
  // onLater(ms, id): a request too new to count yet, to look at again then.
  return async (sessions, files = new Map(), { onLater } = {}) => {
    const due = sessions
      .filter((s) => s.status === "idle" && now() - s.updatedAt < recent && fs.existsSync(path.join(locks, `${s.id}.lock`)))
      .slice(0, max);
    await Promise.all(
      due.map(async (s) => {
        const hit = cache.get(s.id);
        if (!hit || now() - hit.at > ttl) {
          const r = await daemon
            .rpc("thread/turns/list", { threadId: s.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
            .catch(() => null);
          const turn = r?.data?.[0];
          const running = !!turn && !turn.completedAt && ["inProgress", "interrupted"].includes(turn.status);
          const file = files.get(s.id);
          const asked = running && file ? await waiting(file, { onLater: (ms) => onLater?.(ms, s.id) }).catch(() => null) : null;
          cache.set(s.id, { at: now(), running, asking: !!asked, since: asked?.since });
        }
        const { running, asking, since } = cache.get(s.id);
        if (running) s.status = asking ? "waiting" : "running";
        // Since when, from its file: the list doesn't hold it back again.
        if (running && asking && since) s.waitingSince = since;
      }),
    );
    return sessions;
  };
}

// A picture sent in a Codex chat, as its message holds it: inline (a data
// URL) or a file on this Mac (Reach's uploads, the Codex app's attachments).
// Only an image's own bytes, never another file a path might name.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export function sniffImage(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
export async function codexImageData(source, { readFile = fs.promises.readFile, stat = fs.promises.stat, maxBytes = 25 * 1024 * 1024 } = {}) {
  let data = null;
  if (source?.type === "image" && typeof source.url === "string") {
    const m = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(source.url);
    if (m && IMAGE_TYPES.includes(m[1])) data = Buffer.from(m[2], "base64");
  } else if (source?.type === "localImage" && typeof source.path === "string" && path.isAbsolute(source.path)) {
    const info = await stat(source.path).catch(() => null);
    if (info?.isFile() && info.size <= maxBytes) data = await readFile(source.path).catch(() => null);
  }
  const type = data && data.length <= maxBytes ? sniffImage(data) : null;
  return type ? { type, data } : null;
}

export function createCodexSessions({
  daemon,
  holder = codexHolder,
  appState = codexAppState(),
  runningElsewhere = codexRunningElsewhere({ daemon }),
  waitingApproval = codexWaitingApproval,
}) {
  // Told when a thread's request is too new to count yet (codex-asks.mjs).
  const later = new Set();
  const tellLater = (ms, id) => {
    for (const listener of later) listener(ms, id);
  };
  const sentImages = new Map(); // "thread:item" → its pictures, as read last
  const imageSources = (item) => (item.content || []).filter((c) => c?.type === "image" || c?.type === "localImage");
  const legacyEntries = (thread) => (thread.turns || []).flatMap(turn => (turn.items || []).map(item => ({ item, turnId: turn.id, startedAtMs: (turn.startedAt || thread.createdAt || 0) * 1000 })));
  return {
    // A thread to look at again in ms (a request still settling).
    onLater(listener) {
      later.add(listener);
      return () => later.delete(listener);
    },
    // The mode the Codex app's composer is in now; its next message uses it.
    appMode: () => appState().mode || null,
    // The Codex app's projects (its sidebar), each with its folders.
    async projects() {
      const r = await daemon.rpc("project/list", {});
      return (r.data || []).map((p) => ({
        id: p.id,
        name: p.name || "",
        roots: (p.roots || []).map((root) => root.path).filter(Boolean),
      }));
    },
    async list({ pages = 10 } = {}) {
      const threads = [];
      let cursor = null;
      let page = 0;
      do {
        const r = await daemon.rpc("thread/list", { limit: 50, cursor });
        threads.push(...(r.data || []));
        cursor = r.nextCursor;
      } while (cursor && ++page < pages);
      return runningElsewhere(
        threads.map(codexSession),
        new Map(threads.filter((t) => t.path).map((t) => [t.id, t.path])),
        { onLater: tellLater },
      );
    },
    // Archived (or back) in Codex itself, as its app's Archive does: the
    // thread leaves thread/list, here and in the Codex app alike.
    async archive(id, archived = true) {
      if (!UUID.test(id)) throw Object.assign(new Error("Unknown session."), { status: 404 });
      await daemon.rpc(archived ? "thread/archive" : "thread/unarchive", { threadId: id });
      return { archived };
    },
    // A picture sent in a chat, by its message and place in it (n).
    async image(id, itemId, n) {
      const missing = () => Object.assign(new Error("That picture isn't in this session."), { status: 404 });
      if (!UUID.test(id) || typeof itemId !== "string" || !itemId || itemId.length > 200 || !Number.isInteger(n) || n < 0) throw missing();
      let sources = sentImages.get(`${id}:${itemId}`);
      if (!sources) {
        const { thread } = await daemon.rpc("thread/read", { threadId: id, includeTurns: false });
        if (thread?.historyMode === "legacy") {
          const full = await daemon.rpc("thread/read", { threadId: id, includeTurns: true });
          const found = legacyEntries(full.thread).find(e => e.item.type === "userMessage" && e.item.id === itemId);
          sources = found ? imageSources(found.item) : [];
        }
      }
      // Old attachments matter too when exporting a complete conversation.
      const visited = new Set();
      for (let cursor = null; !sources;) {
        if (visited.has(cursor)) throw new Error("Codex repeated an image history page.");
        visited.add(cursor);
        const r = await daemon.rpc("thread/items/list", { threadId: id, limit: 200, sortDirection: "desc", cursor });
        const found = (r.data || []).find((e) => e?.item?.type === "userMessage" && e.item.id === itemId);
        if (found) sources = imageSources(found.item);
        if (!(cursor = r.nextCursor)) break;
      }
      const image = sources?.[n] ? await codexImageData(sources[n]) : null;
      if (!image) throw missing();
      return image;
    },
    async read(id, { cursor = null, before = null, limit = 200, maxOutput = 4000 } = {}) {
      if (!UUID.test(id)) throw Object.assign(new Error("Unknown session."), { status: 404 });
      cursor ??= before;
      const { thread } = await daemon.rpc("thread/read", { threadId: id, includeTurns: false });
      const legacy = thread?.historyMode === "legacy" ? (await daemon.rpc("thread/read", { threadId: id, includeTurns: true })).thread : null;
      const all = legacy ? legacyEntries(legacy) : null;
      const end = all ? (cursor == null ? all.length : Math.max(0, Math.min(Number(cursor) || 0, all.length))) : 0;
      const start = Math.max(0, end - Math.min(Math.max(limit, 1), 500));
      const [r, turns, held] = await Promise.all([
        all ? { data: all.slice(start, end).reverse(), nextCursor: start ? String(start) : null } : daemon.rpc("thread/items/list", {
          threadId: id,
          limit: Math.min(Math.max(limit, 1), 500),
          sortDirection: "desc",
          cursor,
        }),
        // Turn status and errors come from the thread's file, so they are
        // known even while another engine runs it.
        legacy ? { data: [...(legacy.turns || [])].reverse() } : daemon
          .rpc("thread/turns/list", { threadId: id, limit: 40, sortDirection: "desc", itemsView: "notLoaded" })
          .catch(() => null),
        cursor ? null : holder(id),
      ]);
      // Where each sent picture is, for the phone to ask for it (image()).
      for (const entry of r.data || [])
        if (entry?.item?.type === "userMessage" && imageSources(entry.item).length) {
          sentImages.set(`${id}:${entry.item.id}`, imageSources(entry.item));
          if (sentImages.size > 500) sentImages.delete(sentImages.keys().next().value);
        }
      const items = (r.data || [])
        .map((entry) => codexItem(entry, { maxOutput }))
        .filter(Boolean)
        .reverse();
      const session = codexSession(thread);
      // Its sub-agents as Codex last reported them (this page of the chat).
      session.subagents = codexSubagents((r.data || []).map((entry) => entry?.item).reverse());
      session.model = thread.model || null;
      session.effort = thread.reasoningEffort || null;
      session.speed = thread.serviceTier || null;
      session.held = held;
      // The Codex app's composer shows (and its next message uses) the app's
      // current mode, not a thread's own; scheduled runs keep theirs apart.
      session.mode = appState().mode || codexMode(appState().threads[id]);
      // A turn another engine is running reads from its file as
      // "interrupted" with no end time (verified with the Codex app).
      const latest = turns?.data?.[0];
      const runningTurn =
        latest &&
        !latest.completedAt &&
        (latest.status === "inProgress" || (latest.status === "interrupted" && held && held !== "daemon"))
          ? latest.id
          : null;
      if (runningTurn && session.status === "idle") session.status = "running";
      // Held by another engine (the Codex app, a terminal) and asking you
      // there: what it asks, read from the chat's file (that engine tells no
      // one else). Said here, answered there.
      if (runningTurn && held && held !== "reach" && thread.path) {
        const asked = await waitingApproval(thread.path, { onLater: (ms) => tellLater(ms, id) }).catch(() => null);
        if (asked) {
          const { since, ...asking } = asked;
          session.status = "waiting";
          if (since) session.waitingSince = since;
          // The Codex app's card can be answered from the phone (Allow once
          // or Deny, app-cards.mjs): its id names this request.
          session.asking =
            held === "codex-app" && asking.callId && asking.match
              ? { ...asking, id: `app-permission:codex:${asking.callId}` }
              : asking;
        }
      }
      return {
        session,
        items: withTurnNotes(items, turns?.data, { olderPage: !!cursor, runningTurn }),
        before: r.nextCursor || null,
      };
    },
    // Models, efforts and permission modes as Codex offers them now, and the
    // mode the Codex app starts new chats in.
    async models() {
      const [r, profiles, features] = await Promise.all([
        daemon.rpc("model/list", {}),
        daemon.rpc("permissionProfile/list", {}).catch(() => null),
        daemon.rpc("experimentalFeature/list", {}).catch(() => null),
      ]);
      const saved = appState().mode;
      const guardian = (features?.data || []).find((f) => f.name === "guardian_approval");
      const modes = profiles?.data
        ? codexModes(profiles.data, { guardian: guardian ? !!guardian.enabled : true })
        : codexModes([{ id: ":workspace" }, { id: ":danger-full-access" }, { id: ":read-only" }]);
      return {
        models: (r.data || [])
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.id,
            name: modelName(m.displayName || m.id),
            description: m.description || "",
            efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
            effortNotes: Object.fromEntries(
              (m.supportedReasoningEfforts || []).filter((e) => e.description).map((e) => [e.reasoningEffort, e.description]),
            ),
            defaultEffort: m.defaultReasoningEffort || null,
            images: (m.inputModalities || ["text", "image"]).includes("image"),
            isDefault: !!m.isDefault,
            speeds: (m.serviceTiers || []).map((t) => ({ id: t.id, name: t.name || t.id, note: t.description || "" })),
            defaultSpeed: m.defaultServiceTier || null,
          })),
        modes: [...modes, { id: "custom", label: "Custom (config.toml)", note: "Uses permissions defined in config.toml" }],
        mode: modes.some((m) => m.id === saved) || saved === "custom" ? saved : modes[0]?.id || "auto",
      };
    },
    async health() {
      const account = await daemon.rpc("account/read", {});
      if (!account.account) return { agent: "codex", installed: true, signedIn: false };
      const limits = await daemon.rpc("account/rateLimits/read", {}).catch(() => null);
      const primary = limits?.rateLimits?.primary;
      return {
        agent: "codex",
        installed: true,
        signedIn: true,
        usable: limits ? limits.ordinaryUsageAllowed !== false : true,
        resetsAt: primary?.resetsAt ? primary.resetsAt * 1000 : null,
        usedPercent: primary?.usedPercent ?? null,
        usage: codexUsage(limits),
        // Free rate-limit resets the account holds (the app's "Reset usage").
        resetCredits: limits?.rateLimitResetCredits?.availableCount || 0,
      };
    },
    // Spends one rate-limit reset, as the Codex app's "Reset usage" does.
    // reset | nothingToReset | noCredit | alreadyRedeemed.
    async resetUsage() {
      const r = await daemon.rpc("account/rateLimitResetCredit/consume", { idempotencyKey: crypto.randomUUID() });
      return { outcome: r?.outcome || "reset" };
    },
  };
}
