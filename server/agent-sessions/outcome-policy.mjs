// Server policy only. Agent text is material and cannot supply these records.
import { evidenceHash, canonical } from './result-evidence.mjs';
import { fail } from '../core.mjs';

export const digest = (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
export const tupleKeys = ['contractRevision', 'contractDigest', 'resultRevision', 'resultDigest', 'evidenceRevision', 'evidenceDigest'];
export const exactTuple = (body, tuple) => canonical(Object.fromEntries(tupleKeys.map(k => [k, body[k]]))) === canonical(tuple);
const bounded = (s, max = 4000) => typeof s === 'string' && s.length > 0 && s.length <= max;
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => plain(v) && Object.keys(v).every(k => allowed.includes(k));

// Generated branches are presented before approval and materialized as normal
// workflow tasks. They cannot evade the 20-task or three-working-task limits.
export function outcomePlan(w, c) {
  const original = w.tasks.filter(t => !t.outcomeRole);
  if (original.length !== 1 || original[0].kind !== 'build' || !['codex', 'claude'].includes(original[0].agent))
    throw fail(409, 'The first outcome journey requires one local builder task. Review and optional repair branches are added explicitly.');
  const builder = original[0];
  const review = (cycle) => ({ id: `outcome-review-${cycle}`, title: cycle === 1 ? 'Independent review' : 'Review repaired result',
    agent: c.review.agent, kind: 'review', together: false, outcomeRole: 'review', cycle,
    task: c.review.scope || 'Inspect the sealed result against the owner criteria and recorded checks.',
    ...(c.review.model ? { model: c.review.model } : {}), ...(c.review.effort ? { effort: c.review.effort } : {}) });
  const tasks = [{ ...Object.fromEntries(['id', 'title', 'task', 'agent', 'kind', 'model', 'effort'].filter(k => builder[k] !== undefined).map(k => [k, builder[k]])), together: false, outcomeRole: 'builder', cycle: 1 }, review(1)];
  if (c.repair.preapproved) tasks.push({ ...tasks[0], id: 'outcome-repair-2', title: 'Conditional repair', outcomeRole: 'repair', cycle: 2 }, review(2));
  return { builder: { agent: builder.agent, model: builder.model || '', taskId: builder.id },
    independentChecker: c.checks.map(check => ({ ...check })), reviewer: { ...c.review },
    branches: tasks.map(t => ({ ...t, condition: t.cycle === 2 ? 'one_supported_failed_check' : 'initial' })),
    scope: structuredClone(c.allowedArtifacts), limits: { ...c.limits }, repair: { ...c.repair },
    deadline: { starts: 'owner_run', wallSeconds: c.limits.wallSeconds }, externalActions: [] };
}

// prepare() is read-only provisioning/discovery. Definitions, argv and all
// workspace assignments are shown and pinned; nothing is resolved from logs.
export function preparedPlan(value, contract) {
  if (!keys(value, ['profiles', 'buildCwd', 'reviewCwd', 'isolation']) || !Array.isArray(value.profiles) ||
      value.profiles.length !== contract.checks.length || !bounded(value.buildCwd) || !bounded(value.reviewCwd) ||
      value.buildCwd === value.reviewCwd || !bounded(value.isolation)) throw fail(503, 'A supported independent runner and separate workspaces are required.');
  const profiles = contract.checks.map(c => {
    const p = value.profiles.find(p => p.id === c.id);
    if (!keys(p, ['id', 'profileId', 'definition', 'definitionDigest']) || p.profileId !== c.profileId || p.definitionDigest !== c.definitionDigest ||
        !keys(p.definition, ['executable', 'args', 'cwd', 'environment', 'outputBytes']) || !bounded(p.definition.executable, 500) ||
        !Array.isArray(p.definition.args) || p.definition.args.length > 40 || p.definition.args.some(a => typeof a !== 'string' || a.length > 2000) ||
        !bounded(p.definition.cwd, 240) || p.definition.cwd.startsWith('/') || /\\|(^|\/)\.\.(\/|$)/.test(p.definition.cwd) ||
        !Array.isArray(p.definition.environment) || p.definition.environment.some(v => !/^[A-Z_][A-Z0-9_]{0,79}$/.test(v)) ||
        !Number.isSafeInteger(p.definition.outputBytes) || p.definition.outputBytes < 1 || p.definition.outputBytes > 65536 ||
        evidenceHash(p.definition) !== c.definitionDigest) throw fail(503, 'A check profile is unsupported or its pinned definition changed.');
    return structuredClone(p);
  });
  return { ...structuredClone(value), profiles };
}

export const bundleDigest = (bundle) => evidenceHash({ candidate: bundle.candidate, checks: bundle.checks });
export function candidateRecord(v, c) {
  if (!keys(v, ['digest', 'manifestDigest', 'artifactKinds', 'sealed', 'scopeVerified', 'sideEffectsKnown', 'isolationVerified', 'historyComplete']) ||
      !digest(v.digest) || !digest(v.manifestDigest) || !Array.isArray(v.artifactKinds) ||
      v.artifactKinds.some(k => !['source_snapshot', 'diff', 'check_log', 'review_report', 'before_png', 'after_png'].includes(k)) ||
      ['sealed', 'scopeVerified', 'sideEffectsKnown', 'isolationVerified', 'historyComplete'].some(k => v[k] !== true) ||
      c.allowedArtifacts.requiredKinds.filter(k => !['check_log', 'review_report'].includes(k)).some(k => !v.artifactKinds.includes(k)))
    throw fail(409, 'Candidate integrity, scope, artifacts or side effects are unresolved. Inspect this run.');
  return structuredClone(v);
}
export function checkRecord(v, check, candidateDigest) {
  if (!check || !digest(candidateDigest) || !keys(v, ['checkId', 'profileDigest', 'candidateDigest', 'source', 'status', 'exitCode', 'complete', 'sideEffectsKnown', 'logDigest']) ||
      v.checkId !== check.id || v.profileDigest !== check.definitionDigest || v.candidateDigest !== candidateDigest ||
      v.source !== 'independent_runner' || !['passed', 'failed'].includes(v.status) || !Number.isSafeInteger(v.exitCode) ||
      (v.status === 'passed' ? v.exitCode !== 0 : v.exitCode === 0) || v.complete !== true || v.sideEffectsKnown !== true || !digest(v.logDigest))
    throw fail(409, 'A check has missing, incomplete or uncertain independent evidence.');
  return structuredClone(v);
}

// A separate review's JSON is a judgment, never an instruction, check receipt
// or permission. Accept only the finite finding format; do not run its text.
function lastReviewObject(text) {
  if (typeof text !== 'string') throw Error('Missing review text.');
  const stack = [];
  let start = -1, last = null, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (stack.length && ch === '"') { quoted = true; continue; }
    if (ch === '{' || ch === '[') {
      if (!stack.length) start = i;
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      if (stack.pop() !== (ch === '}' ? '{' : '[')) throw Error('Malformed review JSON.');
      if (!stack.length && text[start] === '{') last = text.slice(start, i + 1);
    }
  }
  // Never fall back to an earlier clear report when the final object is torn,
  // malformed or unsupported, or promote an object nested in a wrapper/array.
  if (stack.length || quoted || last === null) throw Error('Missing complete review object.');
  return JSON.parse(last);
}
export function reviewJudgment(text, { chat, builderChat, evidence, inputDigest }) {
  if (!chat || !builderChat || chat.id === builderChat.id && chat.agent === builderChat.agent ||
      !evidence || evidence.historyIncomplete || evidence.unknowns?.includes('summary_clipped') ||
      evidence.summary?.endsWith('\n…') || !evidence.provenance.chatId || !digest(inputDigest))
    throw fail(409, 'Independent review provenance is incomplete.');
  let report;
  try { report = lastReviewObject(text); } catch { throw fail(409, 'The independent review did not return a supported finding report.'); }
  if (!keys(report, ['status', 'findings']) || !['clear', 'findings'].includes(report.status) || !Array.isArray(report.findings) || report.findings.length > 20 ||
      report.findings.some(f => !keys(f, ['id', 'text', 'blocking']) || !/^[a-zA-Z0-9_-]{1,80}$/.test(f.id) || !bounded(f.text) || typeof f.blocking !== 'boolean') ||
      new Set(report.findings.map(f => f.id)).size !== report.findings.length || (report.status === 'clear' && report.findings.length))
    throw fail(409, 'Unsupported independent review findings.');
  return { source: 'reviewer_judgment', chat: structuredClone(chat), inputDigest, report: structuredClone(report), receiptDigest: evidence.evidenceDigest };
}

export function readiness(r, workflow) {
  const x = r.coordination, c = r.contracts.at(-1).contract, b = x?.bundles.at(-1), reasons = [];
  const add = id => reasons.push({ id, kind: id, blocking: true });
  if (!x || !b) { add('candidate_unavailable'); add('verification_unavailable'); return reasons; }
  if (!['ready', 'accepted'].includes(x.phase)) add(x.hold || 'run_not_ready');
  if (x.pending || x.cancelRequested) add('execution_disposition_unknown');
  if (x.contractRevision !== r.contractRevision || x.planDigest !== r.planDigest) add('approval_stale');
  if (x.baseline.length !== c.checks.length || c.checks.some(check => !x.baseline.some(v => v.checkId === check.id))) add('baseline_missing');
  if (!x.baseline.some(v => v.status === 'failed')) add('baseline_did_not_fail');
  try { candidateRecord(b.candidate, c); } catch { add('candidate_unavailable'); }
  for (const check of c.checks) {
    const receipt = b.checks.find(v => v.checkId === check.id);
    try { checkRecord(receipt, check, b.candidate.digest); if (receipt.status !== 'passed') add(`check_failed_${check.id}`); }
    catch { add(`check_missing_${check.id}`); }
  }
  if (!b.review || b.review.inputDigest !== bundleDigest(b)) add('review_unbound');
  else if (b.review.report.findings.some(f => f.blocking)) add('review_blocking');
  for (const criterion of c.criteria.filter(c => c.required && c.method === 'owner_observation'))
    if (x.observations?.findLast(o => o.criterionId === criterion.id && o.resultDigest === b.candidate.digest)?.passed !== true) add(`observation_missing_${criterion.id}`);
  if (workflow.tasks.some(t => t.state === 'uncertain' || t.state === 'starting' || t.state === 'working')) add('task_unsettled');
  if (!workflow.tasks.some(t => t.cycle === x.cycle && t.kind === 'build' && t.state === 'done') ||
      !workflow.tasks.some(t => t.cycle === x.cycle && t.outcomeRole === 'review' && t.state === 'done')) add('task_completion_missing');
  return reasons;
}
export function repairAllowed(r) {
  const x = r.coordination, c = r.contracts.at(-1).contract, b = x?.bundles.at(-1);
  return !!(x && b && c.repair.preapproved && x.repairsUsed === 0 && !x.pending && !x.cancelRequested &&
    b.checks.length === c.checks.length && b.checks.some(v => v.status === 'failed') &&
    b.checks.every(v => { try { checkRecord(v, c.checks.find(c => c.id === v.checkId), b.candidate.digest); return true; } catch { return false; } }) &&
    x.counts.builds < c.limits.maxBuildAttempts && x.counts.checks + c.checks.length <= c.limits.maxTotalCheckRuns &&
    x.counts.reviews < c.limits.maxTotalReviewAttempts);
}

// Versioned coordinator envelope; hash detects torn/changed storage, not a
// sandbox against an agent running as the same OS user. Runner must isolate.
export function validateCoordination(x, contract) {
  if (!keys(x, ['schemaVersion', 'phase', 'prepared', 'preparedDigest', 'plan', 'planDigest', 'contractRevision', 'owner', 'startedAt', 'deadlineAt', 'lastAt',
    'cycle', 'counts', 'repairsUsed', 'pending', 'bundles', 'baseline', 'hold', 'cancelRequested', 'observations']) || x.schemaVersion !== 1 ||
      !['prepared', 'baseline', 'build', 'capture', 'checks', 'review', 'evaluate', 'ready', 'accepted', 'needs_owner', 'cancelling', 'cancelled', 'uncertain', 'changes_requested'].includes(x.phase) ||
      !Array.isArray(x.bundles) || x.bundles.length > 2 || !Array.isArray(x.baseline) || x.baseline.length > 10 || !Array.isArray(x.observations) || x.observations.length > 40 ||
      !digest(x.preparedDigest) || evidenceHash(x.prepared) !== x.preparedDigest || !digest(x.planDigest) ||
      !Number.isSafeInteger(x.contractRevision) || !plain(x.counts) || ['builds', 'checks', 'reviews'].some(k => !Number.isSafeInteger(x.counts[k]) || x.counts[k] < 0) ||
      ![0, 1].includes(x.repairsUsed) || ![1, 2].includes(x.cycle) || !Number.isFinite(x.lastAt)) throw Error('Invalid outcome coordination.');
  if (contract) {
    preparedPlan(x.prepared, contract);
    if (x.counts.builds > contract.limits.maxBuildAttempts || x.counts.checks > contract.limits.maxTotalCheckRuns || x.counts.reviews > contract.limits.maxTotalReviewAttempts ||
        !keys(x.plan, ['builder', 'independentChecker', 'reviewer', 'branches', 'scope', 'limits', 'repair', 'deadline', 'externalActions']) ||
        !Array.isArray(x.plan.branches) || x.plan.branches.length !== (contract.repair.preapproved ? 4 : 2) ||
        !Array.isArray(x.plan.externalActions) || x.plan.externalActions.length ||
        canonical(x.plan.scope) !== canonical(contract.allowedArtifacts) || canonical(x.plan.limits) !== canonical(contract.limits) ||
        canonical(x.plan.repair) !== canonical(contract.repair)) throw Error('Invalid approved plan or limits.');
    for (const b of x.bundles) {
      if (!keys(b, ['candidate', 'checks', 'review']) || !Array.isArray(b.checks) || b.checks.length > contract.checks.length) throw Error('Invalid evidence bundle.');
      candidateRecord(b.candidate, contract);
      const seen = new Set();
      for (const v of b.checks) {
        if (seen.has(v.checkId)) throw Error('Duplicate check.');
        seen.add(v.checkId); checkRecord(v, contract.checks.find(c => c.id === v.checkId), b.candidate.digest);
      }
      if (b.review && (!keys(b.review, ['source', 'chat', 'inputDigest', 'report', 'receiptDigest']) || b.review.source !== 'reviewer_judgment' ||
          !digest(b.review.inputDigest) || !digest(b.review.receiptDigest) || !plain(b.review.chat) || !bounded(b.review.chat.id, 160) ||
          !keys(b.review.report, ['status', 'findings']) || !['clear', 'findings'].includes(b.review.report.status) ||
          !Array.isArray(b.review.report.findings) || b.review.report.findings.length > 20 ||
          b.review.report.findings.some(f => !keys(f, ['id', 'text', 'blocking']) || !bounded(f.id, 80) || !bounded(f.text) || typeof f.blocking !== 'boolean')))
        throw Error('Invalid bound review.');
    }
    for (const v of x.baseline) checkRecord(v, contract.checks.find(c => c.id === v.checkId), v.candidateDigest);
  }
  if (typeof x.cancelRequested !== 'boolean' || !bounded(x.owner, 160) || !bounded(x.hold || '-', 4000) ||
      x.startedAt !== null && (!Number.isFinite(x.startedAt) || !Number.isFinite(x.deadlineAt) || x.deadlineAt <= x.startedAt)) throw Error('Invalid execution boundary.');
  if (x.pending && (!keys(x.pending, ['id', 'kind', 'cycle', 'checkId', 'taskId', 'at', 'chat', 'turnId', 'deadlineAt', 'dispatchedAt']) || !bounded(x.pending.id, 160) ||
    !['baseline', 'capture', 'check', 'build', 'review'].includes(x.pending.kind) || !Number.isFinite(x.pending.at) ||
    x.pending.dispatchedAt !== undefined && x.pending.dispatchedAt !== null && !Number.isFinite(x.pending.dispatchedAt))) throw Error('Invalid action intent.');
  return x;
}
