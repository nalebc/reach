import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findCodexExecutable } from "../capabilities.mjs";

const exec = promisify(execFile);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// Slash commands, as each agent's own composer offers them after "/".
//
// Claude Code says which it has: its handshake lists the commands this
// installed version runs (skills, plugins and the folder's own commands
// included), so the list is its own, for the chat's folder. Each runs as the
// message itself, as typed in its apps.
//
// Codex has no call that lists them: its apps keep their "/" menus in their
// own code. Each of those commands is one call of Codex's app-server, though,
// so Reach offers the ones whose call the installed Codex has (read from its
// own description of its protocol, once per installed version), in the Codex
// app's words, plus the skills Codex lists for the chat's folder.
//   action: "run" runs when picked, as in the Codex app; "insert" puts
//   "/name " in the box and runs on send; "model"/"new" open Reach's own
//   picker or new chat.
export const CODEX_COMMANDS = [
  { name: "status", title: "Status", description: "Show chat ID, model, and rate limits", needs: ["account/rateLimits/read"], action: "run" },
  { name: "compact", title: "Compact", description: "Compact this chat's context", needs: ["thread/compact/start"], action: "run" },
  { name: "review", title: "Review", description: "Review your uncommitted changes, or against a branch", needs: ["review/start"], action: "run", hint: "[branch]" },
  { name: "fork", title: "Fork chat", description: "Fork this chat", needs: ["thread/fork"], action: "run" },
  { name: "rename", title: "Rename", description: "Rename the current chat", needs: ["thread/name/set"], action: "insert", hint: "<name>" },
  { name: "mcp", title: "MCP", description: "Show MCP server status", needs: ["mcpServerStatus/list"], action: "run" },
  { name: "model", title: "Model", description: "Change the model and reasoning", needs: ["model/list"], action: "model" },
  { name: "new", title: "New chat", description: "Start a blank chat in the same folder", needs: ["thread/start"], action: "new" },
];

// The calls an app-server answers, from its protocol description
// (`codex app-server generate-json-schema` writes ClientRequest.json).
export function protocolMethods(dir) {
  const schema = JSON.parse(fs.readFileSync(path.join(dir, "ClientRequest.json"), "utf8"));
  return new Set((schema.oneOf || []).flatMap((v) => v?.properties?.method?.enum || []));
}

// What the installed Codex answers, asked of Codex itself and asked again
// when Codex is updated (its executable changes).
export function createCodexMethods({ locate = findCodexExecutable, run = exec, tmp = os.tmpdir() } = {}) {
  let cached = null;
  return async function methods() {
    const codex = await locate();
    if (!codex) return new Set();
    let key = codex;
    try {
      const real = fs.realpathSync(codex);
      const stat = fs.statSync(real);
      key = `${real}:${stat.size}:${stat.mtimeMs}`;
    } catch {}
    if (cached?.key === key) return cached.value;
    const value = (async () => {
      const dir = fs.mkdtempSync(path.join(tmp, "reach-codex-protocol-"));
      try {
        await run(codex, ["app-server", "generate-json-schema", "--out", dir], { timeout: 20000, maxBuffer: 1 << 20 });
        return protocolMethods(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })();
    cached = { key, value };
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  };
}

const NAME = /^[\w:.-]{1,120}$/;
const LIMIT_NAMES = { 300: "5-hour limit", 10080: "Weekly limit" };
const PLAN_NAMES = { prolite: "Pro Lite", promax: "Pro Max", edu_plus: "Edu Plus", edu_pro: "Edu Pro" };
const planName = (plan) => PLAN_NAMES[plan] || plan[0].toUpperCase() + plan.slice(1).replace(/_/g, " ");
// Why Codex couldn't answer, in its own words (the service's message when it
// gave one).
const reason = (error) => {
  const text = String(error?.message || "");
  const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
  return (said || text).slice(0, 200);
};
const limitName = (mins) => LIMIT_NAMES[mins] || (mins ? `${mins >= 60 ? `${Math.round(mins / 60)}-hour` : `${mins}-minute`} limit` : "Limit");
const MCP_STATUS = {
  connected: "Connected",
  starting: "Starting",
  notStarted: "Not started",
  authenticationRequired: "Needs sign-in",
  failed: "Failed",
  cancelled: "Cancelled",
  disabled: "Off",
};

export function createSlashCommands({
  claudeHost,
  daemon,
  codexLive,
  codex,
  claude,
  codexMethods = createCodexMethods(),
  now = Date.now,
  skillsMs = 60000,
}) {
  // Skills per folder, kept a minute (the menu opens often).
  const skillCache = new Map();
  async function codexSkills(cwd) {
    const hit = skillCache.get(cwd);
    if (hit && now() - hit.at < skillsMs) return hit.value;
    const r = await daemon.rpc("skills/list", { cwds: [cwd] });
    const entry = (r?.data || []).find((e) => e.cwd === cwd) || r?.data?.[0];
    const value = (entry?.skills || [])
      .filter((s) => s?.enabled !== false && NAME.test(String(s?.name || "")) && typeof s.path === "string")
      .map((s) => ({
        name: s.name,
        title: s.interface?.displayName || s.name,
        description: s.interface?.shortDescription || s.shortDescription || s.description || "",
        hint: "",
        group: "skills",
        action: "insert",
        path: s.path,
      }));
    skillCache.set(cwd, { at: now(), value });
    return value;
  }
  // A chat's folder doesn't change: read once per chat.
  const folders = new Map();
  const cwdOf = async (agent, id) => {
    const adapter = { codex, claude }[agent];
    if (!id || !adapter) return undefined;
    const key = `${agent}:${id}`;
    if (folders.has(key)) return folders.get(key);
    const { session } = (await adapter.read(id, { limit: 1 })) || {};
    if (session?.cwd) folders.set(key, session.cwd);
    return session?.cwd;
  };
  const builtIns = async () => {
    const methods = await codexMethods().catch(() => new Set());
    return CODEX_COMMANDS.filter((c) => c.needs.every((m) => methods.has(m))).map(({ needs, ...c }) => ({ hint: "", ...c }));
  };

  async function status(id) {
    const [read, limits, account] = await Promise.all([
      codex.read(id, { limit: 1 }).catch(() => null),
      daemon.rpc("account/rateLimits/read", {}).catch((error) => ({ error })),
      daemon.rpc("account/read", {}).catch(() => null),
    ]);
    const s = read?.session || {};
    const rows = [{ label: "Chat", value: id }];
    if (s.cwd) rows.push({ label: "Folder", value: s.cwd });
    if (s.model) rows.push({ label: "Model", value: `${s.model}${s.effort ? ` · ${s.effort}` : ""}` });
    const plan = account?.account?.planType || limits?.rateLimits?.planType;
    if (plan && plan !== "unknown") rows.push({ label: "Plan", value: planName(plan) });
    if (limits?.error) rows.push({ label: "Limits", value: `Codex couldn't read them: ${reason(limits.error)}` });
    for (const w of [limits?.rateLimits?.primary, limits?.rateLimits?.secondary])
      if (w && typeof w.usedPercent === "number")
        rows.push({ label: limitName(w.windowDurationMins), value: `${w.usedPercent}% used`, ...(w.resetsAt ? { resetsAt: w.resetsAt * 1000 } : {}) });
    if (limits?.ordinaryUsageAllowed === false) rows.push({ label: "Usage", value: "Out of usage" });
    return { card: { title: "Status", rows } };
  }
  async function mcp(id) {
    const r = await daemon.rpc("mcpServerStatus/list", { detail: "toolsAndAuthOnly", threadId: id }).catch(() =>
      daemon.rpc("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }),
    );
    const rows = (r?.data || []).map((m) => {
      const tools = m.tools && typeof m.tools === "object" ? Object.keys(m.tools).length : 0;
      const state = MCP_STATUS[m.runtimeStatus] || (m.authStatus === "notLoggedIn" ? "Needs sign-in" : "Configured");
      return { label: m.name, value: `${state}${tools ? ` · ${tools} tool${tools === 1 ? "" : "s"}` : ""}` };
    });
    return { card: { title: "MCP servers", rows, empty: "No MCP servers are set up for Codex." } };
  }

  return {
    // What "/" offers in this agent's chat (its folder decides the skills
    // and the folder's own commands).
    async list(agent, { id } = {}) {
      if (agent === "claude") {
        const cwd = await cwdOf("claude", id).catch(() => undefined);
        return (await claudeHost.commands(cwd)).map((c) => ({
          name: c.name,
          description: c.description || "",
          hint: c.argumentHint || "",
          // /clear starts another session inside the same Claude Code
          // (verified: a new session id and transcript); the phone would go
          // on writing into one it doesn't show. A new chat, as /clear makes.
          action: c.name === "clear" ? "new" : "insert",
        }));
      }
      if (agent !== "codex") return [];
      const [own, cwd] = await Promise.all([builtIns(), cwdOf("codex", id).catch(() => undefined)]);
      const skills = cwd ? await codexSkills(cwd).catch(() => []) : [];
      return [...own, ...skills.map(({ path: _, ...s }) => s)];
    },
    // A skill picked in this chat, as Codex sends it: {name, path}, the path
    // from Codex's own list, never from the phone.
    async skill(id, name) {
      const cwd = await cwdOf("codex", id);
      const found = cwd && (await codexSkills(cwd)).find((s) => s.name === name);
      if (!found) throw bad(`Codex has no skill named ${name} for this chat's folder.`, 404);
      return { name: found.name, path: found.path };
    },
    // Runs one of Codex's own commands in this chat; only those the menu
    // offers.
    async run(agent, id, name, args = "") {
      if (agent !== "codex") throw bad("Claude Code runs its commands as the message: send it.", 400);
      const command = (await builtIns()).find((c) => c.name === name && (c.action === "run" || c.action === "insert"));
      if (!command) throw bad(`Codex doesn't offer /${String(name).slice(0, 40)} here.`, 404);
      const text = typeof args === "string" ? args.trim().slice(0, 200) : "";
      switch (name) {
        case "status":
          return status(id);
        case "mcp":
          return mcp(id);
        case "compact":
          await codexLive.call(id, "thread/compact/start", {});
          return { ok: true };
        case "review":
          await codexLive.call(id, "review/start", {
            target: text ? { type: "baseBranch", branch: text } : { type: "uncommittedChanges" },
            delivery: "inline",
          });
          return { ok: true };
        case "rename": {
          if (!text) throw bad("Write the chat's new name after /rename.");
          await daemon.rpc("thread/name/set", { threadId: id, name: text.slice(0, 120) });
          return { ok: true, title: text.slice(0, 120) };
        }
        case "fork": {
          // From a chosen message: through its turn (thread/fork's lastTurnId).
          const through = typeof args === "string" && /^[\w-]{8,128}$/.test(args.trim()) ? args.trim() : null;
          const r = await daemon.rpc("thread/fork", { threadId: id, excludeTurns: true, ...(through ? { lastTurnId: through } : {}) });
          const forked = r?.thread?.id;
          if (!forked) throw bad("Codex didn't make the fork.", 502);
          // Like a chat Reach moves: the fork is Codex's, not held here.
          daemon.rpc("thread/unsubscribe", { threadId: forked }).catch(() => {});
          const { session } = await codex.read(forked, { limit: 1 }).catch(() => ({ session: null }));
          return { ok: true, session: session || { agent: "codex", id: forked } };
        }
        default:
          throw bad(`Codex doesn't offer /${name} here.`, 404);
      }
    },
  };
}
