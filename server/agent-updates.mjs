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
import { compareVersions, parseVersion } from "./versions.mjs";
import { boundedResponseText } from "./http-response.mjs";
import { envValue, spawnable } from "./agent-cli.mjs";

const exec = promisify(execFile);

// Version reading and order, shared with Reach's own updates (reach-updates.mjs).
export { parseVersion, compareVersions };

const NAMES = { claude: "Claude Code", codex: "Codex" };
const quote = (file) => `'${file}'`;
// A path safe to put in a command between single quotes.
const plainPath = (file) => typeof file === "string" && path.isAbsolute(file) && !/['\0-\x1f\x7f]/.test(file);

// Who updates the copy at `file` (its real path, links followed), from
// where it lives. null: not a place Reach knows, so nothing is offered.
export function managerOf(agent, file, { real = fs.realpathSync, home = os.homedir(), platform = process.platform, env = process.env, node = process.execPath } = {}) {
  if (platform === "win32") return windowsManagerOf(agent, file, { real, home, env, node });
  if (!plainPath(file)) return null;
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
    const global = target.indexOf("/lib/node_modules/@openai/codex/");
    if (global >= 0) {
      const prefix = target.slice(0, global) || "/";
      // The login shell may select a different Node/npm prefix than the
      // Codex Reach discovered. Update this exact installation, not that one.
      return { manager: "npm", package: "@openai/codex", command: `npm install -g --prefix ${quote(prefix)} @openai/codex@latest` };
    }
    return null;
  }
  return null;
}

// The same decisions on Windows (audit #33, Oct 12), in PowerShell, which
// runs Reach's terminals there: a program is called (&), each path between
// single quotes, which PowerShell also reads in their typographic forms.
const plainWindowsPath = (file) => typeof file === "string" && /^[A-Za-z]:\\/.test(file) && !/['‘’‚‛\0-\x1f\x7f]/.test(file);
const within = (file, dir) => file.toLowerCase().startsWith(`${dir.toLowerCase()}\\`);
function windowsManagerOf(agent, file, { real, home, env, node }) {
  if (!plainWindowsPath(file)) return null;
  let target;
  try {
    target = real(file);
  } catch {
    return null;
  }
  if (!plainWindowsPath(target)) return null;
  const win = path.win32;
  if (agent === "claude") {
    // Its own update, as on a Mac: started as Reach starts it (a script
    // with Node, never by Windows' script host).
    const cli = spawnable(file, { platform: "win32", node });
    const parts = [cli.file, ...cli.args];
    if (!parts.every(plainWindowsPath)) return null;
    const command = `& ${parts.map(quote).join(" ")} update`;
    // Claude Code's native installer: %USERPROFILE%\.local\bin\claude.exe.
    const local = win.join(home, ".local");
    if (target.toLowerCase() === win.join(local, "bin", "claude.exe").toLowerCase() || within(target, win.join(local, "share", "claude", "versions")))
      return { manager: "native", channelFeed: true, command };
    if (/\\node_modules\\@anthropic-ai\\claude-code\\/i.test(target)) return { manager: "npm", channelFeed: true, command };
    return null;
  }
  if (agent === "codex") {
    // npm's global folder (%APPDATA%\npm), Codex's own native codex.exe
    // inside it included. A project's node_modules looks the same on
    // Windows, so no other folder is taken for a global install.
    const prefix = envValue(env, "APPDATA") ? win.join(envValue(env, "APPDATA"), "npm") : win.join(home, "AppData", "Roaming", "npm");
    const modules = win.join(prefix, "node_modules", "@openai");
    const inside = within(target, modules) ? target.slice(modules.length + 1) : "";
    // Its package (bin\codex.js, the codex.exe in it), or its native one beside it.
    if (!plainWindowsPath(prefix) || !/^codex(?:-win32-[\w-]+)?\\/i.test(inside)) return null;
    return { manager: "npm", package: "@openai/codex", command: `npm.cmd install -g --prefix ${quote(prefix)} '@openai/codex@latest'` };
  }
  return null;
}

// A published version read from its maker's feed, bounded in time and size;
// null for anything that isn't exactly a version.
export async function readFeed(url, pick, { fetch: get = globalThis.fetch, timeoutMs = 8000, maxBytes = 512 * 1024 } = {}) {
  try {
    const res = await get(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { accept: "application/json, text/plain" } });
    if (!res.ok) return null;
    const text = await boundedResponseText(res, maxBytes);
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
    const value = Promise.resolve().then(() => read(url, pick)).catch(() => null);
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
