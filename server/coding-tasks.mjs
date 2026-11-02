// Single-turn coding work owned by an invited agent. The provider thread is
// private bookkeeping: callers can neither pick one nor continue/approve it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, fail, isPlainRecord } from "./core.mjs";
import { FULL_CONTROL_VERSION, validPresetPolicy } from "./agent-presets.mjs";
import { turnOutcome } from "./agent-sessions/turn-watch.mjs";
import { RESULT_BYTES, clipResultText, jsonBytes, recordedTurnResult, readOriginalTurn, restoreResult, resultContentHash, resultWithGaps, stampResult } from "./agent-sessions/result-evidence.mjs";

const ACTIVE = new Set(["starting", "running", "waiting", "cancelling"]);
const STATES = new Set([...ACTIVE, "completed", "failed", "cancelled", "interrupted", "uncertain"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST = /^[A-Za-z0-9_-]{8,80}$/;
export const CODING_RESULT_BYTES = RESULT_BYTES;
const bytes = jsonBytes, clipped = clipResultText;
const blankResult = (binding = {}) => recordedTurnResult([], { binding });

export function codingAgentAllowed(client, agent = "codex") {
  if (client?.kind !== "agent") return false;
  if (client.policy?.browser === true)
    return validPresetPolicy(client.policy) && client.policy.preset === "full" &&
      client.policy.fullControlVersion === FULL_CONTROL_VERSION && client.scopes?.includes("browser:shell");
  // Existing legacy access named Codex does not silently grant Claude too.
  return agent === "codex" && client.scopes?.includes("codex") === true;
}

export function codingTaskInput(body) {
  const fields = ["requestId", "agent", "root", "path", "task", "title", "timeoutSeconds"];
  if (!isPlainRecord(body) || Object.keys(body).some((key) => !fields.includes(key)))
    throw fail(400, "This coding task contains unsupported fields.");
  const { requestId, agent, root = 0, path: folder = "", task, title = "", timeoutSeconds = 1800 } = body;
  if (typeof requestId !== "string" || !REQUEST.test(requestId)) throw fail(400, "Use a requestId of 8–80 letters, digits, underscores or dashes. Reuse it when retrying this task.");
  if (!["codex", "claude"].includes(agent)) throw fail(400, "Choose codex or claude.");
  if (!Number.isSafeInteger(root) || root < 0 || typeof folder !== "string" || folder.length > 4096 || /[\0\r\n]/.test(folder))
    throw fail(400, "Choose a project in a shared folder.");
  if (typeof task !== "string" || !task.trim() || task.length > 16000 || task.includes("\0")) throw fail(400, "Describe the task in up to 16,000 characters.");
  if (typeof title !== "string" || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) throw fail(400, "Use a title of up to 120 characters on one line.");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 3600) throw fail(400, "Choose a task timeout from 60 to 3,600 seconds.");
  return { requestId, agent, root, path: folder, task: task.trim(), title: title.trim(), timeoutSeconds };
}

// Only material recorded in the initial task turn. Never a worktree-wide diff
// (which would attribute existing edits to this task), thoughts or app prompts.
export const codingTaskResult = recordedTurnResult;

export function createCodingTasks({
  file, sessions, authorize, resolveProject, validateProject = () => {}, now = Date.now,
  maxRunning = 4, maxPerClient = 2, maxRecords = 2000, everyMs = 1000, shutdownMs = 5000,
}) {
  const records = new Map(), results = new Map(), launches = new Map(), refreshing = new Map(), stopping = new Map(), waiters = new Map();
  const resultsDir = file && path.join(path.dirname(file), "coding-task-results");
  let closed = false, unreadable = false, timer = null, sweeping = null, closing = null;
  const host = () => typeof sessions === "function" ? sessions() : sessions;
  if (file && fs.existsSync(file)) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isPlainRecord(stored) || stored.version !== 1 || !Array.isArray(stored.tasks) || stored.tasks.length > maxRecords) throw Error();
      const requests = new Set();
      for (const r of stored.tasks) {
        const requestKey = `${r.clientId}:${r.requestId}`;
        if (!isPlainRecord(r) || !UUID.test(r.id) || typeof r.clientId !== "string" || !r.clientId || !REQUEST.test(r.requestId) ||
            !/^[a-f0-9]{64}$/.test(r.inputHash) || !["codex", "claude"].includes(r.agent) || !STATES.has(r.status) ||
            typeof r.cwd !== "string" || !path.isAbsolute(r.cwd) || !isPlainRecord(r.project) ||
            !Number.isSafeInteger(r.project.root) || r.project.root < 0 || typeof r.project.path !== "string" || r.project.path.length > 4096 ||
            typeof r.title !== "string" || r.title.length > 120 || !Number.isFinite(r.deadline) || !Number.isFinite(r.createdAt) ||
            !Number.isFinite(r.updatedAt) || !Number.isSafeInteger(r.version) || (r.threadId !== undefined && !UUID.test(r.threadId)) ||
            (r.ownerDefaults !== undefined && typeof r.ownerDefaults !== "boolean") ||
            records.has(r.id) || requests.has(requestKey)) throw Error();
        requests.add(requestKey);
        records.set(r.id, r);
      }
    } catch { records.clear(); unreadable = true; }
  }
  const ready = () => { if (unreadable) throw fail(503, "Reach could not read the coding-task ledger. No new task will start until it is repaired."); };
  const save = () => {
    if (!file) return;
    try { atomicJson(file, { version: 1, tasks: [...records.values()] }); }
    catch { throw fail(507, "The coding task could not be saved. Check free disk space before retrying with the same requestId."); }
  };
  const wake = (r) => { for (const done of waiters.get(r.id) || []) done(); };
  const change = (r, values) => {
    if (Object.entries(values).every(([key, value]) => JSON.stringify(r[key]) === JSON.stringify(value))) return;
    Object.assign(r, values, { updatedAt: now(), version: r.version + 1 });
    save();
    wake(r);
  };
  // After a crash no delegated prompt is replayed. Known original turns are
  // interrupted by sweep(); an uncertain start stays associated with its ID.
  let recovered = false;
  for (const r of records.values()) if (ACTIVE.has(r.status)) {
    Object.assign(r, { status: r.threadId ? "interrupted" : "uncertain", cancelRequested: true, reason: "Reach restarted. This task was not resumed.", updatedAt: now(), version: r.version + 1 });
    recovered = true;
  }
  if (recovered) try { save(); } catch { unreadable = true; }
  const permitted = (clientId, r) => {
    ready();
    const client = authorize(clientId, r);
    if (!codingAgentAllowed(client, r?.agent)) throw fail(403, "Coding tasks need Full control access. Legacy Codex access can start Codex tasks only.");
    if (r?.cwd) validateProject(client, r.cwd);
    return client;
  };
  const owned = (clientId, taskId) => {
    ready();
    const r = records.get(taskId);
    if (!r || r.clientId !== clientId) throw fail(404, "Unknown coding task.");
    return r;
  };
  const resultFor = (r) => {
    if (results.has(r.id)) return results.get(r.id);
    let value = blankResult({ provider: r.agent, chatId: r.threadId, taskId: r.id, attempt: 1, turnId: r.boundary?.turnId });
    if (resultsDir) try {
      const raw = fs.readFileSync(path.join(resultsDir, `${r.id}.json`), "utf8");
      if (Buffer.byteLength(raw) > CODING_RESULT_BYTES + 1024) throw Error();
      const stored = JSON.parse(raw);
      value = restoreResult(stored, { binding: value.provenance, frozen: !ACTIVE.has(r.status) });
      if (r.resultDigest && (r.resultDigest !== value.evidenceDigest || r.resultVersion !== value.evidenceVersion)) throw Error();
    } catch { value = stampResult(recordedTurnResult([], { binding: value.provenance, historyIncomplete: true, gaps: ["collection_failed"] }), { frozen: !ACTIVE.has(r.status), at: now() }); }
    results.set(r.id, value);
    return value;
  };
  const metadata = (r) => ({
    id: r.id, requestId: r.requestId, agent: r.agent, title: r.title, project: r.project, status: r.status,
    createdAt: r.createdAt, updatedAt: r.updatedAt, deadline: r.deadline, version: r.version,
    needsOwner: r.status === "waiting", ...(r.cancelRequested && !r.stopConfirmed ? { cancellationPending: true } : {}), ...(r.reason ? { reason: r.reason } : {}),
  });
  const view = (r) => {
    const result = structuredClone(resultFor(r));
    // Coding-task callers own a delegated task, not its provider chat. Keep
    // that identity binding in private storage, as before, rather than
    // granting a locator into owner session/approval APIs through evidence.
    result.provenance.chatId = null;
    result.provenance.turnId = null;
    for (const item of [...result.commands, ...result.changes]) { item.turnId = null; item.itemId = null; }
    return { ...metadata(r), ...result, source: "provider_reported", provenanceRedacted: true, evidenceDigestScope: "stored_record" };
  };
  const assertRun = (r) => {
    if (closed || r.cancelRequested) throw fail(409, "This coding task was cancelled.");
    const client = permitted(r.clientId, r);
    if (client.codingPaused) throw fail(409, "The owner paused this agent. Resume it in Reach before starting coding work.");
    if (r.ownerDefaults && (client.policy?.browser !== true || client.policy.preset !== "full" || client.policy.fullControlVersion !== FULL_CONTROL_VERSION))
      throw fail(403, "The Full control grant for this coding task ended.");
    const deadline = Math.min(r.deadline, client.expiresAt, r.createdAt + (client.maxJobMs || 3600000));
    if (deadline < r.deadline) change(r, { deadline });
    if (now() >= r.deadline || !(client.expiresAt > now())) throw fail(403, "The task deadline or its access has ended.");
    return client;
  };
  const interrupt = (r) => {
    if (!r.threadId || r.stopConfirmed) return Promise.resolve();
    if (stopping.has(r.id)) return stopping.get(r.id);
    const pending = (async () => {
      try {
        const stopped = await host().stopCodingTask(r.agent, r.threadId, { ...r.boundary, taskTextPrefix: `Reach delegated coding task ${r.id}.` });
        if (stopped?.stopped === false && stopped?.uncertain) throw Error("The original turn's stop could not be confirmed. Check this task in Reach.");
        if (stopped?.turnChanged) change(r, { stopConfirmed: true, status: "interrupted", reason: "This chat continued outside the delegated task. Reach left that work with the owner." });
        else change(r, { stopConfirmed: true, status: ["failed", "interrupted", "uncertain"].includes(r.status) ? r.status : "cancelled", reason: r.reason || "Cancelled." });
      } catch (error) {
        // Cancellation is durable and retried. An unacknowledged interrupt
        // must never appear as a confirmed cancellation.
        change(r, { status: ["failed", "interrupted", "uncertain"].includes(r.status) ? r.status : "cancelling", reason: clipped(error?.message || "Stopping has not been confirmed. Check this task in Reach.", 1000).text });
      }
    })().finally(() => stopping.delete(r.id));
    stopping.set(r.id, pending);
    return pending;
  };
  const requestCancel = (r, reason = "Cancelled by the requesting agent.") => {
    if (!ACTIVE.has(r.status) && !r.cancelRequested) return Promise.resolve();
    if (!r.cancelRequested) change(r, { cancelRequested: true, status: "cancelling", reason });
    if (!launches.has(r.id)) return interrupt(r);
    // startCodingTask rechecks assertRun, and its late result is still kept.
    return Promise.resolve();
  };
  const original = (r) => readOriginalTurn({ read: (...args) => host().read(...args), agent: r.agent, chatId: r.threadId,
    requestPrefix: `Reach delegated coding task ${r.id}.`, turnId: r.boundary?.turnId, authorize: () => assertRun(r) });
  const refresh = (r) => {
    if (!ACTIVE.has(r.status) || !r.threadId || launches.has(r.id) || r.cancelRequested) return Promise.resolve();
    if (refreshing.has(r.id)) return refreshing.get(r.id);
    const pending = (async () => {
      try {
        assertRun(r);
        const current = await original(r);
        assertRun(r);
        const live = host().view?.(r.agent, r.threadId) || {};
        const state = live.status || current.session?.status;
        let status = r.status;
        if (current.later) status = turnOutcome(current.items).kind === "reply" ? "completed" : "interrupted";
        else if (state === "waiting" || live.prompts?.length || current.items.at(-1)?.questions?.length) status = "waiting";
        else if (state === "error" || live.error) status = "failed";
        else if (state === "idle" && current.found) {
          const outcome = turnOutcome(current.items);
          status = outcome.kind === "reply" ? "completed" : outcome.kind === "error" ? "failed" : outcome.kind === "stopped" ? "cancelled" : "interrupted";
        } else if (state === "running") status = "running";
        // An unknown/new provider state is still active, never completed.
        const previous = resultFor(r);
        const nextBody = current.found ? codingTaskResult(current.items, { historyIncomplete: current.incomplete,
          gaps: current.gaps, binding: { provider: r.agent, chatId: r.threadId, taskId: r.id, attempt: 1, turnId: current.turnId || r.boundary?.turnId } }) :
          resultWithGaps(previous, current.gaps);
        let next = stampResult(nextBody, { version: (previous.evidenceVersion || 0) + 1, frozen: !ACTIVE.has(status), at: now() });
        if (resultContentHash(next) === resultContentHash(previous) && next.evidenceFrozen === previous.evidenceFrozen) next = previous;
        if (status !== r.status || next !== previous) {
          if (resultsDir) atomicJson(path.join(resultsDir, `${r.id}.json`), next);
          results.set(r.id, next);
          change(r, { status, resultVersion: next.evidenceVersion, resultDigest: next.evidenceDigest,
            ...(status === "failed" ? { cancelRequested: true, reason: clipped(live.error || "The coding agent ended with an error. See recorded output.", 1000).text } : {}) });
          if (status === "failed") await interrupt(r);
        }
      } catch (error) {
        try { assertRun(r); }
        catch { await requestCancel(r, "The requesting agent's access, project or task deadline ended."); return; }
        // A transient read error is not a finished task. Deadline and live
        // grant checks continue on every sweep.
      }
    })().finally(() => refreshing.delete(r.id));
    refreshing.set(r.id, pending);
    return pending;
  };
  const launch = async (r, input) => {
    try {
      const client = assertRun(r);
      const started = await host().startCodingTask(r.agent, {
        ownerDefaults: r.ownerDefaults === true,
        cwd: r.cwd, name: `${String(client.name || "Invited agent").slice(0, 80)}: ${r.title}`.slice(0, 120),
        text: `Reach delegated coding task ${r.id}.\nRequested by ${String(client.name || "an invited agent").slice(0, 80)} through Reach.\n\n${input.task}\n\nFinish with a summary of the changes and the commands you actually ran, including failures or remaining work.`,
        authorize: () => assertRun(r),
        onCreated: ({ threadId }) => {
          if (!UUID.test(threadId)) throw fail(502, "The coding agent returned an invalid thread ID.");
          // Keep the mapping in memory even if saving fails; the catch and
          // shutdown paths still know which provider turn must be stopped.
          change(r, { threadId });
          assertRun(r);
        },
        onStarted: (boundary) => {
          change(r, { boundary: { ...(boundary.turnId ? { turnId: boundary.turnId } : {}), ...(boundary.generation ? { generation: boundary.generation } : {}) }, stopConfirmed: false });
        },
      });
      if (!UUID.test(started?.threadId)) throw fail(502, "The coding agent did not return a task session.");
      change(r, { threadId: started.threadId, boundary: { ...(started.turnId ? { turnId: started.turnId } : {}), ...(started.generation ? { generation: started.generation } : {}) }, stopConfirmed: false });
      assertRun(r);
      change(r, { status: "running" });
    } catch (error) {
      if (r.cancelRequested || closed) {
        if (!r.threadId && !error?.uncertain) change(r, { cancelRequested: true, status: "cancelled", stopConfirmed: true, reason: r.reason || "Cancelled before the coding agent started." });
        else if (!r.threadId) change(r, { cancelRequested: true, status: "uncertain", reason: "The coding agent's start could not be confirmed. Check Reach before starting another task." });
        else if (!r.cancelRequested) change(r, { cancelRequested: true, status: "cancelling", reason: "Reach is shutting down." });
      } else {
        change(r, { status: r.threadId || error?.uncertain ? "uncertain" : "failed", cancelRequested: !!r.threadId,
          reason: clipped(error?.message || "The task could not start. Retry with the same requestId to check it.", 1000).text });
      }
    }
  };
  const sweep = () => {
    if (closed || unreadable) return Promise.resolve();
    const work = [];
    // Live authorization is checked every tick even when another provider's
    // read is slow. Provider reads/interrupts coalesce per task below.
    for (const r of records.values()) {
      if (r.cancelRequested && !r.stopConfirmed) { if (!launches.has(r.id)) work.push(interrupt(r)); continue; }
      if (!ACTIVE.has(r.status)) continue;
      try { assertRun(r); }
      catch { work.push(requestCancel(r, "The requesting agent's access, project or task deadline ended.")); continue; }
      work.push(refresh(r));
    }
    sweeping = Promise.allSettled(work);
    return sweeping;
  };
  const api = {
    ownsSession: (agent, threadId) => unreadable || [...records.values()].some((r) => r.agent === agent && r.threadId === threadId),
    start(clientId, body) {
      ready();
      if (closed) throw fail(503, "Reach is shutting down.");
      const input = codingTaskInput(body);
      const client = permitted(clientId, { agent: input.agent });
      if (client.codingPaused) throw fail(409, "The owner paused this agent. Resume it in Reach before starting coding work.");
      const inputHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const existing = [...records.values()].find((r) => r.clientId === clientId && r.requestId === input.requestId);
      if (existing) {
        if (existing.inputHash !== inputHash) throw fail(409, "This requestId already belongs to a different coding task.");
        return view(existing);
      }
      if (records.size >= maxRecords) throw fail(429, "The coding-task history is full. Ask the owner to archive it before starting more tasks.");
      const busy = [...records.values()].filter((r) => ACTIVE.has(r.status) || (r.cancelRequested && !r.stopConfirmed));
      if (busy.length >= maxRunning || busy.filter((r) => r.clientId === clientId).length >= maxPerClient) throw fail(429, "Too many coding tasks are active. Wait for one to finish or cancel it.");
      const cwd = resolveProject(client, input.root, input.path);
      validateProject(client, cwd);
      const at = now();
      const r = { id: crypto.randomUUID(), clientId, requestId: input.requestId, inputHash, agent: input.agent,
        ownerDefaults: client.policy?.browser === true && client.policy.preset === "full" && client.policy.fullControlVersion === FULL_CONTROL_VERSION,
        project: { root: input.root, path: input.path }, cwd, title: input.title || input.task.split("\n")[0].replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120),
        status: "starting", createdAt: at, updatedAt: at, version: 1,
        deadline: Math.min(at + input.timeoutSeconds * 1000, client.expiresAt, at + (client.maxJobMs || 3600000)) };
      if (!(r.deadline > at)) throw fail(403, "The requesting agent's access has ended.");
      records.set(r.id, r);
      try { save(); } catch (e) { records.delete(r.id); throw e; }
      results.set(r.id, blankResult({ provider: r.agent, taskId: r.id, attempt: 1 }));
      // Persist before any provider call; shared in-flight work belongs to
      // this record even if the response is lost or the client rotates keys.
      const pending = Promise.resolve().then(() => launch(r, input)).finally(async () => {
        launches.delete(r.id);
        if (r.cancelRequested) await interrupt(r);
        else await refresh(r);
      }).catch(() => {});
      launches.set(r.id, pending);
      return view(r);
    },
    list(clientId) {
      permitted(clientId);
      const own = [...records.values()].filter((r) => r.clientId === clientId);
      const response = { tasks: [] };
      for (const r of own.slice(-50).reverse()) {
        const item = metadata(r);
        if (bytes({ tasks: [...response.tasks, item], truncated: true }) > CODING_RESULT_BYTES) break;
        response.tasks.push(item);
      }
      if (response.tasks.length < own.length) response.truncated = true;
      return response;
    },
    async get(clientId, taskId, { after, waitSeconds = 0, signal } = {}) {
      const r = owned(clientId, taskId);
      permitted(clientId, r);
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0) || !Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 25)
        throw fail(400, "Use a nonnegative version and waitSeconds from 0 to 25.");
      let readingCutoff;
      // MCP transports have a request deadline; a slow provider must not
      // consume it before a requested 25-second status wait even begins.
      await Promise.race([refresh(r), new Promise((resolve) => { readingCutoff = setTimeout(resolve, 5000); })]);
      clearTimeout(readingCutoff);
      if (after === r.version && ACTIVE.has(r.status) && waitSeconds && !signal?.aborted) await new Promise((resolve) => {
        const done = () => { clearTimeout(timeout); waiters.get(r.id)?.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        const timeout = setTimeout(done, waitSeconds * 1000);
        const group = waiters.get(r.id) || new Set();
        waiters.set(r.id, group.add(done));
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted || r.version !== after) done();
      });
      permitted(clientId, r);
      return view(r);
    },
    async cancel(clientId, taskId) {
      const r = owned(clientId, taskId);
      permitted(clientId, r);
      await requestCancel(r);
      return view(r);
    },
    cancelClient(clientId, reason = "The owner ended or paused the requesting agent's access.") {
      return Promise.all([...records.values()].filter((r) => r.clientId === clientId).map((r) => requestCancel(r, reason)));
    },
    sweep,
    startMonitoring() {
      if (timer || closed) return;
      timer = setInterval(() => void sweep(), everyMs);
      timer.unref?.();
      void sweep();
    },
    close() {
      if (closing) return closing;
      closed = true;
      clearInterval(timer);
      // Do not leave the daemon running delegated turns after the server
      // releases its socket. Persist cancellation before asking it to stop.
      const cancellations = [];
      for (const r of records.values()) if (ACTIVE.has(r.status)) {
        try { cancellations.push(requestCancel(r, "Reach is shutting down. This task will not resume automatically.")); }
        catch { cancellations.push(interrupt(r)); }
      }
      const work = [...cancellations, ...launches.values(), ...stopping.values(), ...refreshing.values(), sweeping].filter(Boolean);
      closing = (async () => {
        let cutoff;
        await Promise.race([Promise.allSettled(work), new Promise((resolve) => { cutoff = setTimeout(resolve, shutdownMs); })]);
        clearTimeout(cutoff);
        for (const group of waiters.values()) for (const done of group) done();
      })();
      return closing;
    },
  };
  return api;
}
