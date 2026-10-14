import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  routes,
  onboardArgs,
  pasteArgs,
  listArgs,
  saveApiKey,
  defaultArgs,
  onboardStatus,
  onboardOpenClaw,
  onboardSettled,
  onboardSetup,
  SETUP_ERRORS,
  addOpenClawProvider,
  configFile,
  PROVIDERS,
} from "../server/openclaw-onboard.mjs";
import { installPlan } from "../server/agent-install.mjs";
import { openClawShell, loginShell } from "../server/openclaw-run.mjs";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

const base = "/api/sessions/openclaw";
const KEY = "sk-or-v1-SECRETKEY0123456789";
const env = { SHELL: "/bin/zsh" };
// Homebrew's node@24, as availableUpdateRuntime finds it (a fake path).
const runtime = "/brew/opt/node@24/bin/node";
const LEAD = `export PATH='/brew/opt/node@24/bin:/brew/bin':"$PATH"`;
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
    assert.equal(PROVIDERS[p].envVar, envVar);
  }
  assert.ok(!args.some((x) => /0\.0\.0\.0|^lan$|^auto$|^custom$|tailnet|funnel|serve|--reset|--json|--gateway-token|--remote/.test(x)));
  assert.equal(args[args.indexOf("--gateway-bind") + 1], "loopback");
});

test("every openclaw run: node@24 first, exec, a POSIX login shell, secrets never in argv", async () => {
  const [shell, argv] = await openClawShell(["models", "set", "x"], { env, platform: "darwin", runtime, secret: "OPENAI_API_KEY" });
  assert.equal(shell, "/bin/zsh");
  assert.deepEqual(argv, ["-lc", `${LEAD}; export OPENAI_API_KEY="$REACH_SECRET"; unset REACH_SECRET; exec openclaw "$@"`, "openclaw", "models", "set", "x"]);
  // No node@24: the owner's PATH as it is.
  const [, plain] = await openClawShell(["status"], { env, platform: "darwin", findRuntime: async () => null });
  assert.equal(plain[1], 'exec openclaw "$@"');
  // fish and nu have no "$@": zsh on a Mac, sh elsewhere.
  assert.equal(loginShell({ SHELL: "/opt/homebrew/bin/fish" }, "darwin"), "/bin/zsh");
  assert.equal(loginShell({ SHELL: "/usr/bin/nu" }, "linux"), "/bin/sh");
  assert.equal(loginShell({ SHELL: "/bin/bash" }, "linux"), "/bin/bash");
  await assert.rejects(openClawShell([], { env, runtime, secret: "X; rm -rf ~" }));
});

test("only allowlisted providers, only key-shaped keys", async () => {
  for (const p of ["ollama", "vllm", "custom-api-key", "__proto__", "constructor", "toString", "", undefined, 1, ["openai"]])
    assert.throws(() => onboardArgs(p), (e) => e.status === 400 && /Choose/.test(e.message));
  for (const k of ["", "short", "has space inside", "line\nbreak12345", "x".repeat(4097), 12345678, undefined])
    await assert.rejects(
      onboardOpenClaw({ provider: "openai", key: k, acceptRisk: true }, { run: async () => assert.fail("must not run"), env, platform: "darwin", file: await tempConfig() }),
      (e) => e.status === 400 && e.message === "Paste the API key.",
    );
  assert.throws(() => pasteArgs("__proto__"), (e) => e.status === 400);
  assert.deepEqual(pasteArgs("anthropic", "main"), ["models", "auth", "paste-api-key", "--agent", "main", "--provider", "anthropic", "--profile-id", "anthropic:default"]);
  assert.deepEqual(listArgs("google", "main"), ["models", "auth", "list", "--agent", "main", "--json", "--provider", "google"]);
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
    { run: async (...a) => (calls.push(a), { stdout: KEY }), env, platform: "darwin", file, runtime, authorize: () => auth++ },
  );
  assert.deepEqual(done, { started: true, provider: "openrouter" });
  await onboardSettled();
  assert.deepEqual(onboardSetup(), { state: "done", provider: "openrouter" });
  noKey(done);
  assert.equal(calls.length, 1);
  const [shell, argv, options] = calls[0];
  assert.equal(shell, "/bin/zsh");
  assert.deepEqual(argv.slice(0, 3), ["-lc", `${LEAD}; export OPENROUTER_API_KEY="$REACH_SECRET"; unset REACH_SECRET; exec openclaw "$@"`, "openclaw"]);
  assert.deepEqual(argv.slice(3), onboardArgs("openrouter"));
  // No argv (shown by `ps` to everyone) carries the key: the child's env does.
  assert.doesNotMatch(argv.join(" "), /SECRETKEY/);
  assert.equal(options.env.REACH_SECRET, KEY);
  assert.ok(options.timeout >= 60000);
  assert.ok(auth >= 2, "live authorization before validating and before running");
});

test("setup never runs without accepting the risk or over an existing config", async () => {
  const run = async () => assert.fail("must not run");
  // OpenClaw's --accept-risk only with the owner's own yes.
  for (const acceptRisk of [undefined, false, "true", 1])
    await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk }, { run, env, platform: "darwin", file: await tempConfig() }), (e) => e.status === 400 && /risk/.test(e.message));
  const existing = await tempConfig({ make: true });
  await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run, env, platform: "darwin", file: existing }), (e) => e.status === 409 && /already set up/.test(e.message));
  // A revoked device stops it before anything runs.
  await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run, env, platform: "darwin", file: await tempConfig(), authorize: () => { throw Object.assign(new Error("Revoked"), { status: 401 }); } }), (e) => e.status === 401);
});

test("a failing OpenClaw never carries the key back", async () => {
  const logged = [];
  const original = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(original)) console[k] = (...a) => logged.push(a.join(" "));
  try {
    await onboardOpenClaw({ provider: "openrouter", key: KEY, acceptRisk: true }, { run: async (_s, argv) => { throw leaky(argv); }, env, platform: "darwin", file: await tempConfig(), runtime });
    await onboardSettled();
    assert.deepEqual(onboardSetup(), { state: "failed", provider: "openrouter", error: "OpenClaw didn't finish setting up. Check the key and try again." });
    noKey(onboardSetup());
    const file = await tempConfig({ make: true });
    await assert.rejects(
      addOpenClawProvider({ provider: "openrouter", key: KEY }, { save: async (p, key) => { throw leaky([p, key]); }, env, platform: "darwin", file }),
      (e) => e.status === 409 && e.message === "OpenClaw didn't take this key. Try again." && (noKey(e), true),
    );
    await assert.rejects(
      addOpenClawProvider({ provider: "openai", key: KEY, setDefault: true }, { save: async () => {}, run: async (_s, argv) => { if (argv.includes("models")) throw leaky([...argv, KEY]); }, env, platform: "darwin", file, runtime }),
      (e) => e.status === 409 && /default model/.test(e.message) && (noKey(e), true),
    );
  } finally {
    Object.assign(console, original);
  }
  assert.doesNotMatch(logged.join("\n"), /SECRETKEY/);
});

test("adding a key: OpenClaw's own paste-api-key, the key on stdin, then read back from its list", async () => {
  const piped = [];
  const ran = [];
  const listing = (profiles) => async (...a) => (ran.push(a), {
    stdout: JSON.stringify(a[1].includes("agents") ? [{ id: "sk-proj-x" }, { id: "main", isDefault: true }] : { agentId: "main", profiles }),
  });
  const pipe = async (...a) => piped.push(a);
  await saveApiKey("anthropic", KEY, { pipe, run: listing([{ id: "anthropic:default", provider: "anthropic", type: "api_key" }]), env, platform: "darwin", runtime });
  assert.equal(piped.length, 1);
  const [shell, argv, options] = piped[0];
  assert.equal(shell, "/bin/zsh");
  assert.deepEqual(argv.slice(3), pasteArgs("anthropic", "main"));
  assert.equal(argv[argv.indexOf("--agent") + 1], "main");
  assert.equal(options.input, `${KEY}\n`);
  assert.doesNotMatch(argv.join(" "), /SECRETKEY/);
  assert.equal(options.env.REACH_SECRET, undefined);
  assert.deepEqual(ran.map((c) => c[1].slice(3)), [["agents", "list", "--json"], listArgs("anthropic", "main")]);
  // No default agent named: nothing pasted.
  const before = piped.length;
  await assert.rejects(saveApiKey("anthropic", KEY, { pipe, run: async () => ({ stdout: "[]" }), env, platform: "darwin", runtime }));
  assert.equal(piped.length, before);
  // Not in OpenClaw's list, another type, or a list it can't read: not saved.
  for (const profiles of [[], [{ id: "anthropic:default", provider: "anthropic", type: "token" }], [{ id: "anthropic:manual", provider: "anthropic", type: "api_key" }]])
    await assert.rejects(saveApiKey("anthropic", KEY, { pipe, run: listing(profiles), env, platform: "darwin", runtime }), (e) => (noKey(e), true));
  await assert.rejects(saveApiKey("anthropic", KEY, { pipe, run: async () => ({ stdout: "not json" }), env, platform: "darwin", runtime }), (e) => (noKey(e), true));
  await assert.rejects(saveApiKey("__proto__", KEY, { pipe, run: listing([]) }), (e) => e.status === 400);
  // Through the route's function: the key reaches save, then the default model.
  const file = await tempConfig({ make: true });
  const saved = [];
  const models = [];
  const added = await addOpenClawProvider(
    { provider: "anthropic", key: ` ${KEY} `, setDefault: true },
    { save: async (p, k) => saved.push([p, k]), run: async (...a) => models.push(a), env, platform: "darwin", file, runtime },
  );
  assert.deepEqual(added, { added: true, provider: "anthropic", default: true });
  noKey(added);
  assert.deepEqual(saved, [["anthropic", KEY]]);
  assert.deepEqual(models.map((c) => c[1].slice(3)), [["models", "set", "anthropic/claude-opus-5-5"]]);
  const plain = await addOpenClawProvider({ provider: "google", key: KEY }, { save: async () => {}, run: async () => assert.fail("must not run"), env, platform: "darwin", file });
  assert.equal(plain.default, false);
  // Without a setup there's no profile to add to.
  await assert.rejects(addOpenClawProvider({ provider: "openai", key: KEY }, { save: async () => assert.fail(), env, platform: "darwin", file: await tempConfig() }), (e) => e.status === 409 && /Set up OpenClaw first/.test(e.message));
});

test("status reports install and setup; config path as OpenClaw's", async () => {
  // As this computer writes paths (backslashes on Windows).
  assert.equal(configFile({ env: {}, home: "/h" }), path.join("/h", ".openclaw", "openclaw.json"));
  assert.equal(configFile({ env: { OPENCLAW_STATE_DIR: "/s" }, home: "/h" }), path.join("/s", "openclaw.json"));
  assert.equal(configFile({ env: { OPENCLAW_CONFIG_PATH: "/c.json", OPENCLAW_STATE_DIR: "/s" } }), "/c.json");
  const file = await tempConfig();
  const { setup: _last, ...fresh } = await onboardStatus({ has: async (n) => n === "openclaw", file, platform: "darwin" });
  assert.deepEqual(fresh, {
    installed: true, configured: false, supported: true, providers: ["openrouter", "anthropic", "openai", "google"],
  });
  // Windows too, natively, as on a Mac (docs/WINDOWS_AGENT_PARITY.md).
  const s = await onboardStatus({ has: async () => true, file: await tempConfig({ make: true }), platform: "win32" });
  assert.equal(s.configured, true);
  assert.equal(s.supported, true);
  assert.deepEqual(s.providers, Object.keys(PROVIDERS));
});

test("OpenClaw's own installer, via the agent-install route", async () => {
  const options = (tools) => ({ platform: "darwin", has: async (tool) => tools.includes(tool), findRuntime: async () => null });
  assert.deepEqual(await installPlan("openclaw", options(["npm"])), { agent: "openclaw", name: "OpenClaw", command: "npm install -g openclaw@latest" });
  const script = await installPlan("openclaw", options([]));
  assert.match(script.command, /^curl -fsSL --proto '=https' --tlsv1\.2 https:\/\/openclaw\.ai\/install\.sh \| bash -s -- --no-prompt --no-onboard$/);
  // Windows: its PowerShell installer (windows-openclaw.test.mjs).
  assert.match((await installPlan("openclaw", { platform: "win32", has: async () => true, node: async () => ({ version: "24.16.0", supported: true }) })).command, /install\.ps1\)\)\) -NoOnboard$/);
});

// "Check the key" was every failure's answer. Each cause now has Reach's
// own words, and OpenClaw's output (which can carry the key) never shows.
test("a failed setup names its cause: missing command, Node, partial setup, timeout", async () => {
  const fails = (extra) => async (_s, argv) => { throw Object.assign(leaky(argv), extra); };
  const cases = [
    [{ code: 127 }, false, "failed", SETUP_ERRORS.missing],
    [{ code: 1, stderr: `Node 22.12.0 is unsupported; OpenClaw requires >=24.16.0 <25 || >=26. ${KEY}` }, false, "failed", SETUP_ERRORS.node],
    [{ code: 1 }, true, "partial", SETUP_ERRORS.partial],
    [{ killed: true, signal: "SIGTERM", code: null }, false, "failed", SETUP_ERRORS.timeout],
    [{ code: 1 }, false, "failed", SETUP_ERRORS.failed],
  ];
  for (const [extra, writesConfig, state, error] of cases) {
    const file = await tempConfig();
    const run = async (shell, argv, options) => {
      if (writesConfig) await fs.writeFile(file, "{}"); // config first, then the daemon failed
      return fails(extra)(shell, argv, options);
    };
    await onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run, env, platform: "darwin", file, runtime });
    await onboardSettled();
    assert.deepEqual(onboardSetup(), { state, provider: "openai", error });
    noKey(onboardSetup());
  }
});

test("setup outlasts the phone's request: busy until OpenClaw exits, then polled", async () => {
  let exit;
  const file = await tempConfig();
  const started = await onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, {
    run: () => new Promise((resolve) => { exit = resolve; }), env, platform: "darwin", file, runtime,
  });
  assert.deepEqual(started, { started: true, provider: "openai" });
  assert.deepEqual(onboardSetup(), { state: "running", provider: "openai" });
  assert.equal((await onboardStatus({ has: async () => true, file, platform: "darwin" })).setup.state, "running");
  // No second setup and no Add key while it runs.
  await assert.rejects(onboardOpenClaw({ provider: "openai", key: KEY, acceptRisk: true }, { run: async () => assert.fail("must not run"), env, platform: "darwin", file: await tempConfig() }), (e) => e.status === 409 && /being set up/.test(e.message));
  await assert.rejects(addOpenClawProvider({ provider: "openai", key: KEY }, { save: async () => assert.fail("must not run"), env, platform: "darwin", file: await tempConfig({ make: true }) }), (e) => e.status === 409 && /being set up/.test(e.message));
  exit({ stdout: "" });
  await onboardSettled();
  assert.deepEqual(onboardSetup(), { state: "done", provider: "openai" });
  // Free again.
  await addOpenClawProvider({ provider: "openai", key: KEY }, { save: async () => {}, env, platform: "darwin", file: await tempConfig({ make: true }) });
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
      // OpenClaw writes its config early: configured while it still runs.
      [base + "/onboard/status"]: () => {
        const now = status;
        if (status.setup?.state === "running") status = { ...status, setup: { ...status.setup, state: "done" } };
        return now;
      },
      "/api/sessions/agent-install/openclaw": (init) => {
        const body = JSON.parse(init.body);
        sent.push(["install", body]);
        return { agent: "openclaw", name: "OpenClaw", command: "npm install -g openclaw@latest", ...(body.confirm ? { terminal: { id: "t1", status: "running" } } : {}) };
      },
      "/api/terminals": () => [{ id: "t1", status: "exited", exitCode: 0 }],
      [base + "/onboard"]: (init) => {
        sent.push(["onboard", JSON.parse(init.body)]);
        status = { ...status, configured: true, setup: { state: "running", provider: "openrouter" } };
        return { started: true, provider: "openrouter" };
      },
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
    await dom.waitFor(() => done === 1, 6000);
    // The Gateway starts only once the setup has ended.
    assert.deepEqual(sent.slice(2), [["onboard", { provider: "openrouter", key: KEY, acceptRisk: true }], ["start"]]);
    assert.equal(status.setup.state, "done");
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

// The same on a Windows PC (owner, Oct 13: natively, as on a Mac): its own
// installer, what Reach adds first said before Run, then the key form.
test("ClawOnboard on a Windows PC: OpenClaw's installer, the Node it adds said first, then the key form; no Mac", async () => {
  const sent = [];
  let status = { installed: false, configured: false, supported: true, providers: ["openrouter", "anthropic", "openai", "google"] };
  const plan = {
    agent: "openclaw",
    name: "OpenClaw",
    command: "& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard",
    note: "OpenClaw needs Node 24.16 or newer, and this PC has Node 22.12.0. Reach adds a Node for OpenClaw only first, with OpenClaw's own installer, and keeps this PC's Node as it is.",
  };
  const dom = await startDom({
    routes: {
      [base + "/onboard/status"]: () => status,
      "/api/sessions/agent-install/openclaw": (init) => {
        const body = JSON.parse(init.body);
        sent.push(["install", body]);
        return { ...plan, ...(body.confirm ? { terminal: { id: "t1", status: "running" } } : {}) };
      },
      "/api/terminals": () => [{ id: "t1", status: "exited", exitCode: 0 }],
    },
  });
  try {
    const { ClawOnboard } = await dom.load("/src/OpenClawOnboard.tsx");
    const peer = { id: "pc", url: "https://reach.test", token: "t", platform: "win32" };
    const view = await dom.render(dom.React.createElement(ClawOnboard, { peer, onDone: () => {} }));
    const doc = dom.document;
    const btn = (label) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
    await dom.waitFor(() => btn("Install"));
    btn("Install").click();
    await dom.waitFor(() => doc.querySelector(".claw-onboard-command"));
    assert.equal(doc.querySelector(".claw-onboard-command").textContent, plan.command);
    assert.equal(doc.querySelector(".claw-onboard-note").textContent, plan.note);
    status = { ...status, installed: true };
    btn("Run on Windows PC").click();
    await dom.waitFor(() => sent.length === 2);
    assert.deepEqual(sent[1], ["install", { confirm: true }]);
    await dom.waitFor(() => btn("Accept risk & set up"), 5000);
    assert.match(doc.querySelector(".claw-onboard-note").textContent, /OpenClaw can run commands on this Windows PC/);
    assert.doesNotMatch(doc.body.textContent, /\bMac\b|macOS/);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    await dom.close();
  }
});

// Opened again mid-setup (config already written): a spinner, not nothing.
// Its Gateway service didn't install and Start fails: say so in Reach's words.
test("ClawOnboard reopened while setting up: waits, then names a partial setup", async () => {
  const sent = [];
  let status = { installed: true, configured: true, supported: true, providers: ["openai"], setup: { state: "running", provider: "openai" } };
  const dom = await startDom({
    routes: {
      [base + "/onboard/status"]: () => {
        const now = status;
        status = { ...status, setup: { state: "partial", provider: "openai", error: SETUP_ERRORS.partial } };
        return now;
      },
      [base + "/gateway/start"]: () => (sent.push("start"), new Response(JSON.stringify({ error: "OpenClaw’s Gateway didn’t start." }), { status: 503, headers: { "Content-Type": "application/json" } })),
    },
  });
  try {
    const { ClawOnboard } = await dom.load("/src/OpenClawOnboard.tsx");
    const peer = { id: "p", url: "https://reach.test", token: "t", platform: "darwin" };
    let done = 0;
    const view = await dom.render(dom.React.createElement(ClawOnboard, { peer, onDone: () => done++ }));
    const doc = dom.document;
    await dom.waitFor(() => /Setting up OpenClaw/.test(doc.body.textContent));
    await dom.waitFor(() => doc.querySelector('[role="alert"]'), 6000);
    assert.deepEqual(sent, ["start"]);
    assert.equal(doc.querySelector('[role="alert"]').textContent, SETUP_ERRORS.partial);
    assert.equal(done, 0);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    await dom.close();
  }
});

// A bad key (the usual failure) keeps the form with its reason: no Start,
// and the parent isn't told it's done.
test("ClawOnboard: a failed setup shows why and isn't done", async () => {
  const sent = [];
  let status = { installed: true, configured: false, supported: true, providers: ["openai"] };
  const dom = await startDom({
    routes: {
      [base + "/onboard/status"]: () => {
        const now = status;
        if (status.setup?.state === "running") status = { ...status, setup: { state: "failed", provider: "openai", error: SETUP_ERRORS.failed } };
        return now;
      },
      [base + "/onboard"]: () => ((status = { ...status, setup: { state: "running", provider: "openai" } }), { started: true, provider: "openai" }),
      [base + "/gateway/start"]: () => (sent.push("start"), { connected: true }),
    },
  });
  try {
    const { ClawOnboard } = await dom.load("/src/OpenClawOnboard.tsx");
    const peer = { id: "p", url: "https://reach.test", token: "t", platform: "darwin" };
    let done = 0;
    const view = await dom.render(dom.React.createElement(ClawOnboard, { peer, onDone: () => done++ }));
    const doc = dom.document;
    await dom.waitFor(() => doc.querySelector('[aria-label="OpenAI API key"]'));
    const field = doc.querySelector('[aria-label="OpenAI API key"]');
    await typeInto(field, KEY);
    field.closest("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await dom.waitFor(() => doc.querySelector('[role="alert"]'), 6000);
    assert.equal(doc.querySelector('[role="alert"]').textContent, SETUP_ERRORS.failed);
    assert.equal(done, 0);
    assert.deepEqual(sent, []);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    await dom.close();
  }
});
