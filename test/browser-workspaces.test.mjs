import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBrowserWorkspaces } from '../server/browser-workspaces.mjs';
import { browserFileOperation } from '../server/browser-file-boundary.mjs';

// The manager's storage contract needs POSIX ownership and mode enforcement.
// Windows must fail closed; its filesystems cannot run these POSIX fixtures.
const test = (name, options, body) => typeof options === 'function'
  ? nodeTest(name, { skip: process.platform === 'win32' }, options)
  : nodeTest(name, { ...options, skip: process.platform === 'win32' || options?.skip }, body);

nodeTest('Windows workspace storage fails closed without POSIX owner identity', { skip: process.platform !== 'win32' }, t => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-workspaces-windows-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'private'); fs.mkdirSync(dataDir);
  assert.equal(typeof process.getuid, 'undefined');
  assert.throws(() => createBrowserWorkspaces({ config: { dataDir, roots: [], browserWorkspaceDir: path.join(temp, 'copies') } }),
    { status: 503, message: /storage must be owned by your account/ });
});

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const error = (status, message = 'Fixture rejected operation') => Object.assign(new Error(message), { status });
const owner = () => ({ id: 'owner', kind: 'device', scopes: ['admin'] });

function fixture(t, options = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-workspaces-')));
  const source = path.join(temp, 'project'), source2 = path.join(temp, 'second'), dataDir = path.join(temp, 'private'), copies = path.join(temp, 'copies');
  for (const target of [source, source2, dataDir]) fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'note.txt'), 'original'); fs.mkdirSync(path.join(source, 'nested')); fs.writeFileSync(path.join(source, 'nested', 'child.txt'), 'child');
  fs.writeFileSync(path.join(source2, 'second.txt'), 'second');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = { roots: [source, source2], dataDir, browserWorkspaceDir: copies }, calls = [], active = new Set(); let clock = 10000;
  const fileOperation = async (request, authorize) => {
    authorize(); calls.push({ ...request });
    const target = path.join(request.root, request.path || '');
    assert.ok(target === request.root || target.startsWith(request.root + '/'));
    if (request.op === 'check-reviewed') {
      const parts = request.path.split('/'); parts.pop();
      for (let index = 1; index <= parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        const stat = fs.lstatSync(path.join(request.root, parent), { throwIfNoEntry: false });
        if (!stat) return { matches: request.expectedHash === null && !request.requiredParents.some(required => required === parent || required.startsWith(parent + '/')), reason: 'An original parent folder is missing.' };
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { matches: false, reason: 'A parent folder is not a safe directory.' };
      }
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stat) return { matches: request.expectedHash === null, reason: 'The original file was removed.' };
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { matches: false, reason: 'The destination is not a regular file.' };
      const data = fs.readFileSync(target);
      return { matches: data.length <= request.maxBytes && digest(data) === request.expectedHash, reason: 'The original file changed.' };
    }
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink !== 1)) throw error(403);
    if (request.op === 'list') return { items: fs.readdirSync(target, { withFileTypes: true }).filter(item => !item.isSymbolicLink() && item.name !== '.ssh').map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' })), truncated: false };
    if (request.op === 'read') {
      if (!stat?.isFile()) throw error(403);
      const data = fs.readFileSync(target); if (data.length > request.maxBytes) throw error(413);
      return { data, stat: { type: 'file', size: data.length } };
    }
    if (request.op === 'stat') { if (!stat) throw error(403); return { stat: { type: stat.isDirectory() ? 'directory' : 'file' } }; }
    if (request.op === 'mkdir') { if (stat) throw error(409); fs.mkdirSync(target); return { ok: true }; }
    if (request.op === 'write-reviewed' || request.op === 'delete-reviewed') {
      const current = stat?.isFile() ? digest(fs.readFileSync(target)) : null;
      if (current !== request.expectedHash || (stat && !stat.isFile())) throw error(409);
      if (request.op === 'delete-reviewed') { if (stat) fs.unlinkSync(target); return { ok: true, hash: null }; }
      fs.writeFileSync(target, Buffer.from(request.data, 'base64')); return { ok: true, hash: digest(fs.readFileSync(target)) };
    }
    throw Error('Unexpected operation');
  };
  const inactive = record => !active.has(record.clientId);
  const manager = createBrowserWorkspaces({ config, fileOperation, assertInactive: inactive, now: () => clock, ...options });
  return { temp, source, source2, dataDir, copies, config, calls, active, manager, fileOperation, inactive, tick: amount => clock += amount,
    create: sources => manager.create({ sources: sources || [source], name: 'Muse' }, owner),
    client: (workspace, id = 'muse') => ({ id, browserWorkspaceId: workspace.id, agentRoots: workspace.roots, expiresAt: 60000 }) };
}

test('private copies use protected source reads and have independent roots and immutable original files', async t => {
  const f = fixture(t), first = await f.create(), second = await f.create();
  assert.notEqual(first.roots[0], second.roots[0]);
  assert.equal(fs.readFileSync(path.join(first.roots[0], 'note.txt'), 'utf8'), 'original');
  fs.writeFileSync(path.join(first.roots[0], 'note.txt'), 'private changes');
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(second.roots[0], 'note.txt'), 'utf8'), 'original');
  assert.ok(f.calls.some(call => call.op === 'read' && call.root === f.source && call.path === 'note.txt'));
  assert.ok(f.calls.every(call => ['read', 'list'].includes(call.op)));
  assert.equal(f.manager.listOwner().length, 2);
});

test('workspace binding is one-use and validates session identity, expiry and exact roots', async t => {
  const f = fixture(t), first = await f.create(), second = await f.create();
  f.manager.bind(first.id, 'muse', 60000, { ...f.client(first), name: 'Muse', policy: { browser: true } });
  const client = f.client(first);
  assert.deepEqual(f.manager.validate(client), first.roots);
  assert.throws(() => f.manager.bind(first.id, 'someone', 60000), { status: 409 });
  assert.throws(() => f.manager.bind(second.id, 'muse', 60000), { status: 409 });
  for (const altered of [{ ...client, id: 'someone' }, { ...client, expiresAt: 60001 }, { ...client, agentRoots: second.roots }, { ...client, browserWorkspaceId: second.id }]) assert.throws(() => f.manager.validate(altered), { status: 403 });
  assert.equal(f.manager.validate({ id: 'ordinary' }), null);
  f.tick(60000); assert.throws(() => f.manager.validate(client), { status: 403 });
  assert.equal(f.manager.getOwner(first.id).session.name, 'Muse');
});

test('source removal, root swaps, changed grants and corrupt private registry fail closed', async t => {
  const f = fixture(t), first = await f.create(); f.manager.bind(first.id, 'muse', 60000); const client = f.client(first);
  f.config.roots = [f.source2]; assert.throws(() => f.manager.validate(client), { status: 403 }); f.config.roots = [f.source];
  const previous = first.roots[0] + '-old'; fs.renameSync(first.roots[0], previous); fs.mkdirSync(first.roots[0]);
  assert.throws(() => f.manager.validate(client), { status: 403 }); fs.rmdirSync(first.roots[0]); fs.renameSync(previous, first.roots[0]);
  fs.writeFileSync(path.join(f.dataDir, 'browser-workspaces', 'registry.json'), '{}');
  assert.throws(() => f.manager.validate(client), { status: 503 }); assert.throws(() => f.manager.listOwner(), { status: 503 });
  assert.throws(() => createBrowserWorkspaces({ config: f.config, fileOperation: f.fileOperation }), { status: 503 });
});

test('deleted registry cannot silently reset saved workspace grants', async t => {
  const f = fixture(t); await f.create(); fs.unlinkSync(path.join(f.dataDir, 'browser-workspaces', 'registry.json'));
  assert.throws(() => createBrowserWorkspaces({ config: f.config, fileOperation: f.fileOperation }), { status: 503 });
});

test('existing workspace storage must stay private to its owner without changing source folder permissions', async t => {
  const f = fixture(t), workspace = await f.create();
  const state = path.join(f.dataDir, 'browser-workspaces');
  for (const folder of [f.copies, state]) {
    fs.chmodSync(folder, 0o755);
    assert.throws(() => f.manager.listOwner(), { status: 503 });
    assert.throws(() => createBrowserWorkspaces({ config: f.config, fileOperation: f.fileOperation }), { status: 503 });
    assert.equal(fs.statSync(folder).mode & 0o777, 0o755, 'Reach must not silently chmod an existing folder');
    fs.chmodSync(folder, 0o700);
  }
  for (const file of [path.join(state, 'registry.json'), path.join(state, `${workspace.id}.baseline.json`)]) {
    fs.chmodSync(file, 0o644);
    if (file.endsWith('registry.json')) assert.throws(() => f.manager.listOwner(), { status: 503 });
    else await assert.rejects(f.manager.review(workspace.id, owner), { status: 503 });
    fs.chmodSync(file, 0o600);
  }
  fs.chmodSync(f.source, 0o755); fs.chmodSync(f.dataDir, 0o755);
  assert.equal((await f.manager.review(workspace.id, owner)).summary.conflicts, 0);
});

test('unapproved, overlapping, symlink and private source folders are never copied', async t => {
  const f = fixture(t), outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(f.source, path.join(f.temp, 'alias'));
  for (const sources of [[outside], [f.source, f.source], [f.source, path.join(f.source, 'nested')], [path.join(f.temp, 'alias')], [f.dataDir], ['../outside']]) await assert.rejects(f.create(sources));
  await assert.rejects(f.manager.create({ sources: [f.source] }, () => ({ id: 'muse', kind: 'agent', scopes: ['admin'] })), { status: 403 });
  assert.deepEqual(f.manager.listOwner(), []);
});

test('copies reject traversal from helper output, oversized files, excessive files and truncated listings', async t => {
  const f = fixture(t);
  for (const fileOperation of [async () => ({ items: [{ name: '../escape', type: 'file' }], truncated: false }), async () => ({ items: [], truncated: true })]) {
    const manager = createBrowserWorkspaces({ config: f.config, fileOperation });
    await assert.rejects(manager.create({ sources: [f.source] }, owner));
  }
  const tiny = createBrowserWorkspaces({ config: f.config, fileOperation: f.fileOperation, limits: { files: 1 } });
  await assert.rejects(tiny.create({ sources: [f.source] }, owner), { status: 413 });
  const small = createBrowserWorkspaces({ config: f.config, fileOperation: f.fileOperation, limits: { fileBytes: 2 } });
  await assert.rejects(small.create({ sources: [f.source] }, owner), { status: 413 });
  assert.deepEqual(f.manager.listOwner(), []); assert.deepEqual(fs.readdirSync(f.copies), []);
});

test('review and discard require a stopped, quiescent agent and cannot be called by the agent', async t => {
  const f = fixture(t), workspace = await f.create(); f.manager.bind(workspace.id, 'muse', 60000); f.active.add('muse');
  await assert.rejects(f.manager.review(workspace.id, owner), { status: 409 });
  await assert.rejects(f.manager.discard(workspace.id, owner), { status: 409 });
  f.active.clear();
  await assert.rejects(f.manager.review(workspace.id, () => ({ id: 'muse', kind: 'agent', scopes: ['admin'] })), { status: 403 });
  const reviewed = await f.manager.review(workspace.id, owner); assert.equal(reviewed.changes.length, 0);
  assert.throws(() => f.manager.validate(f.client(workspace)), { status: 403 });
});

test('review manifests include exact added, changed and deleted bytes without revealing private baseline storage', async t => {
  const f = fixture(t), workspace = await f.create();
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'changed');
  fs.unlinkSync(path.join(workspace.roots[0], 'nested', 'child.txt'));
  fs.writeFileSync(path.join(workspace.roots[0], 'added.txt'), 'new');
  const review = await f.manager.review(workspace.id, owner);
  assert.deepEqual(review.changes.map(item => [item.path, item.type]), [['added.txt', 'added'], ['nested/child.txt', 'deleted'], ['note.txt', 'changed']]);
  const changed = review.changes.find(item => item.path === 'note.txt');
  assert.equal(changed.beforeText, 'original'); assert.equal(changed.afterText, 'changed'); assert.equal(changed.beforeHash, digest('original'));
  assert.ok(review.changes.every(item => !('data' in item)));
  assert.equal(JSON.stringify(review).includes(f.dataDir), false);
});

test('applying uses immutable review bytes and guarded writes, even if the stopped copy changes later', async t => {
  const f = fixture(t), workspace = await f.create();
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'approved bytes');
  fs.mkdirSync(path.join(workspace.roots[0], 'new')); fs.writeFileSync(path.join(workspace.roots[0], 'new', 'added.txt'), 'addition');
  fs.unlinkSync(path.join(workspace.roots[0], 'nested', 'child.txt'));
  const review = await f.manager.review(workspace.id, owner);
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'unreviewed bytes');
  const result = await f.manager.apply(workspace.id, review.id, owner);
  assert.equal(result.partial, false); assert.equal(result.applied.length, 3);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'approved bytes');
  assert.equal(fs.readFileSync(path.join(f.source, 'new', 'added.txt'), 'utf8'), 'addition'); assert.equal(fs.existsSync(path.join(f.source, 'nested', 'child.txt')), false);
  assert.ok(f.calls.some(call => call.op === 'write-reviewed' && call.expectedHash === digest('original')));
  assert.ok(f.calls.some(call => call.op === 'delete-reviewed' && call.expectedHash === digest('child')));
  await assert.rejects(f.manager.apply(workspace.id, review.id, owner), { status: 409 });
  assert.ok(fs.existsSync(path.join(f.dataDir, 'browser-workspaces', `${workspace.id}.baseline.json`)));
});

test('unrelated original file changes across granted folders are preserved when applying', async t => {
  const f = fixture(t), workspace = await f.create([f.source, f.source2]);
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent change');
  const review = await f.manager.review(workspace.id, owner);
  fs.writeFileSync(path.join(f.source2, 'second.txt'), 'owner change');
  const result = await f.manager.apply(workspace.id, review.id, owner);
  assert.equal(result.partial, false);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'agent change');
  assert.equal(fs.readFileSync(path.join(f.source2, 'second.txt'), 'utf8'), 'owner change');
});

test('two private agents can apply disjoint changes reviewed before either one applied', async t => {
  const f = fixture(t), first = await f.create(), second = await f.create();
  fs.writeFileSync(path.join(first.roots[0], 'note.txt'), 'first agent');
  fs.writeFileSync(path.join(second.roots[0], 'nested', 'child.txt'), 'second agent');
  const firstReview = await f.manager.review(first.id, owner), secondReview = await f.manager.review(second.id, owner);
  assert.equal(firstReview.summary.conflicts, 0); assert.equal(secondReview.summary.conflicts, 0);
  assert.ok([...firstReview.changes, ...secondReview.changes].every(change => !('conflict' in change)));
  assert.equal((await f.manager.apply(first.id, firstReview.id, owner)).partial, false);
  assert.equal((await f.manager.apply(second.id, secondReview.id, owner)).partial, false);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'first agent');
  assert.equal(fs.readFileSync(path.join(f.source, 'nested', 'child.txt'), 'utf8'), 'second agent');
});

test('review identifies genuine destination conflicts and never rebases the immutable before or after bytes', async t => {
  const f = fixture(t), workspace = await f.create();
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent edit');
  fs.writeFileSync(path.join(f.source, 'note.txt'), 'owner edit');
  const reviewed = await f.manager.review(workspace.id, owner);
  assert.equal(reviewed.summary.conflicts, 1); assert.match(reviewed.changes[0].conflict, /original file changed/);
  assert.equal(reviewed.changes[0].beforeText, 'original'); assert.equal(reviewed.changes[0].afterText, 'agent edit');
  await assert.rejects(f.manager.apply(workspace.id, reviewed.id, owner), { status: 409 });
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'owner edit');
  fs.writeFileSync(path.join(f.source, 'note.txt'), 'original');
  await assert.rejects(f.manager.apply(workspace.id, reviewed.id, owner), { status: 409 });
  const cleanReview = await f.manager.review(workspace.id, owner);
  assert.equal(cleanReview.summary.conflicts, 0);
  assert.equal((await f.manager.apply(workspace.id, cleanReview.id, owner)).partial, false);
});

test('cached reviews without valid conflict metadata require fresh review before any write', async t => {
  const f = fixture(t), workspace = await f.create(); fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent edit');
  for (const invalidate of [value => { delete value.summary.conflicts; }, value => { value.summary.conflicts = 1; },
    value => { value.changes[0].conflict = null; }, value => { value.changes[0].conflict = ''; }]) {
    const reviewed = await f.manager.review(workspace.id, owner);
    const file = path.join(f.dataDir, 'browser-workspaces', `${reviewed.id}.review.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')); invalidate(stored); fs.writeFileSync(file, JSON.stringify(stored));
    await assert.rejects(f.manager.apply(workspace.id, reviewed.id, owner), { status: 409 });
  }
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'original');
  assert.equal(f.calls.some(call => ['write-reviewed', 'delete-reviewed'].includes(call.op)), false);
});

test('a touched file changed after review blocks all writes before a clean earlier file is applied', async t => {
  const f = fixture(t), workspace = await f.create();
  fs.writeFileSync(path.join(workspace.roots[0], 'a.txt'), 'new earlier file');
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent edit');
  const reviewed = await f.manager.review(workspace.id, owner);
  fs.writeFileSync(path.join(f.source, 'note.txt'), 'owner changed after review');
  await assert.rejects(f.manager.apply(workspace.id, reviewed.id, owner), { status: 409 });
  assert.equal(fs.existsSync(path.join(f.source, 'a.txt')), false);
  assert.equal(f.calls.filter(call => ['write-reviewed', 'delete-reviewed', 'mkdir'].includes(call.op)).length, 0);
  assert.equal(f.manager.getOwner(workspace.id).status, 'reviewed');
});

test('missing or unsafe original parent directories conflict even for a newly added file', async t => {
  const f = fixture(t), workspace = await f.create();
  fs.writeFileSync(path.join(workspace.roots[0], 'nested', 'added.txt'), 'new file');
  fs.renameSync(path.join(f.source, 'nested'), path.join(f.source, 'moved'));
  const missing = await f.manager.review(workspace.id, owner);
  assert.equal(missing.summary.conflicts, 1); assert.match(missing.changes[0].conflict, /parent folder is missing/);
  await assert.rejects(f.manager.apply(workspace.id, missing.id, owner), { status: 409 });
  fs.symlinkSync(f.source2, path.join(f.source, 'nested'));
  const unsafe = await f.manager.review(workspace.id, owner);
  assert.equal(unsafe.summary.conflicts, 1); assert.match(unsafe.changes[0].conflict, /safe directory/);
  await assert.rejects(f.manager.apply(workspace.id, unsafe.id, owner), { status: 409 });
  assert.equal(fs.existsSync(path.join(f.source2, 'added.txt')), false);
});

test('an original parent removed after preflight is never recreated during a partial apply', async t => {
  const f = fixture(t);
  const manager = createBrowserWorkspaces({ config: f.config, assertInactive: f.inactive, fileOperation: async (request, authorize, options) => {
    const result = await f.fileOperation(request, authorize, options);
    if (request.op === 'write-reviewed' && request.path === 'a.txt') fs.rmSync(path.join(f.source, 'nested'), { recursive: true });
    return result;
  } });
  const workspace = await manager.create({ sources: [f.source] }, owner);
  fs.writeFileSync(path.join(workspace.roots[0], 'a.txt'), 'first');
  fs.writeFileSync(path.join(workspace.roots[0], 'nested', 'added.txt'), 'second');
  const reviewed = await manager.review(workspace.id, owner), result = await manager.apply(workspace.id, reviewed.id, owner);
  assert.equal(result.partial, true); assert.deepEqual(result.applied.map(change => change.path), ['a.txt']);
  assert.equal(result.failed.path, 'nested/added.txt'); assert.equal(fs.existsSync(path.join(f.source, 'nested')), false);
  assert.equal(f.calls.some(call => call.op === 'mkdir' && call.path === 'nested'), false);
});

test('new unrelated owner files do not conflict but replaced original roots are denied', async t => {
  const f = fixture(t), workspace = await f.create(); fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent change');
  const review = await f.manager.review(workspace.id, owner); fs.writeFileSync(path.join(f.source, 'new-owner-file'), 'mine');
  assert.equal((await f.manager.apply(workspace.id, review.id, owner)).partial, false);
  assert.equal(fs.readFileSync(path.join(f.source, 'new-owner-file'), 'utf8'), 'mine');
  const another = await f.create(); fs.writeFileSync(path.join(another.roots[0], 'note.txt'), 'another change');
  const anotherReview = await f.manager.review(another.id, owner);
  fs.renameSync(f.source, f.source + '-old'); fs.mkdirSync(f.source);
  await assert.rejects(f.manager.apply(another.id, anotherReview.id, owner), { status: 403 });
});

test('unrelated directory changes are preserved and replacing original directories is refused', async t => {
  const f = fixture(t), workspace = await f.create(); fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent change');
  const reviewed = await f.manager.review(workspace.id, owner); fs.mkdirSync(path.join(f.source, 'owner-folder'));
  assert.equal((await f.manager.apply(workspace.id, reviewed.id, owner)).partial, false);
  assert.ok(fs.statSync(path.join(f.source, 'owner-folder')).isDirectory());
  const another = await f.create(); fs.rmSync(path.join(another.roots[0], 'nested'), { recursive: true }); fs.writeFileSync(path.join(another.roots[0], 'nested'), 'replacement');
  await assert.rejects(f.manager.review(another.id, owner), { status: 409 });
});

test('expired or superseded reviews cannot apply and only one review file is retained', async t => {
  const f = fixture(t), workspace = await f.create(); fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent change');
  const first = await f.manager.review(workspace.id, owner), second = await f.manager.review(workspace.id, owner);
  await assert.rejects(f.manager.apply(workspace.id, first.id, owner), { status: 409 });
  assert.equal(fs.existsSync(path.join(f.dataDir, 'browser-workspaces', `${first.id}.review.json`)), false);
  f.tick(11 * 60 * 1000); await assert.rejects(f.manager.apply(workspace.id, second.id, owner), { status: 409 });
});

test('failures after the first write preserve backups and report partial completion without replay', async t => {
  const f = fixture(t); let writes = 0;
  const manager = createBrowserWorkspaces({ config: f.config, assertInactive: f.inactive, fileOperation: async (request, authorize, options) => {
    if (request.op === 'write-reviewed' && ++writes === 2) throw error(409, 'Owner changed this file');
    return f.fileOperation(request, authorize, options);
  } });
  const workspace = await manager.create({ sources: [f.source] }, owner);
  fs.writeFileSync(path.join(workspace.roots[0], 'a.txt'), 'first'); fs.writeFileSync(path.join(workspace.roots[0], 'z.txt'), 'last');
  const review = await manager.review(workspace.id, owner), result = await manager.apply(workspace.id, review.id, owner);
  assert.equal(result.partial, true); assert.deepEqual(result.applied.map(item => item.path), ['a.txt']); assert.equal(result.failed.path, 'z.txt');
  assert.equal(manager.getOwner(workspace.id).status, 'partial');
  assert.equal(fs.readFileSync(path.join(f.source, 'a.txt'), 'utf8'), 'first'); assert.equal(fs.existsSync(path.join(f.source, 'z.txt')), false);
  await assert.rejects(manager.apply(workspace.id, review.id, owner), { status: 409 });
  assert.ok(fs.existsSync(path.join(f.dataDir, 'browser-workspaces', `${workspace.id}.baseline.json`)));
});

test('source apply runs inside the coordinator lock with authorization checked after waiting', async t => {
  const f = fixture(t); let locked = false, lockCalls = 0;
  const manager = createBrowserWorkspaces({ config: f.config, assertInactive: f.inactive, fileOperation: (request, authorize, options) => {
    if (['write-reviewed', 'delete-reviewed'].includes(request.op)) assert.equal(locked, true);
    return f.fileOperation(request, authorize, options);
  }, runExclusiveApply: async (record, operation, authorize) => { lockCalls++; assert.deepEqual(record.sources, [f.source]); authorize(); locked = true; try { return await operation(); } finally { locked = false; } } });
  const workspace = await manager.create({ sources: [f.source] }, owner); fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'agent change');
  const review = await manager.review(workspace.id, owner); await manager.apply(workspace.id, review.id, owner); assert.equal(lockCalls, 1);
});

test('cancelling an apply lease during a native operation stops later files and persists the partial result', async t => {
  const f = fixture(t); let leaseActive = false;
  const attemptedWrites = [];
  const manager = createBrowserWorkspaces({
    config: f.config,
    assertInactive: f.inactive,
    fileOperation: async (request, authorize, options) => {
      if (request.op === 'write-reviewed') {
        attemptedWrites.push(request.path);
        if (request.path === 'note.txt') {
          // Model cancellation after the helper starts, before its next live
          // authorization check. Checking only between files would miss this.
          authorize(); await Promise.resolve(); leaseActive = false;
        }
      }
      return f.fileOperation(request, authorize, options);
    },
    runExclusiveApply: async (_record, operation, authorizeOwner) => {
      authorizeOwner(); leaseActive = true;
      try {
        return await operation(() => {
          if (!leaseActive) throw error(403, 'The apply lease was cancelled');
        });
      } finally { leaseActive = false; }
    },
  });
  const workspace = await manager.create({ sources: [f.source] }, owner);
  fs.writeFileSync(path.join(workspace.roots[0], 'a.txt'), 'completed before cancellation');
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'must not reach the original');
  fs.writeFileSync(path.join(workspace.roots[0], 'z.txt'), 'must never start');
  const reviewed = await manager.review(workspace.id, owner);
  const result = await manager.apply(workspace.id, reviewed.id, owner);
  assert.equal(result.partial, true);
  assert.deepEqual(result.applied, [{ root: 0, path: 'a.txt', type: 'added' }]);
  assert.equal(result.failed.path, 'note.txt'); assert.match(result.failed.message, /lease was cancelled/);
  assert.deepEqual(attemptedWrites, ['a.txt', 'note.txt']);
  assert.equal(fs.readFileSync(path.join(f.source, 'a.txt'), 'utf8'), 'completed before cancellation');
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(f.source, 'z.txt')), false);
  const saved = manager.getOwner(workspace.id);
  assert.equal(saved.status, 'partial'); assert.deepEqual(saved.lastApply, result);
  assert.ok(fs.existsSync(path.join(f.dataDir, 'browser-workspaces', `${workspace.id}.baseline.json`)));
  await assert.rejects(manager.apply(workspace.id, reviewed.id, owner), { status: 409 });
  assert.deepEqual(attemptedWrites, ['a.txt', 'note.txt']);
});

test('discard removes only the stopped copy and explicit private backups, never original or symlink targets', async t => {
  const f = fixture(t), workspace = await f.create(); const outside = path.join(f.temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'kept');
  fs.symlinkSync(outside, path.join(workspace.roots[0], 'escape'));
  const reviewed = await f.manager.review(workspace.id, owner);
  await f.manager.discard(workspace.id, owner);
  assert.equal(fs.existsSync(workspace.roots[0]), false); assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'original'); assert.deepEqual(f.manager.listOwner(), []);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'browser-workspaces', `${workspace.id}.baseline.json`)), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'browser-workspaces', `${reviewed.id}.review.json`)), false);
});

test('saved workspace count and per-workspace operations remain bounded', async t => {
  const f = fixture(t), manager = createBrowserWorkspaces({ config: f.config, fileOperation: f.fileOperation, assertInactive: f.inactive, limits: { workspaces: 1 } });
  const workspace = await manager.create({ sources: [f.source] }, owner);
  await assert.rejects(manager.create({ sources: [f.source] }, owner), { status: 409 });
  let release; const wait = new Promise(resolve => { release = resolve; });
  const slow = createBrowserWorkspaces({ config: f.config, fileOperation: async (request, authorize) => { await wait; return f.fileOperation(request, authorize); }, assertInactive: f.inactive });
  const reviewing = slow.review(workspace.id, owner); await assert.rejects(slow.discard(workspace.id, owner), { status: 409 }); release(); await reviewing;
});

test('real descriptor helpers copy and apply inside the original boundaries', { skip: process.platform !== 'darwin' || process.env.REACH_TEST_FILE_BOUNDARY !== '1' }, async t => {
  const f = fixture(t); const manager = createBrowserWorkspaces({ config: f.config, fileOperation: browserFileOperation, assertInactive: f.inactive });
  fs.mkdirSync(path.join(f.source, '.ssh')); fs.writeFileSync(path.join(f.source, '.ssh', 'secret'), 'never copy');
  fs.symlinkSync(f.source2, path.join(f.source, 'escape'));
  const workspace = await manager.create({ sources: [f.source] }, owner);
  assert.equal(fs.existsSync(path.join(workspace.roots[0], '.ssh')), false); assert.equal(fs.existsSync(path.join(workspace.roots[0], 'escape')), false);
  fs.writeFileSync(path.join(workspace.roots[0], 'note.txt'), 'native reviewed bytes');
  const reviewed = await manager.review(workspace.id, owner); const result = await manager.apply(workspace.id, reviewed.id, owner);
  assert.equal(result.partial, false); assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'native reviewed bytes');
});
