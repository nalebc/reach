// OpenClaw's background work, told to your phone: a schedule (cron) run
// finishing or failing, a sub-agent finishing or failing, and either going
// quiet while still marked running. Fed by the Gateway's events
// (client.onEvent); notifications.mjs reads items() and pushes each once.
// Only cron and sub-agent sessions: chats you started in Reach aren't these.
// Names are capped and cleaned; OpenClaw's error text never leaves here.
import { pushLine } from "./notification-items.mjs";

const CRON = /^agent:[^:]+:cron:([^:]+)/i;
const SUB = /^agent:([^:]+):(?:.*:)?subagent:/i;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// Chats a phone has open now (it polls their changes and history), per
// client: a run seen there isn't pushed (as done-watch does for chats).
const open = new WeakMap(); // client -> Map(key -> at)
const WATCH_MS = 15000;
export function routes(app, client, { base }) {
  const mark = (req, _res, next) => {
    const key = req.query?.key;
    if (typeof key === "string" && key && key.length <= 500) {
      if (!open.has(client)) open.set(client, new Map());
      const keys = open.get(client);
      keys.delete(key);
      keys.set(key, Date.now());
      if (keys.size > 200) keys.delete(keys.keys().next().value);
    }
    next();
  };
  // Registered before openclaw.mjs's own handlers, which then answer.
  app.get(`${base}/changes`, mark);
  app.get(`${base}/history`, mark);
}

export function createOpenClawWatch({
  client,
  now = Date.now,
  // A run with no event for this long, still running, is "quiet".
  quietMs = 10 * 60000,
  // How long a finished or failed alert stays to be pushed.
  keepMs = 30 * 60000,
  // A failed model may be followed by OpenClaw's next under the same runId
  // (as updateRun in openclaw.mjs): failed only if none starts in time.
  graceMs = 15000,
  everyMs = 60000,
  // No event at all (the Gateway ticks every 30 s) for this long: the
  // connection is down, so silence proves nothing.
  liveMs = 90000,
  setTimer = setInterval,
  clearTimer = clearInterval,
  later = setTimeout,
  cancel = clearTimeout,
}) {
  const runs = new Map(); // runId -> sub-agent run
  const crons = new Map(); // jobId -> schedule run
  const ended = new Set(); // runIds already told (late events ignored)
  const alerts = new Map(); // id -> item
  const jobNames = new Map();
  const agentNames = new Map();
  const listeners = new Set();
  let lastEventAt = 0,
    namesAt = null,
    naming = null,
    agentsAt = null,
    closed = false;
  const watchedKeys = () => {
    const at = Date.now();
    return [...(open.get(client) || [])]
      .filter(([, seen]) => at - seen < WATCH_MS)
      .map(([key]) => key);
  };
  // The run's own chat, or the chat that spawned it (sessions.list's
  // spawnedBy), open on a phone: it's seen there.
  const watched = async (key) => {
    const keys = watchedKeys();
    if (!keys.length || typeof key !== "string") return false;
    if (keys.includes(key)) return true;
    if (client.can && !client.can("sessions.list")) return false;
    for (const parent of keys.slice(-5))
      try {
        const result = await client.call("sessions.list", { spawnedBy: parent, limit: 200 });
        if (result?.sessions?.some?.((s) => s?.key === key)) return true;
      } catch {}
    return false;
  };
  const changed = () => {
    for (const listener of listeners)
      try {
        listener();
      } catch {}
  };
  const name = (value, limit) => pushLine(String(value || ""), limit);
  const jobName = (jobId, known) => name(known || jobNames.get(jobId), 60);
  const agentName = (id) =>
    name(agentNames.get(id), 40) || (AGENT_ID.test(id || "") ? id : "OpenClaw");
  // Schedule names from cron.list (a one-shot job is removed right after it
  // finishes, so names are learnt when it starts).
  const learnNames = () => {
    if (naming || (namesAt != null && now() - namesAt < 60000)) return naming;
    naming = (async () => {
      for (let offset = 0, page = 0; page < 4; page++) {
        const result = await client.automations({ offset });
        for (const job of result.jobs || []) jobNames.set(job.id, job.name);
        if (!result.hasMore) break;
        offset = result.nextOffset;
      }
      namesAt = now();
      for (const run of crons.values()) run.name ||= jobNames.get(run.jobId);
    })()
      .catch(() => {})
      .finally(() => (naming = null));
    return naming;
  };
  const learnAgents = () => {
    if (agentsAt != null && now() - agentsAt < 3600000) return;
    agentsAt = now();
    Promise.resolve()
      .then(() => client.catalog())
      .then((c) => {
        for (const a of c?.agents || [])
          if (typeof a?.id === "string" && typeof a.name === "string")
            agentNames.set(a.id, a.name);
      })
      .catch(() => (agentsAt = null));
  };
  const remember = (runId) => {
    ended.add(runId);
    if (ended.size > 2048) ended.delete(ended.values().next().value);
  };
  const alert = (item, key) => {
    if (watchedKeys().length)
      return void watched(key).then((seen) => {
        if (!seen && !closed) put(item);
      });
    put(item);
  };
  const put = (item) => {
    alerts.set(item.id, {
      source: "openclaw-watch",
      sender: "OpenClaw",
      icon: "openclaw",
      kind: "background",
      category: "done",
      // Pushed, not listed under Needs you: nothing here waits on you.
      bell: false,
      createdAt: now(),
      expiresAt: now() + keepMs,
      ...item,
    });
    changed();
  };
  const unquiet = (id) => {
    if (alerts.delete(`openclaw-watch:quiet:${id}`)) changed();
  };
  const target = (key) => ({
    page: "sessions",
    agent: "openclaw",
    ...(typeof key === "string" && key.length <= 500 && { id: key }),
  });
  const finishSub = (runId, failed) => {
    const run = runs.get(runId);
    if (!run) return;
    cancel(run.failTimer);
    runs.delete(runId);
    remember(runId);
    unquiet(runId);
    const who = agentName(run.agentId);
    alert({
      id: `openclaw-watch:sub:${runId}`,
      signature: runId,
      title: `${who} sub-agent ${failed ? "failed" : "finished"}`,
      detail: failed ? "It stopped with an error." : "Its result is ready.",
      target: target(run.key),
    }, run.key);
  };
  const failLater = (run) => {
    if (run.failTimer) return;
    run.failTimer = later(() => {
      run.failTimer = null;
      finishSub(run.runId, true);
    }, graceMs);
    run.failTimer?.unref?.();
  };
  const subRun = (p, create) => {
    let run = runs.get(p.runId);
    if (!run && create && !ended.has(p.runId)) {
      if (runs.size >= 256) return null;
      run = {
        runId: p.runId,
        key: p.sessionKey,
        agentId: SUB.exec(p.sessionKey)[1],
        lastAt: now(),
      };
      runs.set(p.runId, run);
      learnAgents();
    }
    return run;
  };
  const forget = () => {
    for (const run of runs.values()) cancel(run.failTimer);
    runs.clear();
    crons.clear();
  };
  const onEvent = (event, p) => {
    // Back after a silence (the connection dropped): ends may have been
    // missed, so what was running is unknown.
    if (lastEventAt && now() - lastEventAt > liveMs) forget();
    lastEventAt = now();
    if (!p || typeof p !== "object") return;
    if (event === "shutdown") {
      // What runs after a Gateway restart is unknown: tell nothing.
      forget();
      return;
    }
    if (event === "cron") {
      if (typeof p.jobId !== "string" || !p.jobId || p.jobId.length > 200)
        return;
      if (["added", "updated", "removed"].includes(p.action)) namesAt = null;
      if (p.action === "started") {
        crons.set(p.jobId, {
          jobId: p.jobId,
          name: jobNames.get(p.jobId),
          lastAt: now(),
        });
        if (crons.size > 256) crons.delete(crons.keys().next().value);
        if (!jobNames.has(p.jobId)) namesAt = null;
        void learnNames();
      }
      if (p.action === "finished") {
        const run = crons.get(p.jobId);
        crons.delete(p.jobId);
        unquiet(`cron:${p.jobId}`);
        // "skipped": it didn't run (disabled, busy…); nothing to tell.
        if (!["ok", "error"].includes(p.status)) return;
        const job = jobName(p.jobId, run?.name);
        alert({
          id: `openclaw-watch:cron:${p.jobId}`,
          signature: String(
            Number.isFinite(p.runAtMs) ? p.runAtMs : now(),
          ),
          title: `Schedule ${job ? `${job} ` : ""}${p.status === "ok" ? "finished" : "failed"}`,
          detail:
            p.status === "ok" ? "Its run is done." : "It stopped with an error.",
          target: target(p.sessionKey),
        }, p.sessionKey);
      }
      return;
    }
    if (!["agent", "chat"].includes(event)) return;
    if (typeof p.sessionKey !== "string" || typeof p.runId !== "string" || !p.runId)
      return;
    const cron = CRON.exec(p.sessionKey);
    if (cron) {
      // Its end is told by the "cron" event; here, only signs of life.
      const run = crons.get(cron[1]);
      if (run) {
        run.lastAt = now();
        unquiet(`cron:${run.jobId}`);
      }
      return;
    }
    if (!SUB.test(p.sessionKey) || ended.has(p.runId)) return;
    // OpenClaw's own notice of a sequence gap, not the run's.
    if (event === "agent" && p.stream === "error") return;
    const phase =
      event === "chat"
        ? { delta: "live", final: "end", error: "error", aborted: "aborted" }[p.state]
        : p.stream === "lifecycle"
          ? { start: "live", end: "end", error: "error" }[p.data?.phase]
          : "live";
    if (!phase) return;
    // An end whose start came before Reach listened is still told.
    const run = subRun(p, phase !== "aborted");
    if (!run) return;
    if (phase === "live") {
      run.lastAt = now();
      // The next model took over: not failed.
      cancel(run.failTimer);
      run.failTimer = null;
      unquiet(run.runId);
    } else if (phase === "error") failLater(run);
    else if (phase === "end") finishSub(run.runId, false);
    else {
      // Stopped on purpose: nothing to tell.
      cancel(run.failTimer);
      runs.delete(run.runId);
      remember(run.runId);
      unquiet(run.runId);
    }
  };
  // Quiet runs, each confirmed still running before it's told.
  let checking = null;
  const check = () => {
    if (checking || closed) return checking;
    checking = (async () => {
      for (const [id, item] of alerts)
        if (item.expiresAt <= now()) {
          alerts.delete(id);
          changed();
        }
      if (now() - lastEventAt > liveMs) return;
      const minutes = Math.round(quietMs / 60000);
      for (const run of [...runs.values()]) {
        if (now() - run.lastAt < quietMs || run.quietAt === run.lastAt) continue;
        let status;
        try {
          status = (await client.call("agent.wait", { runId: run.runId, timeoutMs: 1 }))
            ?.status;
        } catch {
          continue;
        }
        if (runs.get(run.runId) !== run) continue;
        if (status === "ok" || status === "error") {
          finishSub(run.runId, status === "error");
          continue;
        }
        if (status !== "timeout") continue;
        run.quietAt = run.lastAt;
        alert({
          id: `openclaw-watch:quiet:${run.runId}`,
          signature: String(run.lastAt),
          title: `Quiet for ${minutes} min`,
          detail: `${agentName(run.agentId)} sub-agent is still marked running.`,
          target: target(run.key),
        }, run.key);
      }
      const quietCrons = [...crons.values()].filter(
        (run) => now() - run.lastAt >= quietMs && run.quietAt !== run.lastAt,
      );
      if (!quietCrons.length) return;
      // Still running per OpenClaw's own list.
      let jobs;
      try {
        jobs = [];
        for (let offset = 0, page = 0; page < 4; page++) {
          const result = await client.automations({ offset });
          jobs.push(...(result.jobs || []));
          if (!result.hasMore) break;
          offset = result.nextOffset;
        }
      } catch {
        return;
      }
      for (const run of quietCrons) {
        const job = jobs.find((j) => j.id === run.jobId);
        if (crons.get(run.jobId) !== run) continue;
        if (job?.status !== "running") {
          // Its end was missed: nothing reliable to tell.
          crons.delete(run.jobId);
          continue;
        }
        run.quietAt = run.lastAt;
        const label = jobName(run.jobId, job.name || run.name);
        alert({
          id: `openclaw-watch:quiet:cron:${run.jobId}`,
          signature: String(run.lastAt),
          title: `Quiet for ${minutes} min`,
          detail: `Schedule ${label ? `${label} ` : ""}is still marked running.`,
          target: target(),
        });
      }
    })()
      .catch(() => {})
      .finally(() => (checking = null));
    return checking;
  };
  const stopEvents = client.onEvent?.((event, payload) => {
    try {
      onEvent(event, payload);
    } catch {}
  });
  const timer = setTimer(() => void check(), everyMs);
  timer?.unref?.();
  return {
    // For notifications' read: current alerts, newest first.
    items() {
      const at = now();
      return [...alerts.values()]
        .filter((item) => item.expiresAt > at)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    // Told when an alert comes or goes (notifications.wake).
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    close() {
      closed = true;
      stopEvents?.();
      clearTimer(timer);
      for (const run of runs.values()) cancel(run.failTimer);
    },
  };
}
