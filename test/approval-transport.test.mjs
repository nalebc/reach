import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createCodexDaemon } from '../server/agent-sessions/codex-daemon.mjs';
import { createCodexLive } from '../server/agent-sessions/codex-live.mjs';

const ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('Expected approval state did not arrive');
};

test('a real transport request waits for the phone, receives its exact answer, and cannot be answered after disconnection', { skip: process.platform === 'win32', timeout: 10000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-answer-'));
  const socketPath = path.join(dir, 's');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let peer;
  const answers = [];
  wss.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.method && message.id != null) socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.id != null) answers.push(message);
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const daemon = createCodexDaemon({ locate: async () => '/fake/codex', run: async () => ({ stdout: JSON.stringify({ socketPath }) }) });
  t.after(async () => {
    daemon.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(r => wss.close(r));
    await new Promise(r => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const live = createCodexLive({ daemon });
  await daemon.rpc('test/ping');
  peer.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: ID, command: 'echo synthetic-test', availableDecisions: ['accept', 'decline'] } }));
  await until(() => live.view(ID).prompts.length === 1);
  assert.deepEqual(answers, [], 'nothing executes or gets answered without the user decision');
  assert.deepEqual(await live.respond(ID, 'approval-1', { decision: 'decline' }), { answered: true });
  await until(() => answers.length === 1);
  assert.deepEqual(answers, [{ id: 'approval-1', result: { decision: 'decline' } }]);
  assert.deepEqual(live.view(ID).prompts, []);
  await assert.rejects(live.respond(ID, 'approval-1', { decision: 'accept' }), e => e.status === 409);
  peer.send(JSON.stringify({ id: 'approval-2', method: 'item/tool/requestUserInput', params: { threadId: ID, questions: [{ id: 'q', question: 'Which test?', options: [{ label: 'Unit' }] }] } }));
  await until(() => live.view(ID).prompts.length === 1);
  // Retain the transport responder to exercise the previous silent no-op too.
  let reply;
  daemon.onRequest((_message, resolve) => { reply = resolve; });
  peer.send(JSON.stringify({ id: 'transport-check', method: 'test/request', params: {} }));
  await until(() => !!reply);
  peer.terminate();
  await until(() => live.view(ID).prompts.length === 0);
  await assert.rejects(live.respond(ID, 'approval-2', { answers: { q: ['Unit'] } }), e => e.status === 409);
  await assert.rejects(reply({ decision: 'accept' }), /not sent/);
  assert.equal(answers.length, 1, 'no disconnected answer was reported as delivered');
});
