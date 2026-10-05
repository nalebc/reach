// Driving Codex threads from Reach through the shared daemon: continue,
// start, steer, stop, and answer the same prompts the Codex app shows
// (command and file-change approvals, permission requests, questions,
// MCP elicitations). Existing threads keep their own settings: resuming
// passes no approval or sandbox overrides (on a shared daemon that would
// change the thread for every client). Only threads Reach starts get the
// settings chosen in Reach.
//
// Codex allows one writer per thread (verified): while the Codex app shows a
// thread, its own engine holds it and resuming here fails with "already has
// an active writer". Messages for such a thread go through Codex's shared
// queue instead, and the engine holding the thread runs them — the message
// appears in the Codex app like one typed there (verified). Threads Reach
// drives are released after each turn; the daemon unloads them about a
// minute later so the app can take them back (verified).
import { randomUUID } from "node:crypto";
import { visibleUserText } from "./message-text.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Both messages the Codex app itself checks for.
const WRITER_HELD = /already has an active writer|already has a live local writer/i;
const PROMPTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  // Legacy names kept by the protocol.
  "execCommandApproval",
  "applyPatchApproval",
]);
const DEFAULT_DECISIONS = {
  "item/commandExecution/requestApproval": ["accept", "acceptForSession", "decline", "cancel"],
  "item/fileChange/requestApproval": ["accept", "acceptForSession", "decline", "cancel"],
  // Legacy ReviewDecision: "denied" is an object there, so only these plain values.
  execCommandApproval: ["approved", "approved_for_session", "abort"],
  applyPatchApproval: ["approved", "approved_for_session", "abort"],
};
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What the phone shows for one prompt, in the app's own terms.
export function describePrompt(method, params = {}) {
  const base = { method, threadId: params.threadId || params.conversationId, turnId: params.turnId || null };
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return {
        ...base,
        kind: "command",
        title: "Run this command?",
        command: Array.isArray(params.command) ? params.command.join(" ") : String(params.command ?? ""),
        cwd: params.cwd || "",
        reason: params.reason || "",
        decisions: params.availableDecisions?.length ? params.availableDecisions : DEFAULT_DECISIONS[method],
      };
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return {
        ...base,
        kind: "file-change",
        title: "Make these changes?",
        files: Object.keys(params.fileChanges || {}),
        reason: params.reason || "",
        grantRoot: params.grantRoot || null,
        decisions: DEFAULT_DECISIONS[method],
      };
    case "item/permissions/requestApproval":
      return {
        ...base,
        kind: "permissions",
        title: "Allow more access?",
        reason: params.reason || "",
        permissions: params.permissions || {},
        decisions: ["allow", "deny"],
      };
    case "item/tool/requestUserInput":
      return {
        ...base,
        kind: "question",
        title: "Codex has a question",
        questions: (params.questions || []).map((q) => ({
          id: q.id,
          header: q.header || "",
          question: q.question || "",
          options: (q.options || []).map((o) => ({ label: o.label, description: o.description || "" })),
          other: !!q.isOther,
          secret: !!q.isSecret,
        })),
      };
    case "mcpServer/elicitation/request":
      return {
        ...base,
        kind: "elicitation",
        title: `${params.serverName || "A tool"} needs your input`,
        message: params.message || params.description || params.title || "",
        decisions: ["accept", "decline", "cancel"],
      };
    default:
      return { ...base, kind: "unknown", title: method };
  }
}

// Turns the phone's answer into the response the protocol expects; rejects
// anything the prompt did not offer.
export function answerFor(prompt, answer) {
  switch (prompt.kind) {
    case "command":
    case "file-change": {
      const offered = prompt.decisions.map((d) => (typeof d === "string" ? d : Object.keys(d)[0]));
      const index = offered.indexOf(answer?.decision);
      if (index < 0) throw bad("That choice is not available for this prompt.");
      return { decision: prompt.decisions[index] };
    }
    case "permissions":
      if (answer?.decision === "allow") return { permissions: prompt.permissions, scope: "turn" };
      if (answer?.decision === "deny") return { permissions: {}, scope: "turn" };
      throw bad("Choose allow or deny.");
    case "question": {
      const answers = {};
      for (const q of prompt.questions) {
        const given = answer?.answers?.[q.id];
        if (!Array.isArray(given) || !given.length || given.some((g) => typeof g !== "string" || g.length > 2000))
          throw bad("Answer every question.");
        answers[q.id] = { answers: given };
      }
      return { answers };
    }
    case "elicitation":
      if (!["accept", "decline", "cancel"].includes(answer?.decision)) throw bad("Choose accept, decline or cancel.");
      return { action: answer.decision, content: answer.decision === "accept" ? answer.content ?? null : null };
    default:
      throw bad("Reach cannot answer this prompt.", 409);
  }
}

export function codexInput({ text = "", images = [] } = {}) {
  const input = [];
  if (typeof text !== "string" || text.length > 50000) throw bad("Messages can be up to 50,000 characters.");
  if (text.trim()) input.push({ type: "text", text, text_elements: [] });
  for (const path of images) input.push({ type: "localImage", path });
  if (!input.length) throw bad("Write a message or add an image.");
  return input;
}

// What Codex is doing right now, in the words the apps use.
export function activityFor(item) {
  switch (item?.type) {
    case "commandExecution":
      return `Running ${String(item.command ?? "").slice(0, 80)}`;
    case "fileChange":
      return "Editing files";
    case "webSearch":
      return "Searching the web";
    case "mcpToolCall":
      return `Using ${item.server || "a tool"}`;
    case "reasoning":
      return "Thinking";
    case "contextCompaction":
      return "Compacting context";
    default:
      return null;
  }
}

// A turn the engine holding the thread is still running reads from its file
// as "interrupted" with no end time (verified with the Codex app).
// The Codex app's modes for a turn on an existing thread: the app sends a
// permissions profile id with the approval policy and reviewer (its own table).
export const CODEX_TURN_MODES = {
  auto: { approvalPolicy: "on-request", permissions: ":workspace", approvalsReviewer: "user" },
  "guardian-approvals": { approvalPolicy: "on-request", permissions: ":workspace", approvalsReviewer: "auto_review" },
  "full-access": { approvalPolicy: "never", permissions: ":danger-full-access", approvalsReviewer: "user" },
  "read-only": { approvalPolicy: "on-request", permissions: ":read-only", approvalsReviewer: "user" },
};

// A mode the phone picked: one of the Codex app's, or a permission profile
// Codex offers that Reach has no name for ("profile:<id>").
export const codexTurnMode = (mode) =>
  !mode
    ? {}
    : CODEX_TURN_MODES[mode] ||
      (/^profile::?[\w.-]+$/.test(mode)
        ? { approvalPolicy: "on-request", permissions: mode.slice("profile:".length), approvalsReviewer: "user" }
        : {});

const finished = (turn) => !!turn?.completedAt || ["completed", "failed"].includes(turn?.status);

export function createCodexLive({
  daemon,
  now = Date.now,
  wait = sleep,
  deliverMs = 10000,
  onChange = () => {},
  // Messages waiting in Codex's own queue, shown on the phone (off in tests
  // that count the calls made to Codex).
  queues = !process.env.NODE_TEST_CONTEXT,
}) {
  const threads = new Map();
  const subscribed = new Set();
  const state = (id) => {
    if (!threads.has(id))
      threads.set(id, {
        status: "idle",
        turnId: null,
        lastCompleted: null,
        error: null,
        prompts: new Map(),
        streaming: null,
        activity: null,
        items: 0,
        version: 0,
        waiters: new Set(),
        queue: null,
        queueAt: 0,
        queueReading: null,
      });
    return threads.get(id);
  };
  const changed = (id) => {
    const t = state(id);
    t.version++;
    for (const wake of [...t.waiters]) wake();
    onChange(id);
  };
  const release = (id) => {
    if (!subscribed.delete(id)) return;
    daemon.rpc("thread/unsubscribe", { threadId: id }).catch(() => {});
  };
  daemon.onClose?.(() => {
    subscribed.clear();
    for (const [id, t] of threads)
      if (t.status !== "idle" || t.prompts.size) {
        Object.assign(t, { status: "idle", turnId: null, streaming: null, activity: null });
        t.prompts.clear();
        t.error = "Lost the connection to Codex. Send again to continue.";
        changed(id);
      }
  });
  // What waits in Codex's queue for a thread (the Codex app runs it next):
  // text and a count of pictures, as the phone shows it.
  const readQueue = (id) => {
    const t = state(id);
    t.queueAt = now();
    t.queueReading ||= daemon
      .rpc("thread/queue/list", { threadId: id })
      .then((r) => {
        const next = (r?.data || []).map((q) => ({
          id: String(q.id),
          text: visibleUserText((q.input || []).filter((i) => i?.type === "text").map((i) => i.text).join("\n")),
          images: (q.input || []).filter((i) => i?.type === "image" || i?.type === "localImage").length,
        }));
        if (JSON.stringify(next) !== JSON.stringify(t.queue || [])) {
          t.queue = next;
          changed(id);
        }
      })
      .catch(() => {})
      .finally(() => {
        t.queueReading = null;
      });
    return t.queueReading;
  };
  daemon.onNotification((m) => {
    const p = m.params || {};
    const id = p.threadId || p.turn?.threadId;
    if (!id) return;
    if (m.method === "thread/queue/changed") return void (queues && readQueue(id));
    const t = state(id);
    switch (m.method) {
      case "turn/started":
        t.status = "running";
        t.turnId = p.turn?.id || p.turnId || t.turnId;
        t.error = null;
        break;
      case "turn/completed": {
        const turn = p.turn || {};
        Object.assign(t, { status: "idle", turnId: null, streaming: null, activity: null });
        t.lastCompleted = turn.id || null;
        if (turn.status === "failed" && turn.error?.message) t.error = turn.error.message;
        t.prompts.clear();
        t.items++;
        release(id);
        break;
      }
      case "error":
        if (p.willRetry || !p.error?.message) return; // Codex retries transient errors itself.
        t.error = p.error.message;
        break;
      case "thread/status/changed": {
        const s = p.status || {};
        if (s.type === "active")
          t.status = s.activeFlags?.some((f) => f === "waitingOnApproval" || f === "waitingOnUserInput")
            ? "waiting"
            : "running";
        else if (s.type === "idle") t.status = "idle";
        else return;
        break;
      }
      case "serverRequest/resolved": {
        // Answered elsewhere (e.g. in a terminal): drop it here too.
        let dropped = false;
        for (const [key, prompt] of t.prompts)
          if (prompt.requestId === p.requestId) dropped = t.prompts.delete(key);
        if (!dropped) return;
        break;
      }
      case "item/started": {
        const activity = activityFor(p.item);
        if (!activity) return;
        t.activity = activity;
        break;
      }
      case "item/completed":
        if (t.streaming?.itemId === p.item?.id) t.streaming = null;
        if (activityFor(p.item)) t.activity = null;
        t.items++; // the transcript has something new
        break;
      case "item/agentMessage/delta":
        t.streaming = {
          itemId: p.itemId,
          text: (t.streaming?.itemId === p.itemId ? t.streaming.text : "") + (p.delta || ""),
        };
        break;
      case "thread/closed":
        subscribed.delete(id);
        return;
      default:
        return;
    }
    changed(id);
  });
  daemon.onRequest((message, resolve, reject) => {
    if (!PROMPTS.has(message.method)) return reject({ code: -32601, message: "Not supported by Reach." });
    const prompt = describePrompt(message.method, message.params);
    if (!prompt.threadId) return reject({ code: -32602, message: "Missing thread." });
    const t = state(prompt.threadId);
    const key = String(message.id);
    t.prompts.set(key, { ...prompt, id: key, requestId: message.id, at: now(), resolve });
    t.status = "waiting";
    changed(prompt.threadId);
  });
  async function attach(threadId) {
    if (subscribed.has(threadId)) return;
    // No approval/sandbox overrides: the thread keeps its own settings.
    await daemon.rpc("thread/resume", { threadId, excludeTurns: true });
    subscribed.add(threadId);
  }
  async function runningOnDisk(threadId) {
    const r = await daemon
      .rpc("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
      .catch(() => null);
    const turn = r?.data?.[0];
    return !!turn && !finished(turn);
  }
  // The thread is held by another engine (usually the Codex app showing it).
  async function queueElsewhere(threadId, input) {
    const added = await daemon.rpc("thread/queue/add", { threadId, clientUserMessageId: randomUUID(), input });
    const queued = added?.queuedSubmission?.id;
    if (queues) void readQueue(threadId);
    const deadline = now() + deliverMs;
    while (now() < deadline) {
      await wait(500);
      const list = await daemon.rpc("thread/queue/list", { threadId }).catch(() => null);
      if (list && !(list.data || []).some((q) => q.id === queued)) return { queued: true, delivered: true };
    }
    // A running turn there takes queued messages next, as in the app.
    if (await runningOnDisk(threadId)) return { queued: true, delivered: false };
    // Nothing picked it up: take it back so it cannot run later by surprise.
    const removed = await daemon
      .rpc("thread/queue/delete", { threadId, queuedSubmissionId: queued })
      .catch(() => null);
    if (removed?.deleted === false) return { queued: true, delivered: true };
    throw bad(
      "Another Codex window has this chat open and didn't take the message. Open it in the Codex app on your Mac, or close it there, then try again.",
      409,
    );
  }
  const begin = (threadId, turn) => {
    const t = state(threadId);
    // turn/completed can arrive before the turn/start reply (e.g. usage limits).
    if (turn?.id && t.lastCompleted !== turn.id) {
      t.status = t.status === "waiting" ? "waiting" : "running";
      t.turnId = turn.id;
    }
    changed(threadId);
  };
  return {
    drives: (threadId) => subscribed.has(threadId),
    // A phone has the thread open right now (its live view is waiting).
    watched: (threadId) => !!threads.get(threadId)?.waiters.size,
    async send(threadId, { text, images, model, effort, mode } = {}) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const input = codexInput({ text, images });
      const t = state(threadId);
      if (subscribed.has(threadId) && t.status !== "idle" && t.turnId) {
        // Like typing while Codex works: steer the running turn.
        await daemon.rpc("turn/steer", { threadId, expectedTurnId: t.turnId, input });
        return { steered: true };
      }
      try {
        await attach(threadId);
      } catch (e) {
        if (WRITER_HELD.test(e.message)) return queueElsewhere(threadId, input);
        throw e;
      }
      t.error = null;
      let r;
      try {
        r = await daemon.rpc("turn/start", {
          threadId,
          input,
          clientUserMessageId: randomUUID(),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // Applies to this turn and the ones after, like the app's menu.
          ...codexTurnMode(mode),
        });
      } catch (e) {
        release(threadId);
        throw e;
      }
      begin(threadId, r.turn);
      return { turnId: r.turn?.id || null };
    },
    async start({ cwd, text, images, model, effort, approvalPolicy, sandbox, approvalsReviewer, name }) {
      if (typeof cwd !== "string" || !cwd.startsWith("/")) throw bad("Choose a folder.");
      const input = codexInput({ text, images });
      const started = await daemon.rpc("thread/start", {
        cwd,
        serviceName: "reach",
        ...(model ? { model } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
      });
      const threadId = started.thread.id;
      subscribed.add(threadId);
      if (name) await daemon.rpc("thread/name/set", { threadId, name: String(name).slice(0, 120) }).catch(() => {});
      let r;
      try {
        r = await daemon.rpc("turn/start", {
          threadId,
          input,
          clientUserMessageId: randomUUID(),
          ...(effort ? { effort } : {}),
        });
      } catch (e) {
        release(threadId);
        throw e;
      }
      begin(threadId, r.turn);
      return { threadId, turnId: r.turn?.id || null };
    },
    async stop(threadId) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const t = state(threadId);
      let turnId = subscribed.has(threadId) ? t.turnId : null;
      if (!turnId) {
        const r = await daemon.rpc("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
        const turn = r?.data?.[0];
        if (turn && !finished(turn)) turnId = turn.id;
      }
      if (!turnId) throw bad("There is no running turn to stop.", 409);
      // Same request as the app. Never take over the thread or kill its process.
      await daemon.rpc("turn/interrupt", { threadId, turnId });
      return { stopped: true };
    },
    async cancelQueued(threadId, messageId) {
      if (!UUID.test(threadId) || typeof messageId !== "string" || !messageId || messageId.length > 128)
        throw bad("Unknown queued message.", 404);
      const result = await daemon.rpc("thread/queue/delete", { threadId, queuedSubmissionId: messageId });
      if (result?.deleted !== true) throw bad("That message already left the queue.", 409);
      await readQueue(threadId);
      return { deleted: true };
    },
    respond(threadId, promptId, answer) {
      const t = state(threadId);
      const prompt = t.prompts.get(String(promptId));
      if (!prompt) throw bad("This prompt was already answered.", 409);
      const response = answerFor(prompt, answer);
      t.prompts.delete(String(promptId));
      if (!t.prompts.size && t.status === "waiting") t.status = "running";
      prompt.resolve(response);
      changed(threadId);
      return { answered: true };
    },
    view(threadId) {
      // The phone is looking: what waits in Codex's queue, if not read lately.
      if (queues && now() - (threads.get(threadId)?.queueAt || 0) > 5000) void readQueue(threadId);
      const t = threads.get(threadId);
      if (!t)
        return { version: 0, status: null, error: null, turnId: null, prompts: [], streaming: "", activity: null, items: 0 };
      // What Reach saw last. A turn another engine runs shows in the
      // session's own status (read from its file), not here.
      return {
        version: t.version,
        status: t.status,
        error: t.error,
        turnId: t.turnId,
        prompts: [...t.prompts.values()].map(({ resolve, requestId, ...p }) => p),
        streaming: t.streaming?.text || "",
        activity: t.activity,
        items: t.items,
        ...(t.queue?.length ? { outbox: t.queue } : {}),
      };
    },
    // Resolves when the thread changes (or after `ms`), for long polling.
    changes(threadId, since, ms = 25000, signal) {
      const t = state(threadId);
      if (t.version !== Number(since)) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          t.waiters.delete(done);
          signal?.removeEventListener?.("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        t.waiters.add(done);
        signal?.addEventListener?.("abort", done);
      });
    },
  };
}
