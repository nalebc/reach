import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, loadJson, fail } from "./core.mjs";

// Face ID (a passkey) as another way to approve a new browser of yours. You
// add it once from a device this computer already approved; afterwards, a
// new browser on your Tailscale account can be approved with Face ID instead
// of typing its code here. It proves it's you (your passkey, synced by your
// Apple or Google account), never which phone; the request it approves is
// still bound to that browser's own Tailscale device.
//
// WebAuthn is checked here without dependencies: a strict CBOR reader, the
// two common key types (ES256, RS256), and every check a relying party must
// make (challenge, origin, RP ID, user presence and verification, signature,
// signature counter).

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => {
  if (
    typeof s !== "string" ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(s) ||
    s.length > 16384
  )
    throw fail(400, "That Face ID response isn't readable.");
  return Buffer.from(s.replace(/=+$/, ""), "base64url");
};
const sha256 = (data) => crypto.createHash("sha256").update(data).digest();

// CBOR, only what WebAuthn uses: definite lengths, no tags, no floats.
// Returns the value and where it ended (to step past a COSE key in authData).
export function decodeCbor(buf, start = 0, depth = 0) {
  if (depth > 16)
    throw fail(400, "That Face ID response is too deeply nested.");
  let at = start;
  const need = (n) => {
    if (at + n > buf.length)
      throw fail(400, "That Face ID response is cut short.");
  };
  need(1);
  const head = buf[at++];
  const major = head >> 5,
    info = head & 31;
  let length;
  if (info < 24) length = info;
  else if (info === 24) (need(1), (length = buf[at]), (at += 1));
  else if (info === 25) (need(2), (length = buf.readUInt16BE(at)), (at += 2));
  else if (info === 26) (need(4), (length = buf.readUInt32BE(at)), (at += 4));
  else if (info === 27) {
    need(8);
    const big = buf.readBigUInt64BE(at);
    at += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER))
      throw fail(400, "That Face ID response has an oversized number.");
    length = Number(big);
  } else throw fail(400, "That Face ID response uses unsupported encoding.");
  switch (major) {
    case 0:
      return { value: length, end: at };
    case 1:
      return { value: -1 - length, end: at };
    case 2:
      need(length);
      return { value: buf.subarray(at, at + length), end: at + length };
    case 3:
      need(length);
      return { value: buf.toString("utf8", at, at + length), end: at + length };
    case 4: {
      if (length > 1024) throw fail(400, "That Face ID response is too large.");
      const items = [];
      for (let i = 0; i < length; i++) {
        const item = decodeCbor(buf, at, depth + 1);
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    case 5: {
      if (length > 1024) throw fail(400, "That Face ID response is too large.");
      const map = new Map();
      for (let i = 0; i < length; i++) {
        const key = decodeCbor(buf, at, depth + 1);
        const value = decodeCbor(buf, key.end, depth + 1);
        if (map.has(key.value)) throw fail(400, "Duplicate passkey response field.");
        map.set(key.value, value.value);
        at = value.end;
      }
      return { value: map, end: at };
    }
    case 7:
      if (info === 20) return { value: false, end: at };
      if (info === 21) return { value: true, end: at };
      if (info === 22) return { value: null, end: at };
      throw fail(400, "That Face ID response uses unsupported encoding.");
    default:
      throw fail(400, "That Face ID response uses unsupported encoding.");
  }
}

// A COSE public key (ES256 or RS256) as a JWK this computer can verify with.
export function coseToJwk(map) {
  if (!(map instanceof Map))
    throw fail(400, "That passkey has no readable key.");
  const kty = map.get(1),
    alg = map.get(3);
  if (kty === 2 && alg === -7) {
    const x = map.get(-2),
      y = map.get(-3);
    if (map.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32)
      throw fail(400, "That passkey's key isn't a P-256 key.");
    return {
      alg: -7,
      jwk: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) },
    };
  }
  if (kty === 3 && alg === -257) {
    const n = map.get(-1),
      e = map.get(-2);
    if (!Buffer.isBuffer(n) || n.length < 256 || !Buffer.isBuffer(e) || !e.length)
      throw fail(400, "That passkey's RSA key is too small.");
    return { alg: -257, jwk: { kty: "RSA", n: b64u(n), e: b64u(e) } };
  }
  throw fail(400, "That passkey's key type isn't supported here.");
}

// authenticatorData: who it's for (RP ID hash), what happened (flags),
// the signature counter, and, when registering, the new credential.
const UP = 0x01,
  UV = 0x04,
  AT = 0x40,
  ED = 0x80;
export function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37)
    throw fail(400, "That Face ID response is cut short.");
  const flags = buf[32];
  if ((flags & 0x10) && !(flags & 0x08))
    throw fail(400, "Invalid passkey backup flags.");
  const out = {
    rpIdHash: buf.subarray(0, 32),
    flags,
    userPresent: !!(flags & UP),
    userVerified: !!(flags & UV),
    backupEligible: !!(flags & 0x08),
    signCount: buf.readUInt32BE(33),
  };
  let at = 37;
  if (flags & AT) {
    if (buf.length < at + 18)
      throw fail(400, "That Face ID response is cut short.");
    const idLength = buf.readUInt16BE(at + 16);
    at += 18;
    if (idLength < 1 || idLength > 1023 || buf.length < at + idLength)
      throw fail(400, "That passkey's id isn't readable.");
    out.credentialId = buf.subarray(at, at + idLength);
    at += idLength;
    const key = decodeCbor(buf, at);
    out.publicKey = key.value;
    at = key.end;
  }
  if (flags & ED) at = decodeCbor(buf, at).end; // extensions: read, unused
  if (at !== buf.length)
    throw fail(400, "That Face ID response has extra data.");
  return out;
}

// clientDataJSON: what the browser says it did, for which page and challenge.
function checkClientData(raw, { type, challenge, origins }) {
  let data;
  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    throw fail(400, "That Face ID response isn't readable.");
  }
  if (data?.type !== type)
    throw fail(400, "That Face ID response is for something else.");
  if (
    typeof data.challenge !== "string" ||
    data.challenge.replace(/=+$/, "") !== challenge
  )
    throw fail(
      401,
      "That Face ID response is for an earlier attempt. Try again.",
    );
  if (!origins.includes(data.origin) || data.crossOrigin === true)
    throw fail(401, "That Face ID response came from another page.");
  return sha256(raw);
}

export function createPasskeys({
  dataDir,
  rpId, // this computer's Tailscale name, e.g. mac.tail1.ts.net
  origins, // the private link and the start page on that name, exactly
  now = Date.now,
  // Tests replay recorded responses, which carry their own challenge.
  newChallenge = () => b64u(crypto.randomBytes(32)),
}) {
  const file = path.join(dataDir, "passkeys.json");
  const challenges = new Map();
  const rpIdHash = sha256(rpId);
  const read = () => {
    const value = loadJson(file, null);
    return value?.version === 1 && Array.isArray(value.credentials)
      ? value
      : null;
  };
  // Saved the first time it's needed: the passkey keeps the user id it was
  // made with, and every later sign-in must match it.
  const store = () => {
    const existing = read();
    if (existing) return existing;
    const fresh = {
      version: 1,
      userHandle: b64u(crypto.randomBytes(32)),
      credentials: [],
    };
    atomicJson(file, fresh);
    return fresh;
  };
  // A challenge per purpose (registering from one device, or one pending
  // request on one Tailscale device), used once, for two minutes.
  const issue = (key) => {
    for (const [k, c] of challenges) if (c.until <= now()) challenges.delete(k);
    if (challenges.size > 256)
      throw fail(429, "Too many Face ID attempts. Wait a minute.");
    const previous = challenges.get(key);
    const attempts = (previous?.attempts || 0) + 1;
    if (attempts > 10)
      throw fail(
        429,
        "Too many Face ID attempts here. Approve on your computer instead.",
      );
    const challenge = newChallenge();
    challenges.set(key, { challenge, until: now() + 120000, attempts });
    return challenge;
  };
  const take = (key) => {
    const c = challenges.get(key);
    if (!c?.challenge || c.until <= now())
      throw fail(401, "Face ID took too long. Try again.");
    challenges.set(key, { ...c, challenge: null }); // used once; attempts kept
    return c.challenge;
  };
  // Signing in from the internet (the start page: server/face-join.mjs) has a
  // pool of its own, small and capped: filling it from the internet can't get
  // in the way of the challenges your tailnet devices use above.
  const open = new Map();
  const OPEN_MAX = 32;
  const fields = (credential) => {
    if (
      !credential ||
      typeof credential !== "object" ||
      credential.type !== "public-key"
    )
      throw fail(400, "That Face ID response isn't readable.");
    return credential.response || {};
  };

  return {
    has: () => (read()?.credentials.length || 0) > 0,
    list: () =>
      (read()?.credentials || []).map(({ id, label, createdAt, usedAt }) => ({
        id,
        label,
        createdAt,
        ...(usedAt ? { usedAt } : {}),
      })),
    remove(id) {
      const s = read();
      if (!s?.credentials.some((c) => c.id === id))
        throw fail(404, "That passkey isn't here anymore.");
      atomicJson(file, {
        ...s,
        credentials: s.credentials.filter((c) => c.id !== id),
      });
    },

    // Adding one, from a device this computer already approved.
    registrationOptions(clientId, owner) {
      const s = store();
      if (s.credentials.length >= 10)
        throw fail(409, "Remove an old passkey before adding another.");
      return {
        challenge: issue(`add:${clientId}`),
        rp: { id: rpId, name: "Reach" },
        user: { id: s.userHandle, name: owner, displayName: owner },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        excludeCredentials: s.credentials.map((c) => ({
          type: "public-key",
          id: c.id,
          ...(c.transports ? { transports: c.transports } : {}),
        })),
        attestation: "none",
        timeout: 120000,
      };
    },
    register(clientId, credential, label) {
      const response = fields(credential);
      const challenge = take(`add:${clientId}`);
      checkClientData(unb64u(response.clientDataJSON), {
        type: "webauthn.create",
        challenge,
        origins,
      });
      // The attestation statement isn't needed: the passkey is added from a
      // device you approved here. Only its key and flags are read.
      const attestationRaw = unb64u(response.attestationObject);
      const attestation = decodeCbor(attestationRaw);
      if (
        !(attestation.value instanceof Map) ||
        attestation.end !== attestationRaw.length
      )
        throw fail(400, "That Face ID response isn't readable.");
      const authData = parseAuthData(
        Buffer.from(attestation.value.get("authData") || []),
      );
      if (!authData.rpIdHash.equals(rpIdHash))
        throw fail(401, "That passkey was made for another site.");
      if (!authData.userPresent || !authData.userVerified)
        throw fail(401, "Face ID (or your device passcode) is required.");
      if (!authData.credentialId)
        throw fail(400, "That Face ID response has no passkey in it.");
      const key = coseToJwk(authData.publicKey);
      crypto.createPublicKey({ key: key.jwk, format: "jwk" }); // must load
      const s = store();
      const id = b64u(authData.credentialId);
      if (!unb64u(credential.id).equals(authData.credentialId) ||
          !unb64u(credential.rawId).equals(authData.credentialId))
        throw fail(400, "The passkey IDs do not match.");
      if (s.credentials.length >= 10)
        throw fail(409, "Remove an old passkey before adding another.");
      if (s.credentials.some((c) => c.id === id))
        throw fail(409, "That passkey is already added.");
      const transports = Array.isArray(response.transports)
        ? response.transports
            .filter((t) => typeof t === "string" && t.length < 20)
            .slice(0, 8)
        : undefined;
      const added = {
        id,
        alg: key.alg,
        jwk: key.jwk,
        signCount: authData.signCount,
        backupEligible: authData.backupEligible,
        ...(transports?.length ? { transports } : {}),
        label:
          String(label || "Passkey")
            .replace(/[\x00-\x1f\x7f]/g, "")
            .slice(0, 60) || "Passkey",
        createdAt: new Date(now()).toISOString(),
        addedBy: clientId,
      };
      atomicJson(file, { ...s, credentials: [...s.credentials, added] });
      return { id, label: added.label, createdAt: added.createdAt };
    },

    // Using one, for a pending request (bound to its Tailscale device).
    assertionOptions(binding) {
      const s = read();
      if (!s?.credentials.length)
        throw fail(404, "No passkey is set up on this computer yet.");
      return {
        challenge: issue(`use:${binding}`),
        rpId,
        allowCredentials: s.credentials.map((c) => ({
          type: "public-key",
          id: c.id,
          ...(c.transports ? { transports: c.transports } : {}),
        })),
        userVerification: "required",
        timeout: 120000,
      };
    },
    verifyAssertion(binding, credential) {
      fields(credential);
      return check(take(`use:${binding}`), credential);
    },

    // Signing in from the internet: no passkey IDs are given out (your
    // phone finds its own; iPhone passkeys always can), and the answer must
    // name the user this computer's passkeys were made for.
    publicOptions() {
      if (!read()?.credentials.length)
        throw fail(404, "No passkey is set up on this computer yet.");
      for (const [k, c] of open) if (c.until <= now()) open.delete(k);
      if (open.size >= OPEN_MAX)
        throw fail(429, "Too many Face ID sign-ins right now. Try again in a minute.");
      const id = b64u(crypto.randomBytes(16));
      const challenge = newChallenge();
      open.set(id, { challenge, until: now() + 120000 });
      return {
        id,
        options: {
          challenge,
          rpId,
          allowCredentials: [],
          userVerification: "required",
          timeout: 120000,
        },
      };
    },
    verifyPublic(id, credential) {
      const c = typeof id === "string" ? open.get(id) : undefined;
      open.delete(id); // used once, whatever the answer
      if (!c || c.until <= now())
        throw fail(401, "Face ID took too long. Try again.");
      return check(c.challenge, credential, { handle: true });
    },
  };

  // The checks every sign-in answer gets. `handle`: the answer must carry the
  // user handle (from the internet; the tailnet's may leave it out).
  function check(challenge, credential, { handle = false } = {}) {
    const response = fields(credential);
    const s = read();
    const id =
      typeof credential.id === "string"
        ? credential.id.replace(/=+$/, "")
        : "";
    const known = s?.credentials.find((c) => c.id === id);
    if (!known)
      throw fail(401, "That passkey isn't set up on this computer.");
    const clientHash = checkClientData(unb64u(response.clientDataJSON), {
      type: "webauthn.get",
      challenge,
      origins,
    });
    const authRaw = unb64u(response.authenticatorData);
    const authData = parseAuthData(authRaw);
    if (authData.flags & AT) throw fail(400, "A sign-in must not register a key.");
    if (known.backupEligible !== undefined && known.backupEligible !== authData.backupEligible)
      throw fail(401, "The passkey backup eligibility changed.");
    if (!unb64u(credential.rawId).equals(unb64u(known.id)))
      throw fail(400, "The passkey IDs do not match.");
    if (!authData.rpIdHash.equals(rpIdHash))
      throw fail(401, "That passkey was made for another site.");
    if (!authData.userPresent || !authData.userVerified)
      throw fail(401, "Face ID (or your device passcode) is required.");
    const user = response.userHandle ? unb64u(response.userHandle) : null;
    if (handle && !user?.length)
      throw fail(401, "That Face ID response isn't complete.");
    if (
      user?.length &&
      !user.equals(Buffer.from(s.userHandle, "base64url"))
    )
      throw fail(401, "That passkey belongs to someone else.");
    const key = crypto.createPublicKey({ key: known.jwk, format: "jwk" });
    const signed = Buffer.concat([authRaw, clientHash]);
    const signature = unb64u(response.signature);
    const ok =
      known.alg === -7
        ? crypto.verify(
            "sha256",
            signed,
            { key, dsaEncoding: "der" },
            signature,
          )
        : crypto.verify(
            "sha256",
            signed,
            { key, padding: crypto.constants.RSA_PKCS1_PADDING },
            signature,
          );
    if (!ok) throw fail(401, "That Face ID response didn't check out.");
    // Synced passkeys always say 0; a counter that's in use must go up.
    if (
      (authData.signCount || known.signCount) &&
      authData.signCount <= known.signCount
    )
      throw fail(
        401,
        "That passkey looks copied. Remove it in Settings and add it again.",
      );
    atomicJson(file, {
      ...s,
      credentials: s.credentials.map((c) =>
        c.id === known.id
          ? {
              ...c,
              signCount: authData.signCount,
        backupEligible: authData.backupEligible,
              usedAt: new Date(now()).toISOString(),
            }
          : c,
      ),
    });
    return { id: known.id, label: known.label };
  }
}
