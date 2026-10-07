import test from 'node:test';
import assert from 'node:assert/strict';
import { browserPrivatePaths, isBrowserPrivatePath } from '../server/browser-private-paths.mjs';

test('broad shares exclude enforcement source, state, owner profiles and credentials', () => {
  const paths = browserPrivatePaths({ dataDir: '/workspace/state', agentPolicyFile: '/workspace/policy.json', privatePaths: ['/workspace/secret'] },
    { home: '/owner', appRoot: '/workspace/reach' });
  for (const file of ['/workspace/reach/server/index.mjs', '/workspace/state/clients.json', '/workspace/policy.json',
    '/workspace/secret/token', '/owner/Library/Application Support/Google/Chrome/Default/Cookies',
    '/owner/.ssh/id_ed25519', '/some/share/.aws/credentials', '/some/share/.CODEX/auth.json', '/Library/Keychains/keychain'])
    assert.equal(isBrowserPrivatePath(file, paths), true, file);
  for (const file of ['/owner/Desktop/task.txt', '/workspace/reach-project/readme.md', '/workspace/secrets-example'])
    assert.equal(isBrowserPrivatePath(file, paths), false, file);
});
