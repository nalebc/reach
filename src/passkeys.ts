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

// What this device calls the unlock a passkey asks for. The feature takes
// any platform passkey, so it's said the same way everywhere, in the
// device's own words: Face ID on an iPhone that has it, Touch ID on a Mac
// (or an iPhone with a home button), "Face ID or Touch ID" on an iPad (or
// an iPhone whose screen doesn't say), fingerprint or face unlock on
// Android (Samsung's included), Windows Hello on Windows. Read from the
// user agent, cautiously: anything else is the screen lock.
export type UnlockWords = {
  word: string; // mid-sentence: "Face ID", "fingerprint or face unlock"
  Word: string; // starting a sentence
  title: string; // a heading or a setting's name
  device: string; // "iPhone", "phone", "PC"…
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function unlockWords({
  ua = typeof navigator === "undefined" ? "" : navigator.userAgent,
  touch = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0,
  // An iPhone's longer side, in points: 812 and up have Face ID; 736 and
  // under (SE, 8) a home button with Touch ID.
  longSide = typeof screen === "undefined" ? 0 : Math.max(screen.width || 0, screen.height || 0),
}: { ua?: string; touch?: number; longSide?: number } = {}): UnlockWords {
  const said = (word: string, device: string) => ({
    word,
    Word: cap(word),
    title: cap(word),
    device,
  });
  if (/iPhone|iPod/.test(ua))
    return said(
      longSide >= 812
        ? "Face ID"
        : longSide && longSide <= 736
          ? "Touch ID"
          : "Face ID or Touch ID",
      "iPhone",
    );
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1))
    return said("Face ID or Touch ID", "iPad");
  if (/Android/.test(ua)) return said("fingerprint or face unlock", "phone");
  if (/Windows/.test(ua)) return said("Windows Hello", "PC");
  if (/Macintosh/.test(ua)) return said("Touch ID", deviceLabel(ua, touch));
  const device = /Mobi/.test(ua) ? "phone" : "device";
  return {
    word: `your ${device}'s screen lock`,
    Word: `Your ${device}'s screen lock`,
    title: "Screen lock",
    device,
  };
}

// Why a passkey didn't happen, in this device's words (`said`; Face ID's
// where a page doesn't say).
export const faceIdError = (
  e: unknown,
  said: Pick<UnlockWords, "word" | "Word" | "device"> = {
    word: "Face ID",
    Word: "Face ID",
    device: "phone",
  },
) => {
  const error = e as {
    name?: string;
    message?: string;
    body?: { error?: string };
  };
  // The computer's own reason: a refused Face ID answer comes back as 401,
  // which request() would otherwise call "pair again".
  if (error?.body?.error) return error.body.error;
  if (/NotAllowed|Abort/.test(error?.name || ""))
    return `${said.Word} was cancelled or took too long.`;
  if (error?.name === "InvalidStateError")
    return `This ${said.device}'s ${said.word} is already added.`;
  if (error?.name === "SecurityError")
    return `${said.Word} can't be used from this page's address. Open Reach from its own link.`;
  return error?.message || `${said.Word} didn't work.`;
};

// What to call the passkey in Settings. An iPad's Safari says it's a Mac:
// its touch screen tells them apart.
export const deviceLabel = (
  ua = navigator.userAgent,
  touch = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0,
) =>
  /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android phone"
        : /Windows/.test(ua)
          ? "Windows PC"
          : /Macintosh/.test(ua)
            ? "Mac"
            : "This device";
