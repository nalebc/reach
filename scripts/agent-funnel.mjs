// Reach's tools over the computer's public link (Tailscale Funnel), for an
// agent outside the owner's Tailscale network when invite links aren't set
// up: nothing to install on the owner's side, no Tailscale key. The agent
// signs every request with its own P-256 key, kept owner-only in its folder,
// through the gateway Reach's agent page uses (server/funnel-agent.mjs): open
// only while the agent has access, every request checked against its
// preset's routes, replays refused. Its approved key reconnects at once;
// another computer needs the owner's code (core.mjs relink).
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { agentRequestError, agentRequestTimeout, agentJsonResponseLimit, validateAgentJsonResponse } from "../server/agent-transport.mjs";
import { isScreenImageRoute } from "./agent-client.mjs";

const RESPONSE_LIMIT = 8 * 1024 * 1024;

// The agent's signing key: made once, owner-only, never sent anywhere.
export function agentKey(conn) {
  const file = path.join(conn, "key.pem");
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
  } catch {
    ({ privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }));
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  const { kty, crv, x, y } = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  const jwk = { kty, crv, x, y };
  // As the computer computes it (server/funnel-agent.mjs).
  const thumbprint = crypto.createHash("sha256")
    .update(JSON.stringify({ crv: "P-256", kty: "EC", x, y })).digest("base64url");
  return { privateKey, jwk, thumbprint };
}

// Tailscale's own addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
export function tailnetAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return net.isIPv6(address) && /^fd7a:115c:a1e0:/i.test(address);
}
// The private address is used only when its name resolves into the tailnet
// (off the tailnet, it resolves to the public link's relay), and is given up
// on when no connection is made within a few seconds (connections audit,
// Oct 10).
export function tailnetLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: false }, (error, address, family) => {
    if (error) return callback(error);
    if (!tailnetAddress(address))
      return callback(Object.assign(Error(`${hostname} isn't on your tailnet from here.`), { code: "ENOTTAILNET" }));
    // Node's connect asks for every address (all: true) and refuses a single one.
    if (options?.all) return callback(null, [{ address, family }]);
    callback(null, address, family);
  });
}

// One signed request to the gateway, over HTTPS to one of the computer's
// addresses. A failure before the connection is made (no route, refused,
// a name that doesn't resolve, or not into the tailnet) is marked
// unreachable: the next address is tried. Anything later isn't, so an action
// never runs twice. A fresh connection each time, so "connected" is known.
export function httpsSend(endpoint, body, headers, timeoutMs, { tailnetOnly = false, connectMs = 5000, responseLimit = RESPONSE_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const unreachable = (error) => Object.assign(error, { unreachable: !connected });
    const req = https.request(`${endpoint}/agent-gateway`, {
      // No forced rejectUnauthorized: an agent behind a TLS-intercepting egress
      // proxy (Muse's sandbox) joins with its environment's TLS settings, as
      // the committed runtime always has; forcing it failed every join there
      // before a request left (Oct 10, reproduced).
      method: "POST", headers, timeout: timeoutMs,
      // A fresh connection only for the private address (so "connected" is
      // known there). The public link goes through Node's shared agent, which
      // is what carries an agent sandbox's egress proxy (HTTPS_PROXY with
      // NODE_USE_ENV_PROXY): bypassing it failed every join from Muse's
      // sandbox before a request left (Oct 10, reproduced).
      ...(tailnetOnly ? { agent: false, lookup: tailnetLookup } : {}),
    }, (res) => {
      const chunks = [];
      const limit = res.statusCode >= 200 && res.statusCode < 300 ? responseLimit : RESPONSE_LIMIT;
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) return req.destroy(Error("Reach response exceeds its transport limit."));
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    const connecting = tailnetOnly
      ? setTimeout(() => { if (!connected) req.destroy(unreachable(Error("Reach's private address didn't answer."))); }, connectMs)
      : null;
    connecting?.unref?.();
    req.on("socket", (socket) => socket.once("connect", () => { connected = true; clearTimeout(connecting); }));
    req.on("close", () => clearTimeout(connecting));
    req.on("timeout", () => req.destroy(unreachable(Error("Reach request timed out. Mutating operations are not retried."))));
    req.once("error", (error) => reject(unreachable(error)));
    req.end(body);
  });
}

// The gateway, signed for `audience` (the computer's public origin, its
// identity), reached at the first of `endpoints` that answers: the computer's
// private address when the agent is on the owner's tailnet, else its public
// link. A minute after the private address failed, it's tried again.
// `retry`: true once when the private address became reachable (the agent's
// own node came up): it's tried again at once, not a minute later.
export function funnelGateway(audience, key, { send = httpsSend, now = Date.now, endpoints = [audience], retry = () => false } = {}) {
  let current = 0, failedAt = 0;
  const call = async (input, timeoutMs = 35000) => {
    const payload = JSON.stringify({ v: 1, audience, issuedAt: now(), nonce: crypto.randomBytes(24).toString("base64url"), ...input });
    const signature = crypto.sign("sha256", Buffer.from(payload, "utf8"), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const body = JSON.stringify({ payload, publicKey: key.jwk, signature });
    const headers = {
      "Content-Type": "application/json",
      Origin: audience,
      "Sec-Fetch-Site": "same-origin",
      // Its key named up front: an agent with access has capacity kept for it.
      "Reach-Key": key.thumbprint,
    };
    if (current > 0 && (now() - failedAt > 60_000 || retry())) current = 0;
    // Each request keeps its own fallback cursor. Another request's private
    // failure may change the preference, but cannot consume this fallback.
    let candidate = current;
    for (;;) {
      const endpoint = endpoints[candidate];
      try {
        // Every address but the last (the public link) is a tailnet one.
        const imageLimit = agentJsonResponseLimit(input.path, input.method, input.body);
        const response = await send(endpoint, body, headers, timeoutMs, {
          tailnetOnly: candidate < endpoints.length - 1,
          responseLimit: Math.max(RESPONSE_LIMIT, imageLimit),
        });
        const limit = Math.max(RESPONSE_LIMIT, agentJsonResponseLimit(input.path, input.method, input.body, response.status));
        if (response.bytes.length > limit) throw Error("Reach response exceeds its transport limit.");
        let json = null;
        try { json = JSON.parse(response.bytes.toString("utf8") || "null"); } catch {}
        return { ...response, json, endpoint };
      } catch (error) {
        if (!error?.unreachable || candidate + 1 >= endpoints.length) throw error;
        failedAt = now();
        current = ++candidate;
      }
    }
  };
  return {
    endpoint: () => endpoints[current],
    claim: (invitation) => call({ operation: "claim", invitation }),
    reconnect: (invitation) => call({ operation: "reconnect", invitation }),
    status: (requestId, secret) => call({ operation: "status", requestId, secret }),
    request: (token, method, route, body) =>
      call({ operation: "request", token, method, path: route, body: body ?? null }, agentRequestTimeout(route, method)),
  };
}

// The agent's API, as tailnetApi gives it: (route, method, body) → result.
// A session the computer ended while the access lasts (Reach restarted, the
// owner reopened its link) comes back through the same key, once.
export function funnelApi({ conn, credential, key = agentKey(conn), gatewayOptions = {},
  gateway = funnelGateway(credential.origin, key, { endpoints: [credential.private, credential.origin].filter(Boolean), ...gatewayOptions }), save, reload }) {
  let reconnecting = null;
  const reconnect = (failedToken) => {
    if (reconnecting) return reconnecting;
    // A delayed refusal may name the token another call already replaced.
    reload?.();
    if (credential.token !== failedToken) return true;
    if (!credential.invitation) return false;
    // Renewing again invalidates the first receipt, so concurrent callers
    // share one exchange and save its new token before any retry.
    reconnecting = (async () => {
      const asked = await gateway.reconnect(credential.invitation);
      if (asked.status >= 400) throw agentRequestError(asked.status, asked.json);
      if (asked.status !== 202 || asked.json?.status !== "pending")
        throw agentRequestError(502, { error: "Reach returned an incomplete session renewal. Retry using this connection." });
      if (asked.json.refreshed !== true)
        throw agentRequestError(409, { error: "This connection is waiting for owner approval. Open its existing link to see the verification code." });
      const answer = await gateway.status(asked.json.requestId, asked.json.requestSecret);
      if (answer.status >= 400) throw agentRequestError(answer.status, answer.json);
      if (answer.json?.status === "denied")
        throw agentRequestError(403, { error: "The owner declined this connection." });
      if (answer.json?.status === "expired")
        throw agentRequestError(410, { error: "This connection approval expired. Open its existing link to reconnect." });
      if (answer.status !== 200 || answer.json?.status !== "approved" || typeof answer.json.token !== "string")
        throw agentRequestError(502, { error: "Reach could not collect the renewed session. Retry using this connection." });
      credential.token = answer.json.token;
      save?.(credential);
      return true;
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  };
  return async (route, method = "GET", body) => {
    if (!route.startsWith("/api/") || route.startsWith("//")) throw Error("Invalid API route.");
    if (reconnecting) await reconnecting;
    // Another process may have traded the credential: what it saved.
    reload?.();
    for (let attempt = 0; ; attempt++) {
      const token = credential.token;
      const response = await gateway.request(token, method, route, body);
      if (response.status === 401 && response.headers["reach-not-run"] === "1" && attempt === 0 && (await reconnect(token))) continue;
      const type = String(response.headers["content-type"] || "").split(";")[0].trim();
      if (response.status >= 200 && response.status < 300) {
        if (isScreenImageRoute(route) && ["image/jpeg", "image/png"].includes(type))
          return { image: response.bytes.toString("base64"), mimeType: type };
        return validateAgentJsonResponse(route, method, body, response.json);
      }
      throw agentRequestError(response.status, response.json);
    }
  };
}
