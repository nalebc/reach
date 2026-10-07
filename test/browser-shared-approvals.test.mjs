import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserApprovals } from '../server/browser-approvals.mjs';
import { createBrowserOperationCoordinator } from '../server/browser-operation-coordinator.mjs';

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-shared-approvals-')));
  const root = path.join(dir, 'project'), child = path.join(root, 'child'), other = path.join(dir, 'other');
  fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(other);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = { id: 'owner', kind: 'device', scopes: ['admin'] }, clients = new Map();
  const make = (id, folder) => {
    const client = { id, name: 'Muse', kind: 'agent', expiresAt: Date.now() + 600000,
      scopes: ['browser:read', 'browser:request'], agentRoots: [folder],
      policy: { browser: true, restrictedTerminal: true, terminalApproval: true, scriptApproval: true, screen: 'off' } };
    clients.set(id, client); return client;
  };
  let runs = 0;
  const queue = createBrowserApprovals({ verifyClient: id => clients.get(id), verifyOwner: () => owner,
    execute: async (action, check) => { check(); runs++; return { output: 'ok', exitCode: 0 }; } });
  const input = (type = 'terminal-script') => ({ type, root: 0, command: type === 'terminal-script' ? 'node report.js' : 'touch result.txt', reason: 'Create the report' });
  const approve = (client, type) => queue.decide(owner, queue.request(client, input(type)).id, 'approve-session', () => owner);
  return { root, child, other, make, queue, owner, input, approve, get runs() { return runs; } };
}

test('another writer clears overlapping script and mutation approvals without changing unrelated sessions', async t => {
  for (const type of ['terminal-script', 'terminal-change']) {
    const f = fixture(t), writer = f.make('writer', f.root), nested = f.make('nested', f.child), unrelated = f.make('unrelated', f.other);
    await f.approve(writer, type); await f.approve(nested, type); await f.approve(unrelated, type);
    const pending = f.queue.request(nested, { ...f.input(type), command: type === 'terminal-script' ? 'node second.js' : 'touch second.txt' });
    f.queue.invalidateSharedWrites(writer.id, f.root);
    assert.equal(await f.queue.runRemembered(nested, f.input(type), () => nested), null);
    assert.equal(f.queue.getOwner(pending.id).status, 'cancelled');
    await assert.rejects(f.queue.decide(f.owner, pending.id, 'approve', () => f.owner), { status: 409 });
    assert.equal((await f.queue.runRemembered(writer, f.input(type), () => writer)).status, 'executed');
    assert.equal((await f.queue.runRemembered(unrelated, f.input(type), () => unrelated)).status, 'executed');
  }
});

test('a writer finishing invalidates approvals requested while shared files were changing', async t => {
  const f = fixture(t), writer = f.make('writer', f.root), reader = f.make('reader', f.child);
  const changed = ({ clientId, root }) => f.queue.invalidateSharedWrites(clientId, root);
  const coordinator = createBrowserOperationCoordinator({ onWrite: changed, onWriteFinished: changed });
  t.after(() => coordinator.close());
  let pending;
  await coordinator.run({ clientId: writer.id, root: f.root, kind: 'file-change', authorize: () => writer }, async () => {
    pending = f.queue.request(reader, f.input());
    assert.equal(f.queue.getOwner(pending.id).status, 'pending');
  });
  assert.equal(f.queue.getOwner(pending.id).status, 'cancelled');
  assert.match(f.queue.getOwner(pending.id).error, /Another agent changed/);
  assert.equal(f.runs, 0);
});

test('a concurrent write during final command logging cannot install a stale session approval', async t => {
  const f = fixture(t), first = f.make('first', f.root), second = f.make('second', f.child);
  let finishLog, logging;
  const reachedLog = new Promise(resolve => { logging = resolve; });
  const queue = createBrowserApprovals({ verifyClient: id => id === first.id ? first : second, verifyOwner: () => f.owner,
    execute: async (action, check) => { check(); return { output: 'ok', exitCode: 0 }; },
    onChange: item => item.status === 'executed' ? new Promise(resolve => { finishLog = resolve; logging(); }) : undefined,
  });
  const decision = queue.decide(f.owner, queue.request(first, f.input()).id, 'approve-session', () => f.owner);
  await reachedLog;
  queue.invalidateSharedWrites(second.id, f.child);
  finishLog();
  assert.equal((await decision).status, 'executed', 'the completed command keeps its result');
  assert.equal(await queue.runRemembered(first, f.input(), () => first), null, 'a later write prevents approval inheritance');
});
