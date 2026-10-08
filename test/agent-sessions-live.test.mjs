import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { codexHolder, codexMode, modelName, withTurnNotes } from "../server/agent-sessions/codex.mjs";
import { createAgentImages, imageKind } from "../server/agent-sessions/images.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const T = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

// Lets a background watch finish (its waits are instant in these tests).
const settled = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

test("a working shared Codex chat changes its native model without taking ownership", async () => {
  const daemon = fakeDaemon();
  const live = createCodexLive({ daemon });
  assert.deepEqual(await live.model(T, { model: "gpt-6-luna", effort: "high" }), { model: "gpt-6-luna", effort: "high", applied: true });
  assert.deepEqual(daemon.calls, [["thread/settings/update", { threadId: T, model: "gpt-6-luna", effort: "high" }]]);
  assert.equal(live.drives(T), false);
});

test("a shared Codex chat confirms native permissions instead of only saving a local label", async () => {
  const daemon = fakeDaemon();
  const live = createCodexLive({ daemon });
  assert.deepEqual(await live.mode(T, "auto"), { mode: "auto", applied: true });
  assert.deepEqual(daemon.calls, [["thread/settings/update", {
    threadId: T, approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":workspace",
  }]]);
  assert.equal(live.drives(T), false);
});

test("desktop-owned permission changes use its owner and cannot silently succeed on failure", async () => {
  const daemon = fakeDaemon({
    "thread/settings/update": new Error(`thread not found: ${T}`),
    "thread/resume": new Error("thread already has an active writer"),
  });
  let fail = false;
  const calls = [];
  const live = createCodexLive({ daemon, desktop: { async permissions(id, settings) {
    calls.push([id, settings]);
    if (fail) throw Error("not confirmed");
    return { applied: true };
  } } });
  await live.mode(T, "read-only");
  assert.deepEqual(calls, [[T, { approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":read-only" }]]);
  fail = true;
  await assert.rejects(live.mode(T, "auto"), /not confirmed/);
  assert.equal(live.drives(T), false);
  assert.ok(daemon.methods().every(m => ["thread/settings/update", "thread/resume"].includes(m)));
});

test("Codex questions accept nullable options and reject malformed or unoffered answers", async () => {
  const { describePrompt, answerFor } = await import("../server/agent-sessions/codex-live.mjs");
  const params = { threadId: T, questions: [{ id: "q", header: "", question: "Name?", options: null }] };
  const prompt = describePrompt("item/tool/requestUserInput", params);
  assert.deepEqual(answerFor(prompt, { answers: { q: ["example"] } }), { answers: { q: { answers: ["example"] } } });
  const choice = describePrompt("item/tool/requestUserInput", { ...params, questions: [{ ...params.questions[0], options: [{ label: "A" }] }] });
  assert.throws(() => answerFor(choice, { answers: { q: ["B"] } }));
  const daemon = fakeDaemon(), live = createCodexLive({ daemon });
  const rejected = await daemon.ask(2, "item/tool/requestUserInput", { ...params, questions: [] });
  assert.equal(rejected.error.code, -32602);
  assert.equal(live.view(T).prompts.length, 0);
  assert.match(live.view(T).error, /questions interface/);
});

test("an unloaded chat is resumed only when needed to save the model, then released", async () => {
  let loaded = false;
  const daemon = fakeDaemon({
    "thread/settings/update": () => loaded ? {} : new Error(`thread not found: ${T}`),
    "thread/resume": () => { loaded = true; return {}; },
  });
  const live = createCodexLive({ daemon });
  await live.model(T, { model: "gpt-6-luna" });
  assert.deepEqual(daemon.methods(), ["thread/settings/update", "thread/resume", "thread/settings/update", "thread/unsubscribe"]);
  assert.equal(live.drives(T), false);
});

test("a desktop writer routes model changes to its owner without interrupting or sending", async () => {
  const daemon = fakeDaemon({
    "thread/settings/update": new Error(`thread not found: ${T}`),
    "thread/resume": new Error("thread already has an active writer"),
  });
  const changes = [];
  const live = createCodexLive({ daemon, desktop: { async model(id, settings) {
    changes.push([id, settings]);
    return { ...settings, applied: true };
  } } });
  assert.deepEqual(await live.model(T, { model: "gpt-6-luna", effort: "high" }), { model: "gpt-6-luna", effort: "high", applied: true });
  assert.deepEqual(changes, [[T, { model: "gpt-6-luna", effort: "high" }]]);
  assert.deepEqual(daemon.methods(), ["thread/settings/update", "thread/resume"]);
  assert.equal(live.drives(T), false);
});

test("an unconfirmed desktop model change stays failed and never takes ownership", async () => {
  const daemon = fakeDaemon({
    "thread/settings/update": new Error(`thread not found: ${T}`),
    "thread/resume": new Error("thread already has an active writer"),
  });
  const live = createCodexLive({ daemon, desktop: { async model() {
    throw Object.assign(new Error("Codex didn't confirm the model change."), { status: 409 });
  } } });
  await assert.rejects(live.model(T, { model: "gpt-6-luna" }), (e) => e.status === 409);
  assert.deepEqual(daemon.methods(), ["thread/settings/update", "thread/resume"]);
  assert.equal(live.drives(T), false);
});

test("Stop can address the exact running app turn without taking over the thread", async () => {
  const daemon = fakeDaemon({ "thread/turns/list": { data: [{ id: "app-turn", status: "inProgress" }] } });
  const live = createCodexLive({ daemon });
  assert.deepEqual(await live.stop(T), { stopped: true });
  assert.deepEqual(daemon.calls.at(-1), ["turn/interrupt", { threadId: T, turnId: "app-turn" }]);
  assert.equal(live.drives(T), false);
  assert.ok(!daemon.methods().includes("thread/resume"));
});

test("queued Codex messages hide ambient input and removal must be confirmed", async () => {
  let deleted = false;
  const daemon = fakeDaemon({
    "thread/queue/list": () => ({ data: deleted ? [] : [{ id: "q1", input: [{ type: "text", text: '<in-app-browser-context>internal</in-app-browser-context>\n## My request:\nHi' }] }] }),
    "thread/queue/delete": () => ({ deleted }),
  });
  const live = createCodexLive({ daemon, queues: true });
  live.view(T);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(live.view(T).outbox[0].text, "Hi");
  await assert.rejects(live.cancelQueued(T, "q1"), (e) => e.status === 409);
  deleted = true;
  assert.deepEqual(await live.cancelQueued(T, "q1"), { deleted: true });
  assert.equal(live.view(T).outbox, undefined);
});

// A stand-in for the shared Codex daemon: canned replies per method, and
// hooks to push notifications and server requests the way Codex does.
function fakeDaemon(replies = {}) {
  const calls = [];
  let notify;
  let request;
  let closed;
  let ready;
  return {
    calls,
    methods: () => calls.map(([method]) => method),
    async rpc(method, params) {
      calls.push([method, params]);
      const reply = replies[method];
      const value = typeof reply === "function" ? reply(params) : reply;
      if (value instanceof Error) throw value;
      return value ?? {};
    },
    onNotification: (listener) => (notify = listener),
    onRequest: (handler) => (request = handler),
    onClose: (listener) => (closed = listener),
    onReady: (listener) => (ready = listener),
    ready: () => ready?.(),
    emit: (method, params) => notify({ method, params }),
    ask: (id, method, params) =>
      new Promise((resolve) => request({ id, method, params }, resolve, (error) => resolve({ error }))),
    close: () => closed(),
  };
}

test("continuing a Codex thread resumes it, streams the turn and lets it go after", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "turn-1" } } });
  const live = createCodexLive({ daemon });
  assert.deepEqual(await live.send(T, { text: "hi", model: "gpt-6-astra", effort: "high" }), { turnId: "turn-1" });
  assert.deepEqual(daemon.methods(), ["thread/resume", "turn/start"]);
  // The thread keeps its own approval and sandbox settings.
  assert.deepEqual(daemon.calls[0][1], { threadId: T, excludeTurns: true });
  const start = daemon.calls[1][1];
  assert.equal(start.input[0].text, "hi");
  assert.equal(start.model, "gpt-6-astra");
  assert.equal(start.effort, "high");
  assert.match(start.clientUserMessageId, /^[0-9a-f-]{36}$/);
  assert.equal(live.view(T).status, "running");
  assert.equal(live.drives(T), true);

  daemon.emit("item/started", { threadId: T, item: { type: "commandExecution", command: "npm test" } });
  assert.equal(live.view(T).activity, "Running npm test");
  daemon.emit("item/completed", { threadId: T, item: { id: "c1", type: "commandExecution" } });
  assert.equal(live.view(T).activity, null);
  daemon.emit("item/agentMessage/delta", { threadId: T, itemId: "m1", delta: "Hel" });
  daemon.emit("item/agentMessage/delta", { threadId: T, itemId: "m1", delta: "lo" });
  assert.equal(live.view(T).streaming, "Hello");
  daemon.emit("item/completed", { threadId: T, item: { id: "m1", type: "agentMessage" } });
  assert.equal(live.view(T).streaming, "");

  daemon.emit("turn/completed", { threadId: T, turn: { id: "turn-1", status: "completed" } });
  assert.equal(live.view(T).status, "idle");
  // Released so the daemon can unload it and the Codex app can take it back.
  assert.equal(live.drives(T), false);
  assert.deepEqual(daemon.calls.at(-1), ["thread/unsubscribe", { threadId: T }]);
});

test("typing while Codex works steers the running turn", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "turn-1" } } });
  const live = createCodexLive({ daemon });
  await live.send(T, { text: "first" });
  daemon.emit("turn/started", { threadId: T, turn: { id: "turn-1" } });
  assert.deepEqual(await live.send(T, { text: "also this" }), { steered: true });
  const [method, params] = daemon.calls.at(-1);
  assert.equal(method, "turn/steer");
  assert.equal(params.expectedTurnId, "turn-1");
  assert.equal(params.input[0].text, "also this");
});

test("a thread open in the Codex app gets the message through Codex's queue", async () => {
  let looks = 0;
  const daemon = fakeDaemon({
    "thread/resume": new Error(`thread ${T} already has an active writer`),
    "thread/queue/add": { queuedSubmission: { id: "q1" } },
    "thread/queue/list": () => (++looks < 3 ? { data: [{ id: "q1" }] } : { data: [] }),
  });
  const live = createCodexLive({ daemon, wait: async () => {} });
  // The phone has its answer once it's in the queue (no wait for the app).
  assert.deepEqual(await live.send(T, { text: "from the phone" }), { queued: true, delivered: false, messageId: "q1" });
  await settled();
  // The Codex app took it: nothing taken back, nothing left on the phone.
  assert.ok(!daemon.methods().includes("thread/queue/delete"));
  assert.equal(live.view(T).outbox, undefined);
  const add = daemon.calls.find(([m]) => m === "thread/queue/add")[1];
  assert.equal(add.threadId, T);
  assert.equal(add.input[0].text, "from the phone");
  assert.equal(live.drives(T), false);
  assert.ok(!daemon.methods().includes("turn/start"));
});

test("a queued message nobody takes is taken back and stays on the phone saying why, unless a turn is running there", async () => {
  const held = (turn) => {
    let clock = 0;
    const daemon = fakeDaemon({
      "thread/resume": new Error("already has a live local writer"),
      "thread/queue/add": { queuedSubmission: { id: "q1" } },
      "thread/queue/list": { data: [{ id: "q1" }] },
      "thread/turns/list": { data: [turn] },
      "thread/queue/delete": { deleted: true },
    });
    const live = createCodexLive({ daemon, wait: async () => {}, now: () => (clock += 1000), deliverMs: 3000 });
    return { daemon, live };
  };
  const idle = held({ id: "t0", status: "completed", completedAt: 5 });
  // Answered at once; nothing fails on the phone after 10 s.
  assert.deepEqual(await idle.live.send(T, { text: "hi" }), { queued: true, delivered: false, messageId: "q1" });
  await settled();
  assert.ok(idle.daemon.calls.some(([m, p]) => m === "thread/queue/delete" && p.queuedSubmissionId === "q1"));
  // Taken back, it stays on the phone with its text and why, until dismissed.
  const [back] = idle.live.view(T).outbox;
  assert.equal(back.id, "q1");
  assert.equal(back.text, "hi");
  assert.match(back.error, /Codex app/);
  assert.deepEqual(await idle.live.cancelQueued(T, "q1"), { deleted: true });
  assert.equal(idle.live.view(T).outbox, undefined);

  const busy = held({ id: "t1", status: "inProgress", completedAt: null });
  assert.deepEqual(await busy.live.send(T, { text: "hi" }), { queued: true, delivered: false, messageId: "q1" });
  await settled();
  assert.ok(!busy.daemon.methods().includes("thread/queue/delete"));
  // How a turn the Codex app is running reads from its file (verified).
  const elsewhere = held({ id: "t2", status: "interrupted", completedAt: null });
  assert.deepEqual(await elsewhere.live.send(T, { text: "hi" }), { queued: true, delivered: false, messageId: "q1" });
  await settled();
  assert.ok(!elsewhere.daemon.methods().includes("thread/queue/delete"));
});

test("prompts show on the phone and take only the choices Codex offered", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "turn-1" } } });
  const live = createCodexLive({ daemon });
  await live.send(T, { text: "clean up" });
  const answered = daemon.ask(7, "item/commandExecution/requestApproval", {
    threadId: T,
    turnId: "turn-1",
    command: ["rm", "-rf", "build"],
    availableDecisions: ["accept", "decline"],
  });
  const view = live.view(T);
  assert.equal(view.status, "waiting");
  assert.equal(view.prompts[0].command, "rm -rf build");
  assert.deepEqual(view.prompts[0].decisions, ["accept", "decline"]);
  assert.equal(view.prompts[0].resolve, undefined);
  await assert.rejects(() => live.respond(T, "7", { decision: "acceptForSession" }), /not available/);
  await live.respond(T, "7", { decision: "accept" });
  assert.deepEqual(await answered, { decision: "accept" });
  assert.equal(live.view(T).prompts.length, 0);
  assert.equal(live.view(T).status, "running");
  await assert.rejects(() => live.respond(T, "7", { decision: "accept" }), (e) => e.status === 409);

  const question = daemon.ask(8, "item/tool/requestUserInput", {
    threadId: T,
    questions: [{ id: "q", header: "Deploy", question: "Which target?", options: [{ label: "staging" }] }],
  });
  await assert.rejects(() => live.respond(T, "8", { answers: {} }), /Answer every question/);
  await live.respond(T, "8", { answers: { q: ["staging"] } });
  assert.deepEqual(await question, { answers: { q: { answers: ["staging"] } } });

  // Answered in another window: the card goes away here too.
  void daemon.ask(9, "item/fileChange/requestApproval", { threadId: T, fileChanges: { "a.txt": {} } });
  assert.equal(live.view(T).prompts.length, 1);
  daemon.emit("serverRequest/resolved", { threadId: T, requestId: 9 });
  assert.equal(live.view(T).prompts.length, 0);

  assert.deepEqual((await daemon.ask(10, "account/login/chatgptAuthTokens/refresh", { threadId: T })).error.code, -32601);
});

test("a lost connection forgets what Reach was driving", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "turn-1" } } });
  const live = createCodexLive({ daemon });
  await live.send(T, { text: "go" });
  daemon.close();
  assert.equal(live.drives(T), false);
  assert.match(live.view(T).error, /Lost the connection/);
  await live.send(T, { text: "again" });
  assert.equal(daemon.methods().filter((m) => m === "thread/resume").length, 2);
});

test("a turn that ends before its start reply stays ended, with its error", async () => {
  let daemon;
  daemon = fakeDaemon({
    "turn/start": () => {
      daemon.emit("turn/started", { threadId: T, turn: { id: "t9" } });
      daemon.emit("turn/completed", {
        threadId: T,
        turn: { id: "t9", status: "failed", error: { message: "You've hit your usage limit." } },
      });
      return { turn: { id: "t9" } };
    },
  });
  const live = createCodexLive({ daemon });
  await live.send(T, { text: "x" });
  assert.equal(live.view(T).status, "idle");
  assert.equal(live.view(T).error, "You've hit your usage limit.");
  assert.equal(live.drives(T), false);
});

test("long polls wake on a change, on time, or when the phone leaves", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "turn-1" } } });
  const live = createCodexLive({ daemon });
  await live.send(T, { text: "go" });
  const version = live.view(T).version;
  // Already behind: answers at once.
  await live.changes(T, version - 1, 60000);
  const woken = live.changes(T, version, 60000);
  daemon.emit("item/agentMessage/delta", { threadId: T, itemId: "m", delta: "x" });
  await woken;
  assert.ok(live.view(T).version > version);
  await live.changes(T, live.view(T).version, 5);
  const gone = new AbortController();
  const waiting = live.changes(T, live.view(T).version, 60000, gone.signal);
  gone.abort();
  await waiting;
});

test("starting a session from Reach names it and applies the chosen settings", async () => {
  const daemon = fakeDaemon({
    "thread/start": { thread: { id: T } },
    "turn/start": { turn: { id: "turn-1" } },
  });
  const live = createCodexLive({ daemon });
  const r = await live.start({
    cwd: "/Users/me/app",
    text: "Add tests",
    images: ["/data/agent-images/a.png"],
    model: "gpt-6-sol",
    effort: "low",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    name: "Tests",
  });
  assert.deepEqual(r, { threadId: T, turnId: "turn-1" });
  assert.deepEqual(daemon.methods(), ["thread/start", "thread/name/set", "turn/start"]);
  assert.deepEqual(daemon.calls[0][1], {
    cwd: "/Users/me/app",
    serviceName: "reach",
    model: "gpt-6-sol",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  assert.deepEqual(daemon.calls[2][1].input[1], { type: "localImage", path: "/data/agent-images/a.png" });
  assert.equal(daemon.calls[2][1].effort, "low");
  await assert.rejects(live.start({ cwd: "relative", text: "x" }), /Choose a folder/);
  await assert.rejects(live.send(T, { text: "  " }), /Write a message/);
  await assert.rejects(live.send("not-an-id", { text: "x" }), (e) => e.status === 404);
  await assert.rejects(createCodexLive({ daemon: fakeDaemon() }).stop(T), (e) => e.status === 409);
});

test("turn errors and stops appear where they happened", () => {
  const items = [
    { id: "u1", role: "user", turnId: "t1" },
    { id: "a1", role: "assistant", turnId: "t1" },
    { id: "u2", role: "user", turnId: "t2" },
    { id: "u3", role: "user", turnId: "t3" },
  ];
  const turns = [
    { id: "t1", status: "failed", error: { message: "Usage limit", codexErrorInfo: "usageLimitExceeded" } },
    { id: "t2", status: "interrupted" },
    { id: "t3", status: "failed", error: { message: "Boom" } },
  ];
  assert.deepEqual(
    withTurnNotes(items, turns).map((i) => i.id),
    ["u1", "a1", "t1:error", "u2", "t2:stopped", "u3", "t3:error"],
  );
  assert.equal(withTurnNotes(items, turns)[2].detail, "usageLimitExceeded");
  // An older page may cut a turn in half: nothing after its last item.
  assert.deepEqual(withTurnNotes(items, turns, { olderPage: true }).at(-1).id, "u3");
  // A turn still running elsewhere gets no "Stopped".
  assert.deepEqual(
    withTurnNotes(items.slice(0, 3), turns, { runningTurn: "t2" }).map((i) => i.id),
    ["u1", "a1", "t1:error", "u2"],
  );
  assert.equal(modelName("GPT-6-Astra"), "GPT-6 Astra");
  assert.equal(modelName("GPT-5.6-Sol"), "GPT-5.6 Sol");
});

test("who holds a Codex thread: the app, a terminal, or nobody", async () => {
  const locks = await fs.mkdtemp(path.join(os.tmpdir(), "reach-locks-"));
  try {
    assert.equal(await codexHolder(T, { locks, run: async () => assert.fail("no lock, no lookup") }), null);
    await fs.writeFile(path.join(locks, `${T}.lock`), "");
    // lsof is asked about Codex's processes only (pgrep), never every process.
    const machine = (own, parent) => async (cmd, args) => {
      if (cmd.endsWith("lsof")) assert.deepEqual(args.slice(0, 4), ["-nP", "-a", "-p", "660,4242"]);
      return {
        stdout: cmd.endsWith("pgrep") ? "660\n4242\n" : cmd.endsWith("lsof") ? "p4242\nf42\n" : args.includes("command=") ? parent : own,
      };
    };
    assert.equal(
      await codexHolder(T, {
        locks,
        run: machine(" 660 ?? /Applications/ChatGPT.app/.../codex app-server", "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n"),
      }),
      "codex-app",
    );
    assert.equal(
      await codexHolder(T, { locks, run: machine(" 1 ?? /Users/me/.codex/packages/app-server-daemon/bin/codex", "") }),
      "daemon",
    );
    assert.equal(await codexHolder(T, { locks, run: machine(" 77 ttys004 codex resume", "-zsh\n") }), "terminal");
    assert.equal(
      await codexHolder(T, { locks, run: async () => Promise.reject(Object.assign(new Error("exit 1"), { code: 1 })) }),
      null,
    );
    // No Codex running at all: nobody holds it, and lsof isn't run.
    assert.equal(
      await codexHolder(T, { locks, run: async (cmd) => (cmd.endsWith("pgrep") ? Promise.reject(Object.assign(new Error("exit 1"), { code: 1 })) : assert.fail("no lsof")) }),
      null,
    );
  } finally {
    await fs.rm(locks, { recursive: true, force: true });
  }
});

test("images are typed by their bytes, kept privately and referenced by id", async () => {
  assert.equal(imageKind(PNG), "png");
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpg");
  assert.equal(imageKind(Buffer.from("GIF89a\0\0\0\0\0\0")), "gif");
  assert.equal(imageKind(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(imageKind(Buffer.from("\0\0\0\x18ftypheic\0\0\0\0")), "heic");
  assert.equal(imageKind(Buffer.from("#!/bin/sh\necho hi")), null);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-images-"));
  try {
    const converted = [];
    const images = createAgentImages({
      dir: path.join(root, "images"),
      run: async (cmd, args) => {
        converted.push(cmd);
        await fs.writeFile(args.at(-1), "jpeg");
      },
    });
    await fs.writeFile(path.join(root, "upload-1"), PNG);
    const id = await images.add(path.join(root, "upload-1"));
    assert.match(id, /^[0-9a-f-]{36}\.png$/);
    assert.deepEqual(images.paths([id]), [path.join(root, "images", id)]);
    await fs.writeFile(path.join(root, "upload-2"), Buffer.from("\0\0\0\x18ftypheic\0\0\0\0"));
    assert.match(await images.add(path.join(root, "upload-2")), /\.jpg$/);
    assert.deepEqual(converted, ["/usr/bin/sips"]);
    await fs.writeFile(path.join(root, "upload-3"), "not an image");
    await assert.rejects(images.add(path.join(root, "upload-3")), /PNG, JPEG/);
    await assert.rejects(fs.stat(path.join(root, "upload-3")));
    assert.throws(() => images.paths(["../../etc/passwd"]), /Unknown image/);
    assert.throws(() => images.paths([`${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.png`]), /gone/);
    assert.throws(() => images.paths(new Array(9).fill(id)), /up to 8/);
    assert.deepEqual(images.paths(undefined), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reply, approve, stop and start routes are owner-only and checked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-session-routes-"));
  const seen = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [{ agent: "codex", id: T }], errors: {} }),
      health: async () => [],
      read: async (agent, id, { before }) => ({ session: { agent, id }, items: [{ id: before || "newest" }], before: "older" }),
      send: async (agent, id, body) => (seen.push(["send", agent, id, body]), { turnId: "t1" }),
      answerQuestions: async (agent, id, body) => (seen.push(["answerQuestions", agent, id, body]), { answered: true }),
      start: async (agent, body) => (seen.push(["start", agent, body]), { threadId: T }),
      respond: async (agent, id, prompt, answer) => (seen.push(["respond", prompt, answer]), { answered: true }),
      stop: async () => ({ stopped: true }),
      model: async (agent, id, choice) => (seen.push(["model", agent, id, choice]), { ...choice, applied: true }),
      mode: async (agent, id, { mode }) => (seen.push(["mode", agent, mode]), { mode, applied: true }),
      models: async (agent) => ({ models: [{ id: `${agent}-model` }], mode: "guardian-approvals" }),
      commands: async (agent) => (agent === "claude" ? [{ name: "compact", description: "Summarize", hint: "" }] : []),
      view: () => ({ version: 3, status: "running", prompts: [] }),
      changes: async () => {},
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files", "codex"], "agent");
  const call = (route, token, body, method = body === undefined ? "GET" : "POST") =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "shot.png");
    assert.equal((await call("/api/sessions/images", agent.token, form)).status, 403);
    const uploaded = await call("/api/sessions/images", owner.token, form);
    assert.equal(uploaded.status, 200);
    const { id } = await uploaded.json();

    assert.equal((await call(`/api/sessions/codex/${T}/model`, agent.token, { model: "gpt-6-luna" })).status, 403);
    assert.deepEqual(await (await call(`/api/sessions/codex/${T}/model`, owner.token, { model: "gpt-6-luna", effort: "high" })).json(), { model: "gpt-6-luna", effort: "high", applied: true });
    assert.equal((await call(`/api/sessions/codex/${T}/model`, owner.token, { model: "" })).status, 400);
    assert.deepEqual(seen.filter(([kind]) => kind === "model"), [["model", "codex", T, { model: "gpt-6-luna", effort: "high" }]]);

    // A permission mode picked on the phone, picked in the Claude app too: the
    // owner's call only, and never Bypass permissions.
    assert.equal((await call(`/api/sessions/claude/${T}/mode`, agent.token, { mode: "plan" })).status, 403);
    assert.deepEqual(await (await call(`/api/sessions/claude/${T}/mode`, owner.token, { mode: "plan" })).json(), { mode: "plan", applied: true });
    assert.equal((await call(`/api/sessions/claude/${T}/mode`, owner.token, { mode: "bypassPermissions" })).status, 400);
    assert.deepEqual(seen.filter(([kind]) => kind === "mode"), [["mode", "claude", "plan"]]);
    assert.equal((await call(`/api/sessions/codex/${T}/messages`, agent.token, { text: "hi" })).status, 403);
    const reply = { turnId: "t1", answers: [{ index: 0, answer: "Phone" }] };
    assert.equal((await call(`/api/sessions/codex/${T}/questions/q1`, agent.token, reply)).status, 403);
    assert.deepEqual(await (await call(`/api/sessions/codex/${T}/questions/q1`, owner.token, reply)).json(), { answered: true });
    assert.deepEqual(seen.filter(([kind]) => kind === "answerQuestions"), [["answerQuestions", "codex", T, { itemId: "q1", ...reply }]]);
    const sent = await call(`/api/sessions/codex/${T}/messages`, owner.token, {
      text: "look at this",
      images: [id],
      model: "gpt-6-astra",
      effort: "xhigh",
    });
    assert.equal(sent.status, 200);
    const body = seen.find(([kind]) => kind === "send")[3];
    assert.equal(body.text, "look at this");
    assert.equal(body.images[0], path.join(root, ".reach", "agent-images", id));
    assert.equal(body.effort, "xhigh");
    assert.equal((await call(`/api/sessions/codex/${T}/messages`, owner.token, { text: "x", effort: "turbo" })).status, 400);
    // Claude Code's ids carry brackets.
    assert.equal(
      (await call(`/api/sessions/claude/${T}/messages`, owner.token, { text: "x", model: "claude-fable-5-1[1m]" })).status,
      200,
    );
    assert.equal(seen.filter(([kind]) => kind === "send").at(-1)[3].model, "claude-fable-5-1[1m]");
    assert.equal((await call(`/api/sessions/codex/${T}/messages`, owner.token, { text: "x", model: "a b" })).status, 400);
    // Each agent's own permission modes, nothing else.
    assert.equal((await call(`/api/sessions/codex/${T}/messages`, owner.token, { text: "x", mode: "full-access" })).status, 200);
    assert.equal(seen.filter(([kind]) => kind === "send").at(-1)[3].mode, "full-access");
    assert.equal((await call(`/api/sessions/codex/${T}/messages`, owner.token, { text: "x", mode: "plan" })).status, 400);
    assert.equal((await call(`/api/sessions/claude/${T}/messages`, owner.token, { text: "x", mode: "plan" })).status, 200);
    assert.deepEqual(await (await call("/api/sessions/commands?agent=claude", owner.token)).json(), {
      commands: [{ name: "compact", description: "Summarize", hint: "" }],
    });
    assert.equal((await call(`/api/sessions/codex/${T}/messages`, owner.token, { text: "x", images: ["../x.png"] })).status, 400);

    // Polls that find nothing new get a few bytes back, not the same data.
    const list = await (await call("/api/sessions", owner.token)).json();
    assert.match(list.version, /^[\w-]{16}$/);
    assert.deepEqual(await (await call(`/api/sessions?known=${list.version}`, owner.token)).json(), {
      unchanged: true,
      version: list.version,
    });
    assert.equal((await (await call("/api/sessions?known=stale", owner.token)).json()).sessions.length, 1);
    const newest = await (await call(`/api/sessions/codex/${T}`, owner.token)).json();
    assert.deepEqual(await (await call(`/api/sessions/codex/${T}?known=${newest.version}`, owner.token)).json(), {
      unchanged: true,
      version: newest.version,
    });
    // Older pages always come back whole.
    const older = await (await call(`/api/sessions/codex/${T}?before=older&known=${newest.version}`, owner.token)).json();
    assert.deepEqual(older.items, [{ id: "older" }]);
    assert.equal(older.version, undefined);
    assert.equal((await call(`/api/sessions/codex/${T}/prompts/7`, owner.token, { decision: "accept" })).status, 200);
    assert.deepEqual(seen.find(([kind]) => kind === "respond").slice(1), ["7", { decision: "accept" }]);
    assert.equal((await call(`/api/sessions/codex/${T}/stop`, owner.token, {})).status, 200);
    assert.deepEqual(await (await call(`/api/sessions/codex/${T}/live?since=2`, owner.token)).json(), {
      version: 3,
      status: "running",
      prompts: [],
    });
    // Something new and nothing streaming: answered at once (each wake used
    // to wait a fixed 60 ms first).
    const asked = performance.now();
    await (await call(`/api/sessions/codex/${T}/live?since=2`, owner.token)).json();
    assert.ok(performance.now() - asked < 45, `answered in ${Math.round(performance.now() - asked)} ms`);
    assert.deepEqual(await (await call("/api/sessions/models?agent=codex", owner.token)).json(), {
      models: [{ id: "codex-model" }],
      mode: "guardian-approvals",
    });

    assert.equal((await call("/api/sessions", owner.token, { agent: "codex", cwd: "/etc", text: "x" })).status, 400);
    assert.equal((await call("/api/sessions", owner.token, { agent: "codex", cwd: "relative", text: "x" })).status, 400);
    assert.equal(
      (await call("/api/sessions", owner.token, { agent: "codex", cwd: os.homedir(), text: "x", mode: "everything" })).status,
      400,
    );
    const started = await call("/api/sessions", owner.token, {
      agent: "codex",
      cwd: os.homedir(),
      text: "Add tests",
      mode: "guardian-approvals",
    });
    assert.equal(started.status, 200);
    const start = seen.find(([kind]) => kind === "start");
    assert.equal(start[2].cwd, await fs.realpath(os.homedir()));
    // "Approve for me", as the Codex app sends it.
    assert.equal(start[2].approvalPolicy, "on-request");
    assert.equal(start[2].sandbox, "workspace-write");
    assert.equal(start[2].approvalsReviewer, "auto_review");
  } finally {
    reach.server.close();
    await reach.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex modes read like the app's permissions menu", () => {
  assert.equal(codexMode(null), null);
  assert.equal(
    codexMode({ activePermissionProfile: { id: ":workspace" }, approvalPolicy: "on-request", approvalsReviewer: "auto_review" }),
    "guardian-approvals",
  );
  assert.equal(codexMode({ activePermissionProfile: { id: ":workspace" }, approvalPolicy: "on-request", approvalsReviewer: "user" }), "auto");
  assert.equal(codexMode({ activePermissionProfile: { id: ":danger-full-access" }, approvalPolicy: "never" }), "full-access");
  assert.equal(codexMode({ activePermissionProfile: { id: ":read-only" }, approvalPolicy: "never", approvalsReviewer: "user" }), "read-only");
  assert.equal(codexMode({ activePermissionProfile: { id: ":workspace" }, approvalPolicy: "untrusted" }), "custom");
  assert.equal(codexMode({ activePermissionProfile: { id: "network-only" }, approvalPolicy: "on-request", approvalsReviewer: "user" }), "profile:network-only");
});

test("Codex threads another engine is running show as running; idle or old ones don't", async () => {
  const { codexRunningElsewhere } = await import("../server/agent-sessions/codex.mjs");
  const locks = await fs.mkdtemp(path.join(os.tmpdir(), "reach-running-"));
  const now = 1_000_000_000;
  const ids = ["a", "b", "c", "d"].map((x) => `0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeee${x}`);
  for (const id of ids.slice(0, 3)) await fs.writeFile(path.join(locks, `${id}.lock`), "");
  const turns = {
    [ids[0]]: { status: "interrupted", completedAt: null }, // running in the Codex app (verified shape)
    [ids[1]]: { status: "completed", completedAt: 5 },
    [ids[2]]: { status: "interrupted", completedAt: null },
  };
  const asked = [];
  const daemon = { rpc: async (method, { threadId }) => (asked.push(threadId), { data: [turns[threadId]] }) };
  const check = codexRunningElsewhere({ daemon, locks, now: () => now });
  const sessions = [
    { id: ids[0], status: "idle", updatedAt: now - 60_000 },
    { id: ids[1], status: "idle", updatedAt: now - 60_000 },
    { id: ids[2], status: "idle", updatedAt: now - 3_600_000 }, // locked but long quiet: not checked
    { id: ids[3], status: "idle", updatedAt: now - 1_000 }, // nobody holds it
  ];
  try {
    assert.deepEqual((await check(sessions)).map((s) => s.status), ["running", "idle", "idle", "idle"]);
    assert.deepEqual(asked, [ids[0], ids[1]]);
    // Checked again only after a few seconds.
    await check(sessions.map((s) => ({ ...s, status: "idle" })));
    assert.equal(asked.length, 2);
  } finally {
    await fs.rm(locks, { recursive: true, force: true });
  }
});

test("the agents' logos come from the installed apps, made small once, missing apps skipped", async () => {
  const { createLogos } = await import("../server/agent-sessions/logos.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-logos-"));
  const app = path.join(dir, "Codex.png");
  await fs.writeFile(app, PNG);
  const converted = [];
  const logos = createLogos({
    dataDir: dir,
    platform: "darwin",
    sources: { codex: { file: app, size: 128 }, claude: { file: path.join(dir, "missing.icns"), size: 128 } },
    run: async (cmd, args) => {
      converted.push([cmd, ...args.slice(0, 4)]);
      await fs.writeFile(args.at(-1), PNG);
    },
  });
  try {
    const first = await logos();
    assert.deepEqual(Object.keys(first.logos), ["codex"]);
    assert.equal(first.logos.codex, `data:image/png;base64,${PNG.toString("base64")}`);
    assert.deepEqual(converted, [["/usr/bin/sips", "-s", "format", "png", "-Z"]]);
    // Same files, same answer, no second conversion.
    assert.deepEqual(await logos(), first);
    assert.equal(converted.length, 1);
    // An app update changes the version.
    await fs.writeFile(app, Buffer.concat([PNG, Buffer.from("v2")]));
    assert.notEqual((await logos()).version, first.version);
    // Not a Mac: no logos, names instead.
    assert.deepEqual((await createLogos({ dataDir: dir, platform: "linux", sources: { codex: { file: app, size: 128 } } })()).logos, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("messages waiting in the Codex app's own queue show on the phone, read when it looks and when Codex says the queue changed", async () => {
  let queue = [
    { id: "q1", clientUserMessageId: "c1", input: [{ type: "text", text: "Then run the tests" }, { type: "localImage", path: "/tmp/a.png" }] },
  ];
  let clock = 1_000_000;
  const daemon = fakeDaemon({ "thread/queue/list": () => ({ data: queue }) });
  const live = createCodexLive({ daemon, queues: true, now: () => clock });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  // A fresh page looks: the queue is read, and the view wakes with it.
  assert.equal(live.view(T).outbox, undefined);
  const before = live.view(T).version;
  await settle();
  assert.deepEqual(live.view(T).outbox, [{ id: "q1", text: "Then run the tests", images: 1 }]);
  assert.ok(live.view(T).version > before);
  // Looked at again soon after: not read again.
  const reads = () => daemon.methods().filter((m) => m === "thread/queue/list").length;
  assert.equal(reads(), 1);
  // Codex says the queue changed (the app ran it): read again, and gone.
  queue = [];
  daemon.emit("thread/queue/changed", { threadId: T });
  await settle();
  assert.equal(reads(), 2);
  assert.equal(live.view(T).outbox, undefined);
  // Unreadable (Codex closed): what was shown stays, nothing breaks.
  clock += 10_000;
  const failing = createCodexLive({ daemon: fakeDaemon({ "thread/queue/list": new Error("closed") }), queues: true, now: () => clock });
  failing.view(T);
  await settle();
  assert.equal(failing.view(T).outbox, undefined);
});


test("resolved or closed requests cannot leave decorative approval buttons", async () => {
  const daemon = fakeDaemon();
  const live = createCodexLive({ daemon });
  void daemon.ask(17, "item/commandExecution/requestApproval", { threadId: T, command: "echo check" });
  daemon.emit("serverRequest/resolved", { requestId: "17" });
  assert.deepEqual(live.view(T).prompts, []);
  await assert.rejects(live.respond(T, "17", { decision: "accept" }), (e) => e.status === 409);
  void daemon.ask(18, "item/tool/requestUserInput", { threadId: T, questions: [{ id: "q", question: "Which?" }] });
  daemon.emit("thread/closed", { threadId: T });
  assert.deepEqual(live.view(T).prompts, []);
  await assert.rejects(live.respond(T, "18", { answers: { q: ["first"] } }), (e) => e.status === 409);
});

test("approval stays pending until delivery is known, and uncertain delivery cannot be replayed", async () => {
  const daemon = fakeDaemon();
  let request;
  daemon.onRequest = (handler) => request = handler;
  const live = createCodexLive({ daemon });
  let deliver;
  let fail;
  let attempts = 0;
  request({ id: 19, method: "item/commandExecution/requestApproval", params: { threadId: T, command: "echo test" } }, () => {
    attempts++;
    return new Promise((resolve, reject) => { deliver = resolve; fail = reject; });
  });
  const first = live.respond(T, "19", { decision: "accept" });
  assert.equal(live.view(T).prompts.length, 1, "still pending while sending");
  await assert.rejects(live.respond(T, "19", { decision: "accept" }), /already being sent/);
  fail(new Error("Connection lost"));
  await assert.rejects(first, /Connection lost/);
  assert.equal(live.view(T).prompts.length, 1);
  await assert.rejects(live.respond(T, "19", { decision: "accept" }), /already attempted/);
  assert.equal(attempts, 1);
  assert.equal(live.view(T).prompts[0].attempted, true);
  daemon.emit("serverRequest/resolved", { requestId: 19 });
  assert.deepEqual(live.view(T).prompts, []);
});

test("uncertain queue cancellation never recommends resending a possibly accepted message", async () => {
  const daemon = fakeDaemon({
    "thread/resume": new Error("already has an active writer"),
    "thread/queue/add": { queuedSubmission: { id: "q1" } },
    "thread/turns/list": { data: [] },
    "thread/queue/delete": new Error("socket lost"),
  });
  const live = createCodexLive({ daemon, deliverMs: 0 });
  await live.send(T, { text: "once" });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(live.view(T).error, /did not confirm/);
  assert.equal(live.view(T).outbox, undefined, "an uncertain cancellation never returns a resendable message");
  assert.equal(daemon.methods().filter(m => m === "thread/queue/add").length, 1);
});

test("completion of an older Codex turn cannot finish a newer turn", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "new" } } });
  const live = createCodexLive({ daemon });
  await live.send(T, { text: "new" });
  daemon.emit("turn/completed", { threadId: T, turn: { id: "old", status: "completed" } });
  assert.equal(live.view(T).status, "running");
  assert.equal(live.view(T).turnId, "new");
});

test("permission scope is visible and native-only elicitation cannot accept an empty form", async () => {
  const { describePrompt, answerFor } = await import("../server/agent-sessions/codex-live.mjs");
  const permissions = { network: { enabled: true }, fileSystem: { write: ["/example"] } };
  const prompt = describePrompt("item/permissions/requestApproval", { permissions });
  assert.deepEqual(JSON.parse(prompt.command), permissions);
  for (const mode of ["form", "url", "openai/userVerification", "future-mode"]) {
    const p = describePrompt("mcpServer/elicitation/request", { mode, requestedSchema: {}, serverName: "tool" });
    assert.deepEqual(p.decisions, ["decline", "cancel"]);
    assert.throws(() => answerFor(p, { decision: "accept" }));
  }
});

test("Computer Use's empty MCP form offers Yes and answers only an explicit phone response", async () => {
  const daemon = fakeDaemon();
  const live = createCodexLive({ daemon });
  let answered = false;
  const result = daemon.ask(71, "mcpServer/elicitation/request", {
    threadId: T, serverName: "cua_repl", mode: "form",
    message: 'Allow Computer Use to use "Google Chrome"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use", persist: ["session", "always"] },
  }).then(value => { answered = true; return value; });
  const prompt = live.view(T).prompts[0];
  assert.deepEqual(prompt.decisions, ["accept", "decline", "cancel"]);
  assert.equal(prompt.reason, undefined);
  await settled();
  assert.equal(answered, false);
  await live.respond(T, "71", { decision: "accept", content: { injected: true }, _meta: { persist: "always" } });
  assert.deepEqual(await result, { action: "accept", content: {} });
  assert.equal(live.view(T).prompts.length, 0);
  await assert.rejects(live.respond(T, "71", { decision: "accept" }), /already answered/);
});

test("an uncertain Codex approval cannot be resubmitted from an apparently actionable card", async () => {
  let receive, writes = 0;
  const daemon = fakeDaemon();
  daemon.onRequest = handler => { receive = handler; };
  const live = createCodexLive({ daemon });
  receive({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: T, command: "example" } },
    async () => { writes++; throw Error("delivery unknown"); });
  await assert.rejects(live.respond(T, "7", { decision: "accept" }), /delivery unknown/);
  assert.equal(live.view(T).prompts[0].attempted, true);
  await assert.rejects(live.respond(T, "7", { decision: "accept" }), /already attempted/);
  assert.equal(writes, 1);
});

test("required fields, device proofs and specialized native confirmations never become empty approvals", async () => {
  const { describePrompt, answerFor } = await import("../server/agent-sessions/codex-live.mjs");
  const base = { serverName: "cua_repl", mode: "form", requestedSchema: { type: "object", properties: {} } };
  for (const extra of [
    { requestedSchema: {} },
    { requestedSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] } },
    { requestedSchema: { type: "object", properties: {}, required: ["hidden"] } },
    { requestedSchema: { type: "object", properties: {}, allOf: [] } },
    { mode: "openai/userVerification" },
    { mode: "url" },
    { _meta: { "openai/elicitation": {} } },
    { _meta: { "openai/confirmation": {} } },
    { _meta: { codex_approval_kind: "browser_auth" } },
    { serverName: "codex_apps", _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "another-connector" } },
  ]) {
    const prompt = describePrompt("mcpServer/elicitation/request", { ...base, ...extra });
    assert.deepEqual(prompt.decisions, ["decline", "cancel"]);
    assert.throws(() => answerFor(prompt, { decision: "accept" }));
  }
});

// Speed (Oct 6): the phone's Configure › Speed goes to Codex as its service
// tier, on the next message and on a new chat, as the app's own menu does.
test("a Codex speed picked on the phone reaches Codex as its service tier", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "turn-1" } }, "thread/start": { thread: { id: T } } });
  const live = createCodexLive({ daemon });
  await live.send(T, { text: "hi", speed: "priority" });
  assert.equal(daemon.calls.find(([m]) => m === "turn/start")[1].serviceTier, "priority");
  const other = fakeDaemon({ "turn/start": { turn: { id: "turn-2" } }, "thread/start": { thread: { id: T } } });
  await createCodexLive({ daemon: other }).start({ cwd: "/tmp", text: "go", speed: "priority" });
  assert.equal(other.calls.find(([m]) => m === "thread/start")[1].serviceTier, "priority");
  // No pick, no override: the chat keeps its own speed.
  const plain = fakeDaemon({ "turn/start": { turn: { id: "turn-3" } } });
  await createCodexLive({ daemon: plain }).send(T, { text: "hi" });
  assert.equal("serviceTier" in plain.calls.find(([m]) => m === "turn/start")[1], false);
});


test("a named native permission profile stays selected for the next Reach turn", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "t-profile" } } });
  const live = createCodexLive({ daemon });
  daemon.emit("thread/settings/updated", {
    threadId: T,
    threadSettings: { activePermissionProfile: { id: "network-only" }, approvalPolicy: "on-request", approvalsReviewer: "user" },
  });
  assert.equal(live.currentMode(T), "profile:network-only");
  await live.send(T, { text: "continue", mode: live.currentMode(T) });
  const [, params] = daemon.calls.find(([method]) => method === "turn/start");
  assert.equal(params.permissions, "network-only");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "user");
});

test("a Codex external cancellation during an in-flight queue read is not lost", async () => {
  let finishFirst, reads = 0;
  const daemon = fakeDaemon({ "thread/queue/list": () => ++reads === 1
    ? new Promise(resolve => { finishFirst = resolve; })
    : { data: [] } });
  const live = createCodexLive({ daemon, queues: true });
  live.view(T);
  daemon.emit("thread/queue/changed", { threadId: T });
  finishFirst({ data: [{ id: "cancelled", input: [{ type: "text", text: "Gone in Codex" }] }] });
  await settled();
  assert.equal(reads, 2, "a change during the read requires a fresh native snapshot");
  assert.equal(live.view(T).outbox, undefined);
  assert.ok(daemon.methods().every(method => method === "thread/queue/list"), "never replay cancelled input");
});

test("an unreadable Codex queue is not mistaken for cancellation and never resends", async () => {
  let response = { data: [{ id: "kept", input: [{ type: "text", text: "Still unknown" }] }] };
  const daemon = fakeDaemon({ "thread/queue/list": () => response });
  const live = createCodexLive({ daemon, queues: true });
  live.view(T);
  await settled();
  const expected = live.view(T).outbox;
  for (const unknown of [new Error("connection gone"), {}]) {
    response = unknown;
    daemon.emit("thread/queue/changed", { threadId: T });
    await settled();
    assert.deepEqual(live.view(T).outbox, expected);
  }
  assert.ok(daemon.methods().every(method => method === "thread/queue/list"));
});

function nativeOwnerFixture(daemon, options = {}) {
  let request, rawRequests;
  const owned = new Set(), settings = [];
  const live = createCodexLive({ daemon, ...options, ownerFactory(config) {
    request = config.handleRequest; rawRequests = config.requests;
    return {
      async claim(id) { owned.add(id); }, has: id => owned.has(id), hasFollowers: () => true,
      settings: (id, value) => settings.push([id, value]), update() {}, forget: id => owned.delete(id),
      reset: () => owned.clear(), close: () => owned.clear(),
    };
  } });
  return { live, request: (...args) => request(...args), rawRequests: (...args) => rawRequests(...args), settings };
}

test("reconnecting restores sharing for loaded Reach tasks without replaying their turn", async () => {
  const foreign = "0199aaaa-bbbb-7ccc-8ddd-ffffffffffff";
  const daemon = fakeDaemon({
    "thread/loaded/list": p => p.cursor ? { data: [foreign], nextCursor: null } : { data: [T], nextCursor: "next" },
    "thread/read": p => ({ thread: { id: p.threadId, originator: p.threadId === T ? "reach" : "codex_cli", status: { type: "active", activeFlags: [] } } }),
  });
  const f = nativeOwnerFixture(daemon);
  daemon.ready();
  await settled();
  assert.equal(f.live.drives(T), true);
  assert.equal(f.live.view(T).status, "running");
  assert.equal(f.live.drives(foreign), false);
  assert.deepEqual(daemon.calls.filter(([m]) => m === "thread/resume").map(([, p]) => p.threadId), [T]);
  assert.equal(daemon.methods().some(m => /turn\/start|thread\/(start|fork)|queue\/add/.test(m)), false);
  daemon.close();
  assert.equal(f.live.drives(T), false);
  daemon.ready();
  await settled();
  assert.equal(f.live.drives(T), true);
  assert.equal(f.live.view(T).error, null);
  f.live.close();
});

test("recovery never resumes a task after Reach closes during its read", async () => {
  let finish;
  const daemon = fakeDaemon({
    "thread/loaded/list": { data: [T], nextCursor: null },
    "thread/read": () => new Promise(resolve => { finish = resolve; }),
  });
  const f = nativeOwnerFixture(daemon);
  daemon.ready();
  await settled();
  f.live.close();
  finish({ thread: { id: T, originator: "reach", status: { type: "active" } } });
  await settled();
  assert.equal(daemon.methods().includes("thread/resume"), false);
});

test("a previously shared native-origin task recovers on the same daemon connection", async () => {
  const daemon = fakeDaemon({
    "turn/start": { turn: { id: "existing" } },
    "thread/loaded/list": { data: [T], nextCursor: null },
    "thread/read": { thread: { id: T, originator: "codex_desktop", status: { type: "active", activeFlags: [] } } },
  });
  const f = nativeOwnerFixture(daemon);
  await f.live.send(T, { text: "first" });
  daemon.close();
  daemon.ready();
  await settled();
  assert.equal(f.live.drives(T), true);
  assert.equal(daemon.methods().filter(m => m === "turn/start").length, 1);
  f.live.close();
});

test("Codex desktop starts the next turn on Reach's same writer between completed turns", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "native-turn" } } });
  const f = nativeOwnerFixture(daemon);
  await f.live.send(T, { text: "first" });
  daemon.emit("turn/completed", { threadId: T, turn: { id: "native-turn", status: "completed" } });
  assert.equal(f.live.drives(T), true);
  assert.equal(daemon.methods().includes("thread/unsubscribe"), false);
  const result = await f.request("thread-follower-start-turn", {
    conversationId: T, turnStart: { request: { threadId: "another-task", input: [{ type: "text", text: "desktop", text_elements: [] }], clientUserMessageId: "native-message", model: "gpt-6-luna" } },
  });
  assert.equal(result.result.turn.id, "native-turn");
  assert.deepEqual(daemon.calls.at(-1), ["turn/start", { threadId: T, input: [{ type: "text", text: "desktop", text_elements: [] }], clientUserMessageId: "native-message", model: "gpt-6-luna" }]);
  assert.equal(daemon.methods().filter(m => m === "thread/resume").length, 1);
  assert.equal(daemon.methods().some(m => /thread\/(start|fork)/.test(m)), false);
});

test("native desktop queue edits retain newer Reach messages and preserve context on reorders", async () => {
  let queue = [
    { id: "old", input: [{ type: "text", text: "old", text_elements: [] }] },
    { id: "kept", input: [{ type: "text", text: "<ide_context>code</ide_context>\nKeep", text_elements: [] }, { type: "skill", name: "example", path: "/tmp/skill" }] },
    { id: "new-reach", input: [{ type: "text", text: "new", text_elements: [] }] },
  ];
  const original = structuredClone(queue[1].input);
  const daemon = fakeDaemon({
    "turn/start": { turn: { id: "t1" } }, "thread/queue/list": () => ({ data: queue }),
    "thread/queue/delete": p => { queue = queue.filter(q => q.id !== p.queuedSubmissionId); return { deleted: true }; },
    "thread/queue/reorder": p => { queue = p.queuedSubmissionIds.map(id => queue.find(q => q.id === id)); return {}; },
  });
  const f = nativeOwnerFixture(daemon); await f.live.send(T, { text: "go" });
  await f.request("thread-follower-set-queued-follow-ups-state", { conversationId: T, state: { [T]: [{ id: "kept", text: "Keep" }] } }, { queueIds: ["old", "kept"] });
  assert.deepEqual(queue.map(q => q.id), ["kept", "new-reach"]);
  assert.deepEqual(queue[0].input, original);
  assert.equal(daemon.methods().includes("thread/queue/update"), false);
  const before = daemon.calls.length;
  await assert.rejects(f.request("thread-follower-set-queued-follow-ups-state", { conversationId: T, state: { [T]: [{ id: "kept", text: "x".repeat(50001) }] } }, { queueIds: ["new-reach"] }), /50,000 characters/);
  assert.equal(daemon.calls.slice(before).some(([m]) => ["thread/queue/delete", "thread/queue/update", "thread/queue/reorder"].includes(m)), false);
});

test("a native desktop answer resolves Reach's same pending approval exactly once", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "t1" } } });
  const f = nativeOwnerFixture(daemon); await f.live.send(T, { text: "go" });
  const params = { threadId: T, command: "example", turnId: "t1", itemId: "tool" };
  const response = daemon.ask(42, "item/commandExecution/requestApproval", params);
  assert.deepEqual(f.rawRequests(T), [{ id: 42, method: "item/commandExecution/requestApproval", params }]);
  await f.request("thread-follower-command-approval-decision", { conversationId: T, requestId: 42, decision: "accept" });
  assert.deepEqual(await response, { decision: "accept" });
  assert.deepEqual(f.rawRequests(T), []);
  assert.equal(f.live.view(T).prompts.length, 0);
  await assert.rejects(f.request("thread-follower-command-approval-decision", { conversationId: T, requestId: 42, decision: "accept" }), /already answered/);
});

test("Reach sends to a desktop-owned task without another resume or fork", async () => {
  const daemon = fakeDaemon({ "thread/turns/list": { data: [] } });
  const calls = [];
  const live = createCodexLive({ daemon, nativeTurns: true, desktop: { async startTurn(id, request) { calls.push([id, request]); return { turnId: "desktop-turn" }; } } });
  assert.deepEqual(await live.send(T, { text: "hello", model: "gpt-6-luna", collaboration: "plan" }), { turnId: "desktop-turn", delivered: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], T);
  assert.equal(calls[0][1].input[0].text, "hello");
  assert.equal(calls[0][1].collaborationMode.mode, "plan");
  assert.equal(daemon.methods().some(m => /thread\/(resume|start|fork)|turn\/start/.test(m)), false);
});

test("an uncertain desktop send never falls back to another writer", async () => {
  const daemon = fakeDaemon({ "thread/turns/list": { data: [] } });
  const live = createCodexLive({ daemon, nativeTurns: true, desktop: { async startTurn() { throw Object.assign(Error("delivery uncertain"), { uncertain: true }); } } });
  await assert.rejects(live.send(T, { text: "hello" }), /delivery uncertain/);
  assert.equal(daemon.methods().includes("thread/resume"), false);
});

test("an unavailable desktop owner lets Reach resume the original task", async () => {
  const daemon = fakeDaemon({ "thread/turns/list": { data: [] }, "turn/start": { turn: { id: "t1" } } });
  const live = createCodexLive({ daemon, nativeTurns: true, desktop: { async startTurn() { throw Object.assign(Error("owner unavailable"), { ownerUnavailable: true }); } } });
  assert.deepEqual(await live.send(T, { text: "hello" }), { turnId: "t1" });
  assert.equal(daemon.calls.find(([m]) => m === "thread/resume")[1].threadId, T);
  assert.equal(daemon.methods().some(m => /thread\/(start|fork)/.test(m)), false);
});

test("a stale native queue edit cannot recreate a message cancelled elsewhere", async () => {
  const daemon = fakeDaemon({
    "turn/start": { turn: { id: "t1" } },
    "thread/queue/list": { data: [] },
    "thread/queue/add": { queuedSubmission: { id: "resurrected" } },
  });
  const f = nativeOwnerFixture(daemon);
  await f.live.send(T, { text: "fixture" });
  for (const context of [{ queueIds: ["cancelled"] }, { queueIds: [], knownQueueIds: ["cancelled"] }]) {
    const before = daemon.calls.length;
    await assert.rejects(f.request("thread-follower-set-queued-follow-ups-state", {
      conversationId: T, state: { [T]: [{ id: "cancelled", text: "Do not replay" }] },
    }, context), /no longer.*queue|queued message.*changed/i);
    assert.ok(daemon.calls.slice(before).every(([m]) => m === "thread/queue/list"), "refuse stale state before any queue mutation");
  }
});


test("native follower queue writes refuse unavailable inventory before mutating anything", async () => {
  for (const response of [{}, { data: null }]) {
    const daemon = fakeDaemon({ "turn/start": { turn: { id: "t1" } }, "thread/queue/list": response });
    const f = nativeOwnerFixture(daemon);
    await f.live.send(T, { text: "fixture" });
    for (const [method, params] of [
      ["thread-follower-set-queued-follow-ups-state", { state: { [T]: [{ id: "new", text: "Do not invent inventory" }] } }],
      ["thread-follower-clear-queued-messages", {}],
      ["thread-follower-remove-queued-message", { messageId: "old" }],
    ]) {
      const before = daemon.calls.length;
      await assert.rejects(f.request(method, { conversationId: T, ...params }));
      assert.ok(daemon.calls.slice(before).every(([m]) => m === "thread/queue/list"));
    }
  }
});

test("native desktop answers the same Reach-owned question without adding a message or queue entry", async () => {
  const daemon = fakeDaemon({ "turn/start": { turn: { id: "t1" } } });
  const f = nativeOwnerFixture(daemon);
  await f.live.send(T, { text: "Ask a synthetic question" });
  const pending = daemon.ask(43, "item/tool/requestUserInput", {
    threadId: T, turnId: "t1", itemId: "question-tool",
    questions: [{ id: "color", question: "Which color?", options: [{ label: "Blue" }, { label: "Amber" }] }],
  });
  const response = { answers: { color: { answers: ["Blue"] } } };
  const before = daemon.calls.length;
  await f.request("thread-follower-submit-user-input", { conversationId: T, requestId: 43, response });
  assert.deepEqual(await pending, response);
  assert.deepEqual(f.rawRequests(T), []);
  assert.equal(f.live.view(T).prompts.length, 0);
  assert.deepEqual(daemon.calls.slice(before), [], "resolve the original request, never start, steer or queue a message");
  await assert.rejects(f.request("thread-follower-submit-user-input", { conversationId: T, requestId: 43, response }), /already answered/);
});


for (const operation of ["steer", "queue"])
  for (const loss of ["close", "connection"])
    test(`native ${operation} stops when ${loss} changes during its authoritative read`, async () => {
      let finish, read;
      const reading = new Promise(resolve => { read = resolve; });
      const readMethod = operation === "steer" ? "thread/turns/list" : "thread/queue/list";
      const daemon = fakeDaemon({
        "turn/start": { turn: { id: "t1" } },
        [readMethod]: () => new Promise(resolve => { finish = resolve; read(); }),
      });
      const f = nativeOwnerFixture(daemon);
      await f.live.send(T, { text: "fixture" });
      let connected = true;
      const context = { authorize() { if (!connected) throw Error("Original connection ended"); } };
      const before = daemon.calls.length;
      const work = f.request(operation === "steer" ? "thread-follower-steer-turn" : "thread-follower-clear-queued-messages", {
        conversationId: T, input: [{ type: "text", text: "Do not dispatch" }],
      }, context);
      await reading;
      if (loss === "close") f.live.close();
      else connected = false;
      finish({ data: operation === "steer" ? [{ id: "t1", status: "running" }] : [{ id: "q1", input: [{ type: "text", text: "queued" }] }] });
      await assert.rejects(work, /no longer owns|connection ended/i);
      assert.deepEqual(daemon.calls.slice(before).map(([m]) => m), [readMethod], "no side effect after the awaited read");
    });
