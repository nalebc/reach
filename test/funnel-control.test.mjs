import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { createFunnelAgentGateway } from "../server/funnel-agent.mjs";

// Exercise real signed gateway parsing, without network, keys from a live
// session, desktop capture, or input. The auth fixture is deliberately generous
// so the independent public route allowlist is what denies the owner APIs.
test("signed Muse requests cannot list, create, renew, or stop control leases through Funnel", async () => {
  const origin = "https://fixture.example.ts.net";
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = { ...key.publicKey.export({ format: "jwk" }), ext: true, key_ops: ["verify"] };
  const token = crypto.randomBytes(32).toString("base64url");
  const dispatched = [];
  const gateway = createFunnelAgentGateway({
    origin,
    auth: { verifyFunnel: async (_token, thumbprint) => ({
      id: "muse", kind: "agent", browserTransport: "funnel", browserBinding: thumbprint,
      scopes: ["admin", "browser:read", "browser:request"], policy: { browser: true, screen: "ask" },
    }) },
    dispatch: async (_req, res, context) => {
      dispatched.push(context);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  class Response extends Writable {
    chunks = [];
    statusCode = 200;
    _write(chunk, _encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
    setHeader() {}
    writeHead(status) { this.statusCode = status; }
  }
  const send = async (method, path, body = null) => {
    const payload = JSON.stringify({
      v: 1, audience: origin, issuedAt: Date.now(), nonce: crypto.randomBytes(24).toString("base64url"),
      operation: "request", token, method, path, body,
    });
    const envelope = {
      payload, publicKey,
      signature: crypto.sign("sha256", Buffer.from(payload), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
    };
    const req = new PassThrough();
    req.method = "POST";
    req.url = "/agent-gateway";
    req.headers = { host: new URL(origin).host, origin, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    req.socket = { remoteAddress: "127.0.0.1" };
    const res = new Response();
    const done = new Promise((resolve, reject) => {
      res.once("finish", () => resolve(res.statusCode));
      res.once("error", reject);
    });
    assert.equal(gateway(req, res), true);
    req.end(JSON.stringify(envelope));
    return done;
  };
  const id = "11111111-1111-1111-1111-111111111111";
  for (const [method, path, body] of [
    ["GET", "/api/agents/browser-control"],
    ["HEAD", "/api/agents/browser-control"],
    ["DELETE", `/api/agents/browser-control/${id}`],
    ["POST", `/api/agents/browser-control/${id}`, { acknowledgeRisk: true }],
    ["POST", `/api/agents/browser-requests/${id}`, { decision: "allow-control", acknowledgeRisk: true }],
    ["POST", "/api/browser/control", { acknowledgeRisk: true }],
    ["POST", "/api/browser/requests", { decision: "allow-control", acknowledgeRisk: true }],
  ]) {
    if (path === "/api/browser/requests") {
      // The gateway admits the existing action endpoint; body validation and
      // lease state remain the server's responsibility, covered by route tests.
      assert.equal(await send(method, path, body), 200);
    } else assert.equal(await send(method, path, body), 403, `${method} ${path}`);
  }
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].path, "/api/browser/requests");
});
