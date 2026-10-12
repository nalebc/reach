import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import express from "express";
import {
  INGRESS_KEY,
  keyRedactor,
  keyedTarget,
  listenKeyedIngress,
  listenPrivateIngress,
  newIngressKey,
  serveRequestHost,
  thisComputerRequest,
  trustedRequest,
} from "../server/tailscale-auth.mjs";

// Windows' keyed route (docs/parity/D-public-door.md §4.2): Tailscale Serve
// proxies to 127.0.0.1:<port>/r-<key>, and a request counts as Tailscale's
// only with the key and from Tailscale's own process. In-process, with a
// stand-in for the peer check; the real one runs in
// test/windows-tailscaled-peer.test.mjs on a real Windows runner.

const KEY = newIngressKey();
const OTHER = newIngressKey();
const ok = { check: async () => true };

// One request (or anything) on a fresh connection: what came back, and
// whether the server closed it ("closed") or left it open ("open").
const exchange = (port, text, { wait = 1500 } = {}) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ how, text: Buffer.concat(chunks).toString("latin1") });
    };
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => finish("closed"));
    socket.on("error", () => finish("closed"));
    const timer = setTimeout(() => finish("open"), wait);
    socket.write(text);
  });
const get = (target, headers = {}) =>
  `GET ${target} HTTP/1.1\r\nHost: mac.example.ts.net:8443\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
const upgradeTo = (target, headers = {}) =>
  get(target, { Connection: "Upgrade", Upgrade: "websocket", ...headers });

async function keyed(t, options = {}) {
  const seen = { app: [], identity: 0, checks: [], upgrades: [], public: [], refused: [] };
  const server = await listenKeyedIngress({
    key: KEY,
    peerCheck: {
      check: async (socket, acceptedAt) => {
        seen.checks.push({ socket, acceptedAt });
        return (options.peerCheck || ok).check(socket, acceptedAt);
      },
    },
    resolveIdentity: async () => {
      seen.identity++;
      return { userId: "42", nodeId: "nPhone", login: "owner@example.test" };
    },
    app:
      options.app ||
      ((req, res) => {
        seen.app.push({ url: req.url, trusted: trustedRequest(req), host: serveRequestHost(req), thisComputer: thisComputerRequest(req) });
        res.end("reach");
      }),
    upgrade: (req, socket) => {
      seen.upgrades.push(req.url);
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    },
    ...(options.publicApp !== false && {
      publicApp: (req, res) => {
        seen.public.push({ url: req.url, trusted: trustedRequest(req), thisComputer: thisComputerRequest(req), host: serveRequestHost(req) });
        res.end("start page");
      },
    }),
    refuse: options.refuse,
    onRefused: (kind) => seen.refused.push(kind),
    selfIps: options.selfIps,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, port: server.address().port, seen };
}

test("the key is 256 random bits in base64url; the route's target carries it as its path", () => {
  assert.match(KEY, INGRESS_KEY);
  assert.notEqual(KEY, OTHER);
  assert.equal(keyedTarget(51234, KEY), `http://127.0.0.1:51234/r-${KEY}`);
});

test("without the exact key: 404, the connection closed, and nothing else asked", async (t) => {
  const { port, seen } = await keyed(t);
  const lower = KEY.toLowerCase() === KEY ? KEY.toUpperCase() : KEY.toLowerCase();
  const wrong = [
    "/",
    "/api/health",
    `/r-${OTHER}/api/health`,
    `/r-${KEY.slice(0, -1)}${KEY.at(-1) === "A" ? "B" : "A"}/api/health`, // one character off
    `/r-${KEY.slice(0, 42)}/api/health`, // short
    "/r-",
    `/r-${lower}/`,
    `/?key=/r-${KEY}/`,
    `/r-${KEY}x/api/health`,
    `/r-${KEY}`, // no slash after it: Go's proxy always sends one
    `http://127.0.0.1:${port}/r-${KEY}/api/health`, // absolute form
    "*",
  ];
  for (const target of wrong) {
    const answer = await exchange(port, get(target));
    assert.equal(answer.how, "closed", target);
    assert.match(answer.text, /^HTTP\/1\.1 404 /, target);
    assert.ok(!answer.text.includes(KEY), "the key is never said back");
  }
  assert.deepEqual(seen.app, []);
  assert.equal(seen.identity, 0);
  assert.equal(seen.checks.length, 0, "no peer check without the key");
  assert.ok(seen.refused.length >= wrong.length && seen.refused.every((kind) => kind === "key"));
});

test("the right key from a process that isn't Tailscale's: closed without a byte", async (t) => {
  const { port, seen } = await keyed(t, { peerCheck: { check: async () => false } });
  const forged = await exchange(port, get(`/r-${KEY}/api/auth/method`, { "Tailscale-User-Login": "owner@example.test", "X-Forwarded-For": "100.64.0.10" }));
  assert.deepEqual(forged, { how: "closed", text: "" });
  // A check that throws is a no.
  const throwing = await keyed(t, { peerCheck: { check: async () => { throw Error("helper gone"); } } });
  assert.deepEqual(await exchange(throwing.port, get(`/r-${KEY}/`)), { how: "closed", text: "" });
  // Only exactly true counts.
  const truthy = await keyed(t, { peerCheck: { check: async () => "t" } });
  assert.deepEqual(await exchange(truthy.port, get(`/r-${KEY}/`)), { how: "closed", text: "" });
  assert.deepEqual([...seen.app, ...throwing.seen.app, ...truthy.seen.app], []);
  assert.deepEqual(seen.refused, ["peer"]);
});

test("the right key from Tailscale: Reach sees the request without it, trusted, at the original host", async (t) => {
  const seen = [];
  const app = express();
  app.get("/api/health", (req, res) => {
    seen.push({ url: req.url, originalUrl: req.originalUrl, trusted: trustedRequest(req), host: serveRequestHost(req), query: { ...req.query } });
    res.json({ ok: true });
  });
  const ingress = await keyed(t, { app });
  const answer = await exchange(ingress.port, get(`/r-${KEY}/api/health?x=1`, { "X-Forwarded-Host": "mac.example.ts.net:8443", "X-Forwarded-For": "100.64.0.20" }));
  assert.match(answer.text, /^HTTP\/1\.1 200 /);
  assert.deepEqual(seen, [{ url: "/api/health?x=1", originalUrl: "/api/health?x=1", trusted: true, host: "mac.example.ts.net:8443", query: { x: "1" } }]);
  assert.equal(ingress.seen.identity, 1);
  assert.equal(ingress.seen.checks.length, 1);
  const { acceptedAt } = ingress.seen.checks[0];
  assert.ok(Number.isFinite(acceptedAt) && acceptedAt <= Date.now() && acceptedAt > Date.now() - 5000, "checked with when it was accepted");
  // Escaped paths stay escaped.
  const files = await keyed(t);
  await exchange(files.port, get(`/r-${KEY}/files/a%2Fb`));
  assert.equal(files.seen.app[0].url, "/files/a%2Fb");
});

test("kept-alive connections: one check per connection, the key on every request", async (t) => {
  const { port, seen } = await keyed(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const ask = (target) =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: target, agent }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body, socket: req.socket }));
      });
      req.on("error", reject);
    });
  const first = await ask(`/r-${KEY}/one`);
  const second = await ask(`/r-${KEY}/two`);
  assert.equal(first.socket, second.socket, "the same connection");
  assert.equal(seen.checks.length, 1, "checked once for it");
  assert.deepEqual(seen.app.map((r) => r.url), ["/one", "/two"]);
  // Without the key on the same connection: 404, and it ends.
  const third = await ask("/three");
  assert.equal(third.status, 404);
  await new Promise((resolve) => (third.socket.destroyed ? resolve() : third.socket.once("close", resolve)));
  // A new connection is checked again.
  await ask(`/r-${KEY}/four`);
  assert.equal(seen.checks.length, 2);
  assert.notEqual(seen.checks[0].socket, seen.checks[1].socket);
  assert.deepEqual(seen.app.map((r) => r.url), ["/one", "/two", "/four"]);
});

test("a raw path to the port that Tailscale's process passes, without the key: 404, never Reach", async (t) => {
  // tailscaled forwarding raw TCP (a peer's own route, an exit node's
  // traffic): the peer check would say yes, the key is what's missing.
  const { port, seen } = await keyed(t);
  const answer = await exchange(port, get("/api/auth/method", { "Tailscale-User-Login": "owner@example.test", "X-Forwarded-For": "100.64.0.10" }));
  assert.equal(answer.how, "closed");
  assert.match(answer.text, /^HTTP\/1\.1 404 /);
  assert.deepEqual(seen.app, []);
  assert.equal(seen.checks.length, 0);
});

test("WebSockets: keyed and from Tailscale only; never from the internet", async (t) => {
  const { port, seen } = await keyed(t);
  const answer = await exchange(port, upgradeTo(`/r-${KEY}/api/terminals/1/ws?x=1`));
  assert.match(answer.text, /^HTTP\/1\.1 101 /);
  assert.deepEqual(seen.upgrades, ["/api/terminals/1/ws?x=1"]);
  for (const request of [upgradeTo("/api/terminals/1/ws"), upgradeTo(`/r-${OTHER}/ws`), upgradeTo(`/r-${KEY}/ws`, { "Tailscale-Funnel-Request": "?1" })])
    assert.deepEqual(await exchange(port, request), { how: "closed", text: "" });
  const denied = await keyed(t, { peerCheck: { check: async () => false } });
  assert.deepEqual(await exchange(denied.port, upgradeTo(`/r-${KEY}/ws`)), { how: "closed", text: "" });
  assert.deepEqual(seen.upgrades.length + denied.seen.upgrades.length, 1);
  assert.deepEqual(denied.seen.refused, ["peer"]);
});

test("the internet's keyed requests (Funnel) reach only the start page, with no identity", async (t) => {
  const { port, seen } = await keyed(t, { selfIps: () => ["100.64.0.10"] });
  const answer = await exchange(port, get(`/r-${KEY}/`, { "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "100.64.0.10", "X-Forwarded-Host": "mac.example.ts.net" }));
  assert.match(answer.text, /start page/);
  assert.deepEqual(seen.public, [{ url: "/", trusted: false, thisComputer: false, host: "mac.example.ts.net" }]);
  assert.equal(seen.identity, 0);
  assert.deepEqual(seen.app, []);
  const none = await keyed(t, { publicApp: false });
  const missing = await exchange(none.port, get(`/r-${KEY}/`, { "Tailscale-Funnel-Request": "?1" }));
  assert.match(missing.text, /^HTTP\/1\.1 404 /);
  assert.deepEqual(none.seen.app, []);
});

test("a request from this PC itself (its own Tailscale address, as tailscaled sets it) is marked", async (t) => {
  const { port, seen } = await keyed(t, { selfIps: () => ["100.64.0.10", "fd7a:115c:a1e0::a"] });
  for (const from of ["100.64.0.10", "fd7a:115c:a1e0::a", "100.64.0.20", "100.64.0.10, 1.2.3.4"])
    await exchange(port, get(`/r-${KEY}/api/auth/method`, { "X-Forwarded-For": from }));
  assert.deepEqual(seen.app.map((r) => r.thisComputer), [true, true, false, false]);
  // Without the list (or off Windows) nothing is ever marked.
  const plain = await keyed(t);
  await exchange(plain.port, get(`/r-${KEY}/`, { "X-Forwarded-For": "100.64.0.10" }));
  assert.equal(plain.seen.app[0].thisComputer, false);
});

test("odd requests: a non-ASCII path, malformed HTTP; Reach keeps answering", async (t) => {
  const { port, seen } = await keyed(t);
  // The same length as a keyed path, with bytes the comparison must not trip on.
  const odd = Buffer.concat([Buffer.from(`GET /r-${KEY.slice(0, 40)}`), Buffer.from([0xc3, 0xa9, 0xe2, 0x82, 0xac]), Buffer.from("/x HTTP/1.1\r\nHost: x\r\n\r\n")]);
  const answer = await exchange(port, odd);
  assert.equal(answer.how, "closed");
  assert.ok(answer.text === "" || /^HTTP\/1\.1 (400|404) /.test(answer.text), answer.text);
  assert.deepEqual(await exchange(port, "garbage\r\n\r\n"), { how: "closed", text: "" });
  assert.deepEqual(await exchange(port, `GET /r-${KEY}/ HTTP/9\r\n\r\n`), { how: "closed", text: "" });
  assert.match((await exchange(port, get(`/r-${KEY}/still`))).text, /^HTTP\/1\.1 200 /);
  assert.deepEqual(seen.app.map((r) => r.url), ["/still"]);
});

test("a malformed key or no peer check: nothing listens", async () => {
  for (const key of [undefined, "", "short", KEY + "A", KEY.slice(0, 42) + "=", KEY.slice(0, 42) + "/"])
    await assert.rejects(listenKeyedIngress({ key, peerCheck: ok, app() {}, upgrade() {}, resolveIdentity() {} }), { message: "Reach's private route key is malformed." });
  for (const peerCheck of [undefined, {}, { check: true }])
    await assert.rejects(listenKeyedIngress({ key: KEY, peerCheck, app() {}, upgrade() {}, resolveIdentity() {} }), { message: "Reach's private route needs Tailscale's connection check." });
});

test("while another route leads to the port, or Tailscale's settings don't allow it, every request is closed", async (t) => {
  for (const why of ["route", "settings"]) {
    let refuse = why;
    const { port, seen } = await keyed(t, { refuse: () => refuse });
    assert.deepEqual(await exchange(port, get(`/r-${KEY}/api/health`)), { how: "closed", text: "" });
    assert.deepEqual(await exchange(port, upgradeTo(`/r-${KEY}/ws`)), { how: "closed", text: "" });
    assert.deepEqual(await exchange(port, get("/no-key")), { how: "closed", text: "" });
    assert.deepEqual(seen.refused, [why, why, why]);
    assert.equal(seen.checks.length, 0);
    assert.deepEqual(seen.app, []);
    refuse = "";
    assert.match((await exchange(port, get(`/r-${KEY}/api/health`))).text, /^HTTP\/1\.1 200 /);
  }
});

test("a connection that ends, or a route that closes, while it's being checked is never served", async (t) => {
  // The client resets it mid-check: its address pair is free for another
  // connection, so the answer no longer speaks for this one.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { port, seen } = await keyed(t, { peerCheck: { check: async (socket) => { socket.destroy(); await held; return true; } } });
  const pending = exchange(port, get(`/r-${KEY}/api/health`));
  const upgradePending = exchange(port, upgradeTo(`/r-${KEY}/ws`));
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  assert.deepEqual(await pending, { how: "closed", text: "" });
  assert.deepEqual(await upgradePending, { how: "closed", text: "" });
  assert.deepEqual(seen.app, []);
  assert.deepEqual(seen.upgrades, []);
  // The route closes while the check runs.
  let refuse = "";
  const closing = await keyed(t, { refuse: () => refuse, peerCheck: { check: async () => { refuse = "route"; return true; } } });
  assert.deepEqual(await exchange(closing.port, get(`/r-${KEY}/api/health`)), { how: "closed", text: "" });
  refuse = "";
  assert.deepEqual(await exchange(closing.port, upgradeTo(`/r-${KEY}/ws`)), { how: "closed", text: "" });
  assert.deepEqual(closing.seen.app, []);
  assert.deepEqual(closing.seen.upgrades, []);
});

test("the keyed listener keeps connections 100 s, as Serve keeps its own 90 s; the private socket keeps Node's defaults", { skip: process.platform === "win32" && "no Unix socket listener on Windows" }, async (t) => {
  const { server } = await keyed(t);
  assert.equal(server.keepAliveTimeout, 100000);
  assert.equal(server.headersTimeout, 105000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = await listenPrivateIngress({ socketPath: path.join(dir, "s", "s"), app() {}, upgrade() {}, resolveIdentity: async () => null });
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  const defaults = http.createServer();
  assert.equal(socket.keepAliveTimeout, defaults.keepAliveTimeout);
  assert.equal(socket.headersTimeout, defaults.headersTimeout);
});

test("keyRedactor takes the key out whole, cut, or as any 12 of its characters; other text stays", () => {
  const redact = keyRedactor(KEY);
  const target = keyedTarget(51234, KEY);
  assert.equal(redact(`proxy ${target} up`), "proxy http://127.0.0.1:51234/r-… up");
  assert.equal(redact(`/r-${OTHER}/x`), "/r-…/x", "any key-shaped route path");
  for (let cut = 1; cut < KEY.length; cut++) {
    const said = redact(`…${target.slice(0, 30 + cut)}`);
    for (let i = 0; i + 12 <= KEY.length; i++) assert.ok(!said.includes(KEY.slice(i, i + 12)), `cut ${cut}`);
  }
  for (let i = 0; i + 12 <= KEY.length; i++) assert.ok(!redact(`x ${KEY.slice(i, i + 12)} y`).includes(KEY.slice(i, i + 12)));
  assert.equal(redact("Tailscale didn't answer: listener already exists for port 8443"), "Tailscale didn't answer: listener already exists for port 8443");
  assert.equal(redact("/tmp/reach-501-abcdef012345/s"), "/tmp/reach-501-abcdef012345/s");
  assert.equal(redact(undefined), "");
});
