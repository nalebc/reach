import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { createReach } from "../server/index.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { publicStartHandler } from "../server/public-start.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

const ORIGIN = "https://owner.fixture.ts.net", hostname = new URL(ORIGIN).hostname;
const chromeBinary = findChrome();
test("real Chrome enrolls a separate owner path across ports with persisted non-exportable keys and normal CORS", {
  skip: !process.env.CI && !chromeBinary && "Chrome/Chromium is not installed", timeout: 30000,
}, async t => {
  assert.ok(chromeBinary, "Chrome is required in CI");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-owner-cors-"));
  const certificate = await testCertificate(root, hostname), seen = [], ingressKey = newIngressKey();
  let reach, browser, ingressPort, publicRoute = false, sourceUnavailable = false;
  const tls = https.createServer(certificate, (req, res) => {
    seen.push({ method: req.method, path: req.url, origin: req.headers.origin, site: req.headers["sec-fetch-site"], bearer: !!req.headers.authorization });
    const source = req.url === "/api/device/owner-connection";
    if (source && sourceUnavailable) return res.destroy();
    const proxy = http.request({ host: "127.0.0.1", port: ingressPort, path: `/r-${ingressKey}${req.url}`, method: req.method,
      headers: { ...req.headers, host: "localhost", "x-forwarded-host": req.headers.host,
        "x-forwarded-for": source ? "100.64.0.21" : "100.64.0.22", "tailscale-user-login": "owner@example.test",
        ...(publicRoute ? { "tailscale-funnel-request": "?1" } : {}) } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    proxy.on("error", error => res.destroy(error)); req.pipe(proxy);
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
      Node: { StableID: ip === "100.64.0.21" ? "source-browser" : "target-app", User: 42, Name: "phone.fixture.ts.net.", KeyExpiry: "0001-01-01T00:00:00Z" },
      UserProfile: { ID: 42, LoginName: owner.login },
    }) },
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const dist = path.join(root, "dist"); fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "start.html"), "<!doctype html><title>Owner start</title>");
  ingressPort = await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true },
    publicApp: publicStartHandler({ dist, privateOrigin, home: ORIGIN, name: "Fixture", instance: reach.instance }),
  });
  const grant = reach.auth.issue("Owner browser", ["admin"], "device", { tailscale: { userId: "42", nodeId: "source-browser" } });
  const device = JSON.parse(fs.readFileSync(path.join(dataDir, "device.json")));
  const peer = { ...device, name: "Fixture", url: privateOrigin, token: grant.token };
  const config = { product: "Reach", origin: privateOrigin, home: ORIGIN, instance: reach.instance, name: "Fixture", tailnet: null };
  const bundle = (await build({ stdin: { contents: 'export { ownerEnrollment, browserOwnerKeys } from "./src/owner-connection.ts";', resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", globalName: "OwnerFixture", platform: "browser", target: "es2022" })).outputFiles[0].text;
  browser = await launchChrome(t, { binary: chromeBinary, hosts: [hostname], spki: certificate.spki });
  const version = await browser.send("Browser.getVersion");
  for (const name of ["local-network-access", "local-network", "loopback-network"]) {
    try { await browser.send("Browser.setPermission", { permission: { name }, setting: "granted", origin: ORIGIN }); }
    catch (error) { if (!/Invalid PermissionDescriptor|Unknown permission|Unrecognized permission/i.test(error.message)) throw error; }
  }
  const tab = await openTab(browser);
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
  const joined = await call(`async function (peer, config) {
    const setup = () => OwnerFixture.ownerEnrollment(peer, "browser", config);
    const [first, second] = await Promise.all([setup().join(new AbortController().signal), setup().join(new AbortController().signal)]);
    const pair = await OwnerFixture.browserOwnerKeys.pair(peer.computerId || peer.id);
    return { first, second, extractable: pair.privateKey.extractable, saved: JSON.parse(localStorage.getItem("reach.devices")) };
  }`, peer, config).catch(error => { t.diagnostic(JSON.stringify({ seen, problems: tab.problems })); throw error; });
  assert.equal(joined.first.token, joined.second.token);
  assert.equal(joined.extractable, false);
  assert.equal(joined.saved[0].token, joined.first.token);
  assert.notEqual(joined.first.token, grant.token);
  sourceUnavailable = true;
  const sourceRequests = seen.filter(r => r.path === '/api/device/owner-connection').length;
  await tab.navigate(`${ORIGIN}/`); await tab.evaluate(bundle);
  const restored = await call(`async function (peer, config) {
    return OwnerFixture.ownerEnrollment(peer, "browser", config).join(new AbortController().signal);
  }`, peer, config);
  assert.equal(restored.token, joined.first.token, "IndexedDB key and proposed credential survive reload");
  assert.equal(seen.filter(r => r.path === '/api/device/owner-connection').length, sourceRequests, 'persisted proof resumes without the original route');
  await assert.rejects(tab.evaluate(`OwnerFixture.ownerEnrollment(${JSON.stringify({ ...peer, token: 'DIFFERENT-GRANT' })}, "browser", ${JSON.stringify(config)}).prepare(new AbortController().signal, false)`), /not been prepared/);
  assert.equal(reach.auth.list().length, 2);
  assert.ok(seen.some(r => r.method === "OPTIONS" && r.site === "same-site"));
  assert.ok(seen.filter(r => r.path.startsWith("/api/auth/owner-connection/")).every(r => !r.bearer));
  assert.equal(await tab.evaluate("location.origin"), ORIGIN);
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
    real: "Chrome, IndexedDB, WebCrypto, TLS, cross-port CORS, keyed ingress, owner authentication", simulated: "Tailscale identities, DNS, source browser transport, loopback network permission" }));
});
