import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  routes,
  onboardArgs,
  keyedShell,
  profileArgs,
  authStoreFile,
  saveApiKey,
  defaultArgs,
  onboardStatus,
  onboardOpenClaw,
  addOpenClawProvider,
  configFile,
  PROVIDERS,
} from "../server/openclaw-onboard.mjs";
import { installPlan } from "../server/agent-install.mjs";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

const base = "/api/sessions/openclaw";
const KEY = "sk-or-v1-SECRETKEY0123456789";
const env = { SHELL: "/bin/zsh" };
// A temp main-agent store, as OpenClaw writes it (never this Mac's own).
async function tempStore(extra) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-onboard-store-"));
  const file = path.join(dir, "agents", "main", "agent", "auth-profiles.json");
  if (extra) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(extra, null, 2));
  }
  return file;
}
async function tempConfig({ make = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-onboard-"));
  const file = path.join(dir, "openclaw.json");
  if (make) await fs.writeFile(file, "{}");
  return file;
}
// A failing child as execFile reports it: argv in cmd and message.
const leaky = (argv) =>
  Object.assign(new Error(`Command failed: ${argv.join(" ")}\n${KEY}`), { cmd: argv.join(" "), stderr: `bad key ${KEY}`, stdout: KEY });
const noKey = (value) => assert.doesNotMatch(JSON.stringify(value) + String(value?.message ?? "") + String(value?.stack ?? ""), /SECRETKEY/);

test("first setup: fixed argv, loopback Gateway with token auth, never the key", () => {
  const args = onboardArgs("openrouter");
  assert.deepEqual(args, [
    "onboard", "--non-interactive", "--accept-risk", "--mode", "local",
    "--auth-choice", "openrouter-api-key", "--secret-input-mode", "plaintext",
    "--gateway-port", "18789", "--gateway-bind", "loopback", "--gateway-auth", "token", "--tailscale", "off",
    "--install-daemon", "--daemon-runtime", "node",
    "--skip-channels", "--skip-skills", "--skip-search", "--skip-ui", "--skip-health",
  ]);
  for (const [p, choice, envVar] of [["anthropic", "apiKey", "ANTHROPIC_API_KEY"], ["openai", "openai-api-key", "OPENAI_API_KEY"], ["google", "gemini-api-key", "GEMINI_API_KEY"]]) {
    const a = onboardArgs(p);
    assert.equal(a[a.indexOf("--auth-choice") + 1], choice);
    assert.ok(!a.some((x) => /api-key=/.test(x)));
    assert.match(keyedShell(p, a)[1], new RegExp(`^export ${envVar}="\\$REACH_PROVIDER_KEY"; unset REACH_PROVIDER_KEY; exec openclaw "\\$@"$`));
  }
  assert.ok(!args.some((x) => /0\.0\.0\.0|^lan$|^auto$|^custom$|tailnet|funnel|serve|--reset|--json|--gateway-token|--remote/.test(x)));
  assert.equal(args[args.indexOf("--gateway-bind") + 1], "loopback");
});

test("only allowlisted providers, only key-shaped keys", async () => {
  for (const p of ["ollama", "vllm", "custom-api-key", "__proto__", "constructor", "toString", "", undefined, 1, ["openai"]])
    assert.throws(() => onboardArgs(p), (e) => e.status === 400 && /Choose/.test(e.message));
  for (const k of ["", "short", "has space inside", "line\nbreak12345", "x".repeat(4097), 12345678, undefined])
    await assert.rejects(
      onboardOpenClaw({ provider: "openai", key: k, acceptRisk: true }, { run: async () => assert.fail("must not run"), env, platform: "darwin", file: await tempConfig() }),
      (e) => e.status === 400 && e.message === "Paste the API key.",
    );
  assert.throws(() => profileArgs("__proto__"), (e) => e.status === 400);
  assert.deepEqual(profileArgs("anthropic"), ["config", "set", "auth.profiles[anthropic:default]", '{"provider":"anthropic","mode":"api_key"}', "--strict-json"]);
  assert.deepEqual(defaultArgs("openrouter"), ["models", "set", "openrouter/auto"]);
  assert.deepEqual(defaultArgs("google"), ["models", "set", "google/gemini-3.1-pro-preview"]);
  const file = await tempConfig({ make: true });
  let ran = 0;
  await assert.rejects(
    addOpenClawProvider({ provider: "evil", key: KEY }, { run: async () => ran++, save: async () => ran++, env, platform: "darwin", file }),
    (e) => e.status === 400 && (noKey(e), true),
  );
  await assert.rejects(
    addOpenClawProvider({ provider: "openai", key: KEY, setDefault: "yes" }, { run: async () => ran++, save: async () => ran++, env, platform: "darwin", file }),
    (e) => e.status === 400,
  );
  assert.equal(ran, 0);
});

test("setup runs openclaw through the login shell, the key in its environment only", async () => {
  const file = await tempConfig();
  const calls = [];
  let auth = 0;
  const done = await onboardOpenClaw(
    { provider: "openrouter", key: KEY, acceptRisk: true },
    { run: async (...a) => (calls.push(a), { stdout: KEY }), env, platform: "darwin", file, authorize: () => auth++ },
  );
  assert.deepEqual(done, { done: true, provider: "openrouter" });
  noKey(done);
  assert.equal(calls.length, 1);
  const [shell, argv, options] = calls[0];
  assert.equal(shell, "/bin/zsh");
  assert.deepEqual(argv.slice(0, 3), ["-lc", 'export OPENROUTER_API_KEY="$REACH_PROVIDER_KEY"; unset REACH_PROVIDER_KEY; exec openclaw "$@"', "openclaw"]);
  assert.deepEqual(argv.slice(3), onboardArgs("openrouter"));
  // No argv (shown by `ps` to everyone) carries the key: the child's env does.
  assert.doesNotMatch(argv.join(" "), /SECRETKEY/);
  assert.equal(options.env.REACH_PROVIDER_KEY, KEY);
  assert.ok(options.timeout >= 60000);
  assert.ok(auth >= 2, "live authorization before validating and before running");
});

test("setup never runs without accepting the risk, over an existing config or on Windows", async () => {
  const run = async () => assert.fail("must not run");
  // OpenClaw's --accept-risk only with the owner's own yes.
  for (const acceptRisk of [undefined, false, "true", 1])
    await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk }, { run, env, platform: "darwin", file: await tempConfig() }), (e) => e.status === 400 && /risk/.test(e.message));
  const existing = await tempConfig({ make: true });
  await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run, env, platform: "darwin", file: existing }), (e) => e.status === 409 && /already set up/.test(e.message));
  await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run, env, platform: "win32", file: await tempConfig() }), (e) => e.status === 409);
  // A revoked device stops it before anything runs.
  await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run, env, platform: "darwin", file: await tempConfig(), authorize: () => { throw Object.assign(new Error("Revoked"), { status: 401 }); } }), (e) => e.status === 401);
});

test("a failing OpenClaw never carries the key back", async () => {
  const logged = [];
  const original = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(original)) console[k] = (...a) => logged.push(a.join(" "));
  try {
    await assert.rejects(
      onboardOpenClaw({ provider: "openrouter", key: KEY, acceptRisk: true }, { run: async (_s, argv) => { throw leaky(argv); }, env, platform: "darwin", file: await tempConfig() }),
      (e) => {
        assert.equal(e.status, 409);
        assert.equal(e.message, "OpenClaw didn't finish setting up. Check the key and try again.");
        assert.equal(e.cause, undefined);
        noKey(e);
        return true;
      },
    );
    const file = await tempConfig({ make: true });
    await assert.rejects(
      addOpenClawProvider({ provider: "openrouter", key: KEY }, { save: async (p, key) => { throw leaky([p, key]); }, env, platform: "darwin", file }),
      (e) => e.status === 409 && e.message === "OpenClaw didn't take this key. Try again." && (noKey(e), true),
    );
    await assert.rejects(
      addOpenClawProvider({ provider: "openai", key: KEY, setDefault: true }, { save: async () => {}, run: async (_s, argv) => { if (argv.includes("models")) throw leaky([...argv, KEY]); }, env, platform: "darwin", file }),
      (e) => e.status === 409 && /default model/.test(e.message) && (noKey(e), true),
    );
  } finally {
    Object.assign(console, original);
  }
  assert.doesNotMatch(logged.join("\n"), /SECRETKEY/);
});

test("adding a key writes onboard's api_key profile and marks it in the config", async () => {
  const file = await tempConfig({ make: true });
  const store = await tempStore();
  const ran = [];
  const added = await addOpenClawProvider(
    { provider: "anthropic", key: ` ${KEY} `, setDefault: true },
    { run: async (...a) => ran.push(a), env, platform: "darwin", file, store },
  );
  assert.deepEqual(added, { added: true, provider: "anthropic", default: true });
  noKey(added);
  const saved = JSON.parse(await fs.readFile(store, "utf8"));
  assert.deepEqual(saved, { version: 1, profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: KEY } } });
  assert.equal((await fs.stat(store)).mode & 0o777, 0o600);
  // Fixed argv, no key: config marks it api_key, then the default model.
  assert.deepEqual(ran.map((c) => c[1].slice(3)), [profileArgs("anthropic"), ["models", "set", "anthropic/claude-opus-4-6"]]);
  assert.ok(!ran.some((c) => c[1].join(" ").includes("SECRETKEY")));
  // Already marked: no config write; no default unless asked.
  await fs.writeFile(file, JSON.stringify({ auth: { profiles: { "google:default": { provider: "google", mode: "api_key" } } } }));
  const plain = await addOpenClawProvider({ provider: "google", key: KEY }, { run: async () => assert.fail("must not run"), env, platform: "darwin", file, store });
  assert.equal(plain.default, false);
  // Without a setup there's no profile to add to.
  await assert.rejects(addOpenClawProvider({ provider: "openai", key: KEY }, { save: async () => assert.fail(), env, platform: "darwin", file: await tempConfig() }), (e) => e.status === 409 && /Set up OpenClaw first/.test(e.message));
});

test("saveApiKey replaces only its profile, keeps the rest, under OpenClaw's lock", async () => {
  const before = {
    version: 1,
    profiles: {
      "openrouter:default": { type: "token", provider: "openrouter", token: "Symbol(clack:cancel)" },
      "openai:default": { type: "api_key", provider: "openai", key: "other-key-123" },
    },
    order: { openai: ["openai:default"] },
    lastGood: { openai: "openai:default" },
    usageStats: { "openai:default": { lastUsed: 5 } },
  };
  const store = await tempStore(before);
  await saveApiKey("openrouter", KEY, { file: store });
  const after = JSON.parse(await fs.readFile(store, "utf8"));
  assert.deepEqual(after, { ...before, profiles: { ...before.profiles, "openrouter:default": { type: "api_key", provider: "openrouter", key: KEY } } });
  const left = await fs.readdir(path.dirname(store));
  assert.deepEqual(left, ["auth-profiles.json"], "no lock or temp file left");
  // Waits for a live lock held by OpenClaw, then writes.
  const lock = `${await fs.realpath(store)}.lock`;
  await fs.writeFile(lock, JSON.stringify({ pid: 1, createdAt: new Date().toISOString() }));
  const saving = saveApiKey("google", KEY, { file: store });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(JSON.parse(await fs.readFile(store, "utf8")).profiles["google:default"], undefined);
  await fs.rm(lock);
  await saving;
  assert.equal(JSON.parse(await fs.readFile(store, "utf8")).profiles["google:default"].key, KEY);
  // A stale lock (over 30 s) is taken over, as OpenClaw does.
  await fs.writeFile(lock, JSON.stringify({ pid: 1, createdAt: new Date(Date.now() - 60000).toISOString() }));
  await saveApiKey("openai", KEY, { file: store });
  // Never over a store it can't read.
  await fs.writeFile(store, "{ not json");
  await assert.rejects(saveApiKey("openai", KEY, { file: store }), (e) => (noKey(e), true));
  assert.equal(await fs.readFile(store, "utf8"), "{ not json");
  assert.throws(() => profileArgs("evil"));
  await assert.rejects(saveApiKey("__proto__", KEY, { file: store }), (e) => e.status === 400);
});

test("the key store is where OpenClaw looks", () => {
  assert.equal(authStoreFile({ env: {}, home: "/h" }), "/h/.openclaw/agents/main/agent/auth-profiles.json");
  assert.equal(authStoreFile({ env: { OPENCLAW_STATE_DIR: "/s" }, home: "/h" }), "/s/agents/main/agent/auth-profiles.json");
  assert.equal(authStoreFile({ env: { OPENCLAW_AGENT_DIR: "~/a", OPENCLAW_STATE_DIR: "/s" }, home: "/h" }), "/h/a/auth-profiles.json");
  assert.equal(authStoreFile({ env: { PI_CODING_AGENT_DIR: "/p" }, home: "/h" }), "/p/auth-profiles.json");
});

test("status reports install and setup; config path as OpenClaw's", async () => {
  assert.equal(configFile({ env: {}, home: "/h" }), "/h/.openclaw/openclaw.json");
  assert.equal(configFile({ env: { OPENCLAW_STATE_DIR: "/s" }, home: "/h" }), "/s/openclaw.json");
  assert.equal(configFile({ env: { OPENCLAW_CONFIG_PATH: "/c.json", OPENCLAW_STATE_DIR: "/s" } }), "/c.json");
  const file = await tempConfig();
  assert.deepEqual(await onboardStatus({ has: async (n) => n === "openclaw", file, platform: "darwin" }), {
    installed: true, configured: false, supported: true, providers: ["openrouter", "anthropic", "openai", "google"],
  });
  const s = await onboardStatus({ has: async () => true, file: await tempConfig({ make: true }), platform: "win32" });
  assert.equal(s.configured, true);
  assert.equal(s.supported, false);
  assert.deepEqual(s.providers, Object.keys(PROVIDERS));
});

test("OpenClaw's own installer, via the agent-install route", async () => {
  const options = (tools) => ({ platform: "darwin", has: async (tool) => tools.includes(tool) });
  assert.deepEqual(await installPlan("openclaw", options(["npm"])), { agent: "openclaw", name: "OpenClaw", command: "npm install -g openclaw@latest" });
  const script = await installPlan("openclaw", options([]));
  assert.match(script.command, /^curl -fsSL --proto '=https' --tlsv1\.2 https:\/\/openclaw\.ai\/install\.sh \| bash -s -- --no-prompt --no-onboard$/);
  await assert.rejects(installPlan("openclaw", { platform: "win32", has: async () => true }), (e) => e.status === 400);
});

test("routes pass only the fields they know, with live authorization", async () => {
  const handlers = {};
  const app = { get: (r, fn) => (handlers["GET " + r] = fn), post: (r, fn) => (handlers["POST " + r] = fn) };
  const seen = [];
  routes(app, {}, { base, authorize: (req) => () => req.reauthorize() }, {
    status: async () => ({ installed: true }),
    onboard: async (body, opts) => (opts.authorize(), seen.push(["onboard", body]), { done: true }),
    addProvider: async (body, opts) => (opts.authorize(), seen.push(["add", body]), { added: true }),
  });
  let auth = 0;
  const call = async (key, body) => {
    let out;
    await handlers[key]({ body, reauthorize: () => auth++ }, { json: (v) => (out = v) });
    return out;
  };
  assert.deepEqual(await call(`GET ${base}/onboard/status`), { installed: true });
  await call(`POST ${base}/onboard`, { provider: "openai", key: KEY, acceptRisk: true, extra: "--reset" });
  await call(`POST ${base}/providers/add`, { provider: "openai", key: KEY, setDefault: true, profile: "x" });
  assert.deepEqual(seen, [
    ["onboard", { provider: "openai", key: KEY, acceptRisk: true }],
    ["add", { provider: "openai", key: KEY, setDefault: true }],
  ]);
  assert.equal(auth, 2);
});

test("ClawOnboard: install row, then provider pills and a write-only key", async () => {
  const sent = [];
  let status = { installed: false, configured: false, supported: true, providers: ["openrouter", "anthropic", "openai", "google"] };
  const dom = await startDom({
    routes: {
      [base + "/onboard/status"]: () => status,
      "/api/sessions/agent-install/openclaw": (init) => {
        const body = JSON.parse(init.body);
        sent.push(["install", body]);
        return { agent: "openclaw", name: "OpenClaw", command: "npm install -g openclaw@latest", ...(body.confirm ? { terminal: { id: "t1", status: "running" } } : {}) };
      },
      "/api/terminals": () => [{ id: "t1", status: "exited", exitCode: 0 }],
      [base + "/onboard"]: (init) => (sent.push(["onboard", JSON.parse(init.body)]), { done: true }),
      [base + "/gateway/start"]: () => (sent.push(["start"]), { connected: true }),
      [base + "/providers/add"]: (init) => (sent.push(["add", JSON.parse(init.body)]), { added: true }),
    },
  });
  try {
    const { ClawOnboard, ClawAddProvider } = await dom.load("/src/OpenClawOnboard.tsx");
    const peer = { id: "p", url: "https://reach.test", token: "t", platform: "darwin" };
    let done = 0;
    const view = await dom.render(dom.React.createElement(ClawOnboard, { peer, onDone: () => done++ }));
    const doc = dom.document;
    const btn = (label) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    await dom.waitFor(() => btn("Install"));
    btn("Install").click();
    // The command shows first; nothing runs until confirmed.
    await dom.waitFor(() => doc.querySelector(".claw-onboard-command"));
    assert.equal(doc.querySelector(".claw-onboard-command").textContent, "npm install -g openclaw@latest");
    assert.deepEqual(sent, [["install", { confirm: false }]]);
    status = { ...status, installed: true };
    btn("Run on Mac").click();
    await dom.waitFor(() => sent.length === 2);
    assert.deepEqual(sent[1], ["install", { confirm: true }]);
    await dom.waitFor(() => btn("Accept risk & set up"), 5000);
    assert.match(doc.querySelector(".claw-onboard-note").textContent, /OpenClaw can run commands on this Mac/);
    assert.deepEqual([...doc.querySelectorAll('[role="radio"]')].map((b) => b.textContent), ["OpenRouter", "Anthropic", "OpenAI", "Google"]);
    const field = doc.querySelector('[aria-label="OpenRouter API key"]');
    assert.equal(field.type, "password");
    assert.equal(field.getAttribute("autocomplete"), "off");
    assert.ok(btn("Accept risk & set up").disabled);
    await typeInto(field, KEY);
    field.closest("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => done === 1);
    assert.deepEqual(sent.slice(2), [["onboard", { provider: "openrouter", key: KEY, acceptRisk: true }], ["start"]]);
    assert.doesNotMatch(doc.body.textContent, /SECRETKEY/);
    await view.unmount();

    // Add a key on an existing install, as the default.
    const add = await dom.render(dom.React.createElement(ClawAddProvider, { peer, provider: "anthropic", onDone: () => done++ }));
    await dom.waitFor(() => doc.querySelector('[aria-label="Anthropic API key"]'));
    doc.querySelector('[role="switch"]').click();
    await settle();
    const keyField = doc.querySelector('[aria-label="Anthropic API key"]');
    await typeInto(keyField, KEY);
    keyField.closest("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => btn("Done"));
    assert.deepEqual(sent.at(-1), ["add", { provider: "anthropic", key: KEY, setDefault: true }]);
    assert.doesNotMatch(doc.body.textContent, /SECRETKEY/);
    await add.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    await dom.close();
  }
});
