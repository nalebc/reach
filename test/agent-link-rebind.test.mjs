import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../server/core.mjs";

// One link per agent: once the owner approved it, the same link reconnects
// that browser at once until the access ends. Another browser asks the owner
// again with a new code (security audit H3); once approved, the access moves
// there and the old one is cut off. Nothing the owner hasn't approved, nothing
// ended, and nothing denied ever comes back through it.
const binding = () => crypto.randomBytes(32).toString("base64url");
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-rebind-")));
  const root = path.join(dir, "shared");
  fs.mkdirSync(root);
  const config = {
    dataDir: path.join(dir, "private"), roots: [root],
    agentPolicyFile: path.join(dir, "policy.json"),
    tailscaleOwner: { userId: "real-owner" },
  };
  const auth = createAuth(config);
  const invite = (extra = {}) => auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "readonly", ttlSeconds: 3600, ...extra });
  const claim = (grant, key) => auth.redeemFunnelBrowser(grant.invitation, key);
  const poll = (receipt, key) => auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, key);
  const reconnect = (grant, key) => auth.reconnectFunnelBrowser(grant.invitation, key);
  const join = (grant, key) => {
    const receipt = claim(grant, key);
    auth.decideAgentAdmission(receipt.requestId, "approve");
    return poll(receipt, key);
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(config.dataDir, "clients.json");
  return { auth, invite, claim, poll, join, file, reconnect };
}
const clock = (t) => {
  const real = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => real() + offset);
  return (ms) => { offset += ms; };
};

test("a timed agent that went quiet keeps its connection, and its same link brings a new browser once the owner approves", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.invite();
  const first = binding();
  const access = f.join(grant, first);
  advance(45 * 60_000);
  assert.ok(f.auth.verifyFunnel(access.token, first), "granted: a quiet agent keeps its connection");
  assert.equal(f.auth.funnelWindow().open, true, "the page stays up for it until the access ends");
  const second = binding();
  const receipt = f.claim(grant, second);
  assert.equal(receipt.moved, undefined, "a request for the owner, not a moved access");
  assert.match(receipt.verificationCode, /^\d{6}$/, "a new code to match");
  assert.equal(f.poll(receipt, second).status, "pending");
  assert.deepEqual(f.auth.listAgentAdmissions().map((r) => r.verificationCode), [receipt.verificationCode]);
  f.auth.decideAgentAdmission(receipt.requestId, "approve");
  const back = f.poll(receipt, second);
  assert.equal(back.status, "approved");
  assert.ok(f.auth.verifyFunnel(back.token, second));
  assert.throws(() => f.poll(receipt, second), { status: 409 }, "collected once");
});

test("a first claim still waiting for the owner can't be taken over by another browser", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const receipt = f.claim(grant, binding());
  assert.throws(() => f.claim(grant, binding()), { status: 401 });
  assert.equal(f.auth.listAgentAdmissions().length, 1);
  assert.equal(f.auth.listAgentAdmissions()[0].requestId, receipt.requestId);
});

test("a waiting request whose browser went quiet for a minute moves to the browser that opens the link", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.invite();
  const gone = binding();
  const first = f.claim(grant, gone);
  advance(30_000);
  f.poll(first, gone);
  advance(45_000);
  assert.throws(() => f.claim(grant, binding()), { status: 401 }, "checked in 45 s ago: still its own");
  advance(20_000);
  const fresh = binding();
  const moved = f.claim(grant, fresh);
  assert.equal(moved.status, "pending");
  assert.equal(moved.moved, undefined, "a new request for the owner, not a moved access");
  assert.notEqual(moved.requestId, first.requestId, "a new request on the owner's phone");
  assert.match(moved.verificationCode, /^\d{6}$/);
  assert.equal(f.auth.listAgentAdmissions().length, 1, "still one request");
  assert.equal(f.poll(first, gone).status, "expired", "the quiet browser's request ended");
  assert.throws(() => f.auth.decideAgentAdmission(first.requestId, "approve"), "an old approval card can't approve the new browser");
  f.auth.decideAgentAdmission(moved.requestId, "approve");
  const back = f.poll(moved, fresh);
  assert.equal(back.status, "approved");
  assert.ok(f.auth.verifyFunnel(back.token, fresh));
});

test("denied, ended or revoked access never comes back through the link", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const denied = f.invite();
  const receipt = f.claim(denied, binding());
  f.auth.decideAgentAdmission(receipt.requestId, "deny");
  assert.throws(() => f.claim(denied, binding()), { status: 403 }, "declined: final, and said so");
  const revoked = f.invite();
  const access = f.join(revoked, binding());
  f.auth.revoke(access.clientId);
  assert.throws(() => f.claim(revoked, binding()), { status: 401 });
  const ended = f.invite({ ttlSeconds: 600 });
  f.join(ended, binding());
  advance(11 * 60_000);
  assert.throws(() => f.claim(ended, binding()), { status: 410 }, "expired: final, and said so");
  assert.equal(f.auth.funnelWindow().open, false, "nothing left: the public page closes");
});

test("a link bounced between browsers is slowed down, not looped forever", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  f.join(grant, binding());
  for (let i = 0; i < 6; i++) f.claim(grant, binding());
  assert.throws(() => f.claim(grant, binding()), { status: 429 });
});

test("agents approved before this change keep their connection and their link too", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.invite();
  const key = binding();
  const access = f.join(grant, key);
  // A record from before: approved and collected, with no approval stamp.
  const clients = JSON.parse(fs.readFileSync(f.file, "utf8"));
  const record = clients.find((c) => c.id === access.clientId);
  assert.ok(record.approvedAt > 0);
  delete record.approvedAt;
  delete record.approvedBinding;
  fs.writeFileSync(f.file, JSON.stringify(clients));
  advance(45 * 60_000);
  assert.ok(f.auth.verifyFunnel(access.token, key), "still connected after silence");
  assert.equal(f.claim(grant, binding()).status, "pending", "its link asks the owner for a new browser");
  assert.equal(f.reconnect(grant, key).refreshed, true, "and its own browser still reconnects at once");
});

test("its own browser reconnects on its own: a new token, the old one ends, nothing for the owner", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const key = binding();
  const access = f.join(grant, key);
  const again = f.reconnect(grant, key);
  assert.equal(again.refreshed, true);
  assert.equal(again.moved, undefined);
  assert.equal(f.auth.listAgentAdmissions().length, 0);
  const back = f.poll(again, key);
  assert.equal(back.status, "approved");
  assert.ok(f.auth.verifyFunnel(back.token, key));
  assert.equal(f.auth.verifyFunnel(access.token, key), null, "one token per browser");
});

test("a reconnect from a browser the access moved away from never takes it back", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const oldKey = binding(), newKey = binding();
  f.join(grant, oldKey);
  const moved = f.claim(grant, newKey);
  f.auth.decideAgentAdmission(moved.requestId, "approve");
  const current = f.poll(moved, newKey);
  assert.throws(() => f.reconnect(grant, oldKey), { status: 423 });
  assert.ok(f.auth.verifyFunnel(current.token, newKey), "the browser in use keeps it");
  // Opening the link there on purpose asks the owner again.
  const back = f.claim(grant, oldKey);
  assert.equal(back.status, "pending");
  assert.equal(f.auth.verifyFunnel(current.token, newKey), null);
  f.auth.decideAgentAdmission(back.requestId, "approve");
  assert.equal(f.poll(back, oldKey).status, "approved");
});

test("a copied link never moves the access: another browser waits for the owner's code, a declined one is refused", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const key = binding(), other = binding();
  const access = f.join(grant, key);
  const asked = f.claim(grant, other);
  assert.equal(asked.status, "pending");
  assert.equal(f.poll(asked, other).status, "pending", "no credential before the owner answers");
  assert.equal(f.auth.listAgentAdmissions()[0].verificationCode, asked.verificationCode);
  f.auth.decideAgentAdmission(asked.requestId, "deny");
  assert.equal(f.poll(asked, other).status, "denied");
  assert.throws(() => f.claim(grant, other), { status: 403 }, "a declined browser stays declined");
  assert.throws(() => f.reconnect(grant, other), { status: 403 });
  // The approved browser takes its access back on its own, at once.
  const again = f.reconnect(grant, key);
  assert.equal(again.refreshed, true);
  const back = f.poll(again, key);
  assert.ok(f.auth.verifyFunnel(back.token, key));
  assert.equal(f.auth.verifyFunnel(access.token, key), null, "one token per browser");
  assert.equal(f.auth.funnelWindow().open, true, "the page stays up for it");
});

test("a browser waiting on a move keeps its code when it opens the link again", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  f.join(grant, binding());
  const other = binding();
  const asked = f.claim(grant, other);
  assert.equal(asked.moving, true);
  const again = f.reconnect(grant, other);
  assert.equal(again.requestId, asked.requestId);
  assert.equal(again.verificationCode, asked.verificationCode, "the same code on the owner's phone");
  assert.equal(f.claim(grant, other).verificationCode, asked.verificationCode);
  assert.equal(f.auth.listAgentAdmissions().length, 1);
});

test("an approved browser takes its access back from a move nobody approved", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const key = binding();
  f.join(grant, key);
  f.claim(grant, binding());
  assert.equal(f.auth.listAgentAdmissions().length, 1);
  const again = f.reconnect(grant, key);
  assert.equal(again.refreshed, true);
  assert.equal(f.auth.listAgentAdmissions().length, 0, "the waiting move is gone from the owner's phone");
  assert.equal(f.poll(again, key).status, "approved");
});

test("before approval, a lost answer is recovered by the same browser only, with the same code", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const key = binding();
  const first = f.claim(grant, key);
  const again = f.claim(grant, key);
  assert.equal(again.resumed, true);
  assert.equal(again.requestId, first.requestId);
  assert.equal(again.verificationCode, first.verificationCode, "the owner compares the same code");
  assert.notEqual(again.requestSecret, first.requestSecret);
  assert.throws(() => f.poll(first, key), { status: 401 }, "the lost receipt no longer works");
  assert.equal(f.auth.listAgentAdmissions().length, 1, "still one request on the owner's phone");
  assert.throws(() => f.claim(grant, binding()), { status: 401 }, "another browser gets nothing");
  assert.equal(f.reconnect(grant, key).resumed, true);
  f.auth.decideAgentAdmission(first.requestId, "approve");
  const latest = f.reconnect(grant, key);
  assert.equal(f.poll(latest, key).status, "approved");
});

test("a request the owner never answered expires; the link asks again while the invitation lasts", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.invite();
  const key = binding();
  const first = f.claim(grant, key);
  advance(6 * 60_000);
  assert.equal(f.poll(first, key).status, "expired", "the unanswered request says so");
  const again = f.claim(grant, binding());
  assert.equal(again.status, "pending");
  assert.notEqual(again.requestId, first.requestId);
  assert.equal(f.auth.listAgentAdmissions().length, 1);
  advance(60 * 60_000);
  assert.throws(() => f.claim(grant, binding()), { status: 410 }, "an ended invitation never asks again");
});

test("the owner can change an agent's access while it moves between browsers", (t) => {
  const f = fixture(t);
  const grant = f.invite();
  const access = f.join(grant, binding());
  const newKey = binding();
  const moved = f.claim(grant, newKey);
  f.auth.changeAccess(access.clientId, { preset: "files", folders: [{ root: 0, path: "" }] });
  f.auth.decideAgentAdmission(moved.requestId, "approve");
  const back = f.poll(moved, newKey);
  assert.equal(back.status, "approved");
  assert.ok(f.auth.verifyFunnel(back.token, newKey));
});

test("a change the owner never approved (another supervising phone) is never re-approved by a reconnect", (t) => {
  const f = fixture(t);
  const approver = { nodeId: "owner-phone", userId: "real-owner", clientId: "owner-client" };
  const grant = f.auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "full", ttlSeconds: 3600 }, approver);
  const key = binding();
  const access = f.join(grant, key);
  assert.ok(f.auth.verifyFunnel(access.token, key));
  const clients = JSON.parse(fs.readFileSync(f.file, "utf8"));
  clients.find((c) => c.id === access.clientId).browserAppApprover.clientId = "replacement-owner";
  fs.writeFileSync(f.file, JSON.stringify(clients));
  assert.equal(f.auth.verifyFunnel(access.token, key), null);
  assert.throws(() => f.reconnect(grant, key), (e) => [401, 410].includes(e.status));
  assert.throws(() => f.claim(grant, binding()), (e) => [401, 410].includes(e.status));
  assert.equal(f.auth.funnelWindow().open, false, "nothing keeps the public page up for it");
});
