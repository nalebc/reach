// Updating Claude Code and Codex from the phone, the way Install does it
// (agent-install.mjs): a fixed command per way of installing (never text
// from the phone), shown first, run once confirmed in a Reach terminal.
//
// Fails closed. An update is offered only when every reading is one Reach
// understands: the copy Reach itself runs (not another one on PATH), a way
// of installing it recognizes from where that copy lives, an installed
// version and a published one that both parse, and the published one
// strictly newer. Anything else (a feed that can't be reached or says
// something unexpected, a copy in an unknown place, a version it can't
// read) shows as "couldn't check" and offers nothing. A copy inside an app
// (Codex in the ChatGPT app) updates with that app, never from here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { locateClaude } from "./agent-sessions/index.mjs";
import { findCodexExecutable } from "./capabilities.mjs";
import { probeAgent } from "./agent-sessions/compatibility.mjs";

const exec = promisify(execFile);

// Semantic versions only ("2.1.295", "0.162.0-alpha.2"), whole and short.
const SEMVER = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function parseVersion(text) {
  if (typeof text !== "string" || text.length > 100) return null;
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".") : [];
  // Numeric identifiers with leading zeros aren't semver: not guessed at.
  if (pre.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre, text: text.trim().replace(/^v/, "") };
}
// -1, 0 or 1; null when either isn't a version. A prerelease comes before
// its release (0.162.0-alpha.2 < 0.162.0); numeric parts compare as numbers
// (alpha.10 > alpha.2); build metadata is ignored.
export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const NAMES = { claude: "Claude Code", codex: "Codex" };
const quote = (file) => `'${file}'`;
// A path safe to put in a command between single quotes.
const plainPath = (file) => typeof file === "string" && path.isAbsolute(file) && !/['\0-\x1f\x7f]/.test(file);

// Who updates the copy at `file` (its real path, links followed), from
// where it lives. null: not a place Reach knows, so nothing is offered.
export function managerOf(agent, file, { real = fs.realpathSync, home = os.homedir(), platform = process.platform } = {}) {
  if (platform === "win32" || !plainPath(file)) return null;
  let target;
  try {
    target = real(file);
  } catch {
    return null;
  }
  if (!plainPath(target)) return null;
  // Inside an app bundle: the app's own updater keeps it current.
  const app = /^(.*?\/([^/]+)\.app)\/Contents\//.exec(target);
  if (app) return { manager: "app", app: app[2] };
  const cask = /\/Caskroom\/([a-z0-9][a-z0-9@._-]*)\//.exec(target);
  if (agent === "claude") {
    // Claude Code's native installer: ~/.local/bin/claude → its versions.
    if (target.startsWith(path.join(home, ".local/share/claude/versions") + "/"))
      return { manager: "native", channelFeed: true, command: `${quote(file)} update` };
    if (cask?.[1] === "claude-code" || cask?.[1] === "claude-code@latest")
      return { manager: "brew", cask: cask[1], command: `brew upgrade --cask ${cask[1]}` };
    if (target.includes("/node_modules/@anthropic-ai/claude-code/"))
      return { manager: "npm", channelFeed: true, command: `${quote(file)} update` };
    return null;
  }
  if (agent === "codex") {
    if (cask?.[1] === "codex") return { manager: "brew", cask: "codex", command: "brew upgrade --cask codex" };
    if (target.includes("/node_modules/@openai/codex/"))
      return { manager: "npm", package: "@openai/codex", command: "npm install -g @openai/codex@latest" };
    return null;
  }
  return null;
}

// A published version read from its maker's feed, bounded in time and size;
// null for anything that isn't exactly a version.
export async function readFeed(url, pick, { fetch: get = globalThis.fetch, timeoutMs = 8000, maxBytes = 512 * 1024 } = {}) {
  try {
    const res = await get(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { accept: "application/json, text/plain" } });
    if (!res.ok) return null;
    const length = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > maxBytes) return null;
    const text = await res.text();
    if (text.length > maxBytes) return null;
    const value = pick(text);
    return typeof value === "string" && parseVersion(value) ? parseVersion(value).text : null;
  } catch {
    return null;
  }
}
const json = (text, read) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? read(value) : null;
  } catch {
    return null;
  }
};

// Claude Code's update channel (settings' autoUpdatesChannel): "latest"
// unless set; an unknown value is not guessed at.
export function claudeChannel({ readFile = fs.readFileSync, file = path.join(os.homedir(), ".claude", "settings.json") } = {}) {
  let settings;
  try {
    settings = JSON.parse(readFile(file, "utf8"));
  } catch (e) {
    return e?.code === "ENOENT" ? "latest" : null;
  }
  const channel = settings && typeof settings === "object" ? settings.autoUpdatesChannel : undefined;
  if (channel === undefined) return "latest";
  return channel === "latest" || channel === "stable" ? channel : null;
}

// Where each way of installing publishes its newest version.
export function feedFor(agent, how, { channel = claudeChannel } = {}) {
  if (how.manager === "brew")
    return { url: `https://formulae.brew.sh/api/cask/${encodeURIComponent(how.cask)}.json`, pick: (t) => json(t, (j) => j.version) };
  if (agent === "claude" && how.channelFeed) {
    const name = channel();
    return name && { url: `https://downloads.claude.ai/claude-code-releases/${name}`, pick: (t) => t.trim() };
  }
  if (agent === "codex" && how.manager === "npm")
    return { url: `https://registry.npmjs.org/-/package/${how.package}/dist-tags`, pick: (t) => json(t, (j) => j.latest) };
  return null;
}

export function createAgentUpdates({
  locate = { claude: () => locateClaude(), codex: () => findCodexExecutable() },
  probe = (agent, file) => probeAgent(agent, file),
  manager = managerOf,
  feed = feedFor,
  read = readFeed,
  now = Date.now,
  // Published versions are kept a while; a failed look is retried sooner.
  ttlMs = 6 * 60 * 60 * 1000,
  failedTtlMs = 10 * 60 * 1000,
} = {}) {
  const published = new Map();
  const latest = async (url, pick, fresh) => {
    const kept = published.get(url);
    if (!fresh && kept && now() < kept.expires) return kept.value;
    const value = read(url, pick);
    const entry = { value, expires: now() + ttlMs };
    published.set(url, entry);
    value.then((v) => { if (!v) entry.expires = now() + failedTtlMs; });
    return value;
  };
  async function status(agent, { fresh = false } = {}) {
    if (!Object.hasOwn(NAMES, agent)) throw Object.assign(new Error("Reach can't update that app."), { status: 400 });
    const base = { agent, name: NAMES[agent] };
    const file = await Promise.resolve(locate[agent]()).catch(() => null);
    if (!file) return { ...base, state: "missing" };
    const how = manager(agent, file);
    const installed = parseVersion((await Promise.resolve(probe(agent, file)).catch(() => null))?.version || "")?.text || null;
    if (how?.manager === "app") return { ...base, state: "app", app: how.app, installed };
    if (!how) return { ...base, state: "unknown", installed, reason: "Reach can't tell how it was installed." };
    if (!installed) return { ...base, state: "unknown", manager: how.manager, reason: "Reach can't read its version." };
    const where = feed(agent, how);
    const newest = where ? await latest(where.url, where.pick, fresh) : null;
    if (!newest) return { ...base, state: "unknown", manager: how.manager, installed, reason: "Couldn't check for a newer version." };
    const order = compareVersions(installed, newest);
    if (order === null) return { ...base, state: "unknown", manager: how.manager, installed, reason: "Couldn't check for a newer version." };
    if (order >= 0) return { ...base, state: "current", manager: how.manager, installed, latest: newest };
    return { ...base, state: "available", manager: how.manager, installed, latest: newest, file, command: how.command };
  }
  return {
    status,
    async list({ fresh = false } = {}) {
      return Promise.all(Object.keys(NAMES).map((agent) => status(agent, { fresh }).catch(() => ({ agent, name: NAMES[agent], state: "unknown", reason: "Couldn't check for a newer version." }))));
    },
    // The update to run, read again now (never a stale offer): only when one
    // is available; its command is fixed by the way of installing.
    async plan(agent) {
      const s = await status(agent);
      if (s.state !== "available" || typeof s.command !== "string")
        throw Object.assign(new Error(s.state === "current" ? `${s.name} is up to date.` : s.state === "app" ? `${s.name} updates with the ${s.app} app.` : s.reason || `No ${s.name} update to install.`), { status: 409 });
      return { agent, name: s.name, command: s.command, from: s.installed, to: s.latest };
    },
  };
}
