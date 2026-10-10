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
import fs from "node:fs/promises";
import os from "node:os";
import { codexArchive } from "./portable-history.mjs";
import { createCodexDesktop } from "./codex-desktop.mjs";
import { createCodexOwner, codexQueuedMessage } from "./codex-owner.mjs";
import { elicitationPrompt, elicitationAnswer } from "./elicitation.mjs";
import { codexMode } from "./codex.mjs";
import { questionKey, questionReply, readQuestionReply } from "./codex-questions.mjs";
import { randomUUID } from "node:crypto";
import { visibleUserText } from "./message-text.mjs";
import { computerWord } from "../computer-word.mjs";
import { sweepAtRest } from "./at-rest.mjs";

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
  // What Codex offers, else its usual four. A request that also widens
  // access to a folder (grantRoot) the phone doesn't show is answered for
  // this once only, never for the whole session (fail-open audit, Oct 8).
  // An "Always allow…" that carries a rule (an execpolicy or network
  // amendment) grants what the phone doesn't show: answered in the app only.
  const offered = ((params.availableDecisions?.length ? params.availableDecisions : DEFAULT_DECISIONS[method]) || []).filter((d) => typeof d === "string");
  const decisions = params.grantRoot
    ? offered.filter((d) => !["acceptForSession", "approved_for_session"].includes(typeof d === "string" ? d : Object.keys(d)[0]))
    : offered;
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      // A command the phone can't show as written is never accepted from
      // it: only declined (fail-open audit, Oct 8).
      const shown = (typeof params.command === "string" && params.command.trim()) ||
        (Array.isArray(params.command) && params.command.length && params.command.every((part) => typeof part === "string"));
      return {
        ...base,
        kind: "command",
        title: "Run this command?",
        command: shown ? (Array.isArray(params.command) ? params.command.join(" ") : params.command) : "",
        cwd: params.cwd || "",
        reason: params.reason || "",
        decisions: shown ? decisions : decisions.filter((d) => /^(decline|cancel|abort|denied)$/.test(typeof d === "string" ? d : Object.keys(d)[0])),
      };
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return {
        ...base,
        kind: "file-change",
        title: "Make these changes?",
        files: params.fileChanges && typeof params.fileChanges === "object" && !Array.isArray(params.fileChanges) ? Object.keys(params.fileChanges) : [],
        reason: params.reason || "",
        grantRoot: params.grantRoot || null,
        decisions,
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
      validateQuestions(params.questions, "codex");
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
      return { ...base, ...elicitationPrompt(params) };
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
        if (!Array.isArray(given) || given.length !== 1 || given.some((g) => typeof g !== "string" || !g.trim() || g.length > 2000) ||
            (!q.other && q.options.length && !q.options.some(o => o.label === given[0])))
          throw bad("Answer every question.");
        answers[q.id] = { answers: given };
      }
      return { answers };
    }
    case "elicitation":
      return elicitationAnswer(prompt, answer);
    default:
      throw bad("Reach cannot answer this prompt.", 409);
  }
}

// An answer the Codex app gives for a request Reach holds, checked against
// that request before it goes on: never more access than was asked, only
// the questions asked, only the actions a form has (fail-open audit, Oct 8).
const within = (given, asked) =>
  given === asked ||
  (object(given) && object(asked) && Object.entries(given).every(([k, v]) => Object.hasOwn(asked, k) && within(v, asked[k]))) ||
  (Array.isArray(given) && Array.isArray(asked) && given.every((g) => asked.some((a) => within(g, a)))) ||
  // Turning something off is never more access.
  given === false || given === null;
export function appAnswerFits(prompt, response) {
  switch (prompt.kind) {
    case "permissions":
      return Object.keys(response).every((k) => ["permissions", "scope"].includes(k)) &&
        object(response.permissions) && within(response.permissions, prompt.permissions) &&
        (response.scope === undefined || response.scope === "turn" || response.scope === "session");
    case "question":
      return Object.keys(response).every((k) => k === "answers") && object(response.answers) &&
        Object.entries(response.answers).every(([id, a]) => prompt.questions.some((q) => q.id === id) &&
          object(a) && Array.isArray(a.answers) && a.answers.every((x) => typeof x === "string"));
    case "elicitation":
      return ["accept", "decline", "cancel"].includes(response.action) &&
        (response.content == null || object(response.content));
    default:
      return false;
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
    case "collabAgentToolCall":
      return item.tool === "spawnAgent" ? "Starting an agent" : "Working with agents";
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
  desktop = createCodexDesktop(),
  ownerFactory = createCodexOwner,
  nativeTurns = !process.env.NODE_TEST_CONTEXT,
  now = Date.now,
  wait = sleep,
  deliverMs = 10000,
  // Messages waiting in Codex's own queue, shown on the phone (off in tests
  // that count the calls made to Codex).
  queues = !process.env.NODE_TEST_CONTEXT,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
  // What a thread is resumed with besides itself (a team's lead: its tools
  // and standing instructions, teams.mjs).
  resumeExtras = () => null,
}) {
  const threads = new Map();
  const subscribed = new Set();
  const reconnecting = new Set();
  let closed = false, connectionGeneration = 0;
  const fresh = () => ({
    status: "idle",
    turnId: null,
    lastCompleted: null,
    error: null,
    prompts: new Map(),
    nativeRequests: new Map(),
    streaming: null,
    activity: null,
    items: 0,
    version: 0,
    waiters: new Set(),
    queue: null,
    queueAt: 0,
    queueReading: null,
  });
  const state = (id) => {
    if (!threads.has(id)) threads.set(id, fresh());
    const t = threads.get(id);
    t.touchedAt = now();
    return t;
  };
  // Threads only asked about, at rest for 30 minutes, aren't kept for good
  // (at-rest.mjs); one followed, subscribed or with anything going stays.
  const restSweep = setInterval(() => sweepAtRest(threads, {
    fresh, free: ["version", "touchedAt"], now: now(),
    keep: (id) => subscribed.has(id) || reconnecting.has(id) || owner.hasFollowers?.(id),
  }), 10 * 60 * 1000);
  restSweep.unref?.();
  let api;
  const owner = ownerFactory({
    daemon,
    requests: id => [...state(id).nativeRequests.values()],
    handleRequest: nativeRequest,
  });
  // Told of each change to a thread (the chat list hears of its status and
  // questions this way).
  const changeListeners = new Set();
  const changed = (id) => {
    const t = state(id);
    t.version++;
    for (const wake of [...t.waiters]) wake();
    for (const listener of changeListeners) { try { listener(id); } catch {} }
    owner.update(id);
  };
  const release = (id) => {
    // Keep the engine subscribed while Codex follows it. Both composers
    // remain connected to this writer, including between turns.
    if (owner.hasFollowers(id)) return;
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
    connectionGeneration++;
    for (const id of subscribed) reconnecting.add(id);
    subscribed.clear();
    owner.reset?.();
    for (const [id, t] of threads)
      if (t.status !== "idle" || t.prompts.size) {
        Object.assign(t, { status: "idle", turnId: null, streaming: null, activity: null });
        t.prompts.clear();
        t.nativeRequests.clear();
        t.error = "Lost the connection to Codex. Send again to continue.";
        changed(id);
      }
  });
  // The daemon outlives Reach. Restore the native owner bridge for its
  // still-loaded Reach tasks after startup or a connection loss; otherwise
  // the desktop sees a writer lock with nobody advertising its history.
  daemon.onReady?.(() => { void recoverOwners().catch(() => {}); });
  async function recoverOwners() {
    const generation = connectionGeneration;
    const current = () => !closed && generation === connectionGeneration;
    let cursor = null;
    const visited = new Set();
    do {
      if (!current()) return;
      const page = await daemon.rpc("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const id of page.data || []) {
        if (!current()) return;
        if (subscribed.has(id)) continue;
        try {
          const { thread } = await daemon.rpc("thread/read", { threadId: id, includeTurns: false });
          if (!current()) return;
          if (!reconnecting.has(id) && thread.originator !== "reach") continue;
          await attach(id, () => { if (!current()) throw Error("Codex connection changed."); });
          reconnecting.delete(id);
          const t = state(id);
          const active = thread.status?.type === "active";
          t.status = active
            ? thread.status.activeFlags?.length ? "waiting" : "running"
            : "idle";
          t.error = null;
          changed(id);
          if (!active) release(id);
        } catch {
          // A task may close or change owners during enumeration. Never
          // create a replacement thread or replay a message to recover it.
        }
      }
      cursor = page.nextCursor || null;
      if (visited.has(cursor)) break;
      visited.add(cursor);
    } while (cursor);
  }
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
    if (t.queueReading) {
      // Native cancellation can arrive while an older snapshot is on its
      // way. Read again after it; never publish that known-stale result.
      t.queueAgain = true;
      return t.queueReading;
    }
    t.queueAgain = false;
    t.queueAt = now();
    t.queueReading = daemon
      .rpc("thread/queue/list", { threadId: id })
      .then((r) => {
        if (!Array.isArray(r?.data)) throw compatibilityError("codex", "queued messages");
        if (t.queueAgain) return;
        const next = r.data.map((q) => ({
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
        if (t.queueAgain) return readQueue(id);
      });
    return t.queueReading;
  };
  // How full each chat's context is, as Codex reports it.
  const contexts = new Map();
  daemon.onNotification((m) => {
    const p = m.params || {};
    if (m.method === "thread/tokenUsage/updated" && typeof p.threadId === "string") {
      const used = Number(p.tokenUsage?.last?.totalTokens) || 0;
      const window = Number(p.tokenUsage?.modelContextWindow) || 0;
      if (used > 0 && window > 0) {
        contexts.set(p.threadId, { used, window });
        if (contexts.size > 500) contexts.delete(contexts.keys().next().value);
      }
    }
    // Some resolved notifications identify only the server request. Clear the
    // original card even without a threadId (or with a string request id).
    if (m.method === "serverRequest/resolved") {
      for (const [threadId, t] of threads) {
        let dropped = false;
        for (const [key, prompt] of t.prompts)
          if (String(prompt.requestId) === String(p.requestId)) {
            t.nativeRequests.delete(key);
            dropped = t.prompts.delete(key) || dropped;
          }
        if (dropped) {
          if (!t.prompts.size && t.status === "waiting") t.status = "running";
          changed(threadId);
        }
      }
      return;
    }
    const id = p.threadId || p.turn?.threadId;
    if (!id) return;
    owner.update(id);
    if (m.method === "thread/queue/changed") {
      queueChanged(id);
      return void (queues && readQueue(id));
    }
    const t = state(id);
    switch (m.method) {
      case "thread/settings/updated":
        if (object(p.threadSettings)) t.mode = codexMode(p.threadSettings);
        owner.settings(id, p.threadSettings || {});
        t.items++; // Re-read the native model and effort in the composer.
        break;
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
        t.nativeRequests.clear();
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
        else if (s.type === "idle") {
          t.status = "idle";
          t.turnId = null; // a finished turn must not be interrupted by Stop
        } else return;
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
        owner.forget(id);
        t.prompts.clear();
        t.nativeRequests.clear();
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
    let prompt;
    try { prompt = describePrompt(message.method, message.params); }
    catch (error) {
      const id = message.params?.threadId || message.params?.conversationId;
      if (typeof id === "string" && UUID.test(id)) {
        state(id).error = error.message;
        changed(id);
      }
      return reject({ code: -32602, message: error.message });
    }
    if (!prompt.threadId) return reject({ code: -32602, message: "Missing thread." });
    const t = state(prompt.threadId);
    const key = String(message.id);
    t.prompts.set(key, { ...prompt, id: key, requestId: message.id, at: now(), resolve });
    t.nativeRequests.set(key, { id: message.id, method: message.method, params: message.params });
    t.status = "waiting";
    changed(prompt.threadId);
  });
  async function attach(threadId, authorize = () => {}) {
    authorize();
    if (subscribed.has(threadId)) return;
    // No approval/sandbox overrides: the thread keeps its own settings.
    const extra = resumeExtras(threadId) || {};
    // (false: a stopped team's lead, resumed as an ordinary thread.)
    const resumed = await daemon.rpc("thread/resume", {
      threadId,
      excludeTurns: true,
      ...(extra.config ? { config: extra.config } : {}),
      ...(extra.developerInstructions ? { developerInstructions: extra.developerInstructions } : {}),
    });
    authorize();
    subscribed.add(threadId);
    await owner.claim(threadId, resumed);
    authorize();
  }
  // interrupted: a turn "interrupted" with no end time counts as running (an
  // engine holding the thread runs it). With false it counts as over, as in
  // codex.mjs when no other engine holds the thread (turnOpen): a message
  // must not wait in Codex's queue for a turn nothing is running.
  async function runningOnDisk(threadId, { interrupted = true } = {}) {
    const r = await daemon
      .rpc("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
      .catch(() => null);
    const turn = r?.data?.[0];
    if (!interrupted && turn?.status === "interrupted" && !turn.completedAt) return false;
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
  // Into a turn the Codex app runs, as its own Steer does: through the app,
  // which holds the thread. queued: the queued message it takes out of line.
  // text: what the app puts back in its box should the steer fail.
  async function steerElsewhere(threadId, input, { queued = null, text = input.filter((i) => i?.type === "text").map((i) => i.text).join("\n") } = {}) {
    const read = await daemon.rpc("thread/read", { threadId, includeTurns: false }).catch(() => null);
    const r = await desktop.steer(threadId, { input, text, cwd: read?.thread?.cwd || null, queued });
    const t = state(threadId);
    t.items++;
    changed(threadId);
    return r;
  }
  // A message in Codex's queue, as Codex keeps it (its input, pictures too).
  async function queuedOne(threadId, messageId) {
    if (!UUID.test(threadId) || typeof messageId !== "string" || !messageId || messageId.length > 128)
      throw bad("Unknown queued message.", 404);
    const list = await daemon.rpc("thread/queue/list", { threadId });
    const found = (list?.data || []).find((q) => String(q.id) === messageId);
    if (!found || !Array.isArray(found.input)) throw bad("That message already left the queue.", 409);
    return found;
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
          error: `Another Codex window has this chat open and didn't take it. Open the chat in the Codex app on your ${computerWord(platform)}, then send it again.`,
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
  async function nativeQueue(id) {
    const result = await daemon.rpc("thread/queue/list", { threadId: id });
    if (!Array.isArray(result?.data)) throw compatibilityError("codex", "queued messages");
    return result.data;
  }
  async function nativeRequest(method, p, context = {}) {
    const id = p.conversationId, t = state(id);
    // A request can lose its original connection/ownership while a native
    // read is in flight. Check again immediately before every dispatch.
    const authorize = () => {
      context.authorize?.();
      if (!owner.has(id)) throw bad("Reach no longer owns this task.", 409);
    };
    const write = (method, params) => { authorize(); return daemon.rpc(method, params); };
    authorize();
    switch (method) {
      case "thread-follower-start-turn": {
        if (p.turnStart?.context?.responseItems?.length)
          throw bad("This context needs the Codex app's own writer.", 409);
        const request = p.turnStart?.request;
        if (!Array.isArray(request?.input) || !request.input.length) throw bad("Write a message.");
        await attach(id, authorize);
        const result = await write("turn/start", { ...request, threadId: id, clientUserMessageId: request.clientUserMessageId || randomUUID() });
        authorize();
        owner.settings(id, request);
        begin(id, result.turn);
        const queued = p.turnStart.context?.serverQueuedMessageId;
        if (queued) await write("thread/queue/delete", { threadId: id, queuedSubmissionId: queued }).catch(() => {});
        return { result };
      }
      case "thread-follower-steer-turn": {
        const latest = (await write("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }))?.data?.[0];
        if (!latest || finished(latest)) throw bad("No active turn to steer.", 409);
        const result = await write("turn/steer", { threadId: id, expectedTurnId: latest.id, input: p.input, clientUserMessageId: p.clientUserMessageId || randomUUID(), ...(p.additionalContext ? { additionalContext: p.additionalContext } : {}) });
        const queued = p.restoreMessage?.serverQueuedMessageId;
        if (queued) await write("thread/queue/delete", { threadId: id, queuedSubmissionId: queued }).catch(() => {});
        changed(id);
        return { result };
      }
      case "thread-follower-update-thread-settings": {
        await attach(id, authorize);
        const settings = p.threadSettings || {};
        if (p.activeTurnId) {
          const active = (await write("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }))?.data?.[0];
          if (!active || finished(active) || active.id !== p.activeTurnId) throw bad("That turn has finished.", 409);
          const selected = Object.fromEntries(["model", "effort", "serviceTier", "summary", "approvalsReviewer"].filter(k => k in settings).map(k => [k, settings[k]]));
          await write("turn/settings/update", { ...selected, threadId: id, turnId: p.activeTurnId });
        } else await write("thread/settings/update", { ...settings, threadId: id });
        authorize();
        owner.settings(id, settings); changed(id);
        return { applied: true };
      }
      case "thread-follower-update-daybreak":
        await write("thread/metadata/update", { threadId: id, daybreakEnabled: p.daybreakEnabled });
        return { ok: true };
      case "thread-follower-edit-last-user-turn":
        await api.editLast(id, { turnId: p.turnId, text: p.message }, authorize);
        return { ok: true };
      case "thread-follower-compact-thread":
        await api.call(id, "thread/compact/start", {}, authorize);
        return { ok: true };
      case "thread-follower-interrupt-turn":
        if (p.expectedTurnId && t.turnId && p.expectedTurnId !== t.turnId) throw bad("That turn has finished.", 409);
        await api.stop(id, authorize);
        return { ok: true, interruptedTurnId: p.expectedTurnId || t.turnId || null };
      case "thread-follower-remove-queued-message": {
        const list = await nativeQueue(id);
        const q = list.find(q => q.id === p.messageId || q.clientUserMessageId === p.messageId);
        if (!q) return { removed: null };
        await api.cancelQueued(id, q.id, authorize);
        const cwd = (await write("thread/read", { threadId: id, includeTurns: false })).thread.cwd;
        return { removed: codexQueuedMessage(q, cwd) };
      }
      case "thread-follower-clear-queued-messages": {
        const list = await nativeQueue(id);
        for (const q of list) await api.cancelQueued(id, q.id, authorize);
        const cwd = (await write("thread/read", { threadId: id, includeTurns: false })).thread.cwd;
        return { messages: list.map(q => codexQueuedMessage(q, cwd)) };
      }
      case "thread-follower-set-queued-follow-ups-state": {
        const messages = p.state?.[id];
        if (!Array.isArray(messages) || messages.length > 100) throw bad("Invalid queued messages.");
        const list = await nativeQueue(id);
        const included = new Set(messages.map(m => m.id)), discarded = new Set(p.discardedMessageIds || []);
        if (included.size !== messages.length) throw bad("Queued messages must have unique ids.");
        // Validate the entire edit before deleting anything. A reorder keeps
        // the original input, including skills and attached model context.
        const known = new Set([...(context.queueIds || []), ...(context.knownQueueIds || [])]);
        const prepared = messages.map(message => {
          if (typeof message.id !== "string" || !message.id) throw bad("Invalid queued message.");
          const existing = list.find(q => q.id === message.id || q.clientUserMessageId === message.id);
          if (!existing && (known.has(message.id) || known.has(message.clientUserMessageId)))
            throw bad("That message is no longer in the queue. Refresh the chat before editing it.", 409);
          const text = String(message.text ?? message.context?.prompt ?? "");
          if (text.length > 50000) throw bad("Messages can be up to 50,000 characters.");
          const attachments = message.context?.imageAttachments || [];
          if (!Array.isArray(attachments)) throw bad("Invalid queued pictures.");
          const images = attachments.map(i => {
            if (typeof (i?.localPath || i?.src) !== "string") throw bad("Invalid queued picture.");
            return i.localPath ? { type: "localImage", path: i.localPath } : { type: "image", url: i.src };
          });
          const kept = (existing?.input || []).filter(i => !["text", "image", "localImage"].includes(i.type));
          const input = [...(text.trim() ? [{ type: "text", text, text_elements: [] }] : []), ...images, ...kept];
          if (!input.length) throw bad("Write a message or keep its pictures.");
          const before = existing && codexQueuedMessage(existing);
          const unchanged = before && before.text === text && JSON.stringify(before.context.imageAttachments.map(i => i.localPath || i.src)) === JSON.stringify(attachments.map(i => i.localPath || i.src));
          return { message, existing, input, unchanged };
        });
        const baseline = new Set(context.queueIds || []);
        for (const q of list) {
          if (discarded.has(q.id) || baseline.has(q.id) && !included.has(q.id))
            await write("thread/queue/delete", { threadId: id, queuedSubmissionId: q.id });
        }
        const order = [];
        for (const { message, existing, input, unchanged } of prepared) {
          if (discarded.has(message.id)) continue;
          if (existing) {
            if (!unchanged) await write("thread/queue/update", { threadId: id, queuedSubmissionId: existing.id, input });
            order.push(existing.id);
          } else {
            const added = await write("thread/queue/add", { threadId: id, input, clientUserMessageId: message.clientUserMessageId || message.id || randomUUID() });
            order.push(added.queuedSubmission.id);
          }
        }
        const current = await nativeQueue(id);
        const liveIds = new Set(current.map(q => q.id));
        await write("thread/queue/reorder", { threadId: id, queuedSubmissionIds: [...order.filter(q => liveIds.has(q)), ...current.map(q => q.id).filter(q => !order.includes(q))] });
        await readQueue(id); changed(id);
        return { ok: true };
      }
      default: {
        const methods = {
          "thread-follower-command-approval-decision": "item/commandExecution/requestApproval",
          "thread-follower-file-approval-decision": "item/fileChange/requestApproval",
          "thread-follower-permissions-request-approval-response": "item/permissions/requestApproval",
          "thread-follower-submit-user-input": "item/tool/requestUserInput",
          "thread-follower-submit-mcp-server-elicitation-response": "mcpServer/elicitation/request",
        };
        const key = String(p.requestId), prompt = t.prompts.get(key);
        if (!prompt || prompt.method !== methods[method]) throw bad("This prompt was already answered.", 409);
        if (prompt.attempted) throw bad("This answer was already attempted. Check Codex.", 409);
        const response = "decision" in p ? answerFor(prompt, { decision: p.decision }) : p.response;
        // A decision is one the request offered (answerFor); a whole answer is checked.
        if (!object(response) || (!("decision" in p) && !appAnswerFits(prompt, response))) throw bad("Invalid answer.");
        authorize();
        prompt.attempted = true;
        await prompt.resolve(response);
        t.prompts.delete(key); t.nativeRequests.delete(key);
        if (!t.prompts.size && t.status === "waiting") t.status = "running";
        changed(id);
        return { ok: true };
      }
    }
  }
  return api = {
    close: () => { closed = true; connectionGeneration++; clearInterval(restSweep); owner.close(); },
    drives: (threadId) => subscribed.has(threadId),
    currentMode: (threadId) => threads.get(threadId)?.mode || null,
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
    async call(threadId, method, params = {}, authorize = () => {}) {
      authorize();
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const t = state(threadId);
      if (subscribed.has(threadId) && t.status !== "idle") throw bad("Codex is working in this chat. Try again when it's done.", 409);
      try {
        await attach(threadId, authorize);
      } catch (e) {
        if (WRITER_HELD.test(e.message)) {
          // Compacting goes through the Codex app itself, as its /compact.
          if (method === "thread/compact/start") {
            authorize();
            const done = await desktop.compact(threadId);
            state(threadId).items++;
            changed(threadId);
            return done;
          }
          throw bad("The Codex app has this chat open, so it runs this there. Run it in the Codex app, or close the chat there and try again.", 409);
        }
        throw e;
      }
      t.error = null;
      let r;
      try {
        authorize();
        r = await daemon.rpc(method, { threadId, ...params });
      } catch (e) {
        try { authorize(); release(threadId); } catch {}
        throw e;
      }
      authorize();
      if (r?.turn) begin(threadId, r.turn);
      else {
        // Compact answers before its turn starts; let go if none comes.
        t.status = "running";
        changed(threadId);
        const timer = setTimeout(() => {
          try { authorize(); } catch { return; }
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
    // speed: Codex's service tier, changed mid-chat as in the Codex app.
    async model(threadId, { model, effort, speed } = {}) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const params = { threadId, model, ...(effort ? { effort } : {}), ...(speed ? { serviceTier: speed } : {}) };
      // A chat already loaded by the shared engine can be changed without
      // taking it over, even while another client is running its turn.
      try {
        await daemon.rpc("thread/settings/update", params);
      } catch (error) {
        if (!/thread not found/i.test(error.message)) throw error;
        try {
          await attach(threadId);
        } catch (e) {
          if (WRITER_HELD.test(e.message)) {
            const result = await desktop.model(threadId, { model, effort, ...(speed ? { serviceTier: speed } : {}) });
            state(threadId).items++;
            changed(threadId);
            return result;
          }
          throw e;
        }
        try { await daemon.rpc("thread/settings/update", params); }
        finally { release(threadId); }
      }
      state(threadId).items++;
      changed(threadId);
      return { model, ...(effort ? { effort } : {}), ...(speed ? { speed } : {}), applied: true };
    },
    async mode(threadId, mode) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const settings = codexTurnMode(mode);
      if (!settings.permissions) throw bad("Choose one of Codex's available permission modes.");
      const params = { threadId, ...settings };
      try { await daemon.rpc("thread/settings/update", params); }
      catch (error) {
        if (!/thread not found/i.test(error.message)) throw error;
        try { await attach(threadId); }
        catch (e) {
          if (!WRITER_HELD.test(e.message)) throw e;
          await desktop.permissions(threadId, settings);
          state(threadId).mode = mode;
          state(threadId).items++;
          changed(threadId);
          return { mode, applied: true };
        }
        try { await daemon.rpc("thread/settings/update", params); }
        finally { release(threadId); }
      }
      state(threadId).mode = mode;
      state(threadId).items++;
      changed(threadId);
      return { mode, applied: true };
    },
    // steer: an answer to what Codex asked, into the running turn at once
    // (as the Codex app does), never behind the queue.
    // collaboration: Codex's plan mode ("plan") or not ("default"), as the
    // Codex app's Plan toggle sends it with a turn.
    async send(threadId, { text, images, model, effort, speed, mode, skill, steer = false, collaboration = null } = {}) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      const input = codexInput({ text, images, skill });
      const t = state(threadId);
      if (subscribed.has(threadId) && t.status !== "idle" && t.turnId) {
        // Like typing while Codex works: steer the running turn.
        await daemon.rpc("turn/steer", { threadId, expectedTurnId: t.turnId, input });
        return { steered: true };
      }
      // Use the already discovered writer when Codex owns this task. This
      // also preserves per-turn settings such as Plan without taking over.
      if (nativeTurns && !subscribed.has(threadId) && !steer && typeof desktop.startTurn === "function") {
        if (await runningOnDisk(threadId, { interrupted: false })) return queueElsewhere(threadId, input);
        const planned = collaboration === "plan" || collaboration === "default" ? {
          collaborationMode: { mode: collaboration, settings: {
            model: model || (await daemon.rpc("thread/read", { threadId, includeTurns: false }).catch(() => null))?.thread?.model || await withModel(),
            reasoning_effort: effort || null, developer_instructions: null,
          } },
        } : {};
        try {
          const result = await desktop.startTurn(threadId, {
            threadId, input, clientUserMessageId: randomUUID(), ...planned,
            ...(model ? { model } : {}), ...(effort ? { effort } : {}),
            ...(speed ? { serviceTier: speed } : {}), ...codexTurnMode(mode),
          });
          t.error = null; t.items++; changed(threadId);
          return { ...result, delivered: true };
        } catch (error) { if (!error.ownerUnavailable) throw error; }
      }
      try {
        await attach(threadId);
      } catch (e) {
        if (!WRITER_HELD.test(e.message)) throw e;
        if (collaboration === "plan")
          throw bad("The Codex app has this chat open: turn Plan on there, or close the chat in the Codex app.", 409);
        if (steer && (await runningOnDisk(threadId))) {
          try {
            return { ...(await steerElsewhere(threadId, input)), delivered: true };
          } catch (error) {
            // Uncertain: it may be in; never sent twice. Refused: it waits its turn.
            if (error.uncertain) throw error;
          }
        }
        return queueElsewhere(threadId, input);
      }
      t.error = null;
      let r;
      try {
        // Plan mode names the model it runs with: the one picked, or the chat's.
        const planned =
          collaboration === "plan" || collaboration === "default"
            ? {
                collaborationMode: {
                  mode: collaboration,
                  settings: {
                    model: model || (await daemon.rpc("thread/read", { threadId, includeTurns: false }).catch(() => null))?.thread?.model || "",
                    reasoning_effort: effort || null,
                    developer_instructions: null,
                  },
                },
              }
            : {};
        if (planned.collaborationMode && !planned.collaborationMode.settings.model) throw bad("Pick a model for plan mode.", 409);
        r = await daemon.rpc("turn/start", {
          threadId,
          input,
          clientUserMessageId: randomUUID(),
          ...planned,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // The speed too, for this turn and the ones after, as in the app.
          ...(speed ? { serviceTier: speed } : {}),
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
    // Answers to the questions Codex asked while it works, as the Codex app
    // sends them: into the turn that asked (never the queue, never a new
    // turn), in the app's own envelope, so both show them as answers.
    // answers: [{ index, answer }] for the question message itemId.
    async answerQuestions(threadId, { itemId, turnId, answers } = {}) {
      if (!UUID.test(threadId)) throw bad("Unknown session.", 404);
      if (typeof itemId !== "string" || !itemId || itemId.length > 128 || typeof turnId !== "string" || !turnId || turnId.length > 128)
        throw bad("Unknown question.", 404);
      if (!Array.isArray(answers) || !answers.length || answers.length > 20) throw bad("Answer the question.");
      const moved = () => bad("Codex has moved on from this question. Send your answer as a message.", 409);
      let asked, cursor = null;
      const cursors = new Set();
      const answered = new Set();
      do {
        const r = await daemon.rpc("thread/items/list", { threadId, limit: 100, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
        for (const entry of r?.data || []) {
          const item = entry?.item;
          if (item?.type !== "userMessage" || item.content?.length !== 1 || item.content[0]?.type !== "text") continue;
          for (const reply of readQuestionReply(item.content[0].text) || []) answered.add(reply.questionItemId);
        }
        asked = (r?.data || []).find((entry) => entry?.item?.id === itemId && entry.item.type === "agentMessage");
        cursor = r?.nextCursor;
        if (cursors.has(cursor)) break;
        cursors.add(cursor);
      } while (!asked && cursor);
      const questions = Array.isArray(asked?.item?.questions) ? asked.item.questions : [];
      if (!questions.length) throw bad("Unknown question.", 404);
      if (questions.some((_, index) => answered.has(questionKey(itemId, index)))) throw bad("This question was already answered. Refresh the chat.", 409);
      if (asked.turnId !== turnId) throw moved();
      const replies = [];
      const indices = new Set();
      for (const a of answers) {
        const q = questions[a?.index];
        if (!Number.isInteger(a?.index) || a.index < 0 || !q || typeof q.title !== "string" || indices.has(a.index) || typeof a.answer !== "string" || a.answer.length > 2000) throw bad("Answer the question.");
        indices.add(a.index);
        // An empty answer skips that question, as in the app.
        if (a.answer.trim()) replies.push({ questionItemId: questionKey(itemId, a.index), question: String(q.title ?? ""), answer: a.answer.trim() });
      }
      if (!replies.length) throw bad("Answer the question.");
      const input = [{ type: "text", text: questionReply(replies), text_elements: [] }];
      const t = state(threadId);
      t.questionReplies ||= new Map();
      const previous = t.questionReplies.get(itemId);
      if (previous) throw bad(previous === "sending" ? "This answer is already being sent." : previous === "answered" ? "This question was already answered. Refresh the chat." : "Codex didn't confirm this answer. Check the Codex app before answering again.", 409);
      t.questionReplies.set(itemId, "sending");
      try {
        if (subscribed.has(threadId) && t.turnId) {
          if (t.turnId !== turnId || t.status === "idle") throw moved();
          await daemon.rpc("turn/steer", { threadId, expectedTurnId: turnId, input });
        } else {
          const latest = (await daemon
            .rpc("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })
            .catch(() => null))?.data?.[0];
          if (!latest || finished(latest) || latest.id !== turnId) throw moved();
          try {
            await steerElsewhere(threadId, input, { text: replies.map((x) => x.answer).join("\n\n") });
          } catch (error) {
            if (error.uncertain) throw error;
            throw bad(`Codex couldn't take the answer now. Try again, or answer in the Codex app on your ${computerWord(platform)}.`, 409);
          }
        }
        t.questionReplies.set(itemId, "answered");
        t.items++;
        changed(threadId);
        return { answered: true };
      } catch (error) {
        if (error.uncertain) t.questionReplies.set(itemId, "uncertain");
        throw error;
      } finally {
        if (t.questionReplies.get(itemId) === "sending") t.questionReplies.delete(itemId);
      }
    },
    async start({ cwd, text, images, model: picked, effort, speed, approvalPolicy, sandbox, approvalsReviewer, name, developerInstructions, config }) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw bad("Choose a folder.");
      const input = codexInput({ text, images });
      const model = await withModel(picked);
      const started = await daemon.rpc("thread/start", {
        cwd,
        serviceName: "reach",
        ...(model ? { model } : {}),
        ...(speed ? { serviceTier: speed } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        ...(typeof developerInstructions === "string" && developerInstructions ? { developerInstructions } : {}),
        ...(config && typeof config === "object" ? { config } : {}),
      });
      const threadId = started.thread.id;
      subscribed.add(threadId);
      await owner.claim(threadId, started);
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
        // An empty thread nobody asked for is archived, as fork() does.
        await daemon.rpc("thread/archive", { threadId }).catch(() => {});
        throw e;
      }
      begin(threadId, r.turn);
      return { threadId, turnId: r.turn?.id || null };
    },
    // A thread that continues a chat moved from the other agent (move.mjs):
    // its history goes in as what the model has seen, a batch per call; no
    // turn runs until a message is sent. Let go of at once, so the Codex app
    // can open it; one left empty by a failure is archived.
    async forkHistory({ cwd, name, items, from, model: picked, authorize = () => {} }) {
      authorize();
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw bad("Choose a folder.");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-history-"));
      const file = path.join(dir, "history.jsonl");
      let dispatched = false;
      try {
        authorize();
        const archive = codexArchive({ cwd, items, from, name });
        await fs.writeFile(file, archive.lines.map(l => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
        authorize();
        const model = await withModel(picked);
        authorize();
        // Keep the recovery archive once dispatch is possible: the target
        // may exist even if the answer or the caller's authority is lost.
        dispatched = true;
        const result = await daemon.rpc("thread/fork", { threadId: archive.id, path: file, cwd, excludeTurns: true, ...(model ? { model } : {}) });
        const threadId = result?.thread?.id;
        if (!UUID.test(threadId || "")) throw uncertainDelivery("codex");
        subscribed.add(threadId);
        try {
          authorize();
          await owner.claim(threadId, result);
          authorize();
          if (name) await daemon.rpc("thread/name/set", { threadId, name: String(name).slice(0, 120) });
          authorize();
        } finally { release(threadId); }
        return { threadId };
      } catch (error) {
        // Only this request's unsent local archive may be removed. Never
        // delete a possible target or discard recovery after dispatch.
        if (!dispatched) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    },
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
      await owner.claim(threadId, started);
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
    async stop(threadId, authorize = () => {}) {
      authorize();
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
      authorize();
      await daemon.rpc("turn/interrupt", { threadId, turnId });
      return { stopped: true };
    },
    // Send now, as the Codex app's Steer on a queued message: into the turn
    // Codex is running (the app's own when it holds the chat), or started
    // now when nothing runs.
    async sendQueuedNow(threadId, messageId) {
      const q = await queuedOne(threadId, messageId);
      const t = state(threadId);
      if (await runningOnDisk(threadId)) {
        if (subscribed.has(threadId) && t.turnId) {
          const removed = await daemon.rpc("thread/queue/delete", { threadId, queuedSubmissionId: messageId });
          if (removed?.deleted !== true) throw bad("That message already left the queue.", 409);
          try {
            await daemon.rpc("turn/steer", { threadId, expectedTurnId: t.turnId, input: q.input });
          } catch (e) {
            if (e.uncertain) {
              // The steer may already have run. Re-adding it would submit it
              // a second time after this turn; leave the outcome for review.
              t.error = uncertainDelivery("codex").message;
              changed(threadId);
            } else {
              // Definitely refused: back in line, so nothing is lost.
              await daemon.rpc("thread/queue/add", { threadId, clientUserMessageId: randomUUID(), input: q.input }).catch(() => {});
            }
            await readQueue(threadId);
            throw e;
          }
        } else {
          await steerElsewhere(threadId, q.input, { queued: messageId });
          // The app takes it out of its queue; made sure of here.
          await daemon.rpc("thread/queue/delete", { threadId, queuedSubmissionId: messageId }).catch(() => {});
        }
      } else {
        await daemon.rpc("thread/queue/start", { threadId, queuedSubmissionId: messageId });
      }
      await readQueue(threadId);
      return { sent: true };
    },
    // The last message edited and sent again, as the Codex app's Edit: only
    // the most recent one, never while Codex works; its pictures kept. When
    // the Codex app holds the chat, the app does it.
    async editLast(threadId, { turnId, text } = {}, authorize = () => {}) {
      authorize();
      if (!UUID.test(threadId) || typeof turnId !== "string" || !turnId || turnId.length > 128) throw bad("Unknown message.", 404);
      const words = String(text ?? "");
      if (!words.trim()) throw bad("Write the message.");
      if (words.length > 50000) throw bad("Messages can be up to 50,000 characters.");
      if (await runningOnDisk(threadId)) throw bad("Codex is working. Stop it first to edit your last message.", 409);
      try {
        await attach(threadId, authorize);
      } catch (e) {
        if (!WRITER_HELD.test(e.message)) throw e;
        authorize();
        const done = await desktop.editLast(threadId, { turnId, message: words });
        state(threadId).items++;
        changed(threadId);
        return done;
      }
      let reverted = false;
      try {
        const r = await daemon.rpc("thread/items/list", { threadId, limit: 50, sortDirection: "desc" });
        const latest = (r?.data || []).find((entry) => entry?.item?.type === "userMessage");
        if (!latest || latest.turnId !== turnId) throw bad("Only your most recent message can be edited.", 409);
        const content = Array.isArray(latest.item.content) ? latest.item.content : [];
        const at = content.findIndex((c) => c?.type === "text");
        const input =
          at < 0
            ? [{ type: "text", text: words, text_elements: [] }, ...content]
            : content.map((c, i) => (i === at ? { ...c, text: words, text_elements: [] } : c));
        authorize();
        await daemon.rpc("thread/revert", { threadId, beforeTurnId: turnId });
        reverted = true;
        authorize();
        const started = await daemon.rpc("turn/start", { threadId, input, clientUserMessageId: randomUUID() });
        authorize();
        begin(threadId, started.turn);
        return { edited: true, turnId: started.turn?.id || null };
      } catch (e) {
        try { authorize(); release(threadId); } catch {}
        // The old message is already gone: hand the edited text back, never lose it silently.
        if (reverted) throw bad(`The edit could not be sent and the earlier message was removed. Your edited text was: ${words}`, e?.status || 502);
        throw e;
      }
    },
    // A new order for what waits, as dragged in the Codex app.
    async reorderQueued(threadId, order) {
      if (!UUID.test(threadId) || !Array.isArray(order) || order.length > 100 || !order.every((id) => typeof id === "string" && id && id.length <= 128))
        throw bad("Invalid order.");
      await daemon.rpc("thread/queue/reorder", { threadId, queuedSubmissionIds: order });
      await readQueue(threadId);
      return { reordered: true };
    },
    // A queued message's words changed in place, its pictures kept.
    async editQueued(threadId, messageId, text) {
      const q = await queuedOne(threadId, messageId);
      const words = String(text ?? "");
      if (words.length > 50000) throw bad("Messages can be up to 50,000 characters.");
      const input = [...(words.trim() ? [{ type: "text", text: words, text_elements: [] }] : []), ...q.input.filter((i) => i?.type !== "text")];
      if (!input.length) throw bad("Write a message or keep its pictures.");
      await daemon.rpc("thread/queue/update", { threadId, queuedSubmissionId: messageId, input });
      await readQueue(threadId);
      return { edited: true };
    },
    async cancelQueued(threadId, messageId, authorize = () => {}) {
      authorize();
      if (!UUID.test(threadId) || typeof messageId !== "string" || !messageId || messageId.length > 128)
        throw bad("Unknown queued message.", 404);
      // One Reach took back: dismissed here.
      const t = threads.get(threadId);
      if (t?.returned?.some((m) => m.id === messageId)) {
        t.returned = t.returned.filter((m) => m.id !== messageId);
        changed(threadId);
        return { deleted: true };
      }
      authorize();
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
      if (prompt.attempted) throw bad("This answer was already attempted. Check Codex before answering again.", 409);
      const response = answerFor(prompt, answer);
      prompt.replying = true;
      prompt.attempted = true;
      try {
        await prompt.resolve(response);
        t.prompts.delete(String(promptId));
        t.nativeRequests.delete(String(promptId));
        if (!t.prompts.size && t.status === "waiting") t.status = "running";
        changed(threadId);
        return { answered: true };
      } catch (error) {
        prompt.replying = false;
        t.error = error.message;
        changed(threadId);
        throw error;
      } finally {
        prompt.replying = false;
      }
    },
    contextOf: (threadId) => contexts.get(threadId) || null,
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
        prompts: [...t.prompts.values()].map(({ resolve, requestId, replying, attempted, ...p }) => ({ ...p, ...(attempted && !replying ? { attempted: true } : {}) })),
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
