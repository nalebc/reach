import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Codex } from "../server/codex.mjs";
test("Codex adapter streams messages and requires explicit approval", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-"));
  const c = new Codex({ dataDir });
  const sent = [];
  c.send = (m, callback) => { sent.push(m); callback?.(); };
  c.chats.push({
    id: "thread-1",
    name: "Test",
    status: "running",
    items: [],
    approvals: [],
  });
  c.receive({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", itemId: "message-1", delta: "Hello " },
  });
  c.receive({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", itemId: "message-1", delta: "phone" },
  });
  assert.equal(c.get("thread-1").items[0].text, "Hello phone");
  c.receive({
    id: 12,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", command: "touch example.txt" },
  });
  assert.equal(sent.length, 0);
  assert.equal(c.get("thread-1").status, "waiting");
  await assert.rejects(() => c.respond("thread-1", 12, { decision: "anything" }));
  await c.respond("thread-1", 12, { decision: "decline" });
  assert.deepEqual(sent.at(-1), { id: 12, result: { decision: "decline" } });
  c.receive({
    id: 13,
    method: "item/permissions/requestApproval",
    params: { threadId: "thread-1" },
  });
  assert.ok(sent.at(-1).error);
  assert.equal(c.get("thread-1").approvals.length, 0);
  c.receive({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { status: "completed" } },
  });
  assert.equal(c.get("thread-1").status, "idle");
  c.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a turn/completed with a status Reach doesn't know keeps the chat and its approvals", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-codex-"));
  const c = new Codex({ dataDir });
  c.send = () => {};
  c.chats.push({ id: "thread-1", name: "Test", status: "running", items: [], approvals: [] });
  c.receive({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "t1" } } });
  c.receive({ id: 12, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "touch a" } });
  c.receive({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "t1", status: "futureBlockedState" } } });
  assert.notEqual(c.get("thread-1").status, "idle");
  assert.equal(c.get("thread-1").approvals.length, 1);
  c.receive({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "t1", status: "interrupted" } } });
  assert.equal(c.get("thread-1").status, "idle");
  c.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
