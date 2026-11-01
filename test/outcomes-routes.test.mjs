import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, AGENT_SCOPES } from "../server/core.mjs";
import { outcomeFixture } from "./helpers/outcome-fixture.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

// Actual HTTP/authentication; provider execution is a stand-in. No real
// project, local agent account, screen, CORS or physical phone validation.
test("outcome contracts and original result APIs remain private owner-device routes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-outcome-api-"));
  const workflowFile = path.join(dir, "workflows.json");
  fs.writeFileSync(workflowFile, JSON.stringify([{ id: "legacy-fixture", state: "done", title: "Legacy", cwd: os.homedir(), createdAt: Date.now(), updatedAt: Date.now(),
    tasks: [{ id: "t1", agent: "codex", kind: "build", task: "Synthetic task", state: "done", attempt: 1, result: { answer: "Earlier claim", files: [], diffs: "" } }] }]));
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"),
    workflowFile,
    openClaw: { overview: async () => ({ connected: false }), close() {} },
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }), health: async () => [{ agent: "codex", installed: true, signedIn: true }],
      models: async () => ({ models: [], modes: [] }),
      start: async () => assert.fail("outcome foundation must not execute tasks"),
    } });
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { reach.server.once("error", reject); reach.server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES), agent = reach.auth.issue("Agent", AGENT_SCOPES, "agent");
  const guest = reach.auth.redeemGuest(reach.auth.inviteGuest({ name: "Guest", ttlSeconds: 600, full: true, fullControlVersion: 1 }).invitation);
  const call = async (route, { body, token = owner.token } = {}) => {
    const response = await fetch(url + route, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const created = await call("/api/sessions/workflows", { body: { title: "Fixture", cwd: os.homedir(), tasks: [{ agent: "codex", kind: "build", task: "Fix the synthetic fixture" }] } });
  assert.equal(created.status, 200);
  const prefix = `/api/sessions/workflows/${created.body.workflow.id}`;
  const capabilities = await call('/api/sessions/workflows/outcome-capabilities');
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.headers.get('cache-control'), 'no-store');
  assert.equal(capabilities.body.executionAvailable, false);
  assert.match(capabilities.body.reason, /runner/);
  assert.deepEqual((await call(`${prefix}/outcome`)).body, { outcome: null, capabilities: capabilities.body });
  const body = { requestId: "save-contract-one", expectedVersion: 0, contract: outcomeFixture() };
  const saved = await call(`${prefix}/outcome`, { body });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.outcome.version, 1);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual((await call(`${prefix}/outcome`, { body })).body, saved.body);
  assert.equal((await call(`${prefix}/outcome`, { body: { ...body, requestId: "stale-owner-save", expectedVersion: 0 } })).status, 409);
  assert.equal((await call(`${prefix}/outcome`, { body: { ...body, forgedReceipt: { exitCode: 0 } } })).status, 400);
  assert.equal((await call(`${prefix}/outcome/operations/${body.requestId}`)).body.status, "known");
  const full = admitAgent(reach.auth, reach.auth.inviteBrowser({ name: "Full control agent", ttlSeconds: 600, preset: "full", fullControlVersion: 1 }).invitation);
  for (const token of [agent.token, guest.token, full.token]) for (const [route, mutation] of [
    ['/api/sessions/workflows/outcome-capabilities', undefined],
    [`${prefix}/outcome`, undefined], [`${prefix}/outcome`, body], [`${prefix}/outcome/operations/${body.requestId}`, undefined],
    [`${prefix}/outcome/accept`, {}], [`${prefix}/outcome/run`, {}], [`${prefix}/outcome/prepare`, {}],
    [`${prefix}/outcome/request-changes`, {}], [`${prefix}/outcome/cancel`, {}], [`${prefix}/outcome/observations`, {}], [`${prefix}/tasks/t1/result`, undefined],
  ]) assert.equal((await call(route, { body: mutation, token })).status, 403, route);
  reach.auth.revoke(full.clientId);
  assert.equal((await call(`${prefix}/outcome/run`, { body: {} })).status, 503);
  assert.equal((await call(`${prefix}/run`, { body: {} })).status, 503, "old Run cannot bypass the outcome barrier");
  const current = saved.body.outcome;
  const acceptance = { requestId: "accept-no-result", expectedVersion: current.version, contractRevision: current.contractRevision,
    contractDigest: current.contractDigest, resultRevision: null, resultDigest: null, evidenceRevision: current.evidenceRevision, evidenceDigest: current.evidenceDigest, acknowledgedLimitationIds: [] };
  assert.equal((await call(`${prefix}/outcome/accept`, { body: acceptance })).status, 409);
  assert.equal((await call(`${prefix}/tasks/t1/result`)).status, 404);
  assert.equal((await call(`${prefix}/tasks/t1/result?attempt=-1`)).status, 400);
  const legacy = await call("/api/sessions/workflows/legacy-fixture/tasks/t1/result?attempt=1");
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.result.summarySource, "agent_claim");
  assert.deepEqual(legacy.body.handoff, { answer: 'Earlier claim', files: [], diffs: '', source: 'legacy', truncated: false });
  assert.deepEqual(legacy.body.attempts, [{ attempt: 1, current: true }]);
  assert.equal(legacy.body.attempt, 1);
  assert.ok(legacy.body.result.unknowns.includes("legacy_result"));
  assert.equal(legacy.headers.get("cache-control"), "no-store");
  reach.auth.revoke(owner.clientId);
  assert.equal((await call(`${prefix}/outcome/operations/${body.requestId}`)).status, 401, "cached operations still require current owner authorization");
});

test('owner revocation during an asynchronous outcome decision prevents returning its cached result', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-outcome-route-race-'));
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { finish = resolve; });
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, 'private'),
    openClaw: { overview: async () => ({ connected: false }), close() {} },
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [], models: async () => ({ models: [], modes: [] }) },
    workflows: { list: () => [], async acceptOutcome() { entered(); await held; return { outcome: { privateResult: 'synthetic contents' } }; } } });
  t.after(async () => { finish(); await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { reach.server.once('error', reject); reach.server.listen(0, '127.0.0.1', resolve); });
  const owner = reach.auth.issue('Owner', ALL_SCOPES);
  const response = fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/workflows/synthetic/outcome/accept`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  await started; reach.auth.revoke(owner.clientId); finish();
  const result = await response; assert.equal(result.status, 401); assert.equal(JSON.stringify(await result.json()).includes('privateResult'), false);
});
