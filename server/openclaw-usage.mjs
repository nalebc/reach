// OpenClaw feature: usage. Routes under /api/sessions/openclaw (see
// openClawRoutes in openclaw.mjs). client: createOpenClaw()'s api (call,
// can, onEvent, redact). ctx: { base, authorize, dataDir }.
//
// GET  spend                  today, this month, 30 days, per agent, plan limits, budget.
// GET  spend/chat?key=        one chat's cost.
// POST spend/budget           { monthlyUsd } a soft monthly budget Reach keeps (0: none).
// GET  spend/routing          default and heartbeat models, cache fit, models to pick.
// POST spend/routing          { target: "default"|"heartbeat", model, version }
// POST spend/routing/cheap    { model, version } heartbeats and isolated schedules on `model`.
// POST spend/routing/cache    { version } keep the main model's prompt cache 1 h.
//
// OpenClaw 2026.3.13: usage.cost reads only the default agent's transcripts;
// sessions.usage (every agent, one chat) is handled but not listed in hello,
// so Reach's client refuses it until it's probed like chat.inject. models.list
// carries no prices: the cheap model is a guess by name the user confirms.
// config.patch restarts the Gateway and allows 3 writes a minute. Only the
// whitelisted model and heartbeat fields below ever reach the phone; never
// raw, hash or the rest of the config.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });
const unsupported = (e) => e?.status === 409 && /does not support/i.test(String(e?.message || ""));
// Reach's own words pass (paired again, Gateway down); OpenClaw's never do.
const own = (e, message) =>
  [401, 403, 503].includes(e?.status) ? e : fail(502, message);

export const BUDGET_MAX = 100000;
const BUDGET_FILE = "openclaw-budget.json";
const DAY = 86400000;
const money = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : 0);
// OpenClaw's own day keys (session-cost-usage: toLocaleDateString en-CA, local).
export const dayKey = (ms) => new Date(ms).toLocaleDateString("en-CA");

// Model refs and durations as OpenClaw writes them; anything else is dropped.
const REF = /^[\w.@:+-]+(?:\/[\w.@:+-]+)*$/;
export const ref = (v) => (typeof v === "string" && v.length <= 200 && REF.test(v.trim()) ? v.trim() : "");
const modelOf = (v) => ref(typeof v === "string" ? v : v?.primary);
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i;
const every = (v) => (typeof v === "string" && DURATION.test(v.trim()) ? v.trim() : "");
export function minutes(text) {
  const m = DURATION.exec(String(text || "").trim());
  if (!m) return null;
  const unit = (m[2] || "m").toLowerCase();
  return Number(m[1]) * { ms: 1 / 60000, s: 1 / 60, m: 1, h: 60, d: 1440 }[unit];
}

// --- Budget ---------------------------------------------------------------

export function readBudget(dataDir) {
  if (!dataDir) return 0;
  try {
    const n = JSON.parse(fs.readFileSync(path.join(dataDir, BUDGET_FILE), "utf8"))?.monthlyUsd;
    return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= BUDGET_MAX ? n : 0;
  } catch {
    return 0;
  }
}
function writeBudget(dataDir, monthlyUsd) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, BUDGET_FILE);
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ monthlyUsd }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- Spend ----------------------------------------------------------------

// Sums OpenClaw's daily rows (usage.cost: totalCost; sessions.usage: cost).
export function spendFrom(daily, now = Date.now()) {
  const today = dayKey(now);
  const month = today.slice(0, 8) + "01";
  const from30 = dayKey(now - 29 * DAY);
  let t = 0, m = 0, d30 = 0, missing = 0;
  for (const row of Array.isArray(daily) ? daily : []) {
    if (!row || typeof row.date !== "string") continue;
    const cost = money(row.totalCost ?? row.cost);
    if (row.date === today) t += cost;
    if (row.date >= month && row.date <= today) m += cost;
    if (row.date >= from30 && row.date <= today) d30 += cost;
    if (row.missingCostEntries > 0) missing++;
  }
  return { today: money(t), month: money(m), days30: money(d30), partial: missing > 0 };
}
const limitsFrom = (status) =>
  (Array.isArray(status?.providers) ? status.providers : [])
    .filter((p) => p && Array.isArray(p.windows) && p.windows.length)
    .slice(0, 8)
    .map((p) => ({
      name: (typeof p.displayName === "string" && p.displayName.slice(0, 60)) || ref(p.provider) || "Provider",
      windows: p.windows
        .filter((w) => w && typeof w.label === "string" && Number.isFinite(w.usedPercent))
        .slice(0, 4)
        .map((w) => ({ label: w.label.slice(0, 20), usedPercent: Math.max(0, Math.min(100, Math.round(w.usedPercent))) })),
    }))
    .filter((p) => p.windows.length);

// --- Routing --------------------------------------------------------------

// Names that usually mean a model's cheap tier (models.list has no prices).
const CHEAP = [/\bfree\b|:free$/i, /nano/i, /haiku/i, /flash-?lite|\blite\b/i, /mini\b|-mini/i, /flash/i, /small|tiny/i];
export function cheapest(models) {
  let best = null, rank = Infinity;
  for (const m of models) {
    const i = CHEAP.findIndex((re) => re.test(m.id) || re.test(m.name));
    if (i >= 0 && i < rank) (best = m), (rank = i);
  }
  return best?.id || "";
}
// Providers OpenClaw caches prompts for (docs/reference/prompt-caching.md).
const cacheable = (model) =>
  /^anthropic\//.test(model) || /^openrouter\/anthropic\//.test(model) || /^amazon-bedrock\/.*anthropic\.claude/.test(model);
const retains = (model) => /^anthropic\//.test(model) || /^amazon-bedrock\/.*anthropic\.claude/.test(model);
const TTL = { none: 0, short: 5, long: 60, "5m": 5, "1h": 60 };

// The phone's view of OpenClaw's config: whitelisted fields only.
export function routingFrom(config) {
  const defaults = config?.agents?.defaults || {};
  const model = modelOf(defaults.model);
  const hb = defaults.heartbeat || {};
  const params = model ? defaults.models?.[model]?.params || {} : {};
  const retention =
    ["none", "short", "long"].includes(params.cacheRetention) ? params.cacheRetention
      : params.cacheControlTtl === "5m" ? "short" : params.cacheControlTtl === "1h" ? "long" : "";
  const agents = (Array.isArray(config?.agents?.list) ? config.agents.list : [])
    .filter((a) => a && typeof a.id === "string" && /^[\w-]{1,64}$/.test(a.id))
    .slice(0, 50)
    .map((a) => ({
      id: a.id,
      model: modelOf(a.model),
      heartbeat: a.heartbeat && typeof a.heartbeat === "object"
        ? { model: ref(a.heartbeat.model), every: every(a.heartbeat.every) }
        : null,
    }));
  return { model, heartbeat: { model: ref(hb.model), every: every(hb.every) }, retention, agents };
}
export const versionOf = (routing) =>
  crypto.createHash("sha256").update(JSON.stringify(routing)).digest("hex").slice(0, 24);

// The heartbeat beats the prompt cache: each one writes the cache again.
// When any agent defines a heartbeat, only those agents run one (merged over
// the defaults, OpenClaw's resolveHeartbeatConfigForAgent).
export function cacheFit(routing) {
  const model = routing.model;
  if (!model || !cacheable(model)) return null;
  // OpenClaw seeds "short" for Anthropic direct only; Bedrock caches when told.
  const ttl = routing.retention ? TTL[routing.retention] : /^amazon-bedrock\//.test(model) ? 0 : 5;
  if (!ttl) return null;
  const own = routing.agents.filter((a) => a.heartbeat);
  const beats = own.length
    ? own.map((a) => ({
        model: a.model || model,
        hb: a.heartbeat.model || routing.heartbeat.model || a.model || model,
        every: a.heartbeat.every || routing.heartbeat.every || "30m",
      }))
    : [{ model, hb: routing.heartbeat.model || model, every: routing.heartbeat.every || "30m" }];
  const miss = beats.find((b) => b.model === model && b.hb === model && minutes(b.every) > ttl);
  if (!miss) return null;
  return { every: miss.every, ttlMinutes: ttl, canKeepLonger: retains(model) && ttl < 60 && minutes(miss.every) <= 55 };
}

// What "Cheap background work" changes, exactly.
export function cheapPlan(routing, jobs, model) {
  return {
    heartbeat: (routing.heartbeat.model || routing.model) !== model,
    agents: routing.agents.filter((a) => a.heartbeat?.model && a.heartbeat.model !== model).map((a) => a.id),
    jobs: jobs.filter((j) => (j.model || routing.model) !== model).map((j) => j.id),
  };
}

export function routes(app, client, ctx) {
  const { base, authorize, dataDir } = ctx;
  const call = (method, params, auth, waitMs) => client.call(method, params, auth, waitMs);

  // ---- spend
  const chats = new Map(); // key -> { at, body }
  // sessions.usage scans every transcript: OpenClaw's answer kept a while.
  let last = null; // { at, body }
  app.get(`${base}/spend`, async (_req, res) => {
    if (!client.can("usage.cost")) return res.json({ supported: false });
    const now = Date.now();
    if (last && now - last.at < 30000) return res.json({ ...last.body, budget: readBudget(dataDir) });
    // 30 days, or from the 1st when that is earlier (the 31st), so the month is whole.
    const startAt = Math.min(now - 29 * DAY, new Date(new Date(now).setDate(1)).getTime());
    const agentDays = Math.round((now - startAt) / DAY) + 1;
    const range = { startDate: dayKey(startAt), endDate: dayKey(now), mode: "gateway" };
    const [cost, sessions, status] = await Promise.allSettled([
      call("usage.cost", { days: 31, mode: "gateway" }),
      call("sessions.usage", { ...range, limit: 1000 }),
      client.can("usage.status") ? call("usage.status", {}) : Promise.resolve(null),
    ]);
    if (cost.status === "rejected") {
      if (unsupported(cost.reason)) return res.json({ supported: false });
      throw own(cost.reason, "OpenClaw couldn't count spend right now. Try again.");
    }
    // Every agent when OpenClaw answers sessions.usage; else the default one.
    const all = sessions.status === "fulfilled" && Array.isArray(sessions.value?.aggregates?.daily) ? sessions.value : null;
    const spend = spendFrom(all ? all.aggregates.daily : cost.value?.daily, now);
    const body = {
      supported: true,
      scope: all ? "all" : "default",
      ...spend,
      agentDays,
      agents: all && Array.isArray(all.aggregates.byAgent)
        ? all.aggregates.byAgent
            .filter((a) => a && /^[\w-]{1,64}$/.test(String(a.agentId)))
            .slice(0, 50)
            .map((a) => ({ id: a.agentId, cost: money(a.totals?.totalCost) }))
        : null,
      limits: status.status === "fulfilled" ? limitsFrom(status.value) : [],
    };
    last = { at: now, body };
    res.json({ ...body, budget: readBudget(dataDir) });
  });
  app.get(`${base}/spend/chat`, async (req, res) => {
    const key = req.query.key;
    if (typeof key !== "string" || !key || key.length > 300 || /[\u0000-\u001f\s]/.test(key))
      throw fail(400, "Choose an OpenClaw chat.");
    const hit = chats.get(key);
    if (hit && Date.now() - hit.at < 30000) return res.json(hit.body);
    let result;
    try {
      result = await call("sessions.usage", { key, startDate: "2000-01-01", endDate: dayKey(Date.now()), mode: "gateway", limit: 1 });
    } catch (e) {
      if (unsupported(e)) return res.json({ supported: false });
      throw own(e, "OpenClaw couldn't count this chat's spend.");
    }
    const usage = Array.isArray(result?.sessions) ? result.sessions[0]?.usage : null;
    const total = usage && Number.isFinite(usage.totalCost) ? usage.totalCost : null;
    // Unpriced turns only (a local model): unknown, not free.
    const cost = total === null || (total === 0 && usage.missingCostEntries > 0) ? null : money(total);
    const body = { supported: true, cost };
    chats.set(key, { at: Date.now(), body });
    if (chats.size > 200) chats.delete(chats.keys().next().value);
    res.json(body);
  });
  app.post(`${base}/spend/budget`, async (req, res) => {
    const n = req.body?.monthlyUsd;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > BUDGET_MAX)
      throw fail(400, "Choose a monthly budget in dollars, or 0 for none.");
    if (!dataDir) throw fail(409, "Reach can't keep a budget here.");
    const monthlyUsd = Math.round(n * 100) / 100;
    authorize(req)();
    writeBudget(dataDir, monthlyUsd);
    res.json({ budget: monthlyUsd });
  });

  // ---- routing
  const supported = () => ["config.get", "models.list"].every((m) => client.can(m));
  const listModels = async () => {
    const result = await call("models.list", {});
    return (Array.isArray(result?.models) ? result.models : [])
      .filter((m) => m && typeof m.id === "string")
      .map((m) => {
        const id = ref(typeof m.provider === "string" && m.provider && !m.id.startsWith(`${m.provider}/`) ? `${m.provider}/${m.id}` : m.id);
        return { id, name: (typeof m.name === "string" && m.name.slice(0, 80)) || id, provider: ref(m.provider) || id.split("/")[0] };
      })
      .filter((m) => m.id)
      .slice(0, 500);
  };
  const readConfig = async () => {
    const snapshot = await call("config.get", {});
    const routing = routingFrom(snapshot?.valid === false ? {} : snapshot?.config);
    return { snapshot, routing, version: versionOf(routing) };
  };
  // Isolated agentTurn schedules only: a main-session job's model changes
  // the shared main chat (OpenClaw's docs say not to).
  const listJobs = async () => {
    if (!client.can("cron.list") || !client.can("cron.update")) return [];
    const jobs = [];
    for (let offset = 0, page = 0; page < 5; page++) {
      const result = await call("cron.list", { includeDisabled: true, limit: 200, offset });
      for (const j of Array.isArray(result?.jobs) ? result.jobs : [])
        if (j && typeof j.id === "string" && j.id.length <= 200 && j.sessionTarget === "isolated" && j.payload?.kind === "agentTurn")
          jobs.push({ id: j.id, name: typeof j.name === "string" ? j.name.slice(0, 80) : j.id, model: ref(j.payload.model) });
      if (result?.hasMore !== true) break;
      offset = result.nextOffset ?? offset + (result.jobs?.length || 0);
    }
    return jobs;
  };
  const fresh = async (req) => {
    if (!supported()) throw fail(409, "This OpenClaw can't change models from Reach.");
    const version = req.body?.version;
    if (typeof version !== "string" || version.length > 64) throw fail(400, "Refresh, then try again.");
    let read;
    try {
      read = await readConfig();
    } catch (e) {
      throw own(e, "OpenClaw couldn't read its settings. Try again.");
    }
    if (read.snapshot?.valid === false) throw fail(409, "OpenClaw's config has errors. Fix it on this computer first.");
    if (read.version !== version) throw fail(409, "OpenClaw's settings changed. Refresh, then try again.");
    return read;
  };
  const pick = async (model) => {
    if (typeof model !== "string" || !ref(model)) throw fail(400, "Choose a model.");
    const models = await listModels().catch((e) => {
      throw own(e, "OpenClaw couldn't list its models. Try again.");
    });
    if (!models.some((m) => m.id === model)) throw fail(400, "Choose a model OpenClaw lists.");
    return model;
  };
  const patch = async (req, snapshot, value) => {
    const baseHash = typeof snapshot?.hash === "string" ? snapshot.hash : undefined;
    try {
      // Built from validated values only, never from the snapshot.
      await call("config.patch", { raw: JSON.stringify(value), ...(baseHash ? { baseHash } : {}), note: "Reach: model routing" }, authorize(req));
    } catch (e) {
      if (e?.status === 401 || e?.status === 403) throw e;
      if (/usage limit/i.test(String(e?.message || ""))) throw fail(429, "OpenClaw takes 3 changes a minute. Try again shortly.");
      throw fail(409, "OpenClaw didn't accept this change. Refresh, then try again.");
    }
  };

  app.get(`${base}/spend/routing`, async (_req, res) => {
    if (!supported()) return res.json({ supported: false });
    let read, models, jobs;
    try {
      [read, models, jobs] = await Promise.all([readConfig(), listModels(), listJobs().catch(() => [])]);
    } catch (e) {
      if (unsupported(e)) return res.json({ supported: false });
      throw own(e, "OpenClaw couldn't read its models. Try again.");
    }
    const { routing, version, snapshot } = read;
    res.json({
      supported: true,
      version,
      readOnly: snapshot?.valid === false,
      ...routing,
      models,
      cheapest: cheapest(models),
      jobs,
      cache: cacheFit(routing),
      openRouter: models.some((m) => m.provider === "openrouter"),
    });
  });
  app.post(`${base}/spend/routing`, async (req, res) => {
    const target = req.body?.target;
    if (!["default", "heartbeat"].includes(target)) throw fail(400, "Choose the default or heartbeat model.");
    authorize(req)();
    const { snapshot } = await fresh(req);
    // A heartbeat set to "" follows the default model again.
    const model = target === "heartbeat" && req.body?.model === "" ? null : await pick(req.body?.model);
    const shape = snapshot?.config?.agents?.defaults?.model;
    const value =
      target === "heartbeat"
        ? { agents: { defaults: { heartbeat: { model } } } }
        : { agents: { defaults: { model: shape && typeof shape === "object" ? { primary: model } : model } } };
    authorize(req)();
    await patch(req, snapshot, value);
    res.json({ saved: true });
  });
  app.post(`${base}/spend/routing/cheap`, async (req, res) => {
    authorize(req)();
    const { snapshot, routing } = await fresh(req);
    const model = await pick(req.body?.model);
    const jobs = await listJobs().catch((e) => {
      throw own(e, "OpenClaw couldn't list its schedules. Try again.");
    });
    const plan = cheapPlan(routing, jobs, model);
    // Schedules first: the config patch restarts the Gateway.
    let moved = 0;
    for (const id of plan.jobs) {
      try {
        await call("cron.update", { id, patch: { payload: { kind: "agentTurn", model } } }, authorize(req));
        moved++;
      } catch (e) {
        if (e?.status === 401 || e?.status === 403) throw e;
        throw fail(409, `OpenClaw didn't move a schedule (${moved} of ${plan.jobs.length} moved). Refresh, then try again.`);
      }
    }
    if (plan.heartbeat || plan.agents.length)
      await patch(req, snapshot, {
        agents: {
          ...(plan.heartbeat ? { defaults: { heartbeat: { model } } } : {}),
          ...(plan.agents.length ? { list: plan.agents.map((id) => ({ id, heartbeat: { model } })) } : {}),
        },
      });
    res.json({ saved: true, ...plan });
  });
  app.post(`${base}/spend/routing/cache`, async (req, res) => {
    authorize(req)();
    const { snapshot, routing } = await fresh(req);
    if (!cacheFit(routing)?.canKeepLonger) throw fail(409, "OpenClaw can't keep this model's cache longer. Refresh.");
    authorize(req)();
    await patch(req, snapshot, { agents: { defaults: { models: { [routing.model]: { params: { cacheRetention: "long" } } } } } });
    res.json({ saved: true });
  });
}
