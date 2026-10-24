import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
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

async function fixture(t, { legacy = false, stale = false, maxErrors, maxRequests } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ios-proxy-"));
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "index.html"), "synthetic page");
  await fs.writeFile(path.join(dir, "assets", "screen-test.js"), bytes);
  const app = express(), dispatched = [], legacyErrors = [];
  let noteApplied, allowReply, noteClientClose;
  const applied = new Promise(resolve => { noteApplied = resolve; });
  const replyAllowed = new Promise(resolve => { allowReply = resolve; });
  const clientClosed = new Promise(resolve => { noteClientClose = resolve; });
  app.use(async (req, res, next) => {
    if (!["/fail", "/write", "/held-write"].includes(req.path)) return next();
    let body = "";
    for await (const chunk of req) body += chunk;
    dispatched.push({ path: req.path, method: req.method, body });
    if (req.path === "/held-write") {
      noteApplied();
      await replyAllowed;
      res.writeHead(200).end("synthetic reply bytes");
      return;
    }
    req.socket.destroy();
  });
  serveBuild(app, express, dir);
  const upstreamServer = http.createServer(app), upstream = await listen(upstreamServer);
  const connections = new Map(), wire = { requests: [], selections: [], idleCloses: [] };
  let nextConnection = 0;
  upstreamServer.on("connection", socket => connections.set(socket, ++nextConnection));
  upstreamServer.prependListener("request", req => {
    if (req.url === "/assets/screen-test.js") wire.requests.push({ connection: connections.get(req.socket), path: req.url });
  });
  // Own the legacy pool instead of depending on a process-global agent's
  // defaults or free sockets left by other tests.
  const legacyAgent = legacy ? new http.Agent({ keepAlive: true, maxSockets: 1 }) : undefined;
  const idle = legacy ? once(legacyAgent, "free").then(([socket]) => socket) : undefined;
  const closeIdle = () => {
    const open = [...connections].filter(([socket]) => !socket.destroyed);
    upstreamServer.closeIdleConnections();
    wire.idleCloses.push({ closed: open.filter(([socket]) => socket.destroyed).map(([, id]) => id) });
  };
  const forwarder = createIosProxyForwarder(upstream, { maxErrors, maxRequests });
  let count = 0;
  const proxy = http.createServer((req, res) => {
    if (req.url.startsWith("/held-write")) res.once("close", noteClientClose);
    const challenge = ++count === 2 && stale;
    const forwarded = !legacy ? forwarder.forward(req, res) : http.request(upstream + req.url, { method: req.method, agent: legacyAgent, headers: { ...req.headers, host: new URL(upstream).host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    if (challenge) forwarded.once("socket", () => {
      // Select the upstream socket before closing idle server connections.
      // This fixes the wire ordering without injecting a ClientRequest error:
      // the pooled request has selected the old socket, but cannot send before
      // this listener returns. The fresh forwarder selects a new connection.
      wire.selections.push({ reusedSocket: forwarded.reusedSocket });
      closeIdle();
    });
    if (!legacy) return;
    forwarded.on("error", error => {
      legacyErrors.push({ code: error.code, reusedSocket: forwarded.reusedSocket });
      res.writeHead(502).end();
    });
    req.pipe(forwarded);
  });
  const origin = await listen(proxy);
  t.after(async () => {
    allowReply();
    legacyAgent?.destroy();
    proxy.closeAllConnections(); upstreamServer.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstreamServer.close(resolve))]);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { origin, upstream, forwarder, dispatched, legacyErrors, applied, allowReply, clientClosed, wire, idle,
    async closeBeforeSelection() {
      const socket = await idle;
      assert.equal(socket.destroyed, false, "the pooled connection is idle and open before the close");
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
      closeIdle();
      await closed;
    },
  };
}

test("the old pooled proxy turns an upstream idle close into502 although production serves the asset", async t => {
  const f = await fixture(t, { legacy: true, stale: true });
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  await f.idle;
  assert.equal((await request(f.origin + "/assets/screen-test.js")).status, 502);
  assert.deepEqual(f.legacyErrors, [{ code: "ECONNRESET", reusedSocket: true }]);
  assert.deepEqual(f.wire.selections, [{ reusedSocket: true }]);
  assert.deepEqual(f.wire.idleCloses, [{ closed: [1] }]);
  assert.deepEqual(f.wire.requests, [{ connection: 1, path: "/assets/screen-test.js" }], "the selected stale socket never delivers a second asset request");
  assert.deepEqual(await request(f.upstream + "/assets/screen-test.js"), { status: 200, body: bytes });
});

test("an idle close observed before selection removes the old socket instead of proving a pooled failure", async t => {
  const f = await fixture(t, { legacy: true });
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  await f.closeBeforeSelection();
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  assert.deepEqual(f.legacyErrors, []);
  assert.deepEqual(f.wire.idleCloses, [{ closed: [1] }]);
  assert.deepEqual(f.wire.requests.map(item => item.connection), [1, 2]);
});

test("the iOS fixture serves the same asset after an idle close using a fresh upstream connection", async t => {
  const f = await fixture(t, { stale: true });
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  assert.deepEqual(await request(f.origin + "/assets/screen-test.js"), { status: 200, body: bytes });
  assert.deepEqual(f.wire.selections, [{ reusedSocket: false }]);
  assert.deepEqual(f.wire.requests.map(item => item.connection), [1, 2], "both assets actually reach production on separate upstream connections");
  const evidence = f.forwarder.snapshot();
  assert.deepEqual(evidence.errors, []);
  assert.equal(evidence.droppedErrors, 0);
  assert.equal(evidence.droppedRequests, 0);
  assert.equal(evidence.requests.length, 2);
  for (const item of evidence.requests) {
    assert.equal(item.path, "/assets/screen-test.js");
    assert.equal(item.requestBodyBytes, 0);
    assert.equal(item.requestComplete, true);
    assert.equal(item.upstreamStatus, 200);
    assert.equal(item.upstreamBodyObserved, true);
    assert.equal(item.upstreamResponseBytes, Buffer.byteLength(bytes));
    assert.equal(item.upstreamResponseComplete, true);
    assert.equal(item.clientStatus, 200);
    assert.ok(["requestBodyEndSeconds", "upstreamRequestFinishSeconds", "upstreamHeadersSeconds", "upstreamResponseEndSeconds", "clientFinishSeconds"].every(field => Number.isFinite(item[field])));
  }
});

test("a new upstream connection failure stays visible with bounded safe connection evidence", async t => {
  const f = await fixture(t, { maxErrors: 2, maxRequests: 2 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await request(f.origin + "/fail?token=must-not-record", { headers: { authorization: "Bearer private-header" } })).status, 502);
  }
  const evidence = f.forwarder.snapshot();
  assert.equal(evidence.errors.length, 2);
  assert.equal(evidence.droppedErrors, 1);
  assert.equal(evidence.requests.length, 2);
  assert.equal(evidence.droppedRequests, 1);
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

test("real client cancellation retains a complete one-use request and an unfinished reply without replay or credentials", async t => {
  const f = await fixture(t);
  const client = http.request(f.origin + "/held-write?token=must-not-record", {
    method: "POST", agent: false, headers: { authorization: "Bearer private-header" },
  });
  client.on("error", () => {});
  const body = "synthetic private request bytes";
  client.end(body);
  await f.applied;
  client.destroy();
  await f.clientClosed;
  const evidence = f.forwarder.snapshot(), item = evidence.requests[0];
  assert.equal(item.path, "/held-write");
  assert.equal(item.method, "POST");
  assert.equal(item.requestBodyBytes, Buffer.byteLength(body));
  assert.equal(item.requestComplete, true);
  assert.ok(Number.isFinite(item.requestBodyEndSeconds));
  assert.ok(Number.isFinite(item.upstreamRequestFinishSeconds));
  assert.ok(Number.isFinite(item.clientCloseSeconds));
  assert.equal(item.clientWritableFinished, false);
  assert.equal(item.upstreamStatus, undefined, "no reply has been released yet");
  f.allowReply();
  for (const until = Date.now() + 5000; !f.forwarder.snapshot().requests[0].upstreamStatus; ) {
    assert.ok(Date.now() < until, "the actual upstream reply was observed");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const final = f.forwarder.snapshot();
  assert.equal(final.requests[0].upstreamStatus, 200);
  assert.equal(final.requests[0].upstreamBodyObserved, false, "a reply arriving after client close is not fully byte-observed");
  assert.equal(final.requests[0].clientWritableFinished, false);
  assert.deepEqual(f.dispatched, [{ path: "/held-write", method: "POST", body }]);
  assert.equal(item.upstreamStatus, undefined, "the earlier evidence is a snapshot");
  assert.doesNotMatch(JSON.stringify(final), /must-not-record|private-header|synthetic private request bytes|authorization|Bearer/);
});
