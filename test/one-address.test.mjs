import nodeTest from "node:test";
// This file exercises Serve's private Unix-socket ingress.
const test = (name, options, fn) => typeof options === "function"
  ? nodeTest(name, { skip: process.platform === "win32" && "Unix Serve ingress" }, options)
  : nodeTest(name, options, fn);
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { listenPrivateIngress } from "../server/tailscale-auth.mjs";
import { publicStartHandler } from "../server/public-start.mjs";
import { createReach } from "../server/index.mjs";

// One address for everything (https://<computer>.<tailnet>.ts.net): Tailscale
// sends your devices' requests and, through Funnel, the internet's to Reach's
// one private listener. Tailscale marks the internet's (and strips the mark
// from anything else), so each request is sorted on its own: the internet only
// ever gets the start page, never Reach.
const FUNNEL = { "Tailscale-Funnel-Request": "?1" };

async function ingress(t, { publicApp } = {}) {
  const dir = await fs.mkdtemp("/tmp/reach-one-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "s");
  const seen = { app: [], public: [], upgrade: [], identity: 0 };
  const server = await listenPrivateIngress({
    socketPath,
    app: (req, res) => {
      seen.app.push([req.url, req.reachIdentity?.nodeId, req.socket.n]);
      res.end("reach");
    },
    upgrade: (req, socket) => {
      seen.upgrade.push(req.url);
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    },
    resolveIdentity: async () => (seen.identity++, { nodeId: "phone" }),
    ...(publicApp
      ? {
          publicApp: (req, res) => {
            seen.public.push([req.url, req.socket.n]);
            res.end("start page");
          },
        }
      : {}),
  });
  let connections = 0;
  server.on("connection", (socket) => (socket.n = ++connections));
  t.after(() => new Promise((r) => server.close(r)));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const get = (url, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ socketPath, agent, path: url, headers: { Host: "mac.t.ts.net", ...headers } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        })
        .once("error", reject);
    });
  const upgrade = (url, headers = {}) =>
    new Promise((resolve) => {
      const socket = net.connect(socketPath);
      let got = "";
      socket.on("data", (c) => (got += c));
      socket.on("close", () => resolve(got));
      socket.on("error", () => {});
      socket.write(
        `GET ${url} HTTP/1.1\r\nHost: mac.t.ts.net\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("")}\r\n`,
      );
    });
  return { seen, get, upgrade, connections: () => connections };
}

test("each request is sorted on its own, even on one reused connection", async (t) => {
  const { seen, get, connections } = await ingress(t, { publicApp: true });
  assert.equal((await get("/", FUNNEL)).body, "start page");
  assert.equal((await get("/", {})).body, "reach");
  assert.equal((await get("/api/health", FUNNEL)).body, "start page");
  assert.equal((await get("/api/health", { "Tailscale-Funnel-Request": "" })).body, "start page", "any value counts as marked");
  assert.equal(connections(), 1, "all four came over one connection");
  // The internet never reached Reach, and was never looked up as a device.
  assert.deepEqual(seen.app, [["/", "phone", 1]]);
  assert.deepEqual(seen.public, [["/", 1], ["/api/health", 1], ["/api/health", 1]]);
  assert.equal(seen.identity, 1);
});

test("without a start page (no Funnel set up), the internet gets nothing", async (t) => {
  const { seen, get } = await ingress(t);
  const r = await get("/api/health", FUNNEL);
  assert.equal(r.status, 404);
  assert.deepEqual(seen.app, []);
  assert.equal(seen.identity, 0);
  assert.equal((await get("/api/health")).body, "reach", "your devices still get Reach");
});

test("the start page names the one address, so the browser path uses Reach there too", async (t) => {
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), "reach-one-dist-"));
  t.after(() => fs.rm(dist, { recursive: true, force: true }));
  const config = async (options) => {
    const handler = publicStartHandler({ dist, tailnetDir: null, privateOrigin: "https://mac.t.ts.net:8443", name: "Mac", instance: "i1", ...options });
    const server = http.createServer(handler).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/reach-start.json`, { headers: { Host: "mac.t.ts.net" } });
      return r.json();
    } finally {
      server.close();
    }
  };
  const one = await config({ home: "https://mac.t.ts.net" });
  assert.equal(one.home, "https://mac.t.ts.net");
  assert.equal(one.origin, "https://mac.t.ts.net:8443", "invitations and older pages keep the private address");
  assert.equal("home" in (await config({})), false, "no one address: not named");
});

// As the launcher wires it: Reach itself, with the start page for the internet.
test("Reach at the one address: your phone gets Reach, the internet only the start page", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-one-root-"));
  const dir = await fs.mkdtemp("/tmp/reach-one-");
  t.after(() => Promise.all([root, dir].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const dist = path.join(root, "dist");
  await fs.mkdir(dist);
  await fs.writeFile(path.join(dist, "start.html"), "<!doctype html>start");
  const owner = { userId: "42", login: "owner@example.test" };
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, "private"),
    port: 0,
    publicOrigin: "https://mac.t.ts.net:8443",
    allowedOrigins: ["https://mac.t.ts.net"], // as the launcher adds it
    tailscaleOwner: owner,
    tailscaleIdentity: {
      lookup: async (ip) => {
        if (ip !== "100.64.0.1") throw Error("not on the tailnet");
        return {
          Node: { StableID: "nPhone", User: 42, Name: "phone.t.ts.net.", KeyExpiry: "0001-01-01T00:00:00Z" },
          UserProfile: { ID: 42, LoginName: owner.login },
        };
      },
    },
  });
  t.after(() => reach.close());
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const socketPath = path.join(dir, "s");
  await reach.listenPrivate(socketPath, {
    publicApp: publicStartHandler({ dist, tailnetDir: null, privateOrigin: "https://mac.t.ts.net:8443", home: "https://mac.t.ts.net", name: "Mac", instance: reach.instance }),
  });
  const get = (url, headers) =>
    new Promise((resolve, reject) => {
      http
        .get({ socketPath, path: url, headers: { Host: "mac.t.ts.net", ...headers } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        })
        .once("error", reject);
    });
  const phone = { "X-Forwarded-For": "100.64.0.1", "Tailscale-User-Login": owner.login, Origin: "https://mac.t.ts.net" };
  const health = await get("/api/health", phone);
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).instance, reach.instance, "Reach itself, at the address without a port");
  const method = JSON.parse((await get("/api/auth/method", phone)).body);
  assert.equal(method.eligible, true, "your phone is recognized there");
  // The internet (Funnel): the start page and its files, nothing of Reach.
  const internet = { "X-Forwarded-For": "203.0.113.9", "Tailscale-Funnel-Request": "?1" };
  assert.equal((await get("/", internet)).body, "<!doctype html>start");
  for (const p of ["/api/health", "/api/auth/method", "/api/device"]) {
    const r = await get(p, internet);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /instance|eligible/, p);
  }
  assert.equal(JSON.parse((await get("/reach-start.json", internet)).body).home, "https://mac.t.ts.net");
});

test("WebSockets from the internet are refused; yours go through", async (t) => {
  const { seen, upgrade } = await ingress(t, { publicApp: true });
  assert.equal(await upgrade("/ws/presence", FUNNEL), "", "closed without an answer");
  assert.deepEqual(seen.upgrade, []);
  assert.match(await upgrade("/ws/presence"), /101 Switching Protocols/);
  assert.deepEqual(seen.upgrade, ["/ws/presence"]);
  assert.equal(seen.identity, 1, "only your device was looked up");
});
