import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

// Execute the exact isolated publisher block with a persistent fake REST server.
// Its writes survive simulated lost responses, as real GitHub writes would.
const workflow = parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const step = workflow.jobs.publish.steps.find(step => step.id === 'github-release');
const script = step.run.match(/<<'GITHUB_RELEASE'\n([\s\S]*?)\nGITHUB_RELEASE(?:\n|$)/)?.[1];
assert.ok(script, 'the publisher recovery block must be tested, not copied');
const commit = 'a'.repeat(40), otherCommit = 'b'.repeat(40), version = '0.1.0';
const tag = `v${version}`, repository = 'fixture/reach', title = `Reach ${version}`;
const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

const mock = `
import mockFs from 'node:fs';
import mockCrypto from 'node:crypto';
const remoteFile = 'remote.json';
const remote = JSON.parse(mockFs.readFileSync(remoteFile, 'utf8'));
const save = () => mockFs.writeFileSync(remoteFile, JSON.stringify(remote));
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
const lost = point => { if (remote.lose === point) { delete remote.lose; save(); throw Error('synthetic lost ' + point + ' response'); } };
globalThis.fetch = async (input, options) => {
  const url = new URL(input), method = options.method;
  if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:' ||
      options.headers.Authorization !== 'Bearer synthetic-only-token' || options.redirect !== 'error' || !options.signal)
    throw Error('unsafe request or unbounded network access');
  remote.calls.push({ method, path: url.pathname, query: url.search }); save();
  if (remote.error) return response(remote.error, {});
  const base = '/repos/fixture/reach';
  if (method === 'GET' && url.pathname === base + '/git/ref/tags/v0.1.0') {
    remote.tagReads = (remote.tagReads || 0) + 1; save();
    const sha = remote.moveTag && remote.tagReads > 1 ? '${otherCommit}' : remote.tagCommit;
    return response(200, { ref: 'refs/tags/v0.1.0', object: remote.annotated ? { type: 'tag', sha: '${'c'.repeat(40)}' } : { type: 'commit', sha } });
  }
  if (method === 'GET' && url.pathname === base + '/git/tags/${'c'.repeat(40)}')
    return response(200, { object: remote.annotationLoop ? { type: 'tag', sha: '${'c'.repeat(40)}' } : { type: 'commit', sha: remote.tagCommit } });
  if (method === 'GET' && url.pathname === base + '/releases') {
    const page = Number(url.searchParams.get('page'));
    if (remote.secondPage) return response(200, page === 1 ? Array.from({length:100}, (_, id) => ({id:1000 + id, tag_name:'other-' + id})) : remote.releases);
    return response(200, page === 1 ? remote.releases : []);
  }
  if (method === 'POST' && url.pathname === base + '/releases') {
    const body = JSON.parse(options.body);
    if (remote.releases.some(release => release.tag_name === body.tag_name)) return response(422, {});
    const release = { ...body, id: 42 };
    remote.releases.push(release); save(); lost('create'); return response(201, release);
  }
  const release = remote.releases.find(release => release.id === 42);
  if (method === 'GET' && url.pathname === base + '/releases/42/assets') return response(200, remote.assets);
  if (method === 'GET' && url.pathname === base + '/releases/42') {
    if (remote.changeNotes) release.body = 'concurrent conflicting notes';
    save(); return response(200, release);
  }
  if (url.hostname === 'uploads.github.com' && method === 'POST' && url.pathname === base + '/releases/42/assets') {
    const name = url.searchParams.get('name');
    if (!release?.draft || remote.assets.some(asset => asset.name === name)) return response(422, {});
    const bytes = Buffer.from(options.body);
    const asset = { name, id: remote.assets.length + 1, state: 'uploaded', size: bytes.length,
      digest: 'sha256:' + mockCrypto.createHash('sha256').update(bytes).digest('hex') };
    remote.assets.push(asset); save(); lost('upload-' + remote.assets.length); return response(201, asset);
  }
  if (method === 'PATCH' && url.pathname === base + '/releases/42') {
    if (JSON.stringify(JSON.parse(options.body)) !== '{"draft":false}' || !release.draft || remote.assets.length !== 4)
      throw Error('unsafe release modification');
    release.draft = false; save(); lost('publish'); return response(200, release);
  }
  throw Error('Unexpected synthetic API request ' + method + ' ' + url.pathname);
};
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-release-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'); fs.mkdirSync(candidate);
  const npm = `nalebc-reach-${version}.tgz`, portable = `reach-${version}-portable.tar.gz`;
  const notes = 'Verified fixture notes.\n';
  fs.writeFileSync(path.join(candidate, npm), 'verified npm fixture');
  fs.writeFileSync(path.join(candidate, portable), 'verified portable fixture');
  fs.writeFileSync(path.join(candidate, 'SHA256SUMS'), [npm, portable].map(name => `${sha256(fs.readFileSync(path.join(candidate, name))).slice(7)}  ${name}\n`).join(''));
  const receipt = { version, package: '@nalebc/reach', commit, npm, portable, platform: 'linux', architecture: 'x64' };
  fs.writeFileSync(path.join(candidate, 'candidate.json'), JSON.stringify(receipt) + '\n');
  fs.writeFileSync(path.join(candidate, 'NOTES.md'), notes);
  const assets = [npm, portable, 'SHA256SUMS', 'candidate.json'].map((name, id) => {
    const bytes = fs.readFileSync(path.join(candidate, name));
    return { id: id + 1, name, state: 'uploaded', size: bytes.length, digest: sha256(bytes) };
  });
  const release = { id: 42, tag_name: tag, target_commitish: commit, name: title, body: notes, prerelease: false, draft: true };
  const stateFile = path.join(root, 'remote.json');
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const write = state => fs.writeFileSync(stateFile, JSON.stringify(state));
  const reset = fields => write({ calls: [], releases: [], assets: [], tagCommit: commit, ...fields });
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', mock + '\n' + script], {
    cwd: root, env: { ...process.env, VERSION: version, GITHUB_REF_NAME: tag, GITHUB_SHA: commit, GITHUB_REPOSITORY: repository, GH_TOKEN: 'synthetic-only-token' },
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  reset();
  return { root, candidate, release, receipt, assets, read, write, reset, run };
}
const writes = state => state.calls.filter(call => call.method !== 'GET');
const successful = result => assert.equal(result.status, 0, result.stderr);
const refused = result => assert.notEqual(result.status, 0, 'conflicting release must not be accepted');

test('release recovery creates a complete draft, then publishes once; an exact rerun is read-only', t => {
  const f = fixture(t);
  successful(f.run());
  let state = f.read();
  assert.equal(state.releases.length, 1); assert.equal(state.releases[0].draft, false);
  assert.deepEqual(state.assets, f.assets);
  assert.deepEqual(writes(state).map(call => call.method), ['POST', 'POST', 'POST', 'POST', 'POST', 'PATCH']);
  assert.equal(state.tagReads, 2, 'recheck the live tag before publishing');
  state.calls = []; f.write(state);
  successful(f.run());
  assert.deepEqual(writes(f.read()), [], 'a successful release rerun cannot replace any bytes or metadata');
});

test('release recovery survives lost create, upload and publish responses without duplicates', t => {
  const f = fixture(t);
  for (const lose of ['create', 'upload-1', 'upload-3', 'publish']) {
    f.reset({ lose });
    refused(f.run());
    assert.equal(f.read().releases.length, 1, `${lose}: the remote write happened`);
    successful(f.run());
    const state = f.read();
    assert.equal(state.releases.length, 1);
    assert.equal(state.releases[0].draft, false);
    assert.deepEqual(state.assets, f.assets);
    assert.equal(writes(state).filter(call => call.path === '/repos/fixture/reach/releases').length, 1, 'never duplicate a draft');
    assert.equal(writes(state).filter(call => call.path.endsWith('/assets')).length, 4, 'never re-upload an existing asset');
    assert.equal(writes(state).filter(call => call.method === 'PATCH').length, 1, 'never republish a completed release');
  }
});

test('release recovery finds an existing draft on a later page and peels annotated tags', t => {
  const f = fixture(t);
  f.reset({ releases: [f.release], assets: f.assets.slice(0, 2), secondPage: true, annotated: true });
  successful(f.run());
  assert.deepEqual(f.read().assets, f.assets);
  assert.equal(writes(f.read()).filter(call => call.method === 'POST').length, 2);
  assert.ok(f.read().calls.some(call => call.query.includes('page=2')));
  assert.equal(f.read().calls.filter(call => call.path.includes('/git/tags/')).length, 2);
});

test('release recovery refuses conflicting metadata, target, assets and incomplete published releases before writing', t => {
  const f = fixture(t);
  const cases = [
    { tagCommit: otherCommit },
    ...[{ target_commitish: otherCommit }, { name: 'different title' }, { body: 'different notes' }, { prerelease: true }].map(change => ({ releases: [{ ...f.release, ...change }] })),
    { releases: [{ ...f.release, draft: false }], assets: f.assets.slice(0, 3) },
    ...[{ digest: 'sha256:' + '0'.repeat(64) }, { digest: undefined }, { size: 999 }, { state: 'starter' }, { name: 'unverified.txt' }].map(change => ({ assets: [{ ...f.assets[0], ...change }, ...f.assets.slice(1)] })),
    { assets: [f.assets[0], f.assets[0]] },
    { assets: [...f.assets, { name: 'unexpected.txt' }] },
    { releases: [f.release, { ...f.release, id: 43 }] },
    { annotated: true, annotationLoop: true },
    ...[401, 403, 429, 500].map(error => ({ error })),
  ];
  for (const changed of cases) {
    f.reset({ releases: [f.release], assets: f.assets, ...changed });
    refused(f.run());
    assert.deepEqual(writes(f.read()), [], JSON.stringify(changed));
  }
});

test('release recovery refuses a mismatched candidate receipt before contacting GitHub', t => {
  const f = fixture(t);
  for (const change of [{ commit: otherCommit }, { package: 'other-package' }, { version: '0.2.0' }, { npm: '../other.tgz' }, { portable: 'different.tar.gz' }]) {
    f.reset();
    fs.writeFileSync(path.join(f.candidate, 'candidate.json'), JSON.stringify({ ...f.receipt, ...change }));
    refused(f.run());
    assert.deepEqual(f.read().calls, []);
  }
});

test('release recovery never publishes if the tag or draft notes change during upload', t => {
  const f = fixture(t);
  for (const change of [{ moveTag: true }, { changeNotes: true }]) {
    f.reset(change);
    refused(f.run());
    assert.equal(f.read().releases[0].draft, true);
    assert.equal(writes(f.read()).filter(call => call.method === 'PATCH').length, 0);
  }
});
