import test from "node:test";
import assert from "node:assert/strict";
import { routes, agentRows, applyRule, isSubagent } from "../server/openclaw-agents.mjs";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

const base = "/api/sessions/openclaw";
const roster = {
  defaultId: "main",
  agents: [
    { id: "main", identity: { name: "Personal", emoji: "🦞" } },
    { id: "work", name: "Work" },
  ],
};
const now = Date.now();
const overview = {
  connected: true,
  sessions: [
    { key: "agent:main:main", title: "Direct", status: "running", updatedAt: now, model: "anthropic/claude-x" },
    { key: "agent:main:reach-1a2b", title: "Login page", status: "idle", updatedAt: now - 5 },
    { key: "agent:main:subagent:aaa", title: "Research", status: "idle", updatedAt: now - 1000 },
    { key: "agent:work:subagent:bbb", title: "Old helper", status: "idle", updatedAt: now - 3600_000 },
    // Spawned by a work chat, run as main: it sits under work.
    { key: "agent:main:subagent:ccc", title: "Spawned", status: "running", updatedAt: now - 99 },
    { key: "agent:work:discord:channel:1", title: "Launch", status: "waiting", updatedAt: now - 10, model: "gpt-x" },
  ],
  approvals: [{ id: "a1", sessionKey: "agent:work:discord:channel:1" }, { id: "a2" }],
};
const listing = {
  defaults: { model: "default-model" },
  sessions: [
    { key: "agent:main:main", model: "claude-main" },
    { key: "agent:main:subagent:ccc", spawnedBy: "agent:work:discord:channel:1" },
  ],
};
const snapshot = () => ({
  path: "/Users/x/.openclaw/exec-approvals.json",
  exists: true,
  hash: "abc123",
  file: {
    version: 1,
    socket: { path: "/Users/x/.openclaw/exec-approvals.sock" },
    defaults: { security: "allowlist", ask: "on-miss" },
    agents: {
      "*": { allowlist: [{ id: "w", pattern: "/usr/bin/jq" }] },
      main: {
        security: "full",
        allowlist: [{ id: "1", pattern: "~/bin/rg", lastUsedAt: 5, lastUsedCommand: "rg --token SECRET" }],
      },
    },
  },
});

function fixture({ methods = null, rpc = {} } = {}) {
  const calls = [],
    gets = {},
    posts = {};
  let file = snapshot();
  const client = {
    can: (m) => !methods || methods.includes(m),
    overview: async () => overview,
    call: async (method, params, authorize) => {
      calls.push({ method, params, authorized: typeof authorize === "function" });
      if (authorize) authorize();
      if (rpc[method]) return rpc[method](params);
      if (method === "agents.list") return roster;
      if (method === "sessions.list") return listing;
      if (method === "exec.approvals.get") return file;
      if (method === "exec.approvals.set") {
        if (params.baseHash !== file.hash)
          throw Object.assign(new Error("exec approvals changed since last load; re-run exec.approvals.get and retry"), { status: 409 });
        file = { ...file, hash: "next", file: { ...params.file, socket: file.file.socket } };
        return file;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  let auths = 0;
  const app = { get: (r, fn) => (gets[r] = fn), post: (r, fn) => (posts[r] = fn) };
  routes(app, client, { base, authorize: (req) => () => req.reauthorize() });
  const req = (body) => ({ body, reauthorize: () => auths++ });
  const run = async (fn, body) => {
    let out;
    await fn(req(body), { json: (v) => (out = v) });
    return out;
  };
  return {
    calls,
    get: (r) => run(gets[`${base}/${r}`]),
    post: (r, body) => run(posts[`${base}/${r}`], body),
    auths: () => auths,
  };
}

test("sub-agent keys follow OpenClaw's shapes", () => {
  assert.ok(isSubagent("agent:main:subagent:1"));
  assert.ok(isSubagent("agent:main:subagent:1:subagent:2"));
  assert.ok(isSubagent("agent:main:acp:1"));
  assert.ok(!isSubagent("agent:main:main"));
  assert.ok(!isSubagent("agent:main:discord:channel:subagent"));
});

test("agents list counts running chats, live sub-agents and approvals per agent", async () => {
  const f = fixture();
  const out = await f.get("agents");
  assert.equal(out.supported, true);
  assert.equal(out.canStopSubagents, false);
  const [main, work] = out.agents;
  assert.deepEqual([main.name, main.emoji, main.model], ["Personal", "🦞", "claude-main"]);
  assert.equal(main.running, 1);
  // The hour-old sub-agent is gone; the one a work chat spawned sits under work.
  assert.deepEqual(main.subagents.map((s) => [s.title, s.status]), [["Research", "recent"]]);
  assert.deepEqual(work.subagents.map((s) => [s.title, s.status]), [["Spawned", "running"]]);
  assert.equal(work.running, 1, "waiting counts as running");
  assert.equal(work.waiting, 1);
  assert.equal(main.waiting, 1, "an approval without a chat goes to the default agent");
  assert.deepEqual(main.recent.map((c) => c.title), ["Direct", "Login page"]);
  assert.equal(work.model, "gpt-x");
  assert.deepEqual(Object.keys(main.recent[0]).sort(), ["key", "title"]);
  // Reads need no authorization.
  assert.ok(f.calls.every((c) => !c.authorized));
});

test("a Gateway without agents.list hides the tab; a model falls back to the default", async () => {
  assert.deepEqual(await fixture({ methods: [] }).get("agents"), { supported: false });
  const rows = agentRows({ roster: { agents: [{ id: "solo" }] }, listing, overview: { sessions: [] } });
  assert.equal(rows.agents[0].model, "default-model");
  assert.equal(rows.agents[0].name, "solo");
});

test("rules show modes and patterns, never the socket, path or last command", async () => {
  const out = await fixture().get("agents/rules");
  assert.deepEqual(out.all, { security: "allowlist", ask: "on-miss", allowlist: [{ pattern: "/usr/bin/jq" }] });
  assert.deepEqual(out.agents.main, { security: "full", ask: null, allowlist: [{ pattern: "~/bin/rg", lastUsedAt: 5 }] });
  assert.equal(out.hash, "abc123");
  assert.equal(out.canEdit, true);
  const raw = JSON.stringify(out);
  for (const secret of ["SECRET", "sock", "exec-approvals.json", "lastUsedCommand"]) assert.ok(!raw.includes(secret), secret);
  assert.deepEqual(await fixture({ methods: [] }).get("agents/rules"), { supported: false });
});

test("adding a pattern writes the whole file with OpenClaw's baseHash, under live authorization", async () => {
  const f = fixture();
  const out = await f.post("agents/rules", { hash: "abc123", scope: "main", add: " /opt/homebrew/bin/rg " });
  const set = f.calls.find((c) => c.method === "exec.approvals.set");
  assert.equal(set.authorized, true);
  assert.equal(set.params.baseHash, "abc123");
  assert.equal(set.params.file.socket, undefined, "the socket token stays OpenClaw's");
  assert.deepEqual(set.params.file.agents.main.allowlist.map((e) => e.pattern), ["~/bin/rg", "/opt/homebrew/bin/rg"]);
  assert.deepEqual(set.params.file.agents["*"].allowlist, [{ id: "w", pattern: "/usr/bin/jq" }]);
  assert.equal(out.hash, "next");
  assert.ok(f.auths() >= 3);
});

test("a stale hash, a bad change or a Gateway refusal is refused in Reach's words", async () => {
  const f = fixture();
  await assert.rejects(f.post("agents/rules", { hash: "old", scope: "main", ask: "always" }), { status: 409, message: /changed on your computer/ });
  assert.ok(!f.calls.some((c) => c.method === "exec.approvals.set"));
  for (const body of [
    { hash: "abc123", scope: "main", add: "rg" },
    { hash: "abc123", scope: "main", add: "/bin/a\nb" },
    { hash: "abc123", scope: "../x", add: "/bin/a" },
    { hash: "abc123", scope: "main", security: "yolo" },
    { hash: "abc123", scope: "*", security: null },
    { hash: "abc123", scope: "main", ask: "off", add: "/bin/a" },
    { scope: "main", ask: "off" },
  ])
    await assert.rejects(f.post("agents/rules", body), { status: 400 }, JSON.stringify(body));
  await assert.rejects(f.post("agents/rules", { hash: "abc123", scope: "main", add: "~/BIN/RG" }), { status: 409 });
  const raw = fixture({
    rpc: { "exec.approvals.set": () => { throw Object.assign(new Error("invalid params: /agents/main: secret detail"), { status: 409 }); } },
  });
  await assert.rejects(raw.post("agents/rules", { hash: "abc123", scope: "main", ask: "off" }), { status: 409, message: "OpenClaw didn't save the rule." });
  const denied = fixture();
  await assert.rejects(
    routesPost(denied, { hash: "abc123", scope: "main", ask: "off" }),
    /revoked/,
  );
});
// The same route with authorization that fails: nothing reaches OpenClaw.
async function routesPost(f, body) {
  const posts = {};
  const calls = [];
  routes(
    { get() {}, post: (r, fn) => (posts[r] = fn) },
    { can: () => true, call: async (m) => (calls.push(m), snapshot()) },
    { base, authorize: (req) => () => req.reauthorize() },
  );
  try {
    await posts[`${base}/agents/rules`]({ body, reauthorize: () => { throw new Error("revoked"); } }, { json() {} });
  } finally {
    assert.deepEqual(calls, []);
  }
}

test("modes: agents can go back to the defaults; removing the last pattern drops the list", () => {
  const file = snapshot().file;
  assert.equal(applyRule(file, { scope: "main", security: null }).agents.main.security, undefined);
  assert.equal(applyRule(file, { scope: "*", security: "deny" }).defaults.security, "deny");
  assert.equal(applyRule(file, { scope: "work", ask: "always" }).agents.work.ask, "always");
  const removed = applyRule(file, { scope: "main", remove: "~/bin/rg" });
  assert.equal(removed.agents.main.allowlist, undefined);
  assert.equal(file.agents.main.allowlist.length, 1, "the original is untouched");
  assert.throws(() => applyRule(file, { scope: "main", remove: "/nope" }), { status: 409 });
  assert.equal(applyRule(file, {scope: "*", add: "/bin/ls"}).socket, undefined);
});

test("Agents tab: rows, pills, expand, and two-tap remove of a rule", async () => {
  const sent = [];
  let rules = { supported: true, hash: "h1", canEdit: true, all: { security: "allowlist", ask: "on-miss", allowlist: [{ pattern: "/usr/bin/jq" }] }, agents: {} };
  const dom = await startDom({
    routes: {
      [`${base}/agents`]: () => ({
        supported: true,
        canStopSubagents: false,
        agents: [
          { id: "main", name: "Personal", emoji: "🦞", isDefault: true, model: "claude-x", running: 2, waiting: 1, subagents: [{ key: "s", title: "Research", status: "running" }], recent: [{ key: "c", title: "Login page" }] },
          { id: "work", name: "Work", emoji: "", isDefault: false, model: "gpt", running: 0, waiting: 0, subagents: [], recent: [] },
        ],
      }),
      [`${base}/agents/rules`]: (init) => {
        if (init.method === "POST") {
          const body = JSON.parse(init.body);
          sent.push(body);
          rules = { ...rules, hash: "h2", all: { ...rules.all, allowlist: body.add ? [...rules.all.allowlist, { pattern: body.add }] : [] } };
        }
        return rules;
      },
    },
  });
  try {
    const { ClawAgentsPanel } = await dom.load("/src/OpenClawAgents.tsx");
    const peer = { id: "p", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
    const first = await dom.render(dom.React.createElement(ClawAgentsPanel, { peer, query: "", refresh: 0 }));
    const doc = dom.document;
    await dom.waitFor(() => doc.querySelector(".claw-agents-row") && doc.querySelector('[aria-label="Allowlist"]'));
    const row = doc.querySelector(".claw-agents-row");
    assert.match(row.textContent, /Personal.*claude-x.*2 running.*1 sub.*1 waiting/);
    assert.equal(doc.querySelectorAll(".claw-agents-row")[1].querySelectorAll(".claw-agents-pill").length, 0);
    row.click();
    await settle();
    assert.match(doc.querySelector(".claw-agents-body").textContent, /Research.*Running.*Login page/);
    assert.ok(!doc.querySelector(".claw-agents-body button"), "sub-agents are read-only");
    const remove = doc.querySelector('[aria-label="Remove /usr/bin/jq"]');
    remove.click();
    await settle();
    assert.equal(sent.length, 0, "one tap only asks");
    doc.querySelector('[aria-label="Confirm remove /usr/bin/jq"]').click();
    await dom.waitFor(() => sent.length === 1);
    assert.deepEqual(sent[0], { hash: "h1", scope: "*", remove: "/usr/bin/jq" });
    await typeInto(doc.querySelector('[aria-label="Program path"]'), "/bin/ls");
    doc.querySelector(".claw-agents-add").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => sent.length === 2);
    assert.deepEqual(sent[1], { hash: "h2", scope: "*", add: "/bin/ls" });
    // Full asks twice.
    const full = () => [...doc.querySelectorAll('[aria-label="Security"] button')].find((b) => /Full|Allow all/.test(b.textContent));
    await dom.waitFor(() => !full().disabled);
    full().click();
    await settle();
    assert.equal(full().textContent, "Allow all?");
    assert.equal(sent.length, 2);
    assert.deepEqual(dom.errors, []);
    // The query filters the rows.
    await first.unmount();
    const second = await dom.render(dom.React.createElement(ClawAgentsPanel, { peer, query: "work", refresh: 0 }));
    await dom.waitFor(() => second.container.querySelector(".claw-agents-title"));
    assert.deepEqual([...second.container.querySelectorAll(".claw-agents-title")].map((n) => n.textContent), ["Work"]);
  } finally {
    await dom.close();
  }
});

test("an agent named with a key never shows the key", () => {
  const { agents: rows } = agentRows({
    roster: { defaultId: "main", agents: [{ id: "main" }, { id: "sk-proj-abcdefghijkl", name: "sk-proj-AbCdEfGhIjKl0123456789" }, { id: "ops", identity: { name: "Bearer sk-live-0123456789abcdef" } }] },
  });
  assert.deepEqual(rows.map((r) => r.name), ["main", "Agent named with a key [hidden]", "Agent named with a key [hidden]"]);
  assert.doesNotMatch(JSON.stringify(rows.map((r) => r.name)), /AbCdEf|0123456789/);
});
