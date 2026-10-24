import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";

import express from "express";
import { build } from "esbuild";
import { serveBuild, setStartInfo } from "../server/delivery.mjs";
import { createReach } from "../server/index.mjs";
import { publicStartHandler, PUBLIC_CSP } from "../server/public-start.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { launchChrome, findChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";
const source = new URL("../", import.meta.url);
const chromeBinary = findChrome();

test("actual browser watcher bootstraps only its existing approval through real fixed metadata and the public asset door", { skip: !process.env.CI && !chromeBinary && "Chrome/Chromium is not installed", timeout: 45000 }, async t => {
  assert.ok(chromeBinary, "Chrome/Chromium is required for the CI private-bootstrap contract");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-bootstrap-chrome-")));
  const dist = path.join(root, "dist"), tailnet = path.join(root, "tailnet");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true }); fs.mkdirSync(tailnet);
  const host = "computer.bootstrap.ts.net", servers = [], calls = [], upgrades = [];
  let reach, browser, tab, frontOrigin, privateOrigin, nativeMode = "native", ingressPort, ingressKey;
  let appToken, browserToken, browserStatus = 200, cors = true;
  const device = { id: "fixture-computer", computerId: "same-computer", name: "Disposable bootstrap", platform: process.platform,
    access: { kind: "device", scopes: ["admin", "files"], expiresAt: Date.now() + 60000 } };
  const browserDevice = structuredClone(device);
  const tokenKind = value => value === `Bearer ${appToken}` ? "native-approved" : value === `Bearer ${browserToken}` ? "browser-approved" : value ? "other" : "none";
  const receipt = { hostPlatform: process.platform, arch: process.arch, node: process.version,
    actual: "Real Chrome HTTPS, production private metadata/client delivery, instantiation of a minimal fixture WASM module, production closed public door/cookie admission, cross-port CORS and watchPrivateRecovery itself.",
    controlled: "Tailscale ingress/process identity, approved device records and node packet delivery; the fixture runtime never enrolls, starts a live Tailscale session or receives an auth key.",
    productionTailnetRuntime: false, physicalDevice: false, customerCause: "unproven", cases: [] };
  t.after(async () => {
    const errors = [];
    for (const close of [
      async () => { try { await tab?.evaluate("globalThis.stopWatch?.()"); } catch {} },
      () => browser?.close(),
      ...servers.map(server => async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }),
      () => reach?.close(),
      () => { setStartInfo(null); fs.rmSync(root, { recursive: true, force: true }); },
    ]) { try { await close(); } catch (error) { errors.push(error); } }
    receipt.calls = calls; receipt.upgrades = upgrades;
    t.diagnostic(JSON.stringify(receipt));
    if (errors.length) throw new AggregateError(errors, "Disposable bootstrap cleanup failed");
  });
  const certificate = await testCertificate(root, host);
  const listen = async server => {
    servers.push(server); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `https://${host}:${server.address().port}`;
  };
  const json = (res, value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  privateOrigin = await listen(https.createServer(certificate, (req, res) => {
    const item = { route: "controlled-browser-private", path: req.url, method: req.method, credential: tokenKind(req.headers.authorization), cors };
    calls.push(item); res.once("finish", () => { item.status = res.statusCode; });
    if (cors) {
      res.setHeader("Access-Control-Allow-Origin", frontOrigin); res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.url === "/api/health") return json(res, { product: "Reach", instance: "runtime" });
    if (req.url !== "/api/device" || req.headers.authorization !== `Bearer ${browserToken}`) return json(res, { error: "Not this approved browser" }, 403);
    json(res, browserDevice, browserStatus);
  }));
  const app = express();
  app.use((req, res, next) => { res.setHeader("Content-Security-Policy", PUBLIC_CSP); next(); });
  app.get("/api/health", (_req, res) => json(res, { product: "Reach", instance: "runtime" }));
  app.get("/api/device", (req, res) => json(res, req.headers.authorization === `Bearer ${appToken}` ? device : { error: "Not this approved native device" }, req.headers.authorization === `Bearer ${appToken}` ? 200 : 403));
  serveBuild(app, express, dist, { tailnetDir: tailnet });
  const relay = (req, res) => {
    const forwarded = http.request({ host: "127.0.0.1", port: ingressPort, path: `/r-${ingressKey}${req.url}`, method: req.method, agent: false,
      headers: { ...req.headers, host: new URL(frontOrigin).host, "X-Forwarded-Host": new URL(frontOrigin).host,
        "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.7" } }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
    forwarded.on("error", error => res.destroy(error)); req.pipe(forwarded);
  };
  const front = https.createServer(certificate, (req, res) => {
    const item = { route: nativeMode, path: req.url, method: req.method, cookiePresent: /(?:^|;\s*)reach-door=/.test(req.headers.cookie || ""), credential: tokenKind(req.headers.authorization) };
    calls.push(item); res.once("finish", () => { item.status = res.statusCode; });
    if (nativeMode === "native") app(req, res); else relay(req, res);
  });
  front.on("upgrade", (req, socket, head) => {
    upgrades.push({ route: nativeMode, path: req.url });
    const upstream = net.connect(ingressPort, "127.0.0.1", () => {
      upstream.write(`GET /r-${ingressKey}${req.url} HTTP/1.1\r\nHost: ${new URL(frontOrigin).host}\r\nX-Forwarded-Host: ${new URL(frontOrigin).host}\r\nTailscale-Funnel-Request: ?1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${req.headers["sec-websocket-key"]}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); upstream.on("close", () => socket.destroy()); socket.on("close", () => upstream.destroy());
  });
  frontOrigin = await listen(front);
  reach = await createReach({ roots: [root], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "no-policy.json"),
    name: device.name, publicOrigin: privateOrigin, tailscaleOwner: { userId: "42", login: "fixture@example.test" },
    tailscaleIdentity: { lookup: async () => null }, sweepScreenHelpers() {} });
  const nativeGrant = reach.auth.issue("Existing native fixture", ["admin", "files"], "device");
  const browserGrant = reach.auth.issue("Existing browser fixture", ["admin", "files"], "device");
  appToken = nativeGrant.token; browserToken = browserGrant.token;
  const door = reach.auth.issueDoorKey(browserGrant.clientId);
  assert.equal(reach.funnelWindow().open, false);
  ingressKey = newIngressKey();
  ingressPort = await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true },
    publicApp: publicStartHandler({ dist, tailnetDir: tailnet, privateOrigin, home: frontOrigin, name: device.name, instance: "runtime" }) });
  // Exactly the launcher's callback: no hand-supplied tailnet field. The real
  // delivery handler must discover and validate the actual fixed client files.
  setStartInfo(() => ({ product: "Reach", origin: privateOrigin, name: device.name, instance: "runtime", since: 1 }));
  const manifest = { wasm: "fixture-client.wasm", exec: "fixture-loader.js" };
  fs.writeFileSync(path.join(tailnet, "tailnet.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(tailnet, manifest.wasm), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  fs.writeFileSync(path.join(tailnet, manifest.exec), `
    globalThis.runtime = { registrations: 0, starts: 0, logins: 0, wakes: 0, hasAuthKey: false, settled: 0, errors: 0 };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    globalThis.reachTailnet = configuration => {
      runtime.registrations++; runtime.hasAuthKey = !!configuration.authKey;
      if (!configuration.stateStorage.getState("_machinekey") || configuration.authKey) throw Error("Only the saved fixture identity can restore");
      return {
        start(cb) { runtime.starts++; cb.state("Running"); },
        status() { return { self: { state: "Running" }, peers: [] }; },
        wake() { runtime.wakes++; }, login() { runtime.logins++; throw Error("No new login is authorized"); }, logout() {},
        websocket() { throw Error("Bootstrap cannot create an action socket"); },
        fetch(request) {
          const abort = new AbortController();
          return { abort: () => abort.abort(), response: fixtureNativeFetch(fixturePrivateOrigin + new URL(request.url).pathname, {
            method: request.method, headers: Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2)),
            body: request.body, credentials: "omit", redirect: request.redirect, signal: abort.signal,
          }).then(async response => {
            const bytes = new Uint8Array(await response.arrayBuffer()); let read = false;
            return { status: response.status, statusText: response.statusText, headers: [...response.headers].flat(), read: async () => read ? null : (read = true, bytes), cancel() {} };
          }).catch(error => { runtime.errors++; throw error; }).finally(() => { runtime.settled++; }) };
        },
      };
    };
  `);
  const bundle = await build({ stdin: { contents: 'export { watchPrivateRecovery } from "./src/app-watch.ts"; export { privateWay, tailnetBrowser } from "./src/tailnet-transport.ts";', resolveDir: fileURLToPath(source) },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "BootstrapFixture", target: "es2022", logLevel: "silent" });
  fs.writeFileSync(path.join(dist, "assets", "bootstrap.js"), bundle.outputFiles[0].text);
  const page = '<!doctype html><link rel="icon" href="data:,"><title>Isolated owner bootstrap</title><script src="/assets/bootstrap.js"></script>';
  fs.writeFileSync(path.join(dist, "index.html"), page); fs.writeFileSync(path.join(dist, "start.html"), page);
  browser = await launchChrome(t, { binary: chromeBinary, hosts: [host], spki: certificate.spki });
  receipt.chrome = (await browser.send("Browser.getVersion")).product;
  tab = await openTab(browser); await tab.send("Network.enable"); await tab.send("Network.setCacheDisabled", { cacheDisabled: true });
  const navigate = async suffix => {
    await tab.send("Page.navigate", { url: frontOrigin + suffix });
    await tab.evaluate(`new Promise((resolve, reject) => { const until = Date.now() + 5000; const poll = () => { if (globalThis.BootstrapFixture) resolve(); else if (Date.now() >= until) reject(Error("Fixture entry did not load")); else setTimeout(poll, 10); }; poll(); })`);
    await tab.evaluate(`(() => { globalThis.fixtureNativeFetch = fetch.bind(window); globalThis.fixtureNativeSocket = WebSocket;
      globalThis.fixturePrivateOrigin = ${JSON.stringify(privateOrigin)}; })()`);
  };
  const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
  const state = { "_current-profile": hex("fixture-profile"), "_machinekey": hex(`privkey:${"1".repeat(64)}`),
    "_profiles": hex({ "fixture-profile": { Key: "fixture-profile", NodeID: "n-fixture" } }),
    "fixture-profile": hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "n-fixture" } }) };
  const peer = token => ({ id: device.id, computerId: device.computerId, name: device.name, url: frontOrigin, token, platform: process.platform });
  const seed = async () => tab.evaluate(`(() => {
    localStorage.setItem("reach.ways", "1");
    localStorage.setItem("reach.devices", ${JSON.stringify(JSON.stringify([peer(appToken)]))});
    localStorage.setItem("reach.browser.devices", ${JSON.stringify(JSON.stringify([peer(browserToken)]))});
    for (const [key, value] of Object.entries(${JSON.stringify(state)})) localStorage.setItem("reach.tailnet:" + key, value);
    document.cookie = ${JSON.stringify(`reach-door=${door.key}; Path=/; Secure; SameSite=Lax`)};
  })()`);
  const start = async fresh => tab.evaluate(`(() => {
    const peer = JSON.parse(localStorage.getItem("reach.devices"))[0], device = ${JSON.stringify(device)};
    globalThis.f = { current: ${fresh ? "null" : "{ peer, device }"}, changes: [], currentReads: 0 };
    globalThis.stopWatch = BootstrapFixture.watchPrivateRecovery({ current: () => { f.currentReads++; return f.current; }, selected: () => peer,
      handoff(change) { f.changes.push(change.mode); f.current = { peer: change.peer, device: change.device }; } });
  })()`);
  const wait = async expression => tab.evaluate(`new Promise((resolve, reject) => { const until = Date.now() + 5000; const poll = () => { if (${expression}) resolve(true); else if (Date.now() >= until) reject(Error("Bounded bootstrap state missing")); else setTimeout(poll, 10); }; poll(); })`);
  const discoverySince = async before => {
    for (const until = Date.now() + 3000; !calls.slice(before).some(call => call.path === "/reach-start.json" && call.status); ) {
      assert.ok(Date.now() < until, "the watcher discovery must cross actual HTTP"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    return calls.slice(before).filter(call => call.path === "/reach-start.json");
  };
  await navigate("/"); await seed();
  await t.test("production private metadata adds the validated actual client manifest", async () => {
    const info = await tab.evaluate('fixtureNativeFetch("/reach-start.json", { cache: "no-store" }).then(response => response.json())');
    assert.deepEqual(info.tailnet, manifest); assert.equal(info.origin, privateOrigin);
    receipt.cases.push({ name: "private metadata", tailnetManifestPresent: true, launcherSuppliedTailnet: false });
  });
  await t.test("watcher prepares actual fixed runtime assets and keeps native preference through both handoffs", async () => {
    await start(false); await wait("globalThis.runtime?.starts === 1");
    assert.deepEqual(await tab.evaluate("({ mode: BootstrapFixture.privateWay(), changes: f.changes, registrations: runtime.registrations, logins: runtime.logins, authKey: runtime.hasAuthKey })"),
      { mode: "native", changes: [], registrations: 1, logins: 0, authKey: false });
    nativeMode = "public-closed"; await tab.evaluate('dispatchEvent(new Event("online"))'); await wait('f.changes.join(",") === "browser"');
    nativeMode = "native"; await tab.evaluate('dispatchEvent(new Event("online"))'); await wait('f.changes.join(",") === "browser,native"');
    assert.equal(calls.some(call => call.route === "controlled-browser-private" && call.method === "OPTIONS"), true, "actual Chrome enforced cross-port preflight");
    assert.equal(calls.some(call => call.path === "/tailnet/" + manifest.wasm && call.status === 200), true);
    assert.equal(calls.some(call => call.path === "/tailnet/" + manifest.exec && call.status === 200), true);
    receipt.cases.push({ name: "native metadata and warm recovery", changes: ["browser", "native"], fixedFixtureAssetsDelivered: true, productionTailnetRuntime: false, enrollment: false });
    await tab.evaluate("stopWatch()");
  });
  nativeMode = "public-closed";
  await navigate("/?cold=1");
  await t.test("valid asset cookie admits cold fixed files but public owner APIs and WebSockets stay closed", async () => {
    const result = await tab.evaluate(`(async () => {
      const metadata = await fixtureNativeFetch("/reach-start.json", { cache: "no-store" });
      const owner = await fixtureNativeFetch("/api/device", { headers: { Authorization: ${JSON.stringify(`Bearer ${browserToken}`)} } });
      const denied = await fixtureNativeFetch("/reach-start.json", { credentials: "omit", cache: "no-store" });
      const ws = await new Promise(resolve => { const socket = new fixtureNativeSocket(location.origin.replace("https:", "wss:") + "/ws/screen"); socket.onopen = () => { socket.close(); resolve("opened"); }; socket.onerror = socket.onclose = () => resolve("refused"); });
      return { metadata: metadata.status, manifest: (await metadata.json()).tailnet, owner: owner.status, noCookie: denied.status, ws };
    })()`);
    assert.deepEqual(result, { metadata: 200, manifest, owner: 404, noCookie: 404, ws: "refused" });
    receipt.cases.push({ name: "closed asset door", ...result });
  });
  await t.test("a cold watcher uses its existing asset cookie and restores only its own approved identity", async () => {
    const before = calls.length;
    await start(true);
    const discovery = await discoverySince(before);
    assert.deepEqual(discovery.map(call => ({ status: call.status, cookiePresent: call.cookiePresent })), [{ status: 200, cookiePresent: true }], "the watcher metadata is fixed same-origin content admitted by its existing asset cookie");
    await wait('f.changes.join(",") === "browser"');
    const result = await tab.evaluate("({ changes: f.changes, mode: BootstrapFixture.privateWay(), registrations: runtime.registrations, logins: runtime.logins, authKey: runtime.hasAuthKey })");
    assert.deepEqual(result, { changes: ["browser"], mode: "browser", registrations: 1, logins: 0, authKey: false });
    receipt.cases.push({ name: "cold watcher metadata", discovery, result });
    await tab.evaluate("stopWatch()");
  });
  for (const refused of ["missing-alternate", "browser-403", "browser-guest", "different-computer", "cors-refused"]) {
    await t.test(`cold asset admission cannot authorize ${refused}`, async () => {
      browserStatus = refused === "browser-403" ? 403 : 200;
      browserDevice.access.kind = refused === "browser-guest" ? "guest" : "device";
      browserDevice.computerId = refused === "different-computer" ? "another-computer" : device.computerId;
      cors = refused !== "cors-refused";
      await navigate("/?refused=" + refused);
      await tab.evaluate(`localStorage.setItem("reach.browser.devices", ${JSON.stringify(JSON.stringify(refused === "missing-alternate" ? [] : [peer(browserToken)]))})`);
      const before = calls.length; await start(true);
      const discovery = await discoverySince(before);
      assert.deepEqual(discovery.map(call => ({ status: call.status, cookiePresent: call.cookiePresent })), [{ status: 200, cookiePresent: true }]);
      await wait(refused === "missing-alternate" ? "f.currentReads >= 2" : refused === "cors-refused" ? "globalThis.runtime?.errors >= 1" : "globalThis.runtime?.settled >= 2");
      const result = await tab.evaluate("({ changes: f.changes, mode: BootstrapFixture.privateWay(), logins: globalThis.runtime?.logins || 0, authKey: globalThis.runtime?.hasAuthKey || false })");
      assert.deepEqual(result, { changes: [], mode: "native", logins: 0, authKey: false });
      if (refused === "missing-alternate") assert.equal(await tab.evaluate("!!globalThis.runtime"), false, "no approved alternate means no node construction");
      if (refused === "cors-refused") {
        assert.ok(calls.slice(before).some(call => call.route === "controlled-browser-private" && call.status === 200 && call.cors === false), "an actual cross-port response reached Chrome without CORS permission");
        assert.equal(calls.slice(before).some(call => call.route === "controlled-browser-private" && call.path === "/api/device" && call.method === "GET"), false, "Chrome must refuse the unusable route before an authenticated device request");
      }
      receipt.cases.push({ name: refused, discovery, result });
      await tab.evaluate("stopWatch()");
    });
  }
  browserStatus = 200; browserDevice.access.kind = "device"; browserDevice.computerId = device.computerId; cors = true;
  await navigate("/?rotated-cookie=1");
  const nextDoor = reach.auth.issueDoorKey(browserGrant.clientId);
  await t.test("a rotated asset cookie cannot reopen discovery or enroll another identity", async () => {
    const before = calls.length; await start(true);
    const discovery = await discoverySince(before);
    assert.deepEqual(discovery.map(call => ({ status: call.status, cookiePresent: call.cookiePresent })), [{ status: 404, cookiePresent: true }]);
    assert.deepEqual(await tab.evaluate("({ changes: f.changes, runtimeStarted: !!globalThis.runtime })"), { changes: [], runtimeStarted: false });
    await tab.evaluate("stopWatch()");
    await tab.navigate(frontOrigin + "/?rotated-cold=1");
    assert.match(await tab.evaluate("document.body.textContent"), /Not found/);
    assert.equal(await tab.evaluate("typeof globalThis.BootstrapFixture"), "undefined", "cold navigation with a rotated asset key cannot execute the owner entry");
    receipt.cases.push({ name: "rotated asset cookie", discovery, coldNavigation: 404 });
  });
  await tab.send("Network.setCookie", { name: "reach-door", value: nextDoor.key, url: frontOrigin, path: "/", secure: true, sameSite: "Lax" });
  await navigate("/?missing-cookie=1");
  await t.test("a missing asset cookie stays closed even when browser approval state remains saved", async () => {
    await tab.evaluate('document.cookie = "reach-door=; Max-Age=0; Path=/; Secure; SameSite=Lax"');
    const before = calls.length; await start(true);
    const discovery = await discoverySince(before);
    assert.deepEqual(discovery.map(call => ({ status: call.status, cookiePresent: call.cookiePresent })), [{ status: 404, cookiePresent: false }]);
    assert.deepEqual(await tab.evaluate("({ changes: f.changes, runtimeStarted: !!globalThis.runtime, hasSavedIdentity: !!localStorage.getItem('reach.tailnet:_machinekey') })"), { changes: [], runtimeStarted: false, hasSavedIdentity: true });
    await tab.evaluate("stopWatch()");
    await tab.navigate(frontOrigin + "/?missing-cold=1");
    assert.match(await tab.evaluate("document.body.textContent"), /Not found/);
    assert.equal(await tab.evaluate("typeof globalThis.BootstrapFixture"), "undefined");
    receipt.cases.push({ name: "missing asset cookie", discovery, coldNavigation: 404 });
  });
  assert.ok(calls.filter(call => call.route === "controlled-browser-private" && call.credential !== "none").every(call => call.credential === "browser-approved"), "native credentials never cross into the browser identity");
});
