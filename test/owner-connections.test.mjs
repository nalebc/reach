import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, getConfig, ALL_SCOPES, atomicJson } from "../server/core.mjs";
import { createOwnerConnections } from "../server/owner-connections.mjs";
import { createBrowserHostGuard } from "../server/browser-host-guard.mjs";

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

function guarded(t, f, approver = { clientId: f.grant.clientId, nodeId: f.source.nodeId, userId: owner.userId }) {
  const guard = createBrowserHostGuard({ clients: () => [...f.auth.list(), {
    id: "active-agent", kind: "agent", policy: { browser: true, screen: "apps" },
    expiresAt: Date.now() + 3600000, browserAppApprover: approver,
  }], ownerConnectionIncludes: (...args) => f.auth.ownerConnectionIncludes(...args),
    trusted: req => req.trusted === true,
    lookup: async () => ({ BackendState: "Running", Self: { ID: "host" },
      Peer: { phone: { ID: approver.nodeId, UserID: 42, OS: "iOS" } } }),
  });
  t.after(() => guard.stop());
  const request = (who = f.target) => ({ trusted: true, reachIdentity: who, headers: {}, method: "GET", originalUrl: "/api/device" });
  return { guard, request, authorize: who => connection => guard.assertOwnerConnection(request(who), connection) };
}

test("an active app agent allows only its approver's signed alternate owner path, including WS admission", async t => {
  const f = fixture(t); f.register();
  const g = guarded(t, f); await g.guard.refresh();
  assert.equal(g.guard.allows(g.request(f.source), f.auth.verify(f.grant.token, f.source)), true);
  assert.equal(g.guard.allowsConnection(g.request()), false, "the destination isn't enrolled yet");
  const unrelated = f.auth.issue("Owner phone", ALL_SCOPES, "device", { tailscale: f.target });
  assert.equal(g.guard.allows(g.request(), f.auth.verify(unrelated.token, f.target)), false, "same user/name/node is not same-client proof");
  f.auth.registerOwnerConnection(unrelated.clientId, newKey().publicKey.export({ format: "jwk" }), "native");
  assert.throws(() => f.api.challenge(f.target, { connection: unrelated.clientId, role: "browser" }, g.authorize()), { status: 403 });
  const candidate = token(), challenge = f.api.challenge(f.target, { connection: f.grant.clientId, role: "browser" }, g.authorize());
  const proof = { id: challenge.id, token: candidate,
    signature: crypto.sign("sha256", Buffer.from(`${challenge.payload}\n${candidate}`), { key: f.key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  assert.throws(() => f.api.join(f.target, { ...proof, token: token() }, g.authorize()), /invalid/);
  const joined = f.api.join(f.target, proof, g.authorize());
  const client = f.auth.verify(candidate, f.target);
  assert.equal(client.id, joined.clientId);
  assert.equal(g.guard.allows(g.request(), client), true);
  assert.equal(g.guard.allowsConnection(g.request()), true, "upgrade allowed before separate credential arrives");
  assert.equal(g.guard.allows(g.request(), null), false, "HTTP and WS still require that credential");
  assert.equal(g.guard.allows(g.request(), f.auth.verify(unrelated.token, f.target)), false);
  for (const who of [identity("host"), identity("unrelated"), { ...f.target, userId: "99" },
    { ...f.target, tagged: true }, { ...f.target, validUntil: 0 }]) {
    assert.equal(g.guard.allows(g.request(who), client), false);
    assert.equal(g.guard.allowsConnection(g.request(who)), false);
  }
  assert.equal(g.guard.allows({ ...g.request(), trusted: false }, client), false);
  assert.throws(() => g.guard.assertOwnerConnection(g.request(identity("host")), f.grant.clientId), { status: 403 });
  g.guard.invalidate();
  assert.equal(g.guard.allows(g.request(), client), false);
  assert.equal(g.guard.allowsConnection(g.request()), false);
});

test("a browser-first owner retains browser access after its enrolled native path invites an app agent", async t => {
  const f = fixture(t, "browser"); f.register();
  const proof = f.proof(), native = f.api.join(f.target, proof);
  const g = guarded(t, f, { clientId: native.clientId, nodeId: f.target.nodeId, userId: owner.userId });
  await g.guard.refresh();
  const browser = f.auth.verify(f.grant.token, f.source);
  assert.equal(g.guard.allows(g.request(f.source), browser), true);
  assert.equal(g.guard.allowsConnection(g.request(f.source)), true);
  f.auth.revoke(native.clientId);
  assert.equal(g.guard.allows(g.request(f.source), browser), false, "removing the pinned path does not silently transfer its supervision");
  assert.equal(g.guard.allowsConnection(g.request(f.source)), false);
});

for (const change of ["root", "alternate", "scopes", "expiry", "relationship"]) test(`app guard rechecks ${change} while an alternate owner connection is open`, async t => {
  const f = fixture(t); f.register();
  const g = guarded(t, f); await g.guard.refresh();
  const proof = f.proof(), joined = f.api.join(f.target, proof, g.authorize());
  const held = f.auth.verify(proof.token, f.target);
  assert.equal(g.guard.allows(g.request(), held), true);
  const pending = f.proof(f.target, proof.token);
  if (change === "root") f.auth.revoke(f.grant.clientId);
  else if (change === "alternate") f.auth.revoke(joined.clientId);
  else {
    const file = path.join(f.dir, "clients.json"), clients = JSON.parse(fs.readFileSync(file));
    const root = clients.find(c => c.id === f.grant.clientId);
    if (change === "scopes") root.scopes = ["admin"];
    else if (change === "expiry") root.expiresAt = Date.now() - 1;
    else root.ownerConnection.other = "unrelated";
    atomicJson(file, clients);
  }
  assert.equal(g.guard.allows(g.request(), held), false, "held work cannot keep the old authority");
  assert.equal(g.guard.allowsConnection(g.request()), false);
  assert.throws(() => f.api.join(f.target, pending, g.authorize()), { status: 403 });
});
