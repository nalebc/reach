import crypto from "node:crypto";
import { sourceKey } from "./funnel-agent.mjs";

const BODY_LIMIT = 256 * 1024;
const CLOCK_WINDOW = 60_000;
const REPLAY_TTL = 120_000;
const STRANGER_REPLAY_LIMIT = 4096;
const KNOWN_REPLAY_LIMIT = 16384;
const RATE_BUCKET_LIMIT = 1024;
const TICKET_LIMIT = 256;
const WS_TICKET_TTL = 15_000;
const STREAM_TICKET_TTL = 60_000;
const PRIVATE_EXPOSED_HEADERS =
  "Reach-Not-Run, Reach-Retry, Retry-After, ETag, X-Reach-Screen, Content-Disposition, Content-Length, Content-Range, Accept-Ranges";

export const WS_DEVICE_ROUTES = new Set([
  "/ws/terminal",
  "/ws/screen",
  "/ws/screen-input",
  "/ws/screen-sound",
  "/ws/presence",
]);

const PAYLOAD_KEYS = [
  "v",
  "audience",
  "method",
  "path",
  "issuedAt",
  "nonce",
  "bodySha256",
];

const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, keys) =>
  plain(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const encodedBytes = (value, bytes) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]+$/.test(value) &&
  Buffer.from(value, "base64url").length === bytes &&
  Buffer.from(value, "base64url").toString("base64url") === value;

const failure = (status, message, extra = {}) =>
  Object.assign(new Error(message || "Device gateway request rejected."), {
    status,
    ...extra,
  });

export function normalizeDeviceKey(jwk) {
  if (
    !plain(jwk) ||
    Object.keys(jwk).some(
      (key) => !["kty", "crv", "x", "y", "ext", "key_ops"].includes(key),
    ) ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    !encodedBytes(jwk.x, 32) ||
    !encodedBytes(jwk.y, 32) ||
    (Object.hasOwn(jwk, "ext") && typeof jwk.ext !== "boolean") ||
    (Object.hasOwn(jwk, "key_ops") &&
      (!Array.isArray(jwk.key_ops) ||
        jwk.key_ops.some((op) => !["sign", "verify"].includes(op))))
  )
    throw failure(400, "A valid P-256 device public key is required.");
  const canonical = { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y };
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: canonical, format: "jwk" });
  } catch {
    throw failure(400, "A valid P-256 device public key is required.");
  }
  const thumbprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("base64url");
  return { jwk: canonical, thumbprint, publicKey };
}

export function verifyDeviceSignature(jwkOrKey, text, signature) {
  if (!encodedBytes(signature, 64) || typeof text !== "string") return false;
  try {
    const key =
      jwkOrKey instanceof crypto.KeyObject
        ? jwkOrKey
        : normalizeDeviceKey(jwkOrKey).publicKey;
    return crypto.verify(
      "sha256",
      Buffer.from(text, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function unauthenticatedRouteAllowed(method, rawUrl, { pairingOpen, passkeys }) {
  const path = String(rawUrl || "").split("?", 1)[0];
  if (method === "GET" && (path === "/api/health" || path === "/api/auth/method"))
    return true;
  if (method !== "POST") return false;
  if (path === "/api/auth/requests" || path === "/api/pair") return pairingOpen;
  if (/^\/api\/auth\/requests\/[a-f0-9-]{36}$/.test(path)) return true;
  if (
    /^\/api\/auth\/requests\/[a-f0-9-]{36}\/passkey(?:\/options)?$/.test(path)
  )
    return passkeys;
  if (
    path === "/api/auth/face-passkey/options" ||
    path === "/api/auth/face-passkey/join"
  )
    return passkeys;
  if (path === "/api/guest/redeem" || path === "/api/invitations/redeem")
    return true;
  return false;
}

function readRawBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let finished = false;
    const done = (err, buf) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAbort);
      req.removeListener("error", onAbort);
      if (err) {
        req.resume();
        reject(err);
      } else resolve(buf);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) return done(failure(413, "Request body is too large."));
      chunks.push(chunk);
    };
    const onEnd = () => done(null, Buffer.concat(chunks));
    const onAbort = () => done(failure(400, "Request body was interrupted."));
    const timer = setTimeout(
      () => done(failure(408, "Request timed out.")),
      10_000,
    );
    timer.unref?.();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAbort);
    req.once("error", onAbort);
  });
}

export function createFunnelDeviceGateway({
  auth,
  origin,
  privateHost = null,
  requestHost = (req) => req.headers.host,
  available = () => true,
  passkeysAvailable = () => false,
  onFlood = () => {},
  dispatch,
  now = Date.now,
}) {
  const publicOrigin = new URL(origin);
  if (publicOrigin.origin !== origin || publicOrigin.protocol !== "https:")
    throw new Error("The Funnel device gateway requires an exact HTTPS origin.");
  const hosts = new Set([
    publicOrigin.host,
    ...(typeof privateHost === "string" && privateHost ? [privateHost] : []),
  ]);

  const startedAt = now();
  const knownReplay = new Map();
  const strangerReplay = new Map();
  const knownRates = new Map();
  const strangerIpRates = new Map();
  const strangerKeyRates = new Map();
  const tickets = new Map();

  const FLOOD_PER_MINUTE = 300;
  const FLOOD_PAUSE_MS = 5 * 60_000;
  const strangers = { minute: 0, count: 0 };
  let floodUntil = 0;

  const knownKeys = () => {
    try {
      return auth.deviceFunnelKeys?.() || new Set();
    } catch {
      return new Set();
    }
  };

  const rateBucket = (map, id, maximum, current) => {
    for (const [key, value] of map)
      if (value.until <= current) map.delete(key);
    let value = map.get(id);
    if (value) {
      map.delete(id);
      map.set(id, value);
    } else {
      if (map.size >= RATE_BUCKET_LIMIT) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      value = { until: current + 60_000, count: 0 };
      map.set(id, value);
    }
    if (value.until <= current) {
      value.until = current + 60_000;
      value.count = 0;
    }
    if (++value.count > maximum)
      throw failure(429, "Too many requests. Wait briefly and try again.");
  };

  const rememberNonce = (map, limit, key, current) => {
    for (const [entry, until] of map)
      if (until <= current) map.delete(entry);
    if (map.has(key))
      throw failure(409, "This signed request was already used.");
    if (map.size >= limit) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, current + REPLAY_TTL);
  };

  const pruneTickets = (current) => {
    for (const [id, entry] of tickets)
      if (entry.expiresAt <= current) tickets.delete(id);
  };

  const issueTicket = (entry, current) => {
    pruneTickets(current);
    while (tickets.size >= TICKET_LIMIT) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      tickets.delete(oldest);
    }
    const ticket = crypto.randomBytes(32).toString("base64url");
    tickets.set(ticket, entry);
    return ticket;
  };

  const sendJson = (res, status, body, headers = {}) => {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  };

  const reject = (req, res, error, notRun = true) => {
    req.resume();
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    const status = [
      400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 421, 429, 503,
    ].includes(error?.status)
      ? error.status
      : 500;
    const headers = {};
    if (status === 429 || status === 503) headers["Retry-After"] = "5";
    if (notRun) headers["Reach-Not-Run"] = "1";
    if (notRun && error?.retry === "fresh-signature")
      headers["Reach-Retry"] = "fresh-signature";
    sendJson(
      res,
      status,
      {
        error:
          error?.status && error.message
            ? error.message
            : "The request could not be completed.",
      },
      headers,
    );
  };

  const ALLOWED_HEADERS =
    "Authorization, Content-Type, Reach-Device-Key, Reach-Device-Payload, Reach-Device-Signature, Reach-Device-Jwk, Reach-Pairing-Token, Reach-Stream-Ticket, Range, If-Range";

  const handle = (req, res) => {
    const streamTicket = req.headers["reach-stream-ticket"];
    const deviceKeyHeader = req.headers["reach-device-key"];
    const corsPreflight =
      req.method === "OPTIONS" &&
      typeof req.headers["access-control-request-headers"] === "string" &&
      req.headers["access-control-request-headers"]
        .toLowerCase()
        .includes("reach-device-key");
    if (
      deviceKeyHeader === undefined &&
      streamTicket === undefined &&
      !corsPreflight
    )
      return false;

    void (async () => {
      const host = requestHost(req);
      if (!hosts.has(host)) throw failure(421, "Unrecognized host.");
      const privately = host === privateHost && host !== publicOrigin.host;
      if (
        req.headers.origin !== undefined &&
        req.headers.origin !== origin
      )
        throw failure(403, "Origin is not permitted.");
      if (
        req.headers["sec-fetch-site"] !== undefined &&
        !["same-origin", "none"].includes(req.headers["sec-fetch-site"]) &&
        !(privately && req.headers["sec-fetch-site"] === "same-site")
      )
        throw failure(403, "Cross-site requests are not permitted.");

      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, HEAD, POST, PUT, PATCH, DELETE",
        );
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        req.resume();
        res.writeHead(204);
        res.end();
        return;
      }

      if (privately) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Expose-Headers",
          PRIVATE_EXPOSED_HEADERS,
        );
      }

      if (!available())
        throw failure(
          503,
          "Reach is paused or reconnecting. Try again in a moment.",
        );

      const current = now();

      // Path 1: Single-use pre-authorized streaming ticket (multipart/chunked uploads & range downloads).
      if (typeof streamTicket === "string") {
        pruneTickets(current);
        if (!encodedBytes(streamTicket, 32))
          throw failure(401, "Invalid stream ticket.");
        const entry = tickets.get(streamTicket);
        tickets.delete(streamTicket);
        if (
          !entry ||
          entry.kind !== "stream" ||
          entry.expiresAt <= current ||
          entry.method !== req.method ||
          entry.path !== req.url
        )
          throw failure(401, "This transfer ticket expired. Retry the transfer.");
        const client = auth.verifyDeviceFunnel?.(
          entry.token,
          entry.keyThumbprint,
        );
        if (!client || client.id !== entry.clientId)
          throw failure(401, "Device access expired or was revoked.");
        req.headers.authorization = `Bearer ${entry.token}`;
        dispatch(req, res, {
          deviceFunnel: true,
          streamed: true,
          clientId: client.id,
          keyThumbprint: entry.keyThumbprint,
          token: entry.token,
        });
        return;
      }

      // Path 2: Signed ECDSA P-256 device request.
      if (!encodedBytes(deviceKeyHeader, 32))
        throw failure(400, "Invalid device key header.");
      const thumbprint = deviceKeyHeader;
      const payloadHeader = req.headers["reach-device-payload"];
      const signatureHeader = req.headers["reach-device-signature"];
      if (
        typeof payloadHeader !== "string" ||
        payloadHeader.length > 8192 ||
        !/^[A-Za-z0-9_-]+$/.test(payloadHeader) ||
        !encodedBytes(signatureHeader, 64)
      )
        throw failure(400, "Signed device headers are incomplete.");

      const bearer = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : "";
      const known = knownKeys().has(thumbprint);
      const pairingHeader = req.headers["reach-pairing-token"];
      const pairingToken =
        typeof pairingHeader === "string" && encodedBytes(pairingHeader, 32)
          ? pairingHeader
          : "";

      if (known) {
        rateBucket(knownRates, thumbprint, 600, current);
      } else {
        if (current < floodUntil)
          throw failure(
            429,
            "Sign-in is temporarily rate limited. Wait a few minutes or connect with Tailscale.",
          );
        const minute = Math.floor(current / 60_000);
        if (strangers.minute !== minute) {
          strangers.minute = minute;
          strangers.count = 0;
        }
        if (++strangers.count > FLOOD_PER_MINUTE) {
          floodUntil = current + FLOOD_PAUSE_MS;
          onFlood(strangers.count);
          throw failure(
            429,
            "Sign-in is temporarily rate limited. Wait a few minutes or connect with Tailscale.",
          );
        }
        const ip = sourceKey(req.headers["x-forwarded-for"] || "");
        rateBucket(strangerIpRates, ip, 40, current);
        rateBucket(strangerKeyRates, thumbprint, 30, current);
        const pairingOpen = !!auth.pairingAdmission?.(pairingToken);
        if (
          !unauthenticatedRouteAllowed(req.method, req.url, {
            pairingOpen,
            passkeys: !!passkeysAvailable(),
          })
        ) {
          throw failure(
            pairingOpen ? 401 : 403,
            pairingOpen
              ? "Pair this device first."
              : "Pairing is closed on this link. Run reach pair on your computer, or turn on Tailscale.",
          );
        }
      }

      let payloadText;
      let payload;
      try {
        payloadText = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(payloadHeader, "base64url"),
        );
        payload = JSON.parse(payloadText);
      } catch {
        throw failure(400, "Signed device payload is unreadable.");
      }

      if (
        !exactKeys(payload, PAYLOAD_KEYS) ||
        payload.v !== 1 ||
        payload.audience !== origin ||
        payload.method !== req.method ||
        payload.path !== req.url ||
        !Number.isSafeInteger(payload.issuedAt) ||
        typeof payload.nonce !== "string" ||
        payload.nonce.length < 16 ||
        payload.nonce.length > 64 ||
        !/^[A-Za-z0-9_-]+$/.test(payload.nonce) ||
        !encodedBytes(payload.bodySha256, 32)
      )
        throw failure(400, "Signed device payload does not match request.");

      if (Math.abs(current - payload.issuedAt) > CLOCK_WINDOW)
        throw failure(
          400,
          "Check that this device's clock is set automatically, then try again.",
        );
      if (payload.issuedAt < startedAt)
        throw failure(400, "Reach restarted. Retrying request…", {
          retry: "fresh-signature",
        });

      let deviceKey = auth.devicePublicKey?.(thumbprint) || null;
      if (!deviceKey) {
        const jwkHeader = req.headers["reach-device-jwk"];
        if (
          typeof jwkHeader !== "string" ||
          jwkHeader.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(jwkHeader)
        )
          throw failure(401, "Device key is not registered on this computer.");
        let parsedJwk;
        try {
          parsedJwk = JSON.parse(
            Buffer.from(jwkHeader, "base64url").toString("utf8"),
          );
        } catch {
          throw failure(400, "Device public key header is unreadable.");
        }
        const normalized = normalizeDeviceKey(parsedJwk);
        if (normalized.thumbprint !== thumbprint)
          throw failure(400, "Device key thumbprint does not match public key.");
        deviceKey = normalized;
      } else if (!deviceKey.publicKey) {
        deviceKey = normalizeDeviceKey(deviceKey.jwk || deviceKey);
      }

      if (!verifyDeviceSignature(deviceKey.publicKey, payloadText, signatureHeader))
        throw failure(401, "Invalid device signature.");

      rememberNonce(
        known ? knownReplay : strangerReplay,
        known ? KNOWN_REPLAY_LIMIT : STRANGER_REPLAY_LIMIT,
        `${thumbprint}:${payload.nonce}`,
        current,
      );

      const rawBody = ["GET", "HEAD"].includes(req.method)
        ? Buffer.alloc(0)
        : await readRawBody(req, BODY_LIMIT);
      const actualSha256 = crypto
        .createHash("sha256")
        .update(rawBody)
        .digest("base64url");
      if (actualSha256 !== payload.bodySha256)
        throw failure(400, "Request body did not match signed digest.");

      let parsedBody = {};
      if (rawBody.length > 0) {
        if (
          !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
            req.headers["content-type"] || "",
          )
        )
          throw failure(415, "Use JSON or a stream ticket for request bodies.");
        try {
          parsedBody = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
          );
        } catch {
          throw failure(400, "Request JSON is invalid.");
        }
      }

      const routePath = String(req.url || "").split("?", 1)[0];

      // Ticket minting endpoints for authenticated Funnel devices.
      if (
        req.method === "POST" &&
        (routePath === "/api/device/ws-ticket" ||
          routePath === "/api/device/stream-ticket")
      ) {
        const client = auth.verifyDeviceFunnel?.(bearer, thumbprint);
        if (!client)
          throw failure(401, "Pair this device again. Access expired or was revoked.");
        if (routePath === "/api/device/ws-ticket") {
          const wsPath = parsedBody?.path;
          if (typeof wsPath !== "string" || !WS_DEVICE_ROUTES.has(wsPath))
            throw failure(400, "Unsupported live connection channel.");
          const expiresAt = current + WS_TICKET_TTL;
          const ticket = issueTicket(
            {
              kind: "ws",
              clientId: client.id,
              token: bearer,
              keyThumbprint: thumbprint,
              path: wsPath,
              expiresAt,
            },
            current,
          );
          sendJson(res, 200, { ticket, expiresAt });
          return;
        }
        const streamMethod = parsedBody?.method;
        const streamPath = parsedBody?.path;
        if (
          !["GET", "POST", "PUT"].includes(streamMethod) ||
          typeof streamPath !== "string" ||
          streamPath.length > 4096 ||
          !streamPath.startsWith("/api/")
        )
          throw failure(400, "Invalid transfer ticket target.");
        const expiresAt = current + STREAM_TICKET_TTL;
        const ticket = issueTicket(
          {
            kind: "stream",
            clientId: client.id,
            token: bearer,
            keyThumbprint: thumbprint,
            method: streamMethod,
            path: streamPath,
            expiresAt,
          },
          current,
        );
        sendJson(res, 200, { ticket, expiresAt });
        return;
      }

      // If known key cache admitted a recently-revoked device, ensure non-admission routes still require valid bearer.
      if (known && !bearer) {
        const pairingOpen = !!auth.pairingAdmission?.(pairingToken);
        if (
          !unauthenticatedRouteAllowed(req.method, req.url, {
            pairingOpen,
            passkeys: !!passkeysAvailable(),
          })
        )
          throw failure(401, "Sign in to access this computer.");
      }

      dispatch(req, res, {
        deviceFunnel: true,
        keyThumbprint: thumbprint,
        deviceKey: { jwk: deviceKey.jwk, thumbprint },
        token: bearer,
        pairingToken,
        pairingOpen: !!auth.pairingAdmission?.(pairingToken),
        body: parsedBody,
      });
    })().catch((err) => reject(req, res, err, true));

    return true;
  };

  const upgrade = (req) => {
    if (!available()) return null;
    const host = requestHost(req);
    if (!hosts.has(host)) return null;
    if (req.headers.origin !== undefined && req.headers.origin !== origin)
      return null;
    let parsed;
    try {
      parsed = new URL(req.url || "", origin);
    } catch {
      return null;
    }
    if (!WS_DEVICE_ROUTES.has(parsed.pathname)) return null;
    const ticket = parsed.searchParams.get("ticket");
    if (!encodedBytes(ticket, 32)) return null;
    const current = now();
    pruneTickets(current);
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (
      !entry ||
      entry.kind !== "ws" ||
      entry.expiresAt <= current ||
      entry.path !== parsed.pathname
    )
      return null;
    const client = auth.verifyDeviceFunnel?.(entry.token, entry.keyThumbprint);
    if (!client || client.id !== entry.clientId) return null;
    req.url = parsed.pathname;
    return {
      deviceFunnel: true,
      clientId: client.id,
      keyThumbprint: entry.keyThumbprint,
      token: entry.token,
    };
  };

  return { handle, upgrade };
}
