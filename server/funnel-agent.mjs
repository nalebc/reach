import crypto from "node:crypto";
import { browserRouteAllowed } from "./browser-access.mjs";

const BODY_LIMIT = 32 * 1024;
const CLOCK_WINDOW = 60_000;
const REPLAY_LIMIT = 4096;
const RATE_BUCKET_LIMIT = 1024;
const BASE = ["v", "audience", "issuedAt", "nonce", "operation"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  plain(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const failure = (status) =>
  Object.assign(new Error("Agent gateway request rejected."), { status });
const encoded = (value, bytes) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]+$/.test(value) &&
  Buffer.from(value, "base64url").length === bytes &&
  Buffer.from(value, "base64url").toString("base64url") === value;

function publicKey(jwk) {
  if (
    !plain(jwk) ||
    Object.keys(jwk).some(
      (key) => !["kty", "crv", "x", "y", "ext", "key_ops"].includes(key),
    ) ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    !encoded(jwk.x, 32) ||
    !encoded(jwk.y, 32) ||
    (Object.hasOwn(jwk, "ext") && jwk.ext !== true) ||
    (Object.hasOwn(jwk, "key_ops") &&
      (!Array.isArray(jwk.key_ops) ||
        jwk.key_ops.length !== 1 ||
        jwk.key_ops[0] !== "verify"))
  )
    throw failure(400);
  const canonical = { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y };
  let key;
  try {
    key = crypto.createPublicKey({ key: canonical, format: "jwk" });
  } catch {
    throw failure(400);
  }
  return {
    key,
    thumbprint: crypto
      .createHash("sha256")
      .update(JSON.stringify(canonical))
      .digest("base64url"),
  };
}

// This is deliberately independent of the main application's route table.
// Adding an owner API (or broadening browserRouteAllowed) cannot publish it.
function permittedPath(method, value) {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    !value.startsWith("/api/") ||
    /[\s\\#\u0000-\u001f\u007f]/.test(value)
  )
    throw failure(400);
  let url, route;
  try {
    url = new URL(value, "https://gateway.invalid");
    const rawPath = value.split("?")[0];
    // No URL normalization, encoded separators, double encoding or dot paths.
    if (url.pathname !== rawPath || /%(?:2f|5c|25|00)/i.test(rawPath))
      throw failure(400);
    route = decodeURIComponent(rawPath);
    if (
      route
        .slice(1)
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw failure(400);
    if (!/^[A-Za-z0-9_/:.-]+$/.test(route)) throw failure(400);
    const names = new Set();
    for (const [name] of url.searchParams) {
      if (names.has(name)) throw failure(400);
      names.add(name);
    }
  } catch {
    throw failure(400);
  }
  const read = ["GET", "HEAD"].includes(method);
  const allowed =
    (read &&
      [
        "/api/device",
        "/api/browser",
        "/api/browser/screen",
        "/api/browser/requests",
        "/api/browser/files/search",
        "/api/files",
        "/api/files/text",
        "/api/files/content",
        "/api/files/document-text",
        "/api/files/icons",
      ].includes(route)) ||
    (read && /^\/api\/browser\/terminals\/[A-Za-z0-9_:.-]+$/.test(route)) ||
    (method === "POST" &&
      ["/api/browser/requests", "/api/browser/scroll"].includes(route)) ||
    (method === "DELETE" &&
      (route === "/api/device/access" ||
        /^\/api\/browser\/requests\/[a-f0-9-]{36}$/.test(route)));
  if (!allowed) throw failure(403);
  return route.slice(4);
}

function immutable(value, depth = 0) {
  if (depth > 24) throw failure(400);
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0,
      chunks = [],
      finished = false;
    const complete = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("aborted", aborted);
      req.removeListener("error", aborted);
      if (error) {
        req.resume();
        reject(error);
      } else resolve(value);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) return complete(failure(413));
      chunks.push(chunk);
    };
    const end = () => {
      try {
        // Invalid UTF-8 must not gain a different signed interpretation.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
        complete(null, JSON.parse(text));
      } catch {
        complete(failure(400));
      }
      chunks = [];
    };
    const aborted = () => complete(failure(400));
    const timer = setTimeout(() => complete(failure(408)), 8000);
    timer.unref?.();
    req.on("data", data);
    req.once("end", end);
    req.once("aborted", aborted);
    req.once("error", aborted);
  });
}

/** A single signed HTTP endpoint. No owner APIs, sockets or generic proxy. */
export function createFunnelAgentGateway({
  auth,
  origin,
  available = () => true,
  device = () => ({}),
  claimed = () => {},
  dispatch,
  requestHost = (req) => req.headers.host,
  now = Date.now,
}) {
  const publicOrigin = new URL(origin);
  if (publicOrigin.origin !== origin || publicOrigin.protocol !== "https:")
    throw new Error("The agent gateway requires an exact HTTPS origin.");
  const replay = new Map(),
    ips = new Map(),
    keys = new Map();
  let active = 0;
  const bucket = (map, id, maximum, current) => {
    for (const [key, value] of map)
      if (value.until <= current && value.active === 0) map.delete(key);
    let value = map.get(id);
    if (!value) {
      if (map.size >= RATE_BUCKET_LIMIT) throw failure(429);
      value = { until: current + 60_000, count: 0, active: 0 };
      map.set(id, value);
    }
    if (value.until <= current) {
      value.until = current + 60_000;
      value.count = 0;
    }
    if (++value.count > maximum) throw failure(429);
    return value;
  };
  const json = (res, status, body) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(body));
  };
  const rejection = (req, res, error) => {
    // An early header rejection may happen before readBody attached listeners.
    // Drain remaining bytes so the HTTP connection can finish cleanly.
    req.resume();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = [
      400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 421, 429, 503,
    ].includes(error?.status)
      ? error.status
      : 500;
    const messages = {
      400: "The agent request is invalid.",
      401: "This invitation or session is invalid, expired, or belongs to another browser.",
      403: "This agent request is not allowed.",
      404: "This agent connection was not found.",
      405: "Use a signed POST request.",
      408: "The request took too long. Try again.",
      409: "This request was already used. Try a new request.",
      410: "This agent connection has ended.",
      413: "The agent request is too large.",
      415: "Use JSON for the agent request.",
      421: "Unrecognized host.",
      429: "Too many agent requests. Wait briefly and retry.",
      503: "Agent access is closed. Ask the laptop owner for a new invitation.",
      500: "The agent request could not be completed.",
    };
    if (status === 429) res.setHeader("Retry-After", "5");
    json(res, status, { error: messages[status] });
  };
  const run = async (req, res) => {
    if (req.method !== "POST") throw failure(405);
    if (requestHost(req) !== publicOrigin.host) throw failure(421);
    if (
      req.headers.origin !== origin ||
      (req.headers["sec-fetch-site"] !== undefined &&
        req.headers["sec-fetch-site"] !== "same-origin")
    )
      throw failure(403);
    if (!available()) throw failure(503);
    if (
      !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
        req.headers["content-type"] || "",
      ) ||
      req.headers["content-encoding"]
    )
      throw failure(415);
    if (
      req.headers["content-length"] !== undefined &&
      (!/^\d+$/.test(req.headers["content-length"]) ||
        Number(req.headers["content-length"]) > BODY_LIMIT)
    )
      throw failure(413);
    const ip = bucket(ips, req.socket?.remoteAddress || "unknown", 240, now());
    if (active >= 32 || ip.active >= 8) throw failure(429);
    active++;
    ip.active++;
    let keyBucket,
      released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      ip.active--;
      if (keyBucket) keyBucket.active--;
      res.removeListener("finish", release);
      res.removeListener("close", release);
    };
    res.once("finish", release);
    res.once("close", release);
    try {
      const envelope = await readBody(req);
      if (res.destroyed) return;
      if (
        !exact(envelope, ["payload", "publicKey", "signature"]) ||
        typeof envelope.payload !== "string" ||
        !encoded(envelope.signature, 64)
      )
        throw failure(400);
      const identity = publicKey(envelope.publicKey);
      let payload;
      try {
        payload = JSON.parse(envelope.payload);
      } catch {
        throw failure(400);
      }
      const operationKeys = {
        claim: ["invitation"],
        status: ["requestId", "secret"],
        request: ["token", "method", "path", "body"],
      };
      if (
        !plain(payload) ||
        !Object.hasOwn(operationKeys, payload.operation) ||
        !exact(payload, [...BASE, ...operationKeys[payload.operation]]) ||
        payload.v !== 1 ||
        payload.audience !== origin ||
        !Number.isSafeInteger(payload.issuedAt) ||
        Math.abs(now() - payload.issuedAt) > CLOCK_WINDOW ||
        !encoded(payload.nonce, 24)
      )
        throw failure(400);
      if (
        !crypto.verify(
          "sha256",
          Buffer.from(envelope.payload, "utf8"),
          { key: identity.key, dsaEncoding: "ieee-p1363" },
          Buffer.from(envelope.signature, "base64url"),
        )
      )
        throw failure(401);
      const rate = bucket(keys, identity.thumbprint, 180, now());
      if (rate.active >= 4) throw failure(429);
      keyBucket = rate;
      keyBucket.active++;
      // Consume before any asynchronous or state-changing operation; never
      // evict a live nonce to make room for a new one.
      const current = now();
      for (const [key, expiry] of replay)
        if (expiry < current) replay.delete(key);
      const nonce = `${identity.thumbprint}:${payload.nonce}`;
      if (replay.has(nonce)) throw failure(409);
      if (replay.size >= REPLAY_LIMIT) throw failure(429);
      replay.set(nonce, payload.issuedAt + CLOCK_WINDOW);
      if (!available()) throw failure(503);
      if (payload.operation === "claim") {
        if (!encoded(payload.invitation, 32)) throw failure(400);
        const result = await auth.redeemFunnelBrowser(
          payload.invitation,
          identity.thumbprint,
        );
        if (result?.status !== "pending" || result.token !== undefined)
          throw failure(500);
        // Notification delivery must not lose a successfully consumed receipt.
        try {
          await claimed(result);
        } catch {}
        return json(res, 202, { ...result, device: device() });
      }
      if (payload.operation === "status") {
        if (
          typeof payload.requestId !== "string" ||
          !UUID.test(payload.requestId) ||
          !encoded(payload.secret, 32)
        )
          throw failure(400);
        const result = await auth.pollFunnelAdmission(
          payload.requestId,
          payload.secret,
          identity.thumbprint,
        );
        return json(res, 200, { ...result, device: device() });
      }
      if (
        !encoded(payload.token, 32) ||
        !["GET", "HEAD", "POST", "DELETE"].includes(payload.method) ||
        (payload.body !== null && !plain(payload.body)) ||
        (payload.method !== "POST" && payload.body !== null)
      )
        throw failure(400);
      const route = permittedPath(payload.method, payload.path);
      const client = await auth.verifyFunnel(
        payload.token,
        identity.thumbprint,
      );
      if (
        !client ||
        client.kind !== "agent" ||
        client.policy?.browser !== true ||
        client.browserTransport !== "funnel" ||
        client.browserBinding !== identity.thumbprint
      )
        throw failure(401);
      if (!browserRouteAllowed(client, payload.method, route))
        throw failure(403);
      if (!available()) throw failure(503);
      await auth.touchFunnel?.(payload.token, identity.thumbprint);
      const context = immutable({
        keyThumbprint: identity.thumbprint,
        token: payload.token,
        method: payload.method,
        path: payload.path,
        body: payload.body,
      });
      await dispatch(req, res, context);
    } catch (error) {
      rejection(req, res, error);
    }
  };
  return (req, res) => {
    if (req.url !== "/agent-gateway") return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    void run(req, res).catch((error) => rejection(req, res, error));
    return true;
  };
}
