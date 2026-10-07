import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createReach } from '../server/index.mjs';
import { ALL_SCOPES, atomicJson } from '../server/core.mjs';
import { applyAgentPolicy } from '../server/agent-policy.mjs';

const native = process.platform === 'darwin' && process.env.REACH_TEST_WORKSPACES === '1';
const account = { userId: '42', login: 'owner@example.test' };
const addresses = { owner: '100.64.0.1', first: '100.64.0.2', second: '100.64.0.3', broad: '100.64.0.4' };
const identity = nodeId => ({ nodeId, userId: nodeId === 'owner' ? '42' : '', tagged: nodeId !== 'owner', validUntil: Date.now() + 60000 });

// Actual private-listener HTTP, admission, native file boundaries and owner
// approvals; only Tailscale's external identity lookup uses fixture responses.
async function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-workspace-auth-')));
  const socketDir = fs.mkdtempSync('/tmp/reach-wsa-'), socketPath = path.join(socketDir, 's');
  const source = path.join(temp, 'project'), dataDir = path.join(temp, 'private'), copies = path.join(temp, 'workspaces');
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'note.txt'), 'original');
  const reach = await createReach({ roots: [temp], dataDir, browserWorkspaceDir: copies, port: 0, screen: false,
    tailscaleOwner: account,
    desktopTerminals: { platform: 'linux', run: async () => assert.fail('No host terminal access') },
    browserCapture: async () => assert.fail('No screen capture'), browserInput: async () => assert.fail('No desktop input'),
    tailscaleIdentity: { lookup: async ip => {
      const node = Object.keys(addresses).find(key => addresses[key] === ip);
      assert.ok(node, 'Only fixture nodes can connect');
      return node === 'owner' ? { Node: { StableID: node, User: 42 }, UserProfile: { ID: 42, LoginName: account.login } } : { Node: { StableID: node, Tags: ['tag:agent'] } };
    } },
  });
  const owner = reach.auth.issue('Owner', ALL_SCOPES, 'device', { tailscale: { nodeId: 'owner', userId: '42' } });
  t.after(async () => { await reach.close(); fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(socketDir, { recursive: true, force: true }); });
  await new Promise(resolve => reach.server.listen(0, '127.0.0.1', resolve));
  await reach.listenPrivate(socketPath);
  const call = (route, { node = 'owner', token = node === 'owner' ? owner.token : '', method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method, headers: {
      Host: 'localhost', 'X-Forwarded-For': addresses[node], 'Tailscale-User-Login': account.login,
      ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json',
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let value;
        try { value = JSON.parse(text); } catch { value = text; }
        resolve({ status: response.statusCode, body: value });
      });
    });
    request.setTimeout(20000, () => request.destroy(Error('Fixture request timed out')));
    request.once('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const join = async (node, { workspaceMode = 'private', folder = 'project' } = {}) => {
    const created = await call('/api/agents/browser-invitations', { method: 'POST', body: { name: 'Muse', ttlSeconds: 600,
      screen: 'off', workspaceMode, folders: [{ root: 0, path: folder }], restrictedTerminal: true, terminalApproval: true, scriptApproval: true } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const claimed = await call('/api/invitations/redeem', { node, method: 'POST', body: { invitation: created.body.invitation } });
    assert.equal(claimed.status, 202, JSON.stringify(claimed.body)); assert.equal(claimed.body.token, undefined);
    const admitted = await call(`/api/agents/admissions/${claimed.body.requestId}`, { method: 'POST', body: { decision: 'approve' } });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    const collected = await call(`/api/invitations/claims/${claimed.body.requestId}/status`, { node, method: 'POST', body: { secret: claimed.body.requestSecret } });
    assert.equal(collected.status, 200, JSON.stringify(collected.body)); assert.equal(collected.body.status, 'approved');
    return { ...collected.body, invitation: created.body, node,
      as: (route, options = {}) => call(route, { node, token: collected.body.token, ...options }) };
  };
  const approve = async (agent, command, expected = 'executed') => {
    const requested = await agent.as('/api/browser/terminal', { method: 'POST', body: { root: 0, command } });
    assert.equal(requested.status, 202, JSON.stringify(requested.body)); assert.equal(requested.body.status, 'pending');
    const result = await call(`/api/agents/browser-requests/${requested.body.id}`, { method: 'POST', body: { decision: 'approve',
      ...(requested.body.action.type === 'terminal-script' ? { reviewedScript: true } : { reviewedTerminalChange: true }) } });
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.status, expected, JSON.stringify(result.body));
    return result;
  };
  return { temp, source, copies, dataDir, reach, call, join, approve };
}

test('private workspace HTTP admission, scopes, owner review and apply preserve separate authority', { skip: !native }, async t => {
  const f = await fixture(t), first = await f.join('first'), second = await f.join('second');
  const firstCopy = first.invitation.workspace, secondCopy = second.invitation.workspace;
  assert.notEqual(firstCopy.roots[0], secondCopy.roots[0]);
  assert.equal((await first.as('/api/files/text?root=0&path=note.txt')).body.text, 'original');
  assert.equal((await second.as('/api/files/text?root=0&path=note.txt')).body.text, 'original');
  const terminalRead = await first.as('/api/browser/terminal', { method: 'POST', body: { root: 0, command: 'cat note.txt' } });
  assert.equal(terminalRead.body.status, 'executed', JSON.stringify(terminalRead.body));
  await f.approve(first, 'cp note.txt added.txt');
  assert.equal(fs.readFileSync(path.join(firstCopy.roots[0], 'added.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(f.source, 'added.txt')), false);
  assert.equal(fs.existsSync(path.join(secondCopy.roots[0], 'added.txt')), false);
  await f.approve(first, `node -e 'require("fs").writeFileSync("note.txt", "private edit")'`);
  assert.equal(fs.readFileSync(path.join(firstCopy.roots[0], 'note.txt'), 'utf8'), 'private edit');
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'original');
  assert.equal((await second.as('/api/files/text?root=0&path=note.txt')).body.text, 'original');
  fs.symlinkSync(secondCopy.roots[0], path.join(firstCopy.roots[0], 'other-copy'));
  for (const route of [
    '/api/files/text?root=1&path=note.txt',
    '/api/files/text?root=0&path=../note.txt',
    `/api/files/text?root=0&path=${encodeURIComponent(path.join(secondCopy.roots[0], 'note.txt'))}`,
    '/api/files/text?root=0&path=other-copy/note.txt',
  ]) assert.ok([400, 403].includes((await first.as(route)).status), route);
  const broad = await f.join('broad', { workspaceMode: 'shared', folder: '' });
  for (const route of ['/api/files?root=0&path=workspaces', `/api/files/text?root=0&path=${encodeURIComponent(path.relative(f.temp, path.join(firstCopy.roots[0], 'note.txt')))}`])
    assert.equal((await broad.as(route)).status, 403, route);
  const broadListing = await broad.as('/api/files?root=0&path=');
  assert.equal(broadListing.status, 200, JSON.stringify(broadListing.body));
  assert.equal(JSON.stringify(broadListing.body).includes('workspaces'), false);
  await f.approve(second, `node -e 'require("fs").writeFileSync("note.txt", "second-copy-only-value")'`);
  for (const agent of [first, broad]) {
    const command = `node -e 'process.stdout.write(require("fs").readFileSync("${path.join(secondCopy.roots[0], 'note.txt')}"))'`;
    const forbidden = await f.approve(agent, command, 'failed');
    assert.equal(JSON.stringify(forbidden.body).includes('second-copy-only-value'), false);
  }
  for (const agent of [first, second, broad]) {
    for (const [route, method, body] of [
      [`/api/agents/workspaces/${firstCopy.id}/review`, 'POST', {}],
      [`/api/agents/workspaces/${firstCopy.id}/apply`, 'POST', { reviewId: firstCopy.id }],
      [`/api/agents/workspaces/${firstCopy.id}`, 'DELETE'],
      ['/api/browser/agents', 'GET'],
    ]) assert.equal((await agent.as(route, { method, body })).status, 403, `${agent.node}: ${route}`);
  }
  const verified = f.reach.auth.verify(first.token, identity('first'));
  assert.deepEqual(verified.agentRoots, firstCopy.roots);
  for (const change of [
    { browserWorkspaceId: secondCopy.id },
    { policy: { ...verified.policy, roots: secondCopy.roots } },
    { agentRoots: secondCopy.roots },
    { policy: { ...verified.policy, roots: [f.source] } },
  ]) assert.equal(applyAgentPolicy({ ...verified, ...change }, f.reach.config), null);
  const clientsFile = path.join(f.dataDir, 'clients.json'), stored = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
  try {
    const replaced = structuredClone(stored), client = replaced.find(value => value.id === first.clientId);
    client.browserWorkspaceId = secondCopy.id; client.policy.roots = secondCopy.roots;
    atomicJson(clientsFile, replaced);
    assert.equal(f.reach.auth.verify(first.token, identity('first')), null);
    assert.equal((await first.as('/api/files/text?root=0&path=note.txt')).status, 401);
  } finally { atomicJson(clientsFile, stored); }
  const review = await f.call(`/api/agents/workspaces/${firstCopy.id}/review`, { method: 'POST', body: {} });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.summary.added, 1); assert.equal(review.body.summary.changed, 1);
  assert.equal(review.body.summary.conflicts, 0);
  assert.equal(review.body.changes.find(value => value.path === 'note.txt').afterText, 'private edit');
  assert.equal(f.reach.auth.verify(first.token, identity('first')), null);
  assert.equal((await first.as('/api/files/text?root=0&path=note.txt')).status, 401);
  const ownerAgents = await f.call('/api/browser/agents');
  const retained = ownerAgents.body.agents.find(value => value.id === first.clientId);
  assert.equal(retained.status, 'revoked'); assert.equal(retained.workspace.id, firstCopy.id); assert.equal(retained.workspace.status, 'reviewed');
  assert.equal((await f.call(`/api/agents/workspaces/${firstCopy.id}/apply`, { method: 'POST', body: { reviewId: secondCopy.id } })).status, 409);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'original');
  const applied = await f.call(`/api/agents/workspaces/${firstCopy.id}/apply`, { method: 'POST', body: { reviewId: review.body.id } });
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.partial, false);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'private edit');
  assert.equal(fs.readFileSync(path.join(f.source, 'added.txt'), 'utf8'), 'original');
  assert.equal((await f.call(`/api/agents/workspaces/${firstCopy.id}/apply`, { method: 'POST', body: { reviewId: review.body.id } })).status, 409);

  await f.approve(second, 'cp note.txt another.txt');
  const conflictReview = await f.call(`/api/agents/workspaces/${secondCopy.id}/review`, { method: 'POST', body: {} });
  assert.equal(conflictReview.status, 200, JSON.stringify(conflictReview.body));
  assert.equal(conflictReview.body.summary.conflicts, 1);
  assert.equal(typeof conflictReview.body.changes.find(value => value.path === 'note.txt').conflict, 'string');
  assert.equal(conflictReview.body.changes.find(value => value.path === 'another.txt').conflict, undefined);
  assert.equal((await f.call(`/api/agents/workspaces/${secondCopy.id}/apply`, { method: 'POST', body: { reviewId: conflictReview.body.id, force: true } })).status, 400);
  const conflict = await f.call(`/api/agents/workspaces/${secondCopy.id}/apply`, { method: 'POST', body: { reviewId: conflictReview.body.id } });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'private edit');
  assert.equal(fs.existsSync(path.join(f.source, 'another.txt')), false);
  assert.equal(fs.readFileSync(path.join(secondCopy.roots[0], 'another.txt'), 'utf8'), 'second-copy-only-value');
  const discarded = await f.call(`/api/agents/workspaces/${secondCopy.id}`, { method: 'DELETE' });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal(fs.existsSync(path.dirname(secondCopy.roots[0])), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'private edit');
});

test('two private agents can apply disjoint edits to the same original folder from existing reviews', { skip: !native }, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.source, 'readme.txt'), 'initial readme');
  const first = await f.join('first'), second = await f.join('second');
  await f.approve(first, `node -e 'require("fs").writeFileSync("note.txt", "first agent")'`);
  await f.approve(second, `node -e 'require("fs").writeFileSync("readme.txt", "second agent")'`);
  const reviews = [];
  for (const agent of [first, second]) {
    const result = await f.call(`/api/agents/workspaces/${agent.invitation.workspace.id}/review`, { method: 'POST', body: {} });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.summary.conflicts, 0);
    assert.equal(result.body.changes.length, 1);
    reviews.push(result.body);
  }
  const firstApply = await f.call(`/api/agents/workspaces/${first.invitation.workspace.id}/apply`, { method: 'POST', body: { reviewId: reviews[0].id } });
  assert.equal(firstApply.status, 200, JSON.stringify(firstApply.body));
  assert.equal(firstApply.body.partial, false);
  fs.mkdirSync(path.join(f.source, 'owner-folder'));
  fs.writeFileSync(path.join(f.source, 'owner-folder', 'owner-note.txt'), 'unrelated owner work');
  const secondApply = await f.call(`/api/agents/workspaces/${second.invitation.workspace.id}/apply`, { method: 'POST', body: { reviewId: reviews[1].id } });
  assert.equal(secondApply.status, 200, JSON.stringify(secondApply.body));
  assert.equal(secondApply.body.partial, false);
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'first agent');
  assert.equal(fs.readFileSync(path.join(f.source, 'readme.txt'), 'utf8'), 'second agent');
  assert.equal(fs.readFileSync(path.join(f.source, 'owner-folder', 'owner-note.txt'), 'utf8'), 'unrelated owner work');
  assert.equal((await first.as('/api/files?root=0&path=')).status, 401);
  assert.equal((await second.as('/api/files?root=0&path=')).status, 401);
});

test('a removed original parent blocks the entire stale review and is identified without recreating it', { skip: !native }, async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.source, 'nested'));
  fs.writeFileSync(path.join(f.source, 'nested', 'child.txt'), 'child baseline');
  const agent = await f.join('first');
  await f.approve(agent, `node -e 'const fs=require("fs");fs.writeFileSync("note.txt","agent note");fs.writeFileSync("nested/child.txt","agent child")'`);
  const route = `/api/agents/workspaces/${agent.invitation.workspace.id}`;
  const reviewed = await f.call(route + '/review', { method: 'POST', body: {} });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.summary.conflicts, 0);
  fs.rmSync(path.join(f.source, 'nested'), { recursive: true });
  const applied = await f.call(route + '/apply', { method: 'POST', body: { reviewId: reviewed.body.id } });
  assert.equal(applied.status, 409, JSON.stringify(applied.body));
  assert.equal(fs.readFileSync(path.join(f.source, 'note.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(f.source, 'nested')), false);
  const refreshed = await f.call(route + '/review', { method: 'POST', body: {} });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.notEqual(refreshed.body.id, reviewed.body.id);
  assert.equal(refreshed.body.summary.conflicts, 1);
  assert.ok(refreshed.body.changes.find(value => value.path === 'nested/child.txt').conflict);
  assert.equal(refreshed.body.changes.find(value => value.path === 'note.txt').conflict, undefined);
  assert.equal(fs.existsSync(path.join(f.source, 'nested')), false);
});
