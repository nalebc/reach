import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

const T = "11111111-2222-4333-8444-555555555555";
const MARKER = "Reach delegated coding task fixture-task.";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const denied = () => Object.assign(Error("Access ended"), { status: 401 });

function fixture(t, { replies = {}, ownerClaim = async () => {}, claudeOptions = {}, sessionOptions = {}, onUser } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-coding-session-"));
  const events = [], calls = [], runs = [];
  let notification;
  const daemon = {
    async rpc(method, params) {
      events.push(method); calls.push([method, params]);
      const canned = { "model/list": { data: [] }, "thread/start": { thread: { id: T } }, "turn/start": { turn: { id: "initial-turn" } }, ...replies }[method];
      const result = typeof canned === "function" ? await canned(params) : canned;
      if (result instanceof Error) throw result;
      return result || {};
    },
    onNotification(fn) { notification = fn; }, onRequest() {}, onClose() {}, onReady() {}, close() {},
    emit(method, params) { notification?.({ method, params }); },
  };
  const codexLive = createCodexLive({ daemon, nativeTurns: false, queues: false,
    ownerFactory: () => ({ claim: ownerClaim, update() {}, hasFollowers: () => false, close() {}, reset() {} }) });
  const spawn = (file, args, options) => {
    events.push("claude/spawn");
    const proc = new EventEmitter();
    Object.assign(proc, { file, args, options, lines: [], exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
    proc.print = message => proc.stdout.emit("data", JSON.stringify(message) + "\n");
    proc.stdin = { on() {}, end() {}, write(text, done) {
      for (const line of text.split("\n").filter(Boolean)) {
        const message = JSON.parse(line); proc.lines.push(message);
        if (message.type === "user") { events.push("claude/user"); onUser?.(proc); }
        if (message.type === "control_request") queueMicrotask(() => {
          if (message.request.subtype === "initialize") claudeOptions.initialized?.();
          proc.print({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
            response: message.request.subtype === "generate_session_title" ? { title: "Task" } : {} } });
        });
      }
      done?.();
    } };
    proc.kill = () => { proc.exitCode = 143; proc.emit("exit", 143); };
    runs.push(proc); return proc;
  };
  const claudeHost = createClaudeHost({ locate: async () => "/fixture/claude", spawn, ...claudeOptions });
  const sessions = createAgentSessions({
    dataDir: dir, daemon, codexLive, codex: { models: async () => ({ modes: [{ id: "guardian-approvals" }] }), list: async () => [] },
    claudeHost, claude: { health: async () => ({ signedIn: true }), list: async () => [], read: async id => ({ session: { id, cwd: dir, status: "idle" }, items: [] }) },
    gemini: { list: async () => [] }, signIn: {}, agentAsks: { close() {} }, claudeImports: { add: async () => { events.push("claude/import"); }, close() {} },
    live: async () => new Map(), registry: () => new Map(), continueMs: 1, ...sessionOptions,
  });
  t.after(() => { sessions.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const start = (agent, extra = {}) => sessions.startCodingTask(agent, { cwd: dir, text: MARKER + "\nFix the fixture.", name: "Task", onCreated: async () => { events.push("created"); }, ...extra });
  return { sessions, start, daemon, codexLive, claudeHost, calls, events, runs, dir };
}

test("delegated Codex start records the thread before its first turn and pins owner approvals", async t => {
  const f = fixture(t);
  const result = await f.start("codex", { modeName: "full-access", config: { unsafe: true }, onStarted: async value => { f.events.push("started"); assert.equal(value.turnId, "initial-turn"); } });
  assert.deepEqual(result, { threadId: T, turnId: "initial-turn" });
  const options = f.calls.find(([m]) => m === "thread/start")[1];
  assert.equal(options.approvalPolicy, "on-request"); assert.equal(options.sandbox, "workspace-write"); assert.equal(options.approvalsReviewer, "user");
  assert.equal(options.config, undefined);
  assert.ok(f.events.indexOf("created") < f.events.indexOf("turn/start"));
  assert.ok(f.events.indexOf("turn/start") < f.events.indexOf("started"));
});

test("ordinary Codex start retains its existing automatic reviewer default", async t => {
  const f = fixture(t);
  await f.sessions.start("codex", { cwd: f.dir, text: "Owner task" });
  assert.equal(f.calls.find(([m]) => m === "thread/start")[1].approvalsReviewer, "auto_review");
});

for (const stage of ["discovery", "ownership"]) test(`Codex task revocation during ${stage} prevents its first turn`, async t => {
  let allowed = true;
  const f = fixture(t, stage === "discovery" ? { replies: { "model/list": () => { allowed = false; return { data: [] }; } } } : { ownerClaim: async () => { allowed = false; } });
  await assert.rejects(f.start("codex", { authorize: () => { if (!allowed) throw denied(); } }), { status: 401 });
  assert.equal(f.calls.some(([m]) => m === "turn/start"), false);
  if (stage === "discovery") assert.equal(f.calls.some(([m]) => m === "thread/start"), false);
  else assert.equal(f.events.includes("created"), true, "an already-created empty thread remains known");
});

test("a refused durable creation callback prevents the first Codex turn", async t => {
  const f = fixture(t);
  await assert.rejects(f.start("codex", { onCreated: async () => { throw Error("Ledger unavailable"); } }), /Ledger unavailable/);
  assert.equal(f.calls.some(([m]) => m === "turn/start"), false);
});

for (const method of ["thread/start", "turn/start"]) test(`a lost Codex ${method} answer is uncertain and never retried`, async t => {
  const f = fixture(t, { replies: { [method]: Error("Fixture connection lost") } });
  await assert.rejects(f.start("codex"), error => error.uncertain === true && error.retryable === false);
  assert.equal(f.calls.filter(([m]) => m === method).length, 1);
  assert.equal(f.calls.some(([m]) => m === "thread/archive"), false, "a potentially running task must remain discoverable for cancellation");
});

for (const method of ["thread/start", "turn/start"]) test(`an incomplete Codex ${method} answer is uncertain and never dispatched again`, async t => {
  const f = fixture(t, { replies: { [method]: {} } });
  await assert.rejects(f.start("codex"), error => error.uncertain === true && error.retryable === false);
  assert.equal(f.calls.filter(([m]) => m === method).length, 1);
  assert.equal(f.calls.some(([m]) => m === "thread/archive"), false);
  if (method === "thread/start") assert.equal(f.events.includes("created"), false);
});

test("a refused started callback interrupts the recorded Codex turn and returns its boundary", async t => {
  const f = fixture(t);
  await assert.rejects(f.start("codex", { onStarted: async () => { throw Error("Ledger commit failed"); } }), error =>
    error.message === "Ledger commit failed" && error.threadId === T && error.turnId === "initial-turn" && error.uncertain === true && error.retryable === false);
  assert.deepEqual(f.calls.at(-1), ["turn/interrupt", { threadId: T, turnId: "initial-turn" }]);
});

test("a late successful Codex turn returns its boundary for the manager to cancel", async t => {
  let allowed = true;
  const f = fixture(t, { replies: { "turn/start": () => { allowed = false; return { turn: { id: "initial-turn" } }; } } });
  const started = await f.start("codex", { authorize: () => { if (!allowed) throw denied(); } });
  assert.equal(started.turnId, "initial-turn");
  await f.sessions.stopCodingTask("codex", T, started);
  assert.deepEqual(f.calls.at(-1), ["turn/interrupt", { threadId: T, turnId: "initial-turn" }]);
});

test("Codex cancellation always addresses the recorded turn, never a newer owner turn", async t => {
  const f = fixture(t);
  const first = await f.start("codex");
  f.daemon.emit("turn/started", { threadId: T, turn: { id: "owner-turn" } });
  await f.sessions.stopCodingTask("codex", T, first);
  assert.deepEqual(f.calls.at(-1), ["turn/interrupt", { threadId: T, turnId: "initial-turn" }]);
  assert.equal(f.calls.some(([m]) => m === "thread/turns/list"), false);
});

for (const matching of [false, true]) test(`uncertain Codex cancellation ${matching ? "matches the initial marker" : "refuses another first message"}`, async t => {
  const f = fixture(t, { replies: { "thread/items/list": { data: [
    { turnId: "first-turn", item: { type: "userMessage", content: [{ type: "text", text: matching ? MARKER + "\nDo the work" : "Owner request" }] } },
    { turnId: "owner-turn", item: { type: "userMessage", content: [{ type: "text", text: MARKER }] } },
  ] } } });
  const result = await f.sessions.stopCodingTask("codex", T, { turnId: null, taskTextPrefix: MARKER });
  assert.equal(result.stopped, matching);
  const interrupted = f.calls.filter(([m]) => m === "turn/interrupt");
  assert.deepEqual(interrupted, matching ? [["turn/interrupt", { threadId: T, turnId: "first-turn" }]] : []);
});

test("delegated Claude start persists its identity before launch and keeps Manual permissions", async t => {
  const f = fixture(t);
  const started = await f.start("claude", { mode: "bypassPermissions", extra: ["--dangerous"] });
  assert.ok(started.threadId); assert.equal(started.turnId, null); assert.equal(typeof started.generation, "string");
  const proc = f.runs[0];
  assert.equal(proc.args[proc.args.indexOf("--permission-mode") + 1], "manual");
  assert.equal(proc.args.includes("--dangerous"), false);
  assert.ok(f.events.indexOf("created") < f.events.indexOf("claude/spawn"));
  assert.equal(f.events.includes("claude/import"), false);
  assert.deepEqual(await f.sessions.stopCodingTask("claude", started.threadId, started), { stopped: true });
});

for (const stage of ["discovery", "initialize"]) test(`Claude task revocation during ${stage} prevents user dispatch`, async t => {
  let allowed = true;
  const f = fixture(t, { claudeOptions: stage === "discovery" ? { locate: async () => { allowed = false; return "/fixture/claude"; } } : { initialized: () => { allowed = false; } } });
  await assert.rejects(f.start("claude", { authorize: () => { if (!allowed) throw denied(); } }), { status: 401 });
  assert.equal(f.events.includes("claude/user"), false);
  if (stage === "discovery") assert.equal(f.runs.length, 0);
});

test("a refused durable Claude callback never launches a child", async t => {
  const f = fixture(t);
  let failure;
  await assert.rejects(f.start("claude", { onCreated: () => { throw Error("Ledger unavailable"); } }), error => { failure = error; return error.message === "Ledger unavailable"; });
  assert.equal(f.runs.length, 0);
  assert.deepEqual(await f.sessions.stopCodingTask("claude", failure.threadId, { taskTextPrefix: MARKER }), { stopped: true, alreadyStopped: true });
});

test("a refused started callback interrupts only the newly dispatched Claude generation", async t => {
  const f = fixture(t);
  await assert.rejects(f.start("claude", { onStarted: async () => { throw Error("Ledger commit failed"); } }), error =>
    error.message === "Ledger commit failed" && typeof error.generation === "string" && error.uncertain === true && error.retryable === false);
  assert.equal(f.runs[0].lines.filter(m => m.request?.subtype === "interrupt").length, 1);
});

test("a late successful Claude dispatch returns its generation for cancellation", async t => {
  let allowed = true;
  const f = fixture(t, { onUser: () => { allowed = false; } });
  const started = await f.start("claude", { authorize: () => { if (!allowed) throw denied(); } });
  assert.equal(typeof started.generation, "string");
  assert.deepEqual(await f.sessions.stopCodingTask("claude", started.threadId, started), { stopped: true });
});

test("Claude marker cancellation recovers only the original local message", async t => {
  const f = fixture(t), started = await f.start("claude");
  assert.deepEqual(await f.sessions.stopCodingTask("claude", started.threadId, { taskTextPrefix: MARKER }), { stopped: true });
  await f.claudeHost.send(started.threadId, { text: "Another owner request" });
  const before = f.runs[0].lines.length;
  assert.deepEqual(await f.sessions.stopCodingTask("claude", started.threadId, { taskTextPrefix: MARKER }), { stopped: false, turnChanged: true });
  assert.equal(f.runs[0].lines.slice(before).some(m => m.request?.subtype === "interrupt"), false);
});

test("Claude marker cancellation refuses a later owner message that repeats the marker", async t => {
  const f = fixture(t), started = await f.start("claude");
  await f.claudeHost.send(started.threadId, { text: MARKER + "\nOwner follow-up" });
  const before = f.runs[0].lines.length;
  assert.deepEqual(await f.sessions.stopCodingTask("claude", started.threadId, { taskTextPrefix: MARKER }), { stopped: false, turnChanged: true });
  assert.equal(f.runs[0].lines.slice(before).some(m => m.request?.subtype === "interrupt"), false);
});

test("Claude with no local generation reports uncertain without starting or stopping a process", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.sessions.stopCodingTask("claude", T, { generation: "previous-host-message", taskTextPrefix: MARKER }), { stopped: false, uncertain: true });
  assert.equal(f.runs.length, 0);
});

test("an ended original Claude process is already stopped without resuming", async t => {
  const f = fixture(t), started = await f.start("claude");
  f.runs[0].kill();
  assert.deepEqual(await f.sessions.stopCodingTask("claude", started.threadId, started), { stopped: true, alreadyStopped: true });
  assert.equal(f.runs.length, 1);
});

test("Claude task cancellation refuses a later owner's message generation", async t => {
  const f = fixture(t), started = await f.start("claude");
  await f.claudeHost.send(started.threadId, { text: "A later owner request" });
  const before = f.runs[0].lines.length;
  assert.equal((await f.sessions.stopCodingTask("claude", started.threadId, started)).stopped, false);
  assert.equal(f.runs[0].lines.slice(before).some(m => m.request?.subtype === "interrupt"), false);
});

test("an owner message during Claude initialization prevents delegated dispatch and is never interrupted", async t => {
  let threadId, ownerSend;
  const f = fixture(t, { claudeOptions: { initialized: () => { ownerSend = f.claudeHost.send(threadId, { text: "Owner request during initialization" }); } } });
  await assert.rejects(f.start("claude", { onCreated: ({ threadId: id }) => { threadId = id; } }), { status: 409 });
  await ownerSend;
  const before = f.runs[0].lines.length;
  assert.deepEqual(await f.sessions.stopCodingTask("claude", threadId, { taskTextPrefix: MARKER }), { stopped: false, turnChanged: true });
  assert.equal(f.runs[0].lines.filter(m => m.type === "user").length, 1);
  assert.equal(f.runs[0].lines.slice(before).some(m => m.request?.subtype === "interrupt"), false);
});

test("owned Claude threads never warm, recheck restarted messages, or drain their outbox", async t => {
  let reads = 0;
  const outbox = createOutbox(), message = outbox.add(T, { text: "Must not recover", via: "app" });
  outbox.pause(T, message.id, "Reach restarted during delivery. Check the conversation before sending again; automatic retry is paused.");
  outbox.list(T)[0].restarted = true;
  const f = fixture(t, { sessionOptions: {
    recoveryAllowed: (_agent, id) => id !== T, outbox,
    claudeHost: { interrupted: () => [{ id: T, cwd: path.resolve(os.tmpdir()) }], onRelease() {}, close() {} },
    claude: { health: async () => ({ signedIn: true }), list: async () => [], read: async () => { reads++; throw Error("Must not read owned chat for recovery"); }, arrived: async () => { reads++; return false; } },
  } });
  f.sessions.warm();
  await pause(60);
  assert.equal(reads, 0);
  assert.equal(f.events.includes("claude/user"), false);
  assert.equal(outbox.list(T).length, 1);
});

test("taking task ownership during recovery discovery prevents continuation and retry", async t => {
  let allowed = true, sends = 0;
  const outbox = createOutbox();
  const f = fixture(t, { sessionOptions: {
    recoveryAllowed: () => allowed, outbox,
    claudeHost: { interrupted: () => [{ id: T, cwd: path.resolve(os.tmpdir()) }], onRelease() {}, send: async () => { sends++; }, close() {} },
    claude: { health: async () => ({ signedIn: true }), list: async () => [], read: async () => { allowed = false; return { session: { id: T } }; } },
  } });
  f.sessions.warm();
  await pause(60);
  assert.equal(sends, 0);
  assert.deepEqual(outbox.list(T), []);
});

test("taking task ownership during restart recheck leaves its paused queue untouched", async t => {
  let allowed = true;
  const outbox = createOutbox(), message = outbox.add(T, { text: "Check arrival", via: "app" });
  outbox.pause(T, message.id, "Reach restarted during delivery. Check the conversation before sending again; automatic retry is paused.");
  outbox.list(T)[0].restarted = true;
  fixture(t, { sessionOptions: {
    recoveryAllowed: () => allowed, outbox,
    claude: { health: async () => ({ signedIn: true }), list: async () => [], arrived: async () => { allowed = false; return false; } },
  } });
  await pause(30);
  assert.equal(outbox.list(T)[0].delivery, "paused");
  assert.equal(outbox.list(T)[0].restarted, true);
});
