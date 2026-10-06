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
import { object, validateQuestions, uncertainDelivery, compatibilityError } from "./compatibility.mjs";
import path from "node:path";
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
  if (!object(params)) throw compatibilityError("codex", "approval");
  if (["reason", "cwd", "message", "serverName", "grantRoot"].some(k => params[k] != null && typeof params[k] !== "string"))
    throw compatibilityError("codex", "approval context");
  if (params.availableDecisions != null && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.length || params.availableDecisions.some(d => typeof d !== "string" && !object(d))))
    throw compatibilityError("codex", "approval decisions");
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
      if (!object(params.permissions)) throw compatibilityError("codex", "permission scope");
      return {
        ...base,
        kind: "permissions",
        title: "Allow more access?",
        reason: params.reason || "",
        permissions: params.permissions,
        command: JSON.stringify(params.permissions, null, 2),
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
        // Forms, URLs and device proofs need their native UI; never submit an empty acceptance.
        decisions: params.mode || params.requestedSchema ? ["decline", "cancel"] : ["accept", "decline", "cancel"],
        ...(params.mode || params.requestedSchema ? { reason: "Complete this request in Codex on your computer. Reach cannot safely submit this form or verification." } : {}),
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
      if (!prompt.decisions.includes(answer?.decision)) throw bad("Choose accept, decline or cancel.");
      return { action: answer.decision, content: answer.decision === "accept" ? answer.content ?? null : null };
    default:
      throw bad("Reach cannot answer this prompt.", 409);
  }
}

export function codexInput({ text = "", images = [], skill } = {}) {
  const input = [];
  if (typeof text !== "string" || text.length > 50000) throw bad("Messages can be up to 50,000 characters.");
  // A skill picked from "/", as the Codex app sends it (commands.mjs).
  if (skill?.name && skill?.path) input.push({ type: "skill", name: skill.name, path: skill.path });
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
  // Told of each change to a thread (the chat list hears of its status and
  // questions this way).
  const changeListeners = new Set();
  const changed = (id) => {
    const t = state(id);
    t.version++;
    for (const wake of [...t.waiters]) wake();
    for (const listener of changeListeners) { try { listener(id); } catch {} }
  };
  const release = (id) => {
    if (!subscribed.delete(id)) return;
    daemon.rpc("thread/unsubscribe", { threadId: id }).catch(() => {});
  };
  // A thread started without a model gets the Codex service's own default,
  // which a ChatGPT account may not have (verified: "gpt-6.1-sol … not
  // supported"); Codex's listed default then.
  let listedDefault = null;
  const withModel = async (model) => {
    if (model) return model;
    listedDefault ??= daemon.rpc("model/list", {}).then((r) => (r.data || []).find((m) => m.isDefault)?.id || null);
    try {
      return await listedDefault;
    } catch {
      listedDefault = null;
      return null;
    }
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
  // Codex's queue changed: its own notice for a thread, or a write to its
  // queue database (which doesn't say whose). What waits on that is woken.
  const queueWaiters = new Set();
  const queueChanged = (threadId = null) => {
    for (const waiter of [...queueWaiters])
      if (!threadId || waiter.threadId === threadId) waiter.wake();
  };
  // The next change to a thread's queue, or ms on (the safety net).
  const queueNews = (threadId, ms) =>
    new Promise((resolve) => {
      const waiter = {
        threadId,
        wake: () => {
          queueWaiters.delete(waiter);
          resolve();
        },
      };
      queueWaiters.add(waiter);
      wait(ms).then(waiter.wake);
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
    // Some resolved notifications identify only the server request. Clear the
    // original card even without a threadId (or with a string request id).
    if (m.method === "serverRequest/resolved") {
      for (const [threadId, t] of threads) {
        let dropped = false;
        for (const [key, prompt] of t.prompts)
          if (String(prompt.requestId) === String(p.requestId)) dropped = t.prompts.delete(key) || dropped;
        if (dropped) {
          if (!t.prompts.size && t.status === "waiting") t.status = "running";
          changed(threadId);
        }
      }
      return;
    }
    const id = p.threadId || p.turn?.threadId;
    if (!id) return;
    if (m.method === "thread/queue/changed") {
      queueChanged(id);
      return void (queues && readQueue(id));
    }
    const t = state(id);
    switch (m.method) {
      case "turn/started":
        // A queued message may have just become this turn.
        if (queues && t.queue?.length) void readQueue(id);
        t.status = "running";
        t.turnId = p.turn?.id || p.turnId || t.turnId;
        t.error = null;
        break;
      case "turn/completed": {
        const turn = p.turn || {};
        if (t.turnId && turn.id && turn.id !== t.turnId) return;
        if (queues && t.queue?.length) void readQueue(id);
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
        if (typeof p.delta !== "string" || typeof p.itemId !== "string") {
          t.error = compatibilityError("codex", "stream text").message;
          changed(id); return;
        }
        t.streaming = {
          itemId: p.itemId,
          text: (t.streaming?.itemId === p.itemId ? t.streaming.text : "") + (p.delta || ""),
        };
        break;
      case "thread/closed":
        subscribed.delete(id);
        t.prompts.clear();
        t.status = "idle";
        t.turnId = null;
        break;
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
  // Once in Codex's queue the phone has its answer; whether that engine takes
  // the message is watched from here on (taken, below).
  async function queueElsewhere(threadId, input) {
    const added = await daemon.rpc("thread/queue/add", { threadId, clientUserMessageId: randomUUID(), input });
    const queued = added?.queuedSubmission?.id;
    if (typeof queued !== "string" || !queued) throw uncertainDelivery("codex");
    if (queues) void readQueue(threadId);
    void taken(threadId, queued, input);
    return { queued: true, delivered: false, ...(queued ? { messageId: String(queued) } : {}) };
  }
  async function taken(threadId, queued, input) {
    try {
      const deadline = now() + deliverMs;
      while (now() < deadline) {
        // Woken when Codex's queue changes; a slow look in between.
        await queueNews(threadId, 2000);
        const list = await daemon.rpc("thread/queue/list", { threadId }).catch(() => null);
        if (list && !(list.data || []).some((q) => q.id === queued)) return;
      }
      // A running turn there takes queued messages next, as in the app.
      if (await runningOnDisk(threadId)) return;
      // Nothing picked it up: taken back so it cannot run later by surprise,
      // and kept on the phone, saying why, until it's dismissed there.
      const removed = await daemon
        .rpc("thread/queue/delete", { threadId, queuedSubmissionId: queued })
        .catch(() => null);
      if (removed?.deleted !== true) {
        state(threadId).error = uncertainDelivery("codex").message;
        changed(threadId);
        return;
      }
      const t = state(threadId);
      t.returned = [
        ...(t.returned || []),
        {
          id: String(queued),
          text: visibleUserText(input.filter((i) => i?.type === "text").map((i) => i.text).join("\n")),
          images: input.filter((i) => i?.type === "image" || i?.type === "localImage").length,
          error: "Another Codex window has this chat open and didn't take it. Open the chat in the Codex app on your Mac, then send it again.",
        },
      ];
      if (queues) await readQueue(threadId);
      changed(threadId);
    } catch {
      /* Reach quitting, or Codex gone: the queue shows what's left */
    }
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
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    // A phone has the thread open right now (its live view is waiting).
    watched: (threadId) => !!threads.get(threadId)?.waiters.size,
    // News from the Codex app's own files (agent-watch.mjs): its queue or its
    // history changed, though not which chat's. The chats the phone has open
    // are read again at once (the re-reads in view() stay as the fallback).
    nudge(kind) {
      if (kind === "queue") queueChanged();
      for (const [id, t] of threads) {
        if (!t.waiters.size) continue;
        if (kind === "queue") {
          if (queues) void readQueue(id);
        } else {
          t.items++; // the phone reads the chat again
          changed(id);
        }
      }
    },
    // A command from "/" that works in the chat (compact, review): the thread
    // is taken up here as for a message, and what it starts shows as a turn.
    async call(threadId, method, params = {}) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const t = state(threadId);
      if (subscribed.has(threadId) && t.status !== "idle") throw bad("Codex is working in this chat. Try again when it's done.", 409);
      try {
        await attach(threadId);
      } catch (e) {
        if (WRITER_HELD.test(e.message))
          throw bad("The Codex app has this chat open, so it runs this there. Run it in the Codex app, or close the chat there and try again.", 409);
        throw e;
      }
      t.error = null;
      let r;
      try {
        r = await daemon.rpc(method, { threadId, ...params });
      } catch (e) {
        release(threadId);
        throw e;
      }
      if (r?.turn) begin(threadId, r.turn);
      else {
        // Compact answers before its turn starts; let go if none comes.
        t.status = "running";
        changed(threadId);
        const timer = setTimeout(() => {
          if (t.status === "running" && !t.turnId) {
            t.status = "idle";
            release(threadId);
            changed(threadId);
          }
        }, 15000);
        timer.unref?.();
      }
      return r || {};
    },
    async send(threadId, { text, images, model, effort, mode, skill } = {}) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const input = codexInput({ text, images, skill });
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
    async start({ cwd, text, images, model: picked, effort, approvalPolicy, sandbox, approvalsReviewer, name }) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw bad("Choose a folder.");
      const input = codexInput({ text, images });
      const model = await withModel(picked);
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
    // A thread that continues a chat moved from the other agent (move.mjs):
    // its history goes in as what the model has seen, a batch per call; no
    // turn runs until a message is sent. Let go of at once, so the Codex app
    // can open it; one left empty by a failure is archived.
    async fork({ cwd, name, batches = [], developerInstructions, model: picked }) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw bad("Choose a folder.");
      const model = await withModel(picked);
      const started = await daemon.rpc("thread/start", {
        cwd,
        serviceName: "reach",
        ...(model ? { model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      });
      const threadId = started.thread.id;
      subscribed.add(threadId);
      if (name) await daemon.rpc("thread/name/set", { threadId, name: String(name).slice(0, 120) }).catch(() => {});
      try {
        for (const items of batches) await daemon.rpc("thread/inject_items", { threadId, items });
      } catch (e) {
        release(threadId);
        await daemon.rpc("thread/archive", { threadId }).catch(() => {});
        throw e;
      }
      release(threadId);
      return { threadId };
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
      // One Reach took back: dismissed here.
      const t = threads.get(threadId);
      if (t?.returned?.some((m) => m.id === messageId)) {
        t.returned = t.returned.filter((m) => m.id !== messageId);
        changed(threadId);
        return { deleted: true };
      }
      const result = await daemon.rpc("thread/queue/delete", { threadId, queuedSubmissionId: messageId });
      if (result?.deleted !== true) throw bad("That message already left the queue.", 409);
      await readQueue(threadId);
      return { deleted: true };
    },
    async respond(threadId, promptId, answer) {
      const t = state(threadId);
      const prompt = t.prompts.get(String(promptId));
      if (!prompt) throw bad("This prompt was already answered.", 409);
      if (prompt.replying) throw bad("This answer is already being sent.", 409);
      const response = answerFor(prompt, answer);
      prompt.replying = true;
      try {
        await prompt.resolve(response);
        t.prompts.delete(String(promptId));
        if (!t.prompts.size && t.status === "waiting") t.status = "running";
        changed(threadId);
        return { answered: true };
      } finally {
        prompt.replying = false;
      }
    },
    view(threadId) {
      // The phone is looking: what waits in Codex's queue, if not read lately.
      // The Codex app takes queued messages without a notice to Reach, but
      // its queue database changes, and that reads the queue again at once
      // (nudge); this is the slow safety net in case no word comes.
      const every = threads.get(threadId)?.queue?.length ? 15000 : 30000;
      if (queues && now() - (threads.get(threadId)?.queueAt || 0) > every) void readQueue(threadId);
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
        prompts: [...t.prompts.values()].map(({ resolve, requestId, replying, ...p }) => p),
        streaming: t.streaming?.text || "",
        activity: t.activity,
        items: t.items,
        // Codex's queue, then what Reach took back after nobody took it.
        ...(t.queue?.length || t.returned?.length ? { outbox: [...(t.queue || []), ...(t.returned || [])] } : {}),
      };
    },
    // Resolves when the thread changes (or after `ms`), for long polling.
    changes(threadId, since, ms = 25000, signal) {
      const t = state(threadId);
      if (t.version !== Number(since)) return Promise.resolve();
      // Something waits in Codex's queue: look again soon (view() re-reads it).
      if (queues && t.queue?.length) ms = Math.min(ms, 15000);
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
