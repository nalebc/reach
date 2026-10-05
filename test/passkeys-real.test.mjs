import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createPasskeys, coseToJwk, decodeCbor, parseAuthData } from "../server/passkeys.mjs";

// Face ID checks against responses recorded from real authenticators (see
// fixtures/webauthn-real.json for where they come from), so the hand-written
// reader is proven on real formats, not only on what these tests produce.
const fx = JSON.parse(
  fs.readFileSync(new URL("./fixtures/webauthn-real.json", import.meta.url), "utf8"),
);
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-passkeys-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const asCredential = (r) => ({
  id: r.id,
  rawId: r.id,
  type: "public-key",
  response: { attestationObject: r.attestationObject, clientDataJSON: r.clientDataJSON },
});

for (const r of fx.registrations)
  test(`real registration (${r.name}) is read and accepted`, (t) => {
    const keys = createPasskeys({
      dataDir: tmp(t),
      rpId: r.rpId,
      origins: [r.origin],
      newChallenge: () => r.challenge,
    });
    keys.registrationOptions("device-1", "me");
    const saved = keys.register("device-1", asCredential(r), "Real device");
    assert.equal(saved.id, r.id);
    assert.equal(keys.has(), true);
  });

test("real registrations are refused for another site, page or attempt", (t) => {
  const r = fx.registrations[0];
  const attempt = (opts) => {
    const keys = createPasskeys({
      dataDir: tmp(t),
      rpId: r.rpId,
      origins: [r.origin],
      newChallenge: () => r.challenge,
      ...opts,
    });
    keys.registrationOptions("d", "me");
    return () => keys.register("d", asCredential(r));
  };
  assert.throws(attempt({ rpId: "mac.tail1.ts.net" }), /made for another site/);
  assert.throws(attempt({ origins: ["https://mac.tail1.ts.net"] }), /another page/);
  assert.throws(attempt({ newChallenge: () => "c29tZXRoaW5nIGVsc2U" }), /earlier attempt/);
});

test("real sign-ins: the signature checks out with this reader; touch without Face ID is still refused", (t) => {
  for (const s of fx.assertions) {
    // The stored key, read from its COSE form, verifies the real signature.
    const { alg, jwk } = coseToJwk(decodeCbor(Buffer.from(s.publicKey, "base64url")).value);
    assert.equal(alg, -7);
    const authData = Buffer.from(s.authenticatorData, "base64url");
    const clientData = Buffer.from(s.clientDataJSON, "base64url");
    const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]);
    assert.equal(
      crypto.verify("sha256", signed, { key: crypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "der" }, Buffer.from(s.signature, "base64url")),
      true,
      `${s.name}: real signature`,
    );
    assert.equal(JSON.parse(clientData).challenge, s.challenge);
    const parsed = parseAuthData(authData);
    assert.equal(parsed.userPresent, true);
    assert.equal(parsed.userVerified, false, "these came from a security key tapped, not Face ID");
    // Through the whole check, they stop exactly at "Face ID required".
    const dir = tmp(t);
    fs.writeFileSync(
      path.join(dir, "passkeys.json"),
      JSON.stringify({ version: 1, userHandle: "dXNlcg", credentials: [{ id: s.id, alg, jwk, signCount: s.storedCounter, label: "key" }] }),
    );
    const keys = createPasskeys({ dataDir: dir, rpId: s.rpId, origins: [s.origin], newChallenge: () => s.challenge });
    keys.assertionOptions("r:n");
    assert.throws(
      () => keys.verifyAssertion("r:n", { id: s.id, rawId: s.id, type: "public-key", response: { authenticatorData: s.authenticatorData, clientDataJSON: s.clientDataJSON, signature: s.signature } }),
      /Face ID \(or your device passcode\) is required/,
    );
  }
});
