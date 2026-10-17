import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { serveBuild } from "../server/delivery.mjs";
import { createIosProxyForwarder } from "./helpers/ios-proxy.mjs";

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const bytes = "export const screen = 'synthetic screen bytes';\n";
function request(url, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // Like WKWebView, the front side offers keep-alive. The test client
    // itself does not pool, so only the proxy's upstream pool is exercised.
    const req = http.request(url, { method, agent: false, headers: { connection: "keep-alive", ...headers } }, res => {
      let text = "";
      res.setEncoding("utf8").on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t, { legacy = false, stale = false, maxErrors } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ios-proxy-"));
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "index.html"), "synthetic page");
  await fs.writeFile(path.join(dir, "assets", "screen-test.js"), bytes);
  const app = express(), dispatched = [], legacyErrors = [];
  app.use(async (req, res, next) => {
    if (!["/fail", "/write"].includes(req.path)) return next();
    let body = "";
    for await (const chunk of req) body += chunk;
    dispatched.push({ path: req.path, method: req.method, body });
    req.socket.destroy();
  });
  serveBuild(app, express, dir);
  const upstreamServer = http.createServer(app), upstream = await listen(upstreamServer);
  const forwarder = createIosProxyForwarder(upstream, { maxErrors });
  let count = 0;
  const proxy = http.createServer((req, res) => {
    // The server's idle close reaches the proxy after this synchronous
    // handler. A pooled ClientRequest can therefore select the stale socket.
    if (++count === 2 && stale) upstreamServer.closeIdleConnections();
    if (!legacy) { forwarder.forward(req, res); return; }
    const forwarded = http.request(upstream + req.url, { method: req.method, headers: { ...req.headers, host: new URL(upstream).host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    forwarded.on("error", error => {
      legacyErrors.push({ code: error.code, reusedSocket: forwarded.reusedSocket });
      res.writeHead(502).end();
    });
    req.pipe(forwarded);
  });
  const origin = await listen(proxy);
  t.after(async () => {
    proxy.closeAllConnections(); upstreamServer.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstreamServer.close(resolve))]);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { origin, upstream, forwarder, dispatched, legacyErrors };
}

test("the old pooled proxy turns an upstream idle close into502 although production serves the asset", async t => {
  const f = await fixture(t, { legacy: true, stale: true });
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  assert.equal((await request(f.origin + "/assets/screen-test.js")).status, 502);
  assert.deepEqual(f.legacyErrors, [{ code: "ECONNRESET", reusedSocket: true }]);
  assert.deepEqual(await request(f.upstream + "/assets/screen-test.js"), { status: 200, body: bytes });
});

test("the iOS fixture serves the same asset after an idle close using a fresh upstream connection", async t => {
  const f = await fixture(t, { stale: true });
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  assert.deepEqual(f.forwarder.snapshot(), { errors: [], droppedErrors: 0 });
});

test("a new upstream connection failure stays visible with bounded safe connection evidence", async t => {
  const f = await fixture(t, { maxErrors: 2 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await request(f.origin + "/fail?token=must-not-record", { headers: { authorization: "Bearer private-header" } })).status, 502);
  }
  const evidence = f.forwarder.snapshot();
  assert.equal(evidence.errors.length, 2);
  assert.equal(evidence.droppedErrors, 1);
  assert.ok(evidence.errors.every(error => error.path === "/fail" && error.method === "GET" && error.code === "ECONNRESET" && error.reusedSocket === false));
  assert.ok(evidence.errors.every(error => error.remoteAddress === "127.0.0.1" && Number.isInteger(error.remotePort)));
  assert.doesNotMatch(JSON.stringify(evidence), /must-not-record|private-header|Bearer|authorization|token/);
});

test("a write applied before the upstream reply is lost is dispatched once without replay", async t => {
  const f = await fixture(t);
  assert.equal((await request(f.origin + "/write", { method: "POST", body: "synthetic write bytes" })).status, 502);
  assert.deepEqual(f.dispatched, [{ path: "/write", method: "POST", body: "synthetic write bytes" }]);
  assert.equal(f.forwarder.snapshot().errors.length, 1);
  assert.equal(f.forwarder.snapshot().errors[0].method, "POST");
});
