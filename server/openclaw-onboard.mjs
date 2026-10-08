// OpenClaw feature: onboard. Routes under /api/sessions/openclaw (see
// openClawRoutes in openclaw.mjs). client: createOpenClaw()'s api (call,
// can, onEvent, redact). ctx: { base, authorize, dataDir, openSetup, openCommand }.
//
// OpenClaw 2026.3.13, from the phone:
// - Set up: `openclaw onboard --non-interactive --accept-risk …` (its own
//   wizard, no prompts), only while there's no config: on an existing one it
//   would rotate the Gateway token and reset Tailscale. Gateway on loopback,
//   token auth, always.
// - Add a key: OpenClaw has no prompt-free way (paste-token stores a
//   "token" profile, and a cancelled prompt as the key). So Reach writes the
//   api_key profile onboard writes, {type, provider, key} at X:default in
//   the main agent's auth-profiles.json, under OpenClaw's own lock file, and
//   `openclaw config set auth.profiles[X:default]` marks it api_key.
// - Default model: `openclaw models set <ref>`, OpenClaw's own onboard ref.
// Keys go to OpenClaw only: its env or its own store, never argv, shell
// text, a log or a response. Errors are Reach's fixed words.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import JSON5 from "json5";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasCommand } from "./agent-install.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
// Same shape as channel tokens (addOpenClawChannel).
const KEY_SHAPE = /^[\x21-\x7e]{8,4096}$/;
export const GATEWAY_PORT = 18789;

// The providers a phone can pick; nothing else reaches OpenClaw.
export const PROVIDERS = {
  openrouter: { choice: "openrouter-api-key", envVar: "OPENROUTER_API_KEY", model: "openrouter/auto" },
  anthropic: { choice: "apiKey", envVar: "ANTHROPIC_API_KEY", model: "anthropic/claude-opus-4-6" },
  openai: { choice: "openai-api-key", envVar: "OPENAI_API_KEY", model: "openai/gpt-5.1-codex" },
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
// (keyedShell). Never --json (its summary has the Gateway token), --reset,
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
export const profileArgs = (provider) => {
  pick(provider);
  return ["config", "set", `auth.profiles[${provider}:default]`, JSON.stringify({ provider, mode: "api_key" }), "--strict-json"];
};
export const defaultArgs = (provider) => ["models", "set", pick(provider).model];

const shellOf = (env) => env.SHELL || "/bin/sh";
// "$@": every value is an argument, never shell text.
const viaShell = (args) => ["-lc", 'exec openclaw "$@"', "openclaw", ...args];
// The same, the key set as the provider's variable after the login profile
// (which could set its own), from REACH_PROVIDER_KEY: never in any argv.
export const keyedShell = (provider, args) => [
  "-lc",
  `export ${pick(provider).envVar}="$REACH_PROVIDER_KEY"; unset REACH_PROVIDER_KEY; exec openclaw "$@"`,
  "openclaw",
  ...args,
];

// The main agent's key store, as OpenClaw finds it (resolveOpenClawAgentDir:
// onboard writes there; other agents fall back to it).
export function authStoreFile({ env = process.env, home = os.homedir() } = {}) {
  const user = (p) => (p.startsWith("~") ? path.join(home, p.slice(1)) : path.resolve(p));
  const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  const state = env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".openclaw");
  return path.join(override ? user(override) : path.join(user(state), "agents", "main", "agent"), "auth-profiles.json");
}

// OpenClaw's lock: `<file>.lock` made exclusively, stale after 30 s.
const LOCK_STALE_MS = 30000;
async function withLock(file, work) {
  let target;
  try {
    target = await fs.realpath(file);
  } catch {
    target = path.resolve(file);
  }
  const lock = `${target}.lock`;
  for (let attempt = 0; attempt < 40; attempt++) {
    let handle;
    try {
      handle = await fs.open(lock, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = true;
      try {
        const held = JSON.parse(await fs.readFile(lock, "utf8"));
        const at = Date.parse(held?.createdAt);
        stale = !Number.isFinite(at) || Date.now() - at > LOCK_STALE_MS;
      } catch {
        try {
          stale = Date.now() - (await fs.stat(lock)).mtimeMs > LOCK_STALE_MS;
        } catch {}
      }
      if (stale) await fs.rm(lock, { force: true });
      else await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2), "utf8");
      return await work();
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(lock, { force: true }).catch(() => {});
    }
  }
  throw new Error("locked");
}

// Sets one api_key profile; every other profile, order, lastGood and
// usageStats stay. Atomic (temp file + rename), 0600, then read back.
export async function saveApiKey(provider, key, { file = authStoreFile() } = {}) {
  pick(provider);
  const id = `${provider}:default`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withLock(file, async () => {
    let store = { version: 1, profiles: {} };
    try {
      store = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      // Never over a store Reach can't read.
      if (error.code !== "ENOENT") throw error;
    }
    if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("unreadable");
    if (!store.profiles || typeof store.profiles !== "object" || Array.isArray(store.profiles)) store.profiles = {};
    store.version ??= 1;
    store.profiles[id] = { type: "api_key", provider, key };
    const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    await fs.chmod(file, 0o600);
  });
  // Compared here only; never returned.
  const saved = JSON.parse(await fs.readFile(file, "utf8"))?.profiles?.[id];
  if (saved?.type !== "api_key" || saved.provider !== provider || saved.key !== key) throw new Error("mismatch");
}

// Whether the config already marks X:default as an api_key profile.
async function profileMarked(file, provider) {
  try {
    const p = JSON5.parse(await fs.readFile(file, "utf8"))?.auth?.profiles?.[`${provider}:default`];
    return p?.provider === provider && p?.mode === "api_key";
  } catch {
    return false;
  }
}

export async function onboardStatus({ has = (name) => hasCommand(name), file = configFile(), platform = process.platform } = {}) {
  const [installed, configured] = await Promise.all([has("openclaw"), exists(file)]);
  return { installed, configured, supported: platform !== "win32", providers: Object.keys(PROVIDERS) };
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
  { run = promisify(execFile), env = process.env, platform = process.platform, file = configFile({ env }), authorize = () => {} } = {},
) {
  authorize();
  const args = onboardArgs(provider);
  const value = checkKey(key);
  // --accept-risk is the owner's own yes, never Reach's.
  if (acceptRisk !== true) throw fail(400, "Accept OpenClaw's risk to set it up.");
  if (platform === "win32") throw fail(409, "On Windows, set up OpenClaw on this computer.");
  return once(async () => {
    // Never over an existing setup (new Gateway token, Tailscale off).
    if (await exists(file)) throw fail(409, "OpenClaw is already set up.");
    authorize();
    try {
      await run(shellOf(env), keyedShell(provider, args), {
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...env, REACH_PROVIDER_KEY: value },
      });
    } catch {
      throw fail(409, "OpenClaw didn't finish setting up. Check the key and try again.");
    }
    return { done: true, provider };
  });
}

export async function addOpenClawProvider(
  { provider, key, setDefault } = {},
  { run = promisify(execFile), save = saveApiKey, env = process.env, platform = process.platform, file = configFile({ env }), store = authStoreFile({ env }), authorize = () => {} } = {},
) {
  authorize();
  const args = profileArgs(provider);
  const value = checkKey(key);
  if (setDefault !== undefined && typeof setDefault !== "boolean") throw fail(400, "Choose whether to use it by default.");
  if (platform === "win32") throw fail(409, "On Windows, add keys in OpenClaw on this computer.");
  return once(async () => {
    if (!(await exists(file))) throw fail(409, "Set up OpenClaw first.");
    authorize();
    try {
      await save(provider, value, { file: store });
      if (!(await profileMarked(file, provider))) await run(shellOf(env), viaShell(args), { timeout: 30000 });
    } catch {
      throw fail(409, "OpenClaw didn't take this key. Try again.");
    }
    if (setDefault) {
      authorize();
      try {
        await run(shellOf(env), viaShell(defaultArgs(provider)), { timeout: 30000 });
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
