import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  routes,
  scrubLine,
  readLogLine,
  stateFiles,
  readiness,
  restartOpenClawGateway,
  runOpenClawMaintenance,
  DB_WARN_BYTES,
} from "../server/openclaw-health.mjs";
import { startDom, settle } from "./dom/harness.mjs";

const base = "/api/sessions/openclaw";
// Synthetic secrets, shaped like real ones.
const SECRETS = {
  openai: "sk-proj-" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z",
  anthropic: "sk-ant-" + "api03-Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2",
  slackBot: "xoxb-" + "1111111111-2222222222-AbCdEfGhIjKlMnOp",
  slackApp: "xapp-" + "1-A0123456789-1234567890-abcdef0123",
  github: "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz",
  google: "AIza" + "SyD-0123456789abcdefghijklmnopqrstu",
  telegram: "123456789:" + "AAH-dqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  hex: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  base64: "QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYZ12Abc8dEf==",
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  discord: "MTA1" + "MjM0NTY3ODkwMTIzNDU2Nzg5" + ".GaBcDe" + ".Xy9_abcdefGHIJKLmnop0123456789qrstuv",
};

test("scrubLine hides every key shape", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    const out = scrubLine(`using ${secret} now`);
    assert.equal(out.includes(secret), false, name);
    assert.match(out, /^using .*now$/, name);
    // No 12-char piece of it survives either.
    for (let i = 0; i + 12 <= secret.length; i += 6)
      assert.equal(out.includes(secret.slice(i, i + 12)), false, `${name} @${i}: ${out}`);
  }
});

test("scrubLine hides named secrets in key=value, headers and logged JSON", () => {
  const cases = [
    ["Authorization: Bearer abc.def.ghi", "abc.def"],
    ["authorization: Basic Zm9vOmJhcg==", "Zm9vOmJhcg"],
    ["token=abcdef123&next=1", "abcdef123"],
    ["password: hunter2", "hunter2"],
    ["OPENAI_API_KEY=whatever-it-is", "whatever-it-is"],
    ['{"apiKey":"plainvalue","model":"x"}', "plainvalue"],
    ["{'botToken': 'short1'}", "short1"],
    ['client_secret: "two words"', "two words"],
    ["cookie: sid=s3ss10n; theme=dark", "s3ss10n"],
    ['{"headers":{"x-api-key":"k-123"}}', "k-123"],
  ];
  for (const [line, secret] of cases) {
    const out = scrubLine(line);
    assert.equal(out.includes(secret), false, `${line} -> ${out}`);
    assert.match(out, /\[hidden\]/, line);
  }
  // Counts and flags stay readable.
  assert.equal(scrubLine("inputTokens=1200 tokens: 34"), "inputTokens=1200 tokens: 34");
  assert.equal(scrubLine('{"token":null,"auth":true}'), '{"token":null,"auth":true}');
});

test("scrubLine hides people: emails, phone numbers, chat ids, home folders", () => {
  const cases = [
    ["mail jane.doe+x@example.co.uk", "jane.doe"],
    ["starting provider (+1 514 555 0100)", "555 0100"],
    ["from +447700900123", "7700900123"],
    ["call (514) 555-0100", "555-0100"],
    ["call 514.555.0100", "555.0100"],
    ["jid 15145550100@s.whatsapp.net", "15145550100"],
    ["discord user 123456789012345678", "123456789012345678"],
    ["read /Users/jane/.openclaw/openclaw.json", "jane"],
    ["read /home/jane/x", "jane"],
    ["read C:\\Users\\jane\\x", "jane"],
  ];
  for (const [line, secret] of cases) {
    const out = scrubLine(line);
    assert.equal(out.includes(secret), false, `${line} -> ${out}`);
  }
});

test("scrubLine keeps URLs' hosts only: no credentials, path or query", () => {
  assert.equal(
    scrubLine("POST https://user:pw@hooks.example.com:8443/services/T0/B0/xyz?sig=abc&x=1 ok"),
    "POST https://hooks.example.com:8443 ok",
  );
  const telegram = scrubLine(`GET https://api.telegram.org/bot${SECRETS.telegram}/getUpdates`);
  assert.equal(telegram, "GET https://api.telegram.org");
  assert.equal(scrubLine("wss://x.test/?token=abc"), "wss://x.test");
  assert.equal(scrubLine("GET /oauth/callback?code=4/0Abc&state=xyz 200"), "GET /oauth/callback 200");
});

test("scrubLine leaves ordinary log text readable", () => {
  for (const line of [
    "at 2026-10-08T16:13:24.243Z took 1234ms",
    "model anthropic/claude-sonnet-4-5-20250929 replied",
    "loaded /opt/homebrew/lib/node_modules/openclaw/dist/subsystem-D2xHvZZd.js",
    "gateway/channels/whatsapp listening on port 18789",
    "session 123e4567-e89b-12d3-a456-4266141 ended",
  ])
    assert.equal(scrubLine(line), line);
});

test("scrubLine strips control characters and caps length", () => {
  assert.equal(scrubLine("\u001b[31mred\u001b[0m\u0007 done"), "red done");
  assert.equal(scrubLine("a\n\tb"), "a b");
  const long = scrubLine("word ".repeat(10000));
  assert.ok(long.length <= 300);
  assert.ok(long.endsWith("…"));
  // A token cut by the first cap is never left half-visible.
  for (const pad of [" ".repeat(1180), "x".repeat(1190), "a ".repeat(595)]) {
    const cut = scrubLine("a" + pad + " " + SECRETS.github);
    assert.equal(cut.includes("ghp_"), false, JSON.stringify(cut.slice(-40)));
  }
});

test("readLogLine keeps time, level, subsystem and the scrubbed message; never _meta", () => {
  const raw = JSON.stringify({
    0: '{"subsystem":"gateway/channels/whatsapp"}',
    1: "[default] starting provider (+15145550100)",
    2: { apiKey: "inner-secret" },
    _meta: {
      name: '{"subsystem":"gateway/channels/whatsapp"}',
      date: "2026-10-08T16:13:24.243Z",
      logLevelName: "ERROR",
      hostname: "janes-mac",
      path: { fullFilePath: "file:///Users/jane/x.js:1:2" },
    },
  });
  const line = readLogLine(raw);
  assert.deepEqual(Object.keys(line).sort(), ["level", "source", "text", "time"]);
  assert.equal(line.level, "error");
  assert.equal(line.source, "gateway/channels/whatsapp");
  assert.equal(line.time, Date.parse("2026-10-08T16:13:24.243Z"));
  assert.match(line.text, /^\[default\] starting provider \(\[phone\]\) \{"apiKey":"\[hidden\]"\}$/);
  assert.equal(JSON.stringify(line).includes("janes-mac"), false);
  assert.equal(JSON.stringify(line).includes("jane"), false);
  // Not JSON: still scrubbed, as info.
  assert.deepEqual(readLogLine(`boom ${SECRETS.openai}`), { time: 0, level: "info", source: "", text: "boom [hidden]" });
  assert.equal(readLogLine(""), null);
  assert.equal(readLogLine(JSON.stringify({ _meta: { logLevelName: "BOGUS" }, 0: "x" })).level, "info");
});

test("stateFiles sums OpenClaw's databases and WALs; skips workspaces and symlinks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claw-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "memory"));
  await fs.mkdir(path.join(root, "workspace-x"));
  await fs.writeFile(path.join(root, "memory", "main.sqlite"), Buffer.alloc(1000));
  await fs.writeFile(path.join(root, "memory", "main.sqlite-wal"), Buffer.alloc(3000));
  await fs.writeFile(path.join(root, "memory", "notes.md"), Buffer.alloc(9000));
  await fs.writeFile(path.join(root, "workspace-x", "app.db"), Buffer.alloc(50000));
  await fs.symlink(path.join(root, "workspace-x", "app.db"), path.join(root, "linked.db"));
  const sizes = await stateFiles({ env: { OPENCLAW_STATE_DIR: root } });
  assert.deepEqual(sizes, { supported: true, dbBytes: 4000, walBytes: 3000, largestBytes: 3000, files: 1, warn: false });
  assert.deepEqual(await stateFiles({ env: {}, home: path.join(root, "nowhere") }), { supported: false });
});

test("readiness reads /readyz on loopback and maps channels to fixed labels", async () => {
  let asked;
  const fetch = async (url) => {
    asked = url;
    return { json: async () => ({ ready: false, failing: ["whatsapp", "evil<script>", "whatsapp"], uptimeMs: 1234.4 }) };
  };
  const got = await readiness({ configuration: async () => ({ url: "ws://127.0.0.1:19999", token: "t" }), fetch });
  assert.equal(asked, "http://127.0.0.1:19999/readyz");
  assert.deepEqual(got, { supported: true, ready: false, uptimeMs: 1234, failing: ["WhatsApp", "Other"] });
  assert.deepEqual(
    await readiness({ configuration: async () => ({ url: "ws://127.0.0.1:1" }), fetch: async () => { throw new Error("ECONNREFUSED secret"); } }),
    { supported: false },
  );
  assert.deepEqual(
    await readiness({ configuration: async () => ({ url: "ws://127.0.0.1:1" }), fetch: async () => ({ json: async () => ({ ok: true }) }) }),
    { supported: false },
  );
});

test("restart runs fixed args in a login shell with a timeout; never echoes its output", async () => {
  const runs = [];
  const configuration = async () => ({ url: "ws://127.0.0.1:18789" });
  await restartOpenClawGateway({ configuration, run: async (...a) => runs.push(a), env: { SHELL: "/bin/zsh" }, platform: "darwin" });
  assert.deepEqual(runs, [["/bin/zsh", ["-lc", "openclaw gateway restart"], { timeout: 25000 }]]);
  await assert.rejects(
    restartOpenClawGateway({ configuration, run: async () => { throw new Error(`stderr ${SECRETS.openai}`); }, env: {}, platform: "linux" }),
    (e) => e.status === 503 && !e.message.includes("sk-") && /openclaw gateway restart/.test(e.message),
  );
  await assert.rejects(
    restartOpenClawGateway({ configuration, run: async () => runs.push("ran"), authorize: () => { throw new Error("revoked"); } }),
    /revoked/,
  );
  // A remote profile (localOpenClawConfig refuses it): nothing runs.
  await assert.rejects(
    restartOpenClawGateway({ configuration: async () => { throw Object.assign(new Error("This OpenClaw profile uses a remote Gateway."), { status: 503 }); }, run: async () => runs.push("ran") }),
    /remote Gateway/,
  );
  assert.equal(runs.includes("ran"), false);
});

// A fake express app and Gateway client.
function fixture({ methods = ["health", "logs.tail"], health, tail, ready, files, restart, server, ...extra } = {}) {
  const handlers = {},
    calls = [];
  const app = {
    get: (route, fn) => (handlers[`GET ${route}`] = fn),
    post: (route, fn) => (handlers[`POST ${route}`] = fn),
  };
  const client = {
    can: (m) => methods.includes(m),
    call: async (method, params, authorize, waitMs) => {
      calls.push({ method, params, waitMs });
      if (method === "health") return health ? health() : { ok: true, sessions: { path: "/Users/jane/x" }, agents: [{ name: "Secret Agent" }] };
      if (method === "logs.tail") return tail ? tail(params) : { file: "/tmp/openclaw/x.log", lines: [] };
    },
    overview: async () => ({ connected: true }),
    redact: (t) => t,
    ...(server ? { server } : {}),
  };
  let auths = 0;
  const reauthorized = [];
  routes(app, client, {
    base,
    authorize: (req) => () => {
      auths++;
      req.reauthorize();
    },
    openCommand: extra.openCommand,
    ready: ready || (async () => ({ supported: true, ready: true, uptimeMs: 99000, failing: [] })),
    files: files || (async () => ({ supported: true, dbBytes: 1000, walBytes: 0, largestBytes: 1000, files: 1, warn: false })),
    restart: restart || (async () => {}),
    settleMs: 0,
    ...extra,
  });
  const hit = async (verb, route, { body, query = {}, revoked = false, client = { kind: "device", scopes: ["admin"] } } = {}) => {
    let answered;
    const req = {
      client,
      body,
      query,
      reauthorize: () => {
        reauthorized.push(route);
        if (revoked) throw Object.assign(new Error("Not allowed"), { status: 401 });
      },
    };
    await handlers[`${verb} ${base}${route}`](req, { json: (v) => (answered = v) });
    return answered;
  };
  return { hit, calls, reauthorized, auths: () => auths };
}

test("health answers with numbers and fixed labels only", async () => {
  const f = fixture({ server: () => ({ version: "2026.3.13" }) });
  const h = await f.hit("GET", "/health");
  assert.equal(h.status, "ok");
  assert.equal(h.gateway.supported, true);
  assert.equal(h.gateway.answered, true);
  assert.equal(h.gateway.version, "2026.3.13");
  assert.deepEqual(h.uptime, { supported: true, ms: 99000 });
  assert.deepEqual(h.channels, { supported: true, failing: [] });
  assert.deepEqual(h.memory, { supported: false });
  assert.equal(h.storage.dbBytes, 1000);
  const text = JSON.stringify(h);
  assert.equal(text.includes("jane"), false);
  assert.equal(text.includes("Secret Agent"), false);
  assert.equal(f.calls[0].waitMs, 5000);
});

test("health: slow, failing channels, a big database, a Gateway that doesn't answer", async () => {
  let t = 0;
  const slow = fixture({ now: () => (t += 2500), health: () => ({ ok: true }) });
  assert.equal((await slow.hit("GET", "/health")).status, "slow");
  const channels = fixture({ ready: async () => ({ supported: true, ready: false, uptimeMs: 5, failing: ["Telegram"] }) });
  const c = await channels.hit("GET", "/health");
  assert.equal(c.status, "attention");
  assert.deepEqual(c.channels.failing, ["Telegram"]);
  const big = fixture({ files: async () => ({ supported: true, dbBytes: DB_WARN_BYTES + 1, walBytes: DB_WARN_BYTES + 1, largestBytes: 1, files: 1, warn: true }) });
  assert.equal((await big.hit("GET", "/health")).status, "attention");
  const down = fixture({ health: () => { throw new Error(`gateway said ${SECRETS.openai}`); } });
  const d = await down.hit("GET", "/health");
  assert.equal(d.status, "attention");
  assert.equal(d.gateway.answered, false);
  assert.equal(JSON.stringify(d).includes("sk-"), false);
  // An odd version string never travels.
  const odd = fixture({ server: () => ({ version: "1.0 <img src=x>" }) });
  assert.equal((await odd.hit("GET", "/health")).gateway.version, undefined);
});

test("health: each missing part says supported:false", async () => {
  const f = fixture({ methods: [], ready: async () => ({ supported: false }), files: async () => ({ supported: false }) });
  const h = await f.hit("GET", "/health");
  assert.deepEqual(
    { gateway: h.gateway, uptime: h.uptime, channels: h.channels, memory: h.memory, storage: h.storage },
    { gateway: { supported: false }, uptime: { supported: false }, channels: { supported: false }, memory: { supported: false }, storage: { supported: false } },
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.hit("GET", "/health/logs"), { supported: false });
});

test("the state files are walked at most once a minute", async () => {
  let walks = 0,
    t = 0;
  const f = fixture({ now: () => t, files: async () => (walks++, { supported: false }) });
  await f.hit("GET", "/health");
  await f.hit("GET", "/health");
  assert.equal(walks, 1);
  t = 61000;
  await f.hit("GET", "/health");
  assert.equal(walks, 2);
});

const logLine = (level, text, extra = {}) =>
  JSON.stringify({ 0: text, _meta: { date: "2026-10-08T10:00:00.000Z", logLevelName: level, hostname: "janes-mac" }, ...extra });

test("logs: the last 200 lines, scrubbed; errors only on ask", async () => {
  const lines = [];
  for (let i = 0; i < 260; i++) lines.push(logLine(i % 10 ? "INFO" : "ERROR", `line ${i} key ${SECRETS.slackBot}`));
  const f = fixture({ tail: (p) => ({ file: "/Users/jane/log", lines: lines.slice(-p.limit) }) });
  const all = await f.hit("GET", "/health/logs");
  assert.equal(all.supported, true);
  assert.equal(all.lines.length, 200);
  assert.equal(all.lines.at(-1).text, "line 259 key [hidden]");
  assert.deepEqual(f.calls.at(-1).params, { limit: 200, maxBytes: 250000 });
  const text = JSON.stringify(all);
  for (const leak of ["xoxb", "jane", "file"]) assert.equal(text.includes(leak), false, leak);
  const errors = await f.hit("GET", "/health/logs", { query: { errors: "1" } });
  assert.deepEqual(f.calls.at(-1).params, { limit: 5000, maxBytes: 1000000 });
  assert.equal(errors.lines.length, 26);
  assert.ok(errors.lines.every((l) => l.level === "error"));
});

test("logs: a failed read says so in Reach's words", async () => {
  const f = fixture({ tail: () => { throw new Error(`EACCES /Users/jane ${SECRETS.openai}`); } });
  await assert.rejects(f.hit("GET", "/health/logs"), (e) => e.status === 503 && !/jane|sk-/.test(e.message));
});

test("restart: confirmed, authorized throughout, answers once a new Gateway does", async () => {
  let t = 0,
    restarted = false;
  const ready = async () => ({ supported: true, ready: true, uptimeMs: restarted ? 500 : 10 ** 7, failing: [] });
  const f = fixture({
    now: () => (t += 100),
    ready: async () => {
      const r = await ready();
      return r;
    },
    restart: async ({ authorize }) => {
      authorize();
      restarted = true;
    },
  });
  await assert.rejects(f.hit("POST", "/health/restart", { body: {} }), /Confirm/);
  assert.equal(restarted, false);
  assert.deepEqual(await f.hit("POST", "/health/restart", { body: { confirm: true } }), { restarted: true, back: true });
  assert.ok(f.auths() >= 4);
  // Revoked: nothing runs.
  restarted = false;
  await assert.rejects(f.hit("POST", "/health/restart", { body: { confirm: true }, revoked: true }), /Not allowed/);
  assert.equal(restarted, false);
});

test("restart: the old Gateway still answering isn't taken for the new one; answers within the phone's wait", async () => {
  let t = 0;
  const f = fixture({ now: () => (t += 1000), ready: async () => ({ supported: true, ready: true, uptimeMs: 10 ** 7, failing: [] }) });
  assert.deepEqual(await f.hit("POST", "/health/restart", { body: { confirm: true } }), { restarted: true, back: false });
  assert.ok(t <= 32000);
});

test("maintenance requires confirmation, excludes duplicates and retains results", async () => {
  let finish;
  const called = [];
  const f = fixture({ runMaintenance: (action) => {
    called.push(action);
    return new Promise((resolve) => { finish = resolve; });
  } });
  await assert.rejects(f.hit("POST", "/health/doctor"), /Confirm/);
  await assert.rejects(f.hit("POST", "/health/update", { body: { confirm: true }, revoked: true }), /Not allowed/);
  const started = await f.hit("POST", "/health/doctor", { body: { confirm: true, command: "evil" } });
  assert.equal(started.job.status, "running");
  await assert.rejects(f.hit("POST", "/health/update", { body: { confirm: true } }), /already running/);
  assert.deepEqual(called, ["doctor"]);
  finish({ status: "done", message: "Checked", lines: ["findings"] });
  await new Promise((r) => setImmediate(r));
  const result = await f.hit("GET", "/health/maintenance");
  assert.equal(result.job.status, "done");
  assert.deepEqual(result.job.lines, ["findings"]);
});

test("maintenance runs fixed noninteractive commands, scrubs output and reports failure/skips", async () => {
  const seen = [];
  const deps = { configuration: async () => ({}), env: { SHELL: "/bin/sh" }, platform: "darwin",
    run: async (...args) => { seen.push(args); return { stdout: `key=${SECRETS.openai}`, stderr: "" }; } };
  const doctor = await runOpenClawMaintenance("doctor", deps);
  assert.equal(doctor.status, "done");
  assert.equal(JSON.stringify(doctor).includes(SECRETS.openai), false);
  assert.match(seen[0][1][1], /doctor --non-interactive/);
  await runOpenClawMaintenance("repair", deps);
  assert.match(seen[1][1][1], /--repair --non-interactive/);
  for (const [status, expected] of [["ok", "done"], ["skipped", "skipped"], ["error", "failed"]]) {
    const r = await runOpenClawMaintenance("update", { ...deps, run: async () => ({ stdout: JSON.stringify({ status }) }) });
    assert.equal(r.status, expected);
  }
  const failed = await runOpenClawMaintenance("doctor", { ...deps, run: async () => { throw new Error("secret"); } });
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  const readable = await runOpenClawMaintenance("doctor", { ...deps, run: async () => ({ stdout: "Health check findings\nGateway connection failed\nTry restarting the Gateway" }) });
  assert.deepEqual(readable.lines, ["Health check findings", "Gateway connection failed", "Try restarting the Gateway"]);
  for (const status of ["ok", "skipped", "error"]) {
    const mixed = await runOpenClawMaintenance("update", { ...deps, run: async () => ({ stdout: `Plugin loaded\n${JSON.stringify({ status, steps: [] }, null, 2)}\nService message` }) });
    assert.equal(mixed.status, status === "ok" ? "done" : status === "error" ? "failed" : "skipped");
  }
  const invalid = await runOpenClawMaintenance("update", { ...deps, run: async () => ({ stdout: "Update started" }) });
  assert.equal(invalid.status, "failed");
  await assert.rejects(runOpenClawMaintenance("evil", deps), /Choose/);
  await assert.rejects(runOpenClawMaintenance("doctor", { ...deps, authorize: () => { throw new Error("revoked"); } }), /revoked/);
});

// --- UI --------------------------------------------------------------------
const peer = { id: "fixture", url: "https://reach.test", token: "inert" };
async function ui({ health, logs, job, maintenance, healthRead, continuation } = {}) {
  const posted = [],
    reads = [];
  const opened = [];
  const dom = await startDom({
    routes: {
      [`${base}/health`]: () => (reads.push("health"), healthRead ? healthRead() : health || {
        status: "attention",
        gateway: { supported: true, answered: true, ms: 40 },
        uptime: { supported: true, ms: 3 * 3600000 + 5 * 60000 },
        channels: { supported: true, failing: ["Telegram"] },
        memory: { supported: false },
        storage: { supported: true, dbBytes: 820e6, walBytes: 600e6, warn: true },
      }),
      [`${base}/health/logs`]: (_init, href) => (reads.push(href.search), logs || {
        supported: true,
        lines: href.search.includes("errors=1")
          ? [{ time: 0, level: "error", source: "x", text: "only the error" }]
          : [
              { time: 0, level: "info", source: "x", text: "all fine here" },
              { time: 0, level: "error", source: "x", text: "only the error" },
            ],
      }),
      [`${base}/health/restart`]: (init) => (posted.push(["restart", JSON.parse(init.body)]), { restarted: true }),
      [`${base}/health/maintenance`]: () => ({ job: job || (posted.some(([action]) => action === "doctor") ? { action: "doctor", status: "done", message: "Health check finished.", lines: ["All checks complete"] } : null) }),
      [`${base}/health/maintenance/continue`]: async (init) => (posted.push(["continue", JSON.parse(init.body)]), continuation ? await continuation() : { job: { action: "update", status: "running", lines: [] } }),
      [`${base}/health/doctor`]: async (init) => (posted.push(["doctor", JSON.parse(init.body)]), maintenance ? await maintenance() : { job: { action: "doctor", status: "running", lines: [] } }),
    },
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.addEventListener("reach:open-terminal", (e) => opened.push(e.detail));
  const { ClawHealthPill } = await dom.load("/src/OpenClawHealth.tsx");
  const changed = [];
  await dom.render(dom.React.createElement(ClawHealthPill, { peer, refresh: 0, onChanged: () => changed.push(1) }));
  const button = (text) => [...dom.document.querySelectorAll("button")].reverse().find((b) => b.getAttribute("aria-label") === text || (b.querySelector("strong")?.textContent || b.textContent).trim() === text);
  const click = async (el) => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
  };
  return { dom, posted, reads, opened, changed, button, click, text: () => dom.document.body.textContent };
}

test("pill opens a sheet with rows, fixes and logs", async () => {
  const u = await ui();
  try {
    await u.dom.waitFor(() => u.button("Needs attention"));
    await u.click(u.button("Needs attention"));
    assert.equal(u.dom.document.querySelector(".claw-health-lines"), null);
    assert.equal(u.reads.includes(""), false, "logs are fetched only when opened");
    for (const word of ["3 h 5 min", "820 MB", "Large", "600 MB", "Telegram"]) assert.match(u.text(), new RegExp(word));
    await u.click(u.button("Open logs"));
    await u.dom.waitFor(() => u.text().includes("all fine here"));
    assert.equal(u.text().includes("Memory"), false);
    // Errors only.
    await u.click(u.button("Errors"));
    await u.dom.waitFor(() => !u.text().includes("all fine here"));
    assert.ok(u.reads.includes("?errors=1"));
    await u.click(u.button("Close gateway logs"));
    // Restart takes two taps.
    await u.click(u.button("Restart"));
    assert.equal(u.posted.length, 0);
    await u.click(u.button("Restart"));
    await u.dom.waitFor(() => u.text().includes("Gateway restarted"));
    assert.deepEqual(u.posted, [["restart", { confirm: true }]]);
    assert.equal(u.changed.length, 1);
    await u.click(u.button("Check health"));
    assert.equal(u.posted.length, 1);
    await u.click(u.button("Check health"));
    await u.dom.waitFor(() => u.text().includes("Health check finished."));
    assert.deepEqual(u.posted[1], ["doctor", { confirm: true }]);
    await u.dom.waitFor(() => u.changed.length === 2);
    assert.deepEqual(u.opened, []);
    assert.doesNotMatch(u.text(), /All checks complete/);
    await u.click(u.button("View output"));
    assert.match(u.text(), /All checks complete/);
    assert.deepEqual(u.dom.errors, []);
  } finally {
    await u.dom.close();
  }
});

test("pill words and hidden parts", async () => {
  const u = await ui({
    health: {
      status: "ok",
      gateway: { supported: false },
      uptime: { supported: false },
      channels: { supported: false },
      memory: { supported: false },
      storage: { supported: false },
    },
    logs: { supported: false },
  });
  try {
    await u.dom.waitFor(() => u.button("Healthy"));
    await u.click(u.button("Healthy"));
    await settle(50);
    for (const word of ["Uptime", "Database", "Channels"]) assert.equal(new RegExp(`\\b${word}\\b`).test(u.text()), false, word);
    assert.ok(u.button("Restart"));
  } finally {
    await u.dom.close();
  }
});


test("maintenance reports structured reasons, process failures, timeouts and malformed output", async () => {
  const deps = { configuration: async () => ({}), env: { SHELL: "/bin/sh" }, platform: "darwin" };
  const structured = await runOpenClawMaintenance("update", { ...deps, run: async () => ({
    stdout: JSON.stringify({ status: "error", reason: "npm install failed", steps: [{ exitCode: 1, stderrTail: "EACCES" }] }),
  }) });
  assert.match(structured.message, /npm install failed/);
  const exit = await runOpenClawMaintenance("update", { ...deps, run: async () => {
    throw Object.assign(new Error("failed"), { code: 1, stderr: "EACCES: permission denied" });
  } });
  assert.match(exit.message, /EACCES: permission denied/);
  assert.ok(exit.lines.includes("The command exited with code 1."));
  const timeout = await runOpenClawMaintenance("update", { ...deps, run: async () => {
    throw Object.assign(new Error("failed"), { killed: true });
  } });
  assert.match(timeout.message, /time limit/);
  const missing = await runOpenClawMaintenance("update", { ...deps, run: async () => ({ stdout: "" }) });
  assert.match(missing.message, /valid update result/);
  const skipped = await runOpenClawMaintenance("update", { ...deps, run: async () => ({ stdout: JSON.stringify({ status: "skipped", reason: "dirty working tree" }) }) });
  assert.match(skipped.message, /dirty working tree/);
});


test("actions open focused confirmation and show immediate progress without duplicate submissions", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const u = await ui({ maintenance: () => pending });
  try {
    await u.dom.waitFor(() => u.button("Needs attention"));
    await u.click(u.button("Needs attention"));
    await u.dom.waitFor(() => !u.button("Check health").disabled);
    await u.click(u.button("Check health"));
    assert.ok(u.dom.document.querySelector('dialog[aria-label="Check health"]'));
    assert.equal(u.posted.length, 0);
    const confirm = u.button("Check health");
    confirm.click(); confirm.click();
    await settle();
    assert.equal(u.posted.length, 1);
    assert.match(u.text(), /Checking health…/);
    assert.equal(u.dom.document.querySelector('dialog[aria-label="Check health"]'), null);
    assert.ok(u.button("Restart").disabled);
    release({ job: { action: "doctor", status: "failed", message: "Permission denied", lines: ["EACCES"] } });
    await u.dom.waitFor(() => u.text().includes("Permission denied"));
    assert.ok(u.button("Try again"));
    await u.click(u.button("View output"));
    await u.dom.waitFor(() => u.dom.document.querySelector(".file-code"));
    assert.match(u.dom.document.querySelector(".file-code-source").textContent, /EACCES/);
    await u.click(u.button("Close check health output"));
    assert.match(u.text(), /Permission denied/);
    assert.deepEqual(u.dom.errors, []);
  } finally { release({ job: null }); await u.dom.close(); }
});

test("old failures without details offer logs and retry, and logs use the Files preview", async () => {
  const u = await ui({ job: { action: "doctor", status: "failed", message: "OpenClaw couldn't finish. Try again.", lines: [] } });
  try {
    await u.dom.waitFor(() => u.button("Needs attention"));
    await u.click(u.button("Needs attention"));
    await u.dom.waitFor(() => u.text().includes("No error details were returned"));
    assert.doesNotMatch(u.text(), /couldn't finish/);
    await u.click(u.button("Open logs"));
    await u.dom.waitFor(() => u.dom.document.querySelector(".file-code-source"));
    assert.ok(u.dom.document.querySelector('dialog.file-viewer[aria-label="Gateway logs"]'));
    assert.ok(u.button("Copy text"));
    await u.click(u.button("Wrap lines"));
    assert.ok(u.dom.document.querySelector(".file-code.is-wrapped"));
    await u.click(u.button("All"));
    assert.match(u.dom.document.querySelector(".file-code-source").textContent, /all fine here/);
    await u.click(u.button("Errors"));
    await u.dom.waitFor(() => u.dom.document.querySelector(".file-code-source")?.textContent.includes("only the error"));
    assert.doesNotMatch(u.dom.document.querySelector(".file-code-source").textContent, /all fine here/);
    await u.click(u.button("Close gateway logs"));
    assert.ok(u.button("Try again"));
    assert.deepEqual(u.dom.errors, []);
  } finally { await u.dom.close(); }
});

test("failed updates explain an unsupported Node runtime without opening output", async () => {
  const stderr = "npm error code 1\nnpm error [openclaw] error: this OpenClaw release requires Node >=24.16.0 <25 || >=26.1.0.\nnpm error [openclaw] detected Node 23.7.0 (exec: /opt/homebrew/bin/node).";
  const u = await ui({ job: {
    action: "update", status: "failed", message: "Update failed: global update",
    lines: JSON.stringify({ status: "error", steps: [{ name: "global update", exitCode: 1, stderrTail: stderr }] }, null, 2).split("\n"),
  } });
  try {
    await u.dom.waitFor(() => u.button("Needs attention"));
    await u.click(u.button("Needs attention"));
    await u.dom.waitFor(() => u.button("View output"));
    assert.match(u.text(), /OpenClaw requires Node >=24\.16\.0 <25 \|\| >=26\.1\.0\./);
    assert.match(u.text(), /This computer used Node 23\.7\.0/);
    await u.click(u.button("View output"));
    assert.ok(u.dom.document.querySelector('.file-code-source'));
    assert.match(u.dom.document.querySelector('.file-code-source').textContent, /npm error code 1/);
    await u.click(u.button("Close update openclaw output"));
    await u.click(u.button("Open logs"));
    await u.dom.waitFor(() => u.dom.document.querySelector('.file-code-source'));
    assert.match(u.dom.document.querySelector('.file-code-source').textContent, /all fine here/);
    assert.deepEqual(u.dom.errors, []);
  } finally { await u.dom.close(); }
});


test("dependency recovery requires approval for the exact attempt and retains phase progress", async () => {
  const recipe = { kind: "node", available: true, brew: "/opt/homebrew/bin/brew", minimum: [24, 16, 0], title: "Upgrade Node", description: "Install Node", steps: ["Install", "Verify"] };
  let installDone;
  const calls = [];
  const f = fixture({
    installRuntime: async (_recipe, { authorize }) => {
      authorize(); calls.push("install");
      await new Promise(resolve => { installDone = resolve; });
      authorize(); return "/opt/homebrew/opt/node@24/bin/node";
    },
    runMaintenance: async (action, { authorize, runtime }) => {
      authorize(); calls.push(action);
      if (action === "update" && !runtime) return { status: "failed", recovery: recipe, message: "Node too old", lines: [] };
      return { status: "done", lines: [action] };
    },
  });
  await f.hit("POST", "/health/update", { body: { confirm: true } });
  await settle();
  const { job } = await f.hit("GET", "/health/maintenance");
  assert.equal(job.status, "awaiting_approval");
  assert.equal(job.recovery.brew, undefined, "private execution paths do not go to the phone");
  assert.deepEqual(calls, ["update"], "failure never installs dependencies automatically");
  await assert.rejects(f.hit("POST", "/health/maintenance/continue", { body: { jobId: job.id } }), /Approve/);
  await assert.rejects(f.hit("POST", "/health/maintenance/continue", { body: { jobId: "stale", confirm: true } }), /changed/);
  await assert.rejects(f.hit("POST", "/health/maintenance/continue", { body: { jobId: job.id, confirm: true }, client: { kind: "agent", scopes: ["admin"] } }), /owner/);
  await assert.rejects(f.hit("POST", "/health/maintenance/continue", { body: { jobId: job.id, confirm: true }, revoked: true }), /Not allowed/);
  const started = await f.hit("POST", "/health/maintenance/continue", { body: { jobId: job.id, confirm: true, command: "ignored" } });
  assert.equal(started.job.status, "running");
  await settle();
  assert.match((await f.hit("GET", "/health/maintenance")).job.phase, /Installing Node/);
  await assert.rejects(f.hit("POST", "/health/maintenance/continue", { body: { jobId: job.id, confirm: true } }), /changed/);
  installDone(); await settle();
  const finished = (await f.hit("GET", "/health/maintenance")).job;
  assert.equal(finished.status, "done");
  assert.deepEqual(calls, ["update", "install", "update", "repair-service", "finish-update", "verify-update"]);
  assert.match(finished.message, /Gateway is connected/);
});

test("required changes are reviewable in Reach and only confirmation resumes the update", async () => {
  const job = { id: "attempt-1", action: "update", status: "awaiting_approval", lines: [], recovery: {
    kind: "node", title: "Upgrade Node to continue", description: "Node 23 is too old.", available: true,
    steps: ["Install Node 24 and its Homebrew dependencies", "Migrate settings and plugins", "Verify the Gateway"],
  } };
  const u = await ui({ job });
  try {
    await u.dom.waitFor(() => u.button("Needs attention"));
    await u.click(u.button("Needs attention"));
    await u.dom.waitFor(() => u.button("Review required changes"));
    assert.match(u.text(), /needs approval/);
    await u.click(u.button("Review required changes"));
    assert.match(u.text(), /Install Node 24 and its Homebrew dependencies/);
    assert.equal(u.posted.length, 0);
    await u.click(u.button("Not now"));
    assert.equal(u.posted.length, 0);
    await u.click(u.button("Review required changes"));
    const approve = u.button("Approve and continue");
    approve.click(); approve.click(); await settle();
    assert.deepEqual(u.posted, [["continue", { confirm: true, jobId: "attempt-1" }]]);
    assert.deepEqual(u.dom.errors, []);
  } finally { await u.dom.close(); }
});


test("post-update warnings remain visible without being misreported as a failed command", async () => {
  const result = await runOpenClawMaintenance("finish-update", {
    platform: "darwin", env: { SHELL: "/bin/sh" }, configuration: async () => ({}),
    run: async () => ({ stdout: JSON.stringify({ status: "warning", message: "Plugin still needs attention" }) }),
  });
  assert.equal(result.status, "done");
  assert.equal(result.warnings, true);
  assert.match(result.message, /warnings/);
});
