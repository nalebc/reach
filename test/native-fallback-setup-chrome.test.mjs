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
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { serveBuild, setStartInfo } from "../server/delivery.mjs";
import { publicStartHandler } from "../server/public-start.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

const chromeBinary = findChrome(), source = new URL("../", import.meta.url);
test("actual Chrome sets up its own fallback approval without changing the native workspace", {
  skip: !process.env.CI && !chromeBinary && "Chrome/Chromium is not installed", timeout: 45000,
}, async t => {
  assert.ok(chromeBinary, "Chrome is required in CI for fallback setup boundaries");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-fallback-setup-")));
  const dist = path.join(root, "dist"), tailnet = path.join(root, "tailnet"), host = "computer.fallback.ts.net";
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true }); fs.mkdirSync(tailnet);
  const servers = [], calls = [], receipt = { host: process.platform, arch: process.arch,
    actual: "Chrome HTTPS/CORS, Settings component, production metadata/fixed delivery, actual device-request/approval store, device-bound authentication, recovery watcher, closed public door/API/WS.",
    controlled: "Tailscale WhoIs/process identity and browser-node packet delivery over owned loopback HTTPS. Sign-in completion is controlled and stores fixture identity through the real captured provider.",
    productionTailnetRuntime: false, physicalDevice: false, coldPrivateBookmark: "not tested; warm loaded session only", cases: [] };
  let browser, tab, reach, frontOrigin, privateOrigin, publicOrigin, ingressPort, ingressKey, nativeToken, nativeOn = true, cors = true;
  t.after(async () => {
    const errors = [];
    for (const close of [
      async () => { try { await tab?.evaluate("globalThis.stopFixture?.()"); } catch {} },
      () => browser?.close(),
      ...servers.map(server => async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }),
      () => reach?.close(),
      () => { setStartInfo(null); fs.rmSync(root, { recursive: true, force: true }); },
    ]) { try { await close(); } catch (error) { errors.push(error); } }
    receipt.calls = calls; t.diagnostic(JSON.stringify(receipt));
    if (errors.length) throw new AggregateError(errors, "Fallback setup fixture cleanup failed");
  });
  const cert = await testCertificate(root, host);
  const listen = async server => {
    servers.push(server); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `https://${host}:${server.address().port}`;
  };
  const proxy = (kind, req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const item = { route: kind, path: req.url, method: req.method,
      credential: !token ? "none" : token === nativeToken ? "native" : "browser-or-other" };
    calls.push(item);
    const headers = { ...req.headers, host: new URL(frontOrigin).host, "X-Forwarded-Host": new URL(frontOrigin).host,
      "X-Forwarded-For": kind === "native" ? "100.101.0.1" : kind === "browser" ? "100.101.0.2" : "203.0.113.5" };
    if (kind === "public") headers["Tailscale-Funnel-Request"] = "?1";
    else headers["Tailscale-User-Login"] = "owner@example.test";
    const upstream = http.request({ host: "127.0.0.1", port: ingressPort, path: `/r-${ingressKey}${req.url}`, method: req.method, headers, agent: false }, answer => {
      item.status = answer.statusCode;
      const output = { ...answer.headers };
      if (kind === "browser" && !cors) delete output["access-control-allow-origin"];
      res.writeHead(answer.statusCode, output); answer.pipe(res);
    });
    upstream.on("error", error => res.destroy(error)); req.pipe(upstream);
  };
  privateOrigin = await listen(https.createServer(cert, (req, res) => proxy("browser", req, res)));
  const app = express();
  app.use("/api", (req, res) => {
    req.url = req.originalUrl;
    if (!nativeOn) { calls.push({ route: "native-off", path: req.url, method: req.method }); return res.destroy(); }
    proxy("native", req, res);
  });
  serveBuild(app, express, dist, { tailnetDir: tailnet });
  frontOrigin = await listen(https.createServer(cert, app));
  const publicServer = https.createServer(cert, (req, res) => proxy("public", req, res));
  publicServer.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(ingressPort, "127.0.0.1", () => {
      upstream.write(`GET /r-${ingressKey}${req.url} HTTP/1.1\r\nHost: ${new URL(frontOrigin).host}\r\nX-Forwarded-Host: ${new URL(frontOrigin).host}\r\nTailscale-Funnel-Request: ?1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${req.headers["sec-websocket-key"]}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); upstream.on("close", () => socket.destroy()); socket.on("close", () => upstream.destroy());
  });
  publicOrigin = await listen(publicServer);
  reach = await createReach({ roots: [root], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "absent-policy.json"),
    name: "Disposable fallback", publicOrigin: frontOrigin, tailscaleOwner: { userId: "42", login: "owner@example.test" },
    tailscaleIdentity: { lookup: async ip => ({ Node: { StableID: ip === "100.101.0.1" ? "native-node" : "browser-node", User: 42, ComputedName: ip === "100.101.0.1" ? "native-phone" : "iphone-browser" }, UserProfile: { ID: 42, LoginName: "owner@example.test" } }) }, sweepScreenHelpers() {} });
  nativeToken = reach.auth.issue("Existing native", ALL_SCOPES, "device", { tailscale: { nodeId: "native-node", userId: "42" } }).token;
  ingressKey = newIngressKey();
  ingressPort = await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true },
    publicApp: publicStartHandler({ dist, tailnetDir: tailnet, privateOrigin: frontOrigin, home: publicOrigin, name: "Disposable fallback", instance: reach.instance }) });
  setStartInfo(() => ({ product: "Reach", origin: frontOrigin, home: publicOrigin, name: "Disposable fallback", instance: reach.instance }));
  const manifest = { wasm: "fixture.wasm", exec: "fixture.js" };
  fs.writeFileSync(path.join(tailnet, "tailnet.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(tailnet, manifest.wasm), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
  const state = { _machinekey: hex(`privkey:${"1".repeat(64)}`), _profiles: hex({ fixture: { Key: "profile", NodeID: "browser-node" } }),
    "_current-profile": hex("profile"), profile: hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "browser-node" } }) };
  fs.writeFileSync(path.join(tailnet, manifest.exec), `
    globalThis.runtime = { registrations: 0, starts: 0, logins: 0, hasAuthKey: false };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    globalThis.reachTailnet = configuration => {
      runtime.registrations++; runtime.hasAuthKey = !!configuration.authKey; let callbacks, state = "NeedsLogin";
      runtime.completeSignIn = () => { for (const [key, value] of Object.entries(${JSON.stringify(state)})) configuration.stateStorage.setState(key, value); state = "Running"; callbacks.state(state); };
      return { start(cb) { runtime.starts++; callbacks = cb; cb.state(state); },
        status() { return { self: { state }, peers: [] }; }, login() { runtime.logins++; callbacks.authURL("https://login.tailscale.com/a/fixture"); },
        wake() {}, logout() { throw Error("No logout authorized"); }, websocket() { throw Error("No action sockets authorized"); },
        fetch(request) { const abort = new AbortController(); return { abort: () => abort.abort(),
          response: fixtureNativeFetch(${JSON.stringify(privateOrigin)} + new URL(request.url).pathname, { method: request.method,
            headers: Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2)),
            body: request.body, credentials: "omit", redirect: request.redirect, signal: abort.signal }).then(async response => {
              const body = new Uint8Array(await response.arrayBuffer()); let read = false;
              return { status: response.status, statusText: response.statusText, headers: [...response.headers].flat(), read: async () => read ? null : (read = true, body), cancel() {} };
            }) }; }
      };
    };
  `);
  await build({ stdin: { contents: `
    import React from "react"; import { createRoot } from "react-dom/client";
    import FallbackSetup from "./src/FallbackSetup";
    import { watchPrivateRecovery } from "./src/app-watch";
    import { privateWay } from "./src/tailnet-transport";
    globalThis.fixtureNativeFetch = fetch.bind(globalThis); globalThis.fixtureSocket = WebSocket;
    globalThis.startFixture = async () => {
      localStorage.clear();
      const device = await fixtureNativeFetch("/api/device", { headers: { Authorization: "Bearer ${nativeToken}" } }).then(response => response.json());
      const peer = { id: device.id, computerId: device.computerId, name: device.name, platform: device.platform, url: location.origin, token: ${JSON.stringify(nativeToken)} };
      localStorage.setItem("reach.devices", JSON.stringify([peer])); localStorage.setItem("reach.active", peer.id);
      globalThis.fixture = { current: { peer, device }, changes: [], nativeBytes: localStorage.getItem("reach.devices"), way: privateWay, address: location.href };
      const root = createRoot(document.getElementById("settings")); root.render(React.createElement(FallbackSetup, { peer, device }));
      const stop = watchPrivateRecovery({ current: () => fixture.current, selected: () => fixture.current.peer,
        handoff(change) { fixture.changes.push(change.mode); fixture.current = { peer: change.peer, device: change.device }; } });
      globalThis.stopFixture = () => { stop(); root.unmount(); };
    };
  `, resolveDir: fileURLToPath(source), sourcefile: "fallback-browser-fixture.tsx", loader: "tsx" },
    bundle: true, format: "iife", platform: "browser", outfile: path.join(dist, "assets/setup-fixture.js") });
  fs.writeFileSync(path.join(dist, "index.html"), '<!doctype html><textarea id="work">Unsent work stays here</textarea><div id="settings"></div><script src="/assets/setup-fixture.js"></script>');
  browser = await launchChrome(t, { binary: chromeBinary, hosts: [host], spki: cert.spki });
  receipt.chrome = (await browser.send("Browser.getVersion")).product;
  const wait = async expression => tab.evaluate(`new Promise((resolve, reject) => { const until = Date.now() + 5000; const check = () => ${expression} ? resolve(true) : Date.now() > until ? reject(Error("Fallback state missing")) : setTimeout(check, 10); check(); })`);
  const open = async () => {
    tab ||= await openTab(browser);
    await tab.navigate(frontOrigin + "?case=" + calls.length); await wait("typeof startFixture === 'function'");
    await tab.evaluate("startFixture()"); await wait("document.querySelector('#settings button')");
    await tab.evaluate("document.querySelector('#settings button').click()");
    await wait("document.querySelector('a[href^=\"https://login.tailscale.com/\"]')");
  };
  await t.test("real cross-port CORS refusal cannot submit or approve a connection", async () => {
    cors = false; await open(); await tab.evaluate("runtime.completeSignIn()");
    await wait("document.querySelector('[role=alert]')");
    assert.equal(reach.approvals.list().length, 0);
    assert.equal(await tab.evaluate("localStorage.getItem('reach.browser.devices')"), null);
    assert.equal(calls.some(call => call.route === "browser" && call.path === "/api/auth/requests"), false);
    receipt.cases.push({ name: "CORS denied", submitted: false, approved: false });
    await tab.evaluate("stopFixture()"); await tab.navigate("about:blank"); cors = true;
  });
  await t.test("an explicit separate approval preserves the native workspace and enables both warm handoffs", async () => {
    await open();
    assert.equal(reach.approvals.list().length, 0, "sign-in is not Reach approval");
    await tab.evaluate("globalThis.work = document.getElementById('work'); runtime.completeSignIn()");
    await wait("document.querySelector('.approval-code')");
    const code = await tab.evaluate("document.querySelector('.approval-code').textContent");
    const requests = reach.approvals.list();
    assert.equal(requests.length, 1); assert.equal(requests[0].identity.nodeId, "browser-node");
    assert.equal(code, requests[0].id.slice(0, 8));
    assert.equal(await tab.evaluate("localStorage.getItem('reach.browser.devices')"), null);
    // External fixture owner action, never an endpoint called by setup.
    reach.approvals.decide(requests[0].id, "approve", "disposable fixture owner");
    await wait("document.body.textContent.includes('Fallback is ready.')");
    assert.deepEqual(await tab.evaluate("({native:localStorage.getItem('reach.devices')===fixture.nativeBytes, way:fixture.way(), work:work===document.getElementById('work')&&work.value==='Unsent work stays here', address:location.href===fixture.address, starts:runtime.starts, registrations:runtime.registrations, logins:runtime.logins, authKey:runtime.hasAuthKey})"),
      { native: true, way: "native", work: true, address: true, starts: 1, registrations: 1, logins: 1, authKey: false });
    const tokens = await tab.evaluate("({native:fixture.current.peer.token,browser:JSON.parse(localStorage.getItem('reach.browser.devices'))[0].token})");
    assert.notEqual(tokens.native, tokens.browser);
    nativeOn = false; await tab.evaluate("dispatchEvent(new Event('online'))");
    await wait("fixture.changes.join(',')==='browser'");
    nativeOn = true; await tab.evaluate("dispatchEvent(new Event('online'))");
    await wait("fixture.changes.join(',')==='browser,native'");
    assert.equal(await tab.evaluate("work===document.getElementById('work') && work.value==='Unsent work stays here'"), true);
    assert.equal(calls.filter(call => call.path === "/api/auth/requests" && call.method === "POST").length, 1, "create is never replayed during setup/handoffs");
    assert.ok(calls.filter(call => call.route === "browser").every(call => call.credential !== "native"));
    assert.ok(calls.filter(call => call.route === "native").every(call => call.credential !== "browser-or-other"));
    receipt.cases.push({ name: "explicit own approval", changes: ["browser", "native"], oneNode: true, nativeWorkPreserved: true, actionReplay: false });
    const publicStatus = await tab.evaluate(`fixtureNativeFetch(${JSON.stringify(publicOrigin + "/api/device")}, {headers:{Authorization:'Bearer '+JSON.parse(localStorage.getItem('reach.browser.devices'))[0].token}}).then(response=>({status:response.status}),()=>({browserRead:false}))`);
    assert.deepEqual(publicStatus, { browserRead: false }, "closed public CORS does not admit the owner credential");
    assert.ok(calls.some(call => call.route === "public" && call.path === "/api/device" && call.status === 404), "the public door refuses the actual owner-API preflight on the wire");
    const ws = await tab.evaluate(`new Promise(resolve=>{const ws=new fixtureSocket(${JSON.stringify(publicOrigin.replace("https:", "wss:") + "/ws/presence")}); let opened=false; ws.onopen=()=>{opened=true;ws.close()};ws.onclose=()=>resolve(opened);setTimeout(()=>{ws.close();resolve(opened)},1500)})`);
    assert.equal(ws, false);
    receipt.cases.push({ name: "public owner boundaries", apiPreflightWire: 404, browserApiRead: false, webSocketOpened: false });
  });
});
