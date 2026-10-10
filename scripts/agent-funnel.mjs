// Reach's tools over the computer's public link (Tailscale Funnel), for an
// agent outside the owner's Tailscale network when invite links aren't set
// up: nothing to install on the owner's side, no Tailscale key. The agent
// signs every request with its own P-256 key, kept owner-only in its folder,
// through the gateway Reach's agent page uses (server/funnel-agent.mjs): open
// only while the agent has access, every request checked against its
// preset's routes, replays refused. Its approved key reconnects at once;
// another computer needs the owner's code (core.mjs relink).
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { agentRequestError, agentRequestTimeout } from "../server/agent-transport.mjs";
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

// One signed request to the gateway, over HTTPS to one of the computer's
// addresses. A failure before the connection is made (no route, refused,
// a name that doesn't resolve) is marked unreachable: the next address is
// tried. Anything later isn't, so an action never runs twice.
function httpsSend(endpoint, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const unreachable = (error) => Object.assign(error, { unreachable: !connected });
    const req = https.request(`${endpoint}/agent-gateway`, { method: "POST", headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) return req.destroy(Error("Reach response exceeds 8 MiB."));
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("socket", (socket) => socket.once("connect", () => { connected = true; }));
    req.on("timeout", () => req.destroy(unreachable(Error("Reach request timed out. Mutating operations are not retried."))));
    req.once("error", (error) => reject(unreachable(error)));
    req.end(body);
  });
}

// The gateway, signed for `audience` (the computer's public origin, its
// identity), reached at the first of `endpoints` that answers: the computer's
// private address when the agent is on the owner's tailnet, else its public
// link. A minute after the private address failed, it's tried again.
export function funnelGateway(audience, key, { send = httpsSend, now = Date.now, endpoints = [audience] } = {}) {
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
    if (current > 0 && now() - failedAt > 60_000) current = 0;
    for (;;) {
      const endpoint = endpoints[current];
      try {
        const response = await send(endpoint, body, headers, timeoutMs);
        let json = null;
        try { json = JSON.parse(response.bytes.toString("utf8") || "null"); } catch {}
        return { ...response, json, endpoint };
      } catch (error) {
        if (!error?.unreachable || current + 1 >= endpoints.length) throw error;
        failedAt = now();
        current++;
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
export function funnelApi({ conn, credential, key = agentKey(conn),
  gateway = funnelGateway(credential.origin, key, { endpoints: [credential.private, credential.origin].filter(Boolean) }), save }) {
  const reconnect = async () => {
    if (!credential.invitation) return false;
    const asked = await gateway.reconnect(credential.invitation);
    if (asked.status !== 202 || asked.json?.status !== "pending" || asked.json.refreshed !== true) return false;
    const answer = await gateway.status(asked.json.requestId, asked.json.requestSecret);
    if (answer.json?.status !== "approved" || typeof answer.json.token !== "string") return false;
    credential.token = answer.json.token;
    save?.(credential);
    return true;
  };
  return async (route, method = "GET", body) => {
    if (!route.startsWith("/api/") || route.startsWith("//")) throw Error("Invalid API route.");
    for (let attempt = 0; ; attempt++) {
      const response = await gateway.request(credential.token, method, route, body);
      if (response.status === 401 && response.headers["reach-not-run"] === "1" && attempt === 0 && (await reconnect())) continue;
      const type = String(response.headers["content-type"] || "").split(";")[0].trim();
      if (response.status >= 200 && response.status < 300) {
        if (isScreenImageRoute(route) && ["image/jpeg", "image/png"].includes(type))
          return { image: response.bytes.toString("base64"), mimeType: type };
        return response.json;
      }
      throw agentRequestError(response.status, response.json);
    }
  };
}
