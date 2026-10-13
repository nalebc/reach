import test from "node:test";
import assert from "node:assert/strict";
import { routes } from "../server/openclaw-schedules.mjs";

const base = "/api/sessions/openclaw";
const cronJob = (over = {}) => ({
  id: "job-1",
  name: "Morning briefing",
  agentId: "main",
  enabled: true,
  sessionTarget: "isolated",
  wakeMode: "now",
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Paris", staggerMs: 0 },
  payload: { kind: "agentTurn", message: "Summarize\nmy mail" },
  delivery: { mode: "announce", channel: "whatsapp", to: "+15551234567" },
  state: { lastError: "secret sk-123" },
  ...over,
});

function fixture({ methods, jobs = [cronJob()], handle = {} } = {}) {
  const calls = [];
  const auths = [];
  const handlers = {};
  const app = {
    get: (p, h) => (handlers[`GET ${p}`] = h),
    post: (p, h) => (handlers[`POST ${p}`] = h),
  };
  const client = {
    can: (m) => !methods || methods.includes(m),
    redact: (t) => (t ? "OpenClaw reported an error." : ""),
    async call(method, params, authorize) {
      calls.push([method, params]);
      if (authorize) authorize();
      if (handle[method]) return handle[method](params);
      if (method === "cron.list") {
        const page = jobs.slice(params.offset, params.offset + params.limit);
        const next = params.offset + page.length;
        return { jobs: page, hasMore: next < jobs.length, nextOffset: next < jobs.length ? next : null };
      }
      if (method === "cron.update") {
        const job = structuredClone(jobs.find((j) => j.id === params.id));
        const p = params.patch;
        Object.assign(job, { name: p.name ?? job.name, agentId: p.agentId ?? job.agentId });
        if (p.schedule) job.schedule = p.schedule;
        if (p.payload) job.payload = { ...job.payload, ...p.payload };
        if (p.delivery) job.delivery = { ...job.delivery, ...p.delivery };
        return job;
      }
      if (method === "channels.status")
        return { channelAccounts: { whatsapp: [{ accountId: "personal", connected: true }] } };
      if (method === "sessions.list") return { sessions: [{ key: "agent:main:cron:job-1:run:abcdef123456" }] };
    },
  };
  routes(app, client, { base, authorize: (req) => () => req.reauthorize() });
  const run = async (key, { query = {}, body } = {}) => {
    let out;
    await handlers[key](
      { query, body, reauthorize: () => auths.push(key) },
      { json: (v) => (out = v) },
    );
    return out;
  };
  return { run, calls, auths };
}

test("history: past runs with tokens, redacted errors and listed chats only", async () => {
  const { run, calls } = fixture({
    handle: {
      "cron.runs": () => ({
        entries: [
          {
            ts: 2000, jobId: "job-1", action: "finished", status: "error", error: "token sk-live leaked",
            runAtMs: 1900, durationMs: 102457, summary: "model output", sessionId: "s1",
            sessionKey: "agent:main:cron:job-1:run:abcdef123456",
            usage: { input_tokens: 21, output_tokens: 2807, total_tokens: 28763 },
          },
          { ts: 1000, jobId: "job-1", action: "finished", status: "ok", sessionKey: "agent:main:cron:job-1:run:gone0000", usage: { input_tokens: 5, output_tokens: 7 } },
          { ts: 900, jobId: "other", status: "ok" },
        ],
        hasMore: true,
        nextOffset: 20,
      }),
    },
  });
  const out = await run(`GET ${base}/automations/history`, { query: { id: "job-1" } });
  assert.deepEqual(calls[0], ["cron.runs", { scope: "job", id: "job-1", limit: 20, offset: 0, sortDir: "desc" }]);
  assert.equal(out.runs.length, 2);
  assert.deepEqual(out.runs[0], {
    at: 1900, status: "error", durationMs: 102457, tokens: 28763, model: "",
    error: "OpenClaw reported an error.", note: "", deliveryError: "",
    chat: { key: "agent:main:cron:job-1:run:abcdef123456", title: "Run abcdef12" },
  });
  assert.equal(out.runs[1].tokens, 12);
  assert.equal(out.runs[1].chat, null);
  assert.equal(JSON.stringify(out).includes("sk-live"), false);
  assert.equal(JSON.stringify(out).includes("model output"), false);
  assert.equal(out.hasMore, true);
  assert.equal(out.nextOffset, 20);
});

test("history: a skipped run says why in Reach's words, never as an error", async () => {
  const { run } = fixture({
    handle: {
      "cron.runs": () => ({
        entries: [
          { ts: 3000, jobId: "job-1", status: "skipped", error: "heartbeat skipped: empty-heartbeat-file" },
          { ts: 2000, jobId: "job-1", status: "skipped", error: "heartbeat skipped: something-new" },
          { ts: 1000, jobId: "job-1", status: "skipped", error: "token sk-live leaked" },
        ],
      }),
    },
  });
  const out = await run(`GET ${base}/automations/history`, { query: { id: "job-1" } });
  assert.deepEqual(
    out.runs.map((r) => [r.error, r.note]),
    [
      ["", "Nothing to check: the heartbeat's task list is empty."],
      ["", ""],
      ["", ""],
    ],
  );
});

test("unsupported Gateways hide history and edit", async () => {
  const { run, calls } = fixture({ methods: ["cron.list"] });
  assert.deepEqual(await run(`GET ${base}/automations/history`, { query: { id: "job-1" } }), { supported: false });
  assert.deepEqual(await run(`GET ${base}/automations/job`, { query: { id: "job-1" } }), { supported: false });
  assert.equal(calls.length, 0);
});

test("ids are validated", async () => {
  const { run } = fixture();
  for (const id of ["", "../x", "a/b", undefined, "x".repeat(201)])
    await assert.rejects(run(`GET ${base}/automations/history`, { query: { id } }), { status: 400 });
});

test("job: found past the first page, whitelisted, webhook URL withheld", async () => {
  const many = Array.from({ length: 250 }, (_, i) => cronJob({ id: `j${i}` }));
  many.push(cronJob({ id: "hook", delivery: { mode: "webhook", to: "https://x.test/?key=secret" } }));
  const { run, calls } = fixture({ jobs: many });
  const out = await run(`GET ${base}/automations/job`, { query: { id: "hook" } });
  assert.equal(calls.filter(([m]) => m === "cron.list").length, 2);
  assert.equal(out.job.delivery.mode, "webhook");
  assert.equal("to" in out.job.delivery, false);
  assert.equal(JSON.stringify(out).includes("secret"), false);
  assert.equal(out.job.message, "Summarize\nmy mail");
  assert.deepEqual(out.job.schedule, { kind: "cron", expr: "0 9 * * *", tz: "Europe/Paris" });
  assert.equal("state" in out.job, false);
  assert.equal(out.job.editable, true);
  const shown = await run(`GET ${base}/automations/job`, { query: { id: "j3" } });
  assert.equal(shown.job.delivery.to, "+15551234567");
  await assert.rejects(run(`GET ${base}/automations/job`, { query: { id: "nope" } }), { status: 404 });
  const long = fixture({ jobs: [cronJob({ payload: { kind: "agentTurn", message: "x".repeat(20001) } })] });
  const tooLong = await long.run(`GET ${base}/automations/job`, { query: { id: "job-1" } });
  assert.deepEqual([tooLong.job.editable, tooLong.job.message], [false, ""]);
});

const edit = { id: "job-1", name: " Briefing ", message: "Do it" };
test("edit: keeps schedule and delivery unless sent; reauthorizes", async () => {
  const { run, calls, auths } = fixture();
  assert.deepEqual(await run(`POST ${base}/automations/edit`, { body: edit }), { saved: true });
  const [, params] = calls.find(([m]) => m === "cron.update");
  assert.deepEqual(params, { id: "job-1", patch: { name: "Briefing", payload: { kind: "agentTurn", message: "Do it" } } });
  assert.ok(auths.length >= 3);
});

test("edit: schedule with time zone, last channel clears the old target", async () => {
  const { run, calls } = fixture();
  await run(`POST ${base}/automations/edit`, {
    body: { ...edit, expr: "30 7 * * 1-5", tz: "Europe/Paris", agentId: "work", delivery: "last" },
  });
  const [, { patch }] = calls.find(([m]) => m === "cron.update");
  assert.deepEqual(patch.schedule, { kind: "cron", expr: "30 7 * * 1-5", tz: "Europe/Paris" });
  assert.deepEqual(patch.delivery, { mode: "announce", channel: "last", to: "" });
  assert.equal(patch.agentId, "work");
});

test("edit: a specific channel is checked against the live list", async () => {
  const { run, calls } = fixture();
  await run(`POST ${base}/automations/edit`, {
    body: { ...edit, delivery: "channel", channel: "whatsapp", accountId: "personal", to: " +1555 " },
  });
  const [, { patch }] = calls.find(([m]) => m === "cron.update");
  assert.deepEqual(patch.delivery, { mode: "announce", channel: "whatsapp", to: "+1555", accountId: "personal" });
  await assert.rejects(
    run(`POST ${base}/automations/edit`, { body: { ...edit, delivery: "channel", channel: "discord" } }),
    { status: 409 },
  );
});

test("edit: a system-event job keeps its kind; main-session jobs can't change delivery", async () => {
  const main = cronJob({ sessionTarget: "main", payload: { kind: "systemEvent", text: "ping" }, delivery: undefined });
  const { run, calls } = fixture({ jobs: [main] });
  await run(`POST ${base}/automations/edit`, { body: edit });
  const [, { patch }] = calls.find(([m]) => m === "cron.update");
  assert.deepEqual(patch.payload, { kind: "systemEvent", text: "Do it" });
  await assert.rejects(run(`POST ${base}/automations/edit`, { body: { ...edit, delivery: "none" } }), { status: 409 });
});

test("edit: a command job (or any other kind) is never rebuilt as an agent turn", async () => {
  for (const payload of [{ kind: "command", argv: ["backup.sh"], cwd: "/srv" }, { kind: "later" }, undefined]) {
    const { run, calls } = fixture({ jobs: [cronJob({ payload })] });
    await assert.rejects(run(`POST ${base}/automations/edit`, { body: edit }), { status: 409 });
    assert.equal(calls.some(([m]) => m === "cron.update"), false);
  }
});

test("edit: validated as strictly as a new schedule", async () => {
  const { run, calls } = fixture();
  const bad = [
    { name: "" },
    { name: "x".repeat(121) },
    { message: " " },
    { expr: "0 9 * *" },
    { expr: "0 9 * * $(rm)" },
    { tz: "Europe/Paris" },
    { expr: "0 9 * * *", tz: "../etc" },
    { agentId: "a b" },
    { delivery: "webhook" },
    { delivery: "channel", channel: "WhatsApp!" },
    { delivery: "channel", channel: "whatsapp", to: "a\nb" },
    { delivery: "last", to: "+1" },
    { id: "a/b" },
  ];
  for (const change of bad)
    await assert.rejects(run(`POST ${base}/automations/edit`, { body: { ...edit, ...change } }), { status: 400 }, JSON.stringify(change));
  assert.equal(calls.length, 0);
});

test("edit: an unconfirmed save is an error", async () => {
  const { run } = fixture({ handle: { "cron.update": () => ({ ok: true }) } });
  await assert.rejects(run(`POST ${base}/automations/edit`, { body: edit }), { status: 502 });
  const drift = fixture({
    handle: { "cron.update": () => cronJob({ name: "Briefing", payload: { kind: "agentTurn", message: "Do it" }, schedule: { kind: "cron", expr: "0 9 * * *" } }) },
  });
  await assert.rejects(
    drift.run(`POST ${base}/automations/edit`, { body: { ...edit, expr: "0 9 * * *", tz: "Europe/Paris" } }),
    { status: 502 },
  );
});

// OpenClaw's heartbeat: on and off through its config, confirmed by the schedule.
const beat = (over = {}) =>
  cronJob({
    id: "beat",
    name: "heartbeat-main",
    declarationKey: "heartbeat:main",
    sessionTarget: "main",
    schedule: { kind: "every", everyMs: 3600000 },
    payload: { kind: "heartbeat" },
    delivery: undefined,
    ...over,
  });
const heartbeatFixture = (config, job = beat()) => {
  const jobs = [job];
  const f = fixture({
    jobs,
    handle: {
      "config.get": () => ({ valid: true, hash: "h1", config }),
      "config.patch": (p) => {
        const every = JSON.parse(p.raw).agents.defaults.heartbeat.every;
        jobs[0].enabled = every !== "0m";
        return { ok: true };
      },
    },
  });
  return { ...f, jobs };
};

test("heartbeat: turned off and back on in OpenClaw's config, keeping its interval", async () => {
  const config = { agents: { defaults: { heartbeat: { agentId: "main" } }, entries: { main: { name: "Main" } } } };
  const { run, calls, auths } = heartbeatFixture(config);
  assert.deepEqual(await run(`POST ${base}/automations/heartbeat`, { body: { id: "beat", on: false } }), { enabled: false });
  const patch = calls.find(([m]) => m === "config.patch")[1];
  assert.deepEqual(JSON.parse(patch.raw), { agents: { defaults: { heartbeat: { every: "0m" } } } });
  assert.equal(patch.baseHash, "h1");
  assert.ok(auths.length >= 2);
  assert.deepEqual(await run(`POST ${base}/automations/heartbeat`, { body: { id: "beat", on: true } }), { enabled: true });
  const back = calls.filter(([m]) => m === "config.patch")[1][1];
  assert.deepEqual(JSON.parse(back.raw), { agents: { defaults: { heartbeat: { every: "60m" } } } });
});

test("heartbeat: only the plain one, from a sound config; anything else is changed in OpenClaw", async () => {
  const refuse = async (config, body, pattern, job) => {
    const { run, calls } = heartbeatFixture(config, job);
    await assert.rejects(run(`POST ${base}/automations/heartbeat`, { body }), pattern);
    assert.equal(calls.some(([m]) => m === "config.patch"), false);
  };
  const off = { id: "beat", on: false };
  await refuse({ agents: { entries: { main: { heartbeat: { every: "1h" } } } } }, off, /set per agent/);
  await refuse({ agents: { list: [{ id: "main", heartbeat: {} }] } }, off, /set per agent/);
  await refuse({ agent: { heartbeat: { every: "1h" } } }, off, /set per agent/);
  await refuse({ agents: { entries: { main: "odd" } } }, off, /set per agent/);
  await refuse({}, off, /isn't|Only OpenClaw's heartbeat/, cronJob({ id: "beat" }));
  await refuse({}, { id: "beat" }, /on or off/);
  const { run } = fixture({ jobs: [beat()], handle: { "config.get": () => ({ valid: false, config: {} }) } });
  await assert.rejects(run(`POST ${base}/automations/heartbeat`, { body: off }), /config has errors/);
});
