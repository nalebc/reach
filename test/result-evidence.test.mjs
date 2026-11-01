import test from "node:test";
import assert from "node:assert/strict";
import { RESULT_BYTES, evidenceHash, recordedTurnResult, readOriginalTurn, requestHash, restoreResult, stampResult } from "../server/agent-sessions/result-evidence.mjs";
import { turnMaterial } from "../server/agent-sessions/chat-context.mjs";
import { codexItem } from "../server/agent-sessions/codex.mjs";
import { createClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";

const user = (id, text, turnId = "first") => ({ id, role: "user", kind: "text", text, turnId });
const reply = (id, text, turnId = "first") => ({ id, role: "assistant", kind: "text", text, turnId });
const command = (extra = {}) => ({ id: "cmd", role: "tool", kind: "command", text: "npm test", detail: "passed", status: "completed", turnId: "first", ...extra });
const binding = { provider: "codex", workflowId: "workflow", taskId: "build", attempt: 2, chatId: "chat", turnId: "first", contractRevision: 3 };

test('final-message clipping is distinct from bounded command and progress display', () => {
  const complete = recordedTurnResult([command({ detail: 'x'.repeat(3001), exitCode: 0 }), reply('answer', '{"status":"clear","findings":[]}')], { binding });
  assert.equal(complete.truncated, true);
  assert.equal(complete.unknowns.includes('summary_clipped'), false);
  for (const message of [reply('answer', 'x'.repeat(10000)), { ...reply('answer', 'Partial review'), truncated: true }]) {
    const clipped = recordedTurnResult([message], { binding });
    assert.equal(clipped.truncated, true);
    assert.ok(clipped.unknowns.includes('summary_clipped'));
    const frozen = stampResult(clipped, { at: 1000 });
    assert.deepEqual(restoreResult(frozen), frozen, 'the explicit gap survives persistence');
  }
});

test("assistant success is separate from provider status, unknown exits and reviewer judgments", () => {
  const r = recordedTurnResult([command(), reply("answer", "All tests pass; criterion calculation is satisfied.")], { binding });
  assert.equal(r.summarySource, "agent_claim");
  assert.equal(r.commands[0].source, "provider_command");
  assert.equal(r.commands[0].status, "completed");
  assert.equal(r.commands[0].exitCode, null);
  assert.equal(r.commands[0].outputCompleteness, "unknown");
  assert.deepEqual(r.judgments, []);
  assert.deepEqual(r.criterionIds, []);
  assert.equal(r.provenance.resultRevision, null);
  assert.equal(r.provenance.artifactRevision, null);
  assert.equal(r.provenance.attempt, 2);
  assert.ok(r.unknowns.includes("exit_unavailable"));
  const known = recordedTurnResult([command({ exitCode: 7, outputTruncated: false })], { binding });
  assert.equal(known.commands[0].exitCode, 7);
  assert.equal(known.commands[0].outputCompleteness, "complete");
  assert.equal(known.unknowns.includes("exit_unavailable"), false);
  assert.deepEqual(recordedTurnResult([reply("a", "I ran npm test")], { binding }).commands, []);
});

test("original turn paging excludes later owner work, even a quoted opening marker", async () => {
  const opening = "Synthetic task opening";
  const pages = {
    newest: { items: [user("owner", opening, "later"), command({ id: "later-command", turnId: "later" }), reply("private", "Later owner material", "later")], before: "older" },
    older: { items: [user("request", opening), command(), reply("done", "Original result")], before: null },
  };
  for (const agent of ["codex", "claude"]) {
    const current = await readOriginalTurn({ agent, chatId: "chat", turnId: agent === 'codex' ? 'first' : null, requestDigest: requestHash(opening), replyId: "done", read: async (_agent, _chat, options) => pages[options.before || "newest"] });
    assert.equal(current.found, true);
    assert.equal(current.later, true);
    assert.equal(current.incomplete, false);
    assert.deepEqual(current.items.map((i) => i.id), ["request", "cmd", "done"]);
  }
  const missing = await readOriginalTurn({ agent: "claude", chatId: "chat", requestDigest: requestHash(opening), maxPages: 1, read: async () => pages.newest });
  assert.equal(missing.found, false);
  assert.equal(missing.incomplete, true);
  assert.deepEqual(missing.items, []);
  assert.ok(missing.gaps.includes("pagination_limit"));
});

test("missing boundaries, changed history and failed collectors stay explicit", async () => {
  for (const read of [async () => { throw Error("synthetic read failure"); }, async () => ({ items: [reply("last", "Unbound")], before: null }),
    async () => ({ items: [user("quote", "Opening"), reply("last", "Quoted")], before: "same" })]) {
    const r = await readOriginalTurn({ agent: "claude", chatId: "chat", requestDigest: requestHash("Opening"), read });
    assert.equal(r.incomplete, true);
    assert.deepEqual(r.items, []);
  }
  const missingReply = await readOriginalTurn({ agent: "codex", chatId: "chat", requestDigest: requestHash("Opening"), replyId: "gone", read: async () => ({ items: [user("u", "Opening"), command(), reply("a", "Known partial")], before: null }) });
  assert.equal(missingReply.incomplete, true);
  assert.equal(missingReply.items[1].id, "cmd", "known original receipts survive a missing final item");
  const noTurnId = await readOriginalTurn({ agent: "codex", chatId: "chat", requestDigest: requestHash("Opening"), read: async () => ({ items: [user("u", "Opening"), command({ turnId: undefined })], before: null }) });
  assert.equal(noTurnId.incomplete, true);
  assert.equal(noTurnId.items.length, 1, "an unbound command is not assigned to a known Codex turn");
});

test("encoded evidence is bounded and clipping, concurrent changes and unsupported providers are unknowns", () => {
  const large = "\u0001😀\"".repeat(12000), items = [];
  for (let n = 0; n < 40; n++) items.push(command({ id: `cmd-${n}`, text: large, detail: large }),
    { id: `edit-${n}`, role: "tool", kind: "file-change", status: "completed", text: large, detail: large }, reply(`a-${n}`, large));
  const result = stampResult(recordedTurnResult(items, { binding: { ...binding, provider: "openclaw" }, historyIncomplete: true }), { at: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= RESULT_BYTES);
  assert.equal(result.truncated, true);
  assert.equal(result.historyIncomplete, true);
  for (const kind of ["stored_content_clipped", "concurrent_edits_unknown", "unsupported_provider", "artifact_binding_unavailable"]) assert.ok(result.unknowns.includes(kind), kind);
  assert.equal(result.changes[0].artifactRevision, null);
  assert.deepEqual(restoreResult(result), result);
});

test("sealed evidence verifies digests, rejects future/corrupt records and reads legacy results conservatively", () => {
  const original = stampResult(recordedTurnResult([command(), reply("done", "Claim")], { binding }), { at: 100 });
  assert.deepEqual(restoreResult(original), original);
  const tampered = { ...original, summary: "Different claim" };
  assert.throws(() => restoreResult(tampered), /digest/);
  assert.throws(() => restoreResult({ ...original, schemaVersion: 2 }), /Unsupported/);
  const injected = { ...original, injected: "not a field" };
  const { evidenceDigest, ...body } = injected;
  injected.evidenceDigest = evidenceHash(body);
  assert.throws(() => restoreResult(injected), /fields/);
  assert.throws(() => restoreResult({ ...original, collectedAt: 101 }), /digest/);
  assert.throws(() => restoreResult({ ...original, evidenceFrozen: false }), /digest/);
  const legacy = restoreResult({ summary: "Earlier claim", commands: [{ command: "npm test", status: "completed", output: "old output" }], changes: [], progress: [], truncated: true, historyIncomplete: false }, { binding });
  assert.equal(legacy.commands[0].exitCode, null);
  assert.equal(legacy.truncated, true);
  assert.ok(legacy.unknowns.includes("legacy_result"));
});

test("chat material can retain provider evidence without promoting a handoff to verification", () => {
  const m = turnMaterial([user("u", "Fix it"), command(), reply("a", "Done")], { evidence: true, binding });
  assert.equal(m.answer, "Done");
  assert.equal(m.evidence.commands[0].itemId, "cmd");
  assert.equal(m.evidence.summarySource, "agent_claim");
  assert.deepEqual(m.evidence.judgments, []);
});

test("Codex normalization retains real exits and explicit output/diff clipping", () => {
  const item = codexItem({ item: { id: "c", type: "commandExecution", command: "npm test", status: "completed", aggregatedOutput: "long output", exitCode: 9 } }, { maxOutput: 5 });
  assert.equal(item.exitCode, 9);
  assert.equal(item.outputTruncated, true);
  assert.equal(codexItem({ item: { id: "x", type: "commandExecution", status: "completed" } }).exitCode, null);
});

test("Claude normalization never derives an exit from tool success and records clipping", () => {
  const transcript = createClaudeTranscript({ maxOutput: 100 });
  transcript.add([
    { uuid: "u", type: "user", message: { content: "Fix it" } },
    { uuid: "a", parentUuid: "u", type: "assistant", message: { content: [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "npm test" } }] } },
    { uuid: "tool", parentUuid: "a", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash", content: "x".repeat(500), is_error: false }] } },
  ].map(JSON.stringify).join("\n") + "\n");
  const tool = transcript.view().items.find((i) => i.kind === "command");
  assert.equal(tool.status, "completed");
  assert.equal(tool.exitCode, null);
  assert.equal(tool.outputTruncated, true);
});

test('oldest-page metadata and a Codex dispatch pin are required for complete provenance', async () => {
  const opening = 'Original task';
  for (const agent of ['codex', 'claude']) {
    const unproven = await readOriginalTurn({ agent, chatId: 'chat', turnId: 'first', requestDigest: requestHash(opening),
      read: async () => ({ items: [user('u', opening), reply('r', 'A quoted window')] }) });
    assert.equal(unproven.found, false); assert.equal(unproven.incomplete, true);
  }
  const unpinned = await readOriginalTurn({ agent: 'codex', chatId: 'chat', requestDigest: requestHash(opening),
    read: async () => ({ before: null, items: [user('u', opening), reply('r', 'Claim')] }) });
  assert.ok(unpinned.gaps.includes('provider_turn_id_unavailable'));
});

test('Claude queued owner input stays inside the original turn and early commands survive padding', async () => {
  const opening = 'Original task';
  const result = await readOriginalTurn({ agent: 'claude', chatId: 'chat', requestDigest: requestHash(opening), replyId: 'r', read: async () => ({ before: null,
    items: [user('u', opening), command(), { ...user('q', 'Queued input'), queued: true }, reply('r', 'Finished')] }) });
  assert.equal(result.incomplete, false); assert.equal(result.replyMatched, true); assert.equal(result.items.length, 4);
  const receipt = recordedTurnResult(Array.from({ length: 40 }, (_, i) => command({ id: `c${i}`, text: i === 0 ? 'early action' : 'padding', detail: 'x'.repeat(3000) })), { binding });
  assert.equal(receipt.commands[0].command, 'early action'); assert.equal(receipt.truncated, true);
});

test('a pagination cutoff retains only records with the known dispatch turn pin and explicit gaps', async () => {
  const r = await readOriginalTurn({ agent: 'codex', chatId: 'chat', turnId: 'first', requestDigest: requestHash('Original'), maxPages: 1,
    read: async () => ({ before: 'older', items: [command(), command({ id: 'unrelated', turnId: 'later' })] }) });
  assert.equal(r.found, false); assert.equal(r.incomplete, true); assert.ok(r.gaps.includes('pagination_limit'));
  assert.deepEqual(r.items.map(i => i.id), ['cmd']);
});
