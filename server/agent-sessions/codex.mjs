// Codex sessions through the shared daemon (see codex-daemon.mjs). Reading
// never loads a thread or touches its file (verified); sub-agent threads are
// not listed by the daemon and stay hidden here too.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  const firstLine = String(thread.preview || "").split("\n")[0];
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
  };
}

export function codexItem({ item, turnId, startedAtMs }, { maxOutput = 4000 } = {}) {
  const at = startedAtMs || undefined;
  switch (item?.type) {
    case "userMessage": {
      const text = (item.content || [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
      const images = (item.content || []).filter((c) => c?.type !== "text").length;
      return { id: item.id, role: "user", kind: "text", text, ...(images ? { images } : {}), at, turnId };
    }
    case "agentMessage":
      return item.text?.trim()
        ? { id: item.id, role: "assistant", kind: "text", text: item.text, at, turnId }
        : null;
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
        status: item.status,
        at,
        turnId,
      };
    case "contextCompaction":
      return { id: item.id, role: "system", kind: "compaction", text: "Context compacted", at, turnId };
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

// A thread's permissions as the Codex app saved them, named like its menu.
export function codexMode(p) {
  if (!p) return null;
  const profile = p.activePermissionProfile?.id;
  if (p.approvalPolicy === "never" && profile === ":danger-full-access") return "full-access";
  if (p.approvalsReviewer === "auto_review" || p.approvalsReviewer === "guardian_subagent") return "guardian-approvals";
  if (profile === ":read-only") return "read-only";
  if (profile === ":workspace" && p.approvalPolicy === "on-request") return "auto";
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
    const { stdout } = await run("/usr/sbin/lsof", ["-nP", "-Fp", path.join(locks, `${id}.lock`)], { timeout: 4000 });
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
export function codexRunningElsewhere({ daemon, locks = LOCKS, now = Date.now, ttl = 4000, recent = 15 * 60 * 1000, max = 6 }) {
  const cache = new Map(); // id -> { at, running }
  return async (sessions) => {
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
          cache.set(s.id, { at: now(), running: !!turn && !turn.completedAt && ["inProgress", "interrupted"].includes(turn.status) });
        }
        if (cache.get(s.id).running) s.status = "running";
      }),
    );
    return sessions;
  };
}

export function createCodexSessions({
  daemon,
  holder = codexHolder,
  appState = codexAppState(),
  runningElsewhere = codexRunningElsewhere({ daemon }),
}) {
  return {
    async list({ pages = 10 } = {}) {
      const threads = [];
      let cursor = null;
      let page = 0;
      do {
        const r = await daemon.rpc("thread/list", { limit: 50, cursor });
        threads.push(...(r.data || []));
        cursor = r.nextCursor;
      } while (cursor && ++page < pages);
      return runningElsewhere(threads.map(codexSession));
    },
    async read(id, { cursor = null, limit = 200 } = {}) {
      if (!UUID.test(id)) throw Object.assign(new Error("Unknown session."), { status: 404 });
      const [{ thread }, r, turns, held] = await Promise.all([
        daemon.rpc("thread/read", { threadId: id, includeTurns: false }),
        daemon.rpc("thread/items/list", {
          threadId: id,
          limit: Math.min(Math.max(limit, 1), 500),
          sortDirection: "desc",
          cursor,
        }),
        // Turn status and errors come from the thread's file, so they are
        // known even while another engine runs it.
        daemon
          .rpc("thread/turns/list", { threadId: id, limit: 40, sortDirection: "desc", itemsView: "notLoaded" })
          .catch(() => null),
        cursor ? null : holder(id),
      ]);
      const items = (r.data || [])
        .map((entry) => codexItem(entry))
        .filter(Boolean)
        .reverse();
      const session = codexSession(thread);
      session.model = thread.model || null;
      session.effort = thread.reasoningEffort || null;
      session.held = held;
      session.mode = codexMode(appState().threads[id]);
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
      return {
        session,
        items: withTurnNotes(items, turns?.data, { olderPage: !!cursor, runningTurn }),
        before: r.nextCursor || null,
      };
    },
    // Models, and the mode the Codex app starts new chats in.
    async models() {
      const r = await daemon.rpc("model/list", {});
      const saved = appState().mode;
      return {
        models: (r.data || [])
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.id,
            name: modelName(m.displayName || m.id),
            efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
            defaultEffort: m.defaultReasoningEffort || null,
            images: (m.inputModalities || ["text", "image"]).includes("image"),
            isDefault: !!m.isDefault,
          })),
        mode: Object.hasOwn(CODEX_MODES, saved) ? saved : "auto",
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
      };
    },
  };
}
