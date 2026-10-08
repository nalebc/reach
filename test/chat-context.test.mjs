import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeTranscript } from '../server/agent-sessions/claude-transcript.mjs';
const user = (uuid, parentUuid) => ({ type: 'user', uuid, parentUuid, message: { role: 'user', content: 'synthetic' } });
const reply = (uuid, parentUuid, used, model = 'claude-opus-5-5') => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', model, content: [{ type: 'text', text: 'synthetic' }], usage: { input_tokens: used, output_tokens: 0 } } });
const add = (transcript, ...entries) => transcript.add(entries.map(JSON.stringify).join('\n') + '\n');

test('Claude never infers context capacity from crossing a token threshold', () => {
  const t = createClaudeTranscript();
  add(t, user('u1', null), reply('a1', 'u1', 199999));
  assert.deepEqual(t.view().context, { used: 199999, window: null });
  add(t, user('u2', 'a1'), reply('a2', 'u2', 200001));
  assert.deepEqual(t.view().context, { used: 200001, window: null });
  add(t, user('u3', 'a2'), reply('a3', 'u3', 200002, 'claude-opus-5-5[1m]'));
  assert.deepEqual(t.view().context, { used: 200002, window: 1000000 });
});

test('context usage follows the selected conversation ancestry across branches and rewind', () => {
  const t = createClaudeTranscript();
  add(t, user('u1', null), reply('a1', 'u1', 1200), user('u2', 'a1'), reply('a2', 'u2', 5000, 'claude-opus-5-5[1m]'));
  assert.deepEqual(t.view({ from: 'a1' }).context, { used: 1200, window: null });
  assert.equal(t.view({ from: 'u1' }).context, undefined);
  add(t, user('u3', 'a1'));
  assert.deepEqual(t.view().context, { used: 1200, window: null }, 'an abandoned branch does not supply current usage');
  add(t, { ...reply('subagent', null, 900000), isSidechain: true });
  assert.deepEqual(t.view().context, { used: 1200, window: null });
});
