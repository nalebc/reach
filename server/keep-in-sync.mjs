// Keeping what Reach drives on this computer in sync (Oct 13: "Reach should
// keep in sync with dependencies"). One list: each piece with how it's
// checked and how it's updated, a fixed command per piece (never text from
// the phone). Behind its newest, or out of step with another piece (Codex's
// service older than its CLI), is a quiet Needs you card once per version
// pair and a row in Settings with Update; too old for Reach is the strong one
// ("Update it to X or newer to use it here"). The owner decides with one tap:
// nothing updates in the background, and what a tap would interrupt is said
// first ("1 Codex chat is working: it may stop. Update anyway?").
//
// A source: { id, name, icon, check() → item | null, update?(ctx), working?() }.
// An item: { state: "too-old" | "behind" | "current", from, to, unlocks?,
// canUpdate, how? (what to do when Reach can't), target? }. A check that
// fails or can't tell says nothing (never a guessed offer).
import fs from "node:fs";
import path from "node:path";
import { tooOld as tooOldFor } from "./agent-sessions/compatibility.mjs";
import { openClawTarget } from "./openclaw-hub.mjs";

const CHECK_EVERY_MS = 60 * 60 * 1000;

// "0.158.0-alpha.2.1" → "0.158"; "2.1.295" stays.
export const shortVersion = (v) => {
  const text = String(v || "");
  return /^(\d+\.\d+)\.0(?:[-+].*)?$/.exec(text)?.[1] || text.replace(/[-+].*$/, "");
};
const pairOf = (item) => `${item.from || "?"}>${item.to || "?"}`;
export const workingLine = (n, agent = "Codex") =>
  `${n} ${agent} chat${n === 1 ? " is" : "s are"} working: ${n === 1 ? "it" : "they"} may stop. Update anyway?`;

// What a row and a card say about one piece.
export function describe(item) {
  const from = shortVersion(item.from), to = shortVersion(item.to);
  if (item.id === "codex-service")
    return {
      title: `Update Codex's service to use ${item.unlocks ? `${item.unlocks} and newer models` : "newer models"}`,
      detail: `Codex's service is ${from}; your Codex is ${to}`,
    };
  if (item.state === "too-old")
    return { title: `Update ${item.name} to ${to} or newer to use it here`, detail: from ? `You have ${from}` : "" };
  return { title: `${item.name} ${to} is out`, detail: from ? `You have ${from}` : "" };
}

// Agent CLIs (agent-updates.mjs): newer published, or too old for Reach.
export function agentSource(agent, { updates, update, icon = agent }) {
  const names = { claude: "Claude Code", codex: "Codex" };
  return {
    id: agent,
    name: names[agent],
    icon,
    async check({ fresh = false } = {}) {
      const s = await updates.status(agent, { fresh });
      const old = s.installed ? tooOldFor(agent, s.installed) : null;
      if (old) return { state: "too-old", from: s.installed, to: old.to, canUpdate: s.state === "available", ...(s.state === "app" ? { how: `Update the ${s.app} app` } : {}) };
      if (s.state === "available") return { state: "behind", from: s.installed, to: s.latest, canUpdate: true };
      if (s.state === "current") return { state: "current", from: s.installed, to: s.latest };
      return null;
    },
    update,
  };
}

// Codex's shared service (codex-daemon.mjs): older than the CLI beside it
// means the CLI's newer models can't run. `codex app-server daemon update`.
export function codexServiceSource({ status, models, update, working }) {
  return {
    id: "codex-service",
    name: "Codex's service",
    icon: "codex",
    async check() {
      const s = await status();
      if (!s?.service || !s?.cli) return null;
      if (!s.behind) return { state: "current", from: s.service, to: s.cli };
      const unlocks = (await Promise.resolve(models?.()).catch(() => null))?.serviceUpdate?.unlocks || null;
      return { state: "behind", from: s.service, to: s.cli, unlocks, canUpdate: true };
    },
    update,
    working: () => (working?.() || []).length,
  };
}

// OpenClaw too old for Reach (openclaw.mjs tooOld): updated by its own
// `openclaw update`, from OpenClaw's page in Reach (its maintenance job);
// the Gateway OpenClaw's own Windows app keeps, from that app (Reach leaves
// its repairs and updates to it: openclaw-hub.mjs).
export function openClawSource({ tooOld, kept = async () => (await openClawTarget()).kind === "hub" }) {
  return {
    id: "openclaw",
    name: "OpenClaw",
    icon: "openclaw",
    async check() {
      const old = tooOld?.();
      if (!old?.to) return null;
      const how = (await kept().catch(() => false)) ? "Update it from OpenClaw's Windows app" : "Update it from OpenClaw in Reach";
      return { state: "too-old", from: old.version || null, to: old.to, canUpdate: false, how, target: { page: "sessions", agent: "openclaw" } };
    },
  };
}

export function createKeepInSync({
  sources = [],
  dataDir = null,
  onChange = () => {},
  record = () => {},
  now = Date.now,
  // A Reach terminal an update ran in has ended (or is gone).
  terminalEnded = () => false,
  // A look older than this is taken again when the phone asks.
  staleMs = 60_000,
} = {}) {
  const dismissedFile = dataDir ? path.join(dataDir, "sync-dismissed.json") : null;
  let dismissed = {};
  try { dismissed = JSON.parse(fs.readFileSync(dismissedFile, "utf8")) || {}; } catch { /* none */ }
  const byId = new Map(sources.map((s) => [s.id, s]));
  let snapshot = new Map();
  const runs = new Map();
  let refreshing = null;
  const changed = () => { try { onChange(); } catch { /* not ours */ } };

  async function checkOne(source, options) {
    const item = await Promise.resolve().then(() => source.check(options)).catch(() => null);
    return item ? { ...item, id: source.id, name: source.name, icon: source.icon || "mac" } : null;
  }
  let checkedAt = 0;
  function refresh({ fresh = false } = {}) {
    refreshing ||= (async () => {
      const next = new Map();
      for (const [i, item] of (await Promise.all(sources.map((s) => checkOne(s, { fresh })))).entries())
        if (item) next.set(sources[i].id, item);
      const before = JSON.stringify([...snapshot, ...runs]);
      snapshot = next;
      checkedAt = now();
      // An update in a terminal: done once the piece reads current (or
      // another version), stopped once its terminal ended with it behind.
      for (const [id, run] of runs) {
        if (run.state !== "started") continue;
        const item = snapshot.get(id);
        if (!item || item.state === "current" || item.from !== run.from)
          runs.set(id, { ...run, state: "done", message: `${item?.name || byId.get(id)?.name} is ${shortVersion(item?.from || run.to)}`, at: now() });
        else if (terminalEnded(run.terminal)) runs.set(id, { ...run, state: "failed", message: "Update stopped.", at: now() });
      }
      if (JSON.stringify([...snapshot, ...runs]) !== before) changed();
      return list();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  // What the phone reads: looked at again when it's a while old or an
  // update is under way (cached feeds and probes keep that cheap).
  function look() {
    const moving = [...runs.values()].some((r) => r.state === "started" || r.state === "updating");
    return moving || now() - checkedAt > staleMs ? refresh() : Promise.resolve(list());
  }
  const working = (id) => {
    try { return Number(byId.get(id)?.working?.()) || 0; } catch { return 0; }
  };
  function list() {
    return [...snapshot.values()].map((item) => ({
      ...item,
      ...describe(item),
      working: working(item.id),
      ...(runs.has(item.id) ? { run: runs.get(item.id) } : {}),
    }));
  }
  // Needs you: what's behind or too old, once per version pair (Not now
  // keeps that pair away), not while it's updating.
  function offers() {
    return list().filter((item) => ["behind", "too-old"].includes(item.state) && dismissed[item.id] !== pairOf(item) && !["updating", "started"].includes(runs.get(item.id)?.state));
  }
  function dismiss(id, pair) {
    // Only a piece Reach lists: the key written is Reach's own, never the
    // request's text.
    const key = [...byId.keys()].find((known) => known === id);
    const item = key === undefined ? null : snapshot.get(key);
    if (!item || (pair && pair !== pairOf(item))) return;
    dismissed = { ...dismissed, [key]: pairOf(item) };
    if (dismissedFile) try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(dismissedFile, JSON.stringify(dismissed), { mode: 0o600 });
    } catch { /* remembered until a restart */ }
    changed();
  }
  // Update one piece, as the owner tapped: read again now (never a stale
  // offer), refused when it would stop working chats unless `anyway`.
  async function start(id, { anyway = false, pair = null } = {}, ctx = {}) {
    const source = byId.get(id);
    if (!source) throw Object.assign(new Error("Reach doesn't update that."), { status: 404 });
    if (runs.get(id)?.state === "updating") throw Object.assign(new Error(`${source.name} is already updating.`), { status: 409 });
    const item = await checkOne(source, { fresh: false });
    if (item) snapshot.set(id, item);
    else snapshot.delete(id);
    if (!item || !["behind", "too-old"].includes(item.state)) throw Object.assign(new Error(`${source.name} is up to date.`), { status: 409 });
    if (pair && pair !== pairOf(item)) throw Object.assign(new Error("That update changed. Check again."), { status: 409 });
    if (!item.canUpdate || !source.update) throw Object.assign(new Error(item.how ? `${item.how}.` : `Reach can't update ${source.name}.`), { status: 409 });
    const busy = working(id);
    if (busy && !anyway) throw Object.assign(new Error(workingLine(busy)), { status: 409, code: "WORKING", working: busy });
    const run = { state: "updating", from: item.from, to: item.to, at: now() };
    runs.set(id, run);
    record(`Updating ${source.name}`);
    changed();
    const started = Promise.resolve().then(() => source.update(ctx));
    // A terminal (agent CLIs) says when it ends; anything else is awaited here.
    started.then(
      (result) => {
        if (result?.terminal) {
          runs.set(id, { ...run, state: "started", terminal: result.terminal.id });
        } else {
          const version = result?.service || item.to;
          runs.set(id, { ...run, state: "done", message: `${source.name} is ${shortVersion(version)}`, at: now() });
          record(`${source.name} updated to ${version}`);
        }
        changed();
        void refresh({ fresh: true }).catch(() => {});
      },
      (error) => {
        const message = String(error?.message || `${source.name} didn't update.`);
        runs.set(id, { ...run, state: "failed", message, at: now() });
        record(`${source.name} didn't update: ${message}`);
        changed();
        void refresh({ fresh: true }).catch(() => {});
      },
    );
    // The terminal's id, when one opened (the phone follows it).
    const first = await Promise.race([started.then((r) => r, () => null), new Promise((r) => setTimeout(r, 50, null))]);
    return { ...runs.get(id), ...(first?.terminal ? { terminal: first.terminal } : {}) };
  }
  let timer = null;
  function watch({ firstMs = 30_000, everyMs = CHECK_EVERY_MS } = {}) {
    if (timer) return;
    const tick = () => { void refresh().catch(() => {}); };
    const first = setTimeout(tick, firstMs);
    first.unref?.();
    timer = setInterval(tick, everyMs);
    timer.unref?.();
    timer.first = first;
  }
  function close() {
    if (timer) { clearTimeout(timer.first); clearInterval(timer); timer = null; }
  }
  return { refresh, look, list, offers, dismiss, start, watch, close, pairOf };
}

// The Needs you card for one piece. Behind is quiet (no push); too old for
// Reach pushes. Whether chats work changes what the card offers (Update
// anyway), so a card answers only while that's still true.
export function syncNotification(item, seal) {
  const busy = item.working > 0;
  const pair = pairOf(item);
  return seal(
    {
      id: `sync:${item.id}:${pair}`,
      source: "sync",
      sender: item.name,
      icon: item.icon || "mac",
      ...(item.state === "too-old" ? {} : { push: false }),
      title: item.title,
      kind: "permission",
      detail: item.detail,
      summary: busy ? workingLine(item.working).replace(/ Update anyway\?$/, "") : item.canUpdate ? "" : item.how || "",
      signature: pair,
      target: item.target || { page: "overview", needs: `sync:${item.id}:${pair}` },
      actions: [
        ...(item.canUpdate ? [{ id: busy ? "update-anyway" : "update", label: busy ? "Update anyway" : "Update", tone: "primary" }] : []),
        { id: "deny", label: "Not now", tone: "deny" },
      ],
    },
    { type: "sync", id: item.id, pair, evidence: [busy] },
  );
}
