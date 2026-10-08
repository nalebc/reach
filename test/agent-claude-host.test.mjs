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
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// `claude -p` in stream-json mode, played by a fake: it records what Reach
// writes on stdin and lets the test print messages on stdout. Control requests
// Reach sends (set_model, interrupt) are answered like the CLI does.
// A new session's title is proposed as `title` (an Error: refused; a promise:
// answered when it settles).
function fakeClaude({ models = [], title = "Proposed title" } = {}) {
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
      write(text, callback) {
        for (const line of text.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          proc.lines.push(message);
          const subtype = message.request?.subtype;
          if (message.type === "control_request" && ["set_model", "interrupt", "stop_task"].includes(subtype))
            queueMicrotask(() =>
              proc.print({ type: "control_response", response: { subtype: "success", request_id: message.request_id } }),
            );
          if (message.type === "control_request" && subtype === "rewind_files")
            queueMicrotask(() =>
              proc.print({
                type: "control_response",
                response: { subtype: "success", request_id: message.request_id, response: { canRewind: true, filesChanged: ["src/a.ts", "src/b.ts"], insertions: 12, deletions: 4 } },
              }),
            );
          if (message.type === "control_request" && subtype === "rename_session")
            queueMicrotask(() =>
              proc.print({ type: "control_response", response: { subtype: "success", request_id: message.request_id } }),
            );
          if (message.type === "control_request" && subtype === "generate_session_title")
            Promise.resolve(title).then((value) =>
              proc.print({
                type: "control_response",
                response: value instanceof Error
                  ? { subtype: "error", request_id: message.request_id, error: value.message }
                  : { subtype: "success", request_id: message.request_id, response: { title: value } },
              }),
            );
          if (message.type === "control_request" && subtype === "initialize")
            queueMicrotask(() =>
              proc.print({
                type: "control_response",
                response: { subtype: "success", request_id: message.request_id, response: { models } },
              }),
            );
        }
        callback?.();
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

test("a temporarily unavailable Claude probe asks to retry rather than update Reach", async (t) => {
  const claude = fakeClaude(), h = host(claude, { check: async () => ({ status: "unavailable" }) });
  t.after(() => h.close());
  await assert.rejects(h.send(ID, { text: "hello", cwd: "/work/app" }), (error) => {
    assert.equal(error.status, 503);
    assert.match(error.message, /Try again/);
    assert.equal(error.message.includes("Update Reach"), false);
    return true;
  });
  assert.equal(claude.runs.length, 0);
});

test("Claude stream handling preserves the specific incompatible feature", async (t) => {
  const claude = fakeClaude(), h = host(claude);
  t.after(() => h.close());
  await h.send(ID, { text: "hello", cwd: "/work/app" });
  claude.last().print({ type: "assistant", message: { content: {} } });
  assert.match(h.view(ID).error, /assistant message interface/);
  assert.equal(h.view(ID).error.includes("stream interface"), false);
});

test("Claude keeps its confirmed mode and model after a rejected settings change", async (t) => {
  const claude = fakeClaude(), h = host(claude);
  t.after(() => h.close());
  await h.send(ID, { text: "hello", cwd: "/work/app", mode: "manual", model: "original" });
  const proc = claude.last();
  proc.stdin.write = (text, callback) => {
    const message = JSON.parse(text);
    proc.lines.push(message);
    queueMicrotask(() => proc.print({ type: "control_response", response: {
      subtype: "error", request_id: message.request_id, error: "Setting rejected",
    } }));
    callback?.();
  };
  await assert.rejects(h.mode(ID, "auto"), /Setting rejected/);
  await assert.rejects(h.send(ID, { text: "not sent", model: "rejected" }), /Setting rejected/);
  await assert.rejects(h.send(ID, { text: "not sent", mode: "auto" }), /Setting rejected/);
  assert.equal(proc.lines.filter(m => m.type === "user").length, 1);
  proc.exit();
  await h.send(ID, { text: "resume" });
  const args = claude.last().args;
  assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");
  assert.equal(args[args.indexOf("--model") + 1], "original");
});

test("Claude MCP confirmations wait for the phone instead of being silently rejected", async () => {
  const claude = fakeClaude(), h = host(claude);
  await h.send(ID, { text: "hello", cwd: "/work/app" });
  const proc = claude.last();
  proc.print({ type: "control_request", request_id: "consent", request: {
    subtype: "elicitation", mcp_server_name: "calendar", mode: "form",
    message: "Continue?", requested_schema: { type: "object", properties: {} },
  } });
  assert.deepEqual(h.view(ID).prompts[0].decisions, ["accept", "decline", "cancel"]);
  assert.equal(proc.lines.some(m => m.response?.request_id === "consent"), false);
  await h.respond(ID, "consent", { decision: "accept" });
  assert.deepEqual(proc.lines.at(-1).response, { subtype: "success", request_id: "consent", response: { action: "accept", content: {} } });
  h.close();
});

test("Claude's suppressed permanent permission choice never appears or accepts an answer", () => {
  const prompt = describeClaudePrompt("p", { tool_name: "Bash", input: { command: "example" },
    permission_suggestions: [{ type: "addRules", rules: [] }], suppress_always_allow_rule: true });
  assert.deepEqual(prompt.decisions, ["allow", "deny"]);
  assert.throws(() => claudeAnswer(prompt, { decision: "allowAlways" }), /not available/);
});

test("a Claude approval with unknown delivery remains visible without offering to send it twice", async () => {
  const claude = fakeClaude(), h = host(claude);
  await h.send(ID, { text: "hello", cwd: "/work/app" });
  const proc = claude.last();
  proc.print({ type: "control_request", request_id: "p", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "example" } } });
  let writes = 0;
  proc.stdin.write = (_, callback) => { writes++; callback(Error("disconnected")); };
  await assert.rejects(h.respond(ID, "p", { decision: "allow" }));
  assert.equal(h.view(ID).prompts[0].attempted, true);
  await assert.rejects(h.respond(ID, "p", { decision: "allow" }), /already attempted/);
  assert.equal(writes, 1);
  h.close();
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
    // Without it Claude Code denies writes and edits by itself; the phone never asked.
    "--permission-prompt-tool",
    "stdio",
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
  await assert.rejects(() => h.respond(ID, "r1", { decision: "accept" }), /not available/);
  await h.respond(ID, "r1", { decision: "allowAlways" });
  assert.deepEqual(proc.lines.at(-1), {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "r1",
      response: { behavior: "allow", updatedInput: { command: "rm -rf build" }, updatedPermissions: [always] },
    },
  });
  assert.equal(h.view(ID).status, "running");
  await assert.rejects(() => h.respond(ID, "r1", { decision: "allow" }), (e) => e.status === 409);

  proc.print({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/work/app/a.txt" } } });
  assert.equal(h.view(ID).prompts[0].title, "Allow Write?");
  assert.deepEqual(h.view(ID).prompts[0].decisions, ["allow", "deny"]);
  await h.respond(ID, "r2", { decision: "deny" });
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

const requests = (proc, subtype) => proc.lines.filter((m) => m.type === "control_request" && m.request.subtype === subtype).map((m) => m.request);

test("a new Claude session is named from its first message, so the Claude app doesn't list it as General coding session", async () => {
  const claude = fakeClaude({ title: "Settings page dark mode toggle" });
  const h = host(claude);
  const text = "Add a dark mode toggle to the settings page";
  const { threadId } = await h.start({ cwd: "/work/app", text });
  await settle();
  const proc = claude.last();
  // The message goes first; the title doesn't hold it up.
  assert.equal(proc.lines.findIndex((m) => m.type === "user") < proc.lines.findIndex((m) => m.request?.subtype === "generate_session_title"), true);
  assert.deepEqual(requests(proc, "generate_session_title"), [{ subtype: "generate_session_title", description: text, persist: false }]);
  // rename_session writes the custom-title line the app reads on import.
  assert.deepEqual(requests(proc, "rename_session"), [
    { subtype: "rename_session", title: "Settings page dark mode toggle", source: "host", session_id: threadId },
  ]);
  // A reply in a session that already has its name doesn't rename it.
  proc.print({ type: "result", is_error: false });
  await h.send(threadId, { text: "and the profile page too" });
  await settle();
  assert.equal(requests(proc, "generate_session_title").length, 1);
  h.close();
});

test("a Claude session whose title can't be proposed is named after its first line", async () => {
  const claude = fakeClaude({ title: new Error("unsupported control request") });
  const h = host(claude);
  const { threadId } = await h.start({ cwd: "/w", text: "\n  Fix the   login bug\nIt fails on Safari" });
  await settle();
  assert.deepEqual(requests(claude.last(), "rename_session"), [
    { subtype: "rename_session", title: "Fix the login bug", source: "host", session_id: threadId },
  ]);
  const long = fakeClaude({ title: "" });
  const h2 = host(long);
  await h2.start({ cwd: "/w", text: "x".repeat(80) });
  await settle();
  assert.equal(requests(long.last(), "rename_session")[0].title, `${"x".repeat(59)}…`);
  h.close();
  h2.close();
});

test("Reach keeps a new Claude session until its name is written, then lets go", async () => {
  let answer;
  const claude = fakeClaude({ title: new Promise((resolve) => (answer = resolve)) });
  const h = host(claude, { graceMs: 20, idleMs: 120 });
  const { threadId } = await h.start({ cwd: "/w", text: "go" });
  claude.last().print({ type: "result", is_error: false });
  await settle(40);
  assert.equal(h.drives(threadId), true, "held while naming");
  answer("Go");
  await settle(40);
  assert.equal(requests(claude.last(), "rename_session")[0].title, "Go");
  assert.equal(claude.last().ended, true);
  h.close();
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

// Claude Code 2.1.291, stopped mid-reply (recorded): the words so far, then
// "[Request interrupted by user]" as a user turn, then an error result with no
// words. The phone showed a red "Claude Code stopped with an error".
test("a stop is a stop, not an error, whether Reach or the app stopped it", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  const stopped = (proc) => {
    proc.print({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Marcus had tended the lighthouse" }], stop_reason: null } });
    proc.print({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    proc.print({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", errors: ["[ede_diagnostic] result_type=user"] });
  };
  await h.send(ID, { text: "a story", cwd: "/w" });
  await h.stop(ID);
  stopped(claude.last());
  assert.deepEqual([h.view(ID).status, h.view(ID).error], ["idle", null]);
  await h.send(ID, { text: "another" });
  stopped(claude.last()); // stopped on the Mac this time
  assert.deepEqual([h.view(ID).status, h.view(ID).error], ["idle", null]);
  // A real failure still says so.
  await h.send(ID, { text: "again" });
  claude.last().print({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] });
  assert.equal(h.view(ID).error, "Claude Code stopped with an error.");
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

test("a session counts as open on the phone while its live view waits, then briefly while reconnecting", async () => {
  let now = 1000;
  const h = host(fakeClaude(), { now: () => now });
  assert.equal(h.watched(ID), false);
  const gone = new AbortController();
  const waiting = h.changes(ID, h.view(ID).version, 5000, gone.signal);
  assert.equal(h.watched(ID), true);
  gone.abort();
  await waiting;
  assert.equal(h.watched(ID), true);
  now += 5001;
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

// A message that waits its turn: queued, with the id it waits under.
const queuedReply = ({ messageId, ...reply }) => {
  assert.match(messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return reply;
};

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
  // Sessions whose Claude app window is to be reloaded (claude-import.mjs).
  const refreshed = [];
  const imports = createClaudeImports({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reach-imports-")), "claude-imports.json"),
    open: openLink,
    idle: async () => idle,
    appRunning: async () => true,
    // The chat the Claude app holds is in its list; others aren't.
    imported: (id) => id === ID,
    write: null,
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
    claudeRefresh: { add: async (id) => refreshed.push(id), close() {} },
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
  assert.deepEqual(queuedReply(await sessions.send("claude", ID, { text: "first" })), { queued: true, delivered: false });
  assert.deepEqual(queuedReply(await sessions.send("claude", ID, { text: "second" })), { queued: true, delivered: false });
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
  assert.deepEqual(refreshed, []);
  claudeHost.release(ID);
  // The app's window doesn't see what Reach added: it's reloaded (when nobody is at the Mac).
  assert.deepEqual(refreshed, [ID]);

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
  // Imported, not reloaded: the import shows it afresh.
  assert.deepEqual(refreshed, [ID, ID]);
  sessions.close();
});

test("a message waiting for the Claude app is never lost: it shows, survives a Reach restart, says why it can't go yet, and goes once it can", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reach-outbox-")), "agent-outbox.json");
  // The Claude app's process for the session, busy with a turn.
  const app = { pid: 4646, alive: true, busy: true, where: "claude-app" };
  const make = (claude) =>
    createAgentSessions({
      daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
      codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
      claude: {
        list: async () => [],
        starts: async () => [],
        health: async () => ({ agent: "claude", installed: true, signedIn: true }),
        read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/site", status: "idle" }, items: [], before: null }),
      },
      live: async () =>
        new Map(app.alive ? [[ID, { where: app.where, pid: app.pid, tty: null, exact: true, busy: app.busy }]] : []),
      claudeHost: host(claude),
      signIn: {},
      liveMs: -1,
      queueMs: 10,
      kill: () => {
        if (!app.busy) app.alive = false; // an idle process ends on SIGINT
      },
      alive: () => app.alive,
      takeOverMs: 30,
      claudeImports: { add: async () => {}, close() {} },
      outbox: createOutbox({ file }),
    });
  const first = make(fakeClaude());
  await first.send("claude", ID, { text: "keep me", images: [] });
  const [waiting] = first.view("claude", ID).outbox;
  assert.equal(waiting.text, "keep me");
  assert.equal(waiting.images, 0);
  // Reach restarts while it waits.
  first.close();
  const claude = fakeClaude();
  const second = make(claude);
  assert.deepEqual(second.view("claude", ID).outbox.map((m) => m.text), ["keep me"], "still there after the restart");
  // Moved to a terminal: it can't go from here, and says so.
  app.where = "terminal";
  await settle(60);
  assert.match(second.view("claude", ID).outbox[0].error, /open in a terminal/);
  assert.equal(claude.runs.length, 0);
  // Back in the app and done with its turn: it goes, in the same session, and leaves the outbox.
  app.where = "claude-app";
  app.busy = false;
  await settle(120);
  assert.deepEqual(
    claude.last().lines.filter((l) => l.type === "user").map((l) => l.message.content[0].text),
    ["keep me"],
  );
  assert.deepEqual(second.view("claude", ID).outbox, []);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), []);
  second.close();
});

test("a message to a chat the Claude app lists goes into the app itself (its window shows it), never through Reach's own process", async () => {
  const claude = fakeClaude();
  const app = { pid: 4747, alive: true, busy: true, signals: [], open: true };
  const delivered = [];
  let refuse = "Goes in when you open this chat in the Claude app, or step away from your Mac.";
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [],
      starts: async () => [],
      // The CLI is signed out: the app signs in on its own, so it doesn't matter.
      health: async () => ({ agent: "claude", installed: true, signedIn: false }),
      read: async (id) => ({
        session: { agent: "claude", id, cwd: "/work/site", status: "idle", inApp: true, appTitle: "Fix the chart" },
        items: [],
        before: null,
      }),
    },
    live: async () => new Map(app.alive ? [[ID, { where: "claude-app", pid: app.pid, tty: null, exact: true, busy: app.busy }]] : []),
    claudeHost: host(claude),
    signIn: {},
    liveMs: -1,
    queueMs: 10,
    kill: (pid, signal) => app.signals.push(signal),
    alive: () => app.alive,
    takeOverMs: 30,
    claudeImports: { add: async () => {}, close() {} },
    claudeOpen: async () => app.open,
    claudeCompose: {
      deliver: async (id, message) => {
        if (refuse) throw Object.assign(new Error(refuse), { waiting: true });
        delivered.push([id, message]);
        return { delivered: true };
      },
    },
  });
  const reply = await sessions.send("claude", ID, { text: "Run the tests", images: ["/data/agent-images/p.png"] });
  assert.equal(reply.via, "app");
  assert.equal(reply.queued, true);
  // Waiting for the window, it says why.
  await settle(60);
  const [waiting] = sessions.view("claude", ID).outbox;
  assert.equal(waiting.via, "app");
  assert.equal(waiting.error, refuse);
  // The window can take it: typed into the app, as the app's chat titles it.
  refuse = null;
  await settle(5200);
  assert.deepEqual(delivered, [[ID, { title: "Fix the chart", text: "Run the tests", images: ["/data/agent-images/p.png"] }]]);
  assert.deepEqual(sessions.view("claude", ID).outbox, []);
  await assert.rejects(sessions.model("claude", ID, { model: "different" }), /current selection is unchanged/);
  await assert.rejects(sessions.send("claude", ID, { text: "Use my chosen model", model: "different" }), /hasn't been sent/);
  assert.equal(delivered.length, 1);
  assert.deepEqual(sessions.view("claude", ID).outbox, []);
  // Never Reach's own process, never ending the app's.
  assert.equal(claude.runs.length, 0);
  assert.deepEqual(app.signals, []);
  // The Claude app closed: Reach's own way, as before (which needs the CLI signed in).
  app.open = false;
  await assert.rejects(sessions.send("claude", ID, { text: "hi" }), /signed out/);
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
  // Answerable from the phone: its options pressed in the Claude app (Oct 6).
  assert.deepEqual(session.asking, { kind: "question", questions: [question], id: "app-question:q1" });
  assert.equal((await sessions.list()).sessions[0].status, "waiting");
  // An older page ends wherever it ends, not on what Claude asks now.
  assert.equal((await sessions.read("claude", ID, { before: "1" })).session.asking, undefined);
  // Ending the app's process now would drop its question: the message waits.
  assert.deepEqual(queuedReply(await sessions.send("claude", ID, { text: "use Postgres" })), { queued: true, delivered: false });
  await settle(40);
  assert.deepEqual(app.signals, []);
  assert.equal(claude.runs.length, 0);
  // A permission request reads as one.
  app.waiting = "permission prompt";
  items[1] = { id: "b1", role: "tool", kind: "command", status: "running", text: "rm -rf build", detail: "" };
  assert.deepEqual((await sessions.read("claude", ID)).session.asking, { kind: "permission", text: "rm -rf build", command: true, id: "app-permission:b1" });
  // Some other dialog of Claude Code's (a notice to acknowledge) waits on you
  // too, but it isn't a permission for the last command.
  app.waiting = "dialog open";
  assert.deepEqual((await sessions.read("claude", ID)).session.asking, { kind: "dialog", text: "Claude Code has something open for you to answer." });
  sessions.close();
});

test("the Claude app's own consent card makes its session wait on you, said as the app asks it, only while the app holds it", async () => {
  const consent = {
    kind: "apps",
    id: "consent:toolu_1",
    title: "Allow Claude to use Calculator?",
    reason: "Add up the receipts.",
    apps: ["calculator", "Unknown Tool"],
    options: ["Deny", "Allow for this session"],
  };
  const items = [
    { id: "u1", role: "user", kind: "text", text: "Add these up" },
    { id: "c1", role: "tool", kind: "tool", status: "running", text: consent.title, detail: "", consent },
  ];
  // What the transcript says now (the card's call, until it's answered).
  const answered = { consent };
  const pressed = [];
  // The registry says busy: the card isn't a Claude Code prompt.
  let running = new Map([[ID, { where: "claude-app", pid: 4545, tty: null, exact: true, busy: true, waiting: null }]]);
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now() - 60_000, status: "idle", ...answered }],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/site", status: "idle", ...answered }, items, before: null }),
    },
    live: async () => running,
    claudeHost: host(fakeClaude()),
    signIn: {},
    liveMs: -1,
    claudeImports: { add: async () => {}, close() {} },
    installedApps: async () => [{ id: "/System/Applications/Calculator.app", name: "Calculator" }],
    // The phone's answer: pressed in the app, then the transcript has it.
    claudeShown: () => [{ id: ID, session: `local_${ID}`, at: 1 }],
    pressConsent: async (choice, expect) => {
      pressed.push(choice, expect);
      delete items[1].consent;
      items[1].status = "completed";
      delete answered.consent;
    },
  });
  assert.equal((await sessions.list()).sessions[0].status, "waiting");
  const { session } = await sessions.read("claude", ID);
  assert.equal(session.status, "waiting");
  assert.deepEqual(session.asking, {
    kind: "consent",
    id: "consent:toolu_1",
    about: "apps",
    title: "Allow Claude to use Calculator?",
    reason: "Add up the receipts.",
    // As the app lists them, with the installed app when there is one.
    apps: [{ name: "Calculator", appId: "/System/Applications/Calculator.app" }, { name: "Unknown Tool" }],
    options: ["Deny", "Allow for this session"],
  });
  assert.equal((await sessions.read("claude", ID, { before: "1" })).session.asking, undefined);
  // Answered from the phone: the app's own button is pressed.
  await assert.rejects(sessions.respond("claude", ID, "consent:toolu_1", { decision: "maybe" }), (e) => e.status === 400);
  assert.deepEqual(await sessions.respond("claude", ID, "consent:toolu_1", { decision: "deny" }), { answered: true });
  assert.deepEqual(pressed, ["Deny", ["Allow Claude to use", "calculator", "Unknown Tool"]]);
  await assert.rejects(sessions.respond("claude", ID, "consent:toolu_1", { decision: "deny" }), /already answered/);
  Object.assign(answered, { consent });
  items[1] = { ...items[1], status: "running", consent };
  // The app's process is gone: nothing shows that card any more.
  running = new Map();
  assert.notEqual((await sessions.list()).sessions[0].status, "waiting");
  assert.equal((await sessions.read("claude", ID)).session.asking, undefined);
  sessions.close();
});

// A Claude app chat's permission card couldn't be answered from the phone
// ("Open screen to answer"): the app keeps the request to itself. Now the
// phone shows the app's own card (its words, its buttons, in order), read in
// the app with that chat brought up; on the person's tap only, Reach presses
// the button with that very label, on the card that names the request.
test("a Claude app chat's permission card shows on the phone as the app draws it and is answered with its own buttons", async () => {
  const items = [
    { id: "u1", role: "user", kind: "text", text: "Find it" },
    { id: "toolu_9", role: "tool", kind: "command", status: "running", text: "cd ~/.claude/projects && grep -l \"flipping coing\" *.jsonl", detail: "" },
  ];
  const app = { where: "claude-app", pid: 61729, tty: null, exact: true, busy: false, waiting: "permission prompt", appSessionId: "local_4348" };
  let running = new Map([[ID, app]]);
  const opened = [];
  const reads = [];
  const pressed = [];
  let onScreen = [{ id: "other-chat", session: "local_other", at: 2 }];
  // The card, as the helper reads it in the app.
  const drawn = {
    found: true,
    texts: ["Allow Claude to run this command?", 'cd ~/.claude/projects && grep -l "flipping coing" *.jsonl', "Deny", "Allow once"],
    buttons: [
      { label: "Copy", menu: false },
      { label: "Deny", menu: false },
      { label: "Always allow for this project", menu: false },
      { label: "Allow once", menu: false },
    ],
  };
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now() - 60_000, status: "idle" }],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/reach", status: "idle" }, items, before: null }),
    },
    live: async () => running,
    liveMs: -1,
    claudeHost: host(fakeClaude()),
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    open: async (url) => {
      opened.push(url);
      onScreen = [{ id: ID, session: "local_4348", at: 3 }, ...onScreen];
    },
    claudeShown: () => onScreen,
    readCard: async (agent, expect) => (reads.push([agent, expect]), drawn),
    pressCard: async (agent, label, expect) => {
      pressed.push([agent, label, expect]);
      // Answered: Claude Code goes on, the call gets its result.
      running = new Map([[ID, { ...app, busy: true, waiting: null }]]);
      items[1] = { ...items[1], status: "completed" };
    },
  });
  const { session } = await sessions.read("claude", ID);
  assert.deepEqual(session.asking, { kind: "permission", text: items[1].text, command: true, id: "app-permission:toolu_9" });
  // Explicitly brought up from the phone: the chat shown in the app, its card read there
  // (the one that names this command: its first 40 characters).
  assert.deepEqual(await sessions.card("claude", ID, { bring: true }), {
    id: "app-permission:toolu_9",
    texts: ["Allow Claude to run this command?", 'cd ~/.claude/projects && grep -l "flipping coing" *.jsonl'],
    buttons: ["Deny", "Always allow for this project", "Allow once"],
  });
  assert.deepEqual(opened, ["claude://code/needs-input?session=local_4348"]);
  assert.deepEqual(reads, [["claude", ['cd ~/.claude/projects && grep -l "flippi']]]);
  // Only a button the card has, for the request still waiting.
  await assert.rejects(sessions.respond("claude", ID, "app-permission:toolu_9", { label: "Allow forever" }), (e) => e.status === 400);
  await assert.rejects(sessions.respond("claude", ID, "app-permission:toolu_1", { label: "Allow once" }), /already answered/);
  assert.deepEqual(pressed, []);
  assert.deepEqual(await sessions.respond("claude", ID, "app-permission:toolu_9", { label: "Always allow for this project" }), { answered: true });
  assert.deepEqual(pressed, [["claude", "Always allow for this project", ['cd ~/.claude/projects && grep -l "flippi']]]);
  // Already on screen: not brought up again.
  assert.equal(opened.length, 1);
  await assert.rejects(sessions.respond("claude", ID, "app-permission:toolu_9", { label: "Deny" }), /already answered/);
  await assert.rejects(sessions.card("claude", ID), /already answered/);
  assert.equal((await sessions.read("claude", ID)).session.asking, undefined);
  sessions.close();
});

// Same for the Codex app: its card ("Do you want ChatGPT to run this
// command?") read with the chat opened in the Codex app, answered with one of
// its own buttons, then remembered as answered while the command runs.
test("a Codex app approval shows on the phone as the Codex app draws it and is answered the same way", async () => {
  let asking = { kind: "permission", text: "May I build it?", callId: "c7", match: "npm run build && npm test", id: "app-permission:codex:c7" };
  const opened = [];
  const pressed = [];
  const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: {
      list: async () => [],
      health: async () => ({}),
      read: async (id) => ({ session: { agent: "codex", id, status: asking ? "waiting" : "running", held: "codex-app", ...(asking ? { asking } : {}) }, items: [], before: null }),
    },
    claude: { list: async () => [], starts: async () => [], health: async () => ({}) },
    live: async () => new Map(),
    liveMs: -1,
    claudeHost: host(fakeClaude()),
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    open: async (url) => opened.push(url),
    readCard: async () => ({
      found: true,
      texts: ["Do you want ChatGPT to run this command?", "Reason", "May I build it?", "npm run build && npm test"],
      buttons: [{ label: "Approval options", menu: true }, { label: "Allow once", menu: false }, { label: "Deny", menu: false }],
      // Read from the card's menu, opened and closed in the app.
      more: ["Allow this conversation", "Always allow"],
    }),
    pressCard: async (agent, label, expect) => {
      pressed.push([agent, label, expect]);
      asking = null;
    },
  });
  assert.deepEqual(await sessions.card("codex", CODEX), {
    id: "app-permission:codex:c7",
    texts: ["Do you want ChatGPT to run this command?", "Reason", "May I build it?", "npm run build && npm test"],
    buttons: ["Allow once", "Deny"],
    // The choices behind the card's menu, as the app lists them.
    more: ["Allow this conversation", "Always allow"],
  });
  assert.deepEqual(opened, [`codex://threads/${CODEX}`]);
  await assert.rejects(sessions.respond("codex", CODEX, "app-permission:codex:c6", { label: "Deny" }), /already answered/);
  // One of the menu's choices: pressed in the app's menu.
  assert.deepEqual(await sessions.respond("codex", CODEX, "app-permission:codex:c7", { label: "Always allow" }), { answered: true });
  assert.deepEqual(pressed, [["codex", "Always allow", ["npm run build && npm test"]]]);
  sessions.close();
});

test("only the apps' own cards get read: a terminal's prompt and a chat no longer waiting don't", async () => {
  const items = [{ id: "toolu_5", role: "tool", kind: "command", status: "running", text: "npm test", detail: "" }];
  let live = { where: "terminal", pid: 17, tty: "ttys002", exact: true, busy: false, waiting: "permission prompt" };
  const touched = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now(), status: "idle" }],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/w", status: "idle" }, items, before: null }),
    },
    live: async () => new Map([[ID, live]]),
    liveMs: -1,
    claudeHost: host(fakeClaude()),
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    claudeShown: () => [{ id: ID, session: "local_1", at: 1 }],
    open: async (...a) => touched.push(["open", ...a]),
    readCard: async (...a) => (touched.push(["read", ...a]), { found: true, texts: [], buttons: [] }),
    pressCard: async (...a) => touched.push(["press", ...a]),
  });
  // A terminal's prompt is said, answered there (for now).
  assert.deepEqual((await sessions.read("claude", ID)).session.asking, { kind: "permission", text: "npm test", command: true });
  await assert.rejects(sessions.card("claude", ID), /already answered/);
  await assert.rejects(sessions.respond("claude", ID, "app-permission:toolu_5", { label: "Allow once" }), /already answered/);
  // The app's chat, but Claude Code isn't waiting on a card: nothing to read or press.
  live = { where: "claude-app", pid: 18, tty: null, exact: true, busy: true, waiting: null };
  await assert.rejects(sessions.card("claude", ID), /already answered/);
  assert.deepEqual(touched, []);
  sessions.close();
});

test("the session service exposes live requests without a hook listener", async () => {
  const claude = fakeClaude();
  const claudeHost = host(claude);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-no-hooks-"));
  const sessions = createAgentSessions({
    dataDir, listenForAsks: true,
    daemon: { close() {}, rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}) },
    claude: { list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now(), status: "idle" }], starts: async () => [], health: async () => ({}) },
    live: async () => new Map(), claudeHost, signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    macPrompts: { start() {}, close() {}, current: () => ({ prompts: [] }) },
  });
  try {
    assert.equal(sessions.asks, undefined);
    assert.equal(fs.existsSync(path.join(dataDir, "agent-hook.sock")), false);
    await claudeHost.send(ID, { text: "Check the tests", cwd: "/work" });
    claude.last().print({ type: "control_request", request_id: "real-question", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which tests?", options: [{ label: "Unit", description: "" }], multiSelect: false }] } } });
    assert.equal(sessions.view("claude", ID).prompts[0].id, "real-question");
    assert.equal((await sessions.list()).sessions[0].prompts[0].id, "real-question");
    await sessions.respond("claude", ID, "real-question", { answers: { "Which tests?": ["Unit"] } });
    assert.deepEqual(claude.last().lines.at(-1).response.response.updatedInput.answers, { "Which tests?": "Unit" });
    assert.deepEqual(sessions.view("claude", ID).prompts, []);
    await assert.rejects(sessions.respond("claude", ID, "real-question", { answers: { "Which tests?": ["Unit"] } }), e => e.status === 409);
  } finally {
    sessions.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("while Reach replies, its own Claude Code process isn't where the session lives (it read as Terminal)", async () => {
  // Reach's reply process, as Claude Code's registry lists it: an interactive process.
  const running = new Map([[ID, { where: "terminal", pid: 5151, tty: null, exact: true, busy: true, waiting: null }]]);
  let drives = true;
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [{ agent: "claude", id: ID, updatedAt: Date.now(), status: "idle", inApp: true }],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/site", status: "idle", inApp: true }, items: [], before: null }),
    },
    live: async () => running,
    claudeHost: {
      onRelease() {},
      drives: () => drives,
      running: () => drives,
      view: () => ({ status: "running", version: 1, prompts: [], streaming: "", activity: null, error: null, items: 0 }),
    },
    signIn: {},
    liveMs: -1,
    claudeImports: { add: async () => {}, close() {} },
  });
  const { session } = await sessions.read("claude", ID);
  assert.equal(session.held, "reach");
  assert.equal(session.live, undefined);
  assert.equal(session.status, "running");
  const [listed] = (await sessions.list()).sessions;
  assert.equal(listed.live, undefined);
  assert.equal(listed.status, "running");
  // Once Reach lets go, a real terminal holding it reads as one again.
  drives = false;
  assert.equal((await sessions.read("claude", ID)).session.live.where, "terminal");
  sessions.close();
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


test("watching a Claude session survives long-poll gaps but expires after leaving", async () => {
  let now = 1000;
  const h = host(fakeClaude(), { now: () => now, graceMs: 5000 });
  assert.equal(h.watched(ID), false);
  await h.changes(ID, -1); // an immediate version response, no waiter
  assert.equal(h.watched(ID), true);
  now += 4999;
  assert.equal(h.watched(ID), true);
  now += 2;
  assert.equal(h.watched(ID), false);
  const controller = new AbortController();
  const waiting = h.changes(ID, h.view(ID).version, 25000, controller.signal);
  now += 6000;
  assert.equal(h.watched(ID), true, "an active long poll stays watched");
  controller.abort();
  await waiting;
  assert.equal(h.watched(ID), true);
  now += 5001;
  assert.equal(h.watched(ID), false);
  assert.equal(h.watched("another-session"), false);
  h.close();
});

test("Claude answers remain pending until delivered, uncertain writes pause, and duplicate taps never send twice", async (t) => {
  const claude = fakeClaude();
  const h = host(claude);
  t.after(() => h.close());
  await h.send(ID, { text: "hello", cwd: "/work/app" });
  const proc = claude.last();
  proc.print({ type: "control_request", request_id: "real", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" } } });
  let callback;
  const writes = [];
  proc.stdin.write = (line, cb) => { writes.push(JSON.parse(line)); callback = cb; };
  const failed = h.respond(ID, "real", { decision: "allow" });
  assert.equal(h.view(ID).prompts.length, 1);
  assert.equal(h.view(ID).prompts[0].replying, undefined);
  await assert.rejects(h.respond(ID, "real", { decision: "deny" }), /already attempted/);
  assert.equal(writes.length, 1);
  callback(new Error("broken pipe"));
  await assert.rejects(failed, { code: "AGENT_DELIVERY_UNKNOWN" });
  assert.equal(h.view(ID).prompts.length, 1);
  await assert.rejects(h.respond(ID, "real", { decision: "deny" }), /already attempted/);
  assert.equal(writes.length, 1);
  proc.print({ type: "control_cancel_request", request_id: "real" });
  assert.equal(h.view(ID).prompts.length, 0);
});

test("Claude cancellations and disconnected processes cannot be answered or leak old requests", async (t) => {
  const claude = fakeClaude();
  const h = host(claude);
  t.after(() => h.close());
  await h.send(ID, { text: "hello", cwd: "/work/app" });
  const proc = claude.last();
  const ask = id => proc.print({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" } } });
  ask("cancelled");
  proc.print({ type: "control_cancel_request", request_id: "cancelled" });
  await assert.rejects(h.respond(ID, "cancelled", { decision: "allow" }), /already answered/);
  ask("disconnected");
  proc.stdin.write = () => {};
  const answer = h.respond(ID, "disconnected", { decision: "allow" });
  proc.exit();
  await assert.rejects(answer, { code: "AGENT_DELIVERY_UNKNOWN" });
  assert.equal(h.view(ID).prompts.length, 0);
  await h.send(ID, { text: "continue", cwd: "/work/app" });
  ask("old-process");
  proc.exit();
  assert.equal(h.view(ID).prompts.length, 0);
  assert.equal(h.drives(ID), true);
});

test("an old Claude process cannot clear the replacement's running turn", async (t) => {
  const claude = fakeClaude(); const h = host(claude); t.after(() => h.close());
  await h.send(ID, { text: "first", effort: "low" });
  const old = claude.last();
  old.print({ type: "result", subtype: "success", is_error: false });
  await h.send(ID, { text: "second", effort: "high" });
  const current = claude.last();
  assert.notEqual(old, current);
  old.exit(); old.print({ type: "result", subtype: "success" });
  assert.equal(h.view(ID).status, "running"); assert.equal(h.drives(ID), true);
});

test("concurrent Claude sends share one initialized process", async (t) => {
  const claude = fakeClaude(); const h = host(claude); t.after(() => h.close());
  await Promise.all([h.send(ID, { text: "one" }), h.send(ID, { text: "two" })]);
  assert.equal(claude.runs.length, 1);
  assert.equal(claude.last().lines.filter(m => m.type === "user").length, 2);
});

test("a failed Claude approval write remains uncertain and cannot be replayed", async (t) => {
  const claude = fakeClaude(); const h = host(claude); t.after(() => h.close());
  await h.send(ID, { text: "one" });
  const proc = claude.last();
  proc.print({ type: "control_request", request_id: "ask", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "example" } } });
  let writes = 0;
  proc.stdin.write = (_, cb) => { writes++; cb(Error("broken pipe")); };
  await assert.rejects(h.respond(ID, "ask", { decision: "allow" }), { code: "AGENT_DELIVERY_UNKNOWN" });
  await assert.rejects(h.respond(ID, "ask", { decision: "allow" }), /already attempted/);
  assert.equal(writes, 1);
});

test("a changed Claude stream fails visibly instead of leaving a permanent spinner", async (t) => {
  const claude = fakeClaude(); const h = host(claude); t.after(() => h.close());
  await h.send(ID, { text: "one" });
  claude.last().print({ type: "assistant", message: { content: {} } });
  assert.equal(h.view(ID).status, "idle");
  assert.match(h.view(ID).error, /incompatible/);
});

test("Claude exposes real prompt changes to notification subscribers, without executing answers", async t => {
  const claude = fakeClaude(); const h = host(claude); t.after(() => h.close());
  const prompts = [];
  const stop = h.onChange(id => prompts.push(h.view(id).prompts.map(p => p.id)));
  await h.send(ID, { text: "one" });
  claude.last().print({ type: "control_request", request_id: "ask", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "example" } } });
  assert.deepEqual(prompts.at(-1), ["ask"]);
  assert.equal(claude.last().lines.some(m => m.type === "control_response"), false);
  stop();
});

test("the session service forwards real host prompts to its notification subscription", async t => {
  const claude = fakeClaude(); const h = host(claude);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-notify-protocol-"));
  const sessions = createAgentSessions({ dataDir: dir, claudeHost: h });
  t.after(() => { sessions.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const events = [];
  const unsubscribe = sessions.onPromptChange((agent, id, prompts) => events.push({ agent, id, prompts }));
  await h.send(ID, { text: "one" });
  claude.last().print({ type: "control_request", request_id: "native-ask", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "example" } } });
  assert.equal(events.at(-1).agent, "claude");
  assert.equal(events.at(-1).prompts[0].id, "native-ask");
  unsubscribe();
});

// The Codex app (ChatGPT.app's Chromium view) shows macOS accessibility a
// dozen elements and none of its cards: opening one brought the app to the
// front for nothing. Asked first, it's said at once and the app stays put.
test("an app that shows Reach nothing isn't brought up to read a card", async () => {
  const { createAppCards } = await import("../server/agent-sessions/app-cards.mjs");
  const touched = [];
  const cards = createAppCards({
    probe: async (agent) => ({ elements: agent === "codex" ? 12 : 400 }),
    pending: async (agent) => ({ id: `app-permission:${agent === "codex" ? "codex:c1" : "t1"}`, expect: ["npm test"], appSessionId: "local_1" }),
    open: async (url) => touched.push(["open", url]),
    read: async (agent) => (touched.push(["read", agent]), { found: true, texts: [], buttons: [{ label: "Deny" }, { label: "Allow once" }] }),
    press: async () => touched.push(["press"]),
    shown: () => [{ id: "chat", session: "local_1" }],
    wait: async () => {},
  });
  await assert.rejects(cards.card("codex", "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"), /doesn't let Reach see its cards/);
  assert.deepEqual(touched, []);
  assert.deepEqual((await cards.card("claude", "chat")).buttons, ["Deny", "Allow once"]);
  assert.deepEqual(touched, [["read", "claude"]]);
});

// Two Claude app chats waiting on a permission, each opened on the phone:
// reading each card switched the app's window to it and left it there, so the
// Mac flipped between the two. Looking never switches it under someone using
// the app, and puts it back on its chat; only "Bring it up" leaves it there.
test("looking at a Claude app card never leaves the app on another chat", async () => {
  const { createAppCards } = await import("../server/agent-sessions/app-cards.mjs");
  const opened = [];
  let inFront = true;
  const cards = createAppCards({
    pending: async (agent, id) => ({ id: `app-permission:${id}`, expect: ["npm test"], appSessionId: `local_${id}` }),
    open: async (url) => opened.push(url),
    read: async () => ({ found: true, texts: [], buttons: [{ label: "Deny" }, { label: "Allow once" }] }),
    press: async () => {},
    shown: () => [{ id: "a", session: "local_a" }],
    frontmost: async () => inFront,
    idle: async () => 5,
    wait: async () => {},
  });
  // In the Claude app, using it: nothing switches.
  await assert.rejects(cards.card("claude", "b"), (e) => e.inApp === true);
  assert.deepEqual(opened, []);
  // In another app: read, then back on the chat it showed.
  inFront = false;
  assert.deepEqual((await cards.card("claude", "b")).buttons, ["Deny", "Allow once"]);
  assert.deepEqual(opened, ["claude://code/needs-input?session=local_b", "claude://code/continue?session=local_a"]);
  // Brought up on a tap: it stays.
  opened.length = 0;
  inFront = true;
  await cards.card("claude", "b", { bring: true });
  assert.deepEqual(opened, ["claude://code/needs-input?session=local_b"]);
});

test("an uncertain app or terminal approval cannot be replayed from another phone", async () => {
  const { createAppCards } = await import("../server/agent-sessions/app-cards.mjs");
  for (const tty of [null, "ttys001"]) {
    let presses = 0;
    const read = async () => ({ found: true, texts: ["Run example?"], buttons: [{ label: "Allow once" }, { label: "Deny" }] });
    const press = async () => { presses++; throw Error("Answer delivery unknown"); };
    const cards = createAppCards({
      pending: async () => ({ id: "app-permission:p1", expect: ["example"], tty }),
      shown: () => [{ id: "chat" }], read, press, terminal: { read, press },
    });
    await cards.card("claude", "chat");
    await assert.rejects(cards.answer("claude", "chat", "app-permission:p1", { label: "Allow once" }), /delivery unknown/);
    await assert.rejects(cards.answer("claude", "chat", "app-permission:p1", { label: "Deny" }), /already attempted/);
    await assert.rejects(cards.card("claude", "chat"), /already attempted/);
    assert.equal(presses, 1);
  }
});

// The card as the Claude app reads it out (seen on the phone, 2026-10-06): the
// sentence in pieces, the description twice, then the command. It showed as
// six loose lines; now as the card shows it.
test("a card's words are put back as the card shows them", async () => {
  const { cardLines } = await import("../server/agent-sessions/app-cards.mjs");
  const command = 'stat -f "%Sm %N" -t "%H:%M:%S" .reach/quick/reach-permission-card-* .reach/quick/notification-seen.json';
  assert.deepEqual(
    cardLines(
      ["Allow Claude to", "run", "Check when the card helper was built and notifications seen", "?", "Check when the card helper was built and notifications seen", command, "Deny", "Allow once"],
      { buttons: ["Deny", "Allow once"], command: [command.slice(0, 40)] },
    ),
    ["Allow Claude to run Check when the card helper was built and notifications seen?", command],
  );
  // Already whole: as it was.
  assert.deepEqual(cardLines(["Do you want ChatGPT to run this command?", "npm test"], { command: ["npm test"] }), ["Do you want ChatGPT to run this command?", "npm test"]);
});

// Seen in the end-to-end test (2026-10-06): after Stop, Reach lets go of its
// Claude Code process, which is still exiting for a few seconds; found among
// the processes without Claude Code's own status, with a transcript just
// written, it read as working and the phone showed Working well after Stop.
test("a process Reach just let go of doesn't read as working while it exits", async () => {
  let release;
  const claudeHost = {
    ...host(fakeClaude()),
    onRelease: (listener) => (release = listener),
    running: () => false,
    drives: () => false,
  };
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/w", status: "idle", updatedAt: Date.now() - 2000 }, items: [], before: null }),
    },
    // The exiting process: found by the process list, no word of its own.
    live: async () => new Map([[ID, { where: "background", pid: 77, tty: null, exact: false }]]),
    liveMs: -1,
    claudeHost,
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
  });
  // Before (any process with a fresh transcript): working, as before.
  assert.equal((await sessions.read("claude", ID)).session.status, "running");
  release(ID, { wrote: true });
  assert.equal((await sessions.read("claude", ID)).session.status, "idle");
  sessions.close();
});

// "It says Working even though it's not." A message sent while Claude runs
// tools is folded into that turn: Claude Code echoes it, then sends one
// result for both (seen with a real `claude -p`). The chat must go idle.
test("a message sent mid-turn ends with that turn's result, not Working for good", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  const replay = (text) => ({ type: "user", isReplay: true, parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
  await h.send(ID, { text: "run the tests", cwd: "/work/app" });
  const proc = claude.last();
  proc.print(replay("run the tests"));
  await h.send(ID, { text: "and the docs?" });
  proc.print({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", content: "ok" }] } });
  proc.print(replay("and the docs?"));
  assert.equal(h.running(ID), true);
  proc.print({ type: "result", subtype: "success", is_error: false, result: "Done, docs too." });
  assert.equal(h.running(ID), false);
  assert.equal(h.view(ID).status, "idle");

  // Sent just as a turn ends: not picked up yet, so its own turn follows.
  await h.send(ID, { text: "one more" });
  proc.print(replay("one more"));
  await h.send(ID, { text: "and another" });
  proc.print({ type: "result", subtype: "success", is_error: false, result: "One more done." });
  assert.equal(h.view(ID).status, "running", "the last message hasn't been picked up yet");
  proc.print(replay("and another"));
  proc.print({ type: "result", subtype: "success", is_error: false, result: "Another done." });
  assert.equal(h.view(ID).status, "idle");
});

// "I keep changing permissions to Auto but it reverts to Manual." The
// transcript keeps the mode of the chat's last message (Manual); filled in
// on the next message, it switched Reach's Claude Code straight back.
test("Auto picked for a chat Reach runs stays Auto on its next messages", async () => {
  const claude = fakeClaude();
  const claudeHost = host(claude);
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: {
      list: async () => [],
      starts: async () => [],
      health: async () => ({ agent: "claude", installed: true, signedIn: true }),
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work/site", status: "idle", mode: "default" }, items: [], before: null }),
    },
    live: async () => new Map(),
    claudeHost,
    signIn: {},
    liveMs: -1,
  });
  await sessions.send("claude", ID, { text: "first" });
  const proc = claude.last();
  proc.print({ type: "result", is_error: false });
  // Claude Code confirms each mode change.
  const write = proc.stdin.write;
  proc.stdin.write = (text, callback) => {
    write(text, callback);
    for (const l of text.split("\n").filter(Boolean).map((t) => JSON.parse(t)))
      if (l.request?.subtype === "set_permission_mode")
        queueMicrotask(() => proc.print({ type: "control_response", response: { subtype: "success", request_id: l.request_id } }));
  };
  assert.deepEqual(await sessions.mode("claude", ID, { mode: "auto" }), { mode: "auto", applied: true });
  await sessions.send("claude", ID, { text: "second" });
  const modes = proc.lines.filter((l) => l.request?.subtype === "set_permission_mode").map((l) => l.request.mode);
  assert.ok(modes.length && modes.every((m) => m === "auto"), `never set back to Manual: ${modes}`);
  assert.equal((await sessions.read("claude", ID)).session.mode, "auto");
  // Picked between turns, after its process went: it relaunches in Auto.
  proc.print({ type: "result", is_error: false });
  claudeHost.release(ID);
  await sessions.mode("claude", ID, { mode: "acceptEdits" });
  await sessions.send("claude", ID, { text: "third" });
  const args = claude.last().args;
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("one sub-agent stops, the chat going on, while Reach runs it (stop_task); otherwise it's stopped on the Mac", async (t) => {
  const claude = fakeClaude(), h = host(claude);
  t.after(() => h.close());
  await assert.rejects(h.stopTask(ID, "a28230b100dfc3978"), (e) => e.status === 409 && /isn't running this chat/.test(e.message));
  await h.send(ID, { text: "audit it", cwd: "/work/app" });
  assert.deepEqual(await h.stopTask(ID, "a28230b100dfc3978"), { stopped: true });
  assert.deepEqual(claude.last().lines.find((l) => l.request?.subtype === "stop_task").request, { subtype: "stop_task", task_id: "a28230b100dfc3978" });
  await assert.rejects(h.stopTask(ID, "../x"), (e) => e.status === 404);
});

test("rewind, as Claude Code's own: what would change, the code back, and the conversation going on from before the message", async (t) => {
  const claude = fakeClaude(), h = host(claude);
  t.after(() => h.close());
  const MSG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", BEFORE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  // Nothing running: one is started to answer (resumed, never a new session).
  assert.deepEqual(await h.rewindFiles(ID, { messageId: MSG, cwd: "/work/app", dryRun: true }), {
    canRewind: true,
    files: ["src/a.ts", "src/b.ts"],
    insertions: 12,
    deletions: 4,
  });
  const first = claude.last();
  assert.deepEqual(first.args.slice(first.args.indexOf("--resume"), first.args.indexOf("--resume") + 2), ["--resume", ID]);
  assert.deepEqual(first.lines.find((l) => l.request?.subtype === "rewind_files").request, { subtype: "rewind_files", user_message_id: MSG, dry_run: true });
  await h.rewindFiles(ID, { messageId: MSG });
  assert.equal(first.lines.filter((l) => l.request?.subtype === "rewind_files").at(-1).request.dry_run, undefined);
  // The conversation: the running process ends; the next message resumes there.
  assert.deepEqual(h.rewindConversation(ID, BEFORE), { rewound: true });
  assert.equal(first.ended, true);
  assert.equal(h.rewoundTo(ID), BEFORE);
  await h.send(ID, { text: "do it differently" });
  const next = claude.last();
  assert.notEqual(next, first);
  const at = next.args.indexOf("--resume-session-at");
  assert.deepEqual(next.args.slice(at, at + 2), ["--resume-session-at", BEFORE]);
  assert.equal(h.rewoundTo(ID), null, "done once the next message goes");
  await assert.rejects(h.rewindFiles(ID, { messageId: "../x" }), (e) => e.status === 404);
});
