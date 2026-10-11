// Face ID (a passkey) in the browser. The computer sends its options as JSON
// (ids in base64url); WebAuthn wants bytes, and answers in bytes, which go
// back as base64url. Safari only shows Face ID straight from a tap, so the
// options are fetched beforehand and the tap calls WebAuthn first thing.

// Loose on purpose: the computer's JSON, before the ids become bytes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FaceOptions = Record<string, any>;

const toBytes = (s: string) => {
  const raw = atob(
    s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4),
  );
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const toText = (buf: ArrayBuffer | null | undefined) => {
  if (!buf) return undefined;
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const ids = (list: FaceOptions[] = []) =>
  list.map((c) => ({ ...c, id: toBytes(c.id) }));

// A passkey belongs to its computer's name: only for this page's computer.
export const sameComputer = (url: string) => {
  try {
    return new URL(url).hostname === location.hostname;
  } catch {
    return false;
  }
};

// This phone can do Face ID (or its passcode) for a site.
export async function faceIdReady() {
  try {
    return (
      typeof PublicKeyCredential === "function" &&
      !!navigator.credentials &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

function asJson(credential: Credential | null) {
  const c = credential as PublicKeyCredential | null;
  if (!c) throw Error("Face ID was cancelled.");
  const r = c.response as Partial<
    AuthenticatorAssertionResponse & AuthenticatorAttestationResponse
  >;
  return {
    id: c.id,
    rawId: toText(c.rawId),
    type: c.type,
    response: {
      clientDataJSON: toText(r.clientDataJSON),
      ...(r.authenticatorData
        ? {
            authenticatorData: toText(r.authenticatorData),
            signature: toText(r.signature),
            userHandle: toText(r.userHandle),
          }
        : {}),
      ...(r.attestationObject
        ? {
            attestationObject: toText(r.attestationObject),
            transports: r.getTransports?.() || [],
          }
        : {}),
    },
  };
}

// Call these straight from a tap.
export const signWithFaceId = (options: FaceOptions) =>
  navigator.credentials
    .get({
      publicKey: {
        ...options,
        challenge: toBytes(options.challenge),
        allowCredentials: ids(options.allowCredentials),
      } as unknown as PublicKeyCredentialRequestOptions,
    })
    .then(asJson);
export const createWithFaceId = (options: FaceOptions) =>
  navigator.credentials
    .create({
      publicKey: {
        ...options,
        challenge: toBytes(options.challenge),
        user: { ...options.user, id: toBytes(options.user.id) },
        excludeCredentials: ids(options.excludeCredentials),
      } as unknown as PublicKeyCredentialCreationOptions,
    })
    .then(asJson);

export const faceIdError = (e: unknown) => {
  const error = e as {
    name?: string;
    message?: string;
    body?: { error?: string };
  };
  // The computer's own reason: a refused Face ID answer comes back as 401,
  // which request() would otherwise call "pair again".
  if (error?.body?.error) return error.body.error;
  if (/NotAllowed|Abort/.test(error?.name || ""))
    return "Face ID was cancelled or took too long.";
  if (error?.name === "InvalidStateError")
    return "This phone's Face ID is already added.";
  return error?.message || "Face ID didn't work.";
};

// What to call the passkey in Settings.
export const deviceLabel = (ua = navigator.userAgent) =>
  /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android phone"
        : /Macintosh/.test(ua)
          ? "Mac"
          : "This device";
