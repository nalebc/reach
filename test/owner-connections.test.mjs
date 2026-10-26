import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, getConfig, ALL_SCOPES, atomicJson } from "../server/core.mjs";
import { createOwnerConnections } from "../server/owner-connections.mjs";

const owner = { userId: "42", login: "owner@example.test" };
const identity = nodeId => ({ ...owner, nodeId, nodeName: nodeId, tagged: false, validUntil: Date.now() + 3600000 });
const newKey = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const token = () => crypto.randomBytes(32).toString("base64url");
function fixture(t, role = "native", options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-owner-pair-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = getConfig({ dataDir: dir, tailscaleOwner: owner });
  const auth = createAuth(config), key = newKey(), source = identity("source"), target = identity("target");
  const grant = auth.issue("Owner phone", ALL_SCOPES, "device", { tailscale: source, ...options });
  const register = () => auth.registerOwnerConnection(grant.clientId, key.publicKey.export({ format: "jwk" }), role);
  const api = createOwnerConnections({ auth, owner });
  const other = role === "native" ? "browser" : "native";
  const proof = (who = target, candidate = token(), signer = key, service = api) => {
    const challenge = service.challenge(who, { connection: grant.clientId, role: other });
    return { id: challenge.id, token: candidate,
      signature: crypto.sign("sha256", Buffer.from(`${challenge.payload}\n${candidate}`), { key: signer.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  };
  return { dir, config, auth, key, source, target, grant, register, api, proof, other };
}
for (const role of ["native", "browser"]) test(`${role}-first owner setup gives the other path its own identity-bound approval`, t => {
  const f = fixture(t, role); f.register();
  const proof = f.proof(), joined = f.api.join(f.target, proof);
  assert.deepEqual(joined.scopes, f.grant.scopes);
  assert.equal(joined.expiresAt, f.grant.expiresAt);
  assert.ok(f.auth.verify(f.grant.token, f.source));
  assert.ok(f.auth.verify(proof.token, f.target));
  assert.equal(f.auth.verify(f.grant.token, f.target), null);
  assert.equal(f.auth.verify(proof.token, f.source), null);
  assert.equal(f.auth.verify(proof.token, identity("unrelated")), null);
  assert.equal(f.auth.verify(proof.token), null);
  assert.throws(() => f.api.join(f.target, proof), /expired/);
  assert.equal(f.auth.list().length, 2);
  assert.ok(f.auth.list().every(client => !client.ownerConnection && !client.hash));
});
test("lost replies, concurrent tabs and a host restart collect only the persisted exact alternate", async t => {
  const f = fixture(t); f.register();
  const candidate = token();
  const proofs = Array.from({ length: 4 }, () => f.proof(f.target, candidate));
  const results = await Promise.all(proofs.map(async p => f.api.join(f.target, p)));
  assert.equal(new Set(results.map(r => r.clientId)).size, 1);
  const restored = createAuth(f.config), service = createOwnerConnections({ auth: restored, owner });
  assert.equal(service.join(f.target, f.proof(f.target, candidate, f.key, service)).clientId, results[0].clientId);
  assert.equal(restored.list().length, 2);
  assert.throws(() => service.join(f.target, f.proof(f.target, token(), f.key, service)), /removed or belongs/);
  assert.throws(() => service.join(identity("another-phone"), f.proof(identity("another-phone"), candidate, f.key, service)), /removed or belongs/);
});
test("proofs bind the challenge, node, proposed credential, role and original key", t => {
  const f = fixture(t); f.register();
  const p = f.proof();
  for (const who of [null, identity("other"), { ...f.target, userId: "99" }, { ...f.target, tagged: true }, { ...f.target, validUntil: 0 }])
    assert.throws(() => f.api.join(who, p), /expired or belongs/);
  assert.throws(() => f.api.join(f.target, { ...p, token: token() }), /invalid/);
  assert.throws(() => f.api.join(f.target, f.proof(f.target, token(), newKey())), /invalid/);
  assert.throws(() => f.api.challenge(f.target, { connection: f.grant.clientId, role: "native" }), /already has/);
  assert.throws(() => f.api.join(f.source, f.proof(f.source)), /no longer approved/);
  assert.throws(() => f.auth.registerOwnerConnection(f.grant.clientId, newKey().publicKey.export({ format: "jwk" }), "native"), /another owner/);
  assert.throws(() => f.auth.registerOwnerConnection(f.grant.clientId, f.key.privateKey.export({ format: "jwk" }), "native"), /valid owner/);
  assert.equal(f.auth.list().length, 1);
});
test("guests, agents, restricted devices and unbound credentials cannot register owner enrollment", t => {
  const f = fixture(t), jwk = f.key.publicKey.export({ format: "jwk" });
  for (const [kind, scopes, opts] of [["guest", ALL_SCOPES, { tailscale: f.source }], ["agent", ["files:read"], { tailscale: f.source }],
    ["device", ["files:read"], { tailscale: f.source }], ["device", ALL_SCOPES, {}]]) {
    const grant = f.auth.issue("other", scopes, kind, opts);
    assert.throws(() => f.auth.registerOwnerConnection(grant.clientId, jwk, "native"), /Only an approved owner/);
  }
});
for (const removal of ["root", "alternate", "scopes", "expiry"]) test(`${removal} revocation invalidates the pair and cannot be undone by enrollment retry`, t => {
  const f = fixture(t); f.register();
  const p = f.proof(), joined = f.api.join(f.target, p);
  if (removal === "root") f.auth.revoke(f.grant.clientId);
  else if (removal === "alternate") f.auth.revoke(joined.clientId);
  else {
    const file = path.join(f.dir, "clients.json");
    const clients = JSON.parse(fs.readFileSync(file));
    const root = clients.find(c => c.id === f.grant.clientId);
    if (removal === "scopes") root.scopes = ["files:read"];
    else root.expiresAt = Date.now() - 1;
    atomicJson(file, clients);
  }
  assert.equal(f.auth.verify(p.token, f.target), null);
  assert.throws(() => f.api.join(f.target, f.proof(f.target, p.token)), /approved|removed or belongs/);
  if (removal === "alternate") assert.ok(f.auth.verify(f.grant.token, f.source), "the remaining source approval stays usable");
});
test("pending proofs expire and challenge storage is bounded", t => {
  const f = fixture(t); f.register(); let now = Date.now();
  const api = createOwnerConnections({ auth: f.auth, owner, now: () => now });
  const p = f.proof(f.target, token(), f.key, api);
  now += 120001;
  assert.throws(() => api.join(f.target, p), /expired/);
  for (let i = 0; i < 8; i++) f.proof(f.target, token(), f.key, api);
  assert.throws(() => f.proof(f.target, token(), f.key, api), /already in progress/);
});
