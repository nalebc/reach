import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeNotification, notificationPush, createNotificationActions } from '../server/notification-items.mjs';
import { createNotifications, readAttention, createOutcomeJournal, isOutcomeTask } from '../server/notifications.mjs';

// Synthetic workflow state only; no agent, private evidence or external push service.
const workflow = (phase = 'ready', version = 12) => ({ id: 'wf-outcome', title: 'PRIVATE GOAL', problem: 'PRIVATE ERROR',
  tasks: [{ summary: 'PRIVATE LOG', chat: { agent: 'codex', id: 'task-chat' } }],
  outcome: { phase, version, acceptance: { status: 'not_accepted', eligible: phase === 'ready' } } });
const sources = extra => ({ agentSessions: { list: async () => ({ sessions: [], errors: {} }) },
  openClaw: { overview: async () => ({ connected: false }) }, handoffs: () => [], browserRequests: () => [], admissions: () => [], accessRequests: () => [], ...extra });

test('outcome alerts disclose no goal, logs or decisions and always open the current workflow result', async () => {
  for (const phase of ['ready', 'needs_owner', 'uncertain', 'cancelling', 'unavailable']) {
    const item = outcomeNotification(workflow(phase));
    const pushed = notificationPush(item);
    assert.doesNotMatch(JSON.stringify({ item, pushed }), /PRIVATE|task-chat|resultDigest|accept-result/);
    assert.equal(pushed.url, '/?page=sessions&workflow=wf-outcome');
    assert.deepEqual(pushed.actions, [{ action: 'open', title: 'Review outcome' }]);
    assert.deepEqual(item.actions, []);
  }
  for (const phase of ['draft', 'running', 'accepted', 'cancelled', 'changes_requested']) assert.equal(outcomeNotification(workflow(phase)), null);
  const result = await readAttention(sources({ workflows: () => [workflow()] }));
  assert.equal(result.items[0].id, 'outcome:wf-outcome');
  let decisions = 0;
  const act = createNotificationActions({ read: async () => result, run: () => decisions++ });
  await assert.rejects(act(result.items[0].id, { revision: result.items[0].revision, action: 'accept' }, () => {}), /Review this request/);
  assert.equal(decisions, 0);
});

test('existing notification deduplication drops settled outcomes, retains failed scans and announces changed revisions once', async () => {
  let current = workflow(), failed = false;
  const sent = [];
  const center = createNotifications({ file: null, enabled: () => true,
    read: () => readAttention(sources({ workflows: () => { if (failed) throw Error('Unavailable'); return [current]; } })),
    notify: async m => { sent.push(m); return { sent: 1 }; } });
  try {
    await Promise.all([center.refresh(), center.refresh()]);
    assert.equal(sent.length, 1);
    failed = true;
    assert.ok((await center.refresh({ fresh: true })).unavailable.includes('outcome'));
    failed = false;
    await center.refresh({ fresh: true });
    assert.equal(sent.length, 1);
    current = workflow('needs_owner', 13);
    await center.refresh({ fresh: true });
    await center.refresh({ fresh: true });
    assert.equal(sent.length, 2);
    current = workflow('accepted', 14);
    assert.deepEqual((await center.refresh({ fresh: true })).items, []);
  } finally { center.close(); }
});

test('outcome transitions reuse the private journal; task completion pushes never read outcome transcripts', async () => {
  let current = workflow('running', 1);
  const events = [];
  const change = createOutcomeJournal({ list: () => [current], journal: { add: e => events.push(e) }, now: () => 100 });
  change();
  assert.equal(events.length, 0);
  for (const phase of ['ready', 'needs_owner', 'accepted', 'cancelled']) {
    current = workflow(phase, current.outcome.version + 1); change(); change();
  }
  assert.deepEqual(events.map(e => e.kind), ['outcome-ready', 'outcome-needs_owner', 'outcome-accepted', 'outcome-cancelled']);
  assert.deepEqual(events[0].target, { page: 'sessions', workflow: current.id });
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|task-chat/);
  const { createDoneWatch } = await import('../server/agent-sessions/done-watch.mjs');
  let status = 'running', reads = 0;
  const watcher = createDoneWatch({ list: async () => ({ sessions: [{ agent: 'codex', id: 'task-chat', status }] }),
    watching: (agent, id) => isOutcomeTask([current], agent, id),
    reply: async () => { reads++; return 'PRIVATE'; }, notify: () => assert.fail('No transcript notification'),
  });
  try { await watcher.look(); status = 'idle'; await watcher.look(); assert.equal(reads, 0); }
  finally { watcher.stop(); }
  assert.equal(isOutcomeTask([current], 'claude', 'task-chat'), false);
  assert.equal(isOutcomeTask([{ ...current, outcome: undefined }], 'codex', 'task-chat'), false);
});


test('outcome task approvals retain authenticated detail while push copy stays private, including unbound starts', async () => {
  const w = workflow('running');
  const session = { agent: 'codex', id: 'task-chat', title: 'PRIVATE GOAL', status: 'waiting', prompts: [{ id: 'approval', kind: 'command', command: 'PRIVATE COMMAND' }] };
  const { items } = await readAttention(sources({ workflows: () => [w], agentSessions: { list: async () => ({ sessions: [session], errors: {} }) } }));
  assert.equal(items.length, 1);
  assert.match(JSON.stringify(items[0]), /PRIVATE COMMAND/);
  const push = notificationPush(items[0]);
  assert.doesNotMatch(JSON.stringify(push), /PRIVATE/);
  assert.equal(push.url, '/?page=sessions&agent=codex&id=task-chat&prompt=approval');
  assert.deepEqual(push.actions, [{ action: 'open', title: 'Review task request' }]);
  const unbound = { ...w, tasks: [{ agent: 'codex', state: 'starting' }] };
  assert.equal(isOutcomeTask([unbound], 'codex', 'not-yet-bound'), true);
  assert.equal(isOutcomeTask([unbound], 'claude', 'another-chat'), false);
});
