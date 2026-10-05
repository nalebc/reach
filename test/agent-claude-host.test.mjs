import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  claudeAnswer,
  claudeContent,
  claudeMode,
  createClaudeHost,
  describeClaudePrompt,
} from "../server/agent-sessions/claude-host.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createClaudeImports } from "../server/agent-sessions/claude-import.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// `claude -p` in stream-json mode, played by a fake: it records what Reach
// writes on stdin and lets the test print messages on stdout. Control requests
// Reach sends (set_model, interrupt) are answered like the CLI does.
function fakeClaude({ models = [] } = {}) {
  const runs = [];
  const spawn = (file, args, options) => {
    const proc = new EventEmitter();
    proc.file = file;
    proc.args = args;
    proc.options = options;
    proc.exitCode = null;
    proc.lines = [];
    proc.ended = false;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.print = (message) => proc.stdout.emit("data", `${JSON.stringify(message)}\n`);
    proc.exit = (code = 0) => {
      proc.exitCode = code;
      proc.emit("exit", code);
    };
    proc.kill = () => proc.exit(143);
    proc.stdin = {
      on() {},
      end: () => (proc.ended = true),
      write(text) {
        for (const line of text.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          proc.lines.push(message);
          const subtype = message.request?.subtype;
          if (message.type === "control_request" && ["set_model", "interrupt"].includes(subtype))
            queueMicrotask(() =>
              proc.print({ type: "control_response", response: { subtype: "success", request_id: message.request_id } }),
            );
          if (message.type === "control_request" && subtype === "initialize" && !args.includes("--resume") && !args.includes("--session-id"))
            queueMicrotask(() =>
              proc.print({
                type: "control_response",
                response: { subtype: "success", request_id: message.request_id, response: { models } },
              }),
            );
        }
      },
    };
    runs.push(proc);
    return proc;
  };
  return { runs, spawn, last: () => runs.at(-1) };
}
const host = (claude, extra = {}) =>
  createClaudeHost({
    locate: async () => "/usr/local/bin/claude",
    spawn: claude.spawn,
    env: { PATH: "/usr/bin", HOME: "/Users/me", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", ANTHROPIC_API_KEY: "k", REACH_DATA: "/d" },
    ...extra,
  });

test("a reply resumes the same Claude session in its own folder, prompts going to the host", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  assert.deepEqual(await h.send(ID, { text: "hi", cwd: "/work/app", model: "opus", effort: "max" }), { turnId: null });
  const proc = claude.last();
  assert.equal(proc.file, "/usr/local/bin/claude");
  assert.deepEqual(proc.args, [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompts",
    "host",
    "--include-partial-messages",
    "--replay-user-messages",
    "--resume",
    ID,
    "--model",
    "opus",
    "--effort",
    "max",
  ]);
  assert.equal(proc.options.cwd, "/work/app");
  // Reach's own environment: never a host app's or Reach's pairing settings.
  assert.deepEqual(Object.keys(proc.options.env).sort(), ["HOME", "PATH"]);
  assert.equal(proc.lines[0].type, "control_request");
  assert.equal(proc.lines[0].request.subtype, "initialize");
  assert.deepEqual(proc.lines[1], {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
    parent_tool_use_id: null,
    session_id: ID,
  });
  assert.equal(h.view(ID).status, "running");
  assert.equal(h.drives(ID), true);
});

test("streamed text, what Claude is doing, and the end of a turn", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await h.send(ID, { text: "fix it", cwd: "/work/app" });
  const proc = claude.last();
  const v0 = h.view(ID).version;
  proc.print({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
  proc.print({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }, parent_tool_use_id: null });
  proc.print({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }, parent_tool_use_id: null });
  // A sub-agent's words stay out of the main stream.
  proc.print({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUB" } }, parent_tool_use_id: "t9" });
  assert.equal(h.view(ID).streaming, "Hello");
  proc.print({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
  });
  assert.deepEqual([h.view(ID).streaming, h.view(ID).activity], ["", "Running npm test"]);
  proc.print({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", content: "ok" }] } });
  assert.equal(h.view(ID).activity, null);
  proc.print({ type: "result", subtype: "success", is_error: false, result: "Done" });
  const done = h.view(ID);
  assert.equal(done.status, "idle");
  assert.equal(done.error, null);
  assert.equal(done.items, 3);
  assert.ok(done.version > v0);
});

test("permission prompts become cards and the answer goes back on the same request", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await h.send(ID, { text: "clean", cwd: "/work/app" });
  const proc = claude.last();
  const always = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow", destination: "session" };
  proc.print({
    type: "control_request",
    request_id: "r1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      display_name: "Bash",
      input: { command: "rm -rf build" },
      description: "Delete the build folder",
      permission_suggestions: [always],
      tool_use_id: "t1",
    },
  });
  const view = h.view(ID);
  assert.equal(view.status, "waiting");
  assert.deepEqual(view.prompts, [
    { id: "r1", kind: "tool", tool: "Bash", title: "Delete the build folder", command: "rm -rf build", reason: "", decisions: ["allow", "allowAlways", "deny"] },
  ]);
  assert.throws(() => h.respond(ID, "r1", { decision: "accept" }), /not available/);
  h.respond(ID, "r1", { decision: "allowAlways" });
  assert.deepEqual(proc.lines.at(-1), {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "r1",
      response: { behavior: "allow", updatedInput: { command: "rm -rf build" }, updatedPermissions: [always] },
    },
  });
  assert.equal(h.view(ID).status, "running");
  assert.throws(() => h.respond(ID, "r1", { decision: "allow" }), (e) => e.status === 409);

  proc.print({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/work/app/a.txt" } } });
  assert.equal(h.view(ID).prompts[0].title, "Allow Write?");
  assert.deepEqual(h.view(ID).prompts[0].decisions, ["allow", "deny"]);
  h.respond(ID, "r2", { decision: "deny" });
  assert.deepEqual(proc.lines.at(-1).response.response, { behavior: "deny", message: "The user declined this from Reach." });

  // Answered or withdrawn elsewhere: the card goes away.
  proc.print({ type: "control_request", request_id: "r3", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "a" } } });
  proc.print({ type: "control_cancel_request", request_id: "r3" });
  assert.deepEqual(h.view(ID).prompts, []);
});

test("Claude's questions are answered with the chosen options", () => {
  const prompt = describeClaudePrompt("q1", {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: { questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }], multiSelect: false }] },
  });
  assert.equal(prompt.kind, "question");
  assert.deepEqual(prompt.questions, [
    {
      id: "Which database?",
      header: "DB",
      question: "Which database?",
      options: [
        { label: "Postgres", description: "" },
        { label: "SQLite", description: "" },
      ],
      other: true,
      secret: false,
      multiSelect: false,
    },
  ]);
  assert.deepEqual(claudeAnswer(prompt, { answers: { "Which database?": ["Postgres"] } }), {
    behavior: "allow",
    updatedInput: { ...prompt.input, answers: { "Which database?": "Postgres" } },
  });
  assert.throws(() => claudeAnswer(prompt, { answers: {} }), /Answer every question/);
  // Dialogs Reach can't render can only be dismissed from here.
  const dialog = { kind: "dialog", decisions: ["cancel"] };
  assert.deepEqual(claudeAnswer(dialog, { decision: "cancel" }), { behavior: "cancelled" });
  assert.throws(() => claudeAnswer(dialog, { decision: "allow" }), (e) => e.status === 409);
});

test("requests Reach can't handle are refused at once, so Claude never waits on them", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await h.send(ID, { text: "x", cwd: "/w" });
  const proc = claude.last();
  proc.print({ type: "control_request", request_id: "hook-1", request: { subtype: "hook_callback", callback_id: "c" } });
  assert.deepEqual(proc.lines.at(-1), {
    type: "control_response",
    response: { subtype: "error", request_id: "hook-1", error: "Not supported by Reach." },
  });
  assert.deepEqual(h.view(ID).prompts, []);
});

test("a new Claude session gets its own id and the chosen settings", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  const { threadId } = await h.start({ cwd: "/work/app", text: "go", mode: "default", effort: "high" });
  assert.match(threadId, UUID);
  const args = claude.last().args;
  assert.deepEqual(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2), ["--session-id", threadId]);
  assert.ok(!args.includes("--resume"));
  // The Claude app records Manual as "default"; the flag says "manual".
  assert.deepEqual(args.slice(-4), ["--effort", "high", "--permission-mode", "manual"]);
  assert.equal(claudeMode("plan"), "plan");
  assert.equal(claudeMode("everything"), null);
  await assert.rejects(h.start({ cwd: "relative", text: "x" }), /Choose a folder/);
});

test("the model changes in place; a new thinking level relaunches between turns", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await h.send(ID, { text: "one", cwd: "/w", effort: "max" });
  const first = claude.last();
  first.print({ type: "result", is_error: false });
  await h.send(ID, { text: "two", model: "sonnet" });
  assert.equal(claude.runs.length, 1);
  assert.equal(first.lines.find((l) => l.request?.subtype === "set_model").request.model, "sonnet");
  first.print({ type: "result", is_error: false });
  await h.send(ID, { text: "three", effort: "low" });
  assert.equal(first.ended, true);
  assert.equal(claude.runs.length, 2);
  const second = claude.last();
  assert.deepEqual(second.args.slice(-6), ["--resume", ID, "--model", "sonnet", "--effort", "low"]);
  assert.equal(second.lines.at(-1).message.content[0].text, "three");
});

test("stop interrupts the turn Reach is running, and only that", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await assert.rejects(h.stop(ID), (e) => e.status === 409);
  await h.send(ID, { text: "go", cwd: "/w" });
  assert.deepEqual(await h.stop(ID), { stopped: true });
  assert.equal(claude.last().lines.at(-1).request.subtype, "interrupt");
});

test("an API error ends the turn with its message; a crash mid-turn says so", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await h.send(ID, { text: "go", cwd: "/w" });
  const proc = claude.last();
  proc.print({
    type: "assistant",
    parent_tool_use_id: null,
    error: "authentication_failed",
    message: { model: "<synthetic>", content: [{ type: "text", text: "Failed to authenticate: OAuth session expired" }] },
  });
  proc.print({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired" });
  assert.equal(h.view(ID).error, "Failed to authenticate: OAuth session expired");
  assert.equal(h.view(ID).status, "idle");
  await h.send(ID, { text: "again" });
  assert.equal(h.view(ID).error, null);
  proc.exit(1);
  assert.deepEqual([h.view(ID).status, h.view(ID).error, h.drives(ID)], ["idle", "Claude Code stopped before finishing.", false]);
});

test("Reach lets go of a session before the Claude app takes it, never mid-turn", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  assert.equal(h.release(ID), false);
  await h.send(ID, { text: "go", cwd: "/w" });
  assert.throws(() => h.release(ID), (e) => e.status === 409);
  claude.last().print({ type: "result", is_error: false });
  assert.equal(h.release(ID), true);
  assert.equal(claude.last().ended, true);
  assert.equal(h.drives(ID), false);
});

test("a session counts as open on the phone while its live view waits, and not after", async () => {
  const h = host(fakeClaude());
  assert.equal(h.watched(ID), false);
  const gone = new AbortController();
  const waiting = h.changes(ID, h.view(ID).version, 5000, gone.signal);
  assert.equal(h.watched(ID), true);
  gone.abort();
  await waiting;
  assert.equal(h.watched(ID), false);
});

test("images go inline as base64, in the order they were added", () => {
  const read = (file) => Buffer.from(`bytes of ${file}`);
  assert.deepEqual(claudeContent({ text: "look", images: ["/i/a.png", "/i/b.jpg"] }, read), [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("bytes of /i/a.png").toString("base64") } },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("bytes of /i/b.jpg").toString("base64") } },
  ]);
  assert.throws(() => claudeContent({ text: " " }), /Write a message/);
  assert.throws(() => claudeContent({ images: ["/i/a.heic"] }, read), /Unknown image/);
});

test("models come from a handshake that starts no session, and are kept a while", async () => {
  const models = [{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "max"] }];
  const claude = fakeClaude({ models });
  const h = host(claude);
  assert.deepEqual(await h.models(), models);
  assert.deepEqual(await h.models(), models);
  assert.equal(claude.runs.length, 1);
  assert.ok(!claude.runs[0].args.includes("--resume") && !claude.runs[0].args.includes("--session-id"));
});

test("one Claude session everywhere: Reach continues it, waits its turn when the app is busy, never makes a copy", async () => {
  const claude = fakeClaude();
  const claudeHost = host(claude);
  let signedIn = false;
  let where = null;
  let exact = true;
  // The Claude app's process for the session, as Claude Code's registry shows it.
  const app = { pid: 4242, alive: true, busy: false, signals: [] };
  const opened = [];
  const openLink = async (url, options) => opened.push([url, options]);
  // Someone is using the Mac until the test says otherwise.
  let idle = 5;
  const imports = createClaudeImports({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reach-imports-")), "claude-imports.json"),
    open: openLink,
    idle: async () => idle,
    appRunning: async () => true,
    imported: () => false,
    resume: false,
  });
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/site", status: "idle" }, items: [], before: null }),
    },
    live: async () => new Map(where && app.alive ? [[ID, { where, pid: app.pid, tty: null, exact, busy: app.busy }]] : []),
    claudeHost,
    signIn: {},
    liveMs: -1,
    queueMs: 10,
    kill: (pid, signal) => {
      assert.equal(pid, app.pid);
      app.signals.push(signal);
      if (!app.busy) app.alive = false; // an idle process ends on SIGINT, exit 0
    },
    alive: () => app.alive,
    takeOverMs: 50,
    open: openLink,
    claudeImports: imports,
  });
  await assert.rejects(sessions.send("claude", ID, { text: "hi" }), /signed out/);
  signedIn = true;
  where = "terminal";
  await assert.rejects(sessions.send("claude", ID, { text: "hi" }), /open in a terminal/);
  where = "claude-app";
  exact = false;
  await assert.rejects(sessions.send("claude", ID, { text: "hi" }), /another Claude Code process/);
  exact = true;

  // Busy in the app: the message waits its turn, nothing is ended.
  app.busy = true;
  assert.deepEqual(await sessions.send("claude", ID, { text: "first" }), { queued: true, delivered: false });
  assert.deepEqual(await sessions.send("claude", ID, { text: "second" }), { queued: true, delivered: false });
  assert.equal(sessions.view("claude", ID).queued, 2);
  await settle(40);
  assert.deepEqual(app.signals, []);
  assert.equal(claude.runs.length, 0);
  // The app finishes: its idle process ends cleanly and both go, in order, into the same session.
  app.busy = false;
  await settle(80);
  assert.deepEqual(app.signals, ["SIGINT"]);
  assert.deepEqual(claude.last().args.slice(-2), ["--resume", ID]);
  assert.deepEqual(
    claude.last().lines.filter((l) => l.type === "user").map((l) => l.message.content[0].text),
    ["first", "second"],
  );
  assert.equal(sessions.view("claude", ID).queued, 0);
  claude.last().print({ type: "result", is_error: false });
  claude.last().print({ type: "result", is_error: false });
  claudeHost.release(ID);

  // Idle in the app: handed over at once, never with SIGTERM (the app logs that as an error).
  app.alive = true;
  app.signals = [];
  await sessions.send("claude", ID, { text: "from the phone" });
  assert.deepEqual(app.signals, ["SIGINT"]);
  assert.equal(claude.last().lines.at(-1).message.content[0].text, "from the phone");
  claude.last().print({ type: "result", is_error: false });
  claudeHost.release(ID);
  where = null;

  // Started here: joins the Claude app's list once Reach lets go, but not while
  // someone is using the Mac (the import switches the app's window).
  const { threadId } = await sessions.start("claude", { cwd: "/work/site", text: "new one" });
  assert.deepEqual(opened, []);
  claude.last().print({ type: "result", is_error: false });
  claudeHost.release(threadId);
  await settle(20);
  assert.deepEqual(opened, [], "not while someone is at the Mac");
  idle = 600;
  await imports.check();
  assert.deepEqual(opened, [[`claude://resume?session=${threadId}`, { background: true }]]);
  claudeHost.release(threadId);
  await imports.check();
  assert.equal(opened.length, 1, "imported once");
  sessions.close();
});

test("a Claude app session waiting on you shows what it asks, and a message from here waits instead of ending it", async () => {
  const claude = fakeClaude();
  const claudeHost = host(claude);
  const app = { pid: 4343, waiting: "input needed", signals: [] };
  const question = {
    question: "Which database?",
    header: "Database",
    multiSelect: false,
    options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }],
  };
  const items = [
    { id: "u1", role: "user", kind: "text", text: "Set up storage" },
    { id: "q1", role: "tool", kind: "tool", status: "running", text: "Which database?", detail: "", questions: [question] },
  ];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now() - 60_000, status: "idle" }],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/site", status: "idle" }, items, before: null }),
    },
    live: async () =>
      new Map([[ID, { where: "claude-app", pid: app.pid, tty: null, exact: true, busy: false, waiting: app.waiting }]]),
    claudeHost,
    signIn: {},
    liveMs: -1,
    queueMs: 10,
    kill: (pid, signal) => app.signals.push(signal),
    alive: () => true,
    takeOverMs: 30,
    claudeImports: { add: async () => {}, close() {} },
  });
  const { session } = await sessions.read("claude", ID);
  assert.equal(session.status, "waiting");
  assert.deepEqual(session.asking, { kind: "question", questions: [question] });
  assert.equal((await sessions.list()).sessions[0].status, "waiting");
  // An older page ends wherever it ends, not on what Claude asks now.
  assert.equal((await sessions.read("claude", ID, { before: "1" })).session.asking, undefined);
  // Ending the app's process now would drop its question: the message waits.
  assert.deepEqual(await sessions.send("claude", ID, { text: "use Postgres" }), { queued: true, delivered: false });
  await settle(40);
  assert.deepEqual(app.signals, []);
  assert.equal(claude.runs.length, 0);
  // A permission request reads as one.
  app.waiting = "permission prompt";
  items[1] = { id: "b1", role: "tool", kind: "command", status: "running", text: "rm -rf build", detail: "" };
  assert.deepEqual((await sessions.read("claude", ID)).session.asking, { kind: "permission", text: "rm -rf build", command: true });
  sessions.close();
});

test("a prompt asked through an agent's hook shows in its session, wakes it, and the phone's answer goes back through the hook", async () => {
  const claude = fakeClaude();
  const claudeHost = host(claude);
  const THREAD = "01a10895-1859-7022-8614-f5ef47ab1c66";
  const held = new Map(); // promptId -> { agent, id, prompt }
  const versions = new Map();
  const listeners = new Set();
  const answered = [];
  const agentAsks = {
    has: (agent, id) => [...held.values()].some((h) => h.agent === agent && h.id === id),
    prompts: (agent, id) => [...held.values()].filter((h) => h.agent === agent && h.id === id).map((h) => h.prompt),
    owns: (promptId) => held.has(promptId),
    answer: (agent, id, promptId, answer) => (answered.push([agent, id, promptId, answer]), held.delete(promptId), { answered: true }),
    version: (agent, id) => versions.get(`${agent}:${id}`) || 0,
    onChange: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    close() {},
  };
  const ask = (agent, id, prompt) => {
    held.set(prompt.id, { agent, id, prompt });
    versions.set(`${agent}:${id}`, (versions.get(`${agent}:${id}`) || 0) + 1);
    for (const l of listeners) l(agent, id);
  };
  const codexView = { version: 3, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 };
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [{ agent: "codex", id: THREAD, updatedAt: Date.now() - 1, status: "idle" }], health: async () => ({}) },
    codexLive: {
      drives: () => false,
      view: () => codexView,
      changes: (id, since, ms) => new Promise((r) => setTimeout(r, ms)),
    },
    claude: {
      list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now(), status: "idle" }],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/site", status: "idle" }, items: [], before: null }),
    },
    live: async () => new Map([[ID, { where: "claude-app", pid: 1, tty: null, exact: true, busy: true, waiting: null }]]),
    claudeHost,
    signIn: {},
    liveMs: -1,
    agentAsks,
    claudeImports: { add: async () => {}, close() {} },
  });
  const before = sessions.view("claude", ID);
  assert.deepEqual(before.prompts, []);
  // The long poll is waiting when Claude asks in the app.
  const woke = sessions.changes("claude", ID, before.version, 5000);
  const prompt = { id: "p1", kind: "tool", title: "Allow Bash?", command: "npm test", decisions: ["allow", "deny"] };
  ask("claude", ID, prompt);
  await woke;
  const view = sessions.view("claude", ID);
  assert.equal(view.status, "waiting");
  assert.deepEqual(view.prompts, [prompt]);
  assert.notEqual(view.version, before.version);
  assert.equal((await sessions.list()).sessions.find((s) => s.id === ID).status, "waiting");
  assert.deepEqual(await sessions.respond("claude", ID, "p1", { decision: "allow" }), { answered: true });
  assert.deepEqual(answered, [["claude", ID, "p1", { decision: "allow" }]]);
  // A prompt of Reach's own session still goes to its own host.
  await assert.rejects(sessions.respond("claude", ID, "unknown", { decision: "allow" }), (e) => e.status === 409);

  // The same for a thread in the Codex app.
  const codexBefore = sessions.view("codex", THREAD);
  const codexWoke = sessions.changes("codex", THREAD, codexBefore.version, 5000);
  const approval = { id: "c1", kind: "command", title: "Run this command?", command: "npm test", decisions: ["accept", "decline"] };
  ask("codex", THREAD, approval);
  await codexWoke;
  assert.deepEqual(sessions.view("codex", THREAD).prompts, [approval]);
  assert.equal(sessions.view("codex", THREAD).status, "waiting");
  assert.equal((await sessions.list()).sessions.find((s) => s.id === THREAD).status, "waiting");
  await sessions.respond("codex", THREAD, "c1", { decision: "accept" });
  assert.deepEqual(answered.at(-1), ["codex", THREAD, "c1", { decision: "accept" }]);
  sessions.close();
});

test("Reach holds a hook's prompt only for sessions the phone lists: the Claude app's and terminals', Codex threads, not headless runs", async (t) => {
  const { spawn } = await import("node:child_process");
  const { agentAskSocket } = await import("../server/agent-sessions/agent-asks.mjs");
  const hookScript = new URL("../scripts/agent-hook.mjs", import.meta.url).pathname;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-asks-index-"));
  const APP = "a1111111-2222-4333-8444-555555555555";
  const BACKGROUND = "b1111111-2222-4333-8444-555555555555";
  const UNKNOWN = "c1111111-2222-4333-8444-555555555555";
  const THREAD = "01a10895-1859-7022-8614-f5ef47ab1c66";
  const EXEC = "01a10895-1859-7022-8614-f5ef47ab1c67";
  const sessions = createAgentSessions({
    dataDir,
    listenForAsks: true,
    macIdle: async () => 600, // nobody at the Mac
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: {
      list: async () => [
        { agent: "codex", id: THREAD, updatedAt: 1, status: "idle" },
        { agent: "codex", id: EXEC, updatedAt: 1, status: "idle", headless: true },
      ],
      health: async () => ({}),
    },
    codexLive: { drives: () => false, watched: () => false, view: () => ({ version: 0, prompts: [] }), changes: async () => {} },
    claude: { list: async () => [], starts: async () => [], health: async () => ({ signedIn: true }) },
    live: async () =>
      new Map([
        [APP, { where: "claude-app", pid: 1, busy: true }],
        [BACKGROUND, { where: "background", pid: 2, busy: true }],
      ]),
    claudeHost: host(fakeClaude()),
    signIn: {},
    liveMs: -1,
    claudeImports: { add: async () => {}, close() {} },
  });
  t.after(() => sessions.close());
  await new Promise((r) => setTimeout(r, 100)); // the socket opens
  const ask = (agent, session_id) => {
    const child = spawn(process.execPath, [hookScript, agent, agentAskSocket(dataDir)], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise((resolve) => child.on("exit", () => resolve(out)));
    child.stdin.end(JSON.stringify({ session_id, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }));
    return { child, exited };
  };
  // Headless and unknown sessions go on at once, with no answer from Reach.
  assert.equal(await ask("claude", BACKGROUND).exited, "");
  assert.equal(await ask("claude", UNKNOWN).exited, "");
  assert.equal(await ask("codex", EXEC).exited, "");
  // The Claude app's session and a Codex thread wait for the phone.
  const held = [ask("claude", APP), ask("codex", THREAD)];
  const end = Date.now() + 3000;
  while (!(sessions.view("claude", APP).prompts.length && sessions.view("codex", THREAD).prompts.length)) {
    assert.ok(Date.now() < end, "both held");
    await new Promise((r) => setTimeout(r, 20));
  }
  for (const h of held) h.child.kill("SIGTERM");
  await Promise.all(held.map((h) => h.exited));
});

test("a Claude session shows as working only when it is, not merely open in the app", async () => {
  const claude = fakeClaude();
  const claudeHost = host(claude);
  const now = Date.now();
  const transcripts = [
    { agent: "claude", id: "a1111111-2222-4333-8444-555555555555", updatedAt: now - 5 * 60_000, pending: true, status: "idle" }, // mid-turn in the app
    { agent: "claude", id: "b1111111-2222-4333-8444-555555555555", updatedAt: now - 5 * 60_000, pending: false, status: "idle" }, // open, idle
    { agent: "claude", id: "c1111111-2222-4333-8444-555555555555", updatedAt: now - 5_000, pending: false, status: "idle" }, // just wrote
    { agent: "claude", id: "d1111111-2222-4333-8444-555555555555", updatedAt: now - 5_000, pending: true, status: "idle" }, // no process
  ];
  const open = new Map(transcripts.slice(0, 3).map((t) => [t.id, { where: "claude-app", pid: 1, tty: null }]));
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}) },
    claude: { list: async () => transcripts.map((t) => ({ ...t })), starts: async () => [], health: async () => ({ signedIn: true }) },
    live: async () => open,
    claudeHost,
    signIn: {},
    liveMs: -1,
  });
  const status = async () => Object.fromEntries((await sessions.list()).sessions.map((s) => [s.id[0], s.status]));
  assert.deepEqual(await status(), { a: "running", b: "idle", c: "running", d: "idle" });
});

test("Reach lets go of Claude Code soon after a turn, later only while the phone watches", async () => {
  const claude = fakeClaude();
  const h = host(claude, { graceMs: 20, idleMs: 120 });
  await h.send(ID, { text: "go", cwd: "/w" });
  claude.last().print({ type: "result", is_error: false });
  await settle(40);
  // Nobody watching: gone after the grace, so the Claude app can take it.
  assert.equal(h.drives(ID), false);
  assert.equal(claude.last().ended, true);

  await h.send(ID, { text: "again" });
  let watching = new AbortController();
  let poll = h.changes(ID, h.view(ID).version, 60000, watching.signal);
  claude.last().print({ type: "result", is_error: false });
  await poll; // woken by the turn ending
  // The phone polls again at once, as it does while it shows the session.
  watching = new AbortController();
  poll = h.changes(ID, h.view(ID).version, 60000, watching.signal);
  await settle(40);
  assert.equal(h.drives(ID), true, "kept while the phone shows the session");
  // The phone leaves (its poll is cut): let go soon after.
  watching.abort();
  await poll;
  await settle(40);
  assert.equal(h.drives(ID), false);
});
