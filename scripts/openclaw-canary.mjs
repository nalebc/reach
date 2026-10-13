// Account-free OpenClaw check (check-agent-compatibility.mjs openclaw): the
// commands Reach runs, read from their --help, then a Gateway of that
// OpenClaw's own in a throwaway folder on a random loopback port, joined as
// Reach joins (createOpenClaw: its signed handshake, its scopes), and the
// methods it lists held against the ones Reach calls. Never ~/.openclaw, never
// port 18789, never a model turn, never a key: the environment is built here,
// not inherited.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import WebSocket from "ws";
import { createOpenClaw } from "../server/openclaw.mjs";
import { onboardArgs, pasteArgs, listArgs, PROVIDERS } from "../server/openclaw-onboard.mjs";
import { runToFile } from "../server/agent-sessions/compatibility.mjs";
import { spawnable } from "../server/agent-cli.mjs";

// The Gateway methods Reach calls (server/openclaw*.mjs; a test keeps these
// lists whole). Required: Reach's OpenClaw chats (list, open, start, send,
// reply on a channel, follow a run, stop, remove), called without first
// asking whether the Gateway lists them. Without one, chats break.
export const REQUIRED_METHODS = [
  "sessions.list", "chat.history", "chat.send", "agent", "agent.wait",
  "chat.abort", "sessions.reset", "sessions.delete", "channels.status", "send",
];
// Optional: a page or action Reach offers only when the Gateway lists the
// method (or answered Reach's probe for it), or that says "Update OpenClaw"
// on its own page and leaves chats alone.
export const OPTIONAL_METHODS = [
  "sessions.patch", "sessions.usage", "chat.inject", "exec.approval.resolve",
  "exec.approvals.get", "exec.approvals.set", "agents.list", "models.list",
  "web.login.start", "web.login.wait", "channels.logout",
  "cron.list", "cron.add", "cron.update", "cron.run", "cron.remove", "cron.runs",
  "skills.status", "skills.update", "skills.install",
  "wizard.start", "wizard.next", "wizard.cancel",
  "health", "logs.tail", "usage.status", "usage.cost", "config.get", "config.patch",
];
// Handled by some Gateways without being listed (2026.3.13). Reach asks once
// per connection; asking again here only waits for its answer. Neither can
// change anything: chat.inject without a chat is refused.
const PROBED = { "chat.inject": {}, "sessions.usage": { limit: 0 } };

export function compareMethods(advertised, probed = []) {
  const has = new Set([...advertised, ...probed]);
  return {
    methods: new Set(advertised).size,
    missingRequired: REQUIRED_METHODS.filter((m) => !has.has(m)),
    missingOptional: OPTIONAL_METHODS.filter((m) => !has.has(m)),
  };
}

// The commands Reach runs, each with the options it passes. Required:
// starting and restarting the Gateway from a phone. The rest are pages
// (setup, keys, channels, maintenance). Channel options show only in that
// channel's own help.
const provider = Object.keys(PROVIDERS)[0];
const options = (args) => args.filter((a) => a.startsWith("--"));
export const CLI = [
  { command: ["gateway", "start"], flags: [], required: true },
  { command: ["gateway", "restart"], flags: [], required: true },
  { command: ["gateway", "status"], flags: ["--json", "--require-rpc"] },
  { command: ["gateway", "install"], flags: ["--force", "--runtime", "--json", "--runtime-path"] },
  { command: ["doctor"], flags: ["--repair", "--non-interactive", "--no-workspace-suggestions"] },
  { command: ["update"], flags: ["--yes", "--json", "--timeout"] },
  { command: ["update", "repair"], flags: ["--yes", "--json", "--timeout"] },
  { command: ["onboard"], flags: options(onboardArgs(provider)) },
  { command: ["models", "set"], flags: [] },
  { command: ["models", "auth", "list"], flags: options(listArgs(provider)) },
  { command: ["models", "auth", "paste-api-key"], flags: options(pasteArgs(provider)) },
  { command: ["agents", "list"], flags: ["--json"] },
  { command: ["channels", "add"], channel: "telegram", flags: ["--token-file", "--name"] },
  { command: ["channels", "add"], channel: "discord", flags: ["--token", "--name"] },
  { command: ["channels", "add"], channel: "slack", flags: ["--bot-token", "--app-token", "--name"] },
  { command: ["configure"], flags: ["--section"] },
];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A command that isn't there prints its parent's help (2026.4.11) or fails
// (2026.10): either way, not its own Usage line.
export function readHelp(entry, help) {
  const name = entry.command.join(" ") + (entry.channel ? ` --channel ${entry.channel}` : "");
  const usage = new RegExp(`^Usage:\\s+\\S*openclaw\\S*\\s+${entry.command.map(escape).join("\\s+")}(?![\\w-])`, "m");
  if (help == null || !usage.test(help)) return [name];
  return entry.flags
    .filter((flag) => !new RegExp(`(?<![\\w-])${escape(flag)}(?![\\w-])`).test(help))
    .map((flag) => `${name} ${flag}`);
}

// Ports OpenClaw itself uses (default, --dev): never these.
const RESERVED = new Set([18789, 19001]);
const ephemeral = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
export async function freePort(pick = ephemeral) {
  for (let i = 0; i < 20; i++) {
    const port = await pick();
    if (Number.isInteger(port) && port > 1024 && port < 65536 && !RESERVED.has(port)) return port;
  }
  throw Error("No free loopback port.");
}

// Everything OpenClaw reads from its environment points into `dir`; nothing
// else is passed on (no provider keys, no OPENCLAW_* from this shell). No
// log file at all: OpenClaw logs into the shared /tmp/openclaw beside the
// owner's own Gateway (and prunes it), and 2026.4.11 ignores logging.file.
export function sandboxEnv(dir, { port, token, source = process.env } = {}) {
  const home = path.join(dir, "home"), state = path.join(dir, "state"), tmp = path.join(dir, "tmp");
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "COMSPEC", "LANG"])
    if (typeof source[key] === "string") env[key] = source[key];
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, OPENCLAW_HOME: home,
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_GATEWAY_PORT: String(port), OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_DISABLE_BONJOUR: "1", OPENCLAW_NO_RESPAWN: "1", OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_LOG_LEVEL: "silent",
    TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: "1", NO_COLOR: "1",
  });
}
// The least a Gateway needs to start here, without secrets: local mode (no
// config at all needs --allow-unconfigured). logging.file in case a version
// logs despite the silent level. No heartbeat: nothing may start a model turn.
export const throwawayConfig = (dir) => ({
  gateway: { mode: "local" },
  logging: { file: path.join(dir, "logs", "openclaw.log") },
  agents: { defaults: { heartbeat: { every: "0m" } } },
});

// Records the Gateway's answer to Reach's connect (its hello: methods,
// protocol), which createOpenClaw keeps to itself.
function recording(Socket, hellos) {
  return class extends Socket {
    constructor(...args) {
      super(...args);
      this.on("message", (buffer) => {
        let frame;
        try { frame = JSON.parse(String(buffer)); } catch { return; }
        if (frame?.type === "res" && frame.ok && frame.id === this.reachConnect) hellos.push(frame.payload);
      });
    }
    send(data, ...rest) {
      try {
        const m = JSON.parse(data);
        if (m?.method === "connect") this.reachConnect = m.id;
      } catch {}
      return super.send(data, ...rest);
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const versionOf = (text) => String(text).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] || null;

export async function openClawCanary(executable = "openclaw", {
  run = runToFile,
  launch = spawn,
  kill = (pid, signal) => process.kill(pid, signal),
  Socket = WebSocket,
  pick,
  base = os.tmpdir(),
  env: source = process.env,
  platform = process.platform,
  helpMs = 60000,
  readyMs = 120000,
  pollMs = 250,
  refusedMs = 10000,
  stopMs = 10000,
  killMs = 5000,
  timeoutMs = 15000,
} = {}) {
  const dir = fs.mkdtempSync(path.join(base, "reach-oc-"));
  const result = { version: null, status: "unavailable", reason: "The OpenClaw check stopped before it finished." };
  let child = null, client = null, exited = null;
  const cli = spawnable(executable, { platform });
  // A group of its own (POSIX): workers it starts end with it.
  const group = () => (platform === "win32" ? child.pid : -child.pid);
  const alive = () => {
    try { kill(group(), 0); return true; } catch { return false; }
  };
  const signal = (name) => {
    try {
      if (platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else kill(group(), name);
    } catch {}
  };
  // Interrupted (Ctrl-C, a runner cancelling): still nothing left behind.
  const emergency = () => {
    if (child?.pid) signal("SIGKILL");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  const interrupted = (name) => {
    emergency();
    process.exit(name === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  process.once("exit", emergency);
  try {
    const port = await freePort(pick);
    const token = crypto.randomBytes(24).toString("base64url");
    const env = sandboxEnv(dir, { port, token, source });
    for (const sub of ["home", "state", "tmp", "logs", "reach"])
      fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(throwawayConfig(dir), null, 2), { mode: 0o600 });
    const options = {
      timeout: helpMs,
      maxBuffer: 1024 * 1024,
      env,
      spawn: (file, args, o) => launch(file, args, { ...o, cwd: dir }),
    };
    try {
      result.version = versionOf((await run(cli.file, [...cli.args, "--version"], options)).stdout);
    } catch {}
    if (!result.version) {
      result.reason = "OpenClaw did not report its version. Check that this OpenClaw runs on this Node.";
      return result;
    }

    const gaps = { required: [], optional: [] };
    for (const entry of CLI) {
      const args = [...entry.command, ...(entry.channel ? ["--channel", entry.channel] : []), "--help"];
      let help = null;
      try { help = (await run(cli.file, [...cli.args, ...args], options)).stdout; } catch {}
      gaps[entry.required ? "required" : "optional"].push(...readHelp(entry, help));
    }
    result.cli = { commands: CLI.length, missingRequired: gaps.required, missingOptional: gaps.optional };

    child = launch(cli.file, [...cli.args, "gateway", "run", "--port", String(port), "--bind", "loopback", "--auth", "token", "--tailscale", "off"], {
      cwd: dir, env, stdio: "ignore", detached: platform !== "win32", windowsHide: true,
    });
    child.once("exit", (code, sig) => (exited = { code, signal: sig }));
    child.once("error", () => (exited ??= { code: null, signal: "spawn" }));
    const hellos = [];
    client = createOpenClaw({
      dataDir: path.join(dir, "reach"),
      configuration: async () => ({ url: `ws://127.0.0.1:${port}`, token }),
      Socket: recording(Socket, hellos),
      timeoutMs,
    });
    // Ready when Reach's own connect succeeds. A refusal can be the Gateway
    // still starting; one that lasts is the answer.
    const deadline = Date.now() + readyMs;
    let refused = null;
    for (;;) {
      if (exited) {
        result.reason = `OpenClaw's Gateway stopped before Reach could connect (${exited.code ?? exited.signal}).`;
        return result;
      }
      try {
        await client.call("sessions.list", { includeGlobal: true, includeUnknown: true });
      } catch (error) {
        if (!client.connected()) {
          if (!error?.gatewayDown) {
            refused ??= { at: Date.now() };
            refused.message = String(error?.message || "");
            if (Date.now() - refused.at >= refusedMs) {
              // Reach's own fixed words for the refusal, never the Gateway's.
              result.status = "incompatible";
              result.reason = `OpenClaw's Gateway refused Reach's connection: ${refused.message}`;
              return result;
            }
          } else refused = null;
          if (Date.now() >= deadline) {
            result.reason = "OpenClaw's Gateway did not answer Reach in time.";
            return result;
          }
          await sleep(pollMs);
          continue;
        }
      }
      break;
    }
    const hello = hellos.at(-1);
    const advertised = hello?.features?.methods;
    if (!Array.isArray(advertised) || advertised.some((m) => typeof m !== "string")) {
      result.reason = "OpenClaw's Gateway did not list its methods.";
      return result;
    }
    for (const [method, params] of Object.entries(PROBED))
      if (!advertised.includes(method)) await client.call(method, params).catch(() => {});
    const probed = Object.keys(PROBED).filter((m) => !advertised.includes(m) && client.can(m));
    result.protocol = {
      version: Number.isInteger(hello.protocol) ? hello.protocol : null,
      ...compareMethods(advertised, probed),
      modelTurns: 0,
    };
    const missing = [...result.protocol.missingRequired, ...gaps.required];
    if (missing.length) {
      result.status = "incompatible";
      result.reason = `OpenClaw lacks what Reach's chats use: ${missing.join(", ")}.`;
    } else {
      result.status = "available";
      result.reason = null;
    }
    return result;
  } catch {
    result.status = "unavailable";
    result.reason = "The OpenClaw check failed before it finished.";
    return result;
  } finally {
    client?.close();
    let stopped = true;
    if (child?.pid) {
      if (!exited || alive()) {
        signal("SIGTERM");
        for (const end = Date.now() + stopMs; alive() && Date.now() < end;) await sleep(100);
        if (alive()) {
          signal("SIGKILL");
          for (const end = Date.now() + killMs; alive() && Date.now() < end;) await sleep(100);
        }
      }
      stopped = !alive();
    }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    const removed = !fs.existsSync(dir);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    process.off("exit", emergency);
    result.cleanup = { gateway: !child?.pid ? "not started" : stopped ? "stopped" : "still running", state: removed ? "removed" : "left behind" };
    if (!stopped || !removed) {
      result.status = "unavailable";
      result.reason = !stopped
        ? `The throwaway Gateway did not stop (process ${child.pid}). Stop it, then remove ${dir}.`
        : `The throwaway folder could not be removed: ${dir}.`;
    }
  }
}
