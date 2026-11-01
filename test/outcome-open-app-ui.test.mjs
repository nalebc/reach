import test from 'node:test';
import assert from 'node:assert/strict';
import { startDom, settle } from './dom/harness.mjs';
import { outcomeWorkflowFixture, outcomeResultFixture } from './helpers/outcome-ui-fixture.mjs';

// Full App routing with synthetic authenticated responses. No real network,
// computer screen, OS push service or physical phone is used.
test('cold links, the existing bell and warm push taps open the current outcome in App without submitting a decision', async () => {
  const peer = { id: 'computer', name: 'Computer', url: 'https://reach.test', token: 'synthetic', platform: 'darwin' };
  let result = outcomeResultFixture();
  const workflow = outcomeWorkflowFixture(), writes = [];
  const base = '/api/sessions/workflows/wf-outcome';
  const dom = await startDom({ url: 'https://reach.test/?page=sessions&workflow=wf-outcome', routes: {
    '/api/device': () => ({ id: peer.id, name: peer.name, platform: 'darwin', roots: [], memory: { total: 1, free: 1 }, network: { connected: true, peers: [] }, capabilities: { screenSupported: false } }),
    '/api/terminals': () => [], '/api/chats': () => [], '/api/handoffs': () => [],
    '/api/codex': () => ({ sessions: [] }),
    '/api/terminals/desktop': () => ({ sessions: [] }), '/api/terminals/agents': () => ({ agents: [] }),
    '/api/activity': () => ({ activities: [] }),
    '/api/sessions': () => ({ sessions: [], workflows: [workflow], errors: {} }),
    '/api/sessions/health': () => ({ agents: [{ agent: 'codex', installed: true, signedIn: true }] }),
    '/api/sessions/logos': () => ({ version: '1', logos: {} }),
    '/api/notifications': () => ({ items: [{ id: 'outcome:wf-outcome', source: 'outcome', sender: 'Reach', kind: 'outcome', title: 'Outcome ready for your review', actions: [], target: { page: 'sessions', workflow: workflow.id } }], unavailable: [] }),
    [base]: () => workflow,
    [base + '/outcome']: init => { if (init.method === 'POST') writes.push(init.body); return { outcome: result }; },
  } });
  const socket = globalThis.WebSocket;
  globalThis.WebSocket = class { close() {} send() {} };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const worker = new dom.window.EventTarget();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
  let view;
  const button = text => [...dom.document.querySelectorAll('button')].find(b => b.textContent.includes(text));
  try {
    localStorage.setItem('reach.devices', JSON.stringify([peer]));
    localStorage.setItem('reach.active', peer.id);
    const { default: App } = await dom.load('/src/App.tsx');
    view = await dom.render(dom.React.createElement(App));
    await dom.waitFor(() => dom.document.querySelector('.wf-outcome'));
    assert.match(dom.document.querySelector('.wf-outcome').textContent, /Result revision 1/);
    assert.equal(dom.window.location.search, '');
    dom.document.querySelector('[aria-label="Close synthetic outcome"]').click(); await settle();
    result = { ...result, version: 21, resultRevision: 2 };
    dom.document.querySelector('.notification-bell').click();
    await dom.waitFor(() => button('Review outcome'));
    button('Review outcome').click();
    await dom.waitFor(() => dom.document.querySelector('.wf-outcome')?.textContent.includes('Result revision 2'));
    result = { ...result, version: 22, resultRevision: 3 };
    worker.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'reach-open', url: '/?page=sessions&workflow=wf-outcome' } }));
    await dom.waitFor(() => dom.document.querySelector('.wf-outcome')?.textContent.includes('Result revision 3'), 2000);
    assert.equal(button('Accept result').disabled, true, 'the changed result requires another inspection');
    assert.deepEqual(writes, []);
    assert.deepEqual(dom.errors, []);
  } finally {
    await view?.unmount();
    globalThis.WebSocket = socket;
    await dom.close();
  }
});
