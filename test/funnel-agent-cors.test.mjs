import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../server/core.mjs";
import { createReach } from "../server/index.mjs";
import { createFunnelAgentGateway } from "../server/funnel-agent.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { agentKey } from "../scripts/agent-funnel.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

const ORIGIN = "https://computer.fixture.ts.net", HOST = "computer.fixture.ts.net:8443";
const EXPOSED = ["reach-not-run", "retry-after", "etag", "x-reach-screen", "content-disposition", "content-length", "content-range", "accept-ranges"];
const headerNames = value => String(value || "").toLowerCase().split(",").map(name => name.trim()).filter(Boolean).sort();
const sign = (key, input) => {
  const payload = JSON.stringify({ v: 1, audience: ORIGIN, issuedAt: Date.now(), nonce: crypto.randomBytes(24).toString("base64url"), ...input });
  return { payload, publicKey: key.jwk, signature: crypto.sign("sha256", Buffer.from(payload), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
};
function approve(auth, key) {
  const grant = auth.inviteBrowser({ name: "Disposable CORS agent", preset: "readonly", transport: "funnel", ttlSeconds: 600 });
  const receipt = auth.redeemFunnelBrowser(grant.invitation, key.thumbprint);
  auth.decideAgentAdmission(receipt.requestId, "approve");
  return { grant, token: auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, key.thumbprint).token };
}
const request = (key, token, route = "/api/device") => sign(key, { operation: "request", token, method: "GET", path: route, body: null });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-gateway-cors-"));
  const auth = createAuth({ dataDir: path.join(root, "state"), roots: [], agentPolicyFile: path.join(root, "policy.json") });
  const key = agentKey(root), { grant, token } = approve(auth, key);
  let available = true, dispatched = 0;
  const gateway = createFunnelAgentGateway({ auth, origin: ORIGIN, privateHost: HOST, available: () => available,
    dispatch(_req, res) { dispatched++; res.writeHead(200, { "Content-Type": "application/json", ETag: '"fixture-etag"', "X-Reach-Screen": '{"width":17}' }); res.end('{"ok":true}'); } });
  const server = http.createServer((req, res) => { if (!gateway(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const call = (method = "POST", headers = {}, body = request(key, token), route = "/agent-gateway") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: route, method,
      headers: Object.fromEntries(Object.entries({ Host: HOST, Origin: ORIGIN, "Sec-Fetch-Site": "same-site", ...(method === "POST" ? { "Content-Type": "application/json", "Reach-Key": key.thumbprint } : {}), ...headers }).filter(([, value]) => value !== undefined)) }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.once("error", reject); req.end(method === "POST" ? JSON.stringify(body) : undefined);
  });
  return { auth, key, token, grant, call, dispatched: () => dispatched, pause: value => { available = !value; } };
}
const preflight = { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, reach-key" };

test("private gateway preflight allows only the configured origin, private host and signed POST headers", async t => {
  const f = await fixture(t), admissions = f.auth.listAgentAdmissions();
  f.pause(true);
  const result = await f.call("OPTIONS", preflight);
  assert.equal(result.status, 204);
  assert.equal(result.bytes.length, 0);
  assert.equal(result.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(result.headers["access-control-allow-methods"], "POST");
  assert.deepEqual(headerNames(result.headers["access-control-allow-headers"]), ["content-type", "reach-key"]);
  assert.equal(result.headers["access-control-allow-credentials"], undefined);
  assert.equal(f.dispatched(), 0);
  assert.deepEqual(f.auth.listAgentAdmissions(), admissions, "preflight cannot create or consume an admission, even while paused");
});

test("private gateway preflight rejects foreign origins, hosts, sites, methods and extra headers without CORS", async t => {
  const f = await fixture(t);
  for (const [headers, status] of [
    [{ Origin: "https://attacker.fixture.ts.net" }, 403], [{ Origin: "null" }, 403], [{ Origin: undefined }, 403],
    [{ Host: "attacker.fixture.ts.net:8443" }, 421], [{ Host: "computer.fixture.ts.net:8444" }, 421],
    [{ Host: new URL(ORIGIN).host, "Sec-Fetch-Site": "same-origin" }, 405],
    [{ "Sec-Fetch-Site": "cross-site" }, 403], [{ "Sec-Fetch-Site": "none" }, 403],
    [{ "Access-Control-Request-Method": "GET" }, 405], [{ "Access-Control-Request-Method": "DELETE" }, 405],
    [{ "Access-Control-Request-Headers": "content-type, authorization" }, 403], [{ "Access-Control-Request-Headers": "content-type, x-attacker" }, 403],
    [{ "Access-Control-Request-Headers": "content-type,,reach-key" }, 403],
  ]) {
    const result = await f.call("OPTIONS", { ...preflight, ...headers });
    assert.equal(result.status, status, JSON.stringify(headers));
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  assert.equal((await f.call("OPTIONS", preflight, undefined, "/api/clients")).status, 404, "the gateway does not preflight owner APIs");
  assert.equal(f.dispatched(), 0);
});

test("private gateway CORS preserves signature, scope, revocation and replay gates", async t => {
  const f = await fixture(t), envelope = request(f.key, f.token);
  const success = await f.call("POST", {}, envelope);
  assert.equal(success.status, 200);
  assert.equal(success.headers["access-control-allow-origin"], ORIGIN);
  assert.deepEqual(headerNames(success.headers["access-control-expose-headers"]), [...EXPOSED].sort());
  assert.equal(success.headers["access-control-allow-credentials"], undefined);
  assert.equal((await f.call("POST", {}, envelope)).status, 409, "the same signed read cannot dispatch twice");
  assert.equal((await f.call("POST", {}, request(f.key, f.token, "/api/clients"))).status, 403, "owner APIs stay outside the signed route table");
  const invalid = request(f.key, f.token); invalid.signature = crypto.randomBytes(64).toString("base64url");
  assert.equal((await f.call("POST", {}, invalid)).status, 401);
  f.auth.revoke(f.grant.clientId);
  assert.equal((await f.call()).status, 401);
  assert.equal(f.dispatched(), 1);
});

test("private gateway refusals expose safe retry metadata and public same-origin behavior stays unchanged", async t => {
  const f = await fixture(t);
  f.pause(true);
  const paused = await f.call();
  assert.equal(paused.status, 503);
  assert.equal(paused.headers["reach-not-run"], "1");
  assert.equal(paused.headers["retry-after"], "5");
  assert.equal(paused.headers["access-control-allow-origin"], ORIGIN);
  assert.deepEqual(headerNames(paused.headers["access-control-expose-headers"]), [...EXPOSED].sort());
  f.pause(false);
  const publicHeaders = { Host: new URL(ORIGIN).host, "Sec-Fetch-Site": "same-origin" };
  const publicResponse = await f.call("POST", publicHeaders);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers["access-control-allow-origin"], undefined);
  for (const headers of [{ ...publicHeaders, "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "https://attacker.fixture.ts.net" }]) {
    const result = await f.call("POST", headers);
    assert.equal(result.status, 403);
    assert.equal(result.headers["access-control-allow-origin"], undefined);
  }
  assert.equal((await f.call("PUT")).status, 405);
  assert.equal(f.dispatched(), 1);
});

const chromeBinary = findChrome();
test("real Chrome reads private signed responses and metadata through Reach's ordinary inner middleware", { skip: !process.env.CI && !chromeBinary && "Chrome/Chromium is not installed", timeout: 30000 }, async t => {
  assert.ok(chromeBinary, "Chrome/Chromium is required for the CI CORS contract");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-gateway-cors-chrome-"));
  const certificate = await testCertificate(root, new URL(ORIGIN).hostname), seen = [];
  let reach, browser, ingressPort;
  const ingressKey = newIngressKey();
  const tls = https.createServer(certificate, (req, res) => {
    seen.push({ method: req.method, path: req.url, site: req.headers["sec-fetch-site"], origin: req.headers.origin, host: req.headers.host });
    if (req.url !== "/agent-gateway") { res.writeHead(404); return res.end(); }
    const proxy = http.request({ host: "127.0.0.1", port: ingressPort, path: `/r-${ingressKey}${req.url}`, method: req.method,
      headers: { ...req.headers, host: "localhost", "x-forwarded-host": req.headers.host, "x-forwarded-for": "100.64.0.20" } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    proxy.on("error", error => res.destroy(error)); req.pipe(proxy);
  });
  await new Promise((resolve, reject) => { tls.once("error", reject); tls.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    const errors = [];
    for (const cleanup of [
      () => browser?.close(),
      async () => { tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve)); },
      async () => { if (reach) { reach.server.closeAllConnections(); await reach.close(); } },
      () => fs.rmSync(root, { recursive: true, force: true }),
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Disposable CORS fixture cleanup failed");
  });
  const privateOrigin = `${ORIGIN}:${tls.address().port}`;
  reach = await createReach({ publicOrigin: privateOrigin, allowedOrigins: [ORIGIN], dataDir: path.join(root, "state"), roots: [],
    agentPolicyFile: path.join(root, "policy.json"), name: "Disposable CORS host", previousRun: null, runMarker: false, tidy: false,
    screen: true, browserScreenSupported: true, sweepScreenHelpers() {},
    tailscaleOwner: { userId: "42", login: "fixture@example.test" }, tailscaleIdentity: { lookup: async () => null },
    agentDesktop: { available: () => true, screenshot: async (_client, authorize) => { authorize(); return { jpeg: Buffer.from([255, 216, 255, 217]), width: 17, height: 11, hidden: 2 }; }, cancelClient() {} },
    browserCapture: async () => assert.fail("no actual screen capture"), browserInput: async () => assert.fail("no actual desktop input"),
    desktopTerminals: { platform: "linux", run: async () => assert.fail("no actual terminal access") },
  });
  await new Promise((resolve, reject) => { reach.server.once("error", reject); reach.server.listen(0, "127.0.0.1", resolve); });
  // The production Windows private ingress, including its exact-host
  // resolution, is portable here. Only the tailscaled process check is a
  // stand-in; Chrome, TLS, CORS, gateway and inner middleware are real.
  ingressPort = await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true } });
  const key = agentKey(root), { grant, token } = approve(reach.auth, key);
  browser = await launchChrome(t, { binary: chromeBinary, hosts: [new URL(ORIGIN).hostname], spki: certificate.spki });
  const version = await browser.send("Browser.getVersion");
  // The fixture maps its private host into loopback. Give only this
  // disposable origin the browser's local-network permission; ordinary
  // CORS and fetch-site enforcement remain enabled. Older Chrome builds
  // may predate these permission names and the associated local check.
  for (const name of ["local-network-access", "local-network", "loopback-network"]) {
    try { await browser.send("Browser.setPermission", { permission: { name }, setting: "granted", origin: ORIGIN }); }
    catch (error) { if (!/Invalid PermissionDescriptor|Unknown permission|Unrecognized permission/i.test(error.message)) throw error; }
  }
  const tab = await openTab(browser);
  // Fulfill the inert bootstrap document (and refuse its favicon) without
  // touching any public listener at its real HTTPS origin.
  // Private API requests use actual Chrome CORS + loopback TLS + Reach's
  // gateway/inner Express middleware; no CORS or fetch-site flags disabled.
  browser.on("Fetch.requestPaused", (event, session) => {
    if (session === tab.sessionId) void tab.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: event.request.url === `${ORIGIN}/` ? 200 : 404,
      responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: Buffer.from("<!doctype html><title>Disposable CORS fixture</title>").toString("base64") })
      .catch(error => t.diagnostic(`Disposable bootstrap ended: ${error.message}`));
  });
  await tab.send("Fetch.enable", { patterns: [{ urlPattern: `${ORIGIN}/*`, requestStage: "Request" }] });
  await tab.navigate(`${ORIGIN}/`);
  assert.equal(await tab.evaluate("location.origin"), ORIGIN);
  const fetchSigned = (envelope) => tab.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(`${privateOrigin}/agent-gateway`)}, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json", "Reach-Key": ${JSON.stringify(key.thumbprint)} }, body: ${JSON.stringify(JSON.stringify(envelope))} });
    return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())), headers: Object.fromEntries(response.headers) };
  })()`).catch(error => { t.diagnostic(JSON.stringify({ seen, browserProblems: tab.problems })); throw error; });
  const device = await fetchSigned(request(key, token));
  assert.equal(device.status, 200);
  assert.equal(JSON.parse(Buffer.from(device.bytes).toString()).access.kind, "agent");
  const shot = request(key, token, "/api/browser/desktop/screen");
  const image = await fetchSigned(shot);
  assert.equal(image.status, 200);
  assert.deepEqual(image.bytes, [255, 216, 255, 217]);
  assert.deepEqual(JSON.parse(image.headers["x-reach-screen"]), { width: 17, height: 11, hidden: 2 });
  assert.ok(image.headers.etag, "inner Express ETag is visible across ports");
  const replay = await fetchSigned(shot);
  assert.equal(replay.status, 409);
  assert.equal(replay.headers["reach-not-run"], "1");
  await reach.setPaused(true);
  const paused = await fetchSigned(request(key, token));
  assert.equal(paused.status, 503);
  assert.equal(paused.headers["reach-not-run"], "1");
  assert.equal(paused.headers["retry-after"], "5");
  await reach.setPaused(false);
  reach.auth.revoke(grant.clientId);
  assert.equal((await fetchSigned(request(key, token))).status, 401);
  assert.ok(seen.some(item => item.method === "OPTIONS" && item.site === "same-site"));
  assert.ok(seen.filter(item => item.method === "POST").every(item => item.site === "same-site" && item.origin === ORIGIN && item.host === new URL(privateOrigin).host));
  t.diagnostic(JSON.stringify({ chrome: version.product, hostPlatform: process.platform, preflights: seen.filter(item => item.method === "OPTIONS").length,
    signedPosts: seen.filter(item => item.method === "POST").length, transport: "real browser/TLS/Windows keyed ingress/inner middleware", mocked: "tailscaled peer check, desktop image, DNS mapping, bootstrap page; fixture-only local network permission" }));
});
