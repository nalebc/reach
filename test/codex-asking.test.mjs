import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexWaitingApproval } from "../server/agent-sessions/codex-asks.mjs";
import { codexRunningElsewhere, createCodexSessions } from "../server/agent-sessions/codex.mjs";

// A command the Codex app asked you to allow ("May I apply and build…",
// 2026-10-05) never showed on the phone: the Codex app held the chat and
// keeps its approval card to itself. The chat's file records the command
// asking for more permission, with Codex's question, and its output only once
// it was answered.
const ID = "01a10dff-7671-7232-8f99-4f1225dd072a";
const QUESTION = "May I apply and build the restored Reach screen and verified typing fix in the running checkout?";
const entry = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
const started = entry("event_msg", { type: "task_started" });
// As Codex writes them (verified): a command run from its script tool, and a plain one.
const scriptCall = (callId) =>
  entry("response_item", {
    type: "custom_tool_call",
    call_id: callId,
    name: "exec",
    status: "completed",
    input: `text(await tools.exec_command({"cmd":"python3 build.py","sandbox_permissions":"require_escalated","justification":${JSON.stringify(QUESTION)}}))`,
  });
const plainCall = (callId, args) =>
  entry("response_item", { type: "function_call", call_id: callId, name: "exec_command", arguments: JSON.stringify(args) });
const output = (callId) => entry("response_item", { type: "custom_tool_call_output", call_id: callId, output: "done" });

function chatFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-asks-"));
  const file = path.join(dir, `rollout-${ID}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a command waiting for your OK in the Codex app is read from the chat's file, with Codex's question", async () => {
  const { file, done } = chatFile([started, scriptCall("c1")]);
  try {
    assert.deepEqual(await codexWaitingApproval(file), { kind: "permission", text: QUESTION });
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
    [[started, plainCall("p1", { cmd: "npm run build", sandbox_permissions: "require_escalated" })], { kind: "permission", text: "npm run build", command: true }],
    // Inside the sandbox: nothing to allow.
    [[started, plainCall("p2", { cmd: "ls" })], null],
    // From the turn before this one.
    [[scriptCall("old"), started], null],
  ];
  for (const [lines, want] of cases) {
    const { file, done } = chatFile(lines);
    try {
      assert.deepEqual(await codexWaitingApproval(file), want);
    } finally {
      done();
    }
  }
  assert.equal(await codexWaitingApproval(path.join(os.tmpdir(), "reach-no-such-rollout.jsonl")), null);
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
    assert.deepEqual(session.asking, { kind: "permission", text: QUESTION });
    assert.equal((await codex.list())[0].status, "waiting");
    // Answered in the Codex app: it runs on.
    fs.appendFileSync(file, output("c1") + "\n");
    const after = await codex.read(ID);
    assert.equal(after.session.status, "running");
    assert.equal(after.session.asking, undefined);
    assert.equal((await codex.list())[0].status, "running");
  } finally {
    done();
    fs.rmSync(locks, { recursive: true, force: true });
  }
});
