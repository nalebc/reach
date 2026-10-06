import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexWaitingApproval, markCodexAnswered } from "../server/agent-sessions/codex-asks.mjs";
import { codexRunningElsewhere, createCodexSessions } from "../server/agent-sessions/codex.mjs";

// A command the Codex app asked you to allow ("May I apply and build…",
// 2026-10-05) never showed on the phone: the Codex app held the chat and
// keeps its approval card to itself. The chat's file records the command
// asking for more permission, with Codex's question, and its output only once
// it was answered.
const ID = "01a10dff-7671-7232-8f99-4f1225dd072a";
const QUESTION = "May I apply and build the restored Reach screen and verified typing fix in the running checkout?";
// Written a minute ago: a request still unanswered then is one the app shows.
const entry = (type, payload, ago = 60000) => JSON.stringify({ timestamp: new Date(Date.now() - ago).toISOString(), type, payload });
const started = entry("event_msg", { type: "task_started" });
// The turn's settings: who reviews requests ("user" is you; "auto_review" is
// Codex's own reviewer, the app's "Approve for me").
const settings = (reviewer) => entry("turn_context", { approval_policy: "on-request", approvals_reviewer: reviewer });
// As Codex writes them (verified): a command run from its script tool, and a plain one.
const scriptCall = (callId, ago) =>
  entry("response_item", {
    type: "custom_tool_call",
    call_id: callId,
    name: "exec",
    status: "completed",
    input: `text(await tools.exec_command({"cmd":"python3 build.py","sandbox_permissions":"require_escalated","justification":${JSON.stringify(QUESTION)}}))`,
  }, ago);
const plainCall = (callId, args) =>
  entry("response_item", { type: "function_call", call_id: callId, name: "exec_command", arguments: JSON.stringify(args) });
const output = (callId) => entry("response_item", { type: "custom_tool_call_output", call_id: callId, output: "done" });
// What it asks, without when (checked on its own).
const what = (asked) => asked && (({ since, ...rest }) => rest)(asked);

function chatFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-asks-"));
  const file = path.join(dir, `rollout-${ID}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a command waiting for your OK in the Codex app is read from the chat's file, with Codex's question", async () => {
  const { file, done } = chatFile([started, scriptCall("c1")]);
  try {
    const asked = await codexWaitingApproval(file);
    assert.deepEqual(what(asked), { kind: "permission", text: QUESTION, callId: "c1", match: "python3 build.py" });
    // When it asked, from the file: the list's settle counts from then.
    assert.ok(Math.abs(asked.since - (Date.now() - 60000)) < 5000);
    // Answered in the Codex app: its output is in the file.
    fs.appendFileSync(file, output("c1") + "\n");
    assert.equal(await codexWaitingApproval(file), null);
  } finally {
    done();
  }
});

test("only a command asking for more permission, in the turn running now, counts", async () => {
  const cases = [
    // No question given: the command itself is shown.
    [[started, plainCall("p1", { cmd: "npm run build", sandbox_permissions: "require_escalated" })], { kind: "permission", text: "npm run build", command: true, callId: "p1", match: "npm run build" }],
    // Inside the sandbox: nothing to allow.
    [[started, plainCall("p2", { cmd: "ls" })], null],
    // From the turn before this one.
    [[scriptCall("old"), started], null],
  ];
  for (const [lines, want] of cases) {
    const { file, done } = chatFile(lines);
    try {
      assert.deepEqual(what(await codexWaitingApproval(file)), want);
    } finally {
      done();
    }
  }
  assert.equal(await codexWaitingApproval(path.join(os.tmpdir(), "reach-no-such-rollout.jsonl")), null);
});

// "Codex needs your answer" flashed on the phone and was gone (2026-10-06): the
// chat was in "Approve for me", where Codex's own reviewer allowed the command
// within seconds; you were never asked.
test("in \"Approve for me\", or in its first seconds, a request isn't taken for one waiting on you", async () => {
  const cases = [
    // Codex's reviewer decides: never counted from the file.
    [[started, settings("auto_review"), scriptCall("c1")], null],
    // Asked of you, but just now: a saved rule may let it run.
    [[started, settings("user"), scriptCall("c1", 2000)], null],
    // Asked of you a minute ago and still unanswered: waiting on you.
    [[started, settings("user"), scriptCall("c1")], { kind: "permission", text: QUESTION, callId: "c1", match: "python3 build.py" }],
    // The reviewer changed to you mid-turn: the newest settings count.
    [[started, settings("auto_review"), entry("event_msg", { type: "thread_settings_applied", thread_settings: { approvals_reviewer: "user" } }), scriptCall("c1")], { kind: "permission", text: QUESTION, callId: "c1", match: "python3 build.py" }],
  ];
  for (const [lines, want] of cases) {
    const { file, done } = chatFile(lines);
    try {
      assert.deepEqual(what(await codexWaitingApproval(file)), want);
    } finally {
      done();
    }
  }
});

test("a long turn is read back to its start for its settings", async () => {
  const padding = Array.from({ length: 40 }, (_, i) => entry("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(200) + i }] }));
  const { file, done } = chatFile([started, settings("auto_review"), ...padding, scriptCall("c1")]);
  try {
    // The first read (a few bytes) ends mid-turn; the next goes back to its start.
    assert.equal(await codexWaitingApproval(file, { tails: [600, 1024 * 1024] }), null);
  } finally {
    done();
  }
});

test("a Codex chat the Codex app holds says it waits on you, in the chat and in the list", async () => {
  const { file, done } = chatFile([started, scriptCall("c1")]);
  // The Codex app holds the chat (its writer lock).
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-locks-"));
  fs.writeFileSync(path.join(locks, `${ID}.lock`), "");
  const thread = {
    id: ID,
    path: file,
    preview: "Fix the screen",
    cwd: "/work/app",
    source: "vscode",
    createdAt: Math.floor(Date.now() / 1000) - 60,
    updatedAt: Math.floor(Date.now() / 1000),
    status: { type: "notLoaded" },
  };
  const daemon = {
    async rpc(method) {
      if (method === "thread/read") return { thread };
      if (method === "thread/list") return { data: [thread] };
      if (method === "thread/items/list") return { data: [] };
      // Another engine's turn reads as interrupted, with no end (verified).
      if (method === "thread/turns/list") return { data: [{ id: "t1", status: "interrupted", completedAt: null }] };
      return {};
    },
  };
  try {
    const codex = createCodexSessions({
      daemon,
      holder: async () => "codex-app",
      appState: () => ({ mode: null, threads: {} }),
      runningElsewhere: codexRunningElsewhere({ daemon, locks, ttl: -1 }),
    });
    const { session } = await codex.read(ID);
    assert.equal(session.status, "waiting");
    // The Codex app's card: answerable from the phone, by this request's id.
    assert.deepEqual(session.asking, { kind: "permission", text: QUESTION, callId: "c1", match: "python3 build.py", id: "app-permission:codex:c1" });
    // Since when: a minute ago, as the file says, in the chat and the list.
    assert.ok(Math.abs(session.waitingSince - (Date.now() - 60000)) < 5000);
    const [listed] = await codex.list();
    assert.equal(listed.status, "waiting");
    assert.equal(listed.waitingSince, session.waitingSince);
    // Answered in the Codex app: it runs on.
    fs.appendFileSync(file, output("c1") + "\n");
    const after = await codex.read(ID);
    assert.equal(after.session.status, "running");
    assert.equal(after.session.asking, undefined);
    assert.equal(after.session.waitingSince, undefined);
    assert.equal((await codex.list())[0].status, "running");
  } finally {
    done();
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

// Allowed from the phone, a command runs on and writes nothing to the file
// until it ends: it read as still waiting on you all that time.
test("a request answered from the phone no longer waits, though its command still runs", async () => {
  const { file, done } = chatFile([started, scriptCall("c9")]);
  try {
    assert.equal((await codexWaitingApproval(file)).callId, "c9");
    markCodexAnswered("c9");
    assert.equal(await codexWaitingApproval(file), null);
    // A newer request in the same chat still counts.
    fs.appendFileSync(file, scriptCall("c10") + "\n");
    assert.equal((await codexWaitingApproval(file)).callId, "c10");
  } finally {
    done();
  }
});
