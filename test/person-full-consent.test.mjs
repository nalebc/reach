import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../server/core.mjs";
import { actsAsOwner, ScreenControl } from "../server/screen.mjs";

test("stored Full people keep the old screen boundary until explicit current consent", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-person-consent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { dataDir: root, roots: [root], agentPolicyFile: path.join(root, "none.json") };
  let auth = createAuth(config, { rotatePairing: false });
  const invite = extra => auth.inviteGuest({ name: "Fixture person", ttlSeconds: 600, full: true, ...extra });
  const old = auth.redeemGuest(invite().invitation);
  const current = auth.redeemGuest(invite({ fullControlVersion: 1 }).invitation);
  auth = createAuth(config, { rotatePairing: false });
  const control = new ScreenControl();
  control.dialogUp = () => true;
  const legacy = auth.verify(old.token), fresh = auth.verify(current.token);
  assert.equal(actsAsOwner(legacy), false, "upgrade cannot silently widen a saved grant");
  assert.throws(() => control.acquire(legacy, true), { status: 423 });
  assert.equal(actsAsOwner(fresh), true);
  assert.equal(control.acquire(fresh, true).enabled, true);
  for (const fullControlVersion of [0, 2, "1", true, null])
    assert.throws(() => invite({ fullControlVersion }), { status: 400 });
  auth.changeAccess(current.clientId, { screen: "view" });
  assert.equal(actsAsOwner(auth.verify(current.token)), false);
  auth.changeAccess(old.clientId, { full: true });
  assert.equal(actsAsOwner(auth.verify(old.token)), false, "a cached old form cannot add consent");
  auth.changeAccess(old.clientId, { full: true, fullControlVersion: 1 });
  assert.equal(actsAsOwner(auth.verify(old.token)), true);
});
