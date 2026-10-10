import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserOperationCoordinator, pathsOverlap } from '../server/browser-operation-coordinator.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-coordinator-')));
  for (const folder of ['project', 'project/nested', 'project-other', 'third']) fs.mkdirSync(path.join(temp, folder));
  const coordinator = createBrowserOperationCoordinator({ pollMs: 5, ...options });
  const gates = [];
  t.after(() => { coordinator.close(); for (const gate of gates) gate.resolve(); fs.rmSync(temp, { recursive: true, force: true }); });
  const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); const value = { resolve, promise }; gates.push(value); return value; };
  const agent = (id, folder = 'project') => {
    const root = path.join(temp, folder), client = { id, kind: 'agent', policy: { browser: true }, agentRoots: [root] };
    let allowed = true;
    const authorize = () => { if (!allowed) throw Error('revoked'); return client; };
    return { client, root, revoke: () => { allowed = false; }, run: (execute, kind = 'file-change') => coordinator.run({ clientId: id, root, kind, authorize }, execute) };
  };
  return { temp, coordinator, agent, gate };
}

test('overlapping parent and child folders take turns while separate folders proceed', async t => {
  const f = await fixture(t), first = f.agent('first'), nested = f.agent('nested', 'project/nested'), other = f.agent('other', 'project-other');
  const hold = f.gate(), order = [];
  const one = first.run(async () => { order.push('first'); await hold.promise; });
  const two = nested.run(() => order.push('nested'));
  const three = other.run(() => order.push('other'));
  await three;
  assert.deepEqual(order, ['first', 'other']);
  assert.equal(f.coordinator.listOwner().find(op => op.clientId === 'nested').state, 'waiting');
  assert.equal(pathsOverlap(first.root, nested.root), true);
  assert.equal(pathsOverlap(first.root, other.root), false);
  hold.resolve(); await Promise.all([one, two]);
  assert.deepEqual(order, ['first', 'other', 'nested']);
});

test('FIFO applies across overlapping grants without allowing newer child writers to bypass a waiting parent', async t => {
  const f = await fixture(t), gate = f.gate(), order = [];
  const first = f.agent('one', 'project/nested').run(() => gate.promise);
  const second = f.agent('two').run(() => order.push('parent'));
  const third = f.agent('three', 'project/nested').run(() => order.push('child'));
  await tick(); assert.deepEqual(order, []);
  gate.resolve(); await Promise.all([first, second, third]);
  assert.deepEqual(order, ['parent', 'child']);
});

test('folder identity detects case aliases on case-insensitive volumes', async t => {
  const f = await fixture(t), lower = path.join(f.temp, 'project'), alias = path.join(f.temp, 'PROJECT');
  if (!fs.existsSync(alias)) return t.skip('This volume has case-sensitive paths');
  assert.equal(pathsOverlap(lower, alias), true);
  const hold = f.gate(); let started = false;
  const first = f.agent('first').run(() => hold.promise);
  const second = f.agent('alias', 'PROJECT').run(() => { started = true; });
  await tick(); assert.equal(started, false);
  hold.resolve(); await Promise.all([first, second]);
  assert.equal(started, true);
});

test('queued revocation rejects promptly and never enters the operation', async t => {
  const f = await fixture(t), hold = f.gate(), pending = f.agent('pending'); let entered = false;
  const first = f.agent('first').run(() => hold.promise);
  const second = pending.run(() => { entered = true; });
  const rejected = assert.rejects(second, /revoked/);
  pending.revoke(); await rejected;
  assert.equal(entered, false);
  assert.equal(f.coordinator.listOwner().some(op => op.clientId === 'pending'), false);
  hold.resolve(); await first;
});

test('authorization is checked again between lease acquisition and execute', async t => {
  const f = await fixture(t), agent = f.agent('one'); let entered = false;
  const operation = agent.run(() => { entered = true; });
  agent.revoke(); await assert.rejects(operation, /revoked/);
  assert.equal(entered, false);
});

test('cancel holds a running lease until stopped work settles; future operations from the same session remain possible', async t => {
  const f = await fixture(t), hold = f.gate(), agent = f.agent('one'); let guard, signal, nextStarted = false;
  const first = agent.run(async context => { guard = context.authorize; signal = context.signal; await hold.promise; });
  await tick(); f.coordinator.cancelClient('one');
  assert.equal(signal.aborted, true); assert.throws(guard, /stopped/);
  assert.equal(f.coordinator.listOwner()[0].stopping, true);
  const next = f.agent('two').run(() => { nextStarted = true; });
  await tick(); assert.equal(nextStarted, false);
  hold.resolve(); await first; await next; // work that finished anyway is reported as completed, not failed
  await agent.run(() => 'new operation');
  assert.equal(nextStarted, true);
});

test('waiting deadlines expire without releasing another writer or executing late', async t => {
  const f = await fixture(t, { waitTimeoutMs: 20 }), hold = f.gate(); let entered = false;
  const first = f.agent('one').run(() => hold.promise);
  await assert.rejects(f.agent('two').run(() => { entered = true; }), { status: 504 });
  assert.equal(entered, false);
  assert.equal(f.coordinator.listOwner()[0].state, 'running');
  hold.resolve(); await first;
});

test('failure releases its lease and a waiting operation can proceed', async t => {
  const f = await fixture(t), hold = f.gate(); let entered = false;
  const first = f.agent('one').run(async () => { await hold.promise; throw Error('operation failed'); });
  const rejected = assert.rejects(first, /operation failed/);
  const next = f.agent('two').run(() => { entered = true; });
  hold.resolve(); await rejected; await next; assert.equal(entered, true);
});

test('global and per-session queue limits reject excess waiting work but leave separate folders usable', async t => {
  const f = await fixture(t, { maxWaiting: 2, maxWaitingPerClient: 1 }), hold = f.gate(), two = f.agent('two');
  const first = f.agent('one').run(() => hold.promise), second = two.run(() => {});
  await assert.rejects(two.run(() => {}), { status: 429 });
  const third = f.agent('three').run(() => {});
  await assert.rejects(f.agent('four').run(() => {}), { status: 429 });
  await f.agent('separate', 'third').run(() => {});
  hold.resolve(); await Promise.all([first, second, third]);
});

test('script capacity is reserved only after its folder becomes available', async t => {
  const f = await fixture(t), holds = [f.gate(), f.gate(), f.gate()];
  const writer = f.agent('writer').run(() => holds[0].promise);
  const waiting = f.agent('waiting').run(() => {}, 'script');
  const second = f.agent('second', 'project-other').run(() => holds[1].promise, 'script');
  const third = f.agent('third', 'third').run(() => holds[2].promise, 'script');
  await tick();
  assert.equal(f.coordinator.listOwner().filter(op => op.kind === 'script' && op.state === 'running').length, 2);
  assert.equal(f.coordinator.listOwner().find(op => op.clientId === 'waiting').state, 'waiting');
  for (const hold of holds) hold.resolve(); await Promise.all([writer, waiting, second, third]);
});

test('at most one script from a session runs even across unrelated grants', async t => {
  const f = await fixture(t), hold = f.gate(), a = f.agent('same'), b = f.agent('same', 'third'); let entered = false;
  const first = a.run(() => hold.promise, 'script'), next = b.run(() => { entered = true; }, 'script');
  await tick(); assert.equal(entered, false);
  hold.resolve(); await Promise.all([first, next]); assert.equal(entered, true);
});

test('global script capacity queues a third script across unrelated folders', async t => {
  const f = await fixture(t), a = f.gate(), b = f.gate(); let entered = false;
  const first = f.agent('one').run(() => a.promise, 'script');
  const second = f.agent('two', 'project-other').run(() => b.promise, 'script');
  const third = f.agent('three', 'third').run(() => { entered = true; }, 'script');
  await tick(); assert.equal(entered, false);
  assert.equal(f.coordinator.listOwner().filter(op => op.kind === 'script' && op.state === 'running').length, 2);
  a.resolve(); await first; await third; b.resolve(); await second;
});

test('a changed queued folder or grant cannot execute against its replacement', async t => {
  const f = await fixture(t), hold = f.gate(), pending = f.agent('pending'); let entered = false;
  const first = f.agent('one').run(() => hold.promise);
  const second = pending.run(() => { entered = true; }), rejected = assert.rejects(second, /no longer has access/);
  pending.client.agentRoots = []; await rejected; assert.equal(entered, false);
  hold.resolve(); await first;
  const changed = f.agent('changed');
  const operation = changed.run(() => { entered = true; });
  fs.renameSync(changed.root, changed.root + '-old'); fs.mkdirSync(changed.root);
  await assert.rejects(operation, /folder changed/); assert.equal(entered, false);
});

test('write hooks invalidate assumptions before execution and before lease release on failure', async t => {
  const events = [];
  const f = await fixture(t, { onWrite: info => events.push(`start:${info.clientId}`), onWriteFinished: info => events.push(`finish:${info.clientId}`) });
  const hold = f.gate();
  const first = f.agent('one').run(async () => { events.push('execute:one'); await hold.promise; throw Error('failed'); });
  const rejected = assert.rejects(first, /failed/);
  const second = f.agent('two').run(() => { events.push('execute:two'); });
  await tick(); hold.resolve(); await rejected; await second;
  assert.deepEqual(events, ['start:one', 'execute:one', 'finish:one', 'start:two', 'execute:two', 'finish:two']);
});

test('write hooks fail closed and a failed finish hook still releases an already stopped operation', async t => {
  let entered = false, failStart = true, failFinish = false;
  const f = await fixture(t, { onWrite: () => { if (failStart) throw Error('start hook'); }, onWriteFinished: () => { if (failFinish) throw Error('finish hook'); } });
  const agent = f.agent('one');
  await assert.rejects(agent.run(() => { entered = true; }), /start hook/); assert.equal(entered, false);
  failStart = false; failFinish = true;
  await assert.rejects(agent.run(() => {}), /finish hook/);
  failFinish = false; await agent.run(() => 'released');
});

test('an asynchronous finish hook retains the lease until approval invalidation completes', async t => {
  let finish, markFinishing;
  const held = new Promise(resolve => { finish = resolve; }), finishing = new Promise(resolve => { markFinishing = resolve; });
  const f = await fixture(t, { onWriteFinished: async ({ clientId }) => { if (clientId === 'one') { markFinishing(); await held; } } });
  t.after(finish); let entered = false;
  const first = f.agent('one').run(() => {});
  await finishing;
  const second = f.agent('two').run(() => { entered = true; });
  await tick(); assert.equal(entered, false);
  finish(); await Promise.all([first, second]);
  assert.equal(entered, true); assert.deepEqual(f.coordinator.listOwner(), []);
});

test('closing rejects queued and future work and waits for active work to stop', async t => {
  const f = await fixture(t), hold = f.gate();
  const first = f.agent('one').run(() => hold.promise), firstDone = first;
  const second = f.agent('two').run(() => {}), secondRejected = assert.rejects(second, /stopped/);
  await tick(); f.coordinator.close(); await secondRejected;
  assert.equal(f.coordinator.listOwner().length, 1);
  await assert.rejects(f.agent('new', 'third').run(() => {}), { status: 503 });
  hold.resolve(); await firstDone; // completed work is not reported as failed
});
