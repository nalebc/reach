// OpenClaw feature: agents. Routes under /api/sessions/openclaw (see
// openClawRoutes in openclaw.mjs). client: createOpenClaw()'s api (call,
// can, onEvent, redact). ctx: { base, authorize, dataDir }.
//
// GET  agents        every agent, what runs under it, its recent chats.
// GET  agents/rules  exec approval rules (~/.openclaw/exec-approvals.json).
// POST agents/rules  one change to them, guarded by the file's hash.
//
// Sub-agents are shown, never stopped: OpenClaw 2026.3.13 runs them with its
// `agent` method, and chat.abort only stops runs chat.send started (it
// answers aborted: false). There is no sessions.abort.

const fail = (status, message) => Object.assign(new Error(message), { status });
// OpenClaw's own words for its policy (src/infra/exec-approvals.ts).
export const SECURITY = ["deny", "allowlist", "full"];
export const ASK = ["off", "on-miss", "always"];
// A sub-agent counts as running while OpenClaw says so, or for this long
// after its last update (Reach only hears runs on its own connection).
const RECENT_MS = 10 * 60 * 1000;
const RECENT_CHATS = 5;
const PATTERN_MAX = 512;
const ALLOWLIST_MAX = 500;

const agentOf = (key) =>
  /^agent:([^:]+):/i.exec(String(key || ""))?.[1]?.toLowerCase() || "";
// OpenClaw's shapes: agent:<id>:subagent:<uuid> (nested: …:subagent:…), and
// agent:<id>:acp:<uuid> for ACP children.
export const isSubagent = (key) =>
  /^(?:agent:[^:]+:)?(?:subagent|acp):/i.test(String(key || ""));
const text = (value, max = 120) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const shortModel = (model) => text(String(model || "").split("/").pop(), 80);

export function agentRows({ roster, listing, overview, now = Date.now() }) {
  const defaultId = text(roster?.defaultId, 80) || "main";
  const native = new Map(
    (Array.isArray(listing?.sessions) ? listing.sessions : [])
      .filter((s) => s && typeof s.key === "string")
      .map((s) => [s.key, s]),
  );
  const sessions = Array.isArray(overview?.sessions) ? overview.sessions : [];
  const fallbackModel = shortModel(listing?.defaults?.model);
  const rows = (Array.isArray(roster?.agents) ? roster.agents : [])
    .filter((a) => a && typeof a.id === "string" && a.id)
    .map((a) => ({
      id: a.id,
      name: text(a.identity?.name) || text(a.name) || a.id,
      emoji: text(a.identity?.emoji, 16),
      isDefault: a.id === defaultId,
      model: "",
      running: 0,
      waiting: 0,
      subagents: [],
      recent: [],
    }));
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const owner = (key) => byId.get(agentOf(key)) || byId.get(defaultId.toLowerCase());
  for (const s of sessions) {
    if (!s || typeof s.key !== "string") continue;
    const parent = native.get(s.key)?.spawnedBy;
    // A sub-agent sits under the agent that started it.
    const sub = isSubagent(s.key) || (typeof parent === "string" && !!parent);
    const row = owner(sub && typeof parent === "string" && parent ? parent : s.key);
    if (!row) continue;
    const live = s.status === "running" || s.status === "waiting";
    if (sub) {
      const updatedAt = Number(s.updatedAt) || 0;
      if (live || now - updatedAt < RECENT_MS)
        row.subagents.push({
          key: s.key,
          title: text(s.title) || "Sub-agent",
          status: live ? s.status : "recent",
          updatedAt,
        });
      continue;
    }
    if (live) row.running++;
    row.recent.push({ key: s.key, title: text(s.title) || "Chat", updatedAt: Number(s.updatedAt) || 0 });
  }
  for (const a of Array.isArray(overview?.approvals) ? overview.approvals : []) {
    const row = owner(a?.sessionKey);
    if (row) row.waiting++;
  }
  for (const row of rows) {
    row.recent.sort((a, b) => b.updatedAt - a.updatedAt);
    row.subagents.sort((a, b) => b.updatedAt - a.updatedAt);
    const main = native.get(`agent:${row.id}:main`);
    const latest = sessions.find((s) => s?.key === row.recent[0]?.key);
    row.model = shortModel(main?.model) || shortModel(latest?.model) || fallbackModel;
    row.recent = row.recent.slice(0, RECENT_CHATS).map(({ key, title }) => ({ key, title }));
  }
  return { defaultId, agents: rows };
}

// Only what the phone shows: no socket, no path, no last command (its
// arguments may hold secrets).
const policy = (p) => ({
  security: SECURITY.includes(p?.security) ? p.security : null,
  ask: ASK.includes(p?.ask) ? p.ask : null,
});
const entries = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((e) => typeof e?.pattern === "string" && e.pattern.trim())
    .map((e) => ({
      pattern: e.pattern.slice(0, PATTERN_MAX),
      ...(Number.isFinite(e.lastUsedAt) ? { lastUsedAt: e.lastUsedAt } : {}),
    }));
export function rulesView(snapshot) {
  const file = snapshot?.file || {};
  const agents = {};
  for (const [id, a] of Object.entries(file.agents || {}))
    if (id !== "*") agents[id] = { ...policy(a), allowlist: entries(a?.allowlist) };
  return {
    supported: true,
    hash: typeof snapshot?.hash === "string" ? snapshot.hash : "",
    // "All agents": the defaults, and the allowlist under agents["*"].
    all: { ...policy(file.defaults), allowlist: entries(file.agents?.["*"]?.allowlist) },
    agents,
  };
}

const validId = (scope) =>
  scope === "*" || (typeof scope === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(scope));
// One change at a time: { hash, scope, security | ask | add | remove }.
export function applyRule(file, body) {
  const { scope } = body || {};
  if (!validId(scope)) throw fail(400, "Choose an agent.");
  const changes = ["security", "ask", "add", "remove"].filter((k) => body[k] !== undefined);
  if (changes.length !== 1) throw fail(400, "Choose one change.");
  const [change] = changes;
  const next = {
    version: 1,
    ...(file?.defaults ? { defaults: { ...file.defaults } } : {}),
    agents: Object.fromEntries(
      Object.entries(file?.agents || {}).map(([id, a]) => [
        id,
        { ...a, ...(Array.isArray(a?.allowlist) ? { allowlist: [...a.allowlist] } : {}) },
      ]),
    ),
  };
  if (change === "security" || change === "ask") {
    const value = body[change];
    const options = change === "security" ? SECURITY : ASK;
    // An agent can go back to the defaults (null); the defaults can't.
    if (!(options.includes(value) || (value === null && scope !== "*")))
      throw fail(400, "Choose a mode.");
    const target =
      scope === "*" ? (next.defaults ||= {}) : (next.agents[scope] ||= {});
    if (value === null) delete target[change];
    else target[change] = value;
    return next;
  }
  const agent = (next.agents[scope] ||= {});
  const list = (agent.allowlist ||= []);
  if (change === "add") {
    const pattern = typeof body.add === "string" ? body.add.trim() : "";
    // Paths to programs; OpenClaw ignores bare names.
    if (
      !pattern ||
      pattern.length > PATTERN_MAX ||
      /[\x00-\x1f\x7f]/.test(pattern) ||
      !pattern.includes("/")
    )
      throw fail(400, "Use a program path, like /opt/homebrew/bin/rg.");
    if (list.some((e) => String(e?.pattern || "").toLowerCase() === pattern.toLowerCase()))
      throw fail(409, "Already allowed.");
    if (list.length >= ALLOWLIST_MAX) throw fail(409, "This allowlist is full.");
    list.push({ pattern });
    return next;
  }
  const pattern = typeof body.remove === "string" ? body.remove : "";
  if (!pattern || pattern.length > PATTERN_MAX) throw fail(400, "Choose a rule.");
  const kept = list.filter((e) => e?.pattern !== pattern);
  if (kept.length === list.length) throw fail(409, "That rule is gone. Refresh.");
  if (kept.length) agent.allowlist = kept;
  else delete agent.allowlist;
  return next;
}

// The Gateway's rejection, in Reach's words.
const saveError = (error) => {
  if (error?.status !== 409) return error;
  const said = String(error.message || "");
  if (/changed since|base hash/i.test(said))
    return fail(409, "Rules changed on your computer. Try again.");
  if (/does not support|pairing/i.test(said)) return error;
  return fail(409, "OpenClaw didn't save the rule.");
};

export function routes(app, client, ctx) {
  const { base, authorize } = ctx;
  app.get(`${base}/agents`, async (_req, res) => {
    if (!client.can("agents.list")) return res.json({ supported: false });
    const [roster, listing, overview] = await Promise.allSettled([
      client.call("agents.list", {}),
      client.can("sessions.list")
        ? client.call("sessions.list", { includeGlobal: false, includeUnknown: false })
        : Promise.resolve(null),
      client.overview(),
    ]);
    if (roster.status === "rejected" || !Array.isArray(roster.value?.agents))
      throw fail(502, "OpenClaw didn't list its agents.");
    res.json({
      supported: true,
      // Sub-agents run under OpenClaw's `agent` method: chat.abort can't stop them.
      canStopSubagents: false,
      ...agentRows({
        roster: roster.value,
        listing: listing.status === "fulfilled" ? listing.value : null,
        overview: overview.status === "fulfilled" ? overview.value : null,
      }),
    });
  });
  app.get(`${base}/agents/rules`, async (_req, res) => {
    if (!client.can("exec.approvals.get")) return res.json({ supported: false });
    const snapshot = await client.call("exec.approvals.get", {}).catch(() => {
      throw fail(502, "OpenClaw didn't share its rules.");
    });
    res.json({ ...rulesView(snapshot), canEdit: client.can("exec.approvals.set") });
  });
  app.post(`${base}/agents/rules`, async (req, res) => {
    const live = authorize(req);
    live();
    const body = req.body || {};
    if (typeof body.hash !== "string" || !/^[\w-]{1,128}$/.test(body.hash))
      throw fail(400, "Refresh the rules first.");
    if (!client.can("exec.approvals.set"))
      throw fail(409, "This OpenClaw can't change rules. Update OpenClaw.");
    const current = await client.call("exec.approvals.get", {}, live).catch((error) => {
      throw saveError(error);
    });
    // What the phone saw is what changes; OpenClaw checks it again (baseHash).
    if (current?.hash !== body.hash)
      throw fail(409, "Rules changed on your computer. Try again.");
    const file = applyRule(current.file, body);
    live();
    const saved = await client
      .call("exec.approvals.set", { file, baseHash: current.hash }, live)
      .catch((error) => {
        throw saveError(error);
      });
    res.json({ ...rulesView(saved), canEdit: true });
  });
}
