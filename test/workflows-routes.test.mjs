import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Workflows over HTTP (docs/WORKFLOWS.md) with the real engine: the owner's
// own devices only, at their own address (not read as a chat of an agent
// named "workflows"), each task started as a relay's step is.
const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${check}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("workflows are written, planned, run and stopped by the owner's devices only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-workflow-route-"));
  const started = [];
  const stopped = [];
  let n = 0;
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      read: async () => ({ session: { status: "running" }, items: [] }),
      start: async (agent, body) => (started.push({ agent, body }), { threadId: `${agent}-${++n}` }),
      send: async () => ({ turnId: "t" }),
      stop: async (agent, id) => (stopped.push(`${agent}:${id}`), {}),
      models: async () => ({ models: [], modes: [{ id: "auto" }], mode: null }),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const call = (route, body, token = owner.token) =>
    fetch(`${url}${route}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  // A new chat's folder must be in the home folder (the temporary one isn't).
  const home = os.homedir();
  const tasks = [
    { title: "Build it", agent: "codex", kind: "build", task: "Add /api/items." },
    { title: "Check it", agent: "claude", kind: "review", task: "Review /api/items." },
  ];
  try {
    assert.equal((await call("/api/sessions/workflows", { cwd: home, tasks }, agent.token)).status, 403);
    assert.equal((await call("/api/sessions/workflows", undefined, agent.token)).status, 403);
    // The disk's root: the temp folder can be inside home (CI runners).
    assert.equal((await call("/api/sessions/workflows", { cwd: path.parse(home).root, tasks })).status, 400, "outside the home folder");
    const made = await call("/api/sessions/workflows", { title: "Items API", cwd: home, tasks });
    assert.equal(made.status, 200, await made.clone().text());
    const { workflow } = await made.json();
    assert.equal(workflow.state, "draft");
    assert.equal(workflow.cwd, fs.realpathSync(home));
    assert.deepEqual(workflow.tasks.map((t) => [t.id, t.title, t.task]), [["t1", "Build it", "Add /api/items."], ["t2", "Check it", "Review /api/items."]]);
    // Listed without what each task says; in full at its own address, versioned.
    const listed = (await (await call("/api/sessions/workflows")).json()).workflows;
    assert.deepEqual(listed.map((w) => w.id), [workflow.id]);
    assert.equal(listed[0].tasks[0].task, undefined);
    assert.deepEqual((await (await call("/api/sessions")).json()).workflows.map((w) => w.id), [workflow.id], "the chat list carries them");
    const full = await (await call(`/api/sessions/workflows/${workflow.id}`)).json();
    assert.equal(full.tasks[1].task, "Review /api/items.");
    assert.deepEqual(await (await call(`/api/sessions/workflows/${workflow.id}?known=${full.version}`)).json(), { unchanged: true, version: full.version });
    // Edited, then run: the first task starts as a relay's builder does.
    const edited = await (await call(`/api/sessions/workflows/${workflow.id}`, { tasks: [workflow.tasks[0], { ...workflow.tasks[1], together: true }] })).json();
    assert.equal(edited.workflow.tasks[1].together, true);
    assert.equal((await call(`/api/sessions/workflows/${workflow.id}/run`, {}, agent.token)).status, 403);
    const ran = await call(`/api/sessions/workflows/${workflow.id}/run`, {});
    assert.equal(ran.status, 200, await ran.clone().text());
    await waitFor(() => started.length === 2);
    assert.deepEqual(started.map((s) => s.agent), ["codex", "claude"], "together: both at once (one builds, one reads)");
    assert.equal(started[0].body.modeName, "auto");
    assert.equal(started[0].body.keepOut, true);
    assert.equal(started[0].body.name, "Workflow · Build it");
    assert.equal(started[1].body.mode, "manual");
    assert.equal((await call(`/api/sessions/workflows/${workflow.id}/run`, {})).status, 409, "once");
    assert.equal((await call(`/api/sessions/workflows/${workflow.id}/tasks/t1/retry`, {})).status, 409, "not stopped");
    assert.equal((await call(`/api/sessions/workflows/${workflow.id}/tasks/t1/explode`, {})).status, 404);
    // Stopped: its chats at work stop; a copy runs again.
    assert.deepEqual(await (await call(`/api/sessions/workflows/${workflow.id}/stop`, {})).json(), { stopped: true });
    assert.deepEqual(stopped.sort(), ["claude-2", "codex-1"].map((id) => `${id.split("-")[0]}:${id}`).sort());
    const copy = (await (await call(`/api/sessions/workflows/${workflow.id}/again`, {})).json()).workflow;
    assert.equal(copy.state, "draft");
    assert.deepEqual(await (await call(`/api/sessions/workflows/${copy.id}/remove`, {})).json(), { removed: true });
    // Planned: the planner reads only, whatever mode was asked for.
    const planned = await call("/api/sessions/workflows/plan", { agent: "claude", cwd: home, text: "Plan pagination", mode: "bypassPermissions" });
    assert.equal(planned.status, 200, await planned.clone().text());
    const { workflow: draft, threadId } = await planned.json();
    assert.equal(threadId, "claude-3");
    assert.equal(draft.planner.working, true);
    assert.equal(started.at(-1).body.mode, "manual");
    assert.match(started.at(-1).body.text, /^Plan pagination\n\nPlan this as a workflow in Reach/);
    assert.equal((await call("/api/sessions/workflows/plan", { agent: "gemini", cwd: home, text: "x" })).status, 400);
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
