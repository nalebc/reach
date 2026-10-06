import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserApprovals } from '../server/browser-approvals.mjs';

const batch = (actions = [{ type: 'terminal', root: 0, command: 'pwd' }, { type: 'terminal', root: 0, command: 'ls' }]) => ({ type: 'batch', actions, reason: 'Fill the title and confirm' });
function fixture(hook) {
  let now = 1000;
  const client = { id: 'bot', name: 'Muse', kind: 'agent', expiresAt: 900000,
    agentRoots: ['/shared'], scopes: ['browser:read', 'browser:request'],
    policy: { browser: true, screen: 'off', restrictedTerminal: true } };
  const owner = { id: 'owner', kind: 'device', scopes: ['admin'] };
  const calls = [], notifications = [];
  const f = { client, owner, calls, notifications, advance: (ms) => { now += ms; } };
  f.queue = createBrowserApprovals({
    verifyClient: (id) => id === client.id ? client : null,
    now: () => now,
    notify: (n) => notifications.push(n),
    execute: async (action, authorize, request, progress) => {
      assert.equal(action.type, 'batch');
      assert.ok(Object.isFrozen(action.actions));
      for (const [i, step] of action.actions.entries()) {
        authorize(); await progress(i, 'executing');
        assert.ok(Object.isFrozen(step));
        if (hook) await hook(f, i, request);
        authorize(); calls.push(structuredClone(step));
        await progress(i, 'executed', step.type === 'terminal' ? 'output' : undefined);
      }
    },
  });
  f.submit = (input = batch()) => f.queue.request(client, input);
  f.decide = (r, decision = 'approve') => f.queue.decide(owner, r.id, decision, () => owner);
  return f;
}

test('batch binds a deeply immutable ordered sequence and never creates later permission', async () => {
  const f = fixture(); const input = batch(); const r = f.submit(input);
  input.actions[0].command = 'changed';
  r.action.actions[0].command = 'response changed';
  r.steps[0].action.command = 'step changed';
  f.queue.listOwner()[0].action.actions.push({ type: 'terminal', root: 0, command: 'ls' });
  const result = await f.decide(r);
  assert.equal(result.status, 'executed');
  assert.equal(result.completedCount, 2); assert.equal(result.attemptedCount, 2);
  assert.deepEqual(f.calls, batch().actions);
  await assert.rejects(f.decide(r), { status: 409 });
  assert.equal(f.submit().status, 'pending');
  assert.equal(f.calls.length, 2); assert.equal(f.notifications.length, 2);
});

test('invalid batches fail before notifications and no step may broaden permissions', () => {
  const f = fixture();
  for (const input of [
    batch([]), batch(Array.from({ length: 6 }, () => ({ type: 'key', key: 'enter' }))),
    batch([batch()]), batch([{ type: 'command', command: 'sudo whoami' }]),
    batch([{ type: 'text', text: 'hi', reason: 'hidden reason' }]),
    batch([{ type: 'key', key: 'enter', approve: true }]),
    batch([{ type: 'key', key: 'enter' }, { type: 'terminal', root: 0, command: 'pwd' }]),
    batch(Array.from({ length: 5 }, () => ({ type: 'text', text: '😀'.repeat(1000) }))),
    { ...batch(), allowControl: true }, { ...batch(), reason: 'hidden\u202ereason' },
  ]) assert.throws(() => f.submit(input), { status: 400 });
  for (const screen of ['off', 'view', 'scroll', 'ask', 'apps']) {
    f.client.policy.screen = screen;
    assert.throws(() => f.submit(batch([{ type: 'key', key: 'enter' }])), { status: 403 });
  }
  assert.deepEqual(f.queue.listOwner(), []); assert.equal(f.notifications.length, 0);
});

test('denial and legacy blanket grants cannot execute any child', async () => {
  const f = fixture(); const r = f.submit();
  await assert.rejects(f.decide(r, 'allow-control'), { status: 400 });
  await assert.rejects(f.queue.decide(f.client, r.id, 'approve', () => f.client), { status: 403 });
  const denied = await f.decide(r, 'deny');
  assert.deepEqual(denied.steps.map((s) => s.status), ['skipped', 'skipped']);
  assert.equal(denied.completedCount, 0); assert.equal(f.calls.length, 0);
});

test('concurrent decisions claim the batch once; executing progress is visible and owner can stop', async () => {
  let release, arrived; const started = new Promise((r) => { arrived = r; });
  const f = fixture(async (_, i) => { if (i === 0) { arrived(); await new Promise((r) => { release = r; }); } });
  const r = f.submit(); const first = f.decide(r); await started;
  await assert.rejects(f.decide(r), { status: 409 });
  assert.equal(f.queue.listOwner()[0].status, 'executing');
  assert.equal(f.queue.listOwner()[0].attemptedCount, 1);
  const stopped = await f.decide(r, 'deny'); assert.equal(stopped.status, 'cancelled');
  release(); const result = await first;
  assert.equal(result.status, 'cancelled'); assert.equal(result.completedCount, 0);
  assert.deepEqual(result.steps.map((s) => s.status), ['failed', 'skipped']);
  assert.equal(f.calls.length, 0);
});

test('failure after an earlier step preserves partial progress and never retries', async () => {
  const f = fixture((_, i) => { if (i === 1) throw Error('native error with secret'); });
  const r = f.submit(batch([...batch().actions, { type: 'terminal', root: 0, command: 'pwd' }]));
  const result = await f.decide(r);
  assert.equal(result.status, 'failed'); assert.equal(result.completedCount, 1);
  assert.equal(result.attemptedCount, 2);
  assert.deepEqual(result.steps.map((s) => s.status), ['executed', 'failed', 'skipped']);
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(f.decide(r), { status: 409 }); assert.equal(f.calls.length, 1);
});

test('scope changes, roots changes, expiry and owner cancellation stop subsequent steps', async () => {
  for (const change of [
    (f) => { f.client.policy.screen = 'view'; },
    (f) => { f.client.agentRoots = ['/other']; },
    (f) => { f.client.expiresAt = 1; },
    (f) => f.advance(30001),
    (f) => f.queue.cancelPending(),
    (f) => { f.owner.scopes = []; },
  ]) {
    const f = fixture((f, i) => { if (i === 1) change(f); });
    const result = await f.decide(f.submit());
    assert.notEqual(result.status, 'executed'); assert.equal(result.completedCount, 1);
    assert.equal(f.calls.length, 1);
  }
});

test('restricted command batches preserve exact folder/cwd and per-step output without enabling shell', async () => {
  const f = fixture(); Object.assign(f.client.policy, { screen: 'off', restrictedTerminal: true });
  const r = f.submit(batch([{ type: 'terminal', root: 0, cwd: '', command: 'cd child' }, { type: 'terminal', root: 0, cwd: 'child', command: 'ls' }]));
  assert.equal(r.expiresAt, 301000); assert.equal(r.steps[0].folder, '/shared');
  assert.equal(r.steps[1].folder, '/shared/child');
  const result = await f.decide(r);
  assert.equal(result.status, 'executed'); assert.equal(result.steps[0].directory, 'child');
  assert.equal(result.steps[1].output, 'output');
  for (const command of ['sudo ls', 'rm file', 'ls; whoami'])
    assert.throws(() => f.submit(batch([{ type: 'terminal', root: 0, command }])), { status: 400 });
});

test('failed durable logging prevents both automatic and approved execution', async()=>{
  const client={id:'reader',name:'Reader',kind:'agent',expiresAt:Date.now()+60000,agentRoots:['/shared'],scopes:['browser:read','browser:request'],policy:{browser:true,restrictedTerminal:true,screen:'off'}};
  const owner={id:'owner',kind:'device',scopes:['admin']};let executions=0;
  const queue=createBrowserApprovals({verifyClient:()=>client,execute:()=>{executions++;},onChange:async()=>{throw Error('disk unavailable');}});
  await assert.rejects(queue.runReadOnly(client,{type:'terminal',root:0,command:'pwd',reason:'Read'},()=>client),{status:503});
  const pending=queue.request(client,{type:'terminal',root:0,command:'ls',reason:'Read'});
  await assert.rejects(queue.decide(owner,pending.id,'approve',()=>owner),{status:503});
  assert.equal(executions,0);
});
