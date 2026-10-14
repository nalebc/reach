import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../server/core.mjs";
import { rotateIfDue } from "../scripts/agent-remote.mjs";
import { windowsAcl, othersAllowed } from "./helpers/windows-acl.mjs";

// Security audit M6: an agent on its own tailnet device trades its credential
// for a new one while it works. A copy of its folder then stops working, and
// using the replaced credential again ends the access and tells the owner.
const clock = (t) => {
  const real = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => real() + offset);
  return (ms) => { offset += ms; };
};
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-rotate-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = createAuth({ dataDir: path.join(dir, "private"), roots: [dir], agentPolicyFile: path.join(dir, "policy.json") });
  const node = () => ({ nodeId: "nAgent", userId: "", tagged: true, validUntil: Date.now() + 60_000 });
  const reused = [];
  auth.onCredentialReuse((client) => reused.push(client.id));
  const join = () => {
    const grant = auth.inviteAgent({ name: "Builder", ttlSeconds: 30 * 86400, folders: [{ root: 0, path: "" }] });
    const claim = auth.redeemGuest(grant.invitation, node());
    auth.decideAgentAdmission(claim.requestId, "approve");
    return auth.pollAgentAdmission(claim.requestId, claim.requestSecret, node());
  };
  return { auth, node, join, reused };
}

test("a traded credential takes over on first use; the old one ends two minutes later", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const first = f.join();
  const { token: second } = f.auth.rotateCredential(first.token, f.node());
  assert.ok(f.auth.verify(first.token, f.node()), "until the new one is used, nothing changes");
  assert.ok(f.auth.verify(second, f.node()), "first use: it's the credential now");
  assert.ok(f.auth.verify(first.token, f.node()), "requests already on their way still pass");
  advance(121_000);
  assert.ok(f.auth.verify(second, f.node()));
  assert.deepEqual(f.reused, []);
  // The old one again, later: a copy is in use. The access ends for both.
  assert.equal(f.auth.verify(first.token, f.node()), null);
  assert.deepEqual(f.reused, [first.clientId]);
  assert.equal(f.auth.verify(second, f.node()), null);
  assert.ok(!f.auth.list().some((c) => c.id === first.clientId));
});

test("a copy that trades first is caught when the agent comes back: the access ends", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const original = f.join();
  // The copy trades and uses its new credential; the agent's own is replaced.
  const copy = f.auth.rotateCredential(original.token, f.node());
  assert.ok(f.auth.verify(copy.token, f.node()));
  advance(3 * 60_000);
  // The agent comes back with its own (now replaced) credential: ended.
  assert.equal(f.auth.verify(original.token, f.node()), null);
  assert.equal(f.auth.verify(copy.token, f.node()), null, "the copy's access ended too");
  assert.equal(f.reused.length, 1);
});

test("a trade lost on the way changes nothing; a week without trading ends the access", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const first = f.join();
  const lost = f.auth.rotateCredential(first.token, f.node());
  advance(3600_000);
  assert.ok(f.auth.verify(first.token, f.node()), "never used: the old one stays");
  const next = f.auth.rotateCredential(first.token, f.node());
  assert.equal(f.auth.verify(lost.token, f.node()), null, "a later trade replaces a lost one");
  assert.deepEqual(f.reused, [], "an unused traded credential is no copy");
  assert.ok(f.auth.verify(next.token, f.node()));
  advance(7 * 86400_000 + 1000);
  assert.equal(f.auth.verify(next.token, f.node()), null, "quiet for a week: ended");
});

test("only an agent on its own invited device trades its credential", (t) => {
  const f = fixture(t);
  const owner = f.auth.issue("owner", ["admin"]);
  assert.throws(() => f.auth.rotateCredential(owner.token), { status: 403 });
  assert.throws(() => f.auth.rotateCredential("not-a-credential", f.node()), { status: 403 });
});

test("the agent's runtime saves the new credential before using it, one trade at a time", async (t) => {
  const conn = fs.mkdtempSync(path.join(os.tmpdir(), "reach-rotate-conn-"));
  t.after(() => fs.rmSync(conn, { recursive: true, force: true }));
  let now = Date.parse("2026-10-09T12:00:00Z");
  const credential = { version: 1, via: "tailnet", token: "a".repeat(43), joinedAt: new Date(now).toISOString() };
  const calls = [];
  const call = async (route, method) => {
    calls.push(`${method} ${route}`);
    await new Promise((r) => setTimeout(r, 10));
    return { token: "b".repeat(43) };
  };
  await rotateIfDue(conn, credential, call, { now: () => now });
  assert.deepEqual(calls, [], "not due within the hour");
  now += 3600_001;
  await Promise.all([rotateIfDue(conn, credential, call, { now: () => now }), rotateIfDue(conn, credential, call, { now: () => now })]);
  assert.deepEqual(calls, ["POST /api/device/rotate"], "one trade for concurrent requests");
  assert.equal(credential.token, "b".repeat(43));
  const saved = JSON.parse(fs.readFileSync(path.join(conn, "credential.json"), "utf8"));
  assert.equal(saved.token, "b".repeat(43));
  assert.equal(saved.rotatedAt, now);
  // Windows keeps who may open it in its ACL, not mode bits: this user's alone.
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(conn, "credential.json")).mode & 0o777, 0o600);
  else assert.deepEqual(othersAllowed(await windowsAcl("file", path.join(conn, "credential.json"))), []);
  // Over a direct connection (several processes use it): never.
  const direct = { ...credential, via: "direct", rotatedAt: 0 };
  await rotateIfDue(conn, direct, call, { now: () => now });
  assert.equal(calls.length, 1);
});

// Always on both routes (Oct 10): a public-link agent trades its credential
// the same way, with the key that signs for it; a copy used elsewhere ends
// the access; any Always access unused for a week ends, for good.
test("a public-link agent trades its credential with its key; a copy ends it; a week unused ends any Always access", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const advance = clock(t);
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-rotate-funnel-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = createAuth({ dataDir: path.join(dir, "private"), roots: [dir], agentPolicyFile: path.join(dir, "policy.json"), tailscaleOwner: { userId: "real-owner" } });
  const reused = [];
  auth.onCredentialReuse((client) => reused.push(client.id));
  const binding = () => randomBytes(32).toString("base64url");
  const join = (name, key) => {
    const grant = auth.inviteBrowser({ name, transport: "funnel", preset: "readonly", standing: true });
    const claim = auth.redeemFunnelBrowser(grant.invitation, key);
    auth.decideAgentAdmission(claim.requestId, "approve");
    return auth.pollFunnelAdmission(claim.requestId, claim.requestSecret, key);
  };
  const key = binding();
  const first = join("Muse", key);
  assert.ok(auth.verifyFunnel(first.token, key));
  assert.ok(!auth.funnelWindow().keyed, "not trading yet: its page may need the door open");
  assert.throws(() => auth.rotateFunnelCredential(first.token, binding()), { status: 403 }, "only with its own key");
  const { token: second } = auth.rotateFunnelCredential(first.token, key);
  assert.ok(auth.verifyFunnel(first.token, key), "until the new one is used, nothing changes");
  assert.ok(auth.verifyFunnel(second, key), "first use: it's the credential now");
  assert.deepEqual((({ open, reason, keyed }) => [open, reason, keyed])(auth.funnelWindow()), [true, "standing", true], "a trading Tools agent alone: the door takes known keys only");
  assert.ok(auth.verifyFunnel(first.token, key), "two minutes of grace");
  advance(121_000);
  assert.ok(auth.verifyFunnel(second, key));
  assert.equal(auth.verifyFunnel(first.token, key), null, "the old one again: a copy is in use");
  assert.deepEqual(reused, [first.clientId]);
  assert.equal(auth.verifyFunnel(second, key), null, "both ended");
  assert.ok(auth.funnelKeys().has(key), "an ended agent's key stays known a while: it hears that it ended");
  // A week unused ends an Always access, however it's reached.
  const other = binding();
  const access = join("Grok", other);
  assert.ok(auth.verifyFunnel(access.token, other));
  advance(6 * 86400_000);
  assert.ok(auth.verifyFunnel(access.token, other), "six days: still on");
  advance(6 * 86400_000);
  assert.ok(auth.verifyFunnel(access.token, other), "used six days ago: still on");
  advance(7 * 86400_000 + 60_000);
  assert.equal(auth.verifyFunnel(access.token, other), null, "a week since its last use: ended");
  const listed = auth.list().find((c) => c.id === access.clientId);
  assert.ok(listed.expiresAt <= Date.now(), "ended for good, in the list too");
  assert.equal(auth.funnelWindow().open, false, "nothing keeps the public door for it");
});
