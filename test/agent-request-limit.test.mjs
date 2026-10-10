import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";

test("access requests are limited per visitor and a missing body is a 400", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-req-limit-"));
  const reach = await createReach({
    roots: [tmp],
    dataDir: path.join(tmp, "private"),
    port: 0,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const ask = (ip) =>
    fetch(`${url}/api/agents/requests`, { method: "POST", headers: { "x-forwarded-for": ip } });
  for (let i = 0; i < 5; i++) assert.equal((await ask("100.64.0.1")).status, 400);
  assert.equal((await ask("100.64.0.1")).status, 429);
  assert.equal((await ask("100.64.0.2")).status, 400);
});

// Security audit L1: a Command line request is answered to the device that
// asked, and what the owner approves works from that device alone.
test("a Command line request is collected by the device that asked, and bound to it", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const http = await import("node:http");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-req-bind-"));
  const socketDir = await fs.mkdtemp("/tmp/reach-req-bind-");
  const socketPath = path.join(socketDir, "s");
  const owner = { userId: "42", login: "o@example.test" };
  const node = (id, tags) => ({ Node: { StableID: id, User: 42, ...(tags ? { Tags: tags } : {}), Name: `${id}.t.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: owner.login } });
  const nodes = { "100.64.0.9": node("nPhone"), "100.64.0.30": node("nBuildBox"), "100.64.0.31": node("nOther") };
  const reach = await createReach({ roots: [tmp], dataDir: path.join(tmp, "private"), port: 0, tailscaleOwner: owner,
    tailscaleIdentity: { lookup: async (ip) => nodes[ip] }, agentPolicyFile: path.join(tmp, "none.json") });
  await reach.listenPrivate(socketPath);
  t.after(async () => { await reach.close(); await fs.rm(tmp, { recursive: true, force: true }); await fs.rm(socketDir, { recursive: true, force: true }); });
  const phone = reach.auth.issue("My iPhone", ["admin", "device"], "device", { tailscale: { userId: "42", nodeId: "nPhone" } });
  const call = (route, from, { method = "GET", body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: { Host: "localhost", "X-Forwarded-For": from,
      "Tailscale-User-Login": owner.login, ...(body ? { "Content-Type": "application/json" } : {}), ...headers } },
    (res) => { let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "null") })); });
    req.once("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const asked = await call("/api/agents/requests", "100.64.0.30", { method: "POST", body: { name: "Build box", scopes: ["files:read"] } });
  assert.equal(asked.status, 202, JSON.stringify(asked.json));
  const listed = await call("/api/agents/requests", "100.64.0.9", { headers: { Authorization: `Bearer ${phone.token}` } });
  assert.equal(listed.json[0].nodeName, "nBuildBox.t.ts.net", "you see which device asks");
  assert.equal(listed.json[0].asker, undefined);
  const decided = await call(`/api/agents/requests/${asked.json.id}`, "100.64.0.9", { method: "POST", body: { decision: "approve" }, headers: { Authorization: `Bearer ${phone.token}` } });
  assert.equal(decided.status, 200, JSON.stringify(decided.json));
  const status = (from) => call(`/api/agents/requests/${asked.json.id}/status`, from, { headers: { "x-request-secret": asked.json.secret } });
  assert.equal((await status("100.64.0.31")).status, 404, "another device with the secret gets nothing");
  const collected = await status("100.64.0.30");
  assert.equal(collected.json.status, "approved");
  const browse = (from) => call("/api/files?root=0&path=", from, { headers: { Authorization: `Bearer ${collected.json.token}` } });
  assert.equal((await browse("100.64.0.31")).status, 401, "the credential works from the device that asked only");
  assert.notEqual((await browse("100.64.0.30")).status, 401);
});
