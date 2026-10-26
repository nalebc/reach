import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { build } from "esbuild";
import { createReach } from "../server/index.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { publicStartHandler } from "../server/public-start.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

const ORIGIN = "https://owner.fixture.ts.net", hostname = new URL(ORIGIN).hostname;
const chromeBinary = findChrome();
for (const sourceRole of ["browser", "native"]) test(`real Chrome enrolls ${sourceRole}-first across ports${sourceRole === "native" ? " while an app agent is active" : ""} with persisted keys and normal CORS`, {
  skip: !process.env.CI && !chromeBinary && "Chrome/Chromium is not installed", timeout: 30000,
}, async t => {
  assert.ok(chromeBinary, "Chrome is required in CI");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-owner-cors-"));
  const certificate = await testCertificate(root, hostname), seen = [], trace = [], ingressKey = newIngressKey();
  let reach, browser, ingressPort, publicRoute = false, sourceUnavailable = false;
  const tls = https.createServer(certificate, (req, res) => {
    seen.push({ method: req.method, path: req.url, origin: req.headers.origin, site: req.headers["sec-fetch-site"], bearer: !!req.headers.authorization });
    const source = req.url === "/api/device/owner-connection";
    if (source && sourceUnavailable) return res.destroy();
    const proxy = http.request({ host: "127.0.0.1", port: ingressPort, path: `/r-${ingressKey}${req.url}`, method: req.method,
      headers: { ...req.headers, host: "localhost", "x-forwarded-host": req.headers.host,
        "x-forwarded-for": source ? "100.64.0.21" : "100.64.0.22", "tailscale-user-login": "owner@example.test",
        ...(publicRoute ? { "tailscale-funnel-request": "?1" } : {}) } }, response => {
      // What went back, for a failure's report (Oct 26, Ubuntu/Node 22 CI:
      // two preflights seen, no POST after them, "Failed to fetch").
      trace.push({ answered: req.method, path: req.url, status: response.statusCode,
        allowOrigin: response.headers["access-control-allow-origin"] || null,
        allowMethods: response.headers["access-control-allow-methods"] || null,
        allowHeaders: response.headers["access-control-allow-headers"] || null });
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    proxy.on("error", error => { trace.push({ proxyError: error.code || error.message, path: req.url }); res.destroy(error); }); req.pipe(proxy);
  });
  await new Promise((resolve, reject) => { tls.once("error", reject); tls.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    await browser?.close(); tls.closeAllConnections(); await new Promise(resolve => tls.close(resolve));
    if (reach) { reach.server.closeAllConnections(); await reach.close(); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const privateOrigin = `${ORIGIN}:${tls.address().port}`, dataDir = path.join(root, "state");
  const owner = { userId: "42", login: "owner@example.test" };
  reach = await createReach({ publicOrigin: privateOrigin, allowedOrigins: [ORIGIN], dataDir, roots: [],
    name: "Disposable owner host", previousRun: null, runMarker: false, tidy: false,
    agentPolicyFile: path.join(root, "policy.json"), sweepScreenHelpers() {},
    tailscaleOwner: owner, tailscaleStatus: async () => ({ Self: { TailscaleIPs: ["100.64.0.99"] } }),
    tailscaleIdentity: { lookup: async ip => ({
      Node: { StableID: ip === "100.64.0.21" ? "source" : "target", User: 42, Name: "phone.fixture.ts.net.", KeyExpiry: "0001-01-01T00:00:00Z" },
      UserProfile: { ID: 42, LoginName: owner.login },
    }) },
    browserHostGuard: { lookup: async () => ({ BackendState: "Running", Self: { ID: "host" },
      Peer: { phone: { ID: sourceRole === "native" ? "source" : "target", OS: "iOS", UserID: 42 } } }) },
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const dist = path.join(root, "dist"); fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "start.html"), "<!doctype html><title>Owner start</title>");
  ingressPort = await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true },
    publicApp: publicStartHandler({ dist, privateOrigin, home: ORIGIN, name: "Fixture", instance: reach.instance }),
  });
  const grant = reach.auth.issue("Owner phone", ["admin"], "device", { tailscale: { userId: "42", nodeId: "source" } });
  if (sourceRole === "native") reach.auth.inviteBrowser({ name: "Active app agent", ttlSeconds: 600, screen: "apps", appAccess: [] },
    { nodeId: "source", userId: "42", clientId: grant.clientId });
  const device = JSON.parse(fs.readFileSync(path.join(dataDir, "device.json")));
  const peer = { ...device, name: "Fixture", url: privateOrigin, token: grant.token };
  const config = { product: "Reach", origin: privateOrigin, home: ORIGIN, instance: reach.instance, name: "Fixture", tailnet: null };
  const bundle = (await build({ stdin: { contents: 'export { ownerEnrollment, browserOwnerKeys } from "./src/owner-connection.ts";', resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", globalName: "OwnerFixture", platform: "browser", target: "es2022" })).outputFiles[0].text;
  // Chrome's own network log beside the test's reports, for a failure on a
  // runner (fixture hosts and test credentials only).
  const netLog = path.join(process.cwd(), "reports", `owner-cors-${sourceRole}-netlog.json`);
  fs.mkdirSync(path.dirname(netLog), { recursive: true });
  browser = await launchChrome(t, { binary: chromeBinary, hosts: [hostname], spki: certificate.spki,
    args: [`--log-net-log=${netLog}`, "--net-log-capture-mode=IncludeSensitive"] });
  const version = await browser.send("Browser.getVersion");
  for (const name of ["local-network-access", "local-network", "loopback-network"]) {
    try { await browser.send("Browser.setPermission", { permission: { name }, setting: "granted", origin: ORIGIN }); }
    catch (error) { if (!/Invalid PermissionDescriptor|Unknown permission|Unrecognized permission/i.test(error.message)) throw error; }
  }
  const tab = await openTab(browser);
  // Chrome's own reason when a request fails (a CORS refusal names itself).
  await tab.send("Network.enable");
  const sent = new Map();
  browser.on("Network.requestWillBeSent", (event, session) => {
    if (session === tab.sessionId) sent.set(event.requestId, `${event.request.method} ${new URL(event.request.url).pathname} (${event.initiator?.type})`);
  });
  browser.on("Network.loadingFailed", (event, session) => {
    if (session === tab.sessionId) trace.push({ chromeFailed: event.errorText, canceled: event.canceled ?? null, request: sent.get(event.requestId) || event.requestId,
      cors: event.corsErrorStatus || null, blocked: event.blockedReason || null, type: event.type, at: Math.round(performance.now()) });
  });
  await tab.send("Page.enable");
  browser.on("Page.frameNavigated", (event, session) => {
    if (session === tab.sessionId) trace.push({ navigated: event.frame.url, parent: event.frame.parentId || null, at: Math.round(performance.now()) });
  });
  browser.on("Runtime.executionContextDestroyed", (event, session) => {
    if (session === tab.sessionId) trace.push({ contextDestroyed: event.executionContextId, at: Math.round(performance.now()) });
  });
  browser.on("Fetch.requestPaused", (event, session) => {
    if (session === tab.sessionId) void tab.send("Fetch.fulfillRequest", { requestId: event.requestId,
      responseCode: event.request.url === `${ORIGIN}/` ? 200 : 404,
      responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: Buffer.from("<!doctype html><title>Owner fixture</title>").toString("base64") }).catch(() => {});
  });
  await tab.send("Fetch.enable", { patterns: [{ urlPattern: `${ORIGIN}/*`, requestStage: "Request" }] });
  await tab.navigate(`${ORIGIN}/`); await tab.evaluate(bundle);
  // The page's own code, fixed; the peer and its config go in as arguments
  // (DevTools' callFunctionOn), never spliced into code (CodeQL #358).
  const call = async (fn, ...args) => {
    const { result: page } = await tab.send("Runtime.evaluate", { expression: "globalThis" });
    const { result, exceptionDetails } = await tab.send("Runtime.callFunctionOn", {
      objectId: page.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })),
      awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const joined = await call(`async function (peer, config, sourceRole) {
    const setup = () => OwnerFixture.ownerEnrollment(peer, sourceRole, config);
    const [first, second] = await Promise.all([setup().join(new AbortController().signal), setup().join(new AbortController().signal)]);
    const pair = await OwnerFixture.browserOwnerKeys.pair(peer.computerId || peer.id);
    return { first, second, extractable: pair.privateKey.extractable,
      saved: JSON.parse(localStorage.getItem(sourceRole === "native" ? "reach.browser.devices" : "reach.devices")) };
  }`, peer, config, sourceRole).catch(error => { t.diagnostic(JSON.stringify({ seen, trace, problems: tab.problems })); throw error; });
  assert.equal(joined.first.token, joined.second.token);
  assert.equal(joined.extractable, false);
  assert.equal(joined.saved[0].token, joined.first.token);
  assert.notEqual(joined.first.token, grant.token);
  sourceUnavailable = true;
  const sourceRequests = seen.filter(r => r.path === '/api/device/owner-connection').length;
  await tab.navigate(`${ORIGIN}/`); await tab.evaluate(bundle);
  const restored = await call(`async function (peer, config, sourceRole) {
    return OwnerFixture.ownerEnrollment(peer, sourceRole, config).join(new AbortController().signal);
  }`, peer, config, sourceRole);
  assert.equal(restored.token, joined.first.token, "IndexedDB key and proposed credential survive reload");
  assert.equal(seen.filter(r => r.path === '/api/device/owner-connection').length, sourceRequests, 'persisted proof resumes without the original route');
  await assert.rejects(call(`async function (peer, config, sourceRole) {
    return OwnerFixture.ownerEnrollment(peer, sourceRole, config).prepare(new AbortController().signal, false);
  }`, { ...peer, token: "DIFFERENT-GRANT" }, config, sourceRole), /not been prepared/);
  assert.equal(reach.auth.list().filter(c => c.kind === "device").length, 2);
  assert.ok(seen.some(r => r.method === "OPTIONS" && r.site === "same-site"));
  assert.ok(seen.filter(r => r.path.startsWith("/api/auth/owner-connection/")).every(r => !r.bearer));
  assert.equal(await tab.evaluate("location.origin"), ORIGIN);
  // Real upgrade and first-message authentication through private ingress.
  // A browser node is eligible only after its own approval has been issued;
  // the native bearer remains unusable there.
  const socket = new WebSocket(`ws://127.0.0.1:${ingressPort}/r-${ingressKey}/ws/presence`, { headers: {
    Origin: ORIGIN, "X-Forwarded-For": "100.64.0.22", "Tailscale-User-Login": owner.login,
  } });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const presence = once(socket, "message");
  socket.send(JSON.stringify({ type: "auth", token: joined.first.token, kind: "phone" }));
  assert.equal(JSON.parse((await presence)[0].toString()).devices[0].access[0].kind, "paired");
  socket.close(); await once(socket, "close");
  if (sourceRole === "native") {
    const refused = await call(`async function (origin, token) {
      return (await fetch(origin + "/api/device", { headers: { Authorization: "Bearer " + token } })).status;
    }`, privateOrigin, grant.token);
    assert.equal(refused, 403, "copying a native bearer does not authorize the browser node");
    const admission = await call(`async function (origin) {
      return (await fetch(origin + "/api/auth/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status;
    }`, privateOrigin);
    assert.equal(admission, 403, "ordinary browser admission stays blocked while the agent is active");
  }
  // The public ingress serves fixed bootstrap without an invitation or cookie.
  // An owner credential does not open APIs through Funnel.
  publicRoute = true;
  const publicRead = route => new Promise((resolve, reject) => {
    https.get(`${privateOrigin}${route}`, { lookup: (_host, _options, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]),
      ca: certificate.cert, headers: { Authorization: `Bearer ${joined.first.token}` } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(reach.funnelWindow().open, false);
  for (const route of ["/", "/files", "/screen", "/reach-start.json"]) assert.equal(await publicRead(route), 200, route);
  for (const route of ["/api/device", "/api/auth/owner-connection/join", "/ws/presence"]) assert.equal(await publicRead(route), 404, route);
  t.diagnostic(JSON.stringify({ chrome: version.product, hostPlatform: process.platform,
    real: "Chrome, IndexedDB, WebCrypto, TLS, cross-port CORS, keyed ingress, owner HTTP/WS authentication, app host guard", simulated: "Tailscale identities, DNS, browser transport, loopback network permission" }));
});
