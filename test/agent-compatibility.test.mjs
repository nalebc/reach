import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createAgentProbe,
  runToFile,
  validateQuestions,
  validateCodexResult,
} from "../server/agent-sessions/compatibility.mjs";
import { createCodexDaemon } from "../server/agent-sessions/codex-daemon.mjs";
import { describeClaudePrompt } from "../server/agent-sessions/claude-host.mjs";
import { typeIntoClaude } from "../server/agent-sessions/claude-compose.mjs";

const help =
  "--input-format --output-format --resume --session-id --permission-mode --verbose --permission-prompts --permission-prompt-tool --include-partial-messages --replay-user-messages --model --effort";
test("CLI probes share work, expire, and detect replaced executables without sending prompts", async () => {
  let calls = 0,
    stamp = 1,
    now = 0;
  const probe = createAgentProbe({
    now: () => now,
    stat: () => ({ ino: 1, size: 2, mtimeMs: stamp }),
    run: async (_, args) => {
      calls++;
      assert.ok(["--version", "--help"].includes(args[0]));
      return { stdout: args[0] === "--version" ? "Claude Code 2.1.289" : help };
    },
  });
  const [a, b] = await Promise.all([
    probe("claude", "/fake/claude"),
    probe("claude", "/fake/claude"),
  ]);
  assert.equal(a.status, "available");
  assert.equal(a.version, "2.1.289");
  assert.deepEqual(a, b);
  assert.equal(calls, 2);
  stamp++;
  await probe("claude", "/fake/claude");
  assert.equal(calls, 4);
  now = 61000;
  await probe("claude", "/fake/claude");
  assert.equal(calls, 6);
});
test("a help text cut short is read again, and never makes the agent incompatible", async () => {
  // Claude Code's --help came through a pipe as 8 or 16 KB of 22 KB, cut
  // mid-line, about half the time: the flags past the cut read as missing.
  const full = `${"-".repeat(5000)}\n${help}\n`;
  const cut = full.slice(0, 4200);
  let reads = 0;
  const flaky = createAgentProbe({
    stat: () => ({}),
    run: async (_, args) => {
      if (args[0] === "--version") return { stdout: "2.1.291 (Claude Code)" };
      reads++;
      return { stdout: reads === 1 ? cut : full };
    },
  });
  assert.equal((await flaky("claude", "/fake")).status, "available");
  assert.equal(reads, 2);
  let now = 0;
  const always = createAgentProbe({
    now: () => now,
    stat: () => ({}),
    run: async (_, args) => ({ stdout: args[0] === "--version" ? "2.1.291" : cut }),
  });
  const first = await always("claude", "/fake");
  assert.equal(first.status, "unavailable", "cut short three times: not known, not incompatible");
  assert.match(first.reason, /Try again/);
  // Looked at again soon, not after the usual minute.
  now = 11000;
  assert.equal((await always("claude", "/fake")).status, "unavailable");
  // A whole text that lacks a flag is what incompatible means.
  const whole = createAgentProbe({
    stat: () => ({}),
    run: async (_, args) => ({ stdout: args[0] === "--version" ? "2.1.291" : `${"-".repeat(5000)}\n--resume\n` }),
  });
  assert.equal((await whole("claude", "/fake")).status, "incompatible");
});

test("missing commands and failed version probes fail closed without exposing process output", async () => {
  const missing = createAgentProbe({
    run: async () => ({ stdout: "unexpected 9.0.0" }),
    stat: () => ({}),
  });
  assert.equal((await missing("claude", "/fake")).status, "incompatible");
  const broken = createAgentProbe({
    run: async () => {
      throw Error("private command output");
    },
    stat: () => ({}),
  });
  assert.equal((await broken("codex", "/fake")).status, "unavailable");
  assert.ok(
    !JSON.stringify(await broken("codex", "/fake")).includes("private"),
  );
});
test("additive protocol fields survive but missing fields and ambiguous questions are rejected", () => {
  assert.deepEqual(
    validateCodexResult("thread/list", { data: [], future: true }),
    { data: [], future: true },
  );
  for (const malformed of [null, [], { data: {} }, { data: [null] }])
    assert.throws(() => validateCodexResult("thread/list", malformed), {
      code: "AGENT_INCOMPATIBLE",
    });
  assert.throws(
    () => validateCodexResult("turn/start", {}),
    (e) => e.uncertain && e.retryable === false,
  );
  const q = { question: "Choose", options: [{ label: "A" }], future: true };
  validateQuestions([q], "claude");
  for (const questions of [
    null,
    [],
    [q, q],
    [{ ...q, header: {} }],
    [{ ...q, options: {} }],
    [{ ...q, options: [{ label: "A" }, { label: "A" }] }],
  ])
    assert.throws(
      () =>
        describeClaudePrompt("x", {
          tool_name: "AskUserQuestion",
          input: { questions },
        }),
      { code: "AGENT_INCOMPATIBLE" },
    );
});

function transport(t, respond = () => ({}), options = {}) {
  const calls = [],
    sockets = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    send(raw, callback) {
      callback?.();
      const m = JSON.parse(raw);
      calls.push(m);
      if (m.id === undefined || !m.method) return;
      const payload = m.method === "initialize" ? { result: {} } : respond(m);
      if (payload)
        queueMicrotask(() =>
          this.emit("message", JSON.stringify({ id: m.id, ...payload })),
        );
    }
    terminate() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  const daemon = createCodexDaemon({
    locate: async () => "/fake/codex",
    run: async () => ({ stdout: '{"socketPath":"/fake.sock"}' }),
    Socket,
    requestTimeout: 25,
    protocolCooldown: 40,
    ...options,
  });
  t.after(() => daemon.close());
  return { daemon, calls, sockets };
}
test("daemon readiness restores subscribers after every handshake without deadlocking RPC", async (t) => {
  const { daemon, calls, sockets } = transport(t, () => ({ result: { data: [] } }));
  const recoveries = [];
  const off = daemon.onReady(() => {
    assert.equal(calls.at(-1).method, "initialized");
    recoveries.push(daemon.rpc("thread/loaded/list"));
  });
  await daemon.rpc("thread/list");
  await Promise.all(recoveries);
  assert.equal(recoveries.length, 1);
  sockets[0].terminate();
  await daemon.rpc("thread/list");
  await Promise.all(recoveries);
  assert.equal(recoveries.length, 2);
  off();
  sockets[1].terminate();
  await daemon.rpc("thread/list");
  assert.equal(recoveries.length, 2);
});
test("a changed method is disabled without disabling independent Codex methods", async (t) => {
  const { daemon, calls } = transport(t, (m) =>
    m.method === "thread/list"
      ? { error: { code: -32601 } }
      : { result: { data: [] } },
  );
  await assert.rejects(daemon.rpc("thread/list"), {
    code: "AGENT_INCOMPATIBLE",
  });
  await assert.rejects(daemon.rpc("thread/list"), {
    code: "AGENT_INCOMPATIBLE",
  });
  assert.equal(calls.filter((m) => m.method === "thread/list").length, 1);
  assert.deepEqual(await daemon.rpc("model/list"), { data: [] });
  assert.equal((await daemon.compatibility()).status, "degraded");
});
test("malformed replies never reach the UI and uncertain mutations are never retried", async (t) => {
  const { daemon, calls } = transport(t, (m) =>
    m.method === "turn/start" ? null : { result: { data: "changed" } },
  );
  await assert.rejects(daemon.rpc("thread/list"), {
    code: "AGENT_INCOMPATIBLE",
  });
  await assert.rejects(daemon.rpc("turn/start"), {
    code: "AGENT_DELIVERY_UNKNOWN",
  });
  assert.equal(calls.filter((m) => m.method === "turn/start").length, 1);
});
test("notification exceptions are contained and malformed JSON closes only the agent connection", async (t) => {
  const { daemon, sockets } = transport(t, () => ({ result: { data: [] } }));
  await daemon.rpc("thread/list");
  daemon.onNotification(() => {
    throw Error("changed payload");
  });
  assert.doesNotThrow(() =>
    sockets[0].emit("message", '{"method":"thread/changed","params":{}}'),
  );
  assert.equal(
    (await daemon.compatibility()).issues[0].feature,
    "notifications",
  );
  assert.doesNotThrow(() => sockets[0].emit("message", "null"));
  assert.ok((await daemon.compatibility()).issues.some((issue) => issue.feature === "protocol"));
  // For a moment calls fail at once (no new connection on every poll)...
  await assert.rejects(daemon.rpc("thread/list"), { code: "AGENT_INCOMPATIBLE" });
  assert.equal(sockets.length, 1);
  // ...then one odd message has ended that connection, not Codex: the next
  // call opens a new one, and once it works the issue is past (Oct 10).
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.equal(sockets.length, 2);
  const after = await daemon.compatibility();
  assert.equal(after.issues.some((issue) => issue.feature === "protocol"), false);
  assert.equal(after.status, "available");
});
test("a reply in an unexpected shape fails that call alone; the method works again when Codex answers well", async (t) => {
  let odd = true;
  const { daemon, calls } = transport(t, (m) =>
    m.method === "thread/list" ? { result: { data: odd ? "changed" : [] } } : { result: { data: [] } },
  );
  await assert.rejects(daemon.rpc("thread/list"), { code: "AGENT_INCOMPATIBLE" });
  assert.equal((await daemon.compatibility()).status, "degraded");
  odd = false;
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.equal(calls.filter((m) => m.method === "thread/list").length, 2);
  assert.equal((await daemon.compatibility()).status, "available");
});
test("a pending approval cannot be answered on a replacement socket", async (t) => {
  const { daemon, sockets, calls } = transport(t, () => ({
    result: { data: [] },
  }));
  let answer;
  daemon.onRequest((_request, resolve) => {
    answer = resolve;
  });
  await daemon.rpc("thread/list");
  sockets[0].emit(
    "message",
    JSON.stringify({ id: 500, method: "approval", params: {} }),
  );
  await new Promise((r) => setImmediate(r));
  sockets[0].terminate();
  await daemon.rpc("thread/list");
  await assert.rejects(answer({ decision: "accept" }), /connection ended/);
  assert.equal(calls.filter((m) => m.id === 500).length, 0);
});
test("native helper timeout or unknown acknowledgement is an uncertain delivery", async () => {
  const message = { title: "Example", text: "hello" };
  for (const raw of [
    "null",
    "[]",
    "{}",
    "garbage",
    '{"sent":"true"}',
    '{"error":"New error"}',
  ]) {
    await assert.rejects(
      typeIntoClaude(message, {
        binary: async () => "/fake",
        run: async () => ({ stdout: raw }),
      }),
      { code: "AGENT_DELIVERY_UNKNOWN" },
    );
  }
  await assert.rejects(
    typeIntoClaude(message, {
      binary: async () => "/fake",
      run: async () => {
        throw Error("timeout");
      },
    }),
    { code: "AGENT_DELIVERY_UNKNOWN" },
  );
});

test("one invalid parameter does not disable a method for every conversation", async (t) => {
  let attempts = 0;
  const { daemon } = transport(t, () =>
    ++attempts === 1 ? { error: { code: -32602 } } : { result: { data: [] } },
  );
  await assert.rejects(daemon.rpc("thread/list"), {
    code: "AGENT_INCOMPATIBLE",
  });
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.equal(attempts, 2);
});

test("an agent upgrade clears old capability failures and reinitializes its connection", async (t) => {
  let version = "1.0.0";
  const { daemon, sockets } = transport(
    t,
    () =>
      version === "1.0.0"
        ? { error: { code: -32601 } }
        : { result: { data: [] } },
    { check: async () => ({ status: "available", version }) },
  );
  await assert.rejects(daemon.rpc("thread/list"), {
    code: "AGENT_INCOMPATIBLE",
  });
  version = "2.0.0";
  assert.equal((await daemon.compatibility()).status, "available");
  assert.equal(sockets[0].readyState, 3);
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.equal(sockets.length, 2);
});

test("changed nested fields are caught before they can crash chat rendering", () => {
  for (const [method, result] of [
    ["thread/list", { data: [{ id: "one", name: {} }] }],
    [
      "thread/read",
      { thread: { id: "one", status: { type: "active", activeFlags: {} } } },
    ],
    ["model/list", { data: [{ id: "model", supportedReasoningEfforts: {} }] }],
    [
      "thread/items/list",
      { data: [{ item: { type: "agentMessage", text: {} } }] },
    ],
    ["thread/queue/list", { data: [{ id: "message", input: {} }] }],
  ])
    assert.throws(() => validateCodexResult(method, result), {
      code: "AGENT_INCOMPATIBLE",
    });
});

test("uncertain approval writes are attempted once even if the handler falls back", async (t) => {
  const { daemon, sockets, calls } = transport(t, () => ({ result: { data: [] } }));
  await daemon.rpc("thread/list");
  const send = sockets[0].send.bind(sockets[0]);
  sockets[0].send = (raw, callback) => {
    if (JSON.parse(raw).id === 999) { send(raw); callback?.(Error("write failed")); }
    else send(raw, callback);
  };
  daemon.onRequest(async (_, resolve) => { await resolve({ decision: "accept" }); });
  sockets[0].emit("message", JSON.stringify({ id: 999, method: "approval", params: {} }));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.filter(m => m.id === 999).length, 1);
});

test("thread/loaded/list pages thread ids, and anything else there still fails closed", () => {
  const page = { data: ["01a11cff-9d8d-76d2-b114-c412e165f663"], nextCursor: null };
  assert.deepEqual(validateCodexResult("thread/loaded/list", page), page);
  for (const malformed of [{ data: [{ id: "t" }] }, { data: [""] }, { data: {} }, { data: ["t"], nextCursor: 1 }])
    assert.throws(() => validateCodexResult("thread/loaded/list", malformed), { code: "AGENT_INCOMPATIBLE" });
});

test("queue and steering acknowledgements require their real protocol fields", () => {
  for (const method of ["thread/queue/add", "thread/queue/delete", "turn/steer"])
    assert.throws(() => validateCodexResult(method, {}), e => e.uncertain && e.retryable === false);
  validateCodexResult("thread/queue/add", { queuedSubmission: { id: "q" } });
  validateCodexResult("thread/queue/delete", { deleted: false });
  validateCodexResult("turn/steer", { turnId: "t" });
});

// The helper's refusals say what didn't happen, so they're retried; only a
// reply that says neither is uncertain (2026-10-06, merging the release rule
// with the session-id checks).
test("a refusal from the native helper is retried; the other chat it saw comes with it", async () => {
  const message = { title: "Example", text: "hello" };
  await assert.rejects(
    typeIntoClaude(message, {
      binary: async () => "/fake",
      run: async () => ({ stdout: JSON.stringify({ sent: false, error: "The Claude app is showing another chat.", sessions: ["local_x"] }) }),
    }),
    (e) => e.waiting === true && e.otherChat === true && e.code !== "AGENT_DELIVERY_UNKNOWN",
  );
  const { readFileSync } = await import("node:fs");
  const helper = readFileSync(new URL("../scripts/native/claude-compose.swift", import.meta.url), "utf8");
  assert.match(helper, /if value\["error"\] != nil, !replyAction\.isEmpty, value\[replyAction\] == nil \{ value\[replyAction\] = false \}/);
});


test("file-backed CLI help is complete even when a child exits immediately after a large synchronous write", async () => {
  const expected = "synthetic help ".repeat(9000) + "\n--resume --input-format\n";
  const result = await runToFile(process.execPath, ["-e", "require('node:fs').writeSync(1,'synthetic help '.repeat(9000)+'\\n--resume --input-format\\n');process.exit(0)"]);
  assert.equal(result.stdout, expected);
});

test("file-backed CLI probes reject oversized output instead of silently accepting a truncated prefix", async () => {
  await assert.rejects(runToFile(process.execPath, ["-e", "require('node:fs').writeSync(1,'x'.repeat(65536));process.exit(0)"], { maxBuffer: 4096 }), /output.*limit/i);
});

test("a timed-out CLI probe retains its file until the child really exits and escalates an ignored TERM", async t => {
  const { default: fs } = await import("node:fs");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const child = new EventEmitter(), signals = [];
  child.pid = 123456789; child.exitCode = null; child.signalCode = null;
  child.kill = signal => { signals.push(signal); return true; };
  let fd, settled = false;
  const result = runToFile("inert-only", [], {
    timeout: 10,
    spawn: (_file, _args, options) => { fd = options.stdio[1]; return child; },
  }).then(() => assert.fail("a timeout must reject"), error => { settled = true; return error; });
  try {
    t.mock.timers.tick(10);
    await Promise.resolve();
    assert.equal(settled, false, "sending TERM is not proof of process exit");
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.doesNotThrow(() => fs.fstatSync(fd), "do not remove the active writer's file early");
    t.mock.timers.tick(1000);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(settled, false);
    child.exitCode = null; child.signalCode = "SIGKILL"; child.emit("exit", null, "SIGKILL");
    assert.match((await result).message, /timed out/i);
    assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    t.mock.timers.tick(10000);
    assert.equal(signals.length, 2);
  } finally {
    child.exitCode = 0; child.emit("exit", 0);
    await result;
  }
});


test("a still-running noisy CLI probe is terminated at the observed output limit", async t => {
  const { default: fs } = await import("node:fs");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const child = new EventEmitter(), signals = [];
  child.pid = 123456789;
  child.kill = signal => { signals.push(signal); child.emit("exit", null, signal); return true; };
  let fd;
  const result = runToFile("inert-only", [], { maxBuffer: 1024, spawn: (_file, _args, options) => { fd = options.stdio[1]; return child; } });
  const denied = assert.rejects(result, /output.*limit/i);
  fs.writeSync(fd, Buffer.alloc(1025));
  t.mock.timers.tick(25);
  await denied;
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  t.mock.timers.tick(10000);
  assert.equal(signals.length, 1, "an exited child receives no late escalation");
});
