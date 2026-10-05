import crypto from "node:crypto";

// A software passkey: what a phone's authenticator produces for
// navigator.credentials.create() and .get(), byte for byte.
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (d) => crypto.createHash("sha256").update(d).digest();

export function cbor(v) {
  const head = (major, n) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map)
    return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw Error("unsupported");
}

export function softAuthenticator({ origin }) {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);
  const id = crypto.randomBytes(16);
  let userHandle = null;
  return {
    create(options, { from = origin } = {}) {
      userHandle = Buffer.from(options.user.id, "base64url");
      const authData = Buffer.concat([sha(options.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, id.length]), id, cbor(cose)]);
      return {
        id: b64u(id), rawId: b64u(id), type: "public-key",
        response: {
          clientDataJSON: b64u(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: from })),
          attestationObject: b64u(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))),
          transports: ["internal", "hybrid"],
        },
      };
    },
    get(options, { from = origin } = {}) {
      const authData = Buffer.concat([sha(options.rpId), Buffer.from([0x05]), Buffer.alloc(4)]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: from }));
      const signature = crypto.sign("sha256", Buffer.concat([authData, sha(clientDataJSON)]), { key: pair.privateKey, dsaEncoding: "der" });
      return {
        id: b64u(id), rawId: b64u(id), type: "public-key",
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: b64u(userHandle) },
      };
    },
  };
}
