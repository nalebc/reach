import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../server/core.mjs";

// A public-link agent that is thinking (no request for a while) must not lose
// its session: a preset session ends after ten silent minutes, a session from
// the earlier invitation form after two. Each authenticated request starts
// the count again. Always access never ends this way (agent-standing-access).
const binding = () => crypto.randomBytes(32).toString("base64url");
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-idle-")));
  const root = path.join(dir, "shared");
  fs.mkdirSync(root);
  const config = {
    dataDir: path.join(dir, "private"), roots: [root],
    agentPolicyFile: path.join(dir, "policy.json"),
    tailscaleOwner: { userId: "real-owner" },
  };
  const auth = createAuth(config);
  const invite = (extra) => auth.inviteBrowser({ name: "Muse", transport: "funnel", ttlSeconds: 3600, ...extra });
  const join = (grant, key) => {
    const receipt = auth.redeemFunnelBrowser(grant.invitation, key);
    auth.decideAgentAdmission(receipt.requestId, "approve");
    return auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, key);
  };
  const record = (id) => JSON.parse(fs.readFileSync(path.join(config.dataDir, "clients.json"), "utf8")).find((client) => client.id === id);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { auth, invite, join, record };
}
// A frozen clock: time passes only when the test says so.
const clock = (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return (ms) => { now += ms; };
};

test("an approved preset session never ends from silence, only when its access ends; an earlier-form session ends after two", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const presetKey = binding(), earlierKey = binding();
  const preset = f.join(f.invite({ preset: "readonly" }), presetKey);
  const earlier = f.join(f.invite({ screen: "view" }), earlierKey);
  assert.equal(f.record(preset.clientId).browserIdleExpiresAt, Date.now() + 10 * 60_000);
  assert.equal(f.record(earlier.clientId).browserIdleExpiresAt, Date.now() + 2 * 60_000);
  advance(119_000);
  assert.ok(f.auth.verifyFunnel(earlier.token, earlierKey));
  advance(2_000);
  assert.equal(f.auth.verifyFunnel(earlier.token, earlierKey), null, "the earlier form: two silent minutes");
  assert.ok(f.auth.verifyFunnel(preset.token, presetKey), "a preset agent is still thinking");
  advance(30 * 60_000);
  assert.ok(f.auth.verifyFunnel(preset.token, presetKey), "granted: silence never ends it");
  advance(60 * 60_000);
  assert.equal(f.auth.verifyFunnel(preset.token, presetKey), null, "it ends when its access ends");
});

test("a request from the agent's browser starts a preset session's ten minutes again", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const key = binding();
  const access = f.join(f.invite({ preset: "readonly" }), key);
  advance(9 * 60_000);
  f.auth.touchFunnel(access.token, key);
  assert.equal(f.record(access.clientId).browserIdleExpiresAt, Date.now() + 10 * 60_000);
  advance(9 * 60_000);
  assert.ok(f.auth.verifyFunnel(access.token, key), "renewed at nine minutes, alive at eighteen");
  // The session never outlives the invitation's own end.
  advance(50 * 60_000);
  assert.equal(f.auth.verifyFunnel(access.token, key), null);
});
