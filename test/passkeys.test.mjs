import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createPasskeys, decodeCbor, parseAuthData } from "../server/passkeys.mjs";

// Face ID as a way to approve a new browser: every check a relying party must
// make, against a software authenticator producing what a phone produces.
const RP = "mac.tail1.ts.net";
const ORIGIN = `https://${RP}`; // the start page (browser sign-in)
const PRIVATE = `https://${RP}:8443`; // the private link (Tailscale app)
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (d) => crypto.createHash("sha256").update(d).digest();

// A minimal CBOR encoder (what an authenticator writes).
function cbor(v) {
  const head = (major, n) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : n < 65536
          ? Buffer.from([(major << 5) | 25, n >> 8, n & 255])
          : Buffer.concat([Buffer.from([(major << 5) | 26]), Buffer.from(new Uint32Array([n]).buffer).reverse()]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map)
    return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw Error("unsupported");
}
function authenticator({ rsa = false } = {}) {
  const pair = rsa
    ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    : crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const cose = rsa
    ? new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, "base64url")], [-2, Buffer.from(jwk.e, "base64url")]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);
  const id = crypto.randomBytes(16);
  let counter = 0;
  const auth = { counted: false, flags: 0x05, rp: RP, userHandle: null };
  auth.create = (options, { origin = ORIGIN, flags = 0x45 } = {}) => {
    auth.userHandle = Buffer.from(options.user.id, "base64url");
    const authData = Buffer.concat([
      sha(options.rp.id),
      Buffer.from([flags]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      Buffer.from([0, id.length]),
      id,
      cbor(cose),
    ]);
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false })),
        attestationObject: b64u(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))),
        transports: ["internal", "hybrid"],
      },
    };
  };
  auth.get = (options, { origin = ORIGIN, flags = auth.flags, rp = auth.rp, tamper = false, handle } = {}) => {
    if (auth.counted) counter++;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authData = Buffer.concat([sha(rp), Buffer.from([flags]), count]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false, other_keys_can_be_added_here: "x" }),
    );
    const signed = Buffer.concat([authData, sha(clientDataJSON)]);
    const signature = rsa
      ? crypto.sign("sha256", signed, pair.privateKey)
      : crypto.sign("sha256", signed, { key: pair.privateKey, dsaEncoding: "der" });
    if (tamper) signature[signature.length - 3] ^= 1;
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: b64u(handle || auth.userHandle || crypto.randomBytes(32)),
      },
    };
  };
  return auth;
}
function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-passkeys-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = createPasskeys({ dataDir: dir, rpId: RP, origins: [ORIGIN, PRIVATE], ...extra });
  return { keys, dir };
}
const added = (keys, auth, client = "phone-1") => keys.register(client, auth.create(keys.registrationOptions(client, "me@x.test")), "iPhone");

test("add Face ID from an approved device, then approve a new browser with it", async (t) => {
  const { keys, dir } = setup(t);
  assert.equal(keys.has(), false);
  const phone = authenticator();
  const options = keys.registrationOptions("phone-1", "me@x.test");
  assert.equal(options.rp.id, RP);
  assert.equal(options.authenticatorSelection.userVerification, "required");
  assert.equal(options.attestation, "none");
  const saved = keys.register("phone-1", phone.create(options), "iPhone");
  assert.equal(saved.label, "iPhone");
  assert.equal(keys.has(), true);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "passkeys.json")).mode & 0o777, 0o600);
  // A new browser (from the start page or the private link) uses it.
  for (const origin of [ORIGIN, PRIVATE]) {
    const ask = keys.assertionOptions(`request-${origin}:nChrome`);
    assert.deepEqual(ask.allowCredentials.map((c) => c.id), [saved.id]);
    assert.equal(ask.rpId, RP);
    assert.deepEqual(keys.verifyAssertion(`request-${origin}:nChrome`, phone.get(ask, { origin })), { id: saved.id, label: "iPhone" });
  }
  assert.ok(keys.list()[0].usedAt);
});

test("used once: a replayed response is refused; another request's challenge doesn't fit", async (t) => {
  const { keys } = setup(t);
  const phone = authenticator();
  added(keys, phone);
  const ask = keys.assertionOptions("r1:nChrome");
  const response = phone.get(ask);
  keys.verifyAssertion("r1:nChrome", response);
  assert.throws(() => keys.verifyAssertion("r1:nChrome", response), /took too long|earlier attempt/);
  // A response for request A, offered for request B (or another device).
  const forA = phone.get(keys.assertionOptions("rA:nChrome"));
  keys.assertionOptions("rB:nOther");
  assert.throws(() => keys.verifyAssertion("rB:nOther", forA), /earlier attempt/);
  assert.throws(() => keys.verifyAssertion("rZ:nNone", forA), /took too long/);
});

test("refused: another page, another site, no Face ID, a bad signature, an unknown or someone else's passkey", async (t) => {
  const { keys } = setup(t);
  const phone = authenticator();
  added(keys, phone);
  const attempt = (opts) => {
    const ask = keys.assertionOptions("r:n");
    return () => keys.verifyAssertion("r:n", phone.get(ask, opts));
  };
  assert.throws(attempt({ origin: "https://evil.example.com" }), /another page/);
  assert.throws(attempt({ origin: `https://${RP}:9999` }), /another page/, "only Reach's two addresses");
  assert.throws(attempt({ rp: "other.tail1.ts.net" }), /made for another site/);
  assert.throws(attempt({ flags: 0x01 }), /Face ID \(or your device passcode\) is required/, "presence without verification");
  assert.throws(attempt({ tamper: true }), /didn't check out/);
  assert.throws(attempt({ handle: crypto.randomBytes(32) }), /belongs to someone else/);
  const stranger = authenticator();
  const ask = keys.assertionOptions("r:n");
  assert.throws(() => keys.verifyAssertion("r:n", stranger.get(ask)), /isn't set up on this computer/);
});

test("expired challenges, counters that must go up, and limits", async (t) => {
  let clock = 1_000_000;
  const { keys } = setup(t, { now: () => clock });
  const phone = authenticator();
  added(keys, phone);
  const late = keys.assertionOptions("r:n");
  clock += 121_000;
  assert.throws(() => keys.verifyAssertion("r:n", phone.get(late)), /took too long/);
  // A device with a counter: it must increase every time.
  phone.counted = true;
  keys.verifyAssertion("c:n", phone.get(keys.assertionOptions("c:n")));
  keys.verifyAssertion("c:n", phone.get(keys.assertionOptions("c:n")));
  phone.counted = false; // same count again: looks like a copy
  assert.throws(() => keys.verifyAssertion("c:n", phone.get(keys.assertionOptions("c:n"))), /looks copied/);
  // Ten tries per request, then approve on the computer.
  for (let i = 0; i < 7; i++) keys.assertionOptions("c:n");
  assert.throws(() => keys.assertionOptions("c:n"), /Too many Face ID attempts/);
  // Never added twice; and removable.
  const second = authenticator();
  const saved = added(keys, second, "phone-2");
  const again = keys.registrationOptions("phone-2", "me@x.test");
  assert.ok(again.excludeCredentials.some((c) => c.id === saved.id), "the phone is told it's already added");
  keys.remove(saved.id);
  assert.equal(keys.list().length, 1);
  assert.throws(() => keys.remove(saved.id), /isn't here anymore/);
});

test("adding: made for this computer, with Face ID, from the page that asked", async (t) => {
  const { keys } = setup(t);
  const phone = authenticator();
  assert.throws(() => keys.register("phone-1", phone.create(keys.registrationOptions("phone-1", "me"), { origin: "https://evil.example.com" })), /another page/);
  assert.throws(() => keys.register("phone-1", phone.create({ ...keys.registrationOptions("phone-1", "me"), rp: { id: "evil.example.com" } })), /made for another site/);
  assert.throws(() => keys.register("phone-1", phone.create(keys.registrationOptions("phone-1", "me"), { flags: 0x41 })), /is required/);
  // Another device's registration challenge doesn't fit.
  const forOther = phone.create(keys.registrationOptions("phone-2", "me"));
  assert.throws(() => keys.register("phone-1", forOther), /took too long/);
  assert.equal(keys.has(), false);
});

test("RSA passkeys (RS256) work too", async (t) => {
  const { keys } = setup(t);
  const laptop = authenticator({ rsa: true });
  const saved = added(keys, laptop);
  assert.deepEqual(keys.verifyAssertion("r:n", laptop.get(keys.assertionOptions("r:n"))).id, saved.id);
});

test("strict reading: cut short, extra bytes, unsupported encodings", () => {
  assert.deepEqual(decodeCbor(Buffer.from([0xa1, 0x01, 0x02])).value, new Map([[1, 2]]));
  assert.throws(() => decodeCbor(Buffer.from([0x5f, 0x41, 0x00, 0xff])), /unsupported encoding/, "indefinite length");
  assert.throws(() => decodeCbor(Buffer.from([0x58, 0x05, 0x01])), /cut short/);
  assert.throws(() => decodeCbor(Buffer.from([0xc0, 0x00])), /unsupported encoding/, "tags");
  assert.throws(() => decodeCbor(Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0])), /unsupported encoding/, "floats");
  const authData = Buffer.concat([sha(RP), Buffer.from([0x05]), Buffer.alloc(4)]);
  assert.equal(parseAuthData(authData).userVerified, true);
  assert.throws(() => parseAuthData(Buffer.concat([authData, Buffer.from([0])])), /extra data/);
  assert.throws(() => parseAuthData(authData.subarray(0, 36)), /cut short/);
});


test("malformed backup flags and ambiguous CBOR fields are rejected", () => {
  const auth = Buffer.alloc(37);
  auth[32] = 0x15; // backed up, without backup eligibility
  assert.throws(() => parseAuthData(auth), { status: 400 });
  assert.throws(() => decodeCbor(Buffer.from([0xa2, 0x01, 0x02, 0x01, 0x03])), { status: 400 });
});
