import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runBrowserScript, scriptProfile } from '../server/browser-scripts.mjs';
import { createBrowserOperationCoordinator } from '../server/browser-operation-coordinator.mjs';

const native = process.platform === 'darwin' && process.env.REACH_TEST_SCRIPT_SANDBOX === '1';
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-guarded-script-')));
  const root = path.join(temp, 'shared'), outside = path.join(temp, 'secret');
  fs.mkdirSync(root); fs.writeFileSync(outside, 'never-disclose-this-outside-content');
  const client = { id: path.basename(temp), kind: 'agent', policy: { browser: true, restrictedTerminal: true, scriptApproval: true }, agentRoots: [root] };
  const coordinator = createBrowserOperationCoordinator();
  const resolve = (index, relative = '') => { assert.equal(index, 0); const full = fs.realpathSync(path.resolve(root, relative)); assert.ok(full === root || full.startsWith(root + '/')); return full; };
  t.after(() => { coordinator.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { root, outside, run: command => runBrowserScript({ type: 'terminal-script', root: 0, command }, () => client, { resolve, coordinator }) };
}

test('guarded aliases deny read and write and pin their containing directories', () => {
  const profile = scriptProfile('/tmp/project', [], [], { writes: ['(literal "/tmp/project/parent/link")'], special: ['(literal "/tmp/project/parent/pipe")'], pinned: ['/tmp/project/parent', '/tmp/project'] });
  assert.match(profile, /deny file-read\* file-write\* \(literal "\/tmp\/project\/parent\/link"\)/);
  assert.match(profile, /deny file-read\* file-write\* \(literal "\/tmp\/project\/parent\/pipe"\)/);
  assert.match(profile, /deny file-write-unlink file-write-mode[^\n]*"\/tmp\/project\/parent"/);
});

test('a preexisting hardlink cannot reveal or modify an outside file but normal files remain usable', { skip: !native }, async t => {
  const f = fixture(t); fs.linkSync(f.outside, path.join(f.root, 'alias'));
  const read = await f.run('/bin/cat alias');
  assert.notEqual(read.exitCode, 0); assert.equal(read.output.includes('never-disclose-this-outside-content'), false);
  const write = await f.run(`node -e 'require("fs").writeFileSync("alias", "changed")'`);
  assert.notEqual(write.exitCode, 0);
  const normal = await f.run(`node -e 'require("fs").writeFileSync("normal", "allowed")'`);
  assert.equal(normal.exitCode, 0, normal.output);
  assert.equal(fs.readFileSync(path.join(f.root, 'normal'), 'utf8'), 'allowed');
  assert.equal(fs.readFileSync(f.outside, 'utf8'), 'never-disclose-this-outside-content');
});

test('renaming any ancestor cannot move a hardlink outside its sandbox denial', { skip: !native }, async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'parent', 'nested'), { recursive: true });
  fs.linkSync(f.outside, path.join(f.root, 'parent', 'nested', 'alias'));
  for (const parent of ['parent', 'parent/nested']) {
    const attack = await f.run(`node -e 'const fs=require("fs"); fs.renameSync("${parent}", "moved"); fs.writeFileSync("moved/${parent === 'parent' ? 'nested/' : ''}alias", "changed")'`);
    assert.notEqual(attack.exitCode, 0, attack.output);
    assert.equal(fs.existsSync(path.join(f.root, 'moved')), false);
    assert.equal(fs.readFileSync(f.outside, 'utf8'), 'never-disclose-this-outside-content');
  }
});

test('special files and their parents stay inaccessible to isolated scripts', { skip: !native }, async t => {
  const f = fixture(t), parent = path.join(f.root, 'special'); fs.mkdirSync(parent);
  execFileSync('/usr/bin/mkfifo', [path.join(parent, 'pipe')]);
  const open = await f.run(`node -e 'const fs=require("fs"); fs.closeSync(fs.openSync("special/pipe", fs.constants.O_RDWR | fs.constants.O_NONBLOCK))'`);
  assert.notEqual(open.exitCode, 0, open.output);
  const move = await f.run(`node -e 'require("fs").renameSync("special", "moved")'`);
  assert.notEqual(move.exitCode, 0, move.output); assert.equal(fs.existsSync(path.join(f.root, 'moved')), false);
});

test('an incomplete parallel find scan refuses execution instead of accepting partial exclusions', { skip: !native }, async t => {
  const f = fixture(t), restricted = path.join(f.root, 'a', 'b', 'c');
  fs.mkdirSync(restricted, { recursive: true }); fs.writeFileSync(path.join(restricted, 'hidden'), 'fixture'); fs.chmodSync(restricted, 0);
  try {
    await assert.rejects(f.run(`node -e 'require("fs").writeFileSync("ran", "bad")'`), { status: 503 });
    assert.equal(fs.existsSync(path.join(f.root, 'ran')), false);
  } finally { fs.chmodSync(restricted, 0o700); }
});

test('directory enumeration and final metadata errors refuse execution', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), file = path.join(f.root, 'existing'); fs.writeFileSync(file, 'fixture');
  const originalRead = fs.readdirSync;
  const reading = t.mock.method(fs, 'readdirSync', (target, ...options) => {
    if (target === f.root) throw Object.assign(Error('unreadable'), { code: 'EACCES' });
    return originalRead(target, ...options);
  });
  await assert.rejects(f.run('node -e "console.log(1)"'), { status: 503 }); reading.mock.restore();
  const originalStat = fs.lstatSync;
  const stating = t.mock.method(fs, 'lstatSync', (target, ...options) => {
    if (target === file) throw Object.assign(Error('changed'), { code: 'ENOENT' });
    return originalStat(target, ...options);
  });
  await assert.rejects(f.run('node -e "console.log(1)"'), { status: 503 }); stating.mock.restore();
});
