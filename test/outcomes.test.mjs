import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOutcomes, newOutcomeRef, outcomeAcceptance, outcomeContract, outcomeInput, outcomeTuple, OUTCOME_LIMITS } from "../server/agent-sessions/outcomes.mjs";
import { evidenceHash, recordedTurnResult, stampResult } from "../server/agent-sessions/result-evidence.mjs";
import { outcomePlan, readiness, reviewJudgment } from "../server/agent-sessions/outcome-policy.mjs";
import { createWorkflows } from "../server/agent-sessions/workflows.mjs";
import { outcomeFixture } from "./helpers/outcome-fixture.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-outcome-")), ref = newOutcomeRef();
  const workflow = { id: randomUUID(), title: "Synthetic repair", cwd: "/work/fixture", state: "draft", tasks: [{ id: "t1", title: "Build", task: "Fix the seeded bug", agent: "codex", kind: "build", state: "waiting" }] };
  const directory = path.join(dir, "outcomes"), options = { directory, now: () => 1000 };
  const store = createOutcomes(options), body = { requestId: "save-contract-one", expectedVersion: 0, contract: outcomeFixture() };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, directory, ref, workflow, store, body, options, file: path.join(directory, `${ref.id}.json`),
    save: () => store.put(ref, workflow, body, { create: true }) };
}

function settled(h, phase = 'needs_owner') {
  const definition = { executable: 'synthetic-check', args: [], cwd: '.', environment: [], outputBytes: 4096 };
  h.body.contract.checks[0].definitionDigest = evidenceHash(definition);
  h.save();
  const prepared = { profiles: [{ ...h.body.contract.checks[0], definition }], buildCwd: '/work/build', reviewCwd: '/work/review', isolation: 'synthetic store test' };
  delete prepared.profiles[0].timeoutSeconds;
  h.workflow.state = 'done'; h.workflow.tasks[0].state = 'done';
  h.store.change(h.ref, h.workflow, r => {
    r.phase = phase;
    r.coordination = { schemaVersion: 1, phase, prepared, preparedDigest: evidenceHash(prepared), plan: outcomePlan(h.workflow, r.contracts.at(-1).contract),
      planDigest: r.planDigest, contractRevision: r.contractRevision, owner: 'owner', startedAt: 1000, deadlineAt: 2000, lastAt: 1000,
      cycle: 1, counts: { builds: 0, checks: 0, reviews: 0 }, repairsUsed: 0, pending: null, bundles: [], baseline: [], hold: 'Inspect the synthetic result.', cancelRequested: false, observations: [] };
  });
}

test('independent review accepts a final report inside prose or fences without weakening its schema', () => {
  const clear = { status: 'clear', findings: [] };
  const finding = { status: 'findings', findings: [{ id: 'f1', text: 'Check a literal } and an escaped "quote".', blocking: true }] };
  const evidence = { historyIncomplete: false, truncated: true, provenance: { chatId: 'review' }, unknowns: ['stored_content_clipped'], evidenceDigest: evidenceHash('receipt') };
  const binding = { chat: { agent: 'claude', id: 'review' }, builderChat: { agent: 'codex', id: 'build' }, evidence, inputDigest: evidenceHash('bundle') };
  for (const text of [JSON.stringify(clear), `Here is the review:\n\`\`\`json\n${JSON.stringify(clear)}\n\`\`\`\nReview complete.`])
    assert.deepEqual(reviewJudgment(text, binding).report, clear);
  assert.deepEqual(reviewJudgment(`${JSON.stringify(clear)}\nFinal assessment:\n${JSON.stringify(finding)}`, binding).report, finding);
  for (const text of [
    `\`\`\`json\n${JSON.stringify(clear)}\n\`\`\`\n{"status":"findings",`,
    `${JSON.stringify(clear)}\n{"status":"clear","findings":[],"repair":true}`,
    `${JSON.stringify(clear)}\n{invalid final report}`,
    JSON.stringify({ report: clear }), JSON.stringify([clear]), 'Looks good.',
    JSON.stringify({ status: 'clear', findings: finding.findings }),
    JSON.stringify({ status: 'findings', findings: [finding.findings[0], finding.findings[0]] }),
  ]) assert.throws(() => reviewJudgment(text, binding), { status: 409 });
  for (const incomplete of [{ historyIncomplete: true }, { unknowns: ['summary_clipped'] }, { summary: `${JSON.stringify(clear)}\n…` }])
    assert.throws(() => reviewJudgment(JSON.stringify(clear), { ...binding, evidence: { ...evidence, ...incomplete } }), { status: 409 });
  assert.throws(() => reviewJudgment(JSON.stringify(clear), { ...binding, chat: binding.builderChat }), { status: 409 });
});

test('a persisted ready result cannot bypass the required failing baseline', t => {
  const h = fixture(t); settled(h, 'ready');
  const r = h.store.raw(h.ref, h.workflow);
  r.coordination.bundles = [{ candidate: {}, checks: [] }];
  r.coordination.baseline = [{ checkId: 'unit', status: 'passed' }];
  assert.ok(readiness(r, h.workflow).some(reason => reason.id === 'baseline_did_not_fail'));
});

test('the workflow summary distinguishes waiting for verification without exposing its evidence', t => {
  const h = fixture(t); settled(h);
  assert.equal(h.store.summary(h.ref, h.workflow).waitingForVerification, false);
  h.store.change(h.ref, h.workflow, r => { r.phase = 'running'; r.coordination.phase = 'checks'; r.coordination.hold = 'Waiting for independent verification capacity.'; });
  const summary = h.store.summary(h.ref, h.workflow);
  assert.equal(summary.waitingForVerification, true);
  assert.equal(summary.hold, undefined);
  h.store.change(h.ref, h.workflow, r => { r.coordination.pending = { id: 'current-check', kind: 'check', at: 1000 }; });
  assert.equal(h.store.summary(h.ref, h.workflow).waitingForVerification, false);
});

test('explicit settled deletion releases attachment storage and keeps only a non-replay tombstone', t => {
  const h = fixture(t); settled(h);
  assert.equal(h.store.get(h.ref, h.workflow).capabilities.remove, true);
  assert.equal(h.store.summary(h.ref, h.workflow).removable, true);
  h.store.remove(h.ref, h.workflow);
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.store.isRemoved(h.workflow.id), true);
  const tombstone = JSON.parse(fs.readFileSync(path.join(h.directory, 'deleted', fs.readdirSync(path.join(h.directory, 'deleted'))[0])));
  assert.deepEqual(tombstone.operations, [{ requestId: h.body.requestId, bodyHash: evidenceHash(outcomeInput(h.body)) }]);
  assert.equal(JSON.stringify(tombstone).includes(h.body.contract.goal), false, 'removed goals and evidence are not retained in the tombstone');
  const restarted = createOutcomes(h.options);
  assert.equal(restarted.isRemoved(h.workflow.id), true);
  assert.equal(restarted.summary(h.ref, h.workflow).removable, true, 'a two-store crash keeps explicit deletion cleanup available');
  assert.throws(() => restarted.get(h.ref, h.workflow), { status: 410 });
  assert.throws(() => restarted.put(h.ref, { ...h.workflow, state: 'draft' }, h.body, { create: true }), { status: 410 });
  assert.throws(() => restarted.put(newOutcomeRef(), { ...h.workflow, state: 'draft' }, h.body, { create: true }), { status: 503 });
  restarted.remove(h.ref, h.workflow);
  for (let i = 0; i < OUTCOME_LIMITS.outcomes; i++) {
    const workflow = { ...h.workflow, id: randomUUID(), state: 'draft' };
    restarted.put(newOutcomeRef(), workflow, h.body, { create: true });
  }
  assert.throws(() => restarted.put(newOutcomeRef(), { ...h.workflow, id: randomUUID(), state: 'draft' }, h.body, { create: true }), { status: 429 });
});

test('outcome deletion refuses active and uncertain work and never deletes after a failed tombstone write', t => {
  for (const phase of ['baseline', 'build', 'capture', 'checks', 'review', 'evaluate', 'cancelling', 'uncertain']) {
    const h = fixture(t); settled(h);
    h.store.change(h.ref, h.workflow, r => { r.coordination.phase = phase; });
    assert.equal(h.store.summary(h.ref, h.workflow).removable, false, phase);
    assert.throws(() => h.store.remove(h.ref, h.workflow), { status: 409 }, phase);
    assert.equal(fs.existsSync(h.file), true);
  }
  for (const state of ['starting', 'working', 'uncertain']) {
    const h = fixture(t); settled(h); h.workflow.tasks[0].state = state;
    assert.equal(h.store.get(h.ref, h.workflow).capabilities.remove, false, state);
    assert.throws(() => h.store.remove(h.ref, h.workflow), { status: 409 }, state);
  }
  const h = fixture(t); settled(h);
  h.store.change(h.ref, h.workflow, r => { r.coordination.pending = { id: 'held-check', kind: 'check', at: 1000 }; });
  assert.throws(() => h.store.remove(h.ref, h.workflow), { status: 409 });
  h.store.change(h.ref, h.workflow, r => { r.coordination.pending = null; });
  const denied = createOutcomes({ ...h.options, write() { throw Error('Synthetic disk failure'); } });
  assert.throws(() => denied.remove(h.ref, h.workflow), { status: 507 });
  assert.equal(fs.existsSync(h.file), true);
  assert.equal(h.store.isRemoved(h.workflow.id), false);
});

test('archived unexecuted drafts retain a workflow tombstone that prevents request-changes resurrection', t => {
  const h = fixture(t); h.save();
  h.store.archiveDraft(h.ref, h.workflow);
  const restarted = createOutcomes(h.options);
  assert.equal(restarted.isRemoved(h.workflow.id), true);
  assert.equal(fs.existsSync(path.join(h.directory, 'archived', `${h.ref.id}.json`)), true);
  assert.throws(() => restarted.put(newOutcomeRef(), h.workflow, h.body, { create: true }), { status: 503 });
});

test('cancelling before preparation permits explicit removal without a coordinator record', t => {
  const h = fixture(t); h.save();
  h.store.change(h.ref, h.workflow, r => { r.phase = 'cancelled'; });
  h.workflow.state = 'stopped';
  assert.equal(h.store.summary(h.ref, h.workflow).removable, true);
  h.store.remove(h.ref, h.workflow);
  assert.equal(fs.existsSync(h.file), false);
});

test("strict contracts refuse verdicts, permissions, unpinned checks and unbounded repairs", () => {
  assert.equal(outcomeContract(outcomeFixture()).goal, outcomeFixture().goal);
  const mutations = [
    (c) => { c.mode = "full-access"; },
    (c) => { c.criteria[0].passed = true; },
    (c) => { c.criteria[0].method = "assistant_claim"; },
    (c) => { delete c.criteria[0].id; },
    (c) => { c.criteria.push({ ...c.criteria[0] }); },
    (c) => { c.criteria[0].checkId = "missing"; },
    (c) => { c.criteria[0].required = false; },
    (c) => { c.checks[0].command = "arbitrary executable"; },
    (c) => { c.checks[0].definitionDigest = "mutable-profile"; },
    (c) => { delete c.checks[0].profileId; },
    (c) => { c.allowedArtifacts.allowedChangedPaths = ["../escape"]; },
    (c) => { c.allowedArtifacts.allowedChangedPaths = ["C:\\escape"]; },
    (c) => { c.allowedArtifacts.requiredKinds = ["html"]; },
    (c) => { c.allowedArtifacts.maxBytes = Number.MAX_SAFE_INTEGER; },
    (c) => { c.review.agent = "openclaw"; },
    (c) => { c.review.separateChat = false; },
    (c) => { c.limits.wallSeconds = 3601; },
    (c) => { c.limits.maxTotalCheckRuns = 3; },
    (c) => { c.repair.preapproved = true; c.repair.maxCycles = 1; },
  ];
  for (const mutate of mutations) { const c = outcomeFixture(); mutate(c); assert.throws(() => outcomeContract(c), { status: 400 }); }
  for (const body of [{ expectedVersion: 0, contract: outcomeFixture() }, { requestId: "valid-request", expectedVersion: -1, contract: outcomeFixture() },
    { requestId: "valid-request", expectedVersion: 0, contract: outcomeFixture(), owner: "forged" }]) assert.throws(() => outcomeInput(body), { status: 400 });
});

test("contract versions and request deduplication persist across lost responses and restart", (t) => {
  const h = fixture(t), first = h.save();
  assert.equal(first.outcome.version, 1);
  assert.equal(first.outcome.contractRevision, 1);
  const restarted = createOutcomes(h.options);
  assert.deepEqual(restarted.put(h.ref, h.workflow, h.body), first);
  const edited = structuredClone(h.body);
  edited.requestId = "save-contract-two";
  edited.expectedVersion = 1;
  edited.contract.criteria[0].text = "All pinned seeded cases pass.";
  const second = restarted.put(h.ref, h.workflow, edited);
  assert.equal(second.outcome.contractRevision, 2);
  assert.notEqual(second.outcome.contractDigest, first.outcome.contractDigest);
  assert.equal(second.outcome.contracts[0].digest, first.outcome.contractDigest);
  assert.equal(restarted.put(h.ref, h.workflow, h.body).operation.version, 1, "lost-response retries refer to their historical operation");
  assert.throws(() => restarted.put(h.ref, h.workflow, { ...h.body, contract: edited.contract }), { status: 409 });
  assert.throws(() => restarted.put(h.ref, h.workflow, { ...edited, requestId: "another-owner-save", expectedVersion: 1 }), { status: 409 });
  assert.equal(restarted.operation(h.ref, h.workflow, edited.requestId).operation.version, 2);
  assert.equal(restarted.operation(h.ref, h.workflow, "unknown-request").status, "unknown");
  const disk = JSON.parse(fs.readFileSync(h.file));
  assert.equal(disk.contracts.length, 2);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(h.directory).mode & 0o777, 0o700);
  }
});

test("frozen original-turn receipts bind known identities without establishing checks, candidate bytes or review", (t) => {
  const h = fixture(t);
  h.save();
  const evidence = stampResult(recordedTurnResult([
    { id: "cmd", turnId: "turn", role: "tool", kind: "command", text: "npm test", detail: "passed", status: "completed", exitCode: 0, outputTruncated: false },
    { id: "edit", turnId: "turn", role: "tool", kind: "file-change", text: "src/total.mjs", detail: "+ total", status: "completed" },
    { id: "answer", turnId: "turn", role: "assistant", kind: "text", text: "The required criterion passed." },
  ], { binding: { workflowId: h.workflow.id, taskId: "t1", attempt: 1, provider: "codex", chatId: "builder", turnId: "turn", contractRevision: 1 } }), { at: 100 });
  const added = h.store.appendResult(h.ref, h.workflow, evidence);
  assert.equal(added.evidenceRevision, 1);
  assert.equal(added.results[0].provenance.contractRevision, 1);
  assert.equal(added.checks[0].status, "unknown");
  assert.equal(added.review.status, "pending");
  assert.equal(added.acceptance.eligible, false);
  assert.equal(added.resultRevision, null);
  assert.ok(added.results[0].unknowns.includes("concurrent_edits_unknown"));
  assert.deepEqual(h.store.appendResult(h.ref, h.workflow, evidence), added, "a duplicate completion appends nothing");
  assert.throws(() => h.store.appendResult(h.ref, h.workflow, stampResult(recordedTurnResult([], { binding: evidence.provenance }), { at: 101 })), { status: 409 });
  h.store.put(h.ref, h.workflow, { requestId: "save-contract-two", expectedVersion: added.version, contract: { ...outcomeFixture(), goal: "A revised goal" } });
  const current = h.store.get(h.ref, h.workflow);
  assert.equal(current.results[0].provenance.contractRevision, 1, "contract edits cannot relabel old evidence");
  assert.equal(current.contractRevision, 2);
  const request = { requestId: "accept-old-result", expectedVersion: added.version, ...Object.fromEntries(["contractRevision", "contractDigest", "resultRevision", "resultDigest", "evidenceRevision", "evidenceDigest"].map((key) => [key, added[key]])), acknowledgedLimitationIds: [] };
  assert.throws(() => h.store.accept(h.ref, h.workflow, request), { status: 409 });
  Object.assign(request, { expectedVersion: current.version, ...outcomeTuple(current) });
  assert.throws(() => h.store.accept(h.ref, h.workflow, request), /not eligible/);
});

test("acceptance state becomes stale when any accepted contract/evidence tuple changes", () => {
  const r = { contractRevision: 1, contracts: [{ digest: `sha256:${"a".repeat(64)}` }], evidenceRevision: 1, evidenceDigest: `sha256:${"b".repeat(64)}`, decisions: [] };
  r.decisions.push({ status: "accepted", tuple: outcomeTuple(r) });
  assert.equal(outcomeAcceptance(r).status, "accepted");
  r.evidenceRevision++;
  assert.equal(outcomeAcceptance(r).status, "stale");
  assert.equal(r.decisions[0].status, "accepted", "the old decision is retained for its exact tuple");
});

test("missing, corrupt and future ledgers fail closed and never reset a marked outcome", (t) => {
  const h = fixture(t);
  h.save();
  const original = fs.readFileSync(h.file, "utf8");
  for (const contents of ["{torn", JSON.stringify({ ...JSON.parse(original), schemaVersion: 9 }), JSON.stringify({ ...JSON.parse(original), evidenceDigest: `sha256:${"0".repeat(64)}` })]) {
    fs.writeFileSync(h.file, contents);
    const store = createOutcomes(h.options);
    assert.throws(() => store.get(h.ref, h.workflow), { status: 503 });
    assert.throws(() => store.put(h.ref, h.workflow, h.body), { status: 503 });
    assert.equal(fs.readFileSync(h.file, "utf8"), contents);
  }
  fs.rmSync(h.file);
  assert.throws(() => h.store.put(h.ref, h.workflow, h.body), { status: 503 });
  assert.equal(fs.existsSync(h.file), false);
});

test("storage failures and finite revision quotas preserve the previous record", (t) => {
  const h = fixture(t);
  h.save();
  const before = fs.readFileSync(h.file, "utf8"), store = createOutcomes({ ...h.options, write() { throw Error("synthetic full disk"); } });
  assert.throws(() => store.put(h.ref, h.workflow, { ...h.body, requestId: "save-contract-two", expectedVersion: 1 }), { status: 507 });
  assert.equal(fs.readFileSync(h.file, "utf8"), before);
  for (let n = 1; n < OUTCOME_LIMITS.contracts; n++) h.store.put(h.ref, h.workflow, { ...h.body, requestId: `contract-${String(n).padStart(4, "0")}`, expectedVersion: n });
  const full = fs.readFileSync(h.file, "utf8");
  assert.throws(() => h.store.put(h.ref, h.workflow, { ...h.body, requestId: "contract-overflow", expectedVersion: OUTCOME_LIMITS.contracts }), { status: 429 });
  assert.equal(fs.readFileSync(h.file, "utf8"), full);
});

test("workflow attachments block old controls, preserve compatibility data and copy unapproved drafts", (t) => {
  const h = fixture(t), file = path.join(h.dir, "workflows.json"), sessions = { async list() { return { sessions: [] }; }, async start() { assert.fail("foundation must not dispatch outcome tasks"); } };
  const relays = { get: () => null, watch: () => "watch", cancel() {} };
  const create = () => createWorkflows({ sessions, relays, file, folder: (p) => p, now: () => 1000, setEvery: () => 0, clearEvery() {} });
  let workflows = create();
  const w = workflows.create({ owner: "phone", cwd: "/work/fixture", tasks: h.workflow.tasks }).workflow;
  assert.equal(workflows.getOutcome(w.id).outcome, null);
  assert.equal(workflows.getOutcome(w.id).capabilities.executionAvailable, false);
  const contract = outcomeFixture();
  contract.repair = { preapproved: true, maxCycles: 1 };
  Object.assign(contract.limits, { maxBuildAttempts: 2, maxTotalCheckRuns: 3, maxTotalReviewAttempts: 2 });
  workflows.putOutcome(w.id, { ...h.body, contract });
  const disk = JSON.parse(fs.readFileSync(file));
  disk[0].futureOptional = { keep: true };
  fs.writeFileSync(file, JSON.stringify(disk));
  workflows = create();
  for (const action of [() => workflows.run(w.id, "phone"), () => workflows.resume(w.id, "phone"), () => workflows.retry(w.id, "t1", "phone"), () => workflows.skip(w.id, "t1", "phone")]) assert.throws(action, { status: 503 });
  assert.throws(() => workflows.update(w.id, { tasks: w.tasks }), { status: 409 });
  workflows.update(w.id, { title: "Renamed" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file))[0].futureOptional, { keep: true });
  const copy = workflows.again(w.id, "phone").workflow;
  const copied = workflows.getOutcome(copy.id).outcome;
  assert.equal(copied.contract.repair.preapproved, false);
  assert.equal(copied.contract.limits.maxBuildAttempts, 1);
  assert.equal(copied.evidenceRevision, 0);
  assert.notEqual(copied.id, workflows.getOutcome(w.id).outcome.id);
  // Draft-only archival is now explicit; run/evidence history remains pinned.
  const archivable = workflows.again(w.id, "phone").workflow;
  assert.equal(workflows.remove(archivable.id).removed, true);
  const saved = JSON.parse(fs.readFileSync(file));
  fs.rmSync(path.join(h.dir, "workflow-outcomes", `${saved[0].outcomeRef.id}.json`));
  assert.throws(() => workflows.putOutcome(w.id, h.body), { status: 503 });
  const ordinary = workflows.create({ owner: "phone", cwd: "/work/other", tasks: [] }).workflow;
  assert.equal(ordinary.outcome, undefined);
  assert.equal(workflows.remove(ordinary.id).removed, true);
});
