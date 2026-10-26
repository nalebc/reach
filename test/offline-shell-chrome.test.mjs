import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { serveBuild, setStartInfo } from "../server/delivery.mjs";
import { PUBLIC_CSP, publicStartHandler } from "../server/public-start.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

const binary = findChrome(), dist = fileURLToPath(new URL("../dist/", import.meta.url));
test("actual built Reach cold-opens its original private origin through a complete public-code cache", {
  skip: !process.env.CI && !binary && "Chrome/Chromium is not installed", timeout: 60000,
}, async t => {
  assert.ok(binary, "actual Chrome is required in CI");
  assert.ok(fs.existsSync(path.join(dist, "offline-shell.json")), "npm run build must prepare the actual production shell first");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-cold-pwa-"))), host = "computer.cold.ts.net";
  const tailnet = path.join(root, "tailnet"); fs.mkdirSync(tailnet);
  fs.writeFileSync(path.join(root, "proof.txt"), "COLD-FILE-BYTES");
  const cert = await testCertificate(root, host), servers = [], calls = [], frontSockets = new Set();
  let browser, tab, reach, front, frontOrigin, browserOrigin, publicOrigin, nativeToken, ingressPort, ingressKey, cors = true;
  const report = { sourceHead: process.env.GITHUB_SHA || "local (see recorded source receipt)",
    buildId: JSON.parse(fs.readFileSync(path.join(dist, "offline-shell.json"), "utf8")).build,
    os: process.platform, arch: process.arch,
    actual: "Production Vite-built React/worker/manifest; Chrome HTTPS/CacheStorage/service-worker/CORS; real Reach device approval and file/API authentication; closed private listener and fresh document with cleared HTTP cache; automatic private handoffs.",
    controlled: "Tailscale account/WhoIs and packet transport use owned loopback gateways; minimal fixture WASM/Go facade and explicit fixture sign-in completion; per-target UA suffix labels document attribution. A scriptless same-origin document seeds the approved native peer before App first boots. Peripheral host features return503; terminal watch/list are inert; only device/auth/files/health and presence reach the real backend.",
    productionTailnetRuntime: false, physicalDevice: false };
  const closeServer = async server => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
  t.after(async () => {
    const errors = [];
    for (const close of [() => browser?.close(), ...servers.map(server => () => closeServer(server)), () => reach?.close(),
      () => { setStartInfo(null); fs.rmSync(root, { recursive: true, force: true }); }]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    report.calls = calls; t.diagnostic(JSON.stringify(report));
    if (errors.length) throw new AggregateError(errors, "Cold PWA fixture cleanup failed");
  });
  const listen = async server => { servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); return `https://${host}:${server.address().port}`; };
  const proxy = (kind, req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const realm = Number(/ ReachColdRealm\/([1-9][0-9]*)$/.exec(req.headers["user-agent"] || "")?.[1]) || null;
    const item = { kind, path: new URL(req.url, "https://fixture").pathname, method: req.method,
      realm, credential: !token ? "none" : token === nativeToken ? "native" : "browser-or-other" }; calls.push(item);
    if (kind !== "public" && !/^\/api\/(?:device(?:[/?]|$)|health(?:[/?]|$)|auth\/|files(?:[/?]|$))/.test(req.url)) { res.writeHead(503); return res.end(); }
    const headers = { ...req.headers, "accept-encoding": "identity", host: new URL(frontOrigin).host, "X-Forwarded-Host": new URL(frontOrigin).host,
      "X-Forwarded-For": kind === "native" ? "100.101.0.1" : kind === "browser" ? "100.101.0.2" : "203.0.113.5" };
    if (kind === "public") headers["Tailscale-Funnel-Request"] = "?1"; else headers["Tailscale-User-Login"] = "owner@example.test";
    const upstream = http.request({ host: "127.0.0.1", port: ingressPort, path: `/r-${ingressKey}${req.url}`, method: req.method, headers, agent: false }, response => {
      item.status = response.statusCode;
      const output = { ...response.headers }; if (kind === "browser" && !cors) delete output["access-control-allow-origin"];
      // This fixture retains the legacy private-port migration UI. Model its
      // older host capability while keeping real device-bound authorization.
      if (req.method === "GET" && req.url === "/api/device" && response.statusCode === 200) {
        const chunks = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const device = JSON.parse(Buffer.concat(chunks)); delete device.ownerConnection;
          delete output["content-length"]; res.writeHead(response.statusCode, output); res.end(JSON.stringify(device));
        });
      } else { res.writeHead(response.statusCode, output); response.pipe(res); }
    });
    upstream.on("error", error => res.destroy(error)); req.pipe(upstream);
  };
  const upgrade = kind => (req, socket, head) => {
    if (kind !== "public" && !req.url.startsWith("/ws/presence")) return socket.destroy();
    const upstream = net.connect(ingressPort, "127.0.0.1", () => {
      const extra = kind === "public" ? "Tailscale-Funnel-Request: ?1\r\n" : `Tailscale-User-Login: owner@example.test\r\nX-Forwarded-For: ${kind === "native" ? "100.101.0.1" : "100.101.0.2"}\r\n`;
      upstream.write(`GET /r-${ingressKey}${req.url} HTTP/1.1\r\nHost: ${new URL(frontOrigin).host}\r\nX-Forwarded-Host: ${new URL(frontOrigin).host}\r\n${extra}Origin: ${frontOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${req.headers["sec-websocket-key"]}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); upstream.on("close", () => socket.destroy()); socket.on("close", () => upstream.destroy());
  };
  const app = express();
  // This exact exported policy is byte-identical to server/index.mjs on a
  // non-loopback Tailscale origin; never relax it for the controlled runtime.
  app.use((req, res, next) => {
    for (const [name, value] of Object.entries({ "Content-Security-Policy": PUBLIC_CSP, "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Strict-Transport-Security": "max-age=31536000" })) res.setHeader(name, value);
    next();
  });
  // Seed the existing native approval before App boots. Loading App without
  // it starts genuine native onboarding, whose request can outlive navigation
  // and contaminate the later browser-CORS refusal check.
  app.get("/fixture-seed", (_req, res) => res.type("html").send("<!doctype html><title>Fixture state preparation</title>"));
  app.use("/api", (req, res) => { req.url = req.originalUrl; proxy("native", req, res); });
  serveBuild(app, express, dist, { tailnetDir: tailnet });
  front = https.createServer(cert, app); front.on("upgrade", upgrade("native"));
  front.on("connection", socket => { frontSockets.add(socket); socket.once("close", () => frontSockets.delete(socket)); });
  frontOrigin = await listen(front); const frontPort = front.address().port;
  const gateway = https.createServer(cert, (req, res) => proxy("browser", req, res)); gateway.on("upgrade", upgrade("browser")); browserOrigin = await listen(gateway);
  const publicServer = https.createServer(cert, (req, res) => proxy("public", req, res)); publicServer.on("upgrade", upgrade("public")); publicOrigin = await listen(publicServer);
  reach = await createReach({ roots: [root], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "no-policy.json"),
    name: "Cold fixture", publicOrigin: frontOrigin, sweepScreenHelpers() {},
    terminalWatch: async () => { throw Error("Native terminal watching is outside this files/auth fixture."); },
    desktopTerminals: { run: async () => ({ sessions: [], providers: [], running: false }) },
    tailscaleOwner: { userId: "42", login: "owner@example.test" },
    tailscaleIdentity: { lookup: async ip => ({ Node: { StableID: ip === "100.101.0.1" ? "native-node" : "browser-node", User: 42, ComputedName: "fixture" }, UserProfile: { ID: 42, LoginName: "owner@example.test" } }) } });
  nativeToken = reach.auth.issue("Native fixture", ALL_SCOPES, "device", { tailscale: { nodeId: "native-node", userId: "42" } }).token;
  ingressKey = newIngressKey(); ingressPort = await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true },
    publicApp: publicStartHandler({ dist, tailnetDir: tailnet, privateOrigin: frontOrigin, name: "Cold fixture", instance: reach.instance }) });
  setStartInfo(() => ({ product: "Reach", origin: frontOrigin, name: "Cold fixture", instance: reach.instance }));
  const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
  const identity = { _machinekey: hex(`privkey:${"1".repeat(64)}`), _profiles: hex({ fixture: { Key: "profile", NodeID: "browser-node" } }),
    "_current-profile": hex("profile"), profile: hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "browser-node" } }) };
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const glue = Buffer.from(`globalThis.runtime = { starts:0,logins:0,registrations:0 };
    globalThis.Go = class { importObject={}; run(){return new Promise(()=>{});} };
    globalThis.reachTailnet = config => { runtime.registrations++;let callbacks,state=config.stateStorage.getState('_machinekey')?'Running':'NeedsLogin';
      runtime.completeSignIn=()=>{for(const [k,v]of Object.entries(fixtureIdentity))config.stateStorage.setState(k,v);state='Running';callbacks.state(state);};
      return {start(cb){runtime.starts++;callbacks=cb;cb.state(state);},status(){return {self:{state},peers:[]};},login(){runtime.logins++;callbacks.authURL('https://login.tailscale.com/a/fixture');},wake(){},logout(){throw Error('No logout authorized');},
      fetch(request){const halt=new AbortController();const u=new URL(request.url);u.host=new URL(fixtureGateway).host;return {abort:()=>halt.abort(),response:fixtureNativeFetch(u.href,{method:request.method,headers:Array.from({length:request.headers.length/2},(_,i)=>request.headers.slice(i*2,i*2+2)),body:request.body,credentials:'omit',redirect:request.redirect,signal:halt.signal}).then(async r=>{const body=new Uint8Array(await r.arrayBuffer());let used=false;return {status:r.status,statusText:r.statusText,headers:[...r.headers].flat(),read:async()=>used?null:(used=true,body),cancel(){}};})};},
      websocket(url,cb){const u=new URL(url);u.host=new URL(fixtureGateway).host;const ws=new fixtureSocket(u.href,cb.protocols);ws.binaryType='arraybuffer';ws.onopen=()=>cb.open(ws.protocol);ws.onmessage=e=>cb.message(typeof e.data==='string'?e.data:new Uint8Array(e.data));ws.onclose=e=>cb.close(e.code,e.reason,e.wasClean);return {send:v=>ws.send(v),close:(c,r)=>ws.close(c,r),buffered:()=>ws.bufferedAmount};}};
    };`);
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  const client = { wasm: `reach-tailnet.${digest(wasm).slice(0, 12)}.wasm`, exec: `wasm_exec.${digest(glue).slice(0, 12)}.js` };
  fs.writeFileSync(path.join(tailnet, client.wasm), wasm); fs.writeFileSync(path.join(tailnet, client.exec), glue); fs.writeFileSync(path.join(tailnet, "tailnet.json"), JSON.stringify(client));
  browser = await launchChrome(t, { binary, hosts: [host], spki: cert.spki });
  const userAgent = (await browser.send("Browser.getVersion")).userAgent; let realm = 0;
  const freshTab = async () => {
    const value = await openTab(browser);
    value.fixtureRealm = ++realm;
    // CDP's structured per-target UA preserves Chrome's UA and labels the
    // request's original document even when its socket outlives target close.
    await value.send("Network.setUserAgentOverride", { userAgent: userAgent + " ReachColdRealm/" + value.fixtureRealm });
    await value.send("Page.addScriptToEvaluateOnNewDocument", { source: `globalThis.fixtureNativeFetch=fetch.bind(globalThis);globalThis.fixtureSocket=WebSocket;
      const savedGateway=localStorage.getItem('reach.fixture.gateway');
      if(savedGateway){const gateway=new URL(savedGateway);if(gateway.protocol!=='https:'||gateway.hostname!==location.hostname||gateway.pathname!=='/'||gateway.username||gateway.password||gateway.search||gateway.hash)throw Error('Invalid owned fixture gateway');globalThis.fixtureGateway=gateway.origin;}` });
    return value;
  };
  // Runtime values cross CDP as structured arguments, never JavaScript source.
  const inPage = async (fn, value) => {
    const global = await tab.send("Runtime.evaluate", { expression: "globalThis", returnByValue: false });
    const objectId = global.result.objectId; assert.ok(objectId);
    try {
      const answer = await tab.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn.toString(),
        arguments: [{ value }], awaitPromise: true, returnByValue: true });
      if (answer.exceptionDetails) throw Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
      return answer.result.value;
    } finally { await tab.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  };
  const replaceTab = async () => {
    const target = await tab.send("Target.getTargetInfo");
    await browser.send("Target.closeTarget", { targetId: target.targetInfo.targetId });
    tab = await freshTab();
    const result = await tab.send("Page.navigate", { url: frontOrigin + "/?page=files" });
    assert.equal(result.errorText, undefined, "the saved private-origin interface opens in a genuinely fresh document");
    return tab.fixtureRealm;
  };
  const wait = async (expression, limit = 8000) => {
    try { return await tab.evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+${limit};const check=()=>${expression}?resolve(true):Date.now()>until?reject(Error('Cold test stage unavailable')):setTimeout(check,20);check();})`); }
    catch (error) { error.message += JSON.stringify({ expression, problems: tab.problems.slice(-8), lastCalls: calls.slice(-8) }); throw error; }
  };
  tab = await freshTab(); await tab.navigate(frontOrigin + "/fixture-seed");
  const nativeAnswer = await inPage(async function (token) {
    const response = await fixtureNativeFetch("/api/device", { headers: { Authorization: "Bearer " + token } });
    return { device: await response.json(), csp: response.headers.get("Content-Security-Policy") };
  }, nativeToken);
  assert.equal(nativeAnswer.csp, PUBLIC_CSP, "the fixture policy is the actual private Reach middleware policy");
  const device = nativeAnswer.device;
  const peer = { id: device.id, computerId: device.computerId, name: device.name, platform: device.platform, url: frontOrigin, token: nativeToken };
  await inPage(function (data) {
    localStorage.setItem("reach.devices", JSON.stringify([data.peer])); localStorage.setItem("reach.active", data.peer.id);
    localStorage.setItem("reach.fixture.gateway", data.gateway);
  }, { peer, gateway: new URL(browserOrigin).origin });
  assert.equal(reach.approvals.list().length, 0, "state preparation cannot start unpaired native onboarding");
  assert.equal(calls.some(call => call.method === "POST" && call.path === "/api/auth/requests"), false,
    "no approval request precedes the first approved App launch");
  await tab.navigate(frontOrigin);
  await wait("document.querySelector('.settings-nav')"); await tab.evaluate("document.querySelector('.settings-nav').click()");
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Set up fallback'))");
  await tab.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Set up fallback')).click()");
  await wait("document.querySelector('a[href^=\"https://login.tailscale.com/\"]')");
  cors = false;
  await inPage(function (value) { globalThis.fixtureIdentity = value; runtime.completeSignIn(); }, identity);
  await wait("document.querySelector('dialog [role=alert]')");
  assert.equal(reach.approvals.list().length, 0, "real cross-port CORS refusal cannot submit a request");
  assert.equal(await tab.evaluate("localStorage.getItem('reach.offline-shell.enabled')"), null);
  await tab.evaluate("[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Close setup').click()"); cors = true;
  await tab.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Set up fallback')).click()");
  await wait("document.querySelector('.approval-code')");
  const request = reach.approvals.list()[0]; assert.equal(request.identity.nodeId, "browser-node");
  reach.approvals.decide(request.id, "approve", "separate disposable fixture owner");
  await wait("document.body.textContent.includes('Fallback is ready.')");
  await wait("localStorage.getItem('reach.offline-shell.enabled')==='v1'||document.body.textContent.includes('approval is kept')", 18000);
  const approved = await tab.evaluate("JSON.parse(localStorage.getItem('reach.browser.devices'))");
  assert.ok(Array.isArray(approved) && approved.length === 1);
  assert.equal(approved[0].id, peer.id); assert.equal(approved[0].computerId, peer.computerId);
  assert.equal(new URL(approved[0].url).origin, frontOrigin);
  assert.equal(typeof approved[0].token, "string"); assert.ok(approved[0].token.length > 0);
  assert.notEqual(approved[0].token, nativeToken);
  const nativeSaved = await tab.evaluate("localStorage.getItem('reach.devices')");
  const ownMachineKey = await tab.evaluate("localStorage.getItem('reach.tailnet:_machinekey')");
  assert.equal(typeof ownMachineKey, "string"); assert.ok(ownMachineKey.length > 0);
  const coldPrepared = await tab.evaluate("localStorage.getItem('reach.offline-shell.enabled')==='v1'"); report.coldPrepared = coldPrepared;
  report.publicUp = publicServer.listening;
  const forbidden = [nativeToken, approved[0].token, identity._machinekey, identity.profile];
  const foundSecret = await inPage(async function (secrets) {
    for (const name of await caches.keys()) {
      if (!name.startsWith("reach-static-")) continue;
      const cache = await caches.open(name);
      for (const key of await cache.keys()) {
        const body = await (await cache.match(key)).text();
        if (secrets.some(secret => body.includes(secret))) return true;
      }
    }
    return false;
  }, forbidden);
  assert.equal(foundSecret, false, "no approval, token or persisted identity enters the code cache");
  await tab.send("Network.enable"); await tab.send("Network.clearBrowserCache");
  const target = await tab.send("Target.getTargetInfo"); await browser.send("Target.closeTarget", { targetId: target.targetInfo.targetId });
  for (const socket of frontSockets) socket.destroy(); await closeServer(front);
  tab = await freshTab(); const navigation = await tab.send("Page.navigate", { url: frontOrigin + "/?page=files" });
  report.coldNavigationError = navigation.errorText || null;
  assert.equal(navigation.errorText, undefined, "the original private-origin bookmark must cold-open after its listener closes");
  await wait("document.querySelector('#root')?.childElementCount&&document.documentElement.dataset.connection==='browser'", 12000);
  assert.equal(coldPrepared, true, "cold readiness requires the complete committed cohort");
  await wait("document.body.textContent.includes('proof.txt')");
  assert.ok(calls.some(call => call.realm === tab.fixtureRealm && call.kind === "browser" && call.path === "/api/files" &&
    call.method === "GET" && call.credential === "browser-or-other" && call.status === 200),
    "a real authenticated file read positively verifies fresh-document wire attribution");
  const canary = `https://127.0.0.1:${publicServer.address().port}/csp-probe`;
  const probe = options => new Promise((resolve, reject) => {
    const request = https.get(canary, { ...options, agent: false }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
  });
  await assert.rejects(probe({ servername: host }), error => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  await assert.rejects(probe({ ca: cert.cert, servername: "other.cold.ts.net" }), error => error.code === "ERR_TLS_CERT_ALTNAME_INVALID");
  const reachable = await probe({ ca: cert.cert, servername: host });
  assert.equal(reachable, 404, "the prohibited destination is an actually reachable owned HTTPS listener");
  assert.ok(calls.some(call => call.realm === null && call.kind === "public" && call.path === "/csp-probe" && call.status === 404),
    "unmarked Node probe traffic is retained alongside attributed browser requests");
  report.tlsValidation = { untrustedCaBlocked: true, wrongHostnameBlocked: true, ownedCaMatched: true };
  const beforeCanary = calls.filter(call => call.path === "/csp-probe").length;
  await tab.evaluate("globalThis.policyViolations=[];addEventListener('securitypolicyviolation',e=>policyViolations.push(e.effectiveDirective))");
  assert.equal(await inPage(function (url) { return fixtureNativeFetch(url, { mode: "no-cors" }).then(() => false, () => true); }, canary), true,
    "the cached private page retains enforced connect-src restrictions");
  await wait("policyViolations.includes('connect-src')");
  assert.equal(calls.filter(call => call.path === "/csp-probe").length, beforeCanary, "CSP blocks before the wire");
  assert.equal(await tab.evaluate("localStorage.getItem('reach.devices')") === nativeSaved, true,
    "cold browser recovery preserves the authenticated native record byte-for-byte");
  assert.equal(await tab.evaluate("runtime.logins"), 0, "cold recovery never enrolls or signs in a new device");
  await tab.evaluate("localStorage.removeItem('reach.browser.devices')"); const missingApprovalRealm = await replaceTab();
  await wait("document.querySelector('#root')?.childElementCount");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await tab.evaluate("document.documentElement.dataset.connection==='browser'"), false);
  assert.equal(calls.some(call => call.realm === missingApprovalRealm && call.kind === "browser" && call.credential === "browser-or-other"), false);
  await inPage(function (peers) {
    localStorage.setItem("reach.browser.devices", JSON.stringify(peers)); localStorage.removeItem("reach.tailnet:_machinekey");
  }, approved);
  const missingIdentityRealm = await replaceTab(); await wait("document.querySelector('#root')?.childElementCount");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await tab.evaluate("document.documentElement.dataset.connection==='browser'"), false);
  assert.equal(await tab.evaluate("typeof runtime==='undefined'"), true, "missing saved identity cannot construct, sign in or substitute a recovery device");
  assert.equal(calls.some(call => call.realm === missingIdentityRealm && call.kind === "browser" && call.credential !== "none"), false,
    "the retained approval never travels through a missing/replacement browser identity");
  assert.equal(calls.some(call => call.realm === missingIdentityRealm && call.path === "/api/auth/requests" && call.method === "POST"), false);
  assert.equal(await tab.evaluate("localStorage.getItem('reach.devices')") === nativeSaved, true);
  await inPage(function (key) { localStorage.setItem("reach.tailnet:_machinekey", key); }, ownMachineKey); await replaceTab();
  // A newly committed cold document may not have its root element yet.
  // Readiness requires its mounted interface and actual selected route.
  await wait("document.querySelector('#root')?.childElementCount&&document.documentElement.dataset.connection==='browser'");
  await new Promise(resolve => front.listen(frontPort, "127.0.0.1", resolve));
  await tab.evaluate("dispatchEvent(new Event('online'))");
  await wait("document.querySelector('#root')?.childElementCount&&document.documentElement.dataset.connection!=='browser'");
  const denied = await inPage(function (data) {
    return fixtureNativeFetch(data.url, { headers: { Authorization: "Bearer " + data.token } }).then(() => false, () => true);
  }, { url: new URL("/api/device", publicOrigin).href, token: nativeToken });
  assert.equal(denied, true, "the browser cannot read owner APIs from the public door");
  assert.ok(calls.some(call => call.kind === "public" && call.path === "/api/device" && call.method === "OPTIONS" && call.status === 404));
  const publicSocket = new URL("/ws/presence", publicOrigin); publicSocket.protocol = "wss:";
  assert.equal(await inPage(function (url) {
    return new Promise(resolve => {
      const ws = new fixtureSocket(url); ws.onopen = () => { ws.close(); resolve(true); }; ws.onerror = () => resolve(false);
      setTimeout(() => { ws.close(); resolve(false); }, 1500);
    });
  }, publicSocket.href), false);
  assert.equal(calls.filter(call => call.path === "/api/auth/requests" && call.method === "POST").length, 1, "cold/retry/handoffs never replay approval creation");
  assert.ok(calls.filter(call => call.kind === "browser").every(call => call.credential !== "native"));
  assert.ok(calls.filter(call => call.kind === "browser" && call.credential !== "none").every(call => Number.isSafeInteger(call.realm) && call.realm > 0),
    "all credential-bearing browser requests have positively tracked document attribution");
  assert.equal(fs.readdirSync(path.join(root, "state")).some(name => /^reach-windows-terminals-.*\.exe$/.test(name)), false,
    "the files/auth-only fixture never builds a native terminal helper");
  report.coldRestored = true; report.missingApprovalBlocked = true; report.missingIdentityBlocked = true;
  report.returnedToNative = true; report.noSecretsCached = true; report.ownApprovalCreates = 1;
  report.cachedPrivateCspEnforced = true;
});
