import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeCompose, typeIntoClaude } from '../server/agent-sessions/claude-compose.mjs';
import { createClaudeImports, createClaudeRefresh } from '../server/agent-sessions/claude-import.mjs';
import { createDesktopAutomation } from '../server/desktop-automation.mjs';

const A = '11111111-2222-4333-8444-555555555555';
const B = '22222222-2222-4333-8444-555555555555';
const C = '33333333-2222-4333-8444-555555555555';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const busy = () => Object.assign(new Error('The desktop is in use.'), { waiting: true, status: 409, kind: 'busy' });
// Real arbitration state with synthetic foreground/control observations.
function coordinator() {
  let blocked = false, generation = 0;
  const automation = createDesktopAutomation({ blocked: () => blocked });
  automation.noteForeground('com.apple.Safari');
  return {
    ...automation,
    setBlocked(value) { blocked = value; if (value) automation.interrupt(); },
    changeForeground() { automation.noteForeground(`test.foreground.${++generation}`); },
  };
}
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-claude-ui-'));
  const ui = { session: `local_${B}`, idle: 600, front: false, calls: [], ...extra };
  const shared = {
    idle: async () => ui.idle,
    shown: () => [ui.session, `local_${A}`].map((session, i) => ({ id: session.slice(6), session, at: 3000 - i })),
    open: async (url, options) => { ui.calls.push(['open', url, options]); ui.session = url.includes('resume?') ? `local_${url.split('session=')[1]}` : url.split('session=')[1]; },
    appRunning: async () => true, startedAt: async () => 1000,
    frontmost: async () => ui.front, desktopAutomation: extra.desktopAutomation,
    resume: false, everyMs: 60000, settleMs: 1,
  };
  const importOptions = { ...shared, file: path.join(dir, 'imports.json'), imported: () => false, write: null };
  const refreshOptions = { ...shared, file: path.join(dir, 'refresh.json'), asking: async () => false,
    reload: async () => { ui.calls.push(['reload']); ui.session = `local_${A}`; } };
  const composeOptions = { ...shared, onScreen: async () => ui.session, arrived: async () => true,
    type: async () => { ui.calls.push(['type']); return { sent: true }; }, confirmMs: 20 };
  const imports = createClaudeImports(importOptions), refresh = createClaudeRefresh(refreshOptions);
  const compose = createClaudeCompose(composeOptions);
  t.after(() => { imports.close(); refresh.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ui, imports, refresh, compose, importOptions, refreshOptions, composeOptions };
}

test('refresh restores its own reloaded session in the background', async t => {
  const { refresh, ui } = fixture(t);
  await refresh.add(A);
  assert.deepEqual(ui.calls, [['reload'], ['open', `claude://code/continue?session=local_${B}`, { background: true }]]);
});

test('unknown idle never authorizes automatic import, refresh or a compose chat switch', async t => {
  const { imports, refresh, compose, ui } = fixture(t, { idle: null });
  await imports.add(A); await refresh.add(A);
  await assert.rejects(compose.deliver(A, { title: 'Synthetic', text: 'marker' }), e => e.waiting);
  assert.deepEqual(ui.calls, []);
  assert.deepEqual(imports.pending(), [A]); assert.deepEqual(refresh.pending(), [A]);
});

test('live desktop control defers all Claude UI paths before dispatch without consuming pending work', async t => {
  const arbiter = coordinator(); arbiter.setBlocked(true);
  const { imports, refresh, compose, ui } = fixture(t, { desktopAutomation: arbiter });
  await imports.add(A); await refresh.add(A);
  await assert.rejects(compose.deliver(A, { title: 'Synthetic', text: 'marker' }), e => e.waiting && e.kind === 'busy');
  assert.deepEqual(ui.calls, []);
  assert.deepEqual(imports.pending(), [A]); assert.deepEqual(refresh.pending(), [A]);
  arbiter.setBlocked(false);
  await imports.check();
  assert.deepEqual(imports.pending(), []);
});

test('a third chat selected during compose is not replaced by the stale restore', async t => {
  const { composeOptions, ui } = fixture(t);
  const compose = createClaudeCompose({ ...composeOptions, type: async () => { ui.session = `local_${C}`; return { sent: true }; } });
  assert.deepEqual(await compose.deliver(A, { title: 'Synthetic', text: 'marker' }), { delivered: true });
  assert.equal(ui.session, `local_${C}`);
  assert.equal(ui.calls.length, 1, 'only the initial target switch');
});

test('foreground/control change after a successful send suppresses restoration without retrying the message', async t => {
  const arbiter = coordinator();
  const { composeOptions, ui } = fixture(t, { desktopAutomation: arbiter });
  const compose = createClaudeCompose({ ...composeOptions, type: async () => { arbiter.changeForeground(); return { sent: true }; } });
  assert.deepEqual(await compose.deliver(A, { title: 'Synthetic', text: 'marker' }), { delivered: true });
  assert.equal(ui.calls.length, 1);
});

for (const reason of ['session', 'foreground']) test(`import delayed restoration preserves a newer ${reason}`, async t => {
  const arbiter = coordinator();
  const { importOptions, ui } = fixture(t, { desktopAutomation: arbiter });
  const imports = createClaudeImports({ ...importOptions, wait: async () => {
    if (reason === 'session') ui.session = `local_${C}`; else arbiter.changeForeground();
  } });
  t.after(() => imports.close());
  await imports.add(A);
  assert.equal(ui.calls.length, 1, 'only import, no stale restoration');
  assert.deepEqual(imports.pending(), [], 'the dispatched import is not replayed');
});

for (const reason of ['session', 'foreground']) test(`refresh delayed restoration preserves a newer ${reason}`, async t => {
  const arbiter = coordinator();
  const { refreshOptions, ui } = fixture(t, { desktopAutomation: arbiter });
  const refresh = createClaudeRefresh({ ...refreshOptions, wait: async () => {
    if (reason === 'session') ui.session = `local_${C}`; else arbiter.changeForeground();
  } });
  t.after(() => refresh.close());
  await refresh.add(A);
  assert.deepEqual(ui.calls, [['reload']]);
  assert.deepEqual(refresh.pending(), []);
});

test('a compose transaction keeps imports and refresh from interleaving with its native action', async t => {
  const arbiter = coordinator(), entered = deferred(), release = deferred();
  const { composeOptions, ui, imports, refresh } = fixture(t, { desktopAutomation: arbiter });
  const compose = createClaudeCompose({ ...composeOptions, type: async () => { entered.resolve(); await release.promise; return { sent: true }; } });
  const sent = compose.deliver(A, { title: 'Synthetic', text: 'marker' });
  await entered.promise;
  try {
    await imports.add(C); await refresh.add(A);
    assert.equal(ui.calls.length, 1);
    assert.deepEqual(imports.pending(), [C]); assert.deepEqual(refresh.pending(), [A]);
  } finally { release.resolve(); }
  await sent;
  assert.equal(ui.calls.length, 2, 'target then owned restoration only');
});

test('coordinator loss before native dispatch is retryable; uncertain native delivery stays uncertain', async t => {
  const arbiter = coordinator();
  const { composeOptions, ui } = fixture(t, { desktopAutomation: arbiter });
  const compose = createClaudeCompose({ ...composeOptions, open: async (...args) => { await composeOptions.open(...args); arbiter.changeForeground(); } });
  await assert.rejects(compose.deliver(A, { title: 'Synthetic', text: 'marker' }), e => e.waiting);
  assert.equal(ui.calls.some(c => c[0] === 'type'), false);
  const uncertain = Object.assign(new Error('Delivery unknown'), { retryable: false, uncertain: true });
  const next = createClaudeCompose({ ...composeOptions, type: async () => { throw uncertain; } });
  await assert.rejects(next.deliver(A, { title: 'Synthetic', text: 'marker' }), e => e === uncertain);
});


test('native helper preparation rechecks the coordinator before spawning', async () => {
  const prepared = deferred();
  let allowed = true, calls = 0;
  const sent = typeIntoClaude({ title: 'Synthetic', session: `local_${A}`, text: 'marker' }, {
    binary: () => prepared.promise,
    beforeDispatch: () => { if (!allowed) throw busy(); },
    run: async () => { calls++; return { stdout: '{"sent":true}' }; },
  });
  allowed = false; prepared.resolve('/inert/helper');
  await assert.rejects(sent, e => e.waiting && e.notDispatched);
  assert.equal(calls, 0);
});

// (Effort is no longer picked in the Claude app's menu: nothing outside the
// app changes its process's level, Oct 10; claude-compose.mjs has no effort.)
for (const method of ['draft', 'stop', 'model']) test(`${method} waits for desktop control before native mutation`, async t => {
  const arbiter = coordinator(); arbiter.setBlocked(true);
  const { compose, ui } = fixture(t, { desktopAutomation: arbiter });
  await assert.rejects(compose[method](B, { title: 'Synthetic', text: 'draft', owner: 'owner', mode: 'manual', model: 'Sonnet 5.5', effort: 'high' }), e => e.waiting);
  assert.deepEqual(ui.calls, []);
});

for (const outcome of ['sent', 'uncertain']) test(`actual outbox preserves ${outcome} after an interrupted native attempt`, async t => {
  const { createAgentSessions } = await import('../server/agent-sessions/index.mjs');
  const { createOutbox } = await import('../server/agent-sessions/outbox.mjs');
  const arbiter = coordinator(); arbiter.setBlocked(true);
  const { composeOptions, ui } = fixture(t, { desktopAutomation: arbiter });
  let nativeCalls = 0, transcriptCalls = 0;
  const compose = createClaudeCompose({ ...composeOptions,
    type: async () => {
      nativeCalls++;
      if (outcome === 'uncertain') throw Object.assign(new Error('Synthetic delivery unknown'), { uncertain: true, retryable: false });
      return { sent: true };
    },
    arrived: async () => { transcriptCalls++; arbiter.setBlocked(true); return true; },
  });
  const outbox = createOutbox();
  outbox.add(A, { text: 'synthetic marker', via: 'app', title: 'Synthetic' });
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} }, codex: {}, codexLive: { drives: () => false },
    claude: {}, claudeHost: { onRelease() {} }, signIn: {}, claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} }, outbox, typeIntoApp: true, claudeCompose: compose, appRetryMs: 5, queueMs: 5,
  });
  t.after(() => sessions.close());
  const waitFor = async (predicate) => {
    for (const end = Date.now() + 1000; !predicate() && Date.now() < end;) await new Promise(r => setTimeout(r, 5));
    assert.ok(predicate());
  };
  await waitFor(() => !!outbox.list(A)[0]?.error);
  assert.equal(nativeCalls, 0); assert.equal(outbox.list(A).length, 1);
  assert.notEqual(outbox.list(A)[0].delivery, 'paused', 'pre-dispatch busy is still pending');
  arbiter.setBlocked(false); sessions.frontmost('com.apple.Safari');
  await waitFor(() => outcome === 'sent' ? outbox.list(A).length === 0 : outbox.list(A)[0]?.delivery === 'paused');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(nativeCalls, 1, 'no automatic replay after a dispatched attempt');
  assert.equal(transcriptCalls, outcome === 'sent' ? 1 : 0);
});


test('an unstarted draft helper does not record a possibly written draft', async t => {
  const arbiter = coordinator();
  const { composeOptions } = fixture(t, { desktopAutomation: arbiter });
  let stored = {}, calls = 0;
  const compose = createClaudeCompose({ ...composeOptions,
    store: { load: () => stored, save: value => { stored = value; } },
    type: (message, guard) => typeIntoClaude(message, {
      binary: async () => { arbiter.changeForeground(); return '/inert/helper'; },
      beforeDispatch: guard,
      run: async () => { calls++; return { stdout: '{"drafted":true}' }; },
    }),
  });
  await assert.rejects(compose.draft(B, { title: 'Synthetic', text: 'draft', owner: 'owner' }), e => e.notDispatched);
  assert.equal(calls, 0); assert.deepEqual(stored, {});
});

for (const interrupted of [true, false]) test(`explicit app navigation ${interrupted ? 'waits after lost control' : 'acknowledges its intentional foreground change'}`, async t => {
  const { createAgentSessions } = await import('../server/agent-sessions/index.mjs');
  const arbiter = coordinator();
  let opened = 0, released = 0;
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} }, codex: {}, codexLive: { drives: () => false },
    claude: { read: async () => {
      if (interrupted) arbiter.changeForeground();
      return { session: { agent: 'claude', id: A, appSessionId: `local_${A}` } };
    } },
    claudeHost: { onRelease() {}, release: () => { released++; } }, signIn: {},
    claudeImports: { add: async () => {}, close() {} }, agentAsks: { close() {} }, desktopAutomation: arbiter,
    open: async () => { opened++; arbiter.changeForeground(); },
  });
  t.after(() => sessions.close());
  if (interrupted) await assert.rejects(sessions.openInApp('claude', A), e => e.waiting);
  else assert.deepEqual(await sessions.openInApp('claude', A), { opened: 'claude' });
  assert.equal(opened, interrupted ? 0 : 1); assert.equal(released, interrupted ? 0 : 1);
});

test('unknown foreground is not treated as permission to switch away from an active Claude chat', async t => {
  const { composeOptions, ui } = fixture(t, { idle: 0 });
  const compose = createClaudeCompose({ ...composeOptions, frontmost: async () => null });
  await assert.rejects(compose.deliver(A, { title: 'Synthetic', text: 'marker' }), e => e.waiting);
  assert.deepEqual(ui.calls, []);
});

test('mode travels through the hook and does not trigger native mode selection', async t => {
  const { composeOptions } = fixture(t);
  const typed = [];
  const compose = createClaudeCompose({ ...composeOptions, type: async call => {
    typed.push(call); return { sent: true };
  } });
  assert.deepEqual(await compose.deliver(A, { title: 'Synthetic', text: 'marker', mode: 'manual' }), { delivered: true });
  assert.equal(typed.length, 1);
  assert.equal(typed[0].text, 'marker');
  assert.equal(typed[0].mode, undefined);
});

test('a chat changed during compose idle inspection is not overwritten by the target switch', async t => {
  const { composeOptions, ui } = fixture(t);
  const compose = createClaudeCompose({ ...composeOptions, idle: async () => { ui.session = `local_${C}`; return 600; } });
  await assert.rejects(compose.deliver(A, { title: 'Synthetic', text: 'marker' }), e => e.waiting);
  assert.equal(ui.session, `local_${C}`); assert.deepEqual(ui.calls, []);
});

test('refresh captures the current source chat after awaited idle inspection', async t => {
  const { refreshOptions, ui } = fixture(t);
  const refresh = createClaudeRefresh({ ...refreshOptions, idle: async () => { ui.session = `local_${C}`; return 600; } });
  t.after(() => refresh.close());
  await refresh.add(A);
  assert.deepEqual(ui.calls, [['reload'], ['open', `claude://code/continue?session=local_${C}`, { background: true }]]);
});
