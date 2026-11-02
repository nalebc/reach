import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticAppRepair, outcomeTuple } from './helpers/synthetic-app-repair.mjs';
import { outcomeHttp } from './helpers/outcome-http.mjs';

test('HTTP app repair: approved preparation, duplicate Run, one repair, frozen result, stale owner and duplicate acceptance', async t => {
  const h = syntheticAppRepair(t, { repair: true }), api = await outcomeHttp(t, h);
  const prepared = await api.prepare(); assert.equal(prepared.status, 200);
  assert.equal(prepared.body.outcome.plan.branches.length, 4);
  assert.match(prepared.body.outcome.preparation.prepared.isolation, /TEST ONLY/);
  const run = api.runBody();
  const runs = await Promise.all([api.call('/outcome/run', run), api.call('/outcome/run', run)]);
  assert.deepEqual(runs.map(r => r.status), [200, 200]);
  await h.pump(); await h.finishBuild({ fixed: false }); await h.finishBuild(); await h.finishReview();
  const current = await api.call('/outcome'); assert.equal(current.body.outcome.phase, 'ready');
  assert.equal(current.headers.get('cache-control'), 'no-store');
  const task = h.workflows.get(h.w.id).tasks[2];
  const result = await api.call(`/tasks/${task.id}/result?attempt=1`);
  assert.equal(result.status, 200); assert.equal(result.body.result.provenance.workflowId, h.w.id);
  assert.equal(result.body.result.summarySource, 'agent_claim');
  const stale = h.acceptBody();
  const observed = await api.call('/outcome/observations', h.command('http-owner-observation', { ...outcomeTuple(h.get()), criterionId: 'appearance', passed: true, note: 'Synthetic total visible.' }));
  assert.equal(observed.status, 200);
  assert.equal((await api.call('/outcome/accept', stale)).status, 409);
  const accept = h.acceptBody('http-accept-current');
  const accepted = await Promise.all([api.call('/outcome/accept', accept), api.call('/outcome/accept', accept)]);
  assert.deepEqual(accepted.map(r => r.status), [200, 200]);
  assert.deepEqual(accepted[0].body.operation, accepted[1].body.operation);
  assert.deepEqual(accepted[0].body.operation.tuple, outcomeTuple(observed.body.outcome));
  assert.equal((await api.call(`/outcome/operations/${accept.requestId}`)).body.status, 'known');
  assert.equal((await api.call('/outcome/accept', { ...accept, acknowledgedLimitationIds: ['different'] })).status, 409);
  assert.deepEqual(h.executed.map(v => v.receipt.exitCode), [1, 1, 0]);
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 3);
});

test('HTTP expired owner cannot read evidence or recover/replay cached decisions', async t => {
  const h = syntheticAppRepair(t); await h.ready(); const api = await outcomeHttp(t, h);
  const accept = h.acceptBody('http-accept-before-expiry');
  assert.equal((await api.call('/outcome/accept', accept)).status, 200);
  // Advance only the auth clock after all subprocess/check work has settled.
  const expired = api.owner.expiresAt + 1;
  t.mock.method(Date, 'now', () => expired);
  for (const [suffix, body] of [['/outcome', undefined], [`/outcome/operations/${accept.requestId}`, undefined], ['/outcome/accept', accept], ['/outcome/cancel', h.command('expired-owner-cancel')]]) {
    const response = await api.call(suffix, body);
    assert.equal(response.status, 401, suffix);
    assert.equal(JSON.stringify(response.body).includes(h.get().resultDigest), false);
  }
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 2);
});
