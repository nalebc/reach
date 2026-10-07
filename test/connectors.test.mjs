import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeLoginLink,
  createConnectors,
  oauthCallback,
  parseClaudeList,
  validName,
  validUrl,
} from "../server/agent-sessions/connectors.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// What `claude mcp list` printed (claude 2.1.291), with made-up servers.
const CLAUDE_LIST =
  "Checking MCP server health…\n\n" +
  "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected\n" +
  "plugin:product-management:linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication\n" +
  "github: https://api.githubcopilot.com/mcp/ (HTTP) - ✔ Connected\n" +
  "linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication\n";
// What `claude mcp login --no-browser linear` printed, link as an OSC 8 hyperlink.
const AUTH =
  "https://mcp.linear.app/authorize?response_type=code&client_id=c&code_challenge=x&redirect_uri=http%3A%2F%2Flocalhost%3A59547%2Fcallback&state=S1";
const LOGIN_OUTPUT =
  'Starting authentication for "linear"…\r\nVisit this URL to authorize:\r\n  ' +
  `\x1b]8;;${AUTH}\x1b\\${AUTH}\x1b]8;;\x1b\\\r\n\r\nWaiting for authorization… (^C to cancel)\r\nOr paste the redirect URL here: `;

const home = () => fs.mkdtemp(path.join(os.tmpdir(), "reach-connectors-"));
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
// The agents' CLIs, recorded: the command line each would have run.
function fakeRun(outputs = {}) {
  const ran = [];
  const run = async (file, args) => {
    const line = args.at(-1);
    ran.push(line);
    for (const [match, stdout] of Object.entries(outputs)) if (line.includes(match)) return { stdout };
    return { stdout: "" };
  };
  return { ran, run };
}
function fakeDaemon(answers = {}) {
  const calls = [];
  let notify;
  return {
    calls,
    notify: (m) => notify(m),
    rpc: async (method, params) => {
      calls.push([method, params]);
      const a = answers[method];
      return typeof a === "function" ? a(params) : a || {};
    },
    onNotification: (fn) => (notify = fn),
  };
}
function fakeTerminal() {
  let onData, onExit;
  const proc = { written: [], killed: false, write: (t) => proc.written.push(t), kill: () => (proc.killed = true), onData: (f) => (onData = f), onExit: (f) => (onExit = f) };
  const spawned = [];
  return { proc, spawned, spawn: (file, args) => (spawned.push(args.at(-1)), proc), print: (t) => onData(t), exit: (exitCode) => onExit({ exitCode }) };
}
const located = { claude: async () => "/usr/local/bin/claude", codex: async () => "/usr/local/bin/codex", gemini: async () => "/usr/local/bin/gemini" };

test("Claude Code's server list and sign-in link are read from its output", () => {
  assert.deepEqual(parseClaudeList(CLAUDE_LIST), [
    { name: "claude.ai Gmail", target: "https://gmailmcp.googleapis.com/mcp/v1", state: "connected" },
    { name: "plugin:product-management:linear", target: "https://mcp.linear.app/mcp", state: "needs-auth" },
    { name: "github", target: "https://api.githubcopilot.com/mcp/", state: "connected" },
    { name: "linear", target: "https://mcp.linear.app/mcp", state: "needs-auth" },
  ]);
  assert.equal(claudeLoginLink(LOGIN_OUTPUT), AUTH);
  assert.equal(claudeLoginLink("Starting authentication…"), null);
});

test("only the localhost address this sign-in waits for is accepted back", () => {
  const ok = "http://localhost:59547/callback?code=abc&state=S1";
  assert.equal(oauthCallback(AUTH, ` ${ok} `), ok);
  for (const wrong of [
    "http://localhost:1234/callback?code=abc&state=S1", // another port
    "http://evil.example:59547/callback?code=abc&state=S1", // not this computer
    "http://localhost:59547/other?code=abc&state=S1", // another path
    "http://localhost:59547/callback?state=S1", // no code
    "not a url",
  ])
    assert.throws(() => oauthCallback(AUTH, wrong), /address bar/, wrong);
  assert.throws(() => oauthCallback(AUTH, "http://localhost:59547/callback?code=abc&state=S2"), /another sign-in/);
  // A link that doesn't call back to this computer is never followed.
  assert.throws(() => oauthCallback(AUTH.replace("localhost", "evil.example"), ok.replace("localhost", "evil.example")));
});

test("names and addresses are checked", () => {
  assert.equal(validName("github"), "github");
  assert.throws(() => validName("../x"));
  assert.throws(() => validName("a b"));
  assert.equal(validUrl("https://mcp.linear.app/mcp"), "https://mcp.linear.app/mcp");
  assert.throws(() => validUrl("http://mcp.linear.app/mcp"));
  assert.throws(() => validUrl("https://user:pw@x.example/"));
});

test("Claude Code: its account's connectors and its own servers, nothing secret", async () => {
  const dir = await home();
  await fs.writeFile(
    path.join(dir, ".claude.json"),
    JSON.stringify({ mcpServers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer SECRET" } } } }),
  );
  const { ran, run } = fakeRun({ "'mcp' 'list'": CLAUDE_LIST });
  const c = createConnectors({ home: dir, run, locate: located });
  try {
    const v = await c.list("claude");
    assert.equal(v.installed, true);
    assert.deepEqual(v.native, [{ id: "claude.ai Gmail", name: "Gmail", state: "connected", detail: "gmailmcp.googleapis.com/mcp/v1" }]);
    assert.deepEqual(v.servers, [{ name: "github", url: "api.githubcopilot.com/mcp/", remote: true, state: "connected" }]);
    assert.equal(JSON.stringify(v).includes("SECRET"), false);
    // The list is shared for a while: Claude Code checks every server's health.
    await c.list("claude");
    assert.equal(ran.filter((l) => l.includes("'list'")).length, 1);

    await c.add("claude", { name: "github", url: "https://api.githubcopilot.com/mcp/", token: "ghp_abcdefgh123" });
    assert.ok(ran.includes("exec '/usr/local/bin/claude' 'mcp' 'remove' '-s' 'user' 'github'"));
    assert.ok(
      ran.includes(
        "exec '/usr/local/bin/claude' 'mcp' 'add' '-s' 'user' '-t' 'http' '-H' 'Authorization: Bearer ghp_abcdefgh123' 'github' 'https://api.githubcopilot.com/mcp/'",
      ),
    );
    await c.remove("gemini", "github");
    assert.equal(ran.at(-1), "exec '/usr/local/bin/gemini' 'mcp' 'remove' '-s' 'user' 'github'");
    await assert.rejects(c.add("claude", { name: "x", url: "https://x.example/", token: "short" }), /whole token/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Gemini CLI: servers from its settings, added at user scope", async () => {
  const dir = await home();
  await fs.mkdir(path.join(dir, ".gemini"));
  await fs.writeFile(
    path.join(dir, ".gemini", "settings.json"),
    JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" }, local: { command: "node", args: ["s.js"], env: { KEY: "SECRET" } } } }),
  );
  const { ran, run } = fakeRun();
  const c = createConnectors({ home: dir, run, locate: located });
  try {
    const v = await c.list("gemini");
    assert.deepEqual(v.servers, [
      { name: "linear", url: "mcp.linear.app/mcp", remote: true, state: "added" },
      { name: "local", url: null, remote: false, state: "added" },
    ]);
    assert.equal(JSON.stringify(v).includes("SECRET"), false);
    await c.add("gemini", { name: "linear", url: "https://mcp.linear.app/mcp" });
    assert.equal(ran.at(-1), "exec '/usr/local/bin/gemini' 'mcp' 'add' '-s' 'user' '-t' 'http' 'linear' 'https://mcp.linear.app/mcp'");
    await assert.rejects(c.login("gemini", "linear"), /\/mcp auth linear/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Codex: ChatGPT's apps and its servers, through its daemon", async () => {
  const daemon = fakeDaemon({
    "app/list": ({ cursor }) =>
      cursor
        ? { data: [{ id: "connector_li", name: "Linear", isAccessible: false, installUrl: "https://chatgpt.com/apps/linear/connector_li" }], nextCursor: null }
        : {
            data: [
              { id: "connector_gh", name: "GitHub", isAccessible: true, isEnabled: true, installUrl: "https://chatgpt.com/apps/github/connector_gh" },
              { id: "asdk_x", name: "Planner", isAccessible: false, installUrl: "https://chatgpt.com/apps/planner/asdk_x" },
            ],
            nextCursor: "2",
          },
    "config/read": {
      config: {
        mcp_servers: {
          sentry: { url: "https://mcp.sentry.dev/mcp" },
          node_repl: { command: "/x/node_repl", env: { TOKEN: "SECRET" } },
          review: { command: "/bin/sh" },
        },
      },
    },
    "mcpServerStatus/list": {
      data: [
        { name: "sentry", authStatus: "notLoggedIn" },
        { name: "node_repl", authStatus: "unsupported" },
        { name: "review", authStatus: "unsupported", pluginId: "code-review@openai-bundled" },
      ],
    },
  });
  const c = createConnectors({ daemon, run: fakeRun().run, locate: located });
  const v = await c.list("codex");
  // Linked apps and the catalog's own; never a plugin's server or a secret.
  assert.deepEqual(
    v.native.map((a) => [a.name, a.state]),
    [
      ["GitHub", "connected"],
      ["Linear", "available"],
    ],
  );
  assert.equal(v.native[1].connectUrl, "https://chatgpt.com/apps/linear/connector_li");
  assert.deepEqual(v.servers, [
    { name: "sentry", url: "mcp.sentry.dev/mcp", remote: true, state: "needs-auth" },
    { name: "node_repl", url: null, remote: false, state: "added" },
  ]);
  assert.equal(JSON.stringify(v).includes("SECRET"), false);
  assert.deepEqual((await c.list("codex", { q: "plan" })).native.map((a) => a.name), ["Planner"]);

  daemon.calls.length = 0;
  await c.add("codex", { name: "github", url: "https://api.githubcopilot.com/mcp/", token: "ghp_abcdefgh123" });
  assert.deepEqual(daemon.calls[0], [
    "config/batchWrite",
    {
      edits: [
        {
          keyPath: "mcp_servers.github",
          value: { url: "https://api.githubcopilot.com/mcp/", http_headers: { Authorization: "Bearer ghp_abcdefgh123" } },
          mergeStrategy: "replace",
        },
      ],
      reloadUserConfig: true,
    },
  ]);
  assert.equal(daemon.calls[1][0], "config/mcpServer/reload");
  await c.remove("codex", "github");
  assert.deepEqual(daemon.calls[2][1].edits, [{ keyPath: "mcp_servers.github", value: null, mergeStrategy: "replace" }]);
  await c.setApp("connector_gh", false);
  assert.deepEqual(daemon.calls.at(-1)[1].edits, [{ keyPath: "apps.connector_gh.enabled", value: false, mergeStrategy: "upsert" }]);
  await assert.rejects(c.setApp("../x", true), /Unknown app/);
});

test("Codex signs in to a server: link out, the localhost address back, finished on the computer", async () => {
  const auth = "https://mcp.sentry.dev/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A40111%2Fcallback&state=Z9";
  const daemon = fakeDaemon({ "mcpServer/oauth/login": { authorizationUrl: auth } });
  const visited = [];
  const c = createConnectors({
    daemon,
    run: fakeRun().run,
    locate: located,
    visit: async (url) => {
      visited.push(url);
      daemon.notify({ method: "mcpServer/oauthLogin/completed", params: { name: "sentry", success: true } });
    },
  });
  assert.deepEqual(await c.login("codex", "sentry"), { agent: "codex", name: "sentry", state: "link", url: auth, error: null });
  await assert.rejects(c.callback("codex", "sentry", "http://127.0.0.1:40111/callback?code=c&state=nope"), /another sign-in/);
  assert.equal(visited.length, 0);
  const done = await c.callback("codex", "sentry", "http://127.0.0.1:40111/callback?code=c&state=Z9");
  assert.equal(done.state, "done");
  assert.deepEqual(visited, ["http://127.0.0.1:40111/callback?code=c&state=Z9"]);
});

test("Claude Code signs in to a server through its own login", async () => {
  const term = fakeTerminal();
  const c = createConnectors({ run: fakeRun().run, spawn: term.spawn, locate: located, linkMs: 1000 });
  const started = c.login("claude", "linear");
  await settle();
  term.print(LOGIN_OUTPUT);
  assert.equal((await started).url, AUTH);
  assert.equal(term.spawned[0], "exec '/usr/local/bin/claude' 'mcp' 'login' '--no-browser' 'linear'");
  assert.equal((await c.callback("claude", "linear", "http://localhost:59547/callback?code=k&state=S1")).state, "checking");
  assert.deepEqual(term.proc.written, ["http://localhost:59547/callback?code=k&state=S1\r"]);
  term.exit(0);
  assert.equal(c.loginView("claude", "linear").state, "done");
  // Cancelling one that runs ends its login.
  const again = c.login("claude", "notion");
  await settle();
  term.print(LOGIN_OUTPUT);
  await again;
  assert.equal(c.cancel("claude", "notion").state, "cancelled");
  assert.equal(term.proc.killed, true);
});

test("connector routes are the owner's only; one connector goes to several agents and its token nowhere else", async () => {
  const root = await home();
  const seen = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      health: async () => [],
      connectors: {
        list: async (agent) => ({ agent, installed: true, native: [], servers: [] }),
        add: async (agent, body) => {
          seen.push(["add", agent, body]);
          if (agent === "gemini") throw Object.assign(new Error("Gemini CLI isn't installed on this computer."), { status: 404 });
          return { agent, name: body.name };
        },
        githubToken: async () => "gho_fromthecli123",
        remove: async (agent, name) => (seen.push(["remove", agent, name]), { agent, name }),
      },
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files", "codex"], "agent");
  const call = (route, token, method = "GET", body) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await call("/api/sessions/connectors?agent=claude", agent.token)).status, 403);
    const github = { name: "github", url: "https://api.githubcopilot.com/mcp/" };
    assert.equal((await call("/api/sessions/connectors", agent.token, "POST", { agents: ["claude"], ...github, token: "ghp_x12345678" })).status, 403);
    assert.equal((await (await call("/api/sessions/connectors?agent=claude", owner.token)).json()).installed, true);
    const res = await call("/api/sessions/connectors", owner.token, "POST", { agents: ["claude", "gemini"], ...github, token: "ghp_x12345678" });
    const body = await res.json();
    assert.deepEqual(body, {
      name: "github",
      results: [
        { agent: "claude", ok: true },
        { agent: "gemini", ok: false, error: "Gemini CLI isn't installed on this computer." },
      ],
    });
    assert.deepEqual(seen[0], ["add", "claude", { ...github, token: "ghp_x12345678" }]);
    // The GitHub CLI's token is read on the computer, never sent by the phone.
    await call("/api/sessions/connectors", owner.token, "POST", { agents: ["claude"], ...github, tokenFrom: "gh" });
    assert.equal(seen.at(-1)[2].token, "gho_fromthecli123");
    // Every agent failing is an error.
    assert.equal((await call("/api/sessions/connectors", owner.token, "POST", { agents: ["gemini"], ...github })).status, 404);
    assert.equal((await call("/api/sessions/connectors?agent=codex&name=github", owner.token, "DELETE")).status, 200);
    assert.deepEqual(seen.at(-1), ["remove", "codex", "github"]);
    const activity = JSON.stringify(await (await call("/api/activity", owner.token)).json());
    assert.match(activity, /Added connector github to Claude Code/);
    assert.equal(/ghp_x12345678|gho_fromthecli123/.test(activity), false);
  } finally {
    reach.server.close();
    await reach.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});
