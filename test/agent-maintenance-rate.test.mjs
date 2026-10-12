import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("installer and updater probes share a per-device budget before expensive work", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-maintenance-rate-"));
  let probes = 0, terminals = 0;
  const plan = async agent => {
    probes++;
    return { agent, name: "Codex", command: "synthetic-command-never-run", from: "1.0.0", to: "1.0.1" };
  };
  const reach = await createReach({
    roots: [root], dataDir: path.join(root, "private"), screen: false,
    agentInstallPlan: plan,
    agentUpdates: { plan, list: async () => { probes++; return []; } },
    terminals: { create() { terminals++; return { id: "unexpected" }; }, list: () => [], get: () => null, dispose() {} },
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { reach.server.closeAllConnections(); await reach.close(); await fs.rm(root, { recursive: true, force: true }); });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const second = reach.auth.issue("Second owner device", ALL_SCOPES);
  const url = `http://127.0.0.1:${reach.server.address().port}/api/sessions/`;
  const request = (route, token = owner.token, headers = {}, confirm = false) => fetch(url + route, {
    method: route === "agent-updates" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    ...(route === "agent-updates" ? {} : { body: JSON.stringify({ confirm }) }),
  });
  // Unauthenticated traffic cannot consume an approved device's quota.
  for (let i = 0; i < 35; i++) assert.equal((await request("agent-update/codex", "invalid")).status, 401);
  const routes = ["agent-update/codex", "agent-install/codex", "agent-updates"];
  for (let i = 0; i < 30; i++) assert.equal((await request(routes[i % routes.length])).status, 200);
  assert.equal(probes, 30);
  for (const route of routes) {
    const blocked = await request(route, owner.token, { "X-Forwarded-For": "192.0.2.123" }, true);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.match((await blocked.json()).error, /Try again/);
  }
  assert.equal(probes, 30, "blocked requests do not discover binaries, query feeds or plan installs");
  assert.equal(terminals, 0, "rate-limited confirmations cannot create a terminal");
  assert.equal((await request("agent-update/codex", second.token)).status, 200);
  assert.equal(probes, 31, "another approved device on the same IP retains its own quota");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(60_001);
  assert.equal((await request("agent-update/codex")).status, 200, "the exhausted device recovers after its window");
  assert.equal(probes, 32);
});
