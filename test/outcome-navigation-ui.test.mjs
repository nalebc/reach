import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDom, settle, replaceText } from './dom/harness.mjs';
import { outcomeWorkflowFixture, outcomeResultFixture } from './helpers/outcome-ui-fixture.mjs';
const peer = { id: 'computer', name: 'Computer', url: 'https://reach.test', token: 'synthetic', platform: 'darwin' };
let dom, view, navigation, Home, Everything, WorkflowsPage, state, workflow, sent = [], draftSent = [];
let capabilities = { executionAvailable: true, reason: '' };
const base = '/api/sessions/workflows/wf-outcome';
const health = [{ agent: 'codex', installed: true, signedIn: true }, { agent: 'claude', installed: true, signedIn: true }];
const session = { agent: 'codex', id: 'build-chat', title: 'Builder', status: 'idle', cwd: '/work/fixture', archived: false, createdAt: 1, updatedAt: 1, preview: '' };
before(async () => {
  dom = await startDom({ routes: {
    '/api/sessions/workflows/outcome-capabilities': () => capabilities,
    '/api/sessions/workflows': init => {
      const body = JSON.parse(init.body); draftSent.push(body);
      workflow = { ...outcomeWorkflowFixture(), ...body, state: 'draft', outcome: undefined, tasks: body.tasks.map((t, i) => ({ ...t, id: `t${i}`, state: 'waiting' })) };
      return { workflow };
    },
    [base]: () => workflow,
    [base + '/outcome']: () => ({ outcome: state, capabilities }),
    [base + '/outcome/operations/missing']: () => ({ status: 'unknown' }),
    [base + '/outcome/accept']: init => {
      sent.push(JSON.parse(init.body));
      if (sent.length === 1) return new Response(JSON.stringify({ error: 'Result changed or already answered.' }), { status: 409 });
      state = { ...state, phase: 'accepted', acceptance: { eligible: false, status: 'accepted' } };
      return { outcome: state };
    },
    '/api/sessions/logos': () => ({ version: '1', logos: {} }),
    '/api/sessions/health': () => ({ agents: health }),
    '/api/sessions/models': () => ({ models: [], modes: [] }),
    '/api/sessions/openclaw/overview': () => ({ connected: true, sessions: [], approvals: [] }),
    '/api/sessions/codex/build-chat': () => ({ session, items: [] }),
    '/api/sessions/codex/build-chat/live': async () => { await settle(60); return { status: 'idle', items: 0, prompts: [], streaming: '' }; },
  } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  navigation = await dom.load('/src/outcome-navigation.tsx');
  Home = (await dom.load('/src/HomeLive.tsx')).default;
  Everything = (await dom.load('/src/EverythingChat.tsx')).default;
  ({ WorkflowsPage } = await dom.load('/src/Workflows.tsx'));
});
afterEach(async () => { if (view) await view.unmount(); view = null; sessionStorage.clear(); capabilities = { executionAvailable: true, reason: '' }; assert.deepEqual(dom.errors, []); });
after(() => dom?.close());
const el = (component, props) => dom.React.createElement(component, props);
const button = (text, root = dom.document) => [...root.querySelectorAll('button')].find(b => b.textContent.includes(text));
const feed = list => ({ sessions: [session], workflows: list, health, errors: {}, relays: [], teams: [], macPrompts: [] });

test('Home shows outcome decisions in Needs you without a separate Outcomes card', async () => {
  const list = ['ready', 'needs_owner', 'running'].map((phase, i) => ({ ...outcomeWorkflowFixture(), id: `flow-${i}`, title: `Outcome ${i}`, state: i === 2 ? 'running' : 'done', outcome: { phase, acceptance: { eligible: i === 0, status: 'not_accepted' } } }));
  const opened = [];
  view = await dom.render(el(Home, { features: { owner: true, screen: false }, device: { name: 'Computer', roots: [] }, peer, active: peer.id,
    connections: { computer: { state: 'connected' } }, connection: 'Private', chats: [], pending: [], navigate() {}, openChat() {}, decide() {},
    workflows: list, onOpenWorkflow: id => opened.push(id || 'all'), refreshSessions() {}, toast() {} }));
  const needs = dom.document.querySelector('.home-needs');
  assert.match(needs.textContent, /Ready for your review/);
  assert.match(needs.textContent, /Blocked · needs you/);
  assert.equal(dom.document.querySelector('[aria-label="Outcomes"]'), null);
  assert.doesNotMatch(dom.document.querySelector('.home-live').textContent, /Outcome 2/);
  button('Review outcome', needs).click(); await settle();
  assert.deepEqual(opened, ['flow-0']);
  assert.equal(dom.document.querySelectorAll('.home-needs').length, 1);
});

test('the verification queue stays in Workflows without promoting it on Home as an owner decision', async () => {
  const queued = { ...outcomeWorkflowFixture(), state: 'running', outcome: { phase: 'running', waitingForVerification: true, acceptance: { eligible: false, status: 'not_accepted' } } };
  assert.equal(navigation.outcomeState(queued), 'Waiting for checks');
  assert.equal(navigation.outcomeNeedsOwner(queued), false);
  view = await dom.render(el(Home, { features: { owner: true, screen: false }, device: { name: 'Computer', roots: [] }, peer, active: peer.id,
    connections: { computer: { state: 'connected' } }, connection: 'Private', chats: [], pending: [], navigate() {}, openChat() {}, decide() {},
    workflows: [queued], onOpenWorkflow() {}, refreshSessions() {}, toast() {} }));
  assert.equal(dom.document.querySelector('[aria-label="Outcomes"]'), null);
  assert.equal(button('Review outcome'), undefined);
  await view.unmount();
  view = await dom.render(el(WorkflowsPage, { peer, workflows: [queued], logos: {}, onOpen() {}, onNew() {}, onClose() {} }));
  assert.match(dom.document.querySelector('.workflows-page').textContent, /Waiting for checks/);
});

test('chat lists keep Outcomes in Workflows and can open a result without a task chat', async () => {
  workflow = outcomeWorkflowFixture(); state = outcomeResultFixture();
  for (const agent of ['all', 'codex', 'claude', 'openclaw']) {
    localStorage.setItem('reach.chatAgent', agent);
    view = await dom.render(el(Everything, { peer, feed: { ...feed([workflow]), health: [...health, { agent: 'openclaw', installed: true, signedIn: true }] } }));
    assert.equal(dom.document.querySelector('[aria-label="Outcomes"]'), null, agent);
    const entry = dom.document.querySelector('button[title="Workflows"]');
    assert.ok(entry, `${agent} keeps the Workflows shortcut`);
    entry.click();
    await dom.waitFor(() => dom.document.querySelector('.workflows-page'));
    assert.match(dom.document.querySelector('.workflows-page').textContent, /Ready for your review/);
    button('Synthetic outcome', dom.document.querySelector('.workflows-page')).click();
    await dom.waitFor(() => dom.document.querySelector('.wf-outcome'));
    assert.match(dom.document.querySelector('.wf-outcome').textContent, /Result revision 1/);
    await view.unmount(); view = null; sessionStorage.clear();
  }
});

test('notification targets open the latest outcome even absent from chat feed; stale or repeated Accept taps cannot silently accept', async () => {
  workflow = outcomeWorkflowFixture(); state = { ...outcomeResultFixture(), resultRevision: 2, version: 20 }; sent = [];
  let targets = 0;
  view = await dom.render(el(Everything, { peer, feed: feed([]), workflowTarget: workflow.id, onWorkflowTargetOpened: () => targets++ }));
  await dom.waitFor(() => button('Accept result'));
  assert.equal(targets, 1);
  assert.match(dom.document.querySelector('.wf-outcome').textContent, /Result revision 2/);
  const accept = button('Accept result'); assert.equal(accept.disabled, false); accept.click(); accept.click();
  await settle(100); assert.equal(sent.length, 1);
  await dom.waitFor(() => dom.document.querySelector('.wf-outcome [role="alert"]'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].resultRevision, 2);
  assert.equal(sent[0].expectedVersion, 20);
  assert.match(dom.document.querySelector('.wf-outcome [role="alert"]').textContent, /Review the current revision/);
});

test('reopening a notification refreshes an open result and preserves unsaved owner text', async () => {
  workflow = outcomeWorkflowFixture(); state = outcomeResultFixture();
  let open;
  function Host() {
    const [target, setTarget] = dom.React.useState(workflow.id); open = () => setTarget(workflow.id);
    return el(Everything, { peer, feed: feed([workflow]), workflowTarget: target, onWorkflowTargetOpened: () => setTarget(null) });
  }
  view = await dom.render(el(Host));
  await dom.waitFor(() => button('Accept result'));
  const note = dom.document.querySelector('.wf-outcome label textarea');
  await replaceText(note, 'Keep these owner notes.');
  state = { ...state, version: 21, resultRevision: 2 };
  dom.update(open);
  await dom.waitFor(() => button('Review current revision'), 2000);
  assert.equal(note.value, 'Keep these owner notes.');
  assert.equal(button('Accept result').disabled, true);
  button('Review current revision').click(); await settle();
  assert.equal(button('Accept result').textContent.trim(), 'Accept result revision 2');
});

test('saved task associations link back to their outcome, with no title-based inference', async () => {
  workflow = outcomeWorkflowFixture(); state = outcomeResultFixture();
  assert.equal(navigation.outcomeForChat([workflow], { agent: 'codex', id: 'unrelated', title: 'Workflow · Repair calculation' }), undefined);
  assert.equal(navigation.outcomeForChat([workflow], session).id, workflow.id);
  view = await dom.render(el(Everything, { peer, feed: feed([workflow]), target: { agent: session.agent, id: session.id } }));
  await dom.waitFor(() => button('Back to outcome'));
  button('Back to outcome').click();
  await dom.waitFor(() => dom.document.querySelector('.wf-outcome'));
  assert.match(dom.document.querySelector('.wf-outcome').textContent, /Result revision 1/);
});

test('unavailable outcome history stays active in existing Workflows navigation', async () => {
  const unavailable = { ...outcomeWorkflowFixture(), outcome: { phase: 'unavailable', acceptance: { status: 'not_accepted', eligible: false } } };
  const opened = [];
  view = await dom.render(el(WorkflowsPage, { peer, workflows: [unavailable], logos: {}, onOpen: w => opened.push(w.id), onNew() {}, onClose() {} }));
  assert.equal(dom.document.querySelector('[role="tab"][aria-selected="true"]').textContent, 'Active');
  button('Synthetic outcome').click();
  assert.deepEqual(opened, [unavailable.id]);
  assert.match(dom.document.querySelector(".workflows-page").textContent, /Blocked · needs you/);
});

test('outcome deep links keep the current same-origin workflow locator and remove it after opening', async () => {
  const { openTarget, withoutTarget } = await dom.load('/src/deep-link.ts');
  assert.deepEqual(openTarget('/?page=sessions&workflow=wf-outcome'), { page: 'sessions', workflow: 'wf-outcome' });
  assert.equal(openTarget('https://elsewhere.test/?page=sessions&workflow=wf-outcome'), null);
  assert.equal(withoutTarget('/?page=sessions&workflow=wf-outcome&keep=1'), '/?keep=1');
  const { rememberPlace, lastPlace } = await dom.load('/src/deep-link.ts');
  rememberPlace(peer.id, { page: 'sessions', workflow: 'wf-outcome' });
  assert.deepEqual(lastPlace(peer.id), { page: 'sessions', workflow: 'wf-outcome' });
  assert.equal(lastPlace('another-computer'), null);
});


test('Create outcome draft saves one builder in the existing workflow and opens criteria before any Run', async () => {
  state = null; draftSent = [];
  const { WorkflowIntro, WorkflowSheet } = await dom.load('/src/Workflows.tsx');
  function Host() {
    const [draft, setDraft] = dom.React.useState(null);
    return draft ? el(WorkflowSheet, { peer, id: draft.id, initial: draft, addOutcome: true, logos: {}, onOpenChat() {}, onClose() {} }) :
      el(WorkflowIntro, { peer, agent: 'codex', cwd: '/work/fixture', title: 'Repair the synthetic app', onCreated: (w, outcome) => { assert.equal(outcome, true); setDraft(w); } });
  }
  view = await dom.render(el(Host));
  await dom.waitFor(() => !button('Create outcome draft').disabled);
  button('Create outcome draft').click();
  await dom.waitFor(() => dom.document.querySelector('.wf-outcome-editor'));
  assert.equal(draftSent.length, 1);
  assert.deepEqual(draftSent[0].tasks, [{ title: 'Build result', agent: 'codex', kind: 'build', task: 'Repair the synthetic app', together: false }]);
  assert.equal(button('Prepare checks'), undefined, 'the owner must save criteria first');
});

test('New outcome opens its own criteria-first composer without a workflow planner action', async () => {
  workflow = outcomeWorkflowFixture(); state = outcomeResultFixture();
  localStorage.setItem('reach.chatAgent', 'all');
  view = await dom.render(el(Everything, { peer, feed: feed([workflow]) }));
  dom.document.querySelector('button[title="Workflows"]').click();
  await dom.waitFor(() => button('New outcome') && !button('New outcome').disabled);
  button('New outcome').click();
  await dom.waitFor(() => dom.document.querySelector('textarea[aria-label="Outcome to build"]'));
  assert.ok(button('Create outcome draft'));
  assert.equal(button('Write tasks myself'), undefined);
  assert.equal(dom.document.querySelector('button[aria-label="Plan workflow"]'), null);
});

test('unavailable runner prevents new outcome drafts and keeps ordinary workflow creation available', async () => {
  capabilities = { executionAvailable: false, reason: 'Trusted runner setup is not available yet.' };
  const opened = [];
  view = await dom.render(el(WorkflowsPage, { peer, workflows: [], logos: {}, onOpen() {}, onNew: () => opened.push('workflow'), onNewOutcome: () => opened.push('outcome'), onClose() {} }));
  await dom.waitFor(() => dom.document.body.textContent.includes(capabilities.reason));
  assert.equal(button('New outcome').disabled, true);
  button('New outcome').click(); button('New workflow').click();
  assert.deepEqual(opened, ['workflow']);
  await view.unmount();
  const { WorkflowIntro } = await dom.load('/src/Workflows.tsx');
  view = await dom.render(el(WorkflowIntro, { peer, agent: 'codex', cwd: '/work/fixture', title: 'Repair the synthetic app', onCreated() { assert.fail('unavailable outcomes must not create drafts'); } }));
  await dom.waitFor(() => dom.document.body.textContent.includes(capabilities.reason));
  assert.equal(button('Create outcome draft').disabled, true);
  assert.equal(button('Write tasks myself').disabled, false);
});
