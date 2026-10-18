import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createAuth } from "../server/core.mjs";
import { createFunnelAgentGateway } from "../server/funnel-agent.mjs";
import { startDom } from "./dom/harness.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

const origin = "https://mac.t.ts.net", privateOrigin = origin + ":8444";
const device = { id: "mac", name: "Mac", platform: "darwin" };
const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};
const keys = () => {
  const data = new Map();
  return { read: async key => data.get(key), write: async (key, value) => data.set(key, value), remove: async key => data.delete(key) };
};

test("browser agent prefers a private gateway with the same invitation key and audience", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { createFunnelAgent } = await dom.load("/src/funnel-agent.ts");
    const calls = [];
    const client = createFunnelAgent({
      origin, storage: storage(), keys: keys(), crypto: webcrypto,
      gateway: { endpoint: async () => privateOrigin, failed() {} },
      fetch: async (url, init) => {
        const envelope = JSON.parse(init.body), payload = JSON.parse(envelope.payload);
        calls.push({ url, envelope, payload });
        return Response.json({ status: "pending", requestId: "claim", requestSecret: "s".repeat(43), verificationCode: "123456", expiresAt: Date.now() + 60000, device }, { status: 202 });
      },
    });
    await client.claim(await client.prepare("a".repeat(43)));
    assert.equal(calls[0].url, privateOrigin + "/agent-gateway");
    assert.equal(calls[0].payload.audience, origin, "route changes never change grant/audience");
    const publicKey = await webcrypto.subtle.importKey("jwk", calls[0].envelope.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    assert.equal(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(calls[0].envelope.signature, "base64url"), new TextEncoder().encode(calls[0].envelope.payload)), true);
  } finally { await dom.close(); }
});

test("private-first gateway discovery falls back when unavailable and probes back to private after recovery/restart", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, on = false, instance = "old-runtime";
    const probes = [];
    const route = privateGatewayRoute({ origin, now: () => time, fetch: async (url, init) => {
      probes.push({ url, init });
      if (url.endsWith("/reach-start.json")) return Response.json({ product: "Reach", origin: privateOrigin, name: "Mac", instance: "initial-runtime", tailnet: null });
      if (!on) throw TypeError("not on the tailnet");
      return Response.json({ product: "Reach", instance });
    } });
    assert.equal(await route.endpoint(), origin);
    on = true;
    time = 15001;
    const concurrent = await Promise.all([route.endpoint(), route.endpoint()]);
    assert.deepEqual(concurrent, [privateOrigin, privateOrigin]);
    assert.equal(probes.filter(probe => probe.url.endsWith("/api/health")).length, 2, "one shared new probe per interval");
    route.failed(privateOrigin);
    assert.equal(await route.endpoint(), origin, "future requests use permitted public gateway after private network failure");
    time += 15001;
    instance = "new-runtime-after-normal-restart";
    assert.equal(await route.endpoint(), privateOrigin, "runtime UUID is not the stable grant identity");
    assert.ok(probes.every(({ init }) => init.credentials === "omit" && init.redirect === "error" && !init.headers && !init.body), "discovery and probes carry no credentials/invitation/action");
  } finally { await dom.close(); }
});

test("cached private discovery follows a changed same-computer port with one shared probe", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const replacement = origin + ":8445", calls = [];
    let time = 0, advertised = privateOrigin, oldAvailable = true;
    const route = privateGatewayRoute({ origin, now: () => time, fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/reach-start.json")) return Response.json({ product: "Reach", origin: advertised, name: "Mac", instance: "runtime", tailnet: null });
      if (url.startsWith(privateOrigin) && !oldAvailable) throw TypeError("old private port closed");
      return Response.json({ product: "Reach" });
    } });
    assert.equal(await route.endpoint(), privateOrigin);
    advertised = replacement;
    oldAvailable = false;
    time = 15001;
    assert.deepEqual(await Promise.all([route.endpoint(), route.endpoint(), route.endpoint()]), [replacement, replacement, replacement]);
    assert.equal(calls.filter(call => call.url.endsWith("/reach-start.json")).length, 2, "refresh discovery once after cached private loss");
    assert.equal(calls.filter(call => call.url === replacement + "/api/health").length, 1, "concurrent callers share new-port verification");
    assert.ok(calls.every(({ init }) => init.credentials === "omit" && init.redirect === "error" && !init.headers && !init.body));
    time += 15001;
    assert.equal(await route.endpoint(), replacement);
    assert.equal(calls.filter(call => call.url.endsWith("/reach-start.json")).length, 2, "a healthy private route does not require public rediscovery");
  } finally { await dom.close(); }
});

for (const status of [401, 403, 409, 423, 429, 500]) test(`a cached private health ${status} cannot be bypassed by new-port discovery`, async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, refused = false, metadata = 0;
    const route = privateGatewayRoute({ origin, now: () => time, fetch: async url => {
      if (url.endsWith("/reach-start.json")) {
        metadata++;
        return Response.json({ product: "Reach", origin: refused ? origin + ":8445" : privateOrigin, name: "Mac", instance: "runtime", tailnet: null });
      }
      return Response.json({ product: "Reach" }, { status: refused ? status : 200 });
    } });
    assert.equal(await route.endpoint(), privateOrigin);
    refused = true; time = 15001;
    await assert.rejects(route.endpoint(), error => error.status === status);
    assert.equal(metadata, 1, "an authoritative cached refusal cannot select another endpoint");
  } finally { await dom.close(); }
});

test("refreshed private discovery never probes an advertised foreign host", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, changed = false;
    const calls = [];
    const route = privateGatewayRoute({ origin, now: () => time, fetch: async url => {
      calls.push(url);
      if (url.endsWith("/reach-start.json")) return Response.json({ product: "Reach", origin: changed ? "https://foreign.t.ts.net:8445" : privateOrigin, name: "Mac", instance: "runtime", tailnet: null });
      if (changed) throw TypeError("old private port closed");
      return Response.json({ product: "Reach" });
    } });
    assert.equal(await route.endpoint(), privateOrigin);
    changed = true; time = 15001;
    assert.equal(await route.endpoint(), origin);
    assert.ok(calls.every(url => new URL(url).hostname === new URL(origin).hostname));
  } finally { await dom.close(); }
});

for (const denied of [403, 404, "network"]) test(`rediscovery assets ${denied} do not block an existing grant's public fallback`, async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, metadataOpen = true, oldAvailable = true;
    const route = privateGatewayRoute({ origin, now: () => time, fetch: async url => {
      if (url.endsWith("/reach-start.json")) {
        if (!metadataOpen && denied === "network") throw TypeError("discovery assets unavailable");
        return Response.json({ product: "Reach", origin: privateOrigin, name: "Mac", instance: "runtime", tailnet: null }, { status: metadataOpen ? 200 : denied });
      }
      if (!oldAvailable) throw TypeError("private port closed");
      return Response.json({ product: "Reach" });
    } });
    assert.equal(await route.endpoint(), privateOrigin);
    metadataOpen = false; time = 15001;
    assert.equal(await route.endpoint(), privateOrigin, "healthy cached private access remains independent of public assets");
    oldAvailable = false; time += 15001;
    assert.equal(await route.endpoint(), origin, "the signed gateway independently checks this grant even when public assets are closed");
  } finally { await dom.close(); }
});

for (const denied of [403, 404, "network"]) test(`fresh optional public metadata ${denied} leaves gateway authorization independent`, async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const calls = [];
    const route = privateGatewayRoute({ origin, fetch: async (url, init) => {
      calls.push({ url, init });
      if (denied === "network") throw TypeError("public metadata unavailable");
      return Response.json({}, { status: denied });
    } });
    assert.equal(await route.endpoint(), origin);
    assert.equal(calls.length, 1);
    assert.ok(calls.every(({ url, init }) => url === origin + "/reach-start.json" && init.credentials === "omit" && !init.headers && !init.body));
  } finally { await dom.close(); }
});

test("a previously same-origin gateway can discover a new private port", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, advertised = origin;
    const route = privateGatewayRoute({ origin, now: () => time, fetch: async url => Response.json(url.endsWith("/reach-start.json")
      ? { product: "Reach", origin: advertised, name: "Mac", instance: "runtime", tailnet: null }
      : { product: "Reach" }) });
    assert.equal(await route.endpoint(), origin);
    advertised = privateOrigin;
    time = 15001;
    assert.equal(await route.endpoint(), privateOrigin);
  } finally { await dom.close(); }
});

for (const bad of ["foreign-host", "non-Reach", "missing-config"]) test(`gateway discovery refuses ${bad} without exposing a grant`, async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const probes = [];
    const route = privateGatewayRoute({ origin, fetch: async url => {
      probes.push(url);
      if (url.endsWith("/reach-start.json")) return Response.json(bad === "missing-config" ? {} : { product: "Reach", origin: bad === "foreign-host" ? "https://other.t.ts.net:8444" : privateOrigin, name: "Mac", instance: "i1", tailnet: null });
      return Response.json({ product: "Another service" });
    } });
    assert.equal(await route.endpoint(), origin);
    assert.ok(probes.every(url => new URL(url).hostname === new URL(origin).hostname));
  } finally { await dom.close(); }
});

test("lost private action answer is never resent over Funnel; future requests keep the same signed grant", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { createFunnelAgent, funnelFetch } = await dom.load("/src/funnel-agent.ts");
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    let time = 0, loseAction = true;
    const calls = [];
    const gateway = privateGatewayRoute({ origin, now: () => time, fetch: async url => Response.json(url.endsWith("/reach-start.json")
      ? { product: "Reach", origin: privateOrigin, name: "Mac", instance: "i1", tailnet: null }
      : { product: "Reach", instance: "i2" }) });
    const client = createFunnelAgent({ origin, storage: storage(), keys: keys(), crypto: webcrypto, gateway,
      fetch: async (url, init) => {
        const envelope = JSON.parse(init.body), payload = JSON.parse(envelope.payload);
        calls.push({ url, payload, publicKey: envelope.publicKey });
        if (payload.operation === "claim") return Response.json({ status: "pending", requestId: "claim", requestSecret: "s".repeat(43), verificationCode: "123456", expiresAt: Date.now() + 60000, device }, { status: 202 });
        if (payload.operation === "status") return Response.json({ status: "approved", token: "same-grant", expiresAt: Date.now() + 60000, device });
        if (payload.method === "POST" && loseAction) { loseAction = false; throw TypeError("action answer lost"); }
        return Response.json({ ok: true });
      },
    });
    let state = await client.claim(await client.prepare("a".repeat(43)));
    state = await client.status(state);
    const peer = state.session.peer;
    await assert.rejects(funnelFetch(peer, "/api/browser/desktop/input", { method: "POST", body: '{"click":true}' }, client, 1), /answer lost/);
    assert.equal(calls.filter(call => call.payload.method === "POST").length, 1);
    await client.request(peer, "/api/browser");
    assert.equal(calls.at(-1).url, origin + "/agent-gateway");
    time = 15001;
    await client.request(peer, "/api/browser");
    assert.equal(calls.at(-1).url, privateOrigin + "/agent-gateway");
    assert.ok(calls.every(call => call.payload.audience === origin));
    assert.ok(calls.every(call => JSON.stringify(call.publicKey) === JSON.stringify(calls[0].publicKey)));
    assert.ok(calls.filter(call => call.payload.operation === "request").every(call => call.payload.token === "same-grant"));
    assert.equal(calls.filter(call => call.payload.operation === "claim").length, 1, "no replacement invitation/approval while routing changes");
    assert.equal(calls.filter(call => call.payload.method === "POST").length, 1, "the unknown action never reappears");
  } finally { await dom.close(); }
});

for (const status of [401, 403, 409, 423, 429, 500]) test(`an authoritative private health ${status} never dispatches a signed operation publicly`, async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const { createFunnelAgent } = await dom.load("/src/funnel-agent.ts");
    const signed = [];
    const gateway = privateGatewayRoute({ origin, fetch: async url => Response.json(url.endsWith("/reach-start.json")
      ? { product: "Reach", origin: privateOrigin, name: "Mac", instance: "i1", tailnet: null }
      : { error: "private policy refused" }, { status: url.endsWith("/reach-start.json") ? 200 : status }) });
    const client = createFunnelAgent({ origin, storage: storage(), keys: keys(), crypto: webcrypto, gateway, fetch: async (url, init) => {
      signed.push({ url, init });
      return Response.json({ status: "pending", requestId: "claim", requestSecret: "s".repeat(43), verificationCode: "123456", expiresAt: Date.now() + 60000, device }, { status: 202 });
    } });
    await assert.rejects(client.claim(await client.prepare("a".repeat(43))), error => error.status === status);
    assert.deepEqual(signed, [], "a reachable private refusal must not become a public signed claim/action");
  } finally { await dom.close(); }
});

test("only the explicit credential-free private availability pause can select public after an HTTP response", async () => {
  const dom = await startDom({ url: origin });
  try {
    const { privateGatewayRoute } = await dom.load("/src/private-gateway.ts");
    const route = privateGatewayRoute({ origin, fetch: async url => Response.json(url.endsWith("/reach-start.json")
      ? { product: "Reach", origin: privateOrigin, name: "Mac", instance: "i1", tailnet: null }
      : { error: "private connection temporarily unavailable" }, { status: url.endsWith("/reach-start.json") ? 200 : 503 }) });
    assert.equal(await route.endpoint(), origin);
  } finally { await dom.close(); }
});

const chromeBinary = findChrome();
test("real Chrome rediscovers a moved private HTTPS gateway without replaying an unknown action or losing a held read", {
  skip: !process.env.CI && !chromeBinary && "Chrome/Chromium is not installed", timeout: 30000,
}, async t => {
  assert.ok(chromeBinary, "Chrome/Chromium is required for the CI private-discovery contract");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-private-discovery-chrome-"));
  const host = "computer.fixture.ts.net";
  const servers = [], calls = [], dispatched = [], admissions = [];
  let browser, publicOrigin, advertised, metadataOpen = true, releaseHeld;
  let gatewayPublic, gatewayA, gatewayB;
  t.after(async () => {
    const errors = [];
    for (const cleanup of [
      () => releaseHeld?.(),
      () => browser?.close(),
      ...servers.map(server => async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      }),
      () => fs.rmSync(root, { recursive: true, force: true }),
    ]) { try { await cleanup(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Disposable private-discovery cleanup failed");
  });
  const certificate = await testCertificate(root, host);
  const auth = createAuth({ dataDir: path.join(root, "state"), roots: [], agentPolicyFile: path.join(root, "policy.json") });
  const bundle = await build({
    stdin: { contents: 'export { privateGatewayRoute } from "./src/private-gateway.ts"; export { createFunnelAgent, browserFunnelKeys, funnelFetch } from "./src/funnel-agent.ts";', resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "GatewayFixture", target: "es2022", logLevel: "silent",
  });
  const json = (res, value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const listen = async (way, gateway, hostname = host) => {
    const server = https.createServer(certificate, (req, res) => {
      calls.push({ way, path: req.url, method: req.method, authenticated: !!req.headers.authorization || !!req.headers["reach-key"] });
      if (way === "public" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; script-src 'self'; connect-src 'self' https://*.ts.net:*; img-src 'self' data:" });
        return res.end('<!doctype html><link rel="icon" href="data:,"><title>Private discovery fixture</title><script src="/fixture.js"></script>');
      }
      if (way === "public" && req.url === "/fixture.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(bundle.outputFiles[0].text);
      }
      if (way === "public" && req.url === "/reach-start.json") {
        if (!metadataOpen) { res.writeHead(404); return res.end(); }
        return json(res, { product: "Reach", name: "Disposable host", origin: advertised, instance: "runtime", tailnet: null });
      }
      if (way !== "public" && req.url === "/api/health") {
        res.setHeader("Access-Control-Allow-Origin", publicOrigin);
        res.setHeader("Vary", "Origin");
        return json(res, { product: "Reach" });
      }
      if (gateway()?.(req, res)) return;
      res.writeHead(404); res.end();
    });
    servers.push(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `https://${hostname}:${server.address().port}`;
  };
  publicOrigin = await listen("public", () => gatewayPublic);
  const privateA = await listen("private-a", () => gatewayA), privateB = await listen("private-b", () => gatewayB);
  const foreignHost = "foreign.fixture.ts.net", foreign = await listen("foreign", () => null, foreignHost);
  advertised = privateA;
  let heldStarted;
  const heldAtServer = new Promise(resolve => { heldStarted = resolve; });
  const gateway = (way, endpoint) => createFunnelAgentGateway({ auth, origin: publicOrigin, privateHost: new URL(endpoint).host,
    device: () => ({ id: "disposable-host", name: "Disposable host", platform: "darwin" }),
    claimed: receipt => { admissions.push(receipt.requestId); },
    dispatch(_req, res, context) {
      dispatched.push({ way, method: context.method, path: context.path, key: context.keyThumbprint,
        credential: createHash("sha256").update(context.token).digest("hex") });
      if (context.method === "POST") {
        // The listener moves while an existing read stays in flight. Closing
        // it also prevents Chrome's own socket retry from collecting a reply.
        servers[1].close();
        res.destroy(); return; // One synthetic action ran; its actual HTTPS answer is lost.
      }
      if (context.path === "/api/browser?hold=1") {
        releaseHeld = () => { releaseHeld = undefined; if (!res.destroyed) json(res, { way }); };
        heldStarted(); return;
      }
      json(res, { way });
    },
  });
  gatewayPublic = gateway("public", publicOrigin); gatewayA = gateway("private-a", privateA); gatewayB = gateway("private-b", privateB);
  // This is a synthetic host/approval, with production admission and signature
  // checks. No actual Reach instance, tailnet identity, screen or command runs.
  const invitation = auth.inviteBrowser({ name: "Disposable agent", preset: "full", fullControlVersion: 1, transport: "funnel", ttlSeconds: 600 });
  browser = await launchChrome(t, { binary: chromeBinary, hosts: [host, foreignHost], spki: certificate.spki });
  const version = await browser.send("Browser.getVersion");
  t.diagnostic(JSON.stringify({ chrome: version.product, hostPlatform: process.platform }));
  const tab = await openTab(browser);
  await tab.navigate(publicOrigin + "/");
  const receiptId = await tab.evaluate(`(async () => {
    const f = window.fixture = { time: 0 };
    f.gateway = GatewayFixture.privateGatewayRoute({ origin: location.origin, fetch: fetch.bind(window), now: () => f.time });
    f.client = GatewayFixture.createFunnelAgent({ origin: location.origin, storage: sessionStorage,
      keys: GatewayFixture.browserFunnelKeys(), crypto, fetch: fetch.bind(window), gateway: f.gateway });
    f.state = await f.client.claim(await f.client.prepare(${JSON.stringify(invitation.invitation)}));
    return f.state.receipt.requestId;
  })()`);
  auth.decideAgentAdmission(receiptId, "approve");
  assert.equal(await tab.evaluate(`(async () => {
    const f = window.fixture;
    f.state = await f.client.status(f.state); f.peer = f.state.session.peer;
    return (await (await f.client.request(f.peer, "/api/browser")).json()).way;
  })()`), "private-a");
  await tab.evaluate(`{ const f = window.fixture; f.held = f.client.request(f.peer, "/api/browser?hold=1").then(response => response.json()); "started"; }`);
  await heldAtServer;
  assert.equal(await tab.evaluate(`(async () => {
    const f = window.fixture;
    try { const response = await GatewayFixture.funnelFetch(f.peer, "/api/browser/desktop/input", { method: "POST", body: '{"action":{"type":"click","x":0.5,"y":0.5}}' }, f.client); return { status: response.status, body: await response.text() }; }
    catch (error) { return error.name; }
  })()`), "TypeError");
  assert.equal(await tab.evaluate(`(async () => { const f = window.fixture; return (await (await f.client.request(f.peer, "/api/browser")).json()).way; })()`), "public");
  metadataOpen = false;
  assert.equal(await tab.evaluate(`(async () => { const f = window.fixture; f.time = 15001; return (await (await f.client.request(f.peer, "/api/browser")).json()).way; })()`), "public", "closed discovery assets do not close an independently authorized gateway");
  metadataOpen = true;
  advertised = privateB;
  assert.deepEqual(await tab.evaluate(`(async () => {
    const f = window.fixture; f.time = 30002;
    return Promise.all(Array.from({ length: 3 }, async () => (await (await f.client.request(f.peer, "/api/browser")).json()).way));
  })()`), ["private-b", "private-b", "private-b"]);
  releaseHeld();
  assert.deepEqual(await tab.evaluate("window.fixture.held"), { way: "private-a" }, "the old-route response remains attached to its original request");
  assert.equal(dispatched.filter(call => call.method === "POST").length, 1, "the unknown action was never replayed through either replacement route");
  assert.equal(new Set(dispatched.map(call => call.key)).size, 1, "all routes use the same signing identity");
  assert.equal(new Set(dispatched.map(call => call.credential)).size, 1, "all routes retain the same approved credential");
  assert.deepEqual(admissions, [receiptId], "discovery cannot manufacture another admission or reconnect");
  assert.equal(calls.filter(call => call.path === "/reach-start.json").length, 3, "one initial discovery, one closed door and one shared new-port discovery");
  assert.ok(calls.filter(call => ["/reach-start.json", "/api/health"].includes(call.path)).every(call => !call.authenticated));
  assert.equal(await tab.evaluate(`fetch("/api/clients").then(response => response.status)`), 404, "the public fixture exposes no owner API");
  const beforeDenied = dispatched.length;
  assert.equal(await tab.evaluate(`window.fixture.client.request(window.fixture.peer, "/api/clients").then(response => response.status)`), 403, "the production gateway refuses owner routes on the recovered private endpoint");
  assert.equal(dispatched.length, beforeDenied, "an owner-only request never reaches dispatch");
  const stoppedB = new Promise((resolve, reject) => servers[2].close(error => error ? reject(error) : resolve()));
  servers[2].closeAllConnections();
  await stoppedB;
  advertised = foreign;
  assert.equal(await tab.evaluate(`(async () => { const f = window.fixture; f.time = 45003; return (await (await f.client.request(f.peer, "/api/browser")).json()).way; })()`), "public");
  assert.equal(calls.filter(call => call.way === "foreign").length, 0, "changed-host metadata receives neither a probe nor a signed credential");
  assert.equal(dispatched.filter(call => call.method === "POST").length, 1, "later invalid discovery still cannot replay the unknown action");
  metadataOpen = false;
  const resumed = await tab.evaluate(`(async () => {
    const f = window.fixture; f.time = 60004;
    const read = async () => {
      try { return (await (await f.client.request(f.peer, "/api/browser")).json()).way; }
      catch (error) { return { status: error.status }; }
    };
    const afterForeign = await read();
    // Model a new client module on reload, with the same real browser
    // sessionStorage, IndexedDB signing key and already approved peer.
    f.gateway = GatewayFixture.privateGatewayRoute({ origin: location.origin, fetch: fetch.bind(window) });
    f.client = GatewayFixture.createFunnelAgent({ origin: location.origin, storage: sessionStorage,
      keys: GatewayFixture.browserFunnelKeys(), crypto, fetch: fetch.bind(window), gateway: f.gateway });
    return { afterForeign, fresh: await read() };
  })()`);
  assert.deepEqual(resumed, { afterForeign: "public", fresh: "public" }, "closed optional assets cannot block an already approved signing identity after invalid discovery or a fresh client");
  assert.deepEqual(admissions, [receiptId], "restoring the client neither claims nor approves another identity");
  assert.equal(new Set(dispatched.map(call => call.key)).size, 1);
  assert.equal(new Set(dispatched.map(call => call.credential)).size, 1);
  assert.equal(dispatched.filter(call => call.method === "POST").length, 1);
  t.diagnostic(JSON.stringify({ chrome: version.product, hostPlatform: process.platform, transport: "actual browser/HTTPS/CORS/production discovery, signing, admission and gateway",
    modeled: "DNS to owned loopback ports, private availability and synthetic dispatch, fixture approval, recheck clock; no actual Tailscale or physical device" }));
});
