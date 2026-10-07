import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { browserFileOperation, fileBoundaryProfile } from '../server/browser-file-boundary.mjs';

const native = process.platform === 'darwin' && process.env.REACH_TEST_FILE_BOUNDARY === '1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(value).toString('base64');
const owner = () => ({ id: 'owner', kind: 'device', scopes: ['admin'] });
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-file-review-')));
  const root = path.join(temp, 'shared'), outside = path.join(temp, 'outside'), cache = path.join(temp, 'cache');
  for (const directory of [root, outside, cache]) fs.mkdirSync(directory);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const request = (op, relative, extra) => ({ op, root, path: relative, ...extra });
  const run = (op, relative, extra) => browserFileOperation(request(op, relative, extra), owner, { config: { dataDir: cache } });
  return { temp, root, outside, cache, request, run };
}

test('reviewed file operations require exact hashes and canonical bounded binary data', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); let received;
  const run = async request => { received = request; return { ok: true, hash: hash('hello') }; };
  const invoke = extra => browserFileOperation(f.request('write-reviewed', 'file', { expectedHash: null, data: encode('hello'), ...extra }), owner, { config: { dataDir: f.cache }, run });
  await invoke({});
  assert.equal(received.expectedHash, null); assert.equal(received.data, encode('hello'));
  assert.match(received.sandbox, /allow file-write/);
  for (const extra of [
    { expectedHash: undefined }, { expectedHash: '' }, { expectedHash: 'A'.repeat(64) }, { expectedHash: 7 },
    { path: '' }, { path: '../escape' }, { to: 'elsewhere' }, { maxBytes: 1048577 },
    { data: 'AA' }, { data: 'AB==' }, { data: 'AA==\n' }, { data: '' , maxBytes: 0 },
    { data: encode('too large'), maxBytes: 2 }, { data: Buffer.alloc(1048577).toString('base64') },
  ]) await assert.rejects(invoke(extra), { status: 400 });
  await assert.rejects(browserFileOperation(f.request('delete-reviewed', 'file', { expectedHash: null, data: '' }), owner, { config: { dataDir: f.cache }, run }), { status: 400 });
  for (const requiredParents of [null, 'folder', ['../'], ['other'], ['folder', 'folder'], ['folder//nested'], Array.from({ length: 33 }, (_, index) => 'folder/'.repeat(index + 1).slice(0, -1))])
    await assert.rejects(invoke({ path: 'folder/file', requiredParents }), { status: 400 });
  await invoke({ data: Buffer.alloc(1048576, 0xff).toString('base64') });
  assert.equal(Buffer.from(received.data, 'base64').length, 1048576);
  await invoke({ data: '' }); assert.equal(received.data, '');
  for (const client of [true, undefined, { id: 'agent', kind: 'browser', scopes: ['admin'] }, { id: 'device', kind: 'device', scopes: [] }]) {
    await assert.rejects(browserFileOperation(f.request('write-reviewed', 'file', { expectedHash: null, data: '' }), () => client, { config: { dataDir: f.cache }, run }), { status: 403 });
  }
  let permitted = true;
  await assert.rejects(browserFileOperation(f.request('write-reviewed', 'file', { expectedHash: null, data: '' }), () => ({ ...owner(), scopes: permitted ? ['admin'] : [] }), { config: { dataDir: f.cache }, run: async () => { permitted = false; return { ok: true }; } }), { status: 403 });
});

test('reviewed checks are owner-only, read-only and return only a validated match result', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), request = f.request('check-reviewed', 'parent/file', { expectedHash: null, requiredParents: ['parent'] });
  let observed;
  const run = async value => { observed = value; return { matches: false, reason: 'Changed', data: 'must not return file contents' }; };
  assert.deepEqual(await browserFileOperation(request, owner, { config: { dataDir: f.cache }, run }), { matches: false, reason: 'Changed' });
  assert.deepEqual(observed.requiredParents, ['parent']); assert.doesNotMatch(observed.sandbox, /allow file-write/);
  for (const client of [true, { id: 'agent', kind: 'agent', scopes: ['admin'] }, { id: 'owner', kind: 'device', scopes: [] }])
    await assert.rejects(browserFileOperation(request, () => client, { config: { dataDir: f.cache }, run }), { status: 403 });
  await assert.rejects(browserFileOperation({ ...request, data: '' }, owner, { config: { dataDir: f.cache }, run }), { status: 400 });
  for (const result of [{}, { matches: 'true' }, { matches: false, reason: 7 }, { matches: false, reason: 'x'.repeat(301) }])
    await assert.rejects(browserFileOperation(request, owner, { config: { dataDir: f.cache }, run: async () => result }), { status: 503 });
  let permitted = true;
  await assert.rejects(browserFileOperation(request, () => ({ ...owner(), scopes: permitted ? ['admin'] : [] }), {
    config: { dataDir: f.cache }, run: async () => { permitted = false; return { matches: true }; },
  }), { status: 403 });
});

test('native reviewed checks distinguish changed or blocked destinations from absent new parents', { skip: !native }, async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'original')); fs.writeFileSync(path.join(f.root, 'original', 'file'), 'baseline');
  const check = (file, expectedHash, requiredParents = [], extra = {}) => f.run('check-reviewed', file, { expectedHash, requiredParents, ...extra });
  assert.deepEqual(await check('original/file', hash('baseline'), ['original']), { matches: true });
  assert.equal((await check('original/file', hash('changed'), ['original'])).matches, false);
  assert.equal((await check('original/file', null)).matches, false);
  assert.deepEqual(await check('absent', null), { matches: true });
  assert.equal((await check('absent', hash('baseline'))).matches, false);
  assert.deepEqual(await check('original/new/deep/file', null, ['original']), { matches: true });
  assert.equal(fs.existsSync(path.join(f.root, 'original', 'new')), false, 'the check must not create folders');
  assert.equal((await check('original/new/deep/file', null, ['original', 'original/new'])).matches, false);
  fs.renameSync(path.join(f.root, 'original'), path.join(f.root, 'moved'));
  assert.equal((await check('original/new/file', null, ['original'])).matches, false, 'missing baseline parents are conflicts');
  assert.equal(fs.existsSync(path.join(f.root, 'original')), false);
  fs.symlinkSync(path.join(f.root, 'moved'), path.join(f.root, 'original'));
  assert.equal((await check('original/file', hash('baseline'), ['original'])).matches, false);
  fs.writeFileSync(path.join(f.outside, 'secret'), 'outside-private');
  fs.linkSync(path.join(f.outside, 'secret'), path.join(f.root, 'hardlink'));
  fs.symlinkSync(f.outside, path.join(f.root, 'escape'));
  fs.mkdirSync(path.join(f.root, 'protected')); fs.writeFileSync(path.join(f.root, 'protected', 'secret'), 'protected');
  fs.writeFileSync(path.join(f.root, 'file-parent'), 'not a directory');
  fs.writeFileSync(path.join(f.root, 'large'), Buffer.alloc(1048577));
  await promisify(execFile)('/usr/bin/mkfifo', [path.join(f.root, 'pipe')]);
  for (const [file, expected] of [['hardlink', null], ['hardlink', hash('outside-private')], ['escape/new', null], ['file-parent/child', null], ['moved', null], ['large', null], ['.ssh/new', null], ['pipe', null]]) {
    const result = await check(file, expected); assert.equal(result.matches, false, file);
    assert.equal(JSON.stringify(result).includes('outside-private'), false);
  }
  assert.equal((await check('protected/secret', null, [], { privatePaths: [path.join(f.root, 'protected')] })).matches, false);
  fs.chmodSync(path.join(f.root, 'protected'), 0);
  try { assert.equal((await check('protected/new', null)).matches, false, 'unreadable folders are not missing new folders'); }
  finally { fs.chmodSync(path.join(f.root, 'protected'), 0o700); }
  assert.equal(fs.readFileSync(path.join(f.outside, 'secret'), 'utf8'), 'outside-private');
  assert.equal(fs.existsSync(path.join(f.outside, 'new')), false);
});

test('reviewed mutations recheck required original parents without recreating them', { skip: !native }, async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'original'));
  await f.run('write-reviewed', 'original/new', { expectedHash: null, requiredParents: ['original'], data: encode('new') });
  await f.run('delete-reviewed', 'original/new', { expectedHash: hash('new'), requiredParents: ['original'] });
  fs.rmdirSync(path.join(f.root, 'original'));
  for (const op of ['write-reviewed', 'delete-reviewed']) await assert.rejects(f.run(op, 'original/new', {
    expectedHash: null, requiredParents: ['original'], ...(op === 'write-reviewed' ? { data: encode('new') } : {}),
  }), { status: 409 });
  assert.equal(fs.existsSync(path.join(f.root, 'original')), false);
});

test('workspace file exceptions require an exact current registry binding or owner authority', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), base = path.join(f.temp, 'workspaces'), workspaceRoot = path.join(base, 'one', 'files');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const request = { op: 'list', root: workspaceRoot, path: '' };
  let granted = true, observed;
  const agent = { id: 'agent', kind: 'browser', scopes: ['files:read'], browserWorkspaceId: 'one' };
  const config = { dataDir: f.cache, browserWorkspaceDir: base, resolveBrowserWorkspace: client => granted && client.browserWorkspaceId === 'one' ? [workspaceRoot] : [] };
  const run = async value => { observed = value; return { items: [], truncated: false }; };
  await browserFileOperation(request, () => agent, { config, run });
  assert.equal(observed.privatePaths.includes(base), false);
  for (const client of [{ ...agent, browserWorkspaceId: 'two' }, { ...agent, browserWorkspaceId: undefined }, { id: 'device', kind: 'device', scopes: [] }]) {
    await browserFileOperation(request, () => client, { config, run });
    assert.equal(observed.privatePaths.includes(base), true);
  }
  await browserFileOperation(request, owner, { config, run });
  assert.equal(observed.privatePaths.includes(base), false);
  await assert.rejects(browserFileOperation(request, () => agent, { config, run: async () => { granted = false; return { items: [], truncated: false }; } }), { status: 403 });
  const malformed = { ...config, resolveBrowserWorkspace: () => workspaceRoot };
  await browserFileOperation(request, () => agent, { config: malformed, run });
  assert.equal(observed.privatePaths.includes(base), true);
});

test('native reviewed writes and deletions preserve byte content and detect stale originals', { skip: !native }, async t => {
  const f = fixture(t), target = path.join(f.root, 'file');
  const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
  let result = await f.run('write-reviewed', 'file', { expectedHash: null, data: binary.toString('base64') });
  assert.equal(result.hash, hash(binary)); assert.deepEqual(fs.readFileSync(target), binary);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  for (const op of ['write-reviewed', 'delete-reviewed']) {
    await assert.rejects(f.run(op, 'file', { expectedHash: null, ...(op === 'write-reviewed' ? { data: '' } : {}) }), { status: 409 });
    await assert.rejects(f.run(op, 'file', { expectedHash: hash('stale'), ...(op === 'write-reviewed' ? { data: '' } : {}) }), { status: 409 });
    assert.deepEqual(fs.readFileSync(target), binary);
  }
  result = await f.run('write-reviewed', 'file', { expectedHash: hash(binary), data: '' });
  assert.equal(result.hash, hash('')); assert.equal(fs.statSync(target).size, 0);
  result = await f.run('delete-reviewed', 'file', { expectedHash: hash('') });
  assert.equal(result.hash, null); assert.equal(fs.existsSync(target), false);
  await assert.rejects(f.run('delete-reviewed', 'file', { expectedHash: hash('') }), { status: 409 });
  assert.deepEqual(await f.run('delete-reviewed', 'file', { expectedHash: null }), { ok: true, hash: null });
  const maximum = Buffer.alloc(1048576, 0xa5);
  await f.run('write-reviewed', 'large', { expectedHash: null, data: maximum.toString('base64') });
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'large')), maximum);
  assert.deepEqual(fs.readdirSync(f.root), ['large']);
  await f.run('mkdir', 'new-directory');
  for (const relative of ['new-directory', 'large']) await assert.rejects(f.run('mkdir', relative), { status: 409 });
});

test('native reviewed operations reject links, directories, private paths and oversized originals', { skip: !native }, async t => {
  const f = fixture(t), secret = path.join(f.outside, 'secret'); fs.writeFileSync(secret, 'private');
  fs.symlinkSync(secret, path.join(f.root, 'symlink'));
  fs.linkSync(secret, path.join(f.root, 'hardlink'));
  fs.symlinkSync(f.outside, path.join(f.root, 'escape'));
  fs.mkdirSync(path.join(f.root, 'directory'));
  fs.mkdirSync(path.join(f.root, '.ssh')); fs.writeFileSync(path.join(f.root, '.ssh', 'key'), 'private');
  fs.mkdirSync(path.join(f.root, 'protected')); fs.writeFileSync(path.join(f.root, 'protected', 'key'), 'private');
  fs.writeFileSync(path.join(f.root, 'oversized'), Buffer.alloc(1048577));
  for (const op of ['write-reviewed', 'delete-reviewed']) {
    for (const relative of ['symlink', 'hardlink', 'escape/secret', 'directory', '.ssh/key', 'protected/key']) {
      await assert.rejects(f.run(op, relative, { expectedHash: hash('private'), privatePaths: [path.join(f.root, 'protected')], ...(op === 'write-reviewed' ? { data: encode('changed') } : {}) }));
    }
    await assert.rejects(f.run(op, 'oversized', { expectedHash: hash(Buffer.alloc(1048577)), ...(op === 'write-reviewed' ? { data: '' } : {}) }), { status: 413 });
  }
  assert.equal(fs.readFileSync(secret, 'utf8'), 'private');
  assert.equal(fs.lstatSync(path.join(f.root, 'symlink')).isSymbolicLink(), true);
  assert.equal(fs.statSync(path.join(f.root, 'hardlink')).nlink, 2);
  assert.equal(fs.readFileSync(path.join(f.root, '.ssh', 'key'), 'utf8'), 'private');
  assert.equal(fs.readFileSync(path.join(f.root, 'protected', 'key'), 'utf8'), 'private');
  assert.ok(fs.readdirSync(f.root).every(name => !name.startsWith('.reach-review-')));
});

test('native review rechecks parent confinement, file identity and link status after the original hash', { skip: !native }, async t => {
  const f = fixture(t);
  const original = fs.readFileSync(new URL('../scripts/native/browser-files.swift', import.meta.url), 'utf8');
  const source = original.replace('let original = try reviewedFile(parent, leaf)', `let original = try reviewedFile(parent, leaf)
        FileHandle.standardOutput.write(Data("ready\\n".utf8))
        _ = FileHandle.standardInput.readData(ofLength: 1)`)
    .split('@main struct BrowserFiles {')[0] + `
@main struct ReviewMovedDirectoryTest { static func main() throws {
    let input = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
    let boundary = try Boundary(input)
    try confine(input)
    do { _ = try boundary.run(input); print("unexpected success") }
    catch { print((error as? BoundaryError)?.status ?? 500) }
} }
`;
  const sourceFile = path.join(f.temp, 'review-harness.swift'), binary = path.join(f.temp, 'review-harness');
  fs.writeFileSync(sourceFile, source);
  await promisify(execFile)('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', sourceFile, '-o', binary], { timeout: 120000 });
  for (const op of ['write-reviewed', 'delete-reviewed']) {
    const inside = path.join(f.root, op), moved = path.join(f.outside, op);
    fs.mkdirSync(inside); fs.writeFileSync(path.join(inside, 'file'), 'original');
    const stat = fs.statSync(f.root, { bigint: true });
    const request = { op, root: f.root, rootDev: String(stat.dev), rootIno: String(stat.ino), path: `${op}/file`, expectedHash: hash('original'), ...(op === 'write-reviewed' ? { data: encode('changed') } : {}), sandbox: fileBoundaryProfile(f.root, [], true) };
    const child = spawn(binary, [JSON.stringify(request)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    await once(child.stdout, 'data');
    fs.renameSync(inside, moved); child.stdin.end('x');
    const [code] = await once(child, 'close');
    assert.equal(code, 0); assert.match(output, /^ready\n(403|409)\n$/);
    assert.equal(fs.readFileSync(path.join(moved, 'file'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(moved), ['file']);
  }
  fs.writeFileSync(path.join(f.outside, 'secret'), 'outside');
  for (const op of ['write-reviewed', 'delete-reviewed']) {
    for (const attack of ['symlink', 'hardlink', 'directory', 'content', 'identity']) {
      const name = `${op}-${attack}`, folder = path.join(f.root, name), target = path.join(folder, 'file');
      fs.mkdirSync(folder); fs.writeFileSync(target, 'original');
      const stat = fs.statSync(f.root, { bigint: true });
      const request = { op, root: f.root, rootDev: String(stat.dev), rootIno: String(stat.ino), path: `${name}/file`, expectedHash: hash('original'), ...(op === 'write-reviewed' ? { data: encode('changed') } : {}), sandbox: fileBoundaryProfile(f.root, [], true) };
      const child = spawn(binary, [JSON.stringify(request)], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; });
      await once(child.stdout, 'data');
      if (attack === 'content') fs.writeFileSync(target, 'owner change');
      else {
        fs.unlinkSync(target);
        if (attack === 'symlink') fs.symlinkSync(path.join(f.outside, 'secret'), target);
        if (attack === 'hardlink') fs.linkSync(path.join(f.outside, 'secret'), target);
        if (attack === 'directory') fs.mkdirSync(target);
        if (attack === 'identity') fs.writeFileSync(target, 'original');
      }
      child.stdin.end('x');
      const [code] = await once(child, 'close');
      assert.equal(code, 0); assert.match(output, /^ready\n(403|409)\n$/, `${op}/${attack}: ${output}`);
      assert.deepEqual(fs.readdirSync(folder), ['file']);
      assert.equal(fs.readFileSync(path.join(f.outside, 'secret'), 'utf8'), 'outside');
      if (attack === 'symlink') assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
      if (attack === 'directory') assert.equal(fs.lstatSync(target).isDirectory(), true);
      if (attack === 'content') assert.equal(fs.readFileSync(target, 'utf8'), 'owner change');
      if (attack === 'identity') assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    }
  }
});
