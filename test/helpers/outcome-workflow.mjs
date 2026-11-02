import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflows } from '../../server/agent-sessions/workflows.mjs';
import { evidenceHash } from '../../server/agent-sessions/result-evidence.mjs';
import { outcomeFixture } from './outcome-fixture.mjs';

// Synthetic adapters exercise the coordinator, not runner isolation, live
// providers, OS termination, browser boundaries or physical devices.
export const tuple = o => Object.fromEntries(['contractRevision', 'contractDigest', 'resultRevision', 'resultDigest', 'evidenceRevision', 'evidenceDigest'].map(k => [k, o[k]]));
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export function outcomeWorkflow(t, { repair = false, failed = [], directory = true, builder = 'codex' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-outcome-cycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = directory ? path.join(dir, 'workflows.json') : null;
  const chats = new Map(), watches = new Map(), calls = [];
  let time = 1000, access = '', paused = false, seq = 0, workflows, intervalTick = () => {};
  const settings = { failed, stopConfirmed: true, unknownCheck: false, integrity: true, startGate: null, checkGate: null, verifyGate: null, catalogGate: null };
  const definition = { executable: 'synthetic-runner', args: ['unit'], cwd: '.', environment: [], outputBytes: 4096 };
  const contract = outcomeFixture(); contract.checks[0].definitionDigest = evidenceHash(definition);
  if (repair) { contract.repair = { preapproved: true, maxCycles: 1 }; Object.assign(contract.limits, { maxBuildAttempts: 2, maxTotalCheckRuns: 3, maxTotalReviewAttempts: 2 }); }
  const receipt = (check, candidateDigest, status = 'passed') => ({ checkId: check.id, profileDigest: check.definitionDigest, candidateDigest, source: 'independent_runner', status,
    exitCode: status === 'passed' ? 0 : 1, complete: true, sideEffectsKnown: true, logDigest: evidenceHash({ status }) });
  const runner = {
    async prepare() { calls.push('prepare'); return { profiles: [{ id: 'unit', profileId: contract.checks[0].profileId, definition, definitionDigest: evidenceHash(definition) }], buildCwd: '/work/build', reviewCwd: '/work/review', isolation: 'synthetic adapter only' }; },
    async baseline({ check }) { calls.push('baseline'); return receipt(check, evidenceHash('baseline'), 'failed'); },
    async capture({ cycle }) { calls.push(`capture-${cycle}`); return { digest: evidenceHash(`candidate-${cycle}`), manifestDigest: evidenceHash(`manifest-${cycle}`),
      artifactKinds: ['source_snapshot', 'diff'], sealed: true, scopeVerified: true, sideEffectsKnown: true, isolationVerified: true, historyComplete: true }; },
    async check({ cycle, check, candidate }) { calls.push(`check-${cycle}`); if (settings.checkGate) await settings.checkGate.promise;
      const v = receipt(check, candidate.digest, settings.failed.includes(cycle) ? 'failed' : 'passed'); if (settings.unknownCheck) v.exitCode = null; return v; },
    async verify() { calls.push('verify'); if (settings.verifyGate) await settings.verifyGate.promise; return settings.integrity; },
    async stop(p) { calls.push(`stop-${p.kind}`); return { stopped: settings.stopConfirmed, confirmed: settings.stopConfirmed }; },
    async stopTask(p) { calls.push(`stop-task-${p.chat.id}`); return { stopped: settings.stopConfirmed, confirmed: settings.stopConfirmed }; },
  };
  const sessions = {
    async list() { return { sessions: [] }; },
    async start(agent, body) { calls.push(`start-${agent}`); const threadId = `chat-${++seq}`, turnId = `turn-${seq}`;
      chats.set(threadId, { id: threadId, agent, turnId, body, items: [{ id: `request-${seq}`, role: 'user', kind: 'text', turnId, text: body.text }] });
      if (settings.startGate) await settings.startGate.promise;
      if (settings.startLost) throw Error('Synthetic lost dispatch response');
      return { threadId, turnId }; },
    async read(agent, id) { if (settings.read) return settings.read(agent, id); return { items: structuredClone(chats.get(id).items), before: null, session: { status: 'idle' } }; },
    async stop() { assert.fail('outcomes must use the original operation stop boundary'); },
  };
  const relays = { watch({ from }) { watches.set(from.id, { state: 'waiting' }); return from.id; }, get: id => watches.get(id), cancel(id) { if (watches.has(id)) watches.get(id).state = 'cancelled'; } };
  const options = { sessions, relays, file, outcomeRunner: runner, authorized: () => paused ? 'Reach is paused.' : access, ownerAuthorized: () => access, folder: p => p, now: () => time,
    models: async () => { if (settings.catalogGate) await settings.catalogGate.promise; return [{ id: 'test', efforts: [], isDefault: true }]; },
    setEvery: fn => { intervalTick = fn; return 0; }, clearEvery() {} };
  const make = () => createWorkflows(options);
  workflows = make();
  const w = workflows.create({ owner: 'owner', cwd: '/work/source', title: 'Synthetic fix', tasks: [{ title: 'Fix', task: 'Repair the fixture', kind: 'build', agent: builder }] }).workflow;
  workflows.putOutcome(w.id, { requestId: 'save-contract-one', expectedVersion: 0, contract });
  const get = () => workflows.getOutcome(w.id).outcome;
  const command = (requestId, extra = {}) => ({ requestId, expectedVersion: get().version, ...extra });
  const h = { dir, file, options, runner, sessions, chats, watches, settings, calls, w, contract, get, command,
    get workflows() { return workflows; },
    restart() { workflows = make(); return workflows; }, sweep() { intervalTick(); },
    revoke() { access = 'revoked'; }, pause() { paused = true; }, advanceTime(ms) { time += ms; },
    async prepare() { const o = get(); return workflows.prepareOutcome(w.id, command('prepare-outcome-one', { contractRevision: o.contractRevision, contractDigest: o.contractDigest, planDigest: o.planDigest }), 'owner'); },
    async run() { await h.prepare(); const o = get(); const body = command('run-outcome-one', { contractRevision: o.contractRevision, contractDigest: o.contractDigest, planDigest: o.planDigest, preparedDigest: o.preparation.preparedDigest });
      workflows.runOutcome(w.id, body, 'owner'); await workflows.sync(); return body; },
    async pump(n = 16) { for (let i = 0; i < n; i++) await workflows.sync(); },
    async end(text = 'Builder claim, not verification') {
      const task = workflows.get(w.id).tasks.find(t => t.state === 'working'); assert.ok(task, 'a workflow task is working');
      const chat = chats.get(task.chat.id), id = `reply-${chat.id}`;
      chat.items.push({ id, role: 'assistant', kind: 'text', turnId: chat.turnId, text }); Object.assign(watches.get(chat.id), { state: 'done', outcome: 'reply', item: id });
      await workflows.sync(); return task;
    },
    acceptBody(id = 'accept-result-one') { const o = get(); return command(id, { ...tuple(o), acknowledgedLimitationIds: [] }); },
    changesBody(id = 'request-changes-one') { return command(id, { ...tuple(get()), note: 'Adjust the visible total.' }); },
  };
  return h;
}
