// Notifications on your phone when something needs you and Reach isn't open:
// Web Push (RFC 8030), each message encrypted for that phone (RFC 8291) and
// signed by this computer (VAPID, RFC 8292). Apple, Google or Mozilla carry
// it but can't read it. Messages say what needs you; a request quotes its
// short question or command so it can be answered from the notification.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fail } from "./core.mjs";

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
const unb64 = (text) => Buffer.from(String(text), "base64url");
const RECORD_SIZE = 4096;
const MAX_PER_CLIENT = 5;
// "done": a chat finished its work (agent-sessions/done-watch.mjs).
// "openclaw": OpenClaw's background work ended (openclaw-watch.mjs).
// A switch missing from saved preferences is on.
const categories = ["chat", "done", "openclaw", "computer", "handoffs", "access"];
const preferences = (s) => ({
  ...Object.fromEntries(
    categories.map((key) => [key, s?.preferences?.[key] !== false]),
  ),
  pausedUntil: Number(s?.preferences?.pausedUntil) || 0,
});

// Only the browsers' own push services: a phone can't make this computer
// send requests anywhere else.
export function pushServiceAllowed(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname;
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.port === "" || url.port === "443") &&
    (host === "web.push.apple.com" ||
      host.endsWith(".push.apple.com") ||
      host === "fcm.googleapis.com" ||
      host.endsWith(".push.services.mozilla.com") ||
      host.endsWith(".notify.windows.com"))
  );
}

// RFC 8291 (aes128gcm): one record, the 0x02 delimiter, no padding.
// `salt` and `local` (the server's one-time key pair) are for tests.
export function encryptPush(plaintext, { p256dh, auth }, { salt, local } = {}) {
  const uaPublic = unb64(p256dh),
    authSecret = unb64(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16)
    throw fail(400, "Invalid push subscription keys.");
  const ecdh = crypto.createECDH("prime256v1");
  if (local) ecdh.setPrivateKey(unb64(local));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ecdhSecret,
      authSecret,
      Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
      32,
    ),
  );
  const saltBytes = salt ? unb64(salt) : crypto.randomBytes(16);
  const cek = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ikm,
      saltBytes,
      Buffer.from("Content-Encoding: aes128gcm\0"),
      16,
    ),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ikm,
      saltBytes,
      Buffer.from("Content-Encoding: nonce\0"),
      12,
    ),
  );
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (data.length + 16 > RECORD_SIZE) throw Error("Push message too long.");
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  saltBytes.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

// This computer's VAPID key pair, made once and kept private.
export function vapidKeys(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const privateKey = crypto.createPrivateKey({
      key: saved.jwk,
      format: "jwk",
    });
    return { privateKey, publicKey: saved.publicKey };
  } catch {}
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = b64(
    Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)]),
  );
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ jwk, publicKey }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { privateKey, publicKey };
}

// The signed token a push service checks (ES256, raw r||s signature).
export function vapidJwt({ audience, subject, privateKey, now = Date.now() }) {
  const header = b64(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: subject,
    }),
  );
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${b64(signature)}`;
}

// The reason a push service gave for refusing, from its JSON body.
async function whyRefused(response) {
  try {
    const text = String(await response.text()).slice(0, 300);
    try {
      return String(JSON.parse(text).reason || text).slice(0, 80);
    } catch {
      return text.slice(0, 80);
    }
  } catch {
    return "";
  }
}

export function createPush({
  dataDir,
  // Who sends: this computer's https address (never anyone's email).
  subject,
  post = (url, init) =>
    fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    }),
  now = Date.now,
  log = (message) => console.log(`Reach: ${message}`),
}) {
  const file = path.join(dataDir, "push.json");
  // A phone whose push service keeps refusing (HTTP 400): paused a while after
  // a few in a row, its reason logged once, instead of a refusal (and a log
  // line) on every event. endpoint -> { count, until, reason }
  const refused = new Map();
  let keys;
  const vapid = () =>
    (keys ??= vapidKeys(path.join(dataDir, "push-vapid.json")));
  let subscriptions = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved.subscriptions)) subscriptions = saved.subscriptions;
  } catch {}
  const save = (strict = false) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ subscriptions }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
      if (strict)
        throw fail(503, "Could not save notification preferences. Try again.");
    }
  };
  return {
    key: () => vapid().publicKey,
    subscribe(clientId, subscription) {
      const endpoint = subscription?.endpoint;
      const { p256dh, auth } = subscription?.keys || {};
      if (
        typeof endpoint !== "string" ||
        endpoint.length > 2048 ||
        !pushServiceAllowed(endpoint)
      )
        throw fail(
          400,
          "This browser's notification service isn't one Reach knows.",
        );
      if (
        typeof p256dh !== "string" ||
        typeof auth !== "string" ||
        unb64(p256dh).length !== 65 ||
        unb64(auth).length !== 16
      )
        throw fail(400, "Invalid push subscription keys.");
      const previous = subscriptions.find(
        (s) => s.clientId === clientId && s.endpoint === endpoint,
      );
      // One browser's endpoint belongs to whoever subscribed it last.
      subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
      const mine = subscriptions.filter((s) => s.clientId === clientId);
      if (mine.length >= MAX_PER_CLIENT)
        subscriptions = subscriptions.filter((s) => s !== mine[0]);
      subscriptions.push({
        clientId,
        endpoint,
        keys: { p256dh, auth },
        createdAt: new Date(now()).toISOString(),
        preferences: preferences(previous),
      });
      save();
      return { subscribed: true };
    },
    preferences(clientId, endpoint) {
      const s = subscriptions.find(
        (s) => s.clientId === clientId && s.endpoint === endpoint,
      );
      return s ? preferences(s) : null;
    },
    updatePreferences(clientId, endpoint, patch, pauseMinutes) {
      const s = subscriptions.find(
        (s) => s.clientId === clientId && s.endpoint === endpoint,
      );
      if (!s) throw fail(409, "Enable notifications on this device first.");
      if (
        !patch ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        Object.entries(patch).some(
          ([key, value]) =>
            !categories.includes(key) || typeof value !== "boolean",
        ) ||
        (pauseMinutes !== undefined && ![0, 60, 480].includes(pauseMinutes))
      )
        throw fail(400, "Invalid notification preferences.");
      const old = s.preferences;
      s.preferences = {
        ...preferences(s),
        ...patch,
        ...(pauseMinutes !== undefined && {
          pausedUntil: pauseMinutes ? now() + pauseMinutes * 60000 : 0,
        }),
      };
      try {
        save(true);
      } catch (error) {
        s.preferences = old;
        throw error;
      }
      return preferences(s);
    },
    unsubscribe(clientId, endpoint) {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter(
        (s) => !(s.clientId === clientId && s.endpoint === endpoint),
      );
      if (subscriptions.length !== before) save();
      return { subscribed: false };
    },
    subscribed: (clientId, endpoint) =>
      subscriptions.some(
        (s) =>
          s.clientId === clientId && (!endpoint || s.endpoint === endpoint),
      ),
    // A revoked device gets nothing more.
    forgetClient(clientId) {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter((s) => s.clientId !== clientId);
      if (subscriptions.length !== before) save();
    },
    // `message`: { title, tag?, url? }. Sent to these clients' browsers.
    async notify(clientIds, message, { endpoint, test = false } = {}) {
      const wanted = new Set(clientIds);
      const candidates = subscriptions.filter(
        (s) => wanted.has(s.clientId) && (!endpoint || s.endpoint === endpoint),
      );
      const targets = candidates.filter((s) => {
        const prefs = preferences(s);
        return (
          test ||
          (prefs.pausedUntil <= now() &&
            prefs[message.category || "chat"] !== false)
        );
      });
      // Suppressed events are consumed, not queued for a burst after unmuting.
      if (candidates.length && !targets.length)
        return { sent: 0, suppressed: candidates.length };
      if (!targets.length) return { sent: 0 };
      const { privateKey, publicKey } = vapid();
      const payload = JSON.stringify({
        title: String(message.title || "New activity").slice(0, 120),
        ...(message.tag && { tag: String(message.tag).slice(0, 64) }),
        ...(message.url && { url: String(message.url).length <= 2000 ? String(message.url) : "/" }),
        ...(message.body && { body: String(message.body).slice(0, 240) }),
        ...(["codex", "claude", "gemini", "openclaw", "agent", "mac"].includes(message.icon) && { icon: message.icon }),
        ...(Array.isArray(message.actions) && { actions: message.actions.filter((item) => ["open", "deny"].includes(item?.action) && typeof item.title === "string").slice(0, 2).map((item) => ({ action: item.action, title: item.title.slice(0, 40) })) }),
        ...(typeof message.notification?.id === "string" && message.notification.id.length <= 1500 && /^[a-f0-9]{64}$/.test(message.notification.revision) && { notification: { id: message.notification.id, revision: message.notification.revision } }),
      });
      let sent = 0;
      await Promise.all(
        targets.map(async (s) => {
          const pause = refused.get(s.endpoint);
          if (pause && pause.until > now()) return;
          try {
            const audience = new URL(s.endpoint).origin;
            const send = (topic) =>
              post(s.endpoint, {
                method: "POST",
                headers: {
                  Authorization: `vapid t=${vapidJwt({ audience, subject: subject(), privateKey, now: now() })}, k=${publicKey}`,
                  "Content-Encoding": "aes128gcm",
                  "Content-Type": "application/octet-stream",
                  TTL: "3600",
                  Urgency: "high",
                  ...(topic && { Topic: topic }),
                },
                body: encryptPush(payload, s.keys),
              });
            const topic = message.tag
              ? String(message.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)
              : "";
            let response = await send(topic);
            // Apple says why in the body ({"reason":"BadWebPushTopic"}).
            let reason = response.ok ? "" : await whyRefused(response);
            // A topic the service won't take: once more without one.
            if (response.status === 400 && topic && /topic/i.test(reason)) {
              response = await send("");
              reason = response.ok ? "" : await whyRefused(response);
            }
            // Gone (the phone turned notifications off or reinstalled).
            if (response.status === 404 || response.status === 410) {
              subscriptions = subscriptions.filter((x) => x !== s);
              refused.delete(s.endpoint);
              save();
            } else if (response.ok) {
              sent++;
              refused.delete(s.endpoint);
            } else {
              const last = refused.get(s.endpoint);
              const count = (last?.count || 0) + 1;
              const why = `HTTP ${response.status}${reason ? `: ${reason}` : ""}`;
              if (last?.why !== why) log(`a notification was refused (${why}).`);
              refused.set(s.endpoint, {
                count,
                why,
                until: count >= 3 ? now() + 15 * 60 * 1000 : 0,
              });
              if (count === 3) log(`notifications to one phone are paused for 15 minutes after ${count} refusals (${why}).`);
            }
          } catch (e) {
            log(`a notification could not be sent: ${e.message}`);
          }
        }),
      );
      return { sent };
    },
  };
}
