import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  CLI,
  compareMethods,
  readHelp,
  freePort,
  sandboxEnv,
  openClawCanary,
} from "../scripts/openclaw-canary.mjs";

const ALL = [...REQUIRED_METHODS, ...OPTIONAL_METHODS];

test("every Gateway method Reach calls is required or optional, and nothing listed is a method Reach doesn't call", () => {
  const dir = new URL("../server/", import.meta.url);
  const text = fs
    .readdirSync(dir)
    .filter((f) => /^openclaw.*\.mjs$/.test(f))
    .map((f) => fs.readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
  const called = new Set();
  for (const m of text.matchAll(/\b(?:rpc|call|can|request|methods\.has|read)\(\s*"([a-z][\w-]*(?:\.[\w-]+)*)"/g))
    called.add(m[1]);
  // ["wizard.start", …].every((m) => client.can(m))
  for (const m of text.matchAll(/\[((?:\s*"[\w.]+",?)+)\s*\]\.every\(\s*\(m\)\s*=>\s*client\.can\(m\)/g))
    for (const s of m[1].matchAll(/"([\w.]+)"/g)) called.add(s[1]);
  called.delete("connect"); // the handshake itself
  assert.ok(called.size > 30, "the scan still finds Reach's calls");
  assert.equal(new Set(ALL).size, ALL.length, "no method in both lists");
  assert.deepEqual([...called].filter((m) => !ALL.includes(m)), []);
  // chat.send and agent are picked by a ternary: named in the source.
  assert.deepEqual(ALL.filter((m) => !text.includes(`"${m}"`)), []);
});

test("methods: extra ones are fine, gaps are named by kind, and a probed method counts", () => {
  assert.deepEqual(compareMethods([...ALL, "future.method"]), {
    methods: ALL.length + 1,
    missingRequired: [],
    missingOptional: [],
    unchecked: [],
  });
  const without = ALL.filter((m) => !["chat.send", "cron.runs", "chat.inject"].includes(m));
  assert.deepEqual(compareMethods(without), {
    methods: without.length,
    missingRequired: ["chat.send"],
    missingOptional: ["chat.inject", "cron.runs"],
    unchecked: [],
  });
  assert.deepEqual(compareMethods(without, ["chat.inject"]).missingOptional, ["cron.runs"]);
  assert.equal(compareMethods(["health", "health"]).methods, 1);
  // WhatsApp's login methods come with its plugin: with no channels, unknown.
  const channelless = compareMethods(ALL.filter((m) => !m.startsWith("web.login.")));
  assert.deepEqual(channelless.missingOptional, []);
  assert.deepEqual(channelless.unchecked, ["web.login.start", "web.login.wait"]);
});

const helpText = (words, flags) =>
  `\nOpenClaw 2026.10.2 (abc1234)\n\nUsage: openclaw ${words} [options]\n\nOptions:\n${flags.map((f) => `  ${f} <value>  Something\n`).join("")}`;
test("help: a command needs its own Usage line, and a flag counts only whole", () => {
  const telegram = CLI.find((e) => e.channel === "telegram");
  const discord = CLI.find((e) => e.channel === "discord");
  const repair = CLI.find((e) => e.command.join(" ") === "update repair");
  assert.deepEqual(readHelp(telegram, helpText("channels add", ["--token-file", "--name"])), []);
  // --token-file is not --token.
  assert.deepEqual(readHelp(discord, helpText("channels add", ["--token-file", "--name"])), [
    "channels add --channel discord --token",
  ]);
  // 2026.4.11 answers `update repair --help` with update's own help.
  assert.deepEqual(readHelp(repair, `${helpText("update", repair.flags)}\nCommands:\n  repair  Repair\n`), ["update repair"]);
  assert.deepEqual(readHelp(repair, null), ["update repair"]);
  assert.deepEqual(readHelp(repair, helpText("update repairs", repair.flags)), ["update repair"]);
  assert.deepEqual(readHelp(repair, helpText("update repair", repair.flags)), []);
  // Reach's onboard options come from Reach's own argv (openclaw-onboard.mjs).
  assert.ok(CLI.find((e) => e.command[0] === "onboard").flags.includes("--skip-health"));
});

test("never one of OpenClaw's own ports", async () => {
  const ports = [18789, 19001, 41234];
  assert.equal(await freePort(async () => ports.shift()), 41234);
  const port = await freePort();
  assert.ok(port > 1024 && port !== 18789 && port !== 19001);
});

test("the environment is built, not inherited: no keys, nothing from this shell's OpenClaw", () => {
  const dir = path.join(os.tmpdir(), "reach-oc-env");
  const env = sandboxEnv(dir, {
    port: 4321,
    token: "throwaway",
    source: {
      PATH: "/bin",
      HOME: "/Users/someone",
      ANTHROPIC_API_KEY: "sk-real",
      OPENAI_API_KEY: "sk-real",
      OPENCLAW_STATE_DIR: "/Users/someone/.openclaw",
      OPENCLAW_GATEWAY_TOKEN: "real-token",
      OPENCLAW_LOAD_SHELL_ENV: "1",
      NODE_OPTIONS: "--require x",
    },
  });
  assert.equal(env.PATH, "/bin");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCLAW_LOAD_SHELL_ENV", "NODE_OPTIONS"])
    assert.equal(env[key], undefined, key);
  for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "TMPDIR", "XDG_CONFIG_HOME", "APPDATA"])
    assert.ok(env[key].startsWith(dir + path.sep), key);
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, "throwaway");
  assert.equal(env.OPENCLAW_GATEWAY_PORT, "4321");
  assert.equal(env.OPENCLAW_LOG_LEVEL, "silent");
  assert.equal(env.OPENCLAW_DISABLE_BONJOUR, "1");
});

// A stand-in OpenClaw: its CLI (help texts), a Gateway process that can be
// signalled, and a Gateway socket that challenges, answers Reach's connect
// with `methods`, and answers what it's asked.
function fakeOpenClaw(t, {
  methods = ALL,
  protocol = 4,
  version = "OpenClaw 2026.10.2 (abc1234)",
  helps = {},
  answer = {},
  refuse = null,
  exitEarly = false,
  stubborn = false,
  refusedAttempts = 1,
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "reach-oc-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const flags = [...new Set(CLI.flatMap((e) => e.flags))];
  const seen = { runs: [], spawned: [], sent: [], signals: [], sockets: 0, config: null };
  const run = async (file, args, options) => {
    seen.runs.push({ args, env: options.env });
    if (args[0] === "--version") {
      if (version instanceof Error) throw version;
      return { stdout: version };
    }
    const words = args.slice(0, args.indexOf("--help")).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--channel");
    const key = words.join(" ");
    return { stdout: key in helps ? helps[key] : helpText(key, flags) };
  };
  let alive = false, child = null;
  const launch = (file, args, options) => {
    seen.spawned.push({ file, args, options });
    seen.config = JSON.parse(fs.readFileSync(options.env.OPENCLAW_CONFIG_PATH, "utf8"));
    child = new EventEmitter();
    child.pid = 4242;
    alive = true;
    if (exitEarly)
      setTimeout(() => {
        alive = false;
        child.emit("exit", 78, null);
      }, 5);
    return child;
  };
  const kill = (pid, signal) => {
    seen.signals.push([pid, signal]);
    if (!alive) throw Object.assign(Error("no such process"), { code: "ESRCH" });
    if (signal !== 0 && !stubborn) {
      alive = false;
      setImmediate(() => child.emit("exit", null, signal));
    }
  };
  class Socket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      const attempt = seen.sockets++;
      setImmediate(() => {
        // Not listening yet: the first attempts are refused.
        if (attempt < refusedAttempts) return this.emit("error", Error("ECONNREFUSED"));
        this.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-1" } }));
      });
    }
    send(raw) {
      const m = JSON.parse(raw);
      seen.sent.push(m);
      const reply = (frame) => setImmediate(() => this.emit("message", JSON.stringify({ type: "res", id: m.id, ...frame })));
      if (m.method === "connect")
        return reply(
          refuse
            ? { ok: false, error: { message: refuse } }
            : { ok: true, payload: { protocol, server: { version: "2026.10.2" }, ...(methods ? { features: { methods } } : {}) } },
        );
      if (answer[m.method]) return reply(answer[m.method](m));
      if (!methods?.includes(m.method)) return reply({ ok: false, error: { message: `unknown method: ${m.method}` } });
      return reply({ ok: true, payload: { sessions: [] } });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
    terminate() {
      this.close();
    }
  }
  const check = (options = {}) =>
    openClawCanary("/fake/openclaw", {
      run, launch, kill, Socket, base,
      env: { PATH: "/bin", HOME: os.homedir(), ANTHROPIC_API_KEY: "sk-real", OPENCLAW_STATE_DIR: path.join(os.homedir(), ".openclaw") },
      platform: "darwin",
      pollMs: 5, readyMs: 3000, refusedMs: 50, stopMs: 200, killMs: 200, timeoutMs: 1000,
      ...options,
    });
  return { check, base, seen };
}

const listeners = () => ["SIGINT", "SIGTERM", "exit"].map((e) => process.listenerCount(e));

test("a Gateway of its own: Reach's handshake, its method list, no model turn, nothing left behind", async (t) => {
  const { check, base, seen } = fakeOpenClaw(t, {
    methods: ALL.filter((m) => m !== "chat.inject"),
    // Handled, not listed (2026.3.13): Reach's probe finds it.
    answer: { "chat.inject": () => ({ ok: false, error: { message: "invalid chat.inject params: must have sessionKey" } }) },
  });
  const before = listeners();
  const result = await check();
  assert.equal(result.status, "available", result.reason);
  assert.equal(result.version, "2026.10.2");
  assert.equal(result.reason, null);
  assert.deepEqual(result.cli, { commands: CLI.length, missingRequired: [], missingOptional: [] });
  assert.deepEqual(result.protocol, {
    version: 4,
    methods: ALL.length - 1,
    missingRequired: [],
    missingOptional: [],
    unchecked: [],
    modelTurns: 0,
  });
  assert.deepEqual(result.cleanup, { gateway: "stopped", state: "removed" });
  assert.deepEqual(fs.readdirSync(base), [], "throwaway folder removed");
  assert.deepEqual(listeners(), before, "signal handlers removed");

  // Started from that folder, on a random loopback port, never 18789.
  assert.equal(seen.spawned.length, 1);
  const [{ args, options }] = seen.spawned;
  const port = args[args.indexOf("--port") + 1];
  assert.deepEqual(args, ["gateway", "run", "--port", port, "--bind", "loopback", "--auth", "token", "--tailscale", "off"]);
  assert.notEqual(port, "18789");
  assert.equal(options.env.OPENCLAW_GATEWAY_PORT, port);
  assert.equal(options.detached, true, "a process group of its own");
  for (const key of ["HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"])
    assert.ok(options.env[key].startsWith(base + path.sep), key);
  assert.ok(options.cwd.startsWith(base + path.sep));
  for (const { env } of [options, ...seen.runs]) {
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(env.OPENCLAW_STATE_DIR.startsWith(base + path.sep));
  }
  assert.equal(seen.config.gateway.mode, "local");
  assert.equal(seen.config.agents.defaults.heartbeat.every, "0m");
  assert.ok(seen.config.logging.file.startsWith(base + path.sep));

  // Joined as Reach joins, after the Gateway came up.
  assert.ok(seen.sockets >= 2, "a refused first attempt is tried again");
  const connect = seen.sent.find((m) => m.method === "connect").params;
  assert.equal(connect.client.id, "gateway-client");
  assert.equal(connect.role, "operator");
  assert.ok(connect.scopes.includes("operator.admin"));
  assert.equal(connect.auth.token, options.env.OPENCLAW_GATEWAY_TOKEN);
  assert.equal(connect.device.nonce, "nonce-1");
  assert.equal(typeof connect.device.signature, "string");
  // Read-only calls and Reach's own probe; never a turn.
  assert.deepEqual([...new Set(seen.sent.map((m) => m.method))].sort(), ["chat.inject", "connect", "sessions.list"]);
  assert.ok(seen.sent.filter((m) => m.method === "chat.inject").every((m) => Object.keys(m.params).length === 0));
  // Stopped as a group.
  assert.deepEqual(seen.signals.find(([, s]) => s === "SIGTERM"), [-4242, "SIGTERM"]);
});

test("a missing chat method is incompatible; a method Reach only probes for is found by asking, or missing", async (t) => {
  const lacking = fakeOpenClaw(t, {
    methods: ALL.filter((m) => !["chat.send", "sessions.usage"].includes(m)),
    answer: { "sessions.usage": () => ({ ok: true, payload: { sessions: [] } }) },
  });
  const result = await lacking.check();
  assert.equal(result.status, "incompatible");
  assert.deepEqual(result.protocol.missingRequired, ["chat.send"]);
  assert.deepEqual(result.protocol.missingOptional, []);
  assert.match(result.reason, /chat\.send/);
  assert.deepEqual(result.cleanup, { gateway: "stopped", state: "removed" });

  const older = fakeOpenClaw(t, { methods: ALL.filter((m) => m !== "chat.inject"), protocol: 3 });
  const old = await older.check();
  assert.equal(old.status, "available");
  assert.equal(old.protocol.version, 3);
  assert.deepEqual(old.protocol.missingOptional, ["chat.inject"]);
});

test("the CLI: a missing start or restart is incompatible, a missing page command is only named", async (t) => {
  const { check } = fakeOpenClaw(t, {
    helps: {
      "gateway restart": helpText("gateway", []),
      "models auth list": helpText("models auth", ["--agent"]),
      "gateway install": helpText("gateway install", ["--force", "--runtime", "--json"]),
    },
  });
  const result = await check();
  assert.equal(result.status, "incompatible");
  assert.deepEqual(result.cli.missingRequired, ["gateway restart"]);
  assert.deepEqual(result.cli.missingOptional, ["gateway install --runtime-path", "models auth list"]);
  assert.match(result.reason, /gateway restart/);
  assert.deepEqual(result.protocol.missingRequired, []);
});

test("never available without a method list, a handshake, a running Gateway or a version, and nothing left behind", async (t) => {
  const cases = [
    [{ methods: null }, "unavailable", /did not list its methods/],
    [{ refuse: "protocol mismatch: server speaks 9" }, "incompatible", /incompatible connection versions/],
    // OpenClaw 2026.2.25 and older: only v1/v2 device payloads.
    [{ refuse: "device signature invalid (server speaks 9)" }, "incompatible", /refused Reach's signed device identity/],
    [{ exitEarly: true, refusedAttempts: 1000 }, "unavailable", /stopped before Reach could connect \(78\)/],
    [{ version: Error("ENOENT") }, "unavailable", /did not report its version/],
    [{ refusedAttempts: 1000 }, "unavailable", /did not answer Reach in time/, { readyMs: 100 }],
  ];
  for (const [setup, status, reason, options] of cases) {
    const { check, base, seen } = fakeOpenClaw(t, setup);
    const result = await check(options);
    assert.equal(result.status, status, JSON.stringify(setup));
    assert.match(result.reason, reason);
    assert.ok(!/server speaks 9/.test(result.reason), "the Gateway's own words never pass through");
    assert.deepEqual(fs.readdirSync(base), []);
    assert.equal(result.cleanup.state, "removed");
    if (setup.version) assert.equal(seen.spawned.length, 0);
    else assert.notEqual(result.cleanup.gateway, "still running");
  }
});

test("a Gateway that won't stop is reported, not hidden", async (t) => {
  const { check, seen } = fakeOpenClaw(t, { stubborn: true });
  const result = await check();
  assert.equal(result.status, "unavailable");
  assert.equal(result.cleanup.gateway, "still running");
  assert.match(result.reason, /did not stop \(process 4242\)/);
  assert.deepEqual(seen.signals.filter(([, s]) => s !== 0), [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
});
