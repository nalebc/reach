import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, validateBrowserInvitation } from "../server/core.mjs";
import { presetFixture, privateIngressTest } from "./helpers/preset-fixture.mjs";

// "Always": an agent keeps its access until the owner ends it. It joins like
// any link, with the owner's approval the first time; afterwards that one link
// brings it back from any browser, moving the access and cutting off the old
// browser, until the owner ends it. The public link stays up while it has access, or its
// browser would have nothing to come back to.
const binding = () => crypto.randomBytes(32).toString("base64url");
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-standing-")));
  const root = path.join(dir, "shared");
  fs.mkdirSync(root);
  const config = {
    dataDir: path.join(dir, "private"), roots: [root],
    agentPolicyFile: path.join(dir, "policy.json"),
    tailscaleOwner: { userId: "real-owner" },
  };
  const auth = createAuth(config);
  const invite = (extra = { standing: true }) =>
    auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "readonly", ...extra });
  const claim = (grant, key) => auth.redeemFunnelBrowser(grant.invitation, key);
  const join = (grant, key) => {
    const receipt = claim(grant, key);
    auth.decideAgentAdmission(receipt.requestId, "approve");
    return auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, key);
  };
  const record = (id) => auth.list().find((client) => client.id === id);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { auth, invite, claim, join, record, clientsFile: path.join(config.dataDir, "clients.json") };
}
const clock = (t) => {
  const real = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => real() + offset);
  return (ms) => { offset += ms; };
};

test("Always is a public link with no end time", () => {
  const base = { name: "Muse", transport: "funnel", preset: "readonly" };
  assert.equal(validateBrowserInvitation({ ...base, standing: true }).standing, true);
  for (const wrong of [
    { ...base, standing: true, ttlSeconds: 3600 },
    { ...base, standing: true, transport: "tailnet" },
    { ...base, standing: false, ttlSeconds: 3600 },
  ]) assert.throws(() => validateBrowserInvitation(wrong), { status: 400 });
});

test("Always and approved timed sessions both outlive silent minutes and keep the public link up", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const key = binding();
  const access = f.join(f.invite(), key);
  assert.equal(access.status, "approved");
  assert.equal(access.standing, true, "the page learns to keep this session");
  const onceKey = binding();
  const once = f.join(f.invite({ ttlSeconds: 3600 }), onceKey);
  advance(10 * 60_000);
  assert.ok(f.auth.verifyFunnel(access.token, key), "ten silent minutes don't end Always access");
  assert.equal(f.record(access.clientId).status, "accepted");
  assert.deepEqual(f.auth.funnelWindow(), { open: true, until: f.record(access.clientId).expiresAt, reason: "standing" });
  assert.ok(f.auth.verifyFunnel(once.token, onceKey), "a timed session, once approved, lasts until its access ends");
});

test("one link: opened again in another browser after Muse joined, the owner matches a new code, then the access moves there and the old browser is cut off", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const key = binding();
  const access = f.join(grant, key);
  const newKey = binding();
  const receipt = f.claim(grant, newKey);
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.moved, undefined);
  assert.equal(receipt.clientId, access.clientId, "the same access, not a new one");
  assert.deepEqual(f.auth.listAgentAdmissions().map((r) => r.verificationCode), [receipt.verificationCode], "the owner matches the new browser's code");
  assert.equal(f.auth.verifyFunnel(access.token, key), null, "the browser it used is disconnected");
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  const back = f.auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, newKey);
  assert.equal(back.status, "approved");
  assert.equal(back.standing, true);
  assert.ok(f.auth.verifyFunnel(back.token, newKey));
  assert.equal(f.auth.verifyFunnel(back.token, key), null, "the session belongs to the new browser key only");
});

test("an unopened Always invitation joins within the usual window, then the public link closes", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.invite();
  assert.equal(f.auth.funnelWindow().reason, "invitation");
  advance(16 * 60_000);
  assert.equal(f.auth.funnelWindow().open, false, "an unused Always link doesn't keep the Mac public");
  assert.throws(() => f.claim(grant, binding()), { status: 401 });
});

test("lowering an Always agent's preset keeps it Always", (t) => {
  const f = fixture(t);
  const access = f.join(f.invite(), binding());
  f.auth.changeAccess(access.clientId, { preset: "files", folders: [{ root: 0, path: "" }] });
  const changed = f.record(access.clientId);
  assert.equal(changed.policy.preset, "files");
  assert.equal(changed.policy.standing, true);
});

test("Stop ends Always access and closes the public link", (t) => {
  const f = fixture(t);
  const key = binding();
  const access = f.join(f.invite(), key);
  f.auth.revoke(access.clientId);
  assert.equal(f.auth.verifyFunnel(access.token, key), null);
  assert.equal(f.auth.funnelWindow().open, false);
});

test("Reopen link (owner API) disconnects the browser in use; the link keeps working, a new browser with a new code", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.invite();
  const oldKey = binding();
  const old = f.join(grant, oldKey);
  assert.equal(f.record(old.clientId).relink, true);
  assert.equal(f.record(old.clientId).linkHash, undefined, "the owner's list never carries the link's fingerprint");
  f.auth.reopenBrowserInvitation(old.clientId);
  assert.equal(f.auth.verifyFunnel(old.token, oldKey), null, "the browser it used is disconnected");
  const newKey = binding();
  const receipt = f.claim(grant, newKey);
  assert.equal(receipt.status, "pending", "a new browser: the owner matches its code");
  assert.equal(receipt.clientId, old.clientId, "the same access, not a new one");
  assert.equal(f.auth.listAgentAdmissions().length, 1);
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  const back = f.auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, newKey);
  assert.equal(back.standing, true);
  assert.ok(f.auth.verifyFunnel(back.token, newKey));
  f.auth.reopenBrowserInvitation(old.clientId);
  advance(16 * 60_000);
  // Still its one link for as long as the access lasts.
  assert.equal(f.claim(grant, newKey).refreshed, true, "its approved browser: at once");
  assert.equal(f.claim(grant, binding()).status, "pending");
  assert.equal(f.auth.funnelWindow().open, true);
  f.auth.revoke(old.clientId);
  assert.throws(() => f.claim(grant, binding()), { status: 401 }, "ended: the link is dead");
  assert.equal(f.auth.funnelWindow().open, false);
});

test("a timed invitation can be reopened while it has time left, never after", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.invite({ ttlSeconds: 3600 });
  const first = f.join(grant, binding());
  advance(5 * 60_000);
  f.auth.reopenBrowserInvitation(first.clientId);
  const key = binding();
  const moved = f.claim(grant, key);
  f.auth.decideAgentAdmission(moved.requestId, "approve");
  assert.equal(f.auth.pollFunnelAdmission(moved.requestId, moved.requestSecret, key).status, "approved");
  advance(60 * 60_000);
  assert.throws(() => f.auth.reopenBrowserInvitation(first.clientId), { status: 404 });
  const tailnet = f.invite({ ttlSeconds: 3600, transport: "tailnet" });
  assert.throws(() => f.auth.reopenBrowserInvitation(tailnet.clientId), { status: 404 }, "only public-link agents have a link to reopen");
});

test("only the owner reopens an agent's link", privateIngressTest, async (t) => {
  const f = await presetFixture(t);
  const grant = f.reach.auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "readonly", standing: true });
  const key = binding();
  const receipt = f.reach.auth.redeemFunnelBrowser(grant.invitation, key);
  f.reach.auth.decideAgentAdmission(receipt.requestId, "approve");
  const muse = f.reach.auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, key);
  const listed = (await f.call("/api/browser/agents")).body.agents.find((agent) => agent.id === muse.clientId);
  assert.equal(listed.relink, true);
  assert.equal(listed.standing, true);
  const other = await f.join({ name: "Grok", preset: "readonly" });
  assert.equal((await other.as("/api/browser/agents/reopen", { method: "POST", body: { clientId: muse.clientId } })).status, 403);
  assert.equal((await f.call("/api/browser/agents/reopen", { method: "POST", body: { clientId: muse.clientId, extra: 1 } })).status, 400);
  assert.equal((await f.call("/api/browser/agents/reopen", { method: "POST", body: { clientId: "nope" } })).status, 404);
  const reopened = await f.call("/api/browser/agents/reopen", { method: "POST", body: { clientId: muse.clientId } });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.ok(reopened.body.joinBy > Date.now());
  assert.equal(f.reach.auth.verifyFunnel(muse.token, key), null);
});

// Security audit L4: an Always agent whose terms no longer match what the
// owner approved can't act, so it keeps no public page open either.
test("an Always agent on terms the owner never approved keeps the public page closed", (t) => {
  const f = fixture(t);
  const approver = { nodeId: "owner-phone", userId: "real-owner", clientId: "owner-client" };
  const grant = f.auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "full", standing: true }, approver);
  const key = crypto.randomBytes(32).toString("base64url");
  const access = f.join(grant, key);
  assert.ok(f.auth.verifyFunnel(access.token, key));
  assert.equal(f.auth.funnelWindow().open, true);
  const clientsFile = f.clientsFile;
  const clients = JSON.parse(fs.readFileSync(clientsFile, "utf8"));
  clients.find((c) => c.id === access.clientId).browserAppApprover.clientId = "replacement-owner";
  fs.writeFileSync(clientsFile, JSON.stringify(clients));
  assert.equal(f.auth.verifyFunnel(access.token, key), null);
  assert.equal(f.auth.funnelWindow().open, false, "nothing keeps the public page up for it");
});
