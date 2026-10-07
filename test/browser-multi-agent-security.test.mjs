import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

// These tests exercise the real HTTP authorization boundary. All grants point
// at disposable fixtures; no native capture, keyboard input or script runs.
async function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-multi-security-")));
  const root = path.join(dir, "project"), dataDir = path.join(dir, "private");
  fs.mkdirSync(root);
  const reach = await createReach({ roots: [root], dataDir, screen: false,
    desktopTerminals: { platform: "linux", run: async () => assert.fail("Native terminal use is forbidden") },
    browserCapture: async () => assert.fail("Desktop capture is forbidden"),
    browserInput: async () => assert.fail("Desktop input is forbidden"),
  });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const call = async (route, { token = owner.token, method = "GET", body } = {}) => {
    const result = await fetch(origin + route, { method, headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json().catch(() => null) };
  };
  const invite = (name = "Muse") => reach.auth.inviteBrowser({ name, ttlSeconds: 600,
    folders: [{ root: 0, path: "" }], screen: "off", restrictedTerminal: true, terminalApproval: true });
  const join = name => { const invitation = invite(name); return { ...admitAgent(reach.auth, invitation.invitation), invitation }; };
  const stop = (clientIds, token) => call("/api/browser/agents/stop", { token, method: "POST", body: { clientIds } });
  return { reach, owner, root, dataDir, call, invite, join, stop };
}

test("multi-agent owner APIs reject agent, guest and non-device credentials independently of scopes", async t => {
  const f = await fixture(t), muse = f.join("Muse");
  const deviceWithoutAdmin = f.reach.auth.issue("Limited device", ["device"]);
  const nonDevice = f.reach.auth.issue("Service credential", ALL_SCOPES, "service");
  const guest = f.reach.auth.issue("Guest", ALL_SCOPES, "guest");
  const store = path.join(f.dataDir, "clients.json"), clients = JSON.parse(fs.readFileSync(store));
  clients.find(client => client.id === guest.clientId).guestRoots = [f.root];
  atomicJson(store, clients);
  for (const credential of [muse, deviceWithoutAdmin, nonDevice, guest]) {
    assert.equal((await f.call("/api/browser/agents", { token: credential.token })).status, 403, credential.clientId);
    assert.equal((await f.stop([muse.clientId], credential.token)).status, 403, credential.clientId);
    assert.ok(f.reach.auth.verify(muse.token), "a rejected stop leaves the agent connected");
  }
});

test("stop validates every exact ID before revoking any browser session", async t => {
  const f = await fixture(t), one = f.join("Muse"), two = f.join("Other agent");
  for (const clientIds of [[], [one.clientId, one.clientId], [one.clientId, f.owner.clientId], [one.clientId, 17], [one.clientId, ""]]) {
    const response = await f.stop(clientIds);
    assert.ok([400, 403].includes(response.status), JSON.stringify(response));
    assert.ok(f.reach.auth.verify(one.token), "invalid mixed input cannot partially revoke the first ID");
    assert.ok(f.reach.auth.verify(two.token));
    assert.ok(f.reach.auth.verify(f.owner.token));
  }
});

test("stop shown sessions preserves invitations created after the overview snapshot", async t => {
  const f = await fixture(t), one = f.join("Muse"), pending = f.invite("Waiting agent");
  const overview = await f.call("/api/browser/agents");
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  const snapshot = overview.body.agents.map(agent => agent.id);
  assert.ok(snapshot.includes(one.clientId)); assert.ok(snapshot.includes(pending.clientId));
  const later = f.invite("Invited after snapshot");
  const ended = await f.stop(snapshot);
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.deepEqual(new Set(ended.body.stopped), new Set(snapshot));
  assert.deepEqual(ended.body.missing, []);
  assert.equal(f.reach.auth.verify(one.token), null);
  assert.throws(() => f.reach.auth.redeemGuest(pending.invitation), { status: 401 });
  assert.ok(admitAgent(f.reach.auth, later.invitation).token, "a newer invitation is not included in the old stop snapshot");
  const repeated = await f.stop(snapshot);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.stopped, []);
  assert.deepEqual(new Set(repeated.body.missing), new Set(snapshot));
});

test("owner overview exposes session summaries without admission secrets or credential metadata", async t => {
  const f = await fixture(t), one = f.join("Muse"), two = f.join("Muse"), invitation = f.invite("Not joined yet");
  const created = await f.call("/api/browser/requests", { token: one.token, method: "POST",
    body: { type: "terminal-change", root: 0, command: "touch summary.txt", reason: "Create a note" } });
  assert.equal(created.status, 201);
  const file = path.join(f.dataDir, "clients.json"), stored = JSON.parse(fs.readFileSync(file));
  stored.find(client => client.id === one.clientId).browserBinding = "internal-browser-binding";
  stored.find(client => client.id === one.clientId).internalMetadata = "private-host-metadata";
  atomicJson(file, stored);
  const result = await f.call("/api/browser/agents");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(new Set(result.body.agents.map(client => client.id)), new Set([one.clientId, two.clientId, invitation.clientId]));
  assert.equal(result.body.agents.find(client => client.id === one.clientId).pendingApprovals, 1);
  assert.equal(result.body.agents.find(client => client.id === two.clientId).pendingApprovals, 0);
  const encoded = JSON.stringify(result.body);
  for (const secret of [one.token, two.token, invitation.invitation, "internal-browser-binding", "private-host-metadata",
    ...stored.flatMap(client => [client.hash, client.inviteHash, client.admission?.secretHash]).filter(Boolean)])
    assert.ok(!encoded.includes(secret), "overview contains only explicit public session fields");
});

test("stopping one agent leaves another agent's pending approval and command history intact", async t => {
  const f = await fixture(t), one = f.join("Muse"), two = f.join("Muse");
  const request = async (agent, command) => {
    const value = await f.call("/api/browser/requests", { token: agent.token, method: "POST",
      body: { type: "terminal-change", root: 0, command, reason: "Create a project note" } });
    assert.equal(value.status, 201, JSON.stringify(value.body));
    return value.body;
  };
  const first = await request(one, "touch first.txt"), second = await request(two, "touch second.txt");
  assert.equal((await f.stop([one.clientId])).status, 200);
  const ownRequests = await f.call("/api/browser/requests", { token: two.token });
  assert.equal(ownRequests.status, 200);
  assert.equal(ownRequests.body.find(item => item.id === second.id)?.status, "pending");
  assert.ok(!ownRequests.body.some(item => item.id === first.id), "same display name never joins session identities");
  const ownerRequests = await f.call("/api/agents/browser-requests");
  assert.ok(!ownerRequests.body.some(item => item.id === first.id), "revoked approval no longer appears as pending");
  assert.equal(ownerRequests.body.find(item => item.id === second.id)?.status, "pending");
  const ownerHistory = await f.call("/api/agents/browser-terminal-history");
  assert.equal(ownerHistory.status, 200);
  assert.equal(ownerHistory.body.find(item => item.id === first.id)?.status, "revoked");
  const history = await f.call("/api/browser/terminal/history", { token: two.token });
  assert.equal(history.status, 200);
  const records = Array.isArray(history.body) ? history.body : history.body.commands;
  assert.ok(records.some(item => item.id === second.id));
  assert.ok(records.every(item => item.clientId === two.clientId));
});
