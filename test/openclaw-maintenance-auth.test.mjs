import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("accepted OpenClaw maintenance survives its HTTP response but not credential revocation", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "reach-claw-maintenance-"),
  );
  let release,
    afterResponse,
    performed = 0;
  const reach = await createReach({
    dataDir: path.join(dir, "state"),
    roots: [dir],
    screen: false,
    agentSessions: { list: async () => ({ sessions: [] }), close() {} },
    openClaw: { overview: async () => ({ connected: false }), close() {} },
    openClawMaintenance: async (_action, { authorize }) => {
      afterResponse = authorize;
      await new Promise((resolve) => {
        release = resolve;
      });
      authorize();
      performed++;
      return { status: "done", message: "Checked", lines: ["Complete"] };
    },
  });
  t.after(async () => {
    release?.();
    await reach.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const observer = reach.auth.issue("Observer", ALL_SCOPES);
  const call = async (route, body, token = owner.token) => {
    const response = await fetch(
      origin + "/api/sessions/openclaw/health/" + route,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const action of ["doctor", "update", "repair"]) {
    assert.equal((await call(action, { confirm: true })).job.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotThrow(
      () => afterResponse(),
      "completing the HTTP response does not revoke access",
    );
    release();
    for (let i = 0; i < 30; i++) {
      const { job } = await call("maintenance");
      if (job.status !== "running") {
        assert.equal(job.status, "done");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(performed, 3);
  await call("doctor", { confirm: true });
  reach.auth.revoke(owner.clientId);
  assert.throws(() => afterResponse(), /expired or was revoked/);
  release();
  for (let i = 0; i < 30; i++) {
    const { job } = await call("maintenance", null, observer.token);
    if (job.status !== "running") {
      assert.equal(job.status, "failed");
      assert.match(job.message, /expired or was revoked/);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    performed,
    3,
    "revoked maintenance cannot perform its next step",
  );
});

test("dependency approval requires the owner and stays revocable after its HTTP response", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claw-dependency-"));
  let release, installing = false, steps = 0;
  const reach = await createReach({
    dataDir: path.join(dir, "state"), roots: [dir], screen: false,
    agentSessions: { list: async () => ({ sessions: [] }), close() {} },
    openClaw: { overview: async () => ({ connected: false }), close() {} },
    openClawMaintenance: async (_action, { authorize }) => {
      authorize(); steps++;
      return { status: "failed", lines: [], recovery: { kind: "node", available: true, title: "Upgrade Node", steps: [], description: "Needs Node" } };
    },
    openClawRuntimeInstall: async (_recipe, { authorize }) => {
      authorize(); installing = true;
      await new Promise(resolve => { release = resolve; });
      authorize(); return "/fixture/node";
    },
  });
  t.after(async () => { release?.(); await reach.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${reach.server.address().port}/api/sessions/openclaw/health/`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const limited = reach.auth.issue("Limited", ["codex"]);
  const observer = reach.auth.issue("Observer", ALL_SCOPES);
  const call = async (route, body, token = owner.token) => {
    const res = await fetch(origin + route, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  await call("update", { confirm: true });
  let job;
  for (let i = 0; i < 30; i++) {
    job = (await call("maintenance")).body.job;
    if (job.status === "awaiting_approval") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, "awaiting_approval");
  const approval = { jobId: job.id, confirm: true };
  assert.equal((await call("maintenance/continue", approval, limited.token)).status, 403);
  assert.equal(installing, false);
  assert.equal((await call("maintenance/continue", approval)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(installing, true, "approval starts its job after the response closes");
  reach.auth.revoke(owner.clientId);
  release();
  for (let i = 0; i < 30; i++) {
    job = (await call("maintenance", null, observer.token)).body.job;
    if (job.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, "failed");
  assert.match(job.message, /expired or was revoked/);
  assert.equal(steps, 1, "revocation prevents retry, service edits, and migrations");
});
