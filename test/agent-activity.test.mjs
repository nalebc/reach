import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approveAgentClaim } from "./helpers/agent-admission.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Who is using their access: the owner's list (Agents & people) shows each
// invited agent and person as active or idle, from when they last used it.
// An agent's hourly key trade is not use.

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-activity-"));
  const files = path.join(dir, "files");
  fs.mkdirSync(path.join(files, "Projects"), { recursive: true });
  const reach = await createReach({ roots: [files], dataDir: path.join(dir, "private"), agentPolicyFile: path.join(dir, "agent-policy.json") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { call, owner };
}

test("an agent's use marks it active in the owner's list; its key trade and the owner's own requests don't", async (t) => {
  const { call, owner } = await start(t);
  const created = await call("/api/agents/invitations", {
    method: "POST",
    body: { name: "Builder", ttlSeconds: 7 * 86400, folders: [{ root: 0, path: "Projects" }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listed = async () => (await call("/api/clients")).body.clients;
  const builder = async () => (await listed()).find((c) => c.id === created.body.clientId);
  assert.equal((await builder()).activeAt, undefined, "never used yet");

  const joined = await approveAgentClaim(call, await call("/api/invitations/redeem", { token: "", method: "POST", body: { invitation: created.body.invitation } }));
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const before = Date.now();
  assert.equal((await call("/api/device", { token: joined.body.token })).status, 200);
  const used = (await builder()).activeAt;
  assert.ok(used >= before && used <= Date.now(), String(used));

  await new Promise((r) => setTimeout(r, 15));
  await call("/api/device/rotate", { token: joined.body.token, method: "POST", body: {} });
  assert.equal((await builder()).activeAt, used, "the hourly key trade isn't use");

  const me = (await listed()).find((c) => c.id === owner.clientId);
  assert.ok(me, "the owner's device is listed");
  assert.equal(me.activeAt, undefined, "only invited people and agents");
});
