import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { presetFixture, privateIngressTest } from "./helpers/preset-fixture.mjs";

const tick = () => new Promise(setImmediate);
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.fail("controlled provider operation did not settle");
}
function provider() {
  const runs = new Map(), stopped = [], reads = [];
  return { runs, stopped, reads, sessions: {
    list: async () => ({ sessions: [], errors: {} }), health: async () => [],
    async startCodingTask(agent, body) {
      const threadId = crypto.randomUUID(), turnId = crypto.randomUUID();
      const run = { agent, body, threadId, turnId, status: "running", items: [{ role: "user", kind: "text", text: body.text, turnId }] };
      runs.set(threadId, run);
      body.authorize(); body.onCreated({ threadId }); body.onStarted({ threadId, turnId });
      return { threadId, turnId };
    },
    async read(agent, id) { reads.push({ agent, id }); const run = runs.get(id); return { session: { status: run.status }, items: run.items, before: null }; },
    view(agent, id) { return { status: runs.get(id)?.status }; },
    async stopCodingTask(agent, id, boundary) { stopped.push({ agent, id, boundary }); return { stopped: true }; },
  } };
}
async function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-coding-api-")));
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const p = provider();
  const reach = await createReach({ roots: [project], dataDir: path.join(dir, "private"), agentSessions: p.sessions });
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const first = reach.auth.issue("Grok", ["device", "codex"], "agent");
  const second = reach.auth.issue("Muse", ["device", "codex"], "agent");
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const call = async (route, token = first.token, method = "GET", body) => {
    const response = await fetch(url + route, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { dir, project, reach, first, second, owner, call, ...p,
    input: (requestId = "api-request-one") => ({ requestId, agent: "codex", root: 0, path: "", task: "Fix only the disposable fixture" }) };
}

test("coding-task HTTP routes create, poll, isolate and cancel one delegated turn", async t => {
  const h = await fixture(t);
  const start = await h.call("/api/coding-tasks", h.first.token, "POST", h.input());
  assert.equal(start.status, 202, JSON.stringify(start.body));
  await until(() => h.runs.size === 1);
  const id = start.body.id;
  assert.equal((await h.call("/api/coding-tasks", h.first.token, "POST", h.input())).body.id, id);
  assert.equal(h.runs.size, 1);
  assert.equal((await h.call("/api/coding-tasks")).body.tasks[0].id, id);
  assert.deepEqual((await h.call("/api/coding-tasks", h.second.token)).body.tasks, []);
  assert.equal((await h.call(`/api/coding-tasks/${id}`, h.second.token)).status, 404);
  assert.equal((await h.call(`/api/coding-tasks/${id}/cancel`, h.second.token, "POST", {})).status, 404);
  assert.equal((await h.call(`/api/coding-tasks/${id}?after=-1`)).status, 400);
  assert.equal((await h.call(`/api/coding-tasks/${id}?waitSeconds=26`)).status, 400);
  for (const query of ["after=", "after=1.5", "after=0&after=1", "after=0x10", "threadId=owner", "waitSeconds=1e1"])
    assert.equal((await h.call(`/api/coding-tasks/${id}?${query}`)).status, 400, query);
  const run = [...h.runs.values()][0];
  run.status = "waiting";
  const waiting = await h.call(`/api/coding-tasks/${id}`);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.needsOwner, true);
  assert.equal(JSON.stringify(waiting.body).includes(run.threadId), false);
  assert.equal((await h.call(`/api/sessions/codex/${run.threadId}`)).status, 403);
  assert.equal((await h.call(`/api/sessions/codex/${run.threadId}/respond`, h.first.token, "POST", { answer: "approve" })).status, 403);
  const cancelled = await h.call(`/api/coding-tasks/${id}/cancel`, h.first.token, "POST", {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(h.stopped[0].boundary.turnId, run.turnId);
});

test("coding API rejects permission injection, Claude escalation and projects outside roots", async t => {
  const h = await fixture(t);
  for (const patch of [{ mode: "full-access" }, { agent: "claude" }, { path: "../private" }, { path: h.dir }, { root: 999 }]) {
    const result = await h.call("/api/coding-tasks", h.first.token, "POST", { ...h.input(), ...patch });
    assert.ok([400, 403].includes(result.status), JSON.stringify(result));
  }
  const filesOnly = h.reach.auth.issue("Files", ["device", "files:read"], "agent");
  assert.equal((await h.call("/api/coding-tasks", filesOnly.token, "POST", h.input())).status, 403);
  assert.equal(h.runs.size, 0);
  // Symlink creation on Windows needs host privileges; path traversal above
  // still runs there. This case validates a real macOS/Linux filesystem link.
  if (process.platform !== "win32") {
    fs.symlinkSync(h.dir, path.join(h.project, "outside"), "dir");
    assert.equal((await h.call("/api/coding-tasks", h.first.token, "POST", { ...h.input(), path: "outside" })).status, 403);
    assert.equal(h.runs.size, 0);
  }
});

test("coding creation has an independent per-agent budget that excludes invalid callers", async t => {
  const h = await fixture(t);
  for (let i = 0; i < 21; i++) {
    assert.equal((await h.call("/api/coding-tasks", "invalid", "POST", h.input())).status, 401);
    assert.equal((await h.call("/api/coding-tasks/unknown", "invalid")).status, 401);
  }
  assert.equal(h.runs.size, 0);
  assert.equal(h.reads.length, 0, "invalid authentication never reaches provider work");
  for (let i = 0; i < 20; i++) assert.equal((await h.call("/api/coding-tasks", h.first.token, "POST", h.input())).status, 202);
  const blocked = await h.call("/api/coding-tasks", h.first.token, "POST", h.input());
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.match(blocked.body.error, /Try again/i);
  assert.equal(h.runs.size, 1, "idempotent retries never launch another provider task");
  assert.equal((await h.call("/api/coding-tasks", h.second.token, "POST", h.input())).status, 202, "agents on the same socket have independent budgets");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(60_001);
  assert.equal((await h.call("/api/coding-tasks", h.first.token, "POST", h.input())).status, 202, "the budget recovers after its window");
});

test("coding list and get share a read budget without starving cancellation or another agent", async t => {
  const h = await fixture(t);
  const created = await h.call("/api/coding-tasks", h.first.token, "POST", h.input());
  assert.equal(created.status, 202);
  await until(() => h.runs.size === 1);
  const route = `/api/coding-tasks/${created.body.id}`;
  for (let i = 0; i < 120; i++) assert.equal((await h.call(i % 2 ? route : "/api/coding-tasks")).status, 200);
  for (const target of [route, "/api/coding-tasks"]) {
    const blocked = await h.call(target);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  }
  assert.equal((await h.call(route + "/cancel", h.first.token, "POST", {})).status, 200, "polling cannot exhaust the cancellation budget");
  assert.equal(h.stopped.length, 1);
  assert.equal((await h.call("/api/coding-tasks", h.second.token)).status, 200);
});

test("coding cancellation has its own per-agent budget", async t => {
  const h = await fixture(t);
  const created = await h.call("/api/coding-tasks", h.first.token, "POST", h.input());
  assert.equal(created.status, 202);
  await until(() => h.runs.size === 1);
  const route = `/api/coding-tasks/${created.body.id}/cancel`;
  for (let i = 0; i < 60; i++) assert.equal((await h.call(route, h.first.token, "POST", {})).status, 200);
  const blocked = await h.call(route, h.first.token, "POST", {});
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(h.stopped.length, 1, "repeated cancellation never interrupts another turn");
  assert.equal((await h.call(route, h.second.token, "POST", {})).status, 404, "a different agent keeps its own quota and still cannot cancel this task");
  assert.equal((await h.call("/api/coding-tasks")).status, 200, "cancellation does not consume reads");
});

test("coding creation keeps the same budget after an admitted Full control agent rotates credentials", privateIngressTest, async t => {
  const p = provider();
  const f = await presetFixture(t, { overrides: { agentSessions: p.sessions } });
  const agent = await f.join({ preset: "full", folders: [{ root: 0, path: "Desktop/Project" }] });
  const body = { requestId: "rotation-rate-limit", agent: "codex", task: "Inspect the disposable fixture", root: 0, path: "" };
  for (let i = 0; i < 20; i++) assert.equal((await agent.as("/api/coding-tasks", { method: "POST", body })).status, 202);
  const rotated = await agent.as("/api/device/rotate", { method: "POST", body: {} });
  assert.equal(rotated.status, 200);
  assert.equal((await f.call("/api/coding-tasks", { node: "nAgent", token: rotated.body.token, method: "POST", body })).status, 429);
  assert.equal(p.runs.size, 1);
});

test("HTTP access revocation interrupts delegated work", async t => {
  const h = await fixture(t);
  const start = await h.call("/api/coding-tasks", h.first.token, "POST", h.input("rotate-request"));
  assert.equal(start.status, 202);
  await until(() => h.runs.size === 1);
  const revoke = await h.call(`/api/clients/${h.first.clientId}`, h.owner.token, "DELETE");
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  await until(() => h.stopped.length === 1);
  assert.equal((await h.call(`/api/coding-tasks/${start.body.id}`, h.first.token)).status, 401);
});

test("Full control can delegate Claude; owner pause and supervising-device loss end its task", privateIngressTest, async t => {
  const p = provider();
  const f = await presetFixture(t, { overrides: { agentSessions: p.sessions } });
  const grok = await f.join({ preset: "full", folders: [{ root: 0, path: "Desktop/Project" }] });
  const start = await grok.as("/api/coding-tasks", { method: "POST", body: { requestId: "full-claude-one", agent: "claude", task: "Edit the disposable project", root: 0, path: "" } });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  await until(() => p.runs.size === 1);
  const rotated = await grok.as("/api/device/rotate", { method: "POST", body: {} });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal((await f.call(`/api/coding-tasks/${start.body.id}`, { node: "nAgent", token: rotated.body.token })).status, 200, "rotation preserves the creating client ID");
  const paused = await f.call("/api/browser/agents/pause", { method: "POST", body: { clientId: grok.created.clientId, paused: true } });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  await until(() => p.stopped.length === 1);
  assert.equal((await grok.as(`/api/coding-tasks/${start.body.id}`)).body.status, "cancelled", "a paused agent can still read its own result");
  const blocked = await grok.as("/api/coding-tasks", { method: "POST", body: { requestId: "paused-claude", agent: "claude", task: "This must not start" } });
  assert.equal(blocked.status, 409);
  await f.call("/api/browser/agents/pause", { method: "POST", body: { clientId: grok.created.clientId, paused: false } });
  const next = await grok.as("/api/coding-tasks", { method: "POST", body: { requestId: "owner-device-loss", agent: "claude", task: "Another disposable task" } });
  assert.equal(next.status, 202, JSON.stringify(next.body));
  await until(() => p.runs.size === 2);
  f.reach.auth.revoke(f.owners.nPhone.clientId);
  await f.reach.codingTasks.sweep();
  await until(() => p.stopped.length === 2);
  assert.equal(p.stopped.length, 2);
});
