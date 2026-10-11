// OpenClaw feature: schedules. Routes under /api/sessions/openclaw (see
// openClawRoutes in openclaw.mjs). client: createOpenClaw()'s api (call,
// can, onEvent, redact). ctx: { base, authorize, dataDir }.
// One schedule's past runs (cron.runs) and edits (cron.update). The Gateway
// has no cron.get: a job is found by paging cron.list.

const fail = (status, message) => Object.assign(new Error(message), { status });
const PAGE = 200;
const MAX_PAGES = 25;
const RUNS = 20;
const STATUSES = ["ok", "error", "skipped"];

// The same ids every schedule route takes; cron.runs refuses slashes.
const validId = (id) => {
  if (typeof id !== "string" || !id || id.length > 200 || !/^[^/\\\x00-\x1f]+$/.test(id))
    throw fail(400, "Choose a scheduled job.");
  return id;
};
const text = (v, max) => (typeof v === "string" && v.length <= max && !/[\x00-\x1f]/.test(v) ? v : "");

async function findJob(client, id) {
  for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
    const result = await client.call("cron.list", { includeDisabled: true, limit: PAGE, offset });
    if (!Array.isArray(result?.jobs)) throw fail(502, "OpenClaw returned unsupported scheduled jobs.");
    const job = result.jobs.find((j) => j?.id === id);
    if (job) return job;
    if (result.hasMore !== true || !result.jobs.length) break;
    offset = Number.isInteger(result.nextOffset) ? result.nextOffset : offset + result.jobs.length;
  }
  throw fail(404, "This schedule is no longer in OpenClaw. Refresh the list.");
}

// Only what the edit form needs. A webhook's URL can hold a secret: never sent.
function publicJob(j) {
  const s = j.schedule || {};
  const p = j.payload || {};
  const d = j.delivery || { mode: "none" };
  const body = p.kind === "systemEvent" ? p.text : p.message;
  const mode = ["none", "announce", "webhook"].includes(d.mode) ? d.mode : "none";
  return {
    id: j.id,
    name: text(j.name, 200),
    agentId: text(j.agentId, 80),
    enabled: j.enabled === true,
    target: j.sessionTarget === "main" ? "main" : "isolated",
    schedule: {
      kind: ["cron", "every", "at"].includes(s.kind) ? s.kind : "other",
      ...(s.kind === "cron" ? { expr: text(s.expr, 200), tz: text(s.tz, 64) } : {}),
    },
    kind: p.kind === "systemEvent" ? "systemEvent" : "agentTurn",
    message: typeof body === "string" && body.length <= 20000 ? body : "",
    // Past what an edit accepts, or a kind the edit doesn't keep (a
    // heartbeat, a command): edited in OpenClaw, never cut short here.
    editable: ["systemEvent", "agentTurn"].includes(p.kind) && typeof body === "string" && body.length <= 20000 && typeof j.name === "string" && j.name.trim().length <= 120,
    delivery: {
      mode,
      channel: text(d.channel, 80),
      accountId: text(d.accountId, 80),
      ...(mode === "announce" ? { to: text(d.to, 300) } : {}),
    },
  };
}

// A run's chat, named from its key: "agent:main:cron:<job>:run:<id>".
function chatTitle(key, row) {
  const label = String(row?.label || row?.displayName || "").trim();
  if (label && label !== key && !/^[a-z]+:\S+$/i.test(label)) return label.slice(0, 120);
  const run = /:run:([\w-]{4,})$/.exec(key)?.[1];
  return run ? `Run ${run.slice(0, 8)}` : "Scheduled chat";
}

export function routes(app, client, ctx) {
  const { base, authorize } = ctx;

  app.get(`${base}/automations/history`, async (req, res) => {
    if (!client.can("cron.runs")) return res.json({ supported: false });
    const id = validId(req.query.id);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
      throw fail(400, "Choose a valid page of runs.");
    const result = await client.call("cron.runs", { scope: "job", id, limit: RUNS, offset, sortDir: "desc" });
    if (!Array.isArray(result?.entries)) throw fail(502, "OpenClaw returned unsupported run history.");
    const entries = result.entries.filter((e) => e && typeof e === "object" && e.jobId === id && Number.isFinite(e.ts));
    // Run chats are pruned after a day or so: link only those still listed.
    const keys = entries.map((e) => e.sessionKey).filter((k) => typeof k === "string" && k);
    const listed = new Map();
    if (keys.length && client.can("sessions.list")) {
      const sessions = await client
        .call("sessions.list", { includeGlobal: true, includeUnknown: true })
        .then((r) => (Array.isArray(r?.sessions) ? r.sessions : []))
        .catch(() => []);
      for (const s of sessions) if (s && typeof s.key === "string" && keys.includes(s.key)) listed.set(s.key, s);
    }
    res.json({
      supported: true,
      hasMore: result.hasMore === true,
      nextOffset: Number.isInteger(result.nextOffset) ? result.nextOffset : null,
      runs: entries.map((e) => {
        const u = e.usage && typeof e.usage === "object" ? e.usage : {};
        const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
        const tokens = num(u.total_tokens) || num(u.input_tokens) + num(u.output_tokens);
        const key = typeof e.sessionKey === "string" ? e.sessionKey : "";
        return {
          at: num(e.runAtMs) || e.ts,
          status: STATUSES.includes(e.status) ? e.status : "unknown",
          durationMs: num(e.durationMs),
          tokens,
          model: text(e.model, 120),
          error: client.redact(typeof e.error === "string" ? e.error : ""),
          deliveryError: client.redact(typeof e.deliveryError === "string" ? e.deliveryError : ""),
          chat: listed.has(key) ? { key, title: chatTitle(key, listed.get(key)) } : null,
        };
      }),
    });
  });

  app.get(`${base}/automations/job`, async (req, res) => {
    if (!client.can("cron.list") || !client.can("cron.update")) return res.json({ supported: false });
    const id = validId(req.query.id);
    res.json({ supported: true, job: publicJob(await findJob(client, id)) });
  });

  // An edit, as strict as a new schedule (addAutomation). Only what's sent
  // changes: no `expr` keeps the schedule, no `delivery` keeps where results go.
  app.post(`${base}/automations/edit`, async (req, res) => {
    const auth = authorize(req);
    auth();
    if (!client.can("cron.update")) throw fail(409, "This OpenClaw can't edit schedules.");
    const { id, name, message, expr, tz, agentId, delivery, channel, accountId, to } = req.body || {};
    validId(id);
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
      throw fail(400, "Name the schedule (up to 120 characters).");
    if (typeof message !== "string" || !message.trim() || message.length > 20000)
      throw fail(400, "Write what OpenClaw should do each time.");
    let fields;
    if (expr !== undefined) {
      fields = typeof expr === "string" ? expr.trim().split(/\s+/) : [];
      if (fields.length !== 5 || !fields.every((f) => /^[\d*/,\-A-Za-z?]{1,40}$/.test(f)))
        throw fail(400, "Choose when it runs (five cron fields, like 0 9 * * 1-5).");
    }
    if (tz !== undefined && (expr === undefined || (tz !== "" && (typeof tz !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz) || tz.length > 64))))
      throw fail(400, "Choose a valid time zone.");
    if (agentId !== undefined && (typeof agentId !== "string" || !/^[\w-]{1,80}$/.test(agentId)))
      throw fail(400, "Choose an OpenClaw agent.");
    if (delivery !== undefined && !["none", "last", "channel"].includes(delivery))
      throw fail(400, "Choose where results go.");
    if (delivery === "channel") {
      if (typeof channel !== "string" || !/^[a-z][\w-]{0,39}$/.test(channel))
        throw fail(400, "Choose a connected channel.");
      if (accountId !== undefined && (typeof accountId !== "string" || !/^[\w-]{1,80}$/.test(accountId)))
        throw fail(400, "Choose a connected channel.");
      if (to !== undefined && (typeof to !== "string" || to.length > 300 || /[\x00-\x1f]/.test(to)))
        throw fail(400, "Choose who receives the results (up to 300 characters).");
    } else if (channel !== undefined || accountId !== undefined || to !== undefined)
      throw fail(400, "Choose where results go.");

    const job = await findJob(client, id);
    auth();
    if (delivery !== undefined && job.sessionTarget !== "isolated")
      throw fail(409, "This schedule runs in the main chat. Change where results go in OpenClaw.");
    if (delivery === "channel") {
      // The live channel list, not the phone's.
      const status = client.can("channels.status") ? await client.call("channels.status", { probe: false }) : null;
      const accounts = status?.channelAccounts?.[channel];
      if (!Array.isArray(accounts) || (accountId && !accounts.some((a) => a?.accountId === accountId)))
        throw fail(409, "This channel isn't connected in OpenClaw. Refresh and choose another.");
      auth();
    }
    // Only the two kinds the phone edits: anything else (a "command" job's
    // argv, cwd and env, or a kind added later) would be rebuilt as one.
    const kind = job.payload?.kind;
    if (kind !== "systemEvent" && kind !== "agentTurn")
      throw fail(409, "Reach can't edit this kind of schedule. Change it in OpenClaw.");
    const patch = {
      name: name.trim(),
      // Same kind as the job's: another kind would rebuild the payload.
      payload: kind === "systemEvent" ? { kind, text: message.trim() } : { kind, message: message.trim() },
      ...(agentId ? { agentId } : {}),
      ...(fields ? { schedule: { kind: "cron", expr: fields.join(" "), ...(tz ? { tz } : {}) } } : {}),
      // Channel and target named every time, so old ones don't linger.
      ...(delivery === "none" ? { delivery: { mode: "none", channel: "last", to: "" } } : {}),
      ...(delivery === "last" ? { delivery: { mode: "announce", channel: "last", to: "" } } : {}),
      ...(delivery === "channel"
        ? { delivery: { mode: "announce", channel, to: (to || "").trim(), ...(accountId ? { accountId } : {}) } }
        : {}),
    };
    const result = await client.call("cron.update", { id, patch }, auth);
    const saved = kind === "systemEvent" ? result?.payload?.text : result?.payload?.message;
    if (
      result?.id !== id ||
      result.name !== patch.name ||
      saved !== message.trim() ||
      (fields && (result.schedule?.expr !== patch.schedule.expr || (result.schedule?.tz || "") !== (tz || ""))) ||
      (agentId && result.agentId !== agentId) ||
      (patch.delivery && result.delivery?.mode !== patch.delivery.mode) ||
      (delivery === "channel" && result.delivery?.channel !== channel)
    )
      throw fail(502, "OpenClaw did not confirm the schedule change. Refresh before trying again.");
    res.json({ saved: true });
  });
}
