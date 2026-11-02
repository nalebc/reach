import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkflows } from "../server/agent-sessions/workflows.mjs";

// Controlled provider/relay histories, not live agents or workspace capture.
function fixture(t, { agent = 'codex' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-workflow-evidence-"));
  const file = path.join(dir, "workflows.json"), chats = new Map(), watches = new Map();
  let reads = 0, sequence = 0, failRead = false, clock = 1000;
  const sessions = {
    async list() { return { sessions: [] }; },
    async start(agent, body) {
      const threadId = `chat-${++sequence}`, turnId = `turn-${sequence}`;
      chats.set(threadId, { agent, threadId, turnId, items: [{ id: `request-${sequence}`, turnId, role: "user", kind: "text", text: body.text }] });
      return { threadId, turnId };
    },
    async read(_agent, id, options) {
      reads++;
      if (failRead) throw Error("Synthetic provider read error");
      const chat = chats.get(id);
      if (chat.readBarrier) await chat.readBarrier;
      if (chat.pages) return structuredClone(chat.pages[options.before || "latest"]);
      return { items: structuredClone(chat.items), before: null, session: { status: "idle" } };
    },
    async stop() { return { stopped: true }; },
  };
  const relays = {
    watch({ from }) { const id = `watch-${from.id}`; watches.set(id, { state: "waiting", chatId: from.id }); return id; },
    get: (id) => watches.get(id), cancel() {},
  };
  const options = { sessions, relays, file, folder: (p) => p, now: () => clock, setEvery: () => 0, clearEvery() {} };
  const workflows = createWorkflows(options);
  const w = workflows.create({ owner: "phone", cwd: "/work/fixture", tasks: [{ title: "Fix", task: "Fix the fixture", kind: "build", agent }] }).workflow;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { workflows, options, chats, file, w, get reads() { return reads; }, failRead: () => { failRead = true; }, tick: ms => { clock += ms; },
    async start() { workflows.run(w.id, "phone"); await workflows.sync(); return chats.get(workflows.get(w.id).tasks[0].chat.id); },
    async end(chat, { outcome = "reply", id = "answer", text = "Claimed fixed" } = {}) {
      if (outcome === "reply") chat.items.push({ id, turnId: chat.turnId, role: "assistant", kind: "text", text });
      Object.assign(watches.get(`watch-${chat.threadId}`), { state: "done", outcome, item: id });
      await workflows.sync();
    } };
}

test("workflow results persist bounded original commands/changes and freeze before later owner turns", async (t) => {
  const h = fixture(t), chat = await h.start();
  chat.items.push({ id: "command", turnId: chat.turnId, role: "tool", kind: "command", text: "npm test", status: "completed", detail: "Assertion failed", exitCode: 1, outputTruncated: false },
    { id: "change", turnId: chat.turnId, role: "tool", kind: "file-change", text: "src/total.mjs", status: "completed", detail: "-wrong\n+right" });
  await h.end(chat);
  const retained = h.workflows.taskResult(h.w.id, "t1"), first = retained.result;
  assert.deepEqual(retained.handoff, { answer: 'Claimed fixed', files: ['src/total.mjs'], diffs: '### src/total.mjs\n```diff\n-wrong\n+right\n```', source: 'task_reply', truncated: false });
  assert.deepEqual(retained.attempts, [{ attempt: 1, current: true }]);
  assert.equal(retained.attempt, 1);
  assert.equal(h.workflows.get(h.w.id).tasks[0].resultAvailable, true);
  assert.deepEqual(h.workflows.get(h.w.id).tasks[0].resultAttempts, [1]);
  assert.equal(h.workflows.list()[0].tasks[0].resultAvailable, undefined, 'the feed does not carry retained result details');
  assert.equal(first.evidenceFrozen, true);
  assert.equal(first.provenance.attempt, 1);
  assert.equal(first.provenance.workflowId, h.w.id);
  assert.equal(first.commands[0].exitCode, 1);
  assert.equal(first.summary, "Claimed fixed");
  assert.deepEqual(first.changes.map((i) => i.files), ["src/total.mjs"], "only recorded changes, without a worktree diff");
  chat.items.push({ id: "later", role: "user", kind: "text", text: "Later owner request", turnId: "later" },
    { id: "later-answer", role: "assistant", kind: "text", text: "Later owner answer", turnId: "later" });
  const reads = h.reads;
  await h.workflows.sync();
  const restarted = createWorkflows(h.options);
  assert.deepEqual(restarted.taskResult(h.w.id, "t1"), retained);
  assert.equal(h.reads, reads, "completed evidence is never recollected");
  assert.equal(JSON.stringify(first).includes("Later owner"), false);
  const disk = JSON.parse(fs.readFileSync(h.file));
  disk[0].tasks[0].result.evidence.commands[0].exitCode = 0;
  fs.writeFileSync(h.file, JSON.stringify(disk));
  assert.throws(() => createWorkflows(h.options).taskResult(h.w.id, "t1"), { status: 503 });
});

test("failed and empty collectors retain explicit gaps, and task controls cannot replace original evidence", async (t) => {
  const h = fixture(t), chat = await h.start();
  chat.items.push({ id: "command", turnId: chat.turnId, role: "tool", kind: "command", text: "npm test", detail: "Partial output", status: "running" });
  await h.end(chat, { outcome: "error", id: "missing-end" });
  const original = h.workflows.taskResult(h.w.id, "t1").result;
  assert.equal(original.historyIncomplete, true);
  assert.ok(original.unknowns.includes("execution_disposition_unknown"));
  assert.equal(original.commands[0].exitCode, null);
  chat.items.push({ id: "owner", role: "user", kind: "text", text: "Continue separately", turnId: "later" },
    { id: "owner-answer", role: "assistant", kind: "text", text: "Later handoff summary", turnId: "later" });
  assert.equal((await h.workflows.done(h.w.id, "t1", "phone")).workflow.tasks[0].summary, "Later handoff summary");
  assert.deepEqual(h.workflows.taskResult(h.w.id, "t1").result, original);
  assert.equal(h.workflows.taskResult(h.w.id, "t1").handoff.answer, "Later handoff summary");
  assert.equal(h.workflows.taskResult(h.w.id, "t1").handoff.source, "owner_marked_done", 'a later owner-selected handoff is labelled separately from frozen original receipts');
  const other = fixture(t), unreadable = await other.start();
  other.failRead();
  await other.end(unreadable);
  const missing = other.workflows.taskResult(other.w.id, "t1").result;
  assert.equal(missing.historyIncomplete, true);
  assert.ok(missing.unknowns.includes("collection_failed"));
  assert.deepEqual(missing.commands, []);
});

test("retry retains the prior attempt and legacy handoffs never acquire invented receipts", async (t) => {
  const h = fixture(t), chat = await h.start();
  await h.end(chat, { outcome: "error" });
  const first = h.workflows.taskResult(h.w.id, "t1", { attempt: 1 }).result;
  h.workflows.retry(h.w.id, "t1", "phone");
  await h.workflows.sync();
  assert.deepEqual(h.workflows.taskResult(h.w.id, 't1').attempts, [{ attempt: 1, current: false }], 'the retained prior result stays inspectable during a retry');
  const secondChat = h.chats.get(h.workflows.get(h.w.id).tasks[0].chat.id);
  await h.end(secondChat, { text: "Second result" });
  assert.deepEqual(h.workflows.taskResult(h.w.id, "t1", { attempt: 1 }).result, first);
  assert.equal(h.workflows.taskResult(h.w.id, "t1").result.provenance.attempt, 2);
  assert.deepEqual(h.workflows.get(h.w.id).tasks[0].resultAttempts, [1, 2]);
  assert.deepEqual(h.workflows.taskResult(h.w.id, 't1', { attempt: 1 }).attempts, [{ attempt: 1, current: false }, { attempt: 2, current: true }]);
  assert.throws(() => h.workflows.taskResult(h.w.id, "t1", { attempt: 0 }), { status: 400 });
  const disk = JSON.parse(fs.readFileSync(h.file));
  delete disk[0].tasks[0].result.evidence;
  // Load the actual legacy shape from disk, leaving its handoff untouched.
  fs.writeFileSync(h.file, JSON.stringify(disk));
  const restored = createWorkflows(h.options).taskResult(h.w.id, "t1").result;
  assert.equal(restored.summary, "Second result");
  assert.equal(restored.historyIncomplete, true);
  assert.ok(restored.unknowns.includes("legacy_result"));
  assert.deepEqual(restored.commands, []);
  assert.deepEqual(restored.changes, []);
});

test('the result reader exposes a bounded full handoff without requiring the provider chat', async t => {
  const h = fixture(t), chat = await h.start();
  const answer = `What changed\n\n${'Recorded implementation details. '.repeat(100)}\n\nRemaining: physical-device validation.`;
  await h.end(chat, { text: answer });
  assert.equal(h.workflows.get(h.w.id).tasks[0].summary.length, 280);
  const saved = h.workflows.taskResult(h.w.id, 't1');
  assert.equal(saved.handoff.answer, answer);
  assert.equal(saved.handoff.truncated, false);
  h.failRead();
  assert.deepEqual(createWorkflows(h.options).taskResult(h.w.id, 't1'), saved, 'completion remains readable with provider history unavailable');

  const long = fixture(t), longChat = await long.start();
  longChat.items.push({ id: 'change', turnId: longChat.turnId, role: 'tool', kind: 'file-change', text: 'src/total.mjs', status: 'completed', detail: 'diff detail\n'.repeat(1500) });
  await long.end(longChat, { text: 'Long result\n'.repeat(1000) });
  const clipped = long.workflows.taskResult(long.w.id, 't1');
  assert.equal(clipped.handoff.truncated, true);
  assert.ok(clipped.handoff.answer.length <= 8100);
  assert.ok(clipped.handoff.diffs.length <= 12100);
  assert.match(clipped.handoff.answer, /characters left out/);
});

test('legacy handoff details remain labelled as legacy without inventing original-turn changes', async t => {
  const h = fixture(t), chat = await h.start();
  await h.end(chat);
  const disk = JSON.parse(fs.readFileSync(h.file));
  disk[0].tasks[0].result = { answer: 'Retained before receipts existed', files: ['src/total.mjs'], diffs: 'Stored handoff diff' };
  fs.writeFileSync(h.file, JSON.stringify(disk));
  const saved = createWorkflows(h.options).taskResult(h.w.id, 't1');
  assert.deepEqual(saved.handoff, { answer: 'Retained before receipts existed', files: ['src/total.mjs'], diffs: 'Stored handoff diff', source: 'legacy', truncated: false });
  assert.deepEqual(saved.result.changes, []);
  assert.equal(saved.result.historyIncomplete, true);
  assert.ok(saved.result.unknowns.includes('legacy_result'));
});

test('a delayed result collection refreshes the task when its retained reply becomes available', async t => {
  const h = fixture(t), chat = await h.start();
  let release;
  chat.readBarrier = new Promise(resolve => { release = resolve; });
  const ending = h.end(chat, { text: 'Retained after collection' });
  await new Promise(setImmediate);
  const pending = h.workflows.get(h.w.id).tasks[0];
  assert.equal(pending.state, 'done');
  assert.equal(pending.resultAvailable, undefined);
  h.tick(500);
  release();
  await ending;
  const finished = h.workflows.get(h.w.id);
  assert.equal(finished.tasks[0].resultAvailable, true);
  assert.ok(finished.tasks[0].updatedAt > pending.updatedAt);
  assert.ok(finished.updatedAt > pending.updatedAt);
  assert.equal(h.workflows.taskResult(h.w.id, 't1').handoff.answer, 'Retained after collection');
});

test("a delayed failed-attempt collector cannot pause or overwrite an owner's newer task action", async (t) => {
  const h = fixture(t), chat = await h.start();
  let release;
  chat.readBarrier = new Promise((resolve) => { release = resolve; });
  const ending = h.end(chat, { outcome: "error" });
  await new Promise(setImmediate);
  assert.equal(h.workflows.get(h.w.id).tasks[0].state, "stopped");
  h.workflows.skip(h.w.id, "t1", "phone");
  release();
  await ending;
  assert.equal(h.workflows.get(h.w.id).tasks[0].state, "skipped");
  assert.equal(h.workflows.get(h.w.id).state, "done");
  assert.throws(() => h.workflows.taskResult(h.w.id, "t1", { attempt: 1 }), { status: 404 }, "no receipt is invented for a collection superseded before it completed");
});

test('a later reply cannot finish the original task even if its text repeats the workflow marker', async (t) => {
  const h = fixture(t), chat = await h.start();
  chat.items.push({ id: 'question', role: 'assistant', kind: 'text', turnId: chat.turnId, text: 'Need owner input' },
    { id: 'later-user', role: 'user', kind: 'text', turnId: 'later', text: chat.items[0].text });
  await h.end(chat, { id: 'later-answer', text: 'Later answer' });
  // The synthetic relay supplies the later reply. Original-turn collection
  // independently refuses that completion, even if the relay was fooled.
  assert.equal(h.workflows.get(h.w.id).tasks[0].state, 'uncertain');
  assert.equal(h.workflows.get(h.w.id).state, 'paused');
});

test('ordinary long-turn handoffs survive bounded evidence pagination gaps', async t => {
  const h = fixture(t), chat = await h.start();
  const answer = { id: 'answer', role: 'assistant', kind: 'text', turnId: chat.turnId, text: 'Reviewable handoff survives' };
  chat.pages = { latest: { items: [answer], before: 'loop' }, loop: { items: [], before: 'loop' } };
  await h.end(chat, { text: answer.text });
  assert.equal(h.workflows.get(h.w.id).tasks[0].summary, answer.text);
  assert.equal(h.workflows.taskResult(h.w.id, 't1').result.historyIncomplete, true);
});

for (const agent of ['codex', 'claude']) test(`${agent} workflow repair evidence freezes failures/unknown exits without adopting later owner commands`, async t => {
  const h = fixture(t, { agent }), chat = await h.start();
  chat.items.push({ id: 'seeded-check', role: 'tool', kind: 'command', turnId: chat.turnId,
    text: 'node check.mjs', detail: 'Seeded total failed', status: 'completed', exitCode: agent === 'codex' ? 1 : null, outputTruncated: false });
  await h.end(chat, { text: 'Fixed; all tests pass' });
  const original = h.workflows.taskResult(h.w.id, 't1').result;
  assert.equal(original.provenance.provider, agent);
  assert.equal(original.commands[0].exitCode, agent === 'codex' ? 1 : null);
  assert.equal(original.summarySource, 'agent_claim');
  assert.equal(original.commands[0].source, 'provider_command');
  if (agent === 'claude') assert.ok(original.unknowns.includes('exit_unavailable'));
  chat.items.push({ id: 'owner-change', role: 'user', kind: 'text', turnId: 'later', text: 'Run another check' },
    { id: 'later-success', role: 'tool', kind: 'command', turnId: 'later', text: 'node check.mjs', status: 'completed', detail: 'Later success', exitCode: 0, outputTruncated: false });
  const restored = createWorkflows(h.options).taskResult(h.w.id, 't1').result;
  assert.deepEqual(restored, original);
  assert.equal(JSON.stringify(restored).includes('Later success'), false);
});
