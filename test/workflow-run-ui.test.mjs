import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDom, settle } from './dom/harness.mjs';
import { workflowRunFixture, workflowTaskResultFixture, retainedReply } from './helpers/workflow-run-fixture.mjs';

const peer = { id: 'computer', name: 'Computer', url: 'https://reach.test', token: 'fixture', platform: 'darwin' };
const base = '/api/sessions/workflows/wf-run';
let dom, WorkflowSheet, WorkflowRunSummary, view, workflow, readFailure, resultFailure, results, reads, opened, delayedAttempt;
before(async () => {
  dom = await startDom({ routes: {
    '/api/sessions/workflows/outcome-capabilities': () => ({ executionAvailable: false, reason: 'Synthetic runner unavailable.' }),
    [base]: () => { reads++; return readFailure ? new Response(JSON.stringify({ error: 'Synthetic refresh failure' }), { status: 503 }) : { ...workflow, version: String(workflow.updatedAt) }; },
    [`${base}/tasks/build/result`]: (_init, url) => resultFor('build', url),
    [`${base}/tasks/review/result`]: (_init, url) => resultFor('review', url),
  } });
  ({ WorkflowSheet } = await dom.load('/src/Workflows.tsx'));
  ({ WorkflowRunSummary } = await dom.load('/src/WorkflowRunSummary.tsx'));
});
after(() => dom?.close());
afterEach(async () => { await view?.unmount(); view = undefined; });
const body = () => dom.document.body.textContent;
const button = words => [...dom.document.querySelectorAll('button')].find(node => node.textContent.includes(words) || node.getAttribute('aria-label')?.includes(words));
function resultFor(task, url) {
  results.push({ task, attempt: url.searchParams.get('attempt') });
  if (resultFailure) return new Response(JSON.stringify({ error: 'Synthetic result unavailable' }), { status: 503 });
  if (delayedAttempt && task === 'review' && url.searchParams.get('attempt') === '1') return delayedAttempt;
  return workflowTaskResultFixture(task, Number(url.searchParams.get('attempt') || (task === 'review' ? 2 : 1)));
}
async function open(state = 'done') {
  workflow = workflowRunFixture(state); readFailure = false; resultFailure = false; results = []; reads = 0; opened = []; delayedAttempt = null;
  view = await dom.render(dom.React.createElement(WorkflowSheet, { peer, id: workflow.id, initial: workflow, logos: {}, onClose() {}, onOpenChat: chat => opened.push(chat.id) }));
}

test('completed ordinary workflow opens the retained final reply inside the workflow, beyond its short summary', async () => {
  await open();
  await dom.waitFor(() => body().includes('final paragraph is retained'));
  assert.match(body(), /Run completed/);
  assert.match(body(), /3 of 3 tasks finished/);
  assert.match(body(), /2 completed/i);
  assert.match(body(), /1 skipped/i);
  assert.ok(body().includes(retainedReply.split('\n\n')[1]));
  assert.equal(dom.document.querySelector('script'), null);
  assert.equal(dom.window.workflowInjected, undefined);
  assert.equal(results[0].task, 'review');
  button('Open chat').click();
  await settle();
  assert.deepEqual(opened, ['review-chat']);
});

test('overall progress identifies parallel current work and keeps skipped and unused branches distinct', async () => {
  const selected = [];
  const w = workflowRunFixture('running');
  w.tasks.splice(2, 0, { id: 'second-review', title: 'Check appearance', agent: 'codex', kind: 'review', together: true, state: 'working' });
  w.tasks.push({ id: 'unused', title: 'Unused repair', agent: 'codex', kind: 'build', together: false, state: 'skipped', selection: 'not_selected' });
  view = await dom.render(dom.React.createElement(WorkflowRunSummary, { workflow: w, onSelect: id => selected.push(id) }));
  assert.match(body(), /Workflow running/);
  assert.match(body(), /1 of 4 tasks finished/);
  assert.match(body(), /2 running/i);
  assert.match(body(), /1 waiting/i);
  button('Review calculation').click(); button('Check appearance').click();
  await settle();
  assert.equal(selected.length, 2);
});

test('task details retain file names, escaped command output and an earlier attempt', async () => {
  await open();
  await dom.waitFor(() => body().includes('final paragraph is retained'));
  const select = dom.document.querySelector('select');
  assert.ok(select, 'retained attempts have a selector');
  select.value = '1'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await dom.waitFor(() => body().includes('earlier review requested'));
  assert.ok(results.some(r => r.task === 'review' && r.attempt === '1'));
  dom.document.querySelector('button[aria-label^="Task 1:"]').click();
  await dom.waitFor(() => results.some(r => r.task === 'build'));
  assert.match(body(), /src\/total\.mjs/);
  const details = [...dom.document.querySelectorAll('details')].find(node => /recorded|commands|evidence/i.test(node.querySelector('summary')?.textContent || ''));
  assert.ok(details, 'recorded commands are explicitly expandable');
  details.open = true; details.dispatchEvent(new dom.window.Event('toggle'));
  await dom.waitFor(() => body().includes('node synthetic-check.mjs'));
  assert.match(body(), /Synthetic arithmetic check passed/);
  assert.equal(dom.document.querySelector('img'), null);
});

test('refresh failures are visible with the retained run and manual refresh recovers without leaving the workflow', async () => {
  await open('running');
  readFailure = true;
  button('Refresh workflow').click();
  await dom.waitFor(() => body().includes('Synthetic refresh failure'));
  assert.match(body(), /Workflow running/);
  readFailure = false; workflow = workflowRunFixture('done'); workflow.updatedAt++;
  button('Refresh workflow').click();
  await dom.waitFor(() => body().includes('Run completed'));
  assert.equal(body().includes('Synthetic refresh failure'), false);
  assert.ok(reads >= 3);
});

test('missing retained result shows the available short reply and a retry rather than an empty completed task', async () => {
  await open();
  await dom.waitFor(() => body().includes('final paragraph is retained'));
  resultFailure = true;
  dom.document.querySelector('button[aria-label^="Task 1:"]').click();
  await dom.waitFor(() => body().includes('retained result could not be loaded'));
  assert.match(body(), /seeded total is repaired/);
  assert.match(body(), /preview|summary|retained/i);
  resultFailure = false;
  button('Retry').click();
  await dom.waitFor(() => body().includes('final paragraph is retained'));
});

test('an open task result survives progress updates and a completed reply never becomes an independent check claim', async () => {
  await open('running');
  dom.document.querySelector('button[aria-label^="Task 1:"]').click();
  await dom.waitFor(() => body().includes('final paragraph is retained'));
  workflow = workflowRunFixture('done'); workflow.updatedAt++;
  button('Refresh workflow').click();
  await dom.waitFor(() => body().includes('Run completed'));
  assert.equal(dom.document.querySelector('.wf-item.open button.wf-item-main').getAttribute('aria-label').startsWith('Task 1:'), true);
  assert.match(body(), /agent|provider/i);
  assert.equal(body().includes('Checks passed'), false);
});

test('visible workflow refreshes its overall progress automatically without a manual tap', async () => {
  await open('running');
  assert.match(body(), /1 of 3 tasks finished/);
  workflow = workflowRunFixture('done'); workflow.updatedAt++;
  await dom.waitFor(() => body().includes('Run completed'), 6000);
  assert.match(body(), /3 of 3 tasks finished/);
  assert.ok(reads >= 2);
});

test('a delayed earlier-attempt response cannot replace the latest result the owner selected', async () => {
  await open();
  await dom.waitFor(() => body().includes('final paragraph is retained'));
  let finish;
  delayedAttempt = new Promise(resolve => { finish = resolve; });
  const select = dom.document.querySelector('select');
  select.value = '1'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await dom.waitFor(() => results.some(result => result.attempt === '1'));
  select.value = ''; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await dom.waitFor(() => body().includes('final paragraph is retained'));
  finish(workflowTaskResultFixture('review', 1));
  await settle();
  assert.equal(body().includes('earlier review requested'), false);
  assert.match(body(), /final paragraph is retained/);
});
