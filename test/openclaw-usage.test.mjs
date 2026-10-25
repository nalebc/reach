import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  routes,
  dayKey,
  spendFrom,
  routingFrom,
  cacheFit,
  cheapest,
  cheapPlan,
  versionOf,
  readRouted,
} from "../server/openclaw-usage.mjs";
import { assertPrivate } from "./helpers/private-file.mjs";

const base = "/api/sessions/openclaw";
const unlisted = (method) =>
  Object.assign(Error(`This OpenClaw Gateway does not support ${method}. Update OpenClaw on this computer.`), { status: 409 });

// OpenClaw 2026.3.13's config, secrets included: none may reach a phone.
const config = () => ({
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.2"] },
      heartbeat: { every: "30m", to: "+15555550123" },
      models: { "anthropic/claude-opus-4-6": { params: { cacheRetention: "short" } } },
    },
    list: [
      { id: "main", default: true, heartbeat: {} },
      { id: "ops", heartbeat: { every: "1h", model: "anthropic/claude-sonnet-4-6" }, tools: { apiKey: "sk-secret" } },
    ],
  },
  models: { providers: { anthropic: { apiKey: "sk-ant-secret" } } },
});

function fake({ methods, handlers = {} } = {}) {
  const calls = [];
  const listed = new Set(
    methods || ["usage.cost", "usage.status", "config.get", "config.patch", "models.list", "cron.list", "cron.update"],
  );
  const client = {
    can: (m) => listed.has(m),
    async call(method, params = {}, authorize = () => {}) {
      authorize();
      calls.push({ method, params });
      if (!listed.has(method)) throw unlisted(method);
      const h = handlers[method];
      if (!h) throw Error(`no handler for ${method}`);
      return h(params);
    },
  };
  return { client, calls };
}
function app(client, ctx = {}) {
  const got = new Map();
  const add = (verb) => (route, fn) => got.set(`${verb} ${route}`, fn);
  routes({ get: add("GET"), post: add("POST") }, client, {
    base,
    authorize: (req) => () => req.reauthorize(),
    ...ctx,
  });
  return async (verb, route, { body, query = {}, revoked = () => false } = {}) => {
    let out;
    await got.get(`${verb} ${base}${route}`)(
      {
        body,
        query,
        reauthorize() {
          if (revoked()) throw Object.assign(Error("Revoked"), { status: 401 });
        },
      },
      { json: (v) => (out = v) },
    );
    return out;
  };
}

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-spend-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("spend sums today, this month and 30 days from OpenClaw's own day keys", () => {
  const now = new Date(2026, 9, 8, 12).getTime();
  const s = spendFrom(
    [
      { date: "2026-09-08", totalCost: 100 },
      { date: "2026-09-20", totalCost: 2 },
      { date: "2026-10-01", totalCost: 1.5 },
      { date: dayKey(now), totalCost: 3.1, missingCostEntries: 1 },
    ],
    now,
  );
  assert.deepEqual(s, { today: 3.1, month: 4.6, days30: 6.6, partial: true });
});

test("a Gateway without usage methods hides every part", async () => {
  const { client } = fake({ methods: [] });
  const call = app(client, { dataDir: dir });
  assert.equal((await call("GET", "/spend")).supported, false);
  assert.equal((await call("GET", "/spend/routing")).supported, false);
});

test("2026.3.13: sessions.usage is unlisted, so spend is the default agent's and chat cost hides", async () => {
  const now = Date.now();
  const { client } = fake({
    handlers: {
      "usage.cost": () => ({ daily: [{ date: dayKey(now), totalCost: 0.42 }], totals: { totalCost: 0.42 } }),
      "usage.status": () => ({
        providers: [
          { provider: "anthropic", displayName: "Claude", windows: [{ label: "5h", usedPercent: 81.6 }] },
          { provider: "zai", windows: [], error: "token sk-leak expired" },
        ],
      }),
    },
  });
  const call = app(client, { dataDir: dir });
  const spend = await call("GET", "/spend");
  assert.equal(spend.supported, true);
  assert.equal(spend.scope, "default");
  assert.equal(spend.today, 0.42);
  assert.equal(spend.agents, null);
  assert.deepEqual(spend.limits, [{ name: "Claude", windows: [{ label: "5h", usedPercent: 82 }] }]);
  assert.equal(JSON.stringify(spend).includes("sk-leak"), false);
  const chat = await call("GET", "/spend/chat", { query: { key: "agent:main:reach-1" } });
  assert.deepEqual(chat, { supported: false });
});

test("with sessions.usage, spend covers every agent and a chat shows its cost", async () => {
  const now = Date.now();
  const { client } = fake({
    methods: ["usage.cost", "sessions.usage"],
    handlers: {
      "usage.cost": () => ({ daily: [{ date: dayKey(now), totalCost: 1 }] }),
      "sessions.usage": (p) =>
        p.key
          ? { sessions: [{ key: p.key, usage: { totalCost: p.key.endsWith("free") ? 0 : 0.4234, missingCostEntries: p.key.endsWith("free") ? 3 : 0 } }] }
          : {
              aggregates: {
                daily: [{ date: dayKey(now), cost: 3.1 }],
                byAgent: [{ agentId: "main", totals: { totalCost: 2 } }, { agentId: "ops", totals: { totalCost: 1.1 } }],
              },
            },
    },
  });
  const call = app(client, { dataDir: dir });
  const spend = await call("GET", "/spend");
  assert.equal(spend.scope, "all");
  assert.equal(spend.today, 3.1);
  assert.deepEqual(spend.agents, [{ id: "main", cost: 2 }, { id: "ops", cost: 1.1 }]);
  assert.equal((await call("GET", "/spend/chat", { query: { key: "agent:main:reach-1" } })).cost, 0.4234);
  // Only unpriced turns (a local model): unknown, the pill hides.
  assert.equal((await call("GET", "/spend/chat", { query: { key: "agent:main:free" } })).cost, null);
  await assert.rejects(call("GET", "/spend/chat", { query: { key: "a b" } }), { status: 400 });
});

test("spend is partial while OpenClaw is still counting sessions (2026.9 cacheStatus)", async () => {
  const now = Date.now();
  for (const [status, partial] of [["refreshing", true], ["partial", true], ["stale", true], ["fresh", false], [undefined, false]]) {
    const { client } = fake({
      methods: ["usage.cost", "sessions.usage"],
      handlers: {
        "usage.cost": () => ({ daily: [{ date: dayKey(now), totalCost: 1 }] }),
        "sessions.usage": () => ({
          aggregates: { daily: [{ date: dayKey(now), cost: 0.5 }], byAgent: [] },
          ...(status ? { cacheStatus: { status, cachedFiles: 1, pendingFiles: 4, staleFiles: 0 } } : {}),
        }),
      },
    });
    const call = app(client, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "reach-spend-")) });
    assert.equal((await call("GET", "/spend")).partial, partial, String(status));
  }
});

test("the budget is validated, authorized and kept 0600", async () => {
  const { client } = fake();
  const call = app(client, { dataDir: dir });
  await assert.rejects(call("POST", "/spend/budget", { body: { monthlyUsd: "50" } }), { status: 400 });
  await assert.rejects(call("POST", "/spend/budget", { body: { monthlyUsd: -1 } }), { status: 400 });
  await assert.rejects(
    call("POST", "/spend/budget", { body: { monthlyUsd: 50 }, revoked: () => true }),
    { status: 401 },
  );
  assert.equal(fs.existsSync(path.join(dir, "openclaw-budget.json")), false);
  assert.equal((await call("POST", "/spend/budget", { body: { monthlyUsd: 50 } })).budget, 50);
  const file = path.join(dir, "openclaw-budget.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { monthlyUsd: 50 });
  await assertPrivate(file);
});

const models = {
  models: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
    { id: "gpt-5.2-mini", name: "GPT-5.2 mini", provider: "openai" },
  ],
};
const jobs = {
  jobs: [
    { id: "j1", name: "Inbox", enabled: true, sessionTarget: "isolated", payload: { kind: "agentTurn", message: "x" } },
    { id: "j2", name: "Main", enabled: true, sessionTarget: "main", payload: { kind: "agentTurn", message: "x" } },
    { id: "j3", name: "Ping", enabled: true, sessionTarget: "isolated", payload: { kind: "systemEvent", text: "x" } },
  ],
};

test("routing shows only whitelisted fields, warns of the cache and offers OpenRouter", async () => {
  const { client } = fake({
    handlers: {
      "config.get": () => ({ hash: "h1", raw: "{secret}", valid: true, config: config() }),
      "models.list": () => models,
      "cron.list": () => jobs,
    },
  });
  const r = await app(client)("GET", "/spend/routing");
  const text = JSON.stringify(r);
  for (const leak of ["sk-secret", "sk-ant-secret", "+1555", "h1", "{secret}", "fallbacks"]) assert.equal(text.includes(leak), false, leak);
  assert.equal(r.model, "anthropic/claude-opus-4-6");
  assert.deepEqual(r.heartbeat, { model: "", every: "30m" });
  assert.deepEqual(r.agents[0], { id: "main", model: "", heartbeat: { model: "", every: "" } });
  assert.deepEqual(r.agents[1], { id: "ops", model: "", heartbeat: { model: "anthropic/claude-sonnet-4-6", every: "1h" } });
  assert.deepEqual(r.cache, { every: "30m", ttlMinutes: 5, canKeepLonger: true });
  assert.equal(r.cheapest, "anthropic/claude-haiku-4-5");
  assert.deepEqual(r.jobs, [{ id: "j1", name: "Inbox", model: "" }]);
  assert.equal(r.openRouter, false);
});

test("cache warning only when heartbeats run on a cached main model past its TTL", () => {
  const r = routingFrom(config());
  assert.ok(cacheFit(r));
  assert.equal(cacheFit({ ...r, heartbeat: { model: "openai/gpt-5.2-mini", every: "30m" } }), null);
  assert.equal(cacheFit({ ...r, retention: "long" }), null);
  assert.equal(cacheFit({ ...r, heartbeat: { model: "", every: "2h" }, retention: "long" }).canKeepLonger, false);
  assert.equal(cacheFit({ ...r, model: "openai/gpt-5.2" }), null);
  // Only agents with a heartbeat of their own run one: ops, on Sonnet.
  assert.equal(cacheFit({ ...r, agents: r.agents.slice(1) }), null);
  assert.equal(cacheFit({ ...r, model: "amazon-bedrock/anthropic.claude-x", retention: "" }), null);
  assert.equal(cheapest([{ id: "a/big", name: "Big" }]), "");
});

test("saving a model checks the version, the listed models and authorization, then patches once", async () => {
  let current = config();
  const { client, calls } = fake({
    handlers: {
      "config.get": () => ({ hash: "h1", valid: true, config: current }),
      "models.list": () => models,
      "config.patch": () => ({ ok: true }),
    },
  });
  const call = app(client);
  const version = versionOf(routingFrom(current));
  await assert.rejects(call("POST", "/spend/routing", { body: { target: "default", model: "x/y", version } }), { status: 400 });
  await assert.rejects(
    call("POST", "/spend/routing", { body: { target: "default", model: "anthropic/claude-sonnet-4-6", version: "old" } }),
    { status: 409 },
  );
  await assert.rejects(
    call("POST", "/spend/routing", { body: { target: "default", model: "anthropic/claude-sonnet-4-6", version }, revoked: () => true }),
    { status: 401 },
  );
  assert.equal(calls.some((c) => c.method === "config.patch"), false);
  const out = await call("POST", "/spend/routing", { body: { target: "default", model: "anthropic/claude-sonnet-4-6", version } });
  assert.equal(out.saved, true);
  const patch = calls.filter((c) => c.method === "config.patch");
  assert.equal(patch.length, 1);
  assert.equal(patch[0].params.baseHash, "h1");
  // Keeps the {primary} shape (fallbacks stay OpenClaw's).
  assert.deepEqual(JSON.parse(patch[0].params.raw), { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } });
  await call("POST", "/spend/routing", { body: { target: "heartbeat", model: "", version } });
  assert.deepEqual(JSON.parse(calls.at(-1).params.raw), { agents: { defaults: { heartbeat: { model: null } } } });
  current = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
  await call("POST", "/spend/routing", { body: { target: "default", model: "openai/gpt-5.2-mini", version: versionOf(routingFrom(current)) } });
  assert.deepEqual(JSON.parse(calls.at(-1).params.raw), { agents: { defaults: { model: "openai/gpt-5.2-mini" } } });
});

test("Cheap background work moves isolated schedules first, then heartbeats in one patch", async () => {
  const { client, calls } = fake({
    handlers: {
      "config.get": () => ({ hash: "h1", valid: true, config: config() }),
      "models.list": () => models,
      "cron.list": () => jobs,
      "cron.update": (p) => ({ id: p.id, payload: p.patch.payload }),
      "config.patch": () => ({ ok: true }),
    },
  });
  const version = versionOf(routingFrom(config()));
  const model = "anthropic/claude-haiku-4-5";
  assert.deepEqual(cheapPlan(routingFrom(config()), [{ id: "j1", model: "" }], model), { heartbeat: true, agents: ["ops"], jobs: ["j1"] });
  const out = await app(client)("POST", "/spend/routing/cheap", { body: { model, version } });
  assert.equal(out.saved, true);
  const writes = calls.filter((c) => ["cron.update", "config.patch"].includes(c.method));
  assert.deepEqual(writes.map((c) => c.method), ["cron.update", "config.patch"]);
  assert.deepEqual(writes[0].params, { id: "j1", patch: { payload: { kind: "agentTurn", model } } });
  assert.deepEqual(JSON.parse(writes[1].params.raw), {
    agents: { defaults: { heartbeat: { model } }, list: [{ id: "ops", heartbeat: { model } }] },
  });
});

// Cheap background work is a token optimization: each schedule run Reach
// moved goes in the savings ledger, by OpenClaw's own usage count, under its
// own kind. Nothing is counted on a guess.
test("runs Reach moved to the cheap model are recorded as savings, in tokens", async () => {
  const data = fs.mkdtempSync(path.join(dir, "routed-"));
  let listener;
  const recorded = [];
  const { client } = fake({
    handlers: {
      "config.get": () => ({ hash: "h1", valid: true, config: config() }),
      "models.list": () => models,
      "cron.list": () => ({ jobs: [
        { id: "j1", sessionTarget: "isolated", payload: { kind: "agentTurn" } },
        { id: "j2", sessionTarget: "isolated", payload: { kind: "agentTurn", model: "anthropic/claude-haiku-4-5" } },
      ] }),
      "cron.update": (p) => ({ id: p.id }),
      "config.patch": () => ({ ok: true }),
    },
  });
  client.onEvent = (fn) => ((listener = fn), () => {});
  const model = "anthropic/claude-haiku-4-5";
  const out = await app(client, { dataDir: data, savings: { record: (e) => recorded.push(e) } })("POST", "/spend/routing/cheap", { body: { model, version: versionOf(routingFrom(config())) } });
  assert.deepEqual(out.jobs, ["j1"]);
  assert.deepEqual(readRouted(data), { model, jobs: ["j1"] });
  await assertPrivate(path.join(data, "openclaw-routed.json"));
  const usage = { input_tokens: 1200, output_tokens: 300, total_tokens: 1700, cache_read_tokens: 150, cache_write_tokens: 50 };
  const finished = (over) => ({ jobId: "j1", action: "finished", status: "ok", runId: `r-${Math.random()}`, provider: "anthropic", model: "claude-haiku-4-5", usage, ...over });
  listener("cron", finished({ runId: "r1" }));
  listener("cron", finished({ runId: "r1" })); // the same run told twice
  listener("cron", finished({ jobId: "j2" })); // a job Reach didn't move
  listener("cron", finished({ model: "claude-opus-4-6" })); // ran on another model
  listener("cron", finished({ usage: undefined })); // no usage
  listener("cron", finished({ usage: { ...usage, input_tokens: "1200" } })); // unreadable
  listener("cron", finished({ status: "error" }));
  listener("cron", finished({ action: "started" }));
  assert.deepEqual(recorded, [{ agent: "openclaw", kind: "openclaw-cheap-route", tokens: 1400 }]);
  // A full ref as the model counts too; cache fields left out are none.
  listener("cron", finished({ runId: "r2", provider: undefined, model, usage: { input_tokens: 10, output_tokens: 1 } }));
  assert.deepEqual(recorded.at(-1), { agent: "openclaw", kind: "openclaw-cheap-route", tokens: 10 });
});

test("the cache fix keeps the main model's cache 1 h; a rate limit is said in Reach's words", async () => {
  const { client, calls } = fake({
    handlers: {
      "config.get": () => ({ hash: "h1", valid: true, config: config() }),
      "models.list": () => models,
      "config.patch": () => {
        throw Object.assign(Error("OpenClaw reports a credit balance or usage limit. Check OpenClaw on this computer."), { status: 409 });
      },
    },
  });
  const version = versionOf(routingFrom(config()));
  await assert.rejects(app(client)("POST", "/spend/routing/cache", { body: { version } }), {
    status: 429,
    message: /3 changes a minute/,
  });
  assert.deepEqual(JSON.parse(calls.at(-1).params.raw), {
    agents: { defaults: { models: { "anthropic/claude-opus-4-6": { params: { cacheRetention: "long" } } } } },
  });
});

test("the phone shows a chat's cost, today's spend, and confirms the cheap preset before applying", async () => {
  const { startDom, settle } = await import("./dom/harness.mjs");
  const posted = [];
  const routing = {
    supported: true,
    version: "v1",
    readOnly: false,
    ...routingFrom(config()),
    models: models.models.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, provider: m.provider })),
    cheapest: "anthropic/claude-haiku-4-5",
    jobs: [{ id: "j1", name: "Inbox", model: "" }],
    cache: { every: "30m", ttlMinutes: 5, canKeepLonger: true },
    openRouter: false,
  };
  const dom = await startDom({
    routes: {
      [`${base}/spend`]: () => ({
        supported: true, scope: "default", today: 3.1, month: 45, days30: 60, partial: false,
        agents: null, limits: [], budget: 50,
      }),
      [`${base}/spend/chat`]: () => ({ supported: true, cost: 0.42 }),
      [`${base}/spend/routing`]: () => routing,
      [`${base}/spend/routing/cheap`]: (init) => (posted.push(JSON.parse(init.body)), { saved: true }),
    },
  });
  // Spend opens as a full-screen page (a modal dialog jsdom doesn't have).
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  try {
    const { ClawChatCost, ClawSpendPill } = await dom.load("/src/OpenClawSpend.tsx");
    const peer = { id: "p", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
    await dom.render(dom.React.createElement("div", null,
      dom.React.createElement(ClawChatCost, { peer, sessionKey: "agent:main:reach-1" }),
      dom.React.createElement(ClawSpendPill, { peer })));
    await dom.waitFor(() => dom.document.body.textContent.includes("$3.10 today"));
    assert.ok(dom.document.body.textContent.includes("$0.42"));
    const pill = dom.document.querySelector(".claw-spend-pill");
    assert.ok(pill.classList.contains("near"));
    pill.click();
    await dom.waitFor(() => dom.document.body.textContent.includes("Cheap background work"));
    assert.ok(dom.document.body.textContent.includes("misses 5 min cache"));
    const button = (label) => [...dom.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    button("Set up").click();
    await settle();
    const text = dom.document.body.textContent;
    assert.ok(text.includes("Inbox") && text.includes("ops heartbeat") && text.includes("Gateway restarts"));
    assert.equal(posted.length, 0);
    button("Apply").click();
    await dom.waitFor(() => posted.length === 1);
    assert.deepEqual(posted[0], { model: "anthropic/claude-haiku-4-5", version: "v1" });
  } finally {
    await dom.close();
  }
});
