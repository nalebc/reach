import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syntheticAppRepair, gate, outcomeTuple } from './helpers/synthetic-app-repair.mjs';

// Real fixture files/check subprocesses; simulated provider turns, runner
// isolation and clock/access changes. No live agent or device certification.
for (const builder of ['codex', 'claude']) test(`synthetic app: approved plan -> ${builder} build -> independent check -> separate review -> exact owner acceptance`, async t => {
  const h = syntheticAppRepair(t, { builder });
  assert.equal(h.get().phase, 'draft');
  assert.throws(() => h.workflows.runOutcome(h.w.id, h.command('run-without-preparation'), 'owner'), { status: 409 });
  await h.ready();
  const o = h.get();
  assert.deepEqual(h.executed.map(v => [v.kind, v.receipt.exitCode]), [['baseline', 1], ['check', 0]]);
  assert.equal(o.plan.builder.agent, builder);
  assert.equal(o.review.source, 'reviewer_judgment');
  assert.notDeepEqual(o.review.chat, h.workflows.get(h.w.id).tasks[0].chat);
  assert.equal(o.checks[0].candidateDigest, o.resultDigest);
  assert.equal(o.acceptance.status, 'not_accepted', 'completion/check/review do not accept for the owner');
  assert.equal(h.workflows.get(h.w.id).state, 'done');
  const receipt = h.workflows.taskResult(h.w.id, h.workflows.get(h.w.id).tasks[0].id).result;
  assert.equal(receipt.summarySource, 'agent_claim');
  assert.equal(receipt.changes[0].files, 'src/total.mjs');
  assert.ok(receipt.unknowns.includes('concurrent_edits_unknown'), 'provider attribution is distinct from runner verification');
  const body = h.acceptBody(), accepted = await h.workflows.acceptOutcome(h.w.id, body, 'owner');
  assert.deepEqual(accepted.operation.tuple, outcomeTuple(o));
  h.restart();
  assert.deepEqual((await h.workflows.acceptOutcome(h.w.id, body, 'owner')).operation, accepted.operation);
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 2);
});

for (const repair of [false, true]) test(`synthetic failing builder claim; optional repair ${repair ? 'selected once' : 'disabled'}`, async t => {
  const h = syntheticAppRepair(t, { repair });
  await h.run(); await h.pump(); await h.finishBuild({ fixed: false });
  assert.equal(h.executed.at(-1).receipt.exitCode, 1, 'real independent failure beats the builder success claim');
  if (!repair) {
    assert.equal(h.get().phase, 'needs_owner');
    assert.equal(h.get().execution.counts.builds, 1);
  } else {
    const previous = h.get().resultDigest;
    const oldAcceptance = h.acceptBody('accept-before-repaired-result');
    assert.equal(h.get().execution.repairsUsed, 1);
    await h.finishBuild(); await h.finishReview();
    assert.equal(h.get().resultRevision, 2);
    assert.notEqual(h.get().resultDigest, previous);
    assert.deepEqual(h.executed.map(v => v.receipt.exitCode), [1, 1, 0]);
    assert.equal(h.get().execution.counts.builds, 2);
    assert.equal(h.get().acceptance.eligible, true);
    await assert.rejects(h.workflows.acceptOutcome(h.w.id, oldAcceptance, 'owner'), { status: 409 });
    await h.workflows.acceptOutcome(h.w.id, h.acceptBody(), 'owner');
  }
});

test('a second real failure cannot reserve a third build, even after restart or duplicate Run', async t => {
  const h = syntheticAppRepair(t, { repair: true });
  const body = await h.run(); await h.pump(); await h.finishBuild({ fixed: false }); await h.finishBuild({ fixed: false });
  assert.equal(h.get().phase, 'needs_owner'); assert.equal(h.get().execution.repairsUsed, 1);
  h.restart(); h.workflows.runOutcome(h.w.id, body, 'owner'); await h.pump();
  assert.equal(h.get().execution.counts.builds, 2);
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 2);
  await assert.rejects(h.workflows.acceptOutcome(h.w.id, h.acceptBody(), 'owner'), { status: 409 });
});

for (const fault of ['missing', 'truncated', 'stale']) test(`${fault} check evidence holds instead of accepting or selecting repair`, async t => {
  const h = syntheticAppRepair(t, { repair: true }); h.faults.check = fault;
  await h.run(); await h.pump(); await h.finishBuild({ fixed: false });
  assert.equal(h.executed.at(-1).receipt.exitCode, 1);
  assert.equal(h.get().phase, 'needs_owner'); assert.equal(h.get().acceptance.eligible, false);
  assert.equal(h.get().execution.repairsUsed, 0); assert.equal(h.get().execution.counts.builds, 1);
  await assert.rejects(h.workflows.acceptOutcome(h.w.id, h.acceptBody(), 'owner'), { status: 409 });
});

for (const builder of ['codex', 'claude']) test(`${builder}: missing original build history cannot be upgraded by a successful independent check`, async t => {
  const h = syntheticAppRepair(t, { repair: true, builder }); await h.run(); await h.pump();
  const chat = [...h.chats.values()][0];
  chat.items = [];
  await h.finishBuild();
  assert.equal(h.get().acceptance.eligible, false); assert.equal(h.get().execution.repairsUsed, 0);
  assert.equal(h.executed.length, 1, 'only the baseline ran');
});

for (const builder of ['codex', 'claude']) for (const clipping of ['stored', 'provider']) test(`${builder}: ${clipping} transcript clipping remains visible while complete independent evidence can pass`, async t => {
  const h = syntheticAppRepair(t, { builder }); await h.run(); await h.pump();
  const chat = [...h.chats.values()][0];
  chat.items.push({ id: 'bounded-command', role: 'tool', kind: 'command', text: 'synthetic command', detail: clipping === 'stored' ? 'x'.repeat(3001) : 'partial',
    turnId: chat.turnId, status: 'completed', exitCode: builder === 'codex' ? 0 : null, outputTruncated: clipping === 'provider' });
  for (let i = 0; i < 9; i++) chat.items.push({ id: `progress-${i}`, role: 'assistant', kind: 'text', turnId: chat.turnId, text: `Synthetic progress ${i}` });
  await h.finishBuild();
  const review = [...h.chats.values()].at(-1);
  for (let i = 0; i < 9; i++) review.items.push({ id: `review-progress-${i}`, role: 'assistant', kind: 'text', turnId: review.turnId, text: `Inspection progress ${i}` });
  await h.finishReview();
  const receipt = h.workflows.taskResult(h.w.id, h.workflows.get(h.w.id).tasks[0].id).result;
  assert.equal(receipt.truncated, true); assert.equal(receipt.historyIncomplete, false);
  assert.ok(receipt.unknowns.includes('stored_content_clipped'));
  if (builder === 'claude') assert.ok(receipt.unknowns.includes('exit_unavailable'), 'unknown provider exits remain unknown, not independent success');
  assert.equal(h.get().truncated, true); assert.equal(h.get().acceptance.eligible, true);
  assert.deepEqual(h.executed.map(v => v.receipt.exitCode), [1, 0]);
  await h.workflows.acceptOutcome(h.w.id, h.acceptBody(), 'owner');
});

for (const fault of ['source', 'log']) test(`missing/changed ${fault} invalidates acceptance of a previously ready candidate`, async t => {
  const h = syntheticAppRepair(t); await h.ready(); const body = h.acceptBody();
  if (fault === 'source') fs.writeFileSync(path.join(h.candidates.get(h.get().resultDigest).directory, 'src/total.mjs'), 'export const total = () => 0;');
  else h.logs.clear();
  await assert.rejects(h.workflows.acceptOutcome(h.w.id, body, 'owner'), { status: 409 });
  assert.equal(h.get().acceptance.status, 'not_accepted'); assert.equal(h.get().acceptance.eligible, false);
});

test('concurrent source editing reported at capture blocks check, review and repair', async t => {
  const h = syntheticAppRepair(t, { repair: true }); h.faults.capture = 'concurrent';
  await h.run(); await h.pump(); await h.finishBuild();
  assert.equal(h.get().acceptance.eligible, false); assert.equal(h.get().execution.repairsUsed, 0);
  assert.equal(h.executed.length, 1); assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 1);
});

test('rewriting the project check to no-op violates scope and cannot replace the pinned independent harness', async t => {
  const h = syntheticAppRepair(t, { repair: true }); await h.run(); await h.pump();
  fs.writeFileSync(path.join(h.build, 'check.mjs'), 'process.exit(0);');
  await h.finishBuild({ fixed: false, text: 'All tests pass now.' });
  assert.equal(h.get().acceptance.eligible, false); assert.equal(h.get().execution.repairsUsed, 0);
  assert.equal(h.executed.length, 1, 'tampered candidate never reaches independent check');
});

for (const phase of ['build', 'review', 'repair']) test(`cancellation during ${phase} stops only its owned chat and starts no replacement`, async t => {
  const h = syntheticAppRepair(t, { repair: true }); await h.run(); await h.pump();
  if (phase === 'review') await h.finishBuild();
  if (phase === 'repair') await h.finishBuild({ fixed: false });
  const owned = h.get().execution.pending.chat.id, starts = h.calls.filter(c => c.startsWith('start-')).length;
  await h.workflows.cancelOutcome(h.w.id, h.command(`cancel-${phase}-chat`), 'owner');
  await h.pump();
  assert.equal(h.get().phase, 'cancelled'); assert.equal(h.get().acceptance.eligible, false);
  assert.ok(h.calls.includes(`stop-task-${owned}`));
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, starts);
});

test('duplicate Run and cancelled held check cannot replay a command or select repair on late failure', async t => {
  const h = syntheticAppRepair(t, { repair: true }); const body = await h.run(); await h.pump();
  h.workflows.runOutcome(h.w.id, body, 'owner');
  h.faults.checkGate = gate();
  await h.end('All done'); const pumping = h.pump(); await new Promise(setImmediate);
  assert.equal(h.get().execution.pending.kind, 'check');
  const cancel = h.command('cancel-synthetic-check');
  await h.workflows.cancelOutcome(h.w.id, cancel, 'owner');
  h.faults.checkGate.resolve(); await pumping;
  await h.workflows.cancelOutcome(h.w.id, cancel, 'owner');
  assert.equal(h.get().phase, 'cancelled'); assert.equal(h.get().execution.repairsUsed, 0);
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 1);
  assert.equal(h.executed.filter(c => c.kind === 'baseline').length, 1);
});

test('restart with a reserved builder holds its original operation and current owner access is rechecked', async t => {
  const h = syntheticAppRepair(t, { repair: true }); const body = await h.run(); await h.pump();
  h.restart(); h.workflows.runOutcome(h.w.id, body, 'owner'); await h.pump();
  assert.equal(h.get().phase, 'needs_owner'); assert.equal(h.get().execution.counts.builds, 1);
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 1);
  h.revoke();
  await assert.rejects(h.workflows.acceptOutcome(h.w.id, h.acceptBody(), 'owner'), { status: 403 });
});

test('concurrent owner evidence versus acceptance has one version winner and preserves the observation', async t => {
  const h = syntheticAppRepair(t); await h.ready(); const body = h.acceptBody();
  h.faults.verifyGate = gate();
  const accepting = h.workflows.acceptOutcome(h.w.id, body, 'owner');
  await new Promise(setImmediate);
  h.workflows.observeOutcome(h.w.id, h.command('observe-current-total', { ...outcomeTuple(h.get()), criterionId: 'appearance', passed: true, note: 'Synthetic total is visible.' }), 'owner');
  h.faults.verifyGate.resolve(); await assert.rejects(accepting, { status: 409 });
  assert.equal(h.get().acceptance.status, 'not_accepted'); assert.equal(h.get().execution.observations.length, 1);
  await h.workflows.acceptOutcome(h.w.id, h.acceptBody('accept-fresh-evidence'), 'owner');
});
