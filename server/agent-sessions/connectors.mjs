// Connectors: what Claude Code, Codex and Gemini CLI can reach (GitHub,
// Linear, …), added from the phone through each agent's own configuration.
//
// Each agent keeps its connectors itself; Reach only asks it (verified with
// claude 2.1.291, codex-cli 0.160.0, gemini 0.39.1):
// - Claude Code: `claude mcp add|remove -s user` writes ~/.claude.json;
//   `claude mcp list` also shows the connectors of the claude.ai account
//   ("claude.ai Gmail: <url> - ✔ Connected"); `claude mcp login --no-browser`
//   prints a link and waits at "Or paste the redirect URL here:".
// - Codex: its daemon. `app/list` is ChatGPT's own apps (GitHub among them),
//   linked on chatgpt.com; `config/batchWrite` on mcp_servers.<name> (null
//   removes it), `mcpServer/oauth/login` answers with a link and reports
//   `mcpServer/oauthLogin/completed`.
// - Gemini CLI: `gemini mcp add|remove -s user` writes ~/.gemini/settings.json.
//   It signs in to a server only from its own prompt (/mcp auth <name>).
//
// Signing in to a server calls back to localhost on the computer, a page the
// phone can't open: the phone pastes the address it was sent to, checked
// against the link Reach handed out, and the computer finishes it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import { plainText } from "./sign-in.mjs";

const exec = promisify(execFile);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const clip = (text, max) => {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
export const AGENTS = ["claude", "codex", "gemini"];

// Servers known to work with these agents. GitHub's has no dynamic client
// registration, so the CLIs can't sign in to it: it takes a token instead.
export const CATALOG = [
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues and pull requests",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "token",
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects and cycles",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Pages and databases",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Errors and performance issues",
    url: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
  },
];

export function validName(value) {
  const name = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name))
    throw bad("Name it with letters, numbers, - or _ (up to 40).");
  return name;
}
export function validUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw bad("Enter the server's https:// address.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 500)
    throw bad("Enter the server's https:// address.");
  return url.href;
}
export function validToken(value) {
  const token = String(value ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!/^[\x21-\x7e]{8,512}$/.test(token)) throw bad("Paste the whole token.");
  return token;
}

// The address the phone's browser was sent back to after signing in, if it
// is the one this sign-in waits for: same localhost origin and path as the
// link's redirect_uri, same state.
export function oauthCallback(authorizationUrl, pasted) {
  const again = "Paste the whole address from your browser's address bar.";
  let auth, back, redirect;
  try {
    auth = new URL(authorizationUrl);
    redirect = new URL(auth.searchParams.get("redirect_uri") || "");
    back = new URL(String(pasted ?? "").trim());
  } catch {
    throw bad(again);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"];
  if (
    redirect.protocol !== "http:" ||
    !local.includes(redirect.hostname) ||
    back.origin !== redirect.origin ||
    back.pathname !== redirect.pathname
  )
    throw bad(again);
  const state = auth.searchParams.get("state");
  if (state && back.searchParams.get("state") !== state)
    throw bad("That address is from another sign-in. Start again.");
  if (!back.searchParams.get("code") && !back.searchParams.get("error")) throw bad(again);
  return back.href;
}

// The link `claude mcp login --no-browser` prints (inside an OSC 8 hyperlink
// the target comes first and ends at ESC).
export function claudeLoginLink(output) {
  const text = String(output);
  const at = text.indexOf("Visit this URL to authorize");
  if (at < 0) return null;
  const m = text.slice(at).match(/https:\/\/[^\s\x07\x1b"'<>]+/);
  return m && /[?&]redirect_uri=/.test(m[0]) ? m[0] : null;
}

// `claude mcp list` lines: "<name>: <url or command> [(HTTP)] - <status>".
// A name may hold ":" (plugin:x:y), never ": ".
export function parseClaudeList(output) {
  const states = [
    [/Connected/i, "connected"],
    [/Needs authentication/i, "needs-auth"],
    [/Failed/i, "failed"],
    [/Not configured/i, "off"],
    [/Pending approval/i, "off"],
  ];
  const servers = [];
  for (const line of plainText(output).split("\n")) {
    const m = line.trim().match(/^(.+?): (.*?) - (.+)$/);
    if (!m) continue;
    const target = m[2].replace(/\s*\((HTTP|SSE|stdio|WebSocket)\)$/i, "").trim();
    servers.push({
      name: m[1],
      target,
      state: states.find(([re]) => re.test(m[3]))?.[1] || "added",
    });
  }
  return servers;
}

// Both command lines and provider output can contain existing credentials.
const safeCliError = (error) => error.killed ? "The agent didn't answer in time." : "The agent command failed. Check its connector settings on the computer.";

const shown = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
};

export function createConnectors({
  daemon, // the shared Codex daemon
  locate = {}, // { claude, codex, gemini }: async () => absolute path or null
  home = os.homedir(),
  run = exec, // (file, args, options) => { stdout }
  spawn = pty.spawn,
  shell = process.env.SHELL || "/bin/zsh",
  platform = process.platform,
  env = process.env,
  // Finishing a sign-in on this computer: the localhost address the agent waits on.
  visit = (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) }),
  now = Date.now,
  listMs = 60000,
  appsMs = 5 * 60000,
  timeoutMs = 10 * 60000,
  linkMs = 10000,
}) {
  let closed = false;
  const ensureOpen = () => { if (closed) throw bad("Connector service is closed.", 409); };
  // Reach's own environment, never a host app's.
  const clean = Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|REACH_)/.test(k) && k !== "CLAUDECODE"),
  );
  const where = async (agent) => {
    const found = await locate[agent]?.().catch(() => null);
    return typeof found === "string" && found ? found : null;
  };
  const need = async (agent) => {
    const cli = await where(agent);
    if (!cli) throw bad(`${agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Gemini CLI"} isn't installed on this computer.`, 404);
    return cli;
  };
  // An agent's CLI as the owner's login shell runs it, from their home folder
  // (so `-s user` is the only scope touched).
  const cli = async (agent, args, timeout = 30000, authorize = () => {}) => {
    ensureOpen();
    if (platform === "win32") throw bad("Connector CLI management is not supported on Windows yet.", 409);
    const file = await need(agent);
    ensureOpen();
    authorize();
    try {
      const { stdout } = await run(shell, ["-lc", `exec ${[file, ...args].map(quote).join(" ")}`], {
        cwd: home,
        env: clean,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
      return String(stdout);
    } catch (e) {
      throw bad(safeCliError(e), 502);
    }
  };
  const readJson = async (file) => {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return {};
    }
  };
  const codexRequest = async (method, params) => {
    ensureOpen();
    try {
      return await daemon.rpc(method, params);
    } catch {
      // Provider failures can include serialized config (including headers).
      throw bad("Codex couldn't complete the connector request. Check its settings on the computer and try again.", 502);
    }
  };
  // Only a server's name, address and state leave the computer: never its
  // headers, environment or arguments (they hold tokens).
  const server = (name, entry, state) => {
    const url = typeof entry?.url === "string" ? entry.url : typeof entry?.httpUrl === "string" ? entry.httpUrl : null;
    return { name, url: url && shown(url), remote: !!url, state };
  };

  // ── Claude Code ──
  let claudeList = null;
  const listClaude = (fresh) => {
    if (fresh || !claudeList || now() - claudeList.at > listMs) {
      const value = cli("claude", ["mcp", "list"], 60000).then(parseClaudeList);
      claudeList = { at: now(), value };
      value.catch(() => (claudeList = null));
    }
    return claudeList.value;
  };
  async function claudeView({ fresh }) {
    const [listed, config] = await Promise.all([listClaude(fresh), readJson(path.join(home, ".claude.json"))]);
    const ours = config?.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
    const native = listed
      .filter((s) => s.name.startsWith("claude.ai "))
      .map((s) => ({ id: s.name, name: s.name.slice("claude.ai ".length), state: s.state, detail: shown(s.target) }));
    const servers = Object.entries(ours).map(([name, entry]) =>
      server(name, entry, listed.find((s) => s.name === name)?.state || "added"),
    );
    return { native, servers, manageUrl: "https://claude.ai/settings/connectors" };
  }

  // ── Codex ──
  let codexApps = null;
  const listApps = (fresh) => {
    if (fresh || !codexApps || now() - codexApps.at > appsMs) {
      const value = (async () => {
        const all = [];
        let cursor = null;
        for (let page = 0; page < 10; page++) {
          const r = await codexRequest("app/list", { limit: 200, cursor, ...(fresh && !page ? { forceRefetch: true } : {}) });
          for (const a of Array.isArray(r?.data) ? r.data : [])
            if (a && typeof a.id === "string" && typeof a.name === "string") all.push(a);
          cursor = r?.nextCursor;
          if (!cursor) break;
        }
        return all;
      })();
      codexApps = { at: now(), value };
      value.catch(() => (codexApps = null));
    }
    return codexApps.value;
  };
  const app = (a) => ({
    id: a.id,
    name: clip(a.name, 60),
    description: clip(a.description, 140) || null,
    logo: /^https:\/\//.test(a.logoUrl || "") ? a.logoUrl : null,
    state: a.isAccessible ? (a.isEnabled === false ? "off" : "connected") : "available",
    enabled: a.isEnabled !== false,
    connectUrl: /^https:\/\/chatgpt\.com\//.test(a.installUrl || "") ? a.installUrl : null,
  });
  const CODEX_AUTH = { bearerToken: "connected", oAuth: "connected", notLoggedIn: "needs-auth" };
  async function codexView({ fresh, q }) {
    if (!daemon) throw bad("Codex isn't installed on this computer.", 404);
    const [apps, config, status] = await Promise.all([
      listApps(fresh).catch(() => []),
      codexRequest("config/read", {}),
      codexRequest("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }).catch(() => ({ data: [] })),
    ]);
    const statuses = new Map((status?.data || []).map((s) => [s.name, s]));
    const configured = config?.config?.mcp_servers || {};
    const servers = Object.entries(configured)
      .filter(([name]) => !statuses.get(name)?.pluginId)
      .map(([name, entry]) =>
        server(name, entry, entry?.enabled === false ? "off" : CODEX_AUTH[statuses.get(name)?.authStatus] || "added"),
      );
    // Linked apps, the catalog's own (so GitHub is one tap), and a search.
    const query = String(q || "").trim().toLowerCase().slice(0, 60);
    const catalog = new Set(CATALOG.map((c) => c.name.toLowerCase()));
    const native = apps
      .filter((a) =>
        query ? a.name.toLowerCase().includes(query) : a.isAccessible || catalog.has(a.name.toLowerCase()),
      )
      .sort((a, b) => Number(!!b.isAccessible) - Number(!!a.isAccessible) || a.name.localeCompare(b.name))
      .slice(0, query ? 30 : 100)
      .map(app);
    return { native, servers, manageUrl: "https://chatgpt.com/apps" };
  }

  // ── Gemini CLI ──
  async function geminiView() {
    const settings = await readJson(path.join(home, ".gemini", "settings.json"));
    const servers = Object.entries(settings?.mcpServers || {}).map(([name, entry]) => server(name, entry, "added"));
    return { native: [], servers, manageUrl: null };
  }

  // ── Signing in to a server ──
  const flows = new Map(); // `${agent}:${name}` -> flow
  const active = (flow) => !closed && ["starting", "link", "checking"].includes(flow.state);
  const view = (flow) =>
    flow
      ? { agent: flow.agent, name: flow.name, state: flow.state, url: flow.url, error: flow.error }
      : { state: "idle", url: null, error: null };
  const finish = (flow, state, error = null) => {
    if (["done", "failed", "cancelled"].includes(flow.state)) return;
    clearTimeout(flow.timer);
    flow.state = state;
    flow.error = error;
    if (state === "done" && flow.agent === "claude") claudeList = null;
    for (const wake of flow.waiters.splice(0)) wake();
  };
  // Until the flow leaves `state` (or ms pass).
  const settled = (flow, ms, state = "starting") =>
    flow.state !== state
      ? Promise.resolve()
      : new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          flow.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
  const unsubscribe = daemon?.onNotification?.((m) => {
    if (m.method !== "mcpServer/oauthLogin/completed") return;
    const flow = flows.get(`codex:${m.params?.name}`);
    // This notification has only a server name, so it can belong to a
    // cancelled attempt. Accept it only after this flow's own callback and
    // confirm the server's actual authentication before reporting success.
    if (!flow || !active(flow) || flow.state !== "checking") return;
    if (!m.params?.success) return;
    codexRequest("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }).then((status) => {
      if (flows.get(`codex:${flow.name}`) !== flow || !active(flow) || flow.state !== "checking") return;
      if ((status?.data || []).some((s) => s.name === flow.name && s.authStatus === "oAuth")) finish(flow, "done");
    }).catch(() => {});
  });

  async function loginClaude(flow) {
    if (platform === "win32") throw bad("Connector CLI sign-in is not supported on Windows yet.", 409);
    const file = await need("claude");
    if (!active(flow)) return;
    flow.authorize();
    const proc = spawn(shell, ["-lc", `exec ${[file, "mcp", "login", "--no-browser", flow.name].map(quote).join(" ")}`], {
      name: "xterm-256color",
      cols: 400,
      rows: 40,
      cwd: home,
      env: { ...clean, TERM: "xterm-256color" },
    });
    flow.proc = proc;
    flow.output = "";
    proc.onData((data) => {
      if (!active(flow)) return;
      flow.output = (flow.output + data).slice(-20000);
      if (flow.state === "starting") {
        const url = claudeLoginLink(flow.output);
        if (url) {
          flow.url = url;
          flow.state = "link";
          for (const wake of flow.waiters.splice(0)) wake();
        }
      }
    });
    proc.onExit(({ exitCode }) => {
      if (exitCode === 0) finish(flow, "done");
      else finish(flow, "failed", `Sign-in ended (code ${exitCode}). Check Claude Code's connector settings on the computer.`);
    });
  }
  async function loginCodex(flow) {
    if (!daemon) throw bad("Codex isn't installed on this computer.", 404);
    flow.authorize();
    const r = await codexRequest("mcpServer/oauth/login", { name: flow.name });
    if (!active(flow)) return;
    flow.authorize();
    if (typeof r?.authorizationUrl !== "string" || !/^https:\/\//.test(r.authorizationUrl))
      throw bad("Codex didn't give a sign-in link for this server.", 502);
    flow.url = r.authorizationUrl;
    flow.state = "link";
  }

  return {
    catalog: CATALOG,
    async list(agent, { fresh = false, q = "" } = {}) {
      if (!AGENTS.includes(agent)) throw bad("Unknown agent.", 404);
      const installed = agent === "codex" ? !!(await where("codex")) && !!daemon : !!(await where(agent));
      if (!installed) return { agent, installed: false, native: [], servers: [], manageUrl: null, catalog: CATALOG };
      const v = agent === "claude" ? await claudeView({ fresh }) : agent === "codex" ? await codexView({ fresh, q }) : await geminiView();
      return { agent, installed: true, ...v, catalog: CATALOG, signIn: agent !== "gemini" };
    },
    // A remote server added in the agent's own configuration, for every
    // project; with a token, sent as its Authorization header.
    async add(agent, { name, url, token = null, authorize = () => {} }) {
      ensureOpen();
      if (!AGENTS.includes(agent)) throw bad("Unknown agent.", 404);
      name = validName(name);
      url = validUrl(url);
      const bearer = token ? `Bearer ${validToken(token)}` : null;
      const header = bearer && `Authorization: ${bearer}`;
      if (agent === "codex") {
        if (!daemon) throw bad("Codex isn't installed on this computer.", 404);
        authorize();
        await codexRequest("config/batchWrite", {
          edits: [
            {
              keyPath: `mcp_servers.${name}`,
              value: { url, ...(bearer ? { http_headers: { Authorization: bearer } } : {}) },
              mergeStrategy: "replace",
            },
          ],
          reloadUserConfig: true,
        });
        authorize();
        await codexRequest("config/mcpServer/reload", null).catch(() => {});
      } else if (agent === "claude") {
        // Preserve an existing user connector if its replacement fails.
        const original = (await readJson(path.join(home, ".claude.json"))).mcpServers?.[name];
        if (original) await cli("claude", ["mcp", "remove", "-s", "user", name], 30000, authorize);
        try {
          await cli("claude", ["mcp", "add", "-s", "user", "-t", "http", ...(header ? ["-H", header] : []), name, url], 30000, authorize);
        } catch (error) {
          if (original) {
            try {
              await cli("claude", ["mcp", "add-json", "-s", "user", name, JSON.stringify(original)]);
            } catch {
              throw bad("Replacement failed and the previous connector could not be restored. Check Claude Code's connector settings on the computer.", 502);
            }
          }
          throw error;
        }
        claudeList = null;
      } else {
        await cli("gemini", ["mcp", "add", "-s", "user", "-t", "http", ...(header ? ["-H", header] : []), name, url], 30000, authorize);
      }
      return { agent, name };
    },
    async remove(agent, name, { authorize = () => {} } = {}) {
      ensureOpen();
      if (!AGENTS.includes(agent)) throw bad("Unknown agent.", 404);
      name = validName(name);
      if (agent === "codex") {
        if (!daemon) throw bad("Codex isn't installed on this computer.", 404);
        authorize();
        await codexRequest("config/batchWrite", {
          edits: [{ keyPath: `mcp_servers.${name}`, value: null, mergeStrategy: "replace" }],
          reloadUserConfig: true,
        });
        authorize();
        await codexRequest("config/mcpServer/reload", null).catch(() => {});
      } else {
        await cli(agent, ["mcp", "remove", "-s", "user", name], 30000, authorize);
        if (agent === "claude") claudeList = null;
      }
      return { agent, name };
    },
    // One of ChatGPT's apps on or off for Codex (linking it is ChatGPT's).
    async setApp(id, enabled, { authorize = () => {} } = {}) {
      ensureOpen();
      if (!daemon) throw bad("Codex isn't installed on this computer.", 404);
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw bad("Unknown app.", 404);
      authorize();
      await codexRequest("config/batchWrite", {
        edits: [{ keyPath: `apps.${id}.enabled`, value: !!enabled, mergeStrategy: "upsert" }],
        reloadUserConfig: true,
      });
      codexApps = null;
      return { id, enabled: !!enabled };
    },
    // GitHub's token from the GitHub CLI signed in on this computer, for the
    // owner who chose it; it never goes to the phone.
    async githubToken(url) {
      ensureOpen();
      if (validUrl(url) !== CATALOG.find((entry) => entry.id === "github").url)
        throw bad("Use the GitHub connector address when reusing the GitHub CLI token.");
      try {
        const { stdout } = await run(shell, ["-lc", "exec gh auth token"], { cwd: home, env: clean, timeout: 10000 });
        return validToken(stdout);
      } catch {
        throw bad("The GitHub CLI isn't signed in on this computer. Run `gh auth login` there, or paste a token.", 409);
      }
    },
    async login(agent, name, { authorize = () => {} } = {}) {
      if (closed) throw bad("Connector service is closed.", 409);
      if (agent === "gemini")
        throw bad(`Gemini CLI signs in itself: on your computer, run gemini, then /mcp auth ${name} (a Reach terminal works).`, 409);
      if (agent !== "claude" && agent !== "codex") throw bad("Unknown agent.", 404);
      name = validName(name);
      const key = `${agent}:${name}`;
      const current = flows.get(key);
      if (current && ["starting", "link", "checking"].includes(current.state)) return view(current);
      const flow = { agent, name, state: "starting", url: null, error: null, waiters: [], authorize };
      flows.set(key, flow);
      flow.timer = setTimeout(() => {
        this.cancel(agent, name);
        flow.state = "failed";
        flow.error = "Sign-in timed out. Start again.";
      }, timeoutMs);
      flow.timer.unref?.();
      try {
        if (agent === "claude") await loginClaude(flow);
        else await loginCodex(flow);
      } catch (e) {
        finish(flow, "failed", e.message);
        throw e;
      }
      await settled(flow, linkMs);
      return view(flow);
    },
    // The address the browser landed on after approving, finished here.
    async callback(agent, name, pasted) {
      const flow = flows.get(`${agent}:${name}`);
      if (!flow || flow.state !== "link" || !flow.url) throw bad("There's no sign-in waiting.", 409);
      const target = oauthCallback(flow.url, pasted);
      flow.state = "checking";
      if (agent === "claude") {
        flow.proc.write(`${target}\r`);
        return view(flow);
      }
      try {
        await visit(target);
      } catch {
        finish(flow, "failed", "Codex stopped waiting for this sign-in. Start again.");
      }
      if (!active(flow)) return view(flow);
      // Codex reports the result itself; usually at once.
      await settled(flow, 5000, "checking");
      return view(flow);
    },
    loginView: (agent, name) => view(flows.get(`${agent}:${name}`)),
    cancel(agent, name) {
      const flow = flows.get(`${agent}:${name}`);
      if (!flow) return view(null);
      if (["starting", "link", "checking"].includes(flow.state)) {
        try {
          flow.proc?.kill();
        } catch {}
        finish(flow, "cancelled");
      }
      return view(flow);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const flow of flows.values()) this.cancel(flow.agent, flow.name);
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
}
