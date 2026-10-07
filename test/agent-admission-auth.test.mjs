import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, hash } from "../server/core.mjs";

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-admission-")));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  const config = { dataDir: path.join(dir, "private"), roots: [shared], agentPolicyFile: path.join(dir, "policy.json") };
  const auth = createAuth(config);
  const identity = { nodeId: "vm-1", nodeName: "Muse VM", userId: "", tagged: true, validUntil: Date.now() + 600000 };
  const browser = (input = {}) => auth.inviteBrowser({ name: "Muse", ttlSeconds: 3600, screen: "ask", commandRequests: true, ...input });
  const cli = (input = {}) => auth.inviteAgent({ name: "CLI", ttlSeconds: 3600, folders: [{ root: 0, path: "" }], exec: true, ...input });
  const claim = (grant = browser(), source = identity) => auth.redeemGuest(grant.invitation, source);
  const poll = (receipt, source = identity) => auth.pollAgentAdmission(receipt.requestId, receipt.requestSecret, source);
  const read = () => JSON.parse(fs.readFileSync(path.join(config.dataDir, "clients.json"), "utf8"));
  const alter = (change) => { const clients = read(); change(clients); fs.writeFileSync(path.join(config.dataDir, "clients.json"), JSON.stringify(clients)); };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, shared, config, auth, identity, browser, cli, claim, poll, read, alter };
}

test("both browser and CLI invitations first claim a powerless single-use receipt", (t) => {
  const f = fixture(t);
  for (const grant of [f.browser(), f.cli()]) {
    const receipt = f.claim(grant);
    assert.equal(receipt.status, "pending");
    assert.equal(receipt.kind, "agent");
    assert.equal(receipt.clientId, grant.clientId);
    assert.equal(receipt.token, undefined);
    assert.match(receipt.requestSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.match(receipt.verificationCode, /^\d{6}$/);
    assert.ok(receipt.expiresAt <= Date.now() + 300000);
    assert.equal(f.auth.verify(receipt.requestSecret, f.identity), null);
    assert.equal(f.auth.verify(grant.invitation, f.identity), null);
    assert.equal(f.poll(receipt).status, "pending");
    assert.throws(() => f.claim(grant), { status: 401 });
    const stored = f.read().find((c) => c.id === grant.clientId);
    assert.equal(stored.hash, undefined);
    assert.equal(stored.inviteHash, undefined);
    assert.equal(stored.admission.secretHash, hash(receipt.requestSecret));
    assert.equal(JSON.stringify(stored).includes(receipt.requestSecret), false);
    assert.equal(f.auth.list().find((c) => c.id === grant.clientId).status, "pending");
  }
});

test("owner review includes exact grants and excludes authentication material", (t) => {
  const f = fixture(t);
  const receipt = f.claim(f.browser({ folders: [{ root: 0, path: "" }], terminalIds: ["reach:one"] }));
  const [review] = f.auth.listAgentAdmissions();
  assert.equal(review.requestId, receipt.requestId);
  assert.equal(review.verificationCode, receipt.verificationCode);
  assert.equal(review.browser, true);
  assert.equal(review.screen, "ask");
  assert.equal(review.commandRequests, true);
  assert.deepEqual(review.terminalIds, ["reach:one"]);
  assert.deepEqual(review.roots, [f.shared]);
  assert.equal(review.nodeName, "Muse VM");
  assert.equal(review.nodeId, f.identity.nodeId);
  const publicData = JSON.stringify([f.auth.list(), f.auth.listAgentAdmissions()]);
  assert.equal(publicData.includes(receipt.requestSecret), false);
  assert.equal(publicData.includes(hash(receipt.requestSecret)), false);
  assert.equal(publicData.includes("secretHash"), false);
  assert.equal(publicData.includes('"admission":'), false);
  review.scopes.push("admin");
  review.roots.push("/");
  assert.equal(f.auth.listAgentAdmissions()[0].scopes.includes("admin"), false);
  assert.deepEqual(f.auth.listAgentAdmissions()[0].roots, [f.shared]);
});

test("owner approval permits one collection and never extends the chosen deadline", (t) => {
  const f = fixture(t);
  const grant = f.browser({ ttlSeconds: 60 });
  const receipt = f.claim(grant);
  assert.equal(receipt.expiresAt, grant.expiresAt);
  assert.equal(f.auth.decideAgentAdmission(receipt.requestId, "approve").status, "approved");
  assert.equal(f.auth.list().find((c) => c.id === grant.clientId).status, "approved");
  assert.deepEqual(f.auth.listAgentAdmissions(), []);
  assert.equal(f.auth.verify(receipt.requestSecret, f.identity), null);
  assert.equal(f.read()[0].hash, undefined, "owner approval itself cannot issue access");
  const access = f.poll(receipt);
  assert.equal(access.status, "approved");
  assert.equal(access.clientId, grant.clientId);
  assert.equal(access.expiresAt, grant.expiresAt);
  assert.notEqual(access.token, receipt.requestSecret);
  assert.deepEqual(access.scopes, grant.scopes);
  assert.equal(f.auth.verify(access.token, f.identity).id, grant.clientId);
  assert.equal(f.auth.verify(access.token), null);
  assert.equal(f.auth.list()[0].status, "accepted");
  assert.throws(() => f.poll(receipt), { status: 409 });
  assert.throws(() => f.auth.decideAgentAdmission(receipt.requestId, "approve"), { status: 409 });
  assert.equal(JSON.stringify(f.read()).includes(access.token), false);
});

test("uncollected admissions deny injected token hashes even after approval", (t) => {
  const f = fixture(t);
  const receipt = f.claim();
  const token = "x".repeat(43);
  f.alter((clients) => { clients[0].hash = hash(token); });
  assert.equal(f.auth.verify(token, f.identity), null);
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  assert.equal(f.auth.verifyDigest(hash(token), f.identity), null);
});

test("receipt polling is bound to the claimant identity and cannot use the comparison code", (t) => {
  const f = fixture(t);
  const receipt = f.claim();
  for (const identity of [undefined, { ...f.identity, nodeId: "other" }, { ...f.identity, userId: "other" }, { ...f.identity, validUntil: Date.now() - 1 }])
    assert.throws(() => f.auth.pollAgentAdmission(receipt.requestId, receipt.requestSecret, identity), { status: 401 });
  assert.throws(() => f.auth.pollAgentAdmission(receipt.requestId, receipt.verificationCode, f.identity), { status: 401 });
  assert.throws(() => f.auth.pollAgentAdmission(receipt.requestId, "x".repeat(43), f.identity), { status: 401 });
  assert.equal(f.poll(receipt).status, "pending");
  const grant = f.browser();
  assert.throws(() => f.claim(grant, { ...f.identity, validUntil: Date.now() - 1 }), { status: 401 });
  assert.equal(f.claim(grant).status, "pending", "a rejected identity never consumes the link");
});

test("denial, revocation, and expiration cannot issue a credential", (t) => {
  const f = fixture(t);
  const denied = f.claim();
  f.auth.decideAgentAdmission(denied.requestId, "deny");
  assert.equal(f.poll(denied).status, "denied");
  assert.equal(f.auth.list()[0].status, "denied");
  assert.throws(() => f.auth.decideAgentAdmission(denied.requestId, "approve"), { status: 409 });
  const revoked = f.claim();
  f.auth.revoke(revoked.clientId);
  assert.equal(f.poll(revoked).status, "expired");
  assert.throws(() => f.auth.decideAgentAdmission(revoked.requestId, "approve"), { status: 404 });
  for (const approve of [false, true]) {
    const expired = f.claim();
    if (approve) f.auth.decideAgentAdmission(expired.requestId, "approve");
    f.alter((clients) => { clients.find((c) => c.id === expired.clientId).admission.expiresAt = Date.now() - 1; });
    assert.equal(f.poll(expired).status, "expired");
    assert.equal(f.auth.list().find((c) => c.id === expired.clientId).status, "expired");
    assert.throws(() => f.auth.decideAgentAdmission(expired.requestId, "approve"), { status: 409 });
  }
  assert.equal(f.read().some((c) => c.hash), false);
});

test("owner review stays bound to the original grant before collection", (t) => {
  const f = fixture(t);
  const receipt = f.claim(f.cli());
  assert.throws(() => f.auth.changeAccess(receipt.clientId, { folders: "keep", exec: false }), { status: 409 });
  f.alter((clients) => { clients[0].scopes.push("admin"); });
  assert.deepEqual(f.auth.listAgentAdmissions(), []);
  assert.throws(() => f.auth.decideAgentAdmission(receipt.requestId, "approve"), { status: 409 });
  assert.equal(f.poll(receipt).status, "expired");
  const approved = f.claim();
  f.auth.decideAgentAdmission(approved.requestId, "approve");
  f.alter((clients) => { clients.find((c) => c.id === approved.clientId).policy.commandRequests = false; });
  assert.equal(f.poll(approved).status, "expired");
});

test("claims and decisions survive restart without replaying token collection", (t) => {
  const f = fixture(t);
  const grant = f.browser();
  const receipt = f.claim(grant);
  const restarted = createAuth(f.config, { rotatePairing: false });
  assert.equal(restarted.listAgentAdmissions()[0].requestId, receipt.requestId);
  assert.throws(() => restarted.redeemGuest(grant.invitation, f.identity), { status: 401 });
  restarted.decideAgentAdmission(receipt.requestId, "approve");
  const again = createAuth(f.config, { rotatePairing: false });
  const access = again.pollAgentAdmission(receipt.requestId, receipt.requestSecret, f.identity);
  const last = createAuth(f.config, { rotatePairing: false });
  assert.equal(last.verify(access.token, f.identity).id, receipt.clientId);
  assert.throws(() => last.pollAgentAdmission(receipt.requestId, receipt.requestSecret, f.identity), { status: 409 });
});

test("admission pressure is bounded per source and global capacity", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.claim();
  const fourth = f.browser();
  assert.throws(() => f.claim(fourth), { status: 429 });
  f.auth.decideAgentAdmission(f.auth.listAgentAdmissions()[0].requestId, "deny");
  assert.equal(f.claim(fourth).status, "pending");
  for (let i = 0; i < 17; i++) f.claim(f.browser(), { ...f.identity, nodeId: `node-${i}` });
  const excess = f.browser();
  assert.throws(() => f.claim(excess, { ...f.identity, nodeId: "excess" }), { status: 429 });
});

test("denying claims does not release their per-minute notification budget", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) {
    const receipt = f.claim();
    f.auth.decideAgentAdmission(receipt.requestId, "deny");
  }
  assert.throws(() => f.claim(), { status: 429 });
});

test("ordinary people invitations and locally issued credentials remain immediate", (t) => {
  const f = fixture(t);
  const guest = f.auth.inviteGuest({ name: "Friend", ttlSeconds: 3600, roots: [0] });
  const joined = f.auth.redeemGuest(guest.invitation, f.identity);
  assert.equal(joined.kind, "guest");
  assert.equal(typeof joined.token, "string");
  assert.equal(joined.status, undefined);
  assert.equal(f.auth.verify(joined.token, f.identity).kind, "guest");
  assert.deepEqual(f.auth.listAgentAdmissions(), []);
  const local = f.auth.issue("CLI", ["device", "exec"], "agent");
  assert.equal(f.auth.verify(local.token).kind, "agent");
});

test("public receipt polling only writes credentials when collecting an approved token", (t) => {
  const f = fixture(t);
  const receipt = f.claim();
  const file = path.join(f.config.dataDir, "clients.json");
  const unchanged = (run) => {
    const old = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(file, old, old);
    const before = fs.statSync(file, { bigint: true });
    run();
    const after = fs.statSync(file, { bigint: true });
    assert.equal(after.ino, before.ino, "the credential file was not atomically replaced");
    assert.equal(after.mtimeNs, before.mtimeNs, "the credential file was not written");
    assert.equal(fs.existsSync(file + ".lock"), false);
  };
  unchanged(() => assert.equal(f.poll(receipt).status, "pending"));
  unchanged(() => assert.equal(f.auth.pollAgentAdmission("00000000-0000-0000-0000-000000000000", "x".repeat(43), f.identity).status, "expired"));
  unchanged(() => assert.throws(() => f.auth.pollAgentAdmission(receipt.requestId, "x".repeat(43), f.identity), { status: 401 }));
  f.auth.decideAgentAdmission(receipt.requestId, "deny");
  unchanged(() => assert.equal(f.poll(receipt).status, "denied"));
  const expired = f.claim();
  f.alter((clients) => { clients.find((c) => c.id === expired.clientId).admission.expiresAt = Date.now() - 1; });
  unchanged(() => assert.equal(f.poll(expired).status, "expired"));
  const approved = f.claim();
  f.auth.decideAgentAdmission(approved.requestId, "approve");
  const access = f.poll(approved);
  assert.equal(f.auth.verify(access.token, f.identity).id, approved.clientId);
  unchanged(() => assert.throws(() => f.poll(approved), { status: 409 }));
});
