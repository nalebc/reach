import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, hash } from "../server/core.mjs";

const binding = () => crypto.randomBytes(32).toString("base64url");
const closed = { open: false, until: 0, reason: null };
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-auth-")));
  const root = path.join(dir, "shared");
  fs.mkdirSync(root);
  const config = {
    dataDir: path.join(dir, "private"), roots: [root],
    agentPolicyFile: path.join(dir, "policy.json"),
    tailscaleOwner: { userId: "real-owner" },
  };
  const auth = createAuth(config);
  const key = binding();
  const identity = { userId: "real-owner", nodeId: "owner-laptop", validUntil: Date.now() + 86400000 };
  const file = path.join(config.dataDir, "clients.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const alter = (run) => { const data = read(); run(data); fs.writeFileSync(file, JSON.stringify(data)); };
  const invite = (options = {}) => auth.inviteBrowser({
    name: "Muse", ttlSeconds: 3600, transport: "funnel", screen: "ask",
    folders: [{ root: 0, path: "" }], terminalIds: ["reach:one"], commandRequests: true,
    ...options,
  });
  const claim = (grant = invite(), claimant = key) => auth.redeemFunnelBrowser(grant.invitation, claimant);
  const poll = (receipt, claimant = key) => auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, claimant);
  const collect = (grant = invite()) => {
    const receipt = claim(grant);
    auth.decideAgentAdmission(receipt.requestId, "approve");
    return { receipt, access: poll(receipt), grant };
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { auth, config, key, identity, root, file, read, alter, invite, claim, poll, collect };
}

test("Funnel must be explicit and never changes existing invitation transports", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.auth.funnelWindow(), closed);
  const defaultInvite = f.invite({ transport: undefined });
  const tailnetInvite = f.invite({ transport: "tailnet" });
  assert.equal(f.read().every((c) => c.browserTransport === undefined), true);
  assert.deepEqual(f.auth.funnelWindow(), closed);
  for (const transport of [null, "public", "", true, {}, []])
    assert.throws(() => f.invite({ transport }), { status: 400 });
  for (const grant of [defaultInvite, tailnetInvite]) {
    assert.throws(() => f.claim(grant), { status: 401 });
    assert.equal(f.auth.redeemGuest(grant.invitation, f.identity).status, "pending");
  }
  const publicInvite = f.invite();
  assert.equal(f.read().find((c) => c.id === publicInvite.clientId).browserTransport, "funnel");
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: publicInvite.joinBy, reason: "invitation" });
});

test("Funnel claim consumes one invitation into a powerless browser-bound receipt", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  assert.throws(() => f.auth.redeemGuest(grant.invitation, f.identity), { status: 401 });
  const receipt = f.claim(grant);
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.token, undefined);
  assert.match(receipt.verificationCode, /^\d{6}$/);
  const stored = f.read()[0];
  assert.equal(stored.browserBinding, f.key);
  assert.equal(stored.tailscale, undefined, "a browser proof never manufactures a tailnet identity");
  assert.equal(stored.hash, undefined);
  assert.equal(stored.inviteHash, undefined);
  assert.equal(stored.admission.secretHash, hash(receipt.requestSecret));
  assert.equal(JSON.stringify(stored).includes(receipt.requestSecret), false);
  assert.equal(f.auth.verifyFunnel(receipt.requestSecret, f.key), null);
  assert.equal(f.auth.verifyFunnel(grant.invitation, f.key), null);
  assert.equal(f.poll(receipt).status, "pending");
  assert.throws(() => f.claim(grant), { status: 401 });
  assert.throws(() => f.claim(grant, binding()), { status: 401 });
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: receipt.expiresAt, reason: "invitation" });
  const review = f.auth.listAgentAdmissions()[0];
  assert.equal(review.browserTransport, "funnel");
  assert.equal(review.nodeId, undefined);
  assert.deepEqual(review.roots, [f.root]);
  assert.deepEqual(review.terminalIds, ["reach:one"]);
  assert.equal(JSON.stringify(review).includes(receipt.requestSecret), false);
});

test("browser key validation cannot consume an invite or impersonate a claim", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  for (const key of [undefined, null, {}, "", "a".repeat(42), "a".repeat(44), "!".repeat(43), "A".repeat(42) + "B"])
    assert.throws(() => f.auth.redeemFunnelBrowser(grant.invitation, key), { status: 401 });
  const receipt = f.claim(grant);
  for (const key of [null, "bad", binding()]) {
    assert.throws(() => f.poll(receipt, key), { status: 401 });
    assert.equal(f.auth.verifyFunnel(receipt.requestSecret, key), null);
  }
  assert.throws(() => f.auth.pollFunnelAdmission(receipt.requestId, receipt.verificationCode, f.key), { status: 401 });
  assert.throws(() => f.auth.pollFunnelAdmission(receipt.requestId, binding(), f.key), { status: 401 });
  assert.equal(f.poll(receipt).status, "pending");
});

test("approved credential is collected once and only works with its browser key", (t) => {
  const f = fixture(t);
  const grant = f.invite({ ttlSeconds: 60 });
  const receipt = f.claim(grant);
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  assert.equal(f.read()[0].hash, undefined);
  assert.throws(() => f.poll(receipt, binding()), { status: 401 });
  assert.throws(() => f.auth.pollAgentAdmission(receipt.requestId, receipt.requestSecret, f.identity), { status: 401 });
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: receipt.expiresAt, reason: "invitation" });
  const access = f.poll(receipt);
  assert.equal(access.status, "approved");
  assert.equal(access.expiresAt, grant.expiresAt);
  assert.equal(f.auth.verifyFunnel(access.token, f.key).id, grant.clientId);
  assert.equal(f.auth.verifyFunnel(access.token, binding()), null);
  assert.equal(f.auth.verifyFunnel(access.token), null);
  assert.equal(f.auth.verify(access.token, f.identity), null);
  assert.equal(f.auth.verifyDigest(hash(access.token), f.identity), null);
  assert.equal(f.auth.verify(access.token), null);
  assert.throws(() => f.poll(receipt), { status: 409 });
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: grant.expiresAt, reason: "session" });
  assert.equal(JSON.stringify(f.read()).includes(access.token), false);
});

test("an injected token cannot bypass pending or approved owner admission", (t) => {
  const f = fixture(t);
  const receipt = f.claim();
  const stolen = binding();
  f.alter((data) => { data[0].hash = hash(stolen); });
  assert.equal(f.auth.verifyFunnel(stolen, f.key), null);
  assert.equal(f.auth.verify(stolen, f.identity), null);
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  assert.equal(f.auth.verifyFunnel(stolen, f.key), null);
  assert.equal(f.auth.verify(stolen, f.identity), null);
  const access = f.poll(receipt);
  assert.equal(f.auth.verifyFunnel(stolen, f.key), null);
  assert.equal(f.auth.verifyFunnel(access.token, f.key).id, receipt.clientId);
});

test("public authentication rejects owner, human, CLI, and tailnet browser access", (t) => {
  const f = fixture(t);
  const owner = f.auth.issue("Owner", ["admin"], "device", { tailscale: f.identity });
  assert.equal(f.auth.verify(owner.token, f.identity).kind, "device");
  assert.equal(f.auth.verifyFunnel(owner.token, f.key), null);
  const human = f.auth.inviteGuest({ name: "Friend", ttlSeconds: 3600, roots: [0] });
  const cli = f.auth.inviteAgent({ name: "CLI", ttlSeconds: 3600, folders: [{ root: 0, path: "" }] });
  const browser = f.invite({ transport: "tailnet" });
  for (const grant of [human, cli, browser]) {
    assert.throws(() => f.claim(grant), { status: 401 });
    const receipt = f.auth.redeemGuest(grant.invitation, f.identity);
    let access = receipt;
    if (receipt.kind === "agent") {
      assert.throws(() => f.poll(receipt), { status: 401 });
      f.auth.decideAgentAdmission(receipt.requestId, "approve");
      access = f.auth.pollAgentAdmission(receipt.requestId, receipt.requestSecret, f.identity);
    }
    assert.ok(f.auth.verify(access.token, f.identity));
    assert.equal(f.auth.verifyFunnel(access.token, f.key), null);
  }
  assert.deepEqual(f.auth.funnelWindow(), closed);
});

test("Funnel policy is reapplied to current shared roots and never gains owner scopes", (t) => {
  const f = fixture(t);
  const { access } = f.collect();
  const client = f.auth.verifyFunnel(access.token, f.key);
  assert.deepEqual(client.agentRoots, [f.root]);
  for (const scope of ["admin", "exec", "files:write", "terminal", "screen:control", "apps:drive"])
    assert.equal(client.scopes.includes(scope), false);
  f.config.roots = [];
  f.config.agentPolicyRequired = true;
  const narrowed = f.auth.verifyFunnel(access.token, f.key);
  assert.deepEqual(narrowed.agentRoots, []);
  assert.deepEqual(narrowed.policy.roots, []);
  assert.equal(narrowed.scopes.includes("files:read"), false);
  assert.equal(narrowed.policy.screen, "ask");
});

test("owner decision and credential collection bind the exact Funnel grant", (t) => {
  const f = fixture(t);
  for (const edit of [
    (c) => { c.scopes.push("admin"); },
    (c) => { c.policy.commandRequests = false; },
    (c) => { c.name = "Different agent"; },
    (c) => { c.expiresAt += 60000; },
  ]) {
    const receipt = f.claim(undefined, binding());
    f.auth.decideAgentAdmission(receipt.requestId, "approve");
    const key = f.read().find((c) => c.id === receipt.clientId).browserBinding;
    f.alter((data) => edit(data.find((c) => c.id === receipt.clientId)));
    assert.equal(f.poll(receipt, key).status, "expired");
    assert.deepEqual(f.auth.funnelWindow(), closed);
  }
  const receipt = f.claim();
  f.alter((data) => { data.find((c) => c.id === receipt.clientId).browserBinding = binding(); });
  assert.throws(() => f.poll(receipt), { status: 401 });
  assert.throws(() => f.auth.decideAgentAdmission(receipt.requestId, "approve"), { status: 409 });
  assert.deepEqual(f.auth.funnelWindow(), closed);
});

test("transport or binding mutations cannot downgrade approved access into legacy authentication", (t) => {
  const f = fixture(t);
  const { receipt, access, grant } = f.collect();
  const original = f.read()[0];
  for (const edit of [
    (c) => { c.browserBinding = binding(); },
    (c) => { c.browserTransport = "tailnet"; },
    (c) => { c.policy.browser = false; },
    (c) => { c.kind = "device"; },
    (c) => { c.tailscale = { userId: f.identity.userId, nodeId: f.identity.nodeId }; },
    (c) => { c.policy.screen = "control"; },
  ]) {
    f.alter((data) => { data[0] = structuredClone(original); edit(data[0]); });
    assert.equal(f.auth.verifyFunnel(access.token, f.key), null);
    assert.equal(f.auth.verify(access.token, f.identity), null);
    assert.deepEqual(f.auth.funnelWindow(), closed);
  }
  assert.equal(receipt.clientId, grant.clientId);
});

test("denial and revocation immediately close otherwise idle Funnel windows", (t) => {
  const f = fixture(t);
  const denied = f.claim();
  f.auth.decideAgentAdmission(denied.requestId, "deny");
  assert.equal(f.poll(denied).status, "denied");
  assert.deepEqual(f.auth.funnelWindow(), closed);
  const revoked = f.claim();
  f.auth.revoke(revoked.clientId);
  assert.equal(f.poll(revoked).status, "expired");
  assert.deepEqual(f.auth.funnelWindow(), closed);
  const { access, grant } = f.collect();
  f.auth.revoke(grant.clientId);
  assert.equal(f.auth.verifyFunnel(access.token, f.key), null);
  assert.deepEqual(f.auth.funnelWindow(), closed);
});

test("unclaimed, pending, approved, and collected states expire on their own deadlines", (t) => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const f = fixture(t);
  const grant = f.invite({ joinSeconds: 60 });
  t.mock.timers.setTime(grant.joinBy);
  assert.deepEqual(f.auth.funnelWindow(), closed);
  assert.throws(() => f.claim(grant), { status: 401 });
  const pending = f.claim();
  t.mock.timers.setTime(pending.expiresAt);
  assert.equal(f.poll(pending).status, "expired");
  assert.deepEqual(f.auth.funnelWindow(), closed);
  const approved = f.claim();
  f.auth.decideAgentAdmission(approved.requestId, "approve");
  t.mock.timers.setTime(approved.expiresAt);
  assert.equal(f.poll(approved).status, "expired");
  assert.deepEqual(f.auth.funnelWindow(), closed);
  const { access, grant: active } = f.collect(f.invite({ ttlSeconds: 60 }));
  t.mock.timers.setTime(active.expiresAt - 1);
  assert.ok(f.auth.verifyFunnel(access.token, f.key));
  assert.equal(f.auth.funnelWindow().open, true);
  t.mock.timers.setTime(active.expiresAt);
  assert.equal(f.auth.verifyFunnel(access.token, f.key), null);
  assert.deepEqual(f.auth.funnelWindow(), closed);
});

test("shared Funnel deadline follows the last active window without extending individual credentials", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture(t);
  const { access, grant: short } = f.collect(f.invite({ ttlSeconds: 60 }));
  const longer = f.invite({ ttlSeconds: 3600, joinSeconds: 900 });
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: longer.joinBy, reason: "invitation" });
  t.mock.timers.setTime(short.expiresAt);
  assert.equal(f.auth.verifyFunnel(access.token, f.key), null);
  assert.equal(f.auth.funnelWindow().until, longer.joinBy);
  const receipt = f.claim(longer);
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: receipt.expiresAt, reason: "invitation" });
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  const second = f.poll(receipt);
  assert.equal(second.expiresAt, longer.expiresAt);
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: Date.now() + 120000, reason: "session" });
  f.auth.revoke(longer.clientId);
  assert.deepEqual(f.auth.funnelWindow(), closed);
});

test("restart preserves the browser binding and one-time credential collection", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const receipt = f.claim(grant);
  const restarted = createAuth(f.config, { rotatePairing: false });
  assert.throws(() => restarted.redeemFunnelBrowser(grant.invitation, f.key), { status: 401 });
  restarted.decideAgentAdmission(receipt.requestId, "approve");
  const access = restarted.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, f.key);
  const again = createAuth(f.config, { rotatePairing: false });
  assert.equal(again.verifyFunnel(access.token, f.key).id, grant.clientId);
  assert.throws(() => again.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, f.key), { status: 409 });
  assert.equal(again.verify(access.token, f.identity), null);
});

test("receipt reads are read-only and pressure is bounded per browser", (t) => {
  const f = fixture(t);
  const receipts = Array.from({ length: 3 }, () => f.claim());
  const old = new Date("2000-01-01T00:00:00Z");
  fs.utimesSync(f.file, old, old);
  const before = fs.statSync(f.file, { bigint: true });
  assert.equal(f.poll(receipts[0]).status, "pending");
  assert.equal(f.auth.pollFunnelAdmission("00000000-0000-0000-0000-000000000000", binding(), f.key).status, "expired");
  assert.throws(() => f.poll(receipts[0], binding()), { status: 401 });
  const after = fs.statSync(f.file, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  const fourth = f.invite();
  assert.throws(() => f.claim(fourth), { status: 429 });
  f.auth.decideAgentAdmission(receipts[0].requestId, "deny");
  assert.equal(f.claim(fourth).status, "pending");
});


test("Funnel credentials expire after two disconnected minutes and cannot be revived", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture(t);
  assert.throws(() => f.invite({ ttlSeconds: 3601 }), { status: 400 });
  assert.throws(() => f.invite({ joinSeconds: 901 }), { status: 400 });
  const { access, grant } = f.collect();
  const initial = f.auth.funnelWindow().until;
  assert.equal(initial, Date.now() + 120000);
  t.mock.timers.setTime(initial - 60000);
  assert.ok(f.auth.verifyFunnel(access.token, f.key));
  assert.equal(f.auth.funnelWindow().until, initial, "internal checks never renew the connection");
  assert.throws(() => f.auth.touchFunnel(access.token, binding()), { status: 401 });
  f.auth.touchFunnel(access.token, f.key);
  const renewed = f.auth.funnelWindow().until;
  assert.equal(renewed, Date.now() + 120000);
  assert.ok(renewed < grant.expiresAt);
  t.mock.timers.setTime(renewed);
  assert.equal(f.auth.verifyFunnel(access.token, f.key), null);
  assert.deepEqual(f.auth.funnelWindow(), closed);
  assert.throws(() => f.auth.touchFunnel(access.token, f.key), { status: 401 });
  assert.equal(f.auth.list().find((client) => client.id === grant.clientId).status, "expired");
  const restarted = createAuth(f.config, { rotatePairing: false });
  assert.deepEqual(restarted.funnelWindow(), closed);
  assert.equal(restarted.verifyFunnel(access.token, f.key), null);
});

test("owner edits preserve an accepted browser binding while expanding, restricting, and changing expiry", (t) => {
  const f = fixture(t);
  const { access, grant } = f.collect(f.invite({ ttlSeconds: 1200 }));
  const expiresAt = Date.now() + 1800000;
  const changed = f.auth.changeAccess(grant.clientId, {
    folders: "keep", screen: "view", terminalIds: [], restrictedTerminal: true, expiresAt,
  });
  assert.equal(changed.client.expiresAt, expiresAt);
  const current = f.auth.verifyFunnel(access.token, f.key);
  assert.ok(current, "the same browser remains authenticated");
  assert.equal(f.auth.list().find((c) => c.id === grant.clientId).status, "accepted");
  assert.equal(current.policy.restrictedTerminal, true);
  assert.equal(current.policy.commandRequests, undefined);
  assert.deepEqual(current.policy.terminalIds, []);
  assert.equal(f.auth.verifyFunnel(access.token, binding()), null);
  assert.equal(f.auth.verify(access.token), null);
  for (const changes of [
    { folders: "keep", restrictedTerminal: true, screen: "ask" },
    { folders: "keep", exec: true },
    { folders: "keep", terminalIds: ["; rm -rf /"] },
    { folders: [{ root: 0, path: "../private" }], screen: "off" },
    { folders: "keep", expiresAt: Date.now() + 3601000 },
  ]) {
    assert.throws(() => f.auth.changeAccess(grant.clientId, changes));
    assert.equal(f.auth.verifyFunnel(access.token, f.key).expiresAt, expiresAt, "failed edits are atomic");
  }
  f.auth.changeAccess(grant.clientId, { folders: [], screen: "view", expiresAt: Date.now() + 60000 });
  const restricted = f.auth.verifyFunnel(access.token, f.key);
  assert.deepEqual(restricted.agentRoots, []);
  assert.equal(restricted.scopes.includes("files:read"), false);
  assert.equal(restricted.scopes.includes("browser:request"), false);
  f.auth.revoke(grant.clientId);
  assert.equal(f.auth.verifyFunnel(access.token, f.key), null);
});

test("editing cannot bypass a pending admission or revive a disconnected browser", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  f.claim(grant);
  assert.throws(() => f.auth.changeAccess(grant.clientId, { folders: "keep", screen: "view" }), { status: 409 });
  const accepted = f.collect();
  f.alter((clients) => { clients.find((c) => c.id === accepted.grant.clientId).browserIdleExpiresAt = Date.now() - 1; });
  assert.throws(() => f.auth.changeAccess(accepted.grant.clientId, { folders: "keep", screen: "view" }), { status: 404 });
});
