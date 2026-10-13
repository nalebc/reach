import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { validateBrowserRoot } from '../server/browser-private-paths.mjs';
import { browserFileOperation } from '../server/browser-file-boundary.mjs';
import { browserAccessRoutes } from '../server/browser-access.mjs';
import { safePath } from '../server/core.mjs';
import { presetScopes } from '../server/agent-presets.mjs';

const policy = (preset) => ({ invite: true, browser: true, preset, roots: [] });
function temporary(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-home-preset-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('only Full and Read only authorize the exact Home, never its ancestors or system roots', (t) => {
  const dir = temporary(t), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  const runtime = path.join(home, '.runtime', 'bin', 'node');
  for (const preset of ['readonly']) {
    const options = { home, runtime, policy: policy(preset) };
    assert.equal(validateBrowserRoot(home, options), home);
    assert.equal(validateBrowserRoot(path.join(home, 'Desktop'), options), path.join(home, 'Desktop'));
    for (const root of [dir, path.parse(home).root, '/Applications', '/Library', '/System', '/usr', path.join(home, 'Applications'), path.dirname(runtime)])
      assert.throws(() => validateBrowserRoot(root, options), { status: 403 }, root);
  }
  for (const context of [undefined, policy('files'), { browser: true }, { preset: 'full' }, { browser: false, preset: 'full' }])
    assert.throws(() => validateBrowserRoot(home, { home, runtime, policy: context }), { status: 403 });
});

test('Home file operations derive access from authorized policy and retain private boundary rules', async (t) => {
  const dataDir = temporary(t), home = path.join(dataDir, 'home');
  fs.mkdirSync(path.join(home, 'Library'), { recursive: true });
  t.mock.method(os, 'homedir', () => home);
  // A fresh, canonical Home with a Library; every operation uses this inert runner.
  let calls = 0;
  const run = async (request) => {
    calls++;
    assert.equal(request.root, home);
    if (!request.fullControl) for (const name of ['.ssh', '.aws', '.codex', '.claude', '.zshrc']) assert.ok(request.privateNames.includes(name));
    else assert.deepEqual(request.privateNames, []);
    assert.equal(request.privatePaths.includes(path.join(home, 'Library')), !request.fullControl);
    assert.match(request.sandbox, /deny process-fork process-exec file-link/);
    if (!request.fullControl) assert.match(request.sandbox, /deny file-read\* file-write\*/);
    assert.doesNotMatch(request.sandbox, /allow file-write/);
    return request.op === 'read' ? { data: Buffer.from('fixture').toString('base64') } : { items: [], truncated: false };
  };
  for (const preset of ['full', 'readonly']) {
    const client = { id: preset, policy: policy(preset), agentRoots: [home] };
    assert.deepEqual(await browserFileOperation({ op: 'list', root: home, path: '' }, () => client, { config: { dataDir }, run }), { items: [], truncated: false });
    assert.equal((await browserFileOperation({ op: 'read', root: home, path: 'synthetic-not-read.txt' }, () => client, { config: { dataDir }, run })).data.toString(), 'fixture');
  }
  assert.equal(calls, 4);
  for (const currentPolicy of [policy('files'), { browser: true }, undefined]) {
    await assert.rejects(browserFileOperation({ op: 'list', root: home, path: '', policy: policy('full'), allowHome: true },
      () => ({ id: 'narrow', policy: currentPolicy }), { config: { dataDir }, run }), { status: 403 });
  }
  assert.equal(calls, 4, 'request-supplied policy/flags cannot bypass the grant');
  let active = true;
  await assert.rejects(browserFileOperation({ op: 'list', root: home, path: '' }, () => {
    if (!active) throw Object.assign(Error('revoked fixture'), { status: 403 });
    return { id: 'revoked', policy: policy('full') };
  }, { config: { dataDir }, run: async () => { active = false; return { items: [] }; } }), /revoked fixture/);
});

test('preset invitations validate explicit and default roots before any credential is issued', async (t) => {
  const home = fs.realpathSync.native(os.homedir());
  const config = { roots: [home] };
  let current = { id: 'owner', kind: 'device', scopes: ['admin'] };
  const issued = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.reauthorize = () => current; next(); });
  browserAccessRoutes(app, {
    config,
    auth: { inviteBrowser(input) { issued.push(input); return { clientId: 'synthetic', invitation: 'synthetic', joinBy: Date.now() + 60000 }; } },
    resolve: (root, relative) => safePath(config.roots, root, relative),
    desktop: { available: () => true },
    hostGuard: { async beginInvitation() { return () => {}; } },
    protectedFilesSupported: true,
    record: () => {},
  });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const send = (body, route = '/api/agents/browser-invitations') => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'fixture', ttlSeconds: 600, ...body }),
  });
  for (const preset of ['full', 'readonly']) {
    assert.equal((await send({ preset, ...(preset === 'full' ? { fullControlVersion: 1 } : {}) })).status, 201);
    assert.equal((await send({ preset, ...(preset === 'full' ? { fullControlVersion: 1 } : {}), folders: [{ root: 0, path: '' }] })).status, 201);
  }
  assert.equal(issued.length, 4);
  assert.equal((await send({ preset: 'files', folders: [{ root: 0, path: '' }] })).status, 403);
  assert.equal((await send({ folders: [{ root: 0, path: '' }] })).status, 403, 'legacy invitations remain strict');
  assert.equal((await send({ preset: 'files', folders: [{ root: 0, path: '' }], allowHome: true })).status, 400);
  config.roots = [path.parse(home).root];
  for (const preset of ['full', 'readonly']) {
    assert.equal((await send({ preset, ...(preset === 'full' ? { fullControlVersion: 1 } : {}) })).status, preset === 'full' ? 201 : 403, 'full can use the whole computer');
    assert.equal((await send({ preset, ...(preset === 'full' ? { fullControlVersion: 1 } : {}), folders: [{ root: 0, path: '' }] })).status, preset === 'full' ? 201 : 403, 'narrow presets still reject filesystem roots');
  }
  assert.equal(issued.length, 6, 'only Full control can cover the filesystem root');
  current = { id: 'reader', kind: 'agent', policy: policy('readonly'), scopes: presetScopes(policy('readonly')), agentRoots: [home] };
  assert.equal((await send({ op: 'write', root: 0, path: 'synthetic.txt', content: 'never written' }, '/api/browser/files/change')).status, 403);
  assert.equal((await send({ preset: 'full' })).status, 403, 'an agent cannot grant itself another preset');
});
