import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, hash, hostedConnector } from "../server/core.mjs";
import { applyAgentPolicy } from "../server/agent-policy.mjs";
import { FULL_CONTROL_VERSION, presetScopes, validatePresetInvitation } from "../server/agent-presets.mjs";
import { browserAppSessionActive } from "../server/browser-host-guard.mjs";

test("a stored guarded Full grant cannot silently become unrestricted after restart or access editing", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-full-migration-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  const config = { dataDir: path.join(root, "state"), roots: [shared], agentPolicyFile: path.join(root, "none.json") };
  fs.mkdirSync(config.dataDir);
  const policy = { invite: true, browser: true, preset: "full", roots: [shared], hidden: [{ id: "/Applications/Passwords.app" }] };
  const token = "a".repeat(43), invitation = "b".repeat(43);
  const legacy = { id: "old-full", kind: "agent", name: "Previously guarded", policy, scopes: presetScopes(policy),
    createdAt: new Date().toISOString(), expiresAt: Date.now() + 3600_000, hash: hash(token) };
  const waiting = { ...legacy, id: "old-waiting", hash: undefined, inviteHash: hash(invitation), inviteExpiresAt: Date.now() + 900_000 };
  const connectorHash = hash(hostedConnector(invitation));
  const hosted = { ...waiting, id: "old-hosted", browserTransport: "funnel", hosted: true, connectorHash };
  const file = path.join(config.dataDir, "clients.json");
  const bytes = JSON.stringify([legacy, waiting, hosted]);
  fs.writeFileSync(file, bytes);
  assert.equal(applyAgentPolicy(legacy, config), null, "deny before adding filesystem root or removing hidden apps");
  const auth = createAuth(config);
  assert.equal(auth.verify(token), null, "an old credential cannot use the wider policy");
  assert.equal(auth.list().find(c => c.id === legacy.id).needsInvitation, true);
  assert.equal(auth.list().find(c => c.id === legacy.id).status, "expired");
  assert.equal(auth.funnelWindow().open, false, "an invalidated waiting Tools grant cannot open the public page");
  assert.deepEqual(auth.hostedConnectors().get(connectorHash), { waiting: false }, "invalidated hosted grant can report ended access but admits no registrations");
  assert.equal(browserAppSessionActive(auth.list().find(c => c.id === legacy.id)), false, "invalidated access cannot lock out the owner");
  for (const changes of [{ preset: "full", folders: "keep" }, { expiresAt: Date.now() + 7200_000 }, { preset: "readonly" }])
    assert.throws(() => auth.changeAccess(legacy.id, changes), e => e.status === 409 && /Full control is no longer available/.test(e.message));
  assert.throws(() => auth.redeemGuest(invitation), e => e.status === 410 && /Full control is no longer available/.test(e.message));
  assert.throws(() => auth.renewInvitation(waiting.id), e => e.status === 409 && /Full control is no longer available/.test(e.message));
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "refusals do not rewrite consent or issue credentials");
  assert.equal(createAuth(config, { rotatePairing: false }).verify(token), null, "denial survives another restart");
});

test("agent Full control invitations are rejected regardless of consent version", () => {
  const input = { name: "Trusted agent", preset: "full", fullControlVersion: FULL_CONTROL_VERSION, ttlSeconds: 900 };
  const policy = { invite: true, browser: true, preset: "full", fullControlVersion: FULL_CONTROL_VERSION, roots: [] };
  assert.equal(applyAgentPolicy({ kind: "agent", scopes: presetScopes(policy), policy }, { roots: [] }), null);
  for (const version of [undefined, 0, 2, "1"])
    assert.throws(() => validatePresetInvitation({ ...input, fullControlVersion: version }), e => e.status === 403);
  assert.throws(() => validatePresetInvitation({ ...input, preset: "readonly" }), e => e.status === 403);
});
