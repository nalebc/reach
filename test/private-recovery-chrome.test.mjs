import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createPublicStart } from "../server/public-start.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

const chromeBinary = findChrome();
test("real Chrome owner recovery crosses a public start 404 using only its separately approved browser device", {
  skip: !process.env.CI && !chromeBinary && "Chrome/Chromium is not installed", timeout: 30000,
}, async t => {
  assert.ok(chromeBinary, "Chrome/Chromium is required for the CI owner-recovery contract");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-owner-recovery-chrome-"));
  const host = "computer.fixture.ts.net", servers = [], calls = [], held = [];
  let browser, publicOrigin, privateOrigin, nativeMode = "private", healthStatus = 200;
  let nativeDeviceStatus = 200;
  let browserStatus = 200, cors = true;
  let holdBrowserDevice = false, releaseBrowserDevice;
  const device = { id: "computer", computerId: "same-computer", name: "Disposable host", platform: "darwin",
    access: { kind: "device", scopes: ["admin", "files"], expiresAt: Date.now() + 60000 } };
  const browserDevice = structuredClone(device);
  t.after(async () => {
    const errors = [];
    for (const cleanup of [
      () => held.splice(0).forEach(release => release()),
      () => browser?.close(),
      ...servers.map(server => async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      }),
      () => fs.rmSync(root, { recursive: true, force: true }),
    ]) { try { await cleanup(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Disposable owner-recovery cleanup failed");
  });
  const certificate = await testCertificate(root, host);
  const json = (res, value, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const listen = async server => {
    servers.push(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `https://${host}:${server.address().port}`;
  };
  privateOrigin = await listen(https.createServer(certificate, (req, res) => {
    calls.push({ route: "browser-private", path: req.url, method: req.method, token: req.headers.authorization || "" });
    if (cors) {
      res.setHeader("Access-Control-Allow-Origin", publicOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.url === "/api/health") return json(res, { product: "Reach", instance: "runtime" });
    if (req.headers.authorization !== "Bearer BROWSER") return json(res, { error: "Wrong device credential" }, 403);
    if (holdBrowserDevice && req.url === "/api/device") {
      holdBrowserDevice = false;
      releaseBrowserDevice = () => json(res, browserDevice, browserStatus);
      held.push(releaseBrowserDevice);
      return;
    }
    return json(res, browserDevice, browserStatus);
  }));
  fs.mkdirSync(path.join(root, "assets"));
  const bundle = await build({
    stdin: { contents: 'export { createPrivateRecovery } from "./src/app-watch.ts"; export { installTailnet, bindPrivatePeer, privateWay, tailnetFetch } from "./src/tailnet-transport.ts";', resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "RecoveryFixture", target: "es2022", logLevel: "silent",
  });
  fs.writeFileSync(path.join(root, "assets", "fixture.js"), bundle.outputFiles[0].text);
  fs.writeFileSync(path.join(root, "start.html"), '<!doctype html><link rel="icon" href="data:,"><title>Owner recovery fixture</title><script src="/assets/fixture.js"></script>');
  const publicStart = createPublicStart({ dist: root, privateOrigin, name: device.name, instance: "runtime" });
  const publicRequest = publicStart.listeners("request")[0], publicUpgrade = publicStart.listeners("upgrade")[0];
  const front = https.createServer(certificate, (req, res) => {
    calls.push({ route: nativeMode, path: req.url, method: req.method, token: req.headers.authorization || "" });
    // A closed production public door also returns a bare 404 before its
    // start handler. This wire response is modeled here, not an auth bypass.
    if (nativeMode === "closed") { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found."); }
    if (nativeMode === "private" && req.url === "/api/health") return json(res, { product: "Reach", instance: "runtime" }, healthStatus);
    if (nativeMode === "private" && req.url.startsWith("/api/")) {
      if (req.headers.authorization !== "Bearer APP") return json(res, { error: "Wrong native device credential" }, 403);
      if (req.url === "/api/held") { held.push(() => json(res, { original: true })); return; }
      if (req.url === "/api/action" && req.method === "POST") {
        req.on("end", () => {
          // A partial response makes delivery known to the HTTP stack while
          // leaving the application result unknown. Closing before any bytes
          // arrive can make Chrome itself retry a reused HTTP connection.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write('{"accepted":');
          setTimeout(() => res.destroy(), 5);
        });
        req.resume();
        return;
      }
      return json(res, device, nativeDeviceStatus);
    }
    publicRequest(req, res);
  });
  front.on("upgrade", (req, socket, head) => publicUpgrade(req, socket, head));
  publicOrigin = await listen(front);
  browser = await launchChrome(t, { binary: chromeBinary, hosts: [host], spki: certificate.spki });
  const tab = await openTab(browser);
  await tab.send("Page.navigate", { url: publicOrigin });
  await tab.evaluate(`new Promise(resolve => {
    const ready = () => globalThis.RecoveryFixture ? resolve(true) : setTimeout(ready, 5);
    ready();
  })`);
  await tab.evaluate(`(() => {
    const direct = fetch.bind(window), NativeSocket = WebSocket;
    const origin = location.origin, privateOrigin = ${JSON.stringify(privateOrigin)};
    const device = ${JSON.stringify(device)};
    const peer = token => ({ id: device.id, computerId: device.computerId, name: device.name, url: origin, token, platform: "darwin" });
    const node = {
      fetch(request) {
        const controller = new AbortController();
        return { abort: () => controller.abort(), response: direct(privateOrigin + new URL(request.url).pathname, {
          method: request.method, headers: Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2)),
          body: request.body, credentials: "omit", redirect: request.redirect, signal: controller.signal,
        }).then(async response => {
          const bytes = new Uint8Array(await response.arrayBuffer()); let read = false;
          return { status: response.status, statusText: response.statusText, headers: [...response.headers].flat(),
            read: async () => read ? null : (read = true, bytes), cancel() {} };
        }) };
      },
      websocket() { throw Error("Recovery must not send actions or open a replacement action socket"); },
    };
    globalThis.makeRecovery = (options = {}) => {
      globalThis.f?.recovery.stop();
      RecoveryFixture.installTailnet(node, "fixture.ts.net", "native");
      const currentDevice = structuredClone(device);
      if (options.guest) currentDevice.access.kind = "guest";
      if (options.restricted) currentDevice.access.scopes = ["files"];
      const currentPeer = { ...peer("APP"), ...(options.publicPeer ? { transport: "funnel" } : {}), ...(options.foreign ? { url: "https://arbitrary.example" } : {}) };
      const f = { current: options.fresh ? null : { peer: currentPeer, device: currentDevice }, selected: currentPeer, changes: [], browserStarts: 0,
        saved: { native: [peer("APP")], browser: options.noAlternate ? [] : [peer("BROWSER")] } };
      RecoveryFixture.bindPrivatePeer(peer("APP"), "native");
      f.recovery = RecoveryFixture.createPrivateRecovery({ product: "Reach", origin: privateOrigin, home: origin,
        name: device.name, instance: "runtime", tailnet: null }, {
        nativeFetch: direct, current: () => f.current, selected: () => f.selected, peers: mode => f.saved[mode],
        browser: async () => { f.browserStarts++; return { node, fetch: (input, init) => RecoveryFixture.tailnetFetch(node, input, init) }; },
        handoff: change => { f.changes.push(change); f.current = { peer: change.peer, device: change.device }; },
      });
      globalThis.f = f;
    };
    globalThis.publicBoundaries = async () => {
      const response = await direct(origin + "/api/device");
      const ws = await new Promise(resolve => {
        const socket = new NativeSocket(origin.replace("https:", "wss:") + "/ws/screen");
        socket.onopen = () => { socket.close(); resolve("opened"); };
        socket.onerror = () => resolve("refused");
        socket.onclose = () => resolve("refused");
      });
      return { status: response.status, ws };
    };
    globalThis.originalFetch = direct;
    makeRecovery();
  })()`);
  await tab.evaluate("f.recovery.check()");
  assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), []);
  await tab.evaluate(`(() => {
    f.held = fetch(location.origin + "/api/held", { headers: { Authorization: "Bearer APP" } }).then(response => response.json());
    return fetch(location.origin + "/api/action", { method: "POST", headers: { Authorization: "Bearer APP" }, body: "once" }).then(response => response.json()).then(() => false, () => true);
  })()`);
  assert.equal(calls.filter(call => call.path === "/api/action").length, 1, "the disposable HTTP fixture delivers the action only once before handoff");
  nativeMode = "funnel";
  assert.deepEqual(await tab.evaluate("publicBoundaries()"), { status: 404, ws: "refused" }, "Funnel keeps owner API and WebSocket private");
  const concurrent = await tab.evaluate("Promise.all([f.recovery.check(), f.recovery.check(), f.recovery.check()]).then(() => ({ modes: f.changes.map(change => change.mode), token: f.current.peer.token, starts: f.browserStarts }))");
  assert.deepEqual(concurrent, { modes: ["browser"], token: "BROWSER", starts: 1 }, "an actual public-start health404 must not strand an independently approved browser device");
  assert.equal(calls.filter(call => call.route === "browser-private" && call.method === "GET" && call.path === "/api/device").length, 1, "concurrent recovery shares one alternate identity probe");
  assert.equal(await tab.evaluate('fetch(location.origin + "/api/device", { headers: { Authorization: "Bearer APP" } }).then(response => response.status)'), 404, "a held native credential remains on its original transport");
  held.splice(0).forEach(release => release());
  assert.deepEqual(await tab.evaluate("f.held"), { original: true }, "a read already delivered on the old route may finish there");
  assert.equal(calls.filter(call => call.path === "/api/action").length, 1, "an action with an unknown answer is never replayed");
  nativeMode = "private";
  await tab.evaluate("f.recovery.check()");
  assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), token: f.current.peer.token })"), { modes: ["browser", "native"], token: "APP" });

  for (const status of [401, 403, 423, 429, 500]) {
    healthStatus = status;
    await tab.evaluate("makeRecovery(); f.recovery.check()");
    assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), starts: f.browserStarts })"), { modes: [], starts: 0 }, `native health${status} cannot substitute another identity`);
  }
  healthStatus = 200;
  nativeMode = "closed";
  await tab.evaluate("makeRecovery(); f.recovery.check()");
  assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), ["browser"], "a closed public door404 still permits individually authenticated private recovery");
  for (const options of [{ noAlternate: true }, { guest: true }, { restricted: true }, { publicPeer: true }, { foreign: true }]) {
    await tab.evaluate(`makeRecovery(${JSON.stringify(options)}); f.recovery.check()`);
    assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), starts: f.browserStarts })"), { modes: [], starts: 0 }, `404 grants no authority to ${JSON.stringify(options)}`);
  }
  nativeMode = "funnel";
  for (const status of [401, 403]) {
    browserStatus = status;
    await tab.evaluate("makeRecovery(); f.recovery.check()");
    assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), [], `browser device${status} cannot become an approval`);
  }
  browserStatus = 200;
  browserDevice.id = "different-device";
  await tab.evaluate("makeRecovery(); f.recovery.check()");
  assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), [], "an alternate for a different device cannot replace the current one");
  browserDevice.id = device.id;
  browserDevice.access.scopes = ["admin"];
  await tab.evaluate("makeRecovery(); f.recovery.check()");
  assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), [], "a different approved scope cannot replace the current grant");
  browserDevice.access.scopes = device.access.scopes;
  browserDevice.computerId = "different-computer";
  await tab.evaluate("makeRecovery(); f.recovery.check()");
  assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), [], "a different computer cannot replace the current one");
  browserDevice.computerId = device.computerId;

  await tab.evaluate("makeRecovery({ fresh: true }); f.recovery.check()");
  assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), token: f.current?.peer.token })"), { modes: ["browser"], token: "BROWSER" }, "a fresh owner page restores its own approved browser device after actual public-start device404");
  nativeMode = "private";
  await tab.evaluate("f.recovery.check()");
  assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), token: f.current?.peer.token })"), { modes: ["browser", "native"], token: "APP" }, "fresh restoration automatically returns to the separately approved native credential");
  for (const status of [401, 403, 503]) {
    nativeDeviceStatus = status;
    await tab.evaluate("makeRecovery({ fresh: true }); f.recovery.check()");
    assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), ["browser"], `a fresh page may use its own approved browser after native device${status}`);
  }
  for (const status of [423, 429, 500]) {
    nativeDeviceStatus = status;
    await tab.evaluate("makeRecovery({ fresh: true }); f.recovery.check()");
    assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), starts: f.browserStarts })"), { modes: [], starts: 0 }, `fresh native device${status} cannot substitute another identity`);
  }
  nativeDeviceStatus = 200;
  for (const grant of ["owner", "restricted", "guest"]) {
    device.access.kind = grant === "guest" ? "guest" : "device";
    device.access.scopes = grant === "restricted" ? ["files"] : ["admin", "files"];
    await tab.evaluate("makeRecovery({ fresh: true }); f.recovery.check()");
    assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), starts: f.browserStarts })"), { modes: [], starts: 0 }, `a reachable native ${grant} grant wins on a fresh page`);
  }
  device.access.kind = "device";
  device.access.scopes = ["admin", "files"];
  nativeMode = "closed";
  await tab.evaluate("makeRecovery({ fresh: true }); f.recovery.check()");
  assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), ["browser"], "a fresh page also survives the modeled closed public-door404");
  for (const options of [{ noAlternate: true }, { publicPeer: true }, { foreign: true }]) {
    await tab.evaluate(`makeRecovery({ fresh: true, ...${JSON.stringify(options)} }); f.recovery.check()`);
    assert.deepEqual(await tab.evaluate("({ modes: f.changes.map(change => change.mode), starts: f.browserStarts })"), { modes: [], starts: 0 }, `fresh404 grants no authority to ${JSON.stringify(options)}`);
  }
  nativeMode = "funnel";
  for (const status of [401, 403]) {
    browserStatus = status;
    await tab.evaluate("makeRecovery({ fresh: true }); f.recovery.check()");
    assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), [], `fresh browser device${status} cannot become an approval`);
  }
  browserStatus = 200;
  for (const changed of ["selection", "saved-approval"]) {
    holdBrowserDevice = true;
    releaseBrowserDevice = undefined;
    await tab.evaluate("makeRecovery({ fresh: true }); f.probing = f.recovery.check(); true");
    for (let waiting = 0; !releaseBrowserDevice && waiting < 100; waiting++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseBrowserDevice, "the actual browser probe must reach the held alternate authorization response");
    await tab.evaluate(changed === "selection" ? 'f.selected = { ...f.selected, token: "REPLACED" }' : "f.saved.browser = []");
    releaseBrowserDevice();
    held.splice(held.indexOf(releaseBrowserDevice), 1);
    await tab.evaluate("f.probing");
    assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), [], `a changed fresh ${changed} cannot be revived by a late approved response`);
  }
  cors = false;
  await tab.evaluate("makeRecovery(); f.recovery.check()");
  assert.deepEqual(await tab.evaluate("f.changes.map(change => change.mode)"), [], "actual browser CORS refusal prevents an unusable cross-port alternative");
  assert.ok(calls.filter(call => call.route === "browser-private" && call.token).every(call => call.token === "Bearer BROWSER"), "the native credential is never transferred to the browser identity");
  assert.ok(calls.filter(call => call.path === "/api/health").every(call => !call.token), "availability probes carry no device credential");
  const version = await browser.send("Browser.getVersion");
  t.diagnostic(JSON.stringify({ chrome: version.product, hostPlatform: process.platform,
    actual: "Chrome HTTPS, cross-port CORS, production public-start handler and owner recovery/routing; public owner API/WebSocket refusal",
    modeled: "OS VPN availability, separate approved private-device identities and browser-node packet delivery over owned loopback HTTPS; closed public-door wire response",
    physicalIPhone: "not tested; exact user URL and browser approval state unknown" }));
});
