import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PACKAGE, createReachUpdates } from "../server/reach-updates.mjs";

// The Mac's side of Reach's own updates, through a real Reach server: only
// the owner sees and installs it, Needs you offers it once per version, and
// agents aren't told of the new runtime until the new server runs it. Also:
// which runtime each agent runs, in Agents & people. npm is a stand-in.
test("Reach's own update: owner only, offered once, agents held back until the restart", { timeout: 30000 }, async (t) => {
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-update-routes-"));
  const agentRuntimeFile = path.join(dir, "agent.mjs");
  fs.writeFileSync(agentRuntimeFile, "// the runtime\n");
  const served = crypto.createHash("sha256").update("// the runtime\n").digest("hex");
  const runs = [];
  let restarted = 0;
  const reachUpdates = createReachUpdates({
    root: dir, dataDir: path.join(dir, "private"),
    install: { source: false, version: "0.1.0", name: PACKAGE, prefix: "/opt/homebrew", npm: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js" },
    fetch: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ latest: "0.2.0" }) }),
    spawn: (file, args) => { const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} }); runs.push({ file, args, child }); return child; },
    restart: () => restarted++, readVersion: () => "0.2.0",
  });
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), port: 0, agentRuntimeFile, agentPolicyFile: path.join(dir, "none.json"), reachUpdates });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("Builder", ["files:read"], "agent");
  const call = (method, route, token, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: reach.server.address().port, path: route, method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text || "null") }));
    });
    req.once("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  // Only the owner's admin device.
  const status = await call("GET", "/api/reach/update?fresh=1", owner.token);
  assert.equal(status.status, 200);
  assert.deepEqual([status.body.state, status.body.to, status.body.version], ["available", "0.2.0", "0.1.0"]);
  assert.equal((await call("GET", "/api/reach/update", agent.token)).status, 403);
  assert.equal((await call("POST", "/api/reach/update", agent.token, { action: "install", version: "0.2.0" })).status, 403);
  assert.equal(runs.length, 0);

  // Needs you: the card, Not now, and it's gone for that version.
  const needs = (await call("GET", "/api/notifications", owner.token)).body.items.filter((item) => item.source === "update");
  assert.deepEqual(needs.map((item) => [item.id, item.title]), [["update:0.2.0", "Update Reach to 0.2.0"]]);
  assert.equal((await call("POST", "/api/notifications/update%3A0.2.0/actions", agent.token, { revision: needs[0].revision, action: "update" })).status, 403);
  const denied = await call("POST", "/api/notifications/update%3A0.2.0/actions", owner.token, { revision: needs[0].revision, action: "deny" });
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  assert.deepEqual((await call("GET", "/api/notifications", owner.token)).body.items.filter((item) => item.source === "update"), []);
  assert.equal((await call("GET", "/api/reach/update", owner.token)).body.state, "available", "still in Settings");

  // Agents & people: which runtime the agent runs.
  assert.equal((await call("GET", "/api/device", agent.token)).body.runtime, served);
  await call("GET", `/api/device?runtime=${served}`, agent.token);
  const listed = (await call("GET", "/api/clients", owner.token)).body.clients.find((client) => client.id === agent.clientId || client.name === "Builder");
  assert.equal(listed.runtime, "current");
  await call("GET", `/api/device?runtime=${"b".repeat(64)}`, agent.token);
  assert.equal((await call("GET", "/api/clients", owner.token)).body.clients.find((client) => client.name === "Builder").runtime, "updating");

  // Installing: exactly that version; agents hear nothing of the files on
  // disk until the new server runs them.
  assert.equal((await call("POST", "/api/reach/update", owner.token, { action: "install", version: "0.3.0" })).status, 409);
  const started = await call("POST", "/api/reach/update", owner.token, { action: "install", version: "0.2.0" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.state, "installing");
  assert.deepEqual(runs[0].args.slice(1), ["install", "--global", "--prefix", "/opt/homebrew", "--no-fund", "--no-audit", `${PACKAGE}@0.2.0`]);
  assert.equal((await call("GET", "/api/device", agent.token)).body.runtime, undefined);
  assert.equal((await call("GET", "/api/device/runtime", agent.token)).status, 503);
  runs[0].child.emit("exit", 0);
  assert.equal(restarted, 1, "Reach starts again on it");
  assert.equal((await call("GET", "/api/reach/update", owner.token)).body.state, "restarting");
  assert.equal((await call("GET", "/api/device", agent.token)).body.runtime, undefined);
});
