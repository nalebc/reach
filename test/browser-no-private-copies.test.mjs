import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateBrowserInvitation } from '../server/core.mjs';
import { browserFileOperation } from '../server/browser-file-boundary.mjs';
import { applyAgentPolicy } from '../server/agent-policy.mjs';

// Agents invited with folders always use the real folders. Copying a folder
// like the Desktop could never work, so the private-copy feature is gone.
const invite = extra => ({ name: 'Muse', ttlSeconds: 600, folders: [{ root: 0, path: 'project' }], ...extra });

test('invitations no longer ask for a private copy', () => {
  assert.throws(() => validateBrowserInvitation(invite({ workspaceMode: 'private' })), { status: 400 });
  const shared = validateBrowserInvitation(invite({ workspaceMode: 'shared' }));
  assert.equal('workspaceMode' in shared, false);
  assert.equal('workspaceMode' in validateBrowserInvitation(invite()), false);
});

test('the file boundary has no reviewed copy-apply operations', async () => {
  const owner = () => ({ id: 'owner', kind: 'device', scopes: ['admin'] });
  for (const op of ['check-reviewed', 'write-reviewed', 'delete-reviewed'])
    await assert.rejects(browserFileOperation({ op, root: '/tmp/project', path: 'file', expectedHash: null }, owner, { run: async () => ({ ok: true }) }), { status: 400 });
});

test('clients from the old private-copy feature get no access', () => {
  const policy = { browser: true, invite: true, roots: ['/tmp/shared/project'], terminalIds: [], screen: 'off' };
  const client = { id: 'muse', kind: 'agent', scopes: ['files:read'], policy };
  const config = { roots: ['/tmp/shared'] };
  assert.deepEqual(applyAgentPolicy(client, config).agentRoots, ['/tmp/shared/project']);
  assert.equal(applyAgentPolicy({ ...client, browserWorkspaceId: 'old-copy' }, config), null);
});

test('no copy-feature modules or routes remain', () => {
  for (const file of ['browser-workspaces.mjs', 'browser-workspace-routes.mjs', 'browser-workspace-paths.mjs'])
    assert.equal(fs.existsSync(new URL(`../server/${file}`, import.meta.url)), false, file);
  const ui = fs.readFileSync(new URL('../src/BrowserAgents.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /api\/agents\/workspaces|Apply reviewed changes|Stop & review/);
});
