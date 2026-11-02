import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { outcomeWorkflow, deferred } from './helpers/outcome-workflow.mjs';

// Simulated providers/runner gates; this checks scheduler ordering, not OS
// termination or production isolation.
async function until(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail(message);
}

test('a pending independent check does not block ordinary dispatch or finished relay collection', async t => {
  const h = outcomeWorkflow(t);
  await h.run(); await h.pump(); await h.end();
  const gate = deferred(); h.settings.checkGate = gate;
  const checking = h.pump();
  try {
    await until(() => h.calls.includes('check-1'), 'check entered');
    const other = h.workflows.create({ owner: 'owner', cwd: '/work/other', tasks: [{ kind: 'build', agent: 'codex', task: 'Ordinary task' }] }).workflow;
    h.workflows.run(other.id, 'owner');
    await until(() => h.workflows.get(other.id).tasks[0].state === 'working', 'ordinary task starts while check is held');
    const task = h.workflows.get(other.id).tasks[0], chat = h.chats.get(task.chat.id);
    chat.items.push({ id: 'ordinary-reply', role: 'assistant', kind: 'text', turnId: chat.turnId, text: 'Ordinary task finished' });
    Object.assign(h.watches.get(chat.id), { state: 'done', outcome: 'reply', item: 'ordinary-reply' });
    h.sweep();
    await until(() => h.workflows.get(other.id).state === 'done', 'ordinary relay completion is collected while check is held');
    assert.equal(h.get().execution.pending.kind, 'check');
    assert.equal(h.calls.filter(c => c === 'check-1').length, 1, 'overlapping ticks cannot dispatch the check twice');
  } finally { gate.resolve(); await checking; }
});

test('cancelling during agent discovery is confirmed unsent and frees its task and folder across restart', async t => {
  const h = outcomeWorkflow(t), gate = deferred();
  h.options.availableAgents = async () => { await gate.promise; return ['codex', 'claude']; };
  h.restart(); await h.run();
  const starting = h.pump();
  try {
    await until(() => h.workflows.get(h.w.id).tasks[0].state === 'starting', 'task is in discovery');
    assert.equal(h.get().execution.pending.dispatchedAt, null);
    await h.workflows.cancelOutcome(h.w.id, h.command('cancel-unsent-build'), 'owner');
    assert.equal(h.get().phase, 'cancelled');
    assert.equal(h.get().execution.pending, null);
    assert.equal(h.workflows.get(h.w.id).tasks[0].state, 'stopped');
    assert.equal(h.calls.some(c => c.startsWith('start-') || c.startsWith('stop-task-')), false);
  } finally { gate.resolve(); await starting; }
  h.restart();
  const other = h.workflows.create({ owner: 'owner', cwd: '/work/build', tasks: [{ kind: 'build', agent: 'codex', task: 'Use released folder' }] }).workflow;
  h.workflows.run(other.id, 'owner'); await h.pump();
  assert.equal(h.workflows.get(other.id).tasks[0].state, 'working');
  assert.equal(h.get().phase, 'cancelled');
});

test('explicitly removed requested drafts are not recreated by restart or duplicate decisions', async t => {
  const h = outcomeWorkflow(t);
  await h.run(); await h.pump(); await h.end(); await h.pump(); await h.end('{"status":"clear","findings":[]}'); await h.pump();
  const body = h.changesBody();
  const decision = h.workflows.requestOutcomeChanges(h.w.id, body, 'owner');
  assert.equal(h.workflows.remove(decision.draft.id).removed, true);
  h.restart(); await h.pump();
  assert.equal(h.workflows.list().length, 1);
  const retry = h.workflows.requestOutcomeChanges(h.w.id, body, 'owner');
  assert.equal(retry.draft, null);
  assert.equal(retry.draftRemoved, true);
  assert.equal(h.workflows.outcomeOperation(h.w.id, body.requestId).draftRemoved, true);
  assert.equal(h.workflows.list().length, 1);
  const beforeDelete = fs.readFileSync(h.file);
  assert.equal(h.workflows.remove(h.w.id).removed, true);
  // Crash after the deletion marker/file cleanup, before saving the list.
  fs.writeFileSync(h.file, beforeDelete);
  h.restart(); assert.equal(h.workflows.list().length, 0);
});

test('an outcome cancelled before preparation can be explicitly removed', async t => {
  const h = outcomeWorkflow(t);
  await h.workflows.cancelOutcome(h.w.id, h.command('cancel-unprepared'), 'owner');
  assert.equal(h.get().phase, 'cancelled');
  assert.equal(h.get().execution, null);
  assert.equal(h.workflows.get(h.w.id).outcome.removable, true);
  assert.equal(h.workflows.remove(h.w.id).removed, true);
  h.restart(); assert.equal(h.workflows.list().length, 0);
});

test('a delayed task collector cannot touch a cancelled and removed workflow', async t => {
  const h = outcomeWorkflow(t), gate = deferred();
  await h.run(); await h.pump();
  h.settings.read = async (_agent, id) => {
    await gate.promise;
    return { items: structuredClone(h.chats.get(id).items), before: null, session: { status: 'idle' } };
  };
  const ending = h.end();
  try {
    await until(() => h.workflows.get(h.w.id).tasks[0].state === 'done', 'collector is awaiting provider evidence');
    await h.workflows.cancelOutcome(h.w.id, h.command('cancel-collecting-result'), 'owner');
    h.workflows.remove(h.w.id);
  } finally { gate.resolve(); }
  await ending; await h.pump();
  assert.equal(h.workflows.list().length, 0);
  assert.equal(h.calls.some(c => c.startsWith('capture-')), false);
});
