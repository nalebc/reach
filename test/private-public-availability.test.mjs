import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { hostedConnector } from "../server/core.mjs";
import { agentKey, funnelApi, funnelGateway } from "../scripts/agent-funnel.mjs";
import { PrivateLinkRecovery } from "../scripts/private-link-recovery.mjs";

const PUBLIC = "https://computer.fixture.ts.net";
const PRIVATE = `${PUBLIC}:8443`;

// Real admission, signature, ingress and route guards. Only Tailscale's
// delivery/process identity and Serve inventory are synthetic; no daemon,
// native input, public service or account is used.
async function fixture(t, platform) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-route-availability-")));
  const keyed = platform === "win32" || process.platform === "win32";
  const socketDir = keyed ? "" : fs.mkdtempSync("/tmp/reach-route-availability-");
  const socketPath = keyed ? "" : path.join(socketDir, "s");
  const reach = await createReach({
    platform, name: "Disposable route fixture", roots: [root], dataDir: path.join(root, "state"),
    agentPolicyFile: path.join(root, "no-policy.json"), publicOrigin: PRIVATE,
    allowedOrigins: [PUBLIC], tailscaleOwner: { userId: "42", login: "owner@example.test" },
    tailscaleIdentity: { lookup: async () => null }, sweepScreenHelpers() {},
  });
  const publicApp = (req, res) => reach.publicAgent(req, res) || (res.writeHead(404), res.end("Not found."));
  await new Promise((resolve, reject) => { reach.server.once("error", reject); reach.server.listen(0, "127.0.0.1", resolve); });
  const ingressKey = keyed ? newIngressKey() : "";
  const port = keyed ? await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true }, publicApp }) : 0;
  if (!keyed) await reach.listenPrivate(socketPath, { publicApp });
  t.after(async () => {
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
  });
  const send = (endpoint, body, headers, _timeout, _options, route = "/agent-gateway") => new Promise((resolve, reject) => {
    const privately = endpoint === PRIVATE;
    const host = new URL(endpoint).host;
    const req = http.request({
      ...(keyed ? { host: "127.0.0.1", port, path: `/r-${ingressKey}${route}` } : { socketPath, path: route }),
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, Host: keyed ? host : "localhost", "X-Forwarded-Host": host,
        ...(privately ? { "X-Forwarded-For": "100.64.0.20" } : { "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.7" }) },
    }, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.once("error", reject);
    req.end(body);
  });
  const key = agentKey(root);
  const grant = reach.auth.inviteBrowser({ name: "Disposable agent", transport: "funnel", preset: "readonly", ttlSeconds: 3600 });
  const claim = reach.auth.redeemFunnelBrowser(grant.invitation, key.thumbprint);
  reach.auth.decideAgentAdmission(claim.requestId, "approve");
  const approved = reach.auth.pollFunnelAdmission(claim.requestId, claim.requestSecret, key.thumbprint);
  const api = endpoint => funnelApi({ conn: root, credential: { origin: PUBLIC, token: approved.token }, key,
    gateway: funnelGateway(PUBLIC, key, { endpoints: [endpoint], send }) });
  const hostedGrant = reach.auth.inviteBrowser({ name: "Disposable hosted agent", transport: "funnel", hosted: true, preset: "readonly", ttlSeconds: 3600 });
  const connector = hostedConnector(hostedGrant.invitation), binding = crypto.randomBytes(32).toString("base64url");
  const hostedClaim = reach.auth.claimHostedInvitation(binding, { name: "Fixture", clientId: "fixture", connector });
  reach.auth.decideAgentAdmission(hostedClaim.requestId, "approve");
  const hostedAccess = reach.auth.pollFunnelAdmission(hostedClaim.requestId, hostedClaim.requestSecret, binding);
  const hosted = () => send(PUBLIC, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reach_access", arguments: {} } }),
    { "Content-Type": "application/json", Authorization: `Bearer ${binding}.${hostedAccess.accessToken}` }, 0, {}, `/mcp/${connector}`);
  return { reach, send, api, grant, hosted };
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: private Serve loss preserves the authorized public gateway, without exposing owner routes`, { timeout: 15000 }, async t => {
    const f = await fixture(t, platform);
    const publicApi = f.api(PUBLIC), privateApi = f.api(PRIVATE);
    assert.equal((await privateApi("/api/device")).access.kind, "agent");
    const target = "http://127.0.0.1:5555";
    let present = true;
    const owned = { TCP: { 8443: { HTTPS: true } }, Web: { [new URL(PRIVATE).host]: { Handlers: { "/": { Proxy: target } } } } };
    const recovery = new PrivateLinkRecovery({ origin: PRIVATE, target,
      inspect: async () => present ? owned : {}, restart: async () => {},
      // This is the launcher's private recovery notification. The fallback
      // reproduces the original global setter on the unchanged public code.
      available: value => (f.reach.setPrivateTransportAvailable || f.reach.setTransportAvailable)(value),
    });
    await recovery.check();
    present = false;
    await recovery.check();
    await recovery.check();
    assert.equal((await f.send(PRIVATE, undefined, {}, 0, {}, "/api/health")).status, 503);
    assert.equal((await publicApi("/api/device")).access.kind, "agent", "a different Serve port failing must not close the working signed gateway");
    const hosted = await f.hosted(), hostedResult = JSON.parse(hosted.bytes.toString("utf8"));
    assert.equal(hosted.status, 200);
    assert.ok(hostedResult.result?.content?.length > 0 && hostedResult.result.isError !== true, "the authorized hosted tool reaches real inner dispatch while private Serve is down");
    assert.equal((await f.send(PUBLIC, undefined, {}, 0, {}, "/api/clients")).status, 404, "ordinary owner APIs remain outside the public door");

    f.reach.setTransportAvailable(false);
    await assert.rejects(publicApi("/api/device"), { status: 503 }, "whole transport loss still closes both routes");
    f.reach.setTransportAvailable(true);
    assert.equal((await publicApi("/api/device")).access.kind, "agent");
    assert.equal((await f.send(PRIVATE, undefined, {}, 0, {}, "/api/health")).status, 503, "global recovery does not reopen the still-missing private route");

    present = true;
    await recovery.check();
    assert.equal((await f.send(PRIVATE, undefined, {}, 0, {}, "/api/health")).status, 200);
    assert.equal((await privateApi("/api/device")).access.kind, "agent", "the approved grant works privately after Serve recovers");
    await f.reach.setPaused(true);
    await assert.rejects(publicApi("/api/device"), { status: 503 });
    await f.reach.setPaused(false);
    f.reach.auth.revoke(f.grant.clientId);
    await assert.rejects(publicApi("/api/device"), { status: 401 }, "route recovery never revives a revoked grant");
  });
}
