// OpenClaw feature: onboard. Routes under /api/sessions/openclaw (see
// openClawRoutes in openclaw.mjs). client: createOpenClaw()'s api (call,
// can, onEvent, redact). ctx: { base, authorize, dataDir, openSetup, openCommand }.
//
// OpenClaw 2026.3.13, from the phone:
// - Set up: `openclaw onboard --non-interactive --accept-risk …` (its own
//   wizard, no prompts), only while there's no config: on an existing one it
//   would rotate the Gateway token and reset Tailscale. Gateway on loopback,
//   token auth, always.
// - Add a key: `openclaw models auth paste-api-key --provider X
//   --profile-id X:default`, the key on its stdin (it reads a pipe when
//   there's no terminal). OpenClaw 2026.9 keeps keys in its own database and
//   ignores the old auth-profiles.json, so Reach never writes a store itself.
//   Then `openclaw models auth list --json` must show X:default as api_key.
// - Default model: `openclaw models set <ref>`, OpenClaw's own onboard ref.
// Keys go to OpenClaw only: its env or its own store, never argv, shell
// text, a log or a response. Errors are Reach's fixed words.
// The same on Windows, where OpenClaw runs natively (openclaw-windows.mjs).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasCommand } from "./agent-install.mjs";
import { openClawShell, runOpenClaw, secretEnv } from "./openclaw-run.mjs";
import { findOpenClaw, killTree, typedCli } from "./openclaw-windows.mjs";
import { computerWord } from "./computer-word.mjs";
import { hubGateway, withoutWslNotes } from "./openclaw-hub.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
// Same shape as channel tokens (addOpenClawChannel).
const KEY_SHAPE = /^[\x21-\x7e]{8,4096}$/;
export const GATEWAY_PORT = 18789;

// The providers a phone can pick; nothing else reaches OpenClaw.
export const PROVIDERS = {
  openrouter: { choice: "openrouter-api-key", envVar: "OPENROUTER_API_KEY", model: "openrouter/auto" },
  // OpenClaw 2026.9.9's own defaults for these providers.
  anthropic: { choice: "apiKey", envVar: "ANTHROPIC_API_KEY", model: "anthropic/claude-opus-5-5" },
  openai: { choice: "openai-api-key", envVar: "OPENAI_API_KEY", model: "openai/gpt-6-astra" },
  google: { choice: "gemini-api-key", envVar: "GEMINI_API_KEY", model: "google/gemini-3.1-pro-preview" },
};
// No Ollama: its non-interactive setup pulls a multi-GB model when none is
// there, far past a phone's request.
const pick = (provider) => {
  const found = typeof provider === "string" && Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null;
  if (!found) throw fail(400, "Choose OpenRouter, Anthropic, OpenAI or Google.");
  return found;
};
const checkKey = (key) => {
  if (typeof key !== "string" || !KEY_SHAPE.test(key.trim())) throw fail(400, "Paste the API key.");
  return key.trim();
};

// Where OpenClaw keeps its config (as localOpenClawConfig reads it).
export function configFile({ env = process.env, home = os.homedir() } = {}) {
  const state = env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  return env.REACH_OPENCLAW_CONFIG || env.OPENCLAW_CONFIG_PATH || path.join(state, "openclaw.json");
}
const exists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

// The fixed argv for a first setup. The key is not in it (argv shows in
// `ps` to everyone): OpenClaw reads it from the provider's env variable
// (openClawShell's secret). Never --json (its summary has the Gateway token), --reset,
// or a Gateway token.
export function onboardArgs(provider) {
  const found = pick(provider);
  return [
    "onboard", "--non-interactive", "--accept-risk", "--mode", "local",
    "--auth-choice", found.choice, "--secret-input-mode", "plaintext",
    "--gateway-port", String(GATEWAY_PORT),
    "--gateway-bind", "loopback",
    "--gateway-auth", "token",
    "--tailscale", "off",
    "--install-daemon",
    "--daemon-runtime", "node",
    "--skip-channels", "--skip-skills", "--skip-search", "--skip-ui",
    // Reach waits for the Gateway itself (gateway/start).
    "--skip-health",
  ];
}
// --agent: with more than one agent OpenClaw won't pick one itself.
const AGENT = /^[a-z0-9][\w-]{0,79}$/i;
export const pasteArgs = (provider, agent = "main") => {
  pick(provider);
  return ["models", "auth", "paste-api-key", "--agent", agent, "--provider", provider, "--profile-id", `${provider}:default`];
};
export const listArgs = (provider, agent = "main") => {
  pick(provider);
  return ["models", "auth", "list", "--agent", agent, "--json", "--provider", provider];
};
export const defaultArgs = (provider) => ["models", "set", pick(provider).model];

// One run with something on its stdin (execFile has no input), bounded in
// time and output; its output is never shown or logged.
// On Windows the whole process tree ends with it (runTree).
export function pipeRun(file, args, { input = "", timeout = 30000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const kill = () => (process.platform === "win32" ? killTree(child.pid) : child.kill("SIGKILL"));
    let done = false, size = 0;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => (kill(), finish(new Error("timeout"))), timeout);
    const count = (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) kill();
    };
    child.stdout.on("data", count);
    child.stderr.on("data", count);
    child.on("error", () => finish(new Error("start")));
    child.on("close", (code) => finish(code === 0 ? null : new Error("exit")));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// The key in OpenClaw's own store (on stdin), then read back from OpenClaw's
// list, which shows ids and types only, never keys. In OpenClaw's Windows
// app's distro the script comes first on stdin (openclaw-hub.mjs).
const scripted = (script) => (script === undefined ? {} : { input: script });
export async function saveApiKey(provider, key, { pipe = pipeRun, run = runOpenClaw, env = process.env, platform = process.platform, runtime, ...where } = {}) {
  pick(provider);
  // OpenClaw's default agent (the one onboard set up), by its own list.
  const [agentsFile, agents, agentsEnv = env, agentsScript] = await openClawShell(["agents", "list", "--json"], { env, platform, runtime, ...where });
  const roster = JSON.parse(withoutWslNotes((await run(agentsFile, agents, { timeout: 30000, maxBuffer: 1024 * 1024, env: agentsEnv, ...scripted(agentsScript) })).stdout) || "null");
  const agent = (Array.isArray(roster) ? roster : roster?.agents)?.find?.((a) => a?.isDefault === true)?.id;
  if (typeof agent !== "string" || !AGENT.test(agent)) throw new Error("no default agent");
  const [file, args, pasteEnv = env, pasteScript = ""] = await openClawShell(pasteArgs(provider, agent), { env, platform, runtime, ...where });
  await pipe(file, args, { input: `${pasteScript}${key}\n`, timeout: 60000, env: pasteEnv });
  const [listFile, list, listEnv = env, listScript] = await openClawShell(listArgs(provider, agent), { env, platform, runtime, ...where });
  const { stdout } = await run(listFile, list, { timeout: 30000, maxBuffer: 1024 * 1024, env: listEnv, ...scripted(listScript) });
  const profiles = JSON.parse(withoutWslNotes(stdout) || "null")?.profiles;
  const saved = Array.isArray(profiles) && profiles.find((p) => p?.id === `${provider}:default`);
  if (!saved || saved.provider !== provider || saved.type !== "api_key") throw new Error("not saved");
}

// The last setup run, for the phone to poll (it outlasts a phone's request):
// { state: running | done | partial | failed, provider, error? }, the error
// in Reach's fixed words. Never the key, OpenClaw's output or its env.
let setup = null;
let setupRun = null;
export const onboardSetup = () => (setup ? { ...setup } : null);
// Resolves once the current run has ended (tests, shutdown).
export const onboardSettled = () => setupRun || Promise.resolve();

// On Windows, installed is what Reach can start (openclaw-windows.mjs),
// found where an install made since Reach started puts it; OpenClaw's own
// Windows app keeping a Gateway in WSL is installed and set up already.
export async function onboardStatus({ has, file = configFile(), platform = process.platform, hub = hubGateway } = {}) {
  has ??= (name) => (platform === "win32" ? findOpenClaw().then(Boolean, () => false) : hasCommand(name));
  const [installed, configured, kept] = await Promise.all([has("openclaw"), exists(file), platform === "win32" ? hub() : null]);
  return { installed: installed || !!kept, configured: configured || !!kept, supported: true, providers: Object.keys(PROVIDERS), setup: onboardSetup() };
}

// Why a setup run failed, in Reach's own words. OpenClaw's output is read
// only to tell causes apart, never echoed: it can carry the key.
const partial = (cli) => `OpenClaw saved its setup, but its Gateway service didn't install. On this computer, run: ${cli} gateway install`;
export const SETUP_ERRORS = {
  missing: "OpenClaw isn't installed on this computer. Install it, then set it up.",
  node: "OpenClaw needs Node 24.16 or newer on this computer. Update Node, then set it up again.",
  partial: partial("openclaw"),
  timeout: "OpenClaw's setup took over 3 minutes and was stopped. Try again.",
  failed: "OpenClaw didn't finish setting up. Check the key and try again.",
};
export async function setupFailure(error, file, platform = process.platform) {
  const output = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  // The login shell's "command not found", or no shell at all.
  if (error?.code === 127 || error?.code === "ENOENT") return { state: "failed", error: SETUP_ERRORS.missing };
  // OpenClaw's own Node check (node-version.mjs, openclaw.mjs) and the
  // older "requires Node" wording updateRecovery reads.
  if (/OpenClaw requires|requires Node|Node [\w.]+ is unsupported|Use Node\.js \d/i.test(output)) return { state: "failed", error: SETUP_ERRORS.node };
  // Config written, daemon not: a retry would only get "already set up".
  if (await exists(file)) return { state: "partial", error: platform === "win32" ? partial(typedCli(platform)) : SETUP_ERRORS.partial };
  if (error?.killed === true || error?.signal === "SIGTERM" || error?.signal === "SIGKILL") return { state: "failed", error: SETUP_ERRORS.timeout };
  return { state: "failed", error: SETUP_ERRORS.failed };
}

// A Gateway on OpenClaw's port that nothing here says was set up (another
// install, another user's): setup doesn't start a second one beside it, on
// any computer. Anything answering there, or not refusing (Windows takes
// about two seconds to refuse a closed port on the PC itself), counts.
export async function gatewayAnswers({ port = GATEWAY_PORT, get = fetch, timeoutMs = 6000 } = {}) {
  try {
    await get(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (error) {
    return (error?.cause?.code ?? error?.code) !== "ECONNREFUSED";
  }
}

let busy = false;
const once = async (work) => {
  if (busy) throw fail(409, "OpenClaw is being set up. Try again in a moment.");
  busy = true;
  try {
    return await work();
  } finally {
    busy = false;
  }
};

export async function onboardOpenClaw(
  { provider, key, acceptRisk } = {},
  { run = runOpenClaw, env = process.env, platform = process.platform, file = configFile({ env }), authorize = () => {}, runtime, gateway = gatewayAnswers, hub = hubGateway, ...windows } = {},
) {
  authorize();
  const args = onboardArgs(provider);
  const value = checkKey(key);
  // --accept-risk is the owner's own yes, never Reach's.
  if (acceptRisk !== true) throw fail(400, "Accept OpenClaw's risk to set it up.");
  if (busy) throw fail(409, "OpenClaw is being set up. Try again in a moment.");
  busy = true;
  let started = false;
  try {
    // Never over an existing setup (new Gateway token, Tailscale off), nor
    // beside the Gateway OpenClaw's own Windows app keeps: Reach uses it.
    if (await exists(file)) throw fail(409, "OpenClaw is already set up.");
    if (platform === "win32" && (await hub())) throw fail(409, "OpenClaw is already set up in its Windows app on this PC, and Reach uses that one.");
    // Nor beside a Gateway Reach can't see.
    if (await gateway())
      throw fail(409, `Something already answers on OpenClaw's Gateway port on this ${computerWord(platform)}, and Reach can't see what set it up. Reach won't start a second Gateway beside it.`);
    authorize();
    const secret = pick(provider).envVar;
    // Windows finds OpenClaw before it runs: none there is said now.
    const [shell, argv, childEnv = env] = await openClawShell(args, { env, platform, secret, runtime, ...windows }).catch((error) => {
      throw error?.code === "ENOENT" ? fail(409, SETUP_ERRORS.missing) : error;
    });
    // Up to 3 minutes, past a phone's request: it runs on here and the
    // phone polls onboard/status. Busy (no Add key) until OpenClaw exits.
    setup = { state: "running", provider };
    setupRun = run(shell, argv, { timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: secretEnv(childEnv, { platform, secret, value }) })
      .then(() => ({ state: "done" }), (error) => setupFailure(error, file, platform))
      .catch(() => ({ state: "failed", error: SETUP_ERRORS.failed }))
      .then((end) => { setup = { ...end, provider }; })
      .finally(() => { busy = false; });
    started = true;
    return { started: true, provider };
  } finally {
    if (!started) busy = false;
  }
}

export async function addOpenClawProvider(
  { provider, key, setDefault } = {},
  { run = runOpenClaw, save = saveApiKey, env = process.env, platform = process.platform, file = configFile({ env }), authorize = () => {}, runtime, hub = hubGateway } = {},
) {
  authorize();
  pick(provider);
  const value = checkKey(key);
  if (setDefault !== undefined && typeof setDefault !== "boolean") throw fail(400, "Choose whether to use it by default.");
  return once(async () => {
    if (!(await exists(file)) && !(platform === "win32" && (await hub()))) throw fail(409, "Set up OpenClaw first.");
    authorize();
    try {
      await save(provider, value, { env, platform, run, runtime });
    } catch {
      throw fail(409, "OpenClaw didn't take this key. Try again.");
    }
    if (setDefault) {
      authorize();
      try {
        const [shell, argv, childEnv = env, script] = await openClawShell(defaultArgs(provider), { env, platform, runtime });
        await run(shell, argv, { timeout: 30000, env: childEnv, ...scripted(script) });
      } catch {
        throw fail(409, "The key is saved, but the default model didn't change.");
      }
    }
    return { added: true, provider, default: setDefault === true };
  });
}

export function routes(app, client, ctx, deps = {}) {
  const { base, authorize } = ctx;
  const { status = onboardStatus, onboard = onboardOpenClaw, addProvider = addOpenClawProvider } = deps;
  app.get(`${base}/onboard/status`, async (_req, res) => res.json(await status()));
  app.post(`${base}/onboard`, async (req, res) => {
    const body = req.body || {};
    res.json(await onboard({ provider: body.provider, key: body.key, acceptRisk: body.acceptRisk }, { authorize: authorize(req) }));
  });
  app.post(`${base}/providers/add`, async (req, res) => {
    const body = req.body || {};
    res.json(await addProvider({ provider: body.provider, key: body.key, setDefault: body.setDefault }, { authorize: authorize(req) }));
  });
}
