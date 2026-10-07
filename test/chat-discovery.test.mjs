import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAgents } from '../server/agent-sessions/index.mjs';

test('optional discovery distinguishes installed apps and CLIs from missing ones', async () => {
  const calls = [];
  const list = await detectAgents({
    platform: 'darwin', env: { SHELL: '/bin/zsh' }, home: '/synthetic',
    exists: file => file === '/Applications/Cursor.app',
    run: async (bin, args) => { calls.push([bin, args]); return { stdout: args.at(-1) === 'command -v openclaw' ? '/bin/openclaw' : '' }; },
  });
  assert.equal(list.find(a => a.agent === 'openclaw').installed, true);
  assert.equal(list.find(a => a.agent === 'openclaw').supported, true);
  assert.equal(list.find(a => a.agent === 'cursor').installed, true);
  assert.equal(list.find(a => a.agent === 'gemini').installed, false);
  assert.ok(!calls.some(([, args]) => args.at(-1).includes('cursor-agent')));
});

test('OpenClaw config discovers its Gateway without probing private sessions', async () => {
  let calls = 0;
  const list = await detectAgents({
    known: [{ agent: 'openclaw', name: 'OpenClaw', cli: 'openclaw', supported: true }],
    env: { OPENCLAW_CONFIG_PATH: '/custom/openclaw.json' },
    exists: file => file === '/custom/openclaw.json',
    run: async () => { calls++; throw Error('should not run'); },
  });
  assert.equal(list[0].installed, true); assert.equal(calls, 0);
});

test('Windows discovery uses its executable locator and never launches a Unix shell', async () => {
  const calls = [];
  const list = await detectAgents({
    known: [{ agent: 'openclaw', name: 'OpenClaw', cli: 'openclaw', supported: true }],
    platform: 'win32', env: {}, home: 'C:/Users/test', exists: () => false,
    run: async (bin, args) => { calls.push([bin, args]); return { stdout: 'C:\\bin\\openclaw.cmd' }; },
  });
  assert.deepEqual(calls, [['where.exe', ['openclaw']]]); assert.equal(list[0].installed, true);
});

test('a missing Codex binary prompts installation; a failed connection prompts retry', async () => {
  const { createAgentSessions } = await import('../server/agent-sessions/index.mjs');
  let reason = Object.assign(Error('Codex is not installed on this computer.'), { code: 'AGENT_NOT_INSTALLED' });
  let fresh;
  const adapter = createAgentSessions({
    codex: { health: async () => { throw reason; } },
    claude: { health: async () => ({ agent: 'claude', installed: false, signedIn: false }) },
    claudeApp: async () => ({ installed: false, signedIn: false }),
    detect: async (options) => { fresh = options.fresh; return []; },
  });
  try {
    const missing = (await adapter.health({ fresh: true }))[0];
    assert.equal(missing.installed, false); assert.equal(missing.error, undefined); assert.equal(fresh, true);
    reason = Error('App connection timed out');
    assert.equal((await adapter.health())[0].error, 'App connection timed out');
  } finally { adapter.close(); }
});
