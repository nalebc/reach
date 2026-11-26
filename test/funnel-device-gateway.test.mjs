import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createReach } from "../server/index.mjs";
import { openPairingWindow, readPairingWindowToken } from "../server/core.mjs";
import { approvalStore } from "../server/device-approval.mjs";
import { createPasskeys } from "../server/passkeys.mjs";
import { softAuthenticator } from "./helpers/soft-authenticator.mjs";
import { startDom } from "./dom/harness.mjs";

const PUBLIC_HOST = "studio.example.ts.net";
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const PRIVATE_ORIGIN = `https://${PUBLIC_HOST}:8443`;
const OWNER = { userId: "42", login: "sam@example.test" };

function makeDeviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const exported = publicKey.export({ format: "jwk" });
  const jwk = {
    crv: "P-256",
    kty: "EC",
    x: exported.x,
    y: exported.y,
  };
  const thumbprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(jwk))
    .digest("base64url");
  const sign = (text) =>
    crypto
      .sign(
        "sha256",
        Buffer.from(text, "utf8"),
        { key: privateKey, dsaEncoding: "ieee-p1363" },
      )
      .toString("base64url");
  return { jwk, thumbprint, sign };
}

async function createHost(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-funnel-dev-"));
  const socketDir = await fs.mkdtemp("/tmp/reach-fdg-");
  const socketPath = path.join(socketDir, "s");
  const dataDir = path.join(root, "private");
  await fs.writeFile(path.join(root, "hello.txt"), "hello world\n", "utf8");

  const nodes = new Map([
    [
      "100.64.0.10",
      {
        Node: {
          StableID: "nPhone",
          User: 42,
          ComputedName: "sam-phone",
          Name: "sam-phone.example.ts.net.",
          KeyExpiry: "0001-01-01T00:00:00Z",
        },
        UserProfile: { ID: 42, LoginName: OWNER.login },
      },
    ],
    [
      "100.64.0.99",
      {
        Node: {
          StableID: "nStranger",
          User: 99,
          ComputedName: "other-phone",
          Name: "other-phone.other.ts.net.",
          KeyExpiry: "0001-01-01T00:00:00Z",
        },
        UserProfile: { ID: 99, LoginName: "other@example.test" },
      },
    ],
  ]);

  const reach = await createReach({
    roots: [root],
    dataDir,
    port: 0,
    publicOrigin: PRIVATE_ORIGIN,
    allowedOrigins: [PUBLIC_ORIGIN],
    tailscaleOwner: OWNER,
    tailscaleIdentity: { lookup: async (ip) => nodes.get(ip) || null },
    browserHostGuard: {
      lookup: async () => ({
        BackendState: "Running",
        Self: { ID: "nHost", KeyExpiry: "0001-01-01T00:00:00Z" },
        Peer: {},
      }),
    },
    ...overrides,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  if (process.platform !== "win32") {
    await reach.listenPrivate(socketPath, {
      publicApp: (req, res) => {
        if (req.url === "/" || req.url === "/guest") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!doctype html><main id='start'></main>");
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found.");
      },
    });
  }

  t.after(async () => {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(socketDir, { recursive: true, force: true });
  });

  const rawRequest = ({
    method = "GET",
    path: routePath = "/",
    headers = {},
    body = undefined,
    internet = true,
    fromIp = "203.0.113.10",
  }) =>
    new Promise((resolve, reject) => {
      const buf =
        body === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(body)
            ? body
            : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      const req = http.request(
        {
          socketPath,
          method,
          path: routePath,
          headers: {
            Host: PUBLIC_HOST,
            "X-Forwarded-For": fromIp,
            ...(internet
              ? { "Tailscale-Funnel-Request": "?1", Origin: PUBLIC_ORIGIN }
              : { "Tailscale-User-Login": OWNER.login }),
            ...(buf.length > 0 && !headers["Content-Type"] && !headers["content-type"]
              ? { "Content-Type": "application/json" }
              : {}),
            ...(buf.length > 0 ? { "Content-Length": buf.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            const text = raw.toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              json,
              raw,
            });
          });
        },
      );
      req.once("error", reject);
      if (buf.length > 0) req.write(buf);
      req.end();
    });

  const signedFunnel = (
    key,
    method,
    routePath,
    {
      body = undefined,
      token = "",
      pairingToken = "",
      fromIp = "203.0.113.10",
      issuedAt = Date.now(),
      nonce = crypto.randomBytes(18).toString("base64url"),
    } = {},
  ) => {
    const rawBody =
      body === undefined || ["GET", "HEAD"].includes(method)
        ? Buffer.alloc(0)
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const bodySha256 = crypto.createHash("sha256").update(rawBody).digest("base64url");
    const payload = JSON.stringify({
      v: 1,
      audience: PUBLIC_ORIGIN,
      method,
      path: routePath,
      issuedAt,
      nonce,
      bodySha256,
    });
    const signature = key.sign(payload);
    return rawRequest({
      method,
      path: routePath,
      internet: true,
      fromIp,
      body: rawBody.length > 0 ? rawBody : undefined,
      headers: {
        "Reach-Device-Key": key.thumbprint,
        "Reach-Device-Payload": Buffer.from(payload, "utf8").toString("base64url"),
        "Reach-Device-Signature": signature,
        "Reach-Device-Jwk": Buffer.from(JSON.stringify(key.jwk), "utf8").toString("base64url"),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(pairingToken ? { "Reach-Pairing-Token": pairingToken } : {}),
      },
    });
  };

  return { root, dataDir, socketPath, reach, rawRequest, signedFunnel };
}

const unix = { skip: process.platform === "win32", timeout: 30000 };

test(
  "Funnel device gateway rejects strangers outside a pairing window and admits pairing + WS + uploads + downloads when approved",
  unix,
  async (t) => {
    const { dataDir, socketPath, reach, rawRequest, signedFunnel } = await createHost(t);
    const phoneKey = makeDeviceKey();

    // 1. Unsigned internet requests cannot reach private APIs or WebSockets.
    assert.equal((await rawRequest({ path: "/api/health?probe=1" })).status, 404);
    const rawWsReply = await new Promise((resolve) => {
      const socket = net.connect(socketPath, () =>
        socket.write(
          `GET /ws/presence HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nTailscale-Funnel-Request: ?1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        ),
      );
      let out = "";
      socket.on("data", (c) => (out += c));
      socket.on("close", () => resolve(out));
      socket.on("error", () => resolve(out));
    });
    assert.doesNotMatch(rawWsReply, /101 Switching/);

    // 2. Signed probe works on Funnel, and reports pairing closed when no window is open.
    const health = await signedFunnel(phoneKey, "GET", "/api/health?probe=1");
    assert.equal(health.status, 200);
    assert.equal(health.json?.transport, "funnel");

    const closedMethod = await signedFunnel(phoneKey, "GET", "/api/auth/method");
    assert.equal(closedMethod.status, 200);
    assert.equal(closedMethod.json?.transport, "funnel");
    assert.equal(closedMethod.json?.eligible, false);

    // Stranger cannot create an approval request or read /api/device when window is closed.
    const deniedReq = await signedFunnel(phoneKey, "POST", "/api/auth/requests", {
      body: { name: "My iPhone" },
    });
    assert.equal(deniedReq.status, 403);
    assert.equal(deniedReq.headers["reach-not-run"], "1");
    assert.equal((await signedFunnel(phoneKey, "GET", "/api/device")).status, 403);

    // 3. Open pairing window -> request approval -> approve on host -> collect token.
    openPairingWindow(dataDir);
    const pairingToken = readPairingWindowToken(dataDir);
    assert.match(pairingToken, /^[A-Za-z0-9_-]{43}$/);

    const openMethod = await signedFunnel(phoneKey, "GET", "/api/auth/method", { pairingToken });
    assert.equal(openMethod.json?.eligible, true);

    const created = await signedFunnel(phoneKey, "POST", "/api/auth/requests", {
      pairingToken,
      body: { name: "My iPhone" },
    });
    assert.equal(created.status, 202);
    assert.match(created.json?.verification, /^[0-9a-f]{8}$/);

    // Replay of exact signed nonce is rejected.
    const fixedNonce = crypto.randomBytes(18).toString("base64url");
    const firstPoll = await signedFunnel(
      phoneKey,
      "POST",
      `/api/auth/requests/${created.json.id}`,
      { body: { secret: created.json.secret }, nonce: fixedNonce },
    );
    assert.equal(firstPoll.status, 200);
    assert.equal(firstPoll.json?.status, "pending");
    const replayedPoll = await signedFunnel(
      phoneKey,
      "POST",
      `/api/auth/requests/${created.json.id}`,
      { body: { secret: created.json.secret }, nonce: fixedNonce },
    );
    assert.equal(replayedPoll.status, 409);

    // Host approves the verification code.
    approvalStore(dataDir).decide(created.json.id, "approve");
    const approved = await signedFunnel(
      phoneKey,
      "POST",
      `/api/auth/requests/${created.json.id}`,
      { body: { secret: created.json.secret } },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.json?.status, "approved");
    const token = approved.json.token;
    assert.ok(token);

    // Pairing window automatically closed after first device joined.
    assert.equal(reach.auth.pairingAdmission(), false);

    // 4. Enrolled Funnel device accesses workspace APIs, stream uploads, downloads, and live WebSockets!
    const otherKey = makeDeviceKey();
    assert.equal(
      (await signedFunnel(otherKey, "GET", "/api/device", { token })).status,
      403,
      "stolen bearer token without the device's P-256 private key is rejected",
    );

    const devRes = await signedFunnel(phoneKey, "GET", "/api/device", { token });
    assert.equal(devRes.status, 200);
    assert.equal(devRes.json?.access?.kind, "device");

    // Ticketed WebSocket (/ws/presence)
    const wsTicketRes = await signedFunnel(phoneKey, "POST", "/api/device/ws-ticket", {
      token,
      body: { path: "/ws/presence" },
    });
    assert.equal(wsTicketRes.status, 200);
    const wsTicket = wsTicketRes.json.ticket;

    const presenceMsg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${socketPath}:/ws/presence?ticket=${wsTicket}`, {
        headers: {
          Host: PUBLIC_HOST,
          Origin: PUBLIC_ORIGIN,
          "Tailscale-Funnel-Request": "?1",
        },
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token, kind: "phone" }));
      });
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === "presence") {
          ws.close();
          resolve(parsed);
        }
      });
      ws.on("error", reject);
    });
    assert.equal(presenceMsg.type, "presence");

    // Reusing the same single-use WS ticket fails immediately.
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws+unix://${socketPath}:/ws/presence?ticket=${wsTicket}`, {
          headers: {
            Host: PUBLIC_HOST,
            Origin: PUBLIC_ORIGIN,
            "Tailscale-Funnel-Request": "?1",
          },
        });
        ws.on("open", resolve);
        ws.on("error", reject);
        ws.on("close", () => reject(new Error("closed")));
      }),
    );

    // Single-use stream ticket for chunked binary upload + download link over Funnel
    const startUpload = await signedFunnel(phoneKey, "POST", "/api/files/uploads", {
      token,
      body: { root: 0, path: "", name: "uploaded.bin", size: 6 },
    });
    assert.equal(startUpload.status, 200);
    const uploadPath = `/api/files/uploads/${startUpload.json.id}?offset=0`;
    const streamTicketRes = await signedFunnel(phoneKey, "POST", "/api/device/stream-ticket", {
      token,
      body: { method: "PUT", path: uploadPath },
    });
    assert.equal(streamTicketRes.status, 200);
    const putRes = await rawRequest({
      method: "PUT",
      path: uploadPath,
      internet: true,
      body: Buffer.from("abcdef"),
      headers: {
        "Content-Type": "application/octet-stream",
        "Reach-Stream-Ticket": streamTicketRes.json.ticket,
      },
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.json?.offset, 6);
    const completeRes = await signedFunnel(
      phoneKey,
      "POST",
      `/api/files/uploads/${startUpload.json.id}/complete`,
      { token, body: {} },
    );
    assert.equal(completeRes.status, 200);

    const dlLink = await signedFunnel(
      phoneKey,
      "GET",
      "/api/files/download-link?root=0&path=uploaded.bin",
      { token },
    );
    assert.equal(dlLink.status, 200);
    const downloaded = await rawRequest({ path: dlLink.json.url, internet: true });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.text, "abcdef");

    // 5. Flood of stranger traffic pauses strangers while enrolled device keeps working!
    let floodStatus = 0;
    for (let i = 0; i < 305; i++) {
      const strangerKey = makeDeviceKey();
      const r = await signedFunnel(strangerKey, "GET", "/api/health?probe=1", {
        fromIp: `198.51.100.${(i % 200) + 1}`,
      });
      if (r.status === 429) {
        floodStatus = 429;
        break;
      }
    }
    assert.equal(floodStatus, 429, "stranger flood triggers global stranger rate limit");
    const enrolledDuringFlood = await signedFunnel(phoneKey, "GET", "/api/device", { token });
    assert.equal(enrolledDuringFlood.status, 200, "enrolled Funnel device is unaffected by stranger flood");

    // 6. Revoking client immediately cuts off Funnel device access.
    const clientEntry = reach.auth.list().find((c) => c.kind === "device");
    const revokeRes = await signedFunnel(
      phoneKey,
      "DELETE",
      `/api/clients/${clientEntry.id}`,
      { token },
    );
    assert.equal(revokeRes.status, 200);
    assert.equal((await signedFunnel(phoneKey, "GET", "/api/device", { token })).status, 401);
  },
);

test(
  "bi-directional private <-> Funnel server binding: Funnel-first upgrades to private Tailscale, and private-first binds Funnel fallback",
  unix,
  async (t) => {
    const { dataDir, rawRequest, signedFunnel } = await createHost(t);

    // Part A: Funnel-first enrollment -> Tailscale turns on -> bind-private upgrades same grant!
    openPairingWindow(dataDir);
    const funnelKey = makeDeviceKey();
    const reqA = await signedFunnel(funnelKey, "POST", "/api/auth/requests", {
      body: { name: "Sam iPad" },
    });
    approvalStore(dataDir).decide(reqA.json.id, "approve");
    const pollA = await signedFunnel(funnelKey, "POST", `/api/auth/requests/${reqA.json.id}`, {
      body: { secret: reqA.json.secret },
    });
    const tokenA = pollA.json.token;

    // Before bind-private, private Tailscale rejects tokenA because no tailscale nodeId is bound yet.
    const preBind = await rawRequest({
      path: "/api/device",
      internet: false,
      fromIp: "100.64.0.10",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(preBind.status, 401);

    // Wrong Tailscale account cannot bind-private onto owner's Funnel grant.
    const issuedAt = Date.now();
    const wrongNonce = crypto.randomBytes(18).toString("base64url");
    const wrongSig = funnelKey.sign(
      `reach-bind-private-v1\n${PUBLIC_HOST}\n${funnelKey.thumbprint}\n${issuedAt}\n${wrongNonce}`,
    );
    const wrongAccount = await rawRequest({
      method: "POST",
      path: "/api/device/bind-private",
      internet: false,
      fromIp: "100.64.0.99",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        keyThumbprint: funnelKey.thumbprint,
        issuedAt,
        nonce: wrongNonce,
        signature: wrongSig,
      },
    });
    assert.equal(wrongAccount.status, 403);

    // Owner's Tailscale node binds cleanly with valid P-256 signature proof.
    const bindNonce = crypto.randomBytes(18).toString("base64url");
    const bindSig = funnelKey.sign(
      `reach-bind-private-v1\n${PUBLIC_HOST}\n${funnelKey.thumbprint}\n${issuedAt}\n${bindNonce}`,
    );
    const bound = await rawRequest({
      method: "POST",
      path: "/api/device/bind-private",
      internet: false,
      fromIp: "100.64.0.10",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        keyThumbprint: funnelKey.thumbprint,
        issuedAt,
        nonce: bindNonce,
        signature: bindSig,
      },
    });
    assert.equal(bound.status, 200);

    // Now BOTH private Tailscale AND Signed Public Funnel work with tokenA!
    assert.equal(
      (
        await rawRequest({
          path: "/api/device",
          internet: false,
          fromIp: "100.64.0.10",
          headers: { Authorization: `Bearer ${tokenA}` },
        })
      ).status,
      200,
    );
    assert.equal((await signedFunnel(funnelKey, "GET", "/api/device", { token: tokenA })).status, 200);

    // Part B: Private-first device binds its Funnel P-256 key silently via /api/device/funnel-key
    const privReq = await rawRequest({
      method: "POST",
      path: "/api/auth/requests",
      internet: false,
      fromIp: "100.64.0.10",
      body: { name: "Sam iPhone" },
    });
    approvalStore(dataDir).decide(privReq.json.id, "approve");
    const privPoll = await rawRequest({
      method: "POST",
      path: `/api/auth/requests/${privReq.json.id}`,
      internet: false,
      fromIp: "100.64.0.10",
      body: { secret: privReq.json.secret },
    });
    const tokenB = privPoll.json.token;
    const deviceId = privPoll.json.device.id;

    const privFunnelKey = makeDeviceKey();
    const fkNonce = crypto.randomBytes(18).toString("base64url");
    const fkSig = privFunnelKey.sign(
      `reach-bind-funnel-v1\n${deviceId}\n${privFunnelKey.thumbprint}\n${issuedAt}\n${fkNonce}`,
    );
    const fkRes = await rawRequest({
      method: "POST",
      path: "/api/device/funnel-key",
      internet: false,
      fromIp: "100.64.0.10",
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        publicKey: privFunnelKey.jwk,
        issuedAt,
        nonce: fkNonce,
        signature: fkSig,
      },
    });
    assert.equal(fkRes.status, 200);
    assert.equal(
      (await signedFunnel(privFunnelKey, "GET", "/api/device", { token: tokenB })).status,
      200,
      "private-enrolled device immediately works over Funnel when Tailscale turns off",
    );
  },
);

test(
  "Face ID 1-tap passkey sign-in and guest invitation redemption work directly over Signed Public Funnel",
  unix,
  async (t) => {
    const { dataDir, reach, signedFunnel } = await createHost(t);
    const passkeys = createPasskeys({
      dataDir,
      rpId: PUBLIC_HOST,
      origins: [PRIVATE_ORIGIN, PUBLIC_ORIGIN],
    });
    const authenticator = softAuthenticator({ origin: PUBLIC_ORIGIN });
    passkeys.register(
      "c1",
      authenticator.create(passkeys.registrationOptions("c1", OWNER.login)),
      "Sam iPhone",
    );

    // 1. Face ID works over Funnel even when pairing window is CLOSED!
    assert.equal(reach.auth.pairingAdmission(), false);
    const browserKey = makeDeviceKey();
    const method = await signedFunnel(browserKey, "GET", "/api/auth/method");
    assert.equal(method.json?.faceId, true);

    const opts = await signedFunnel(browserKey, "POST", "/api/auth/face-passkey/options", {
      body: {},
    });
    assert.equal(opts.status, 200);
    assert.ok(opts.json?.id);

    const credential = authenticator.get(opts.json.options);
    const joined = await signedFunnel(browserKey, "POST", "/api/auth/face-passkey/join", {
      body: { id: opts.json.id, credential, name: "Safari iPhone" },
    });
    assert.equal(joined.status, 200);
    assert.equal(
      (await signedFunnel(browserKey, "GET", "/api/device", { token: joined.json.token })).status,
      200,
    );

    // 2. Guest invitation redeems over Signed Public Funnel without Tailscale!
    const invite = reach.auth.inviteGuest({
      name: "Alex",
      ttlSeconds: 3600,
      folders: [{ root: 0, path: "" }],
    });
    const guestKey = makeDeviceKey();
    const guestRedeem = await signedFunnel(guestKey, "POST", "/api/guest/redeem", {
      body: { invitation: invite.invitation },
    });
    assert.equal(guestRedeem.status, 200);
    const guestDev = await signedFunnel(guestKey, "GET", "/api/device", {
      token: guestRedeem.json.token,
    });
    assert.equal(guestDev.status, 200);
    assert.equal(guestDev.json?.access?.kind, "guest");
  },
);

test(
  "client private-first probe and live Private <-> Funnel handoff preserve workspaceKey without replaying mutations",
  async () => {
    const dom = await startDom({ url: PUBLIC_ORIGIN });
    const oldEventTarget = globalThis.EventTarget;
    globalThis.EventTarget = dom.window.EventTarget;
    const config = {
      product: "Reach",
      origin: PRIVATE_ORIGIN,
      home: PUBLIC_ORIGIN,
      name: "Studio",
      instance: "inst-1",
      tailnet: null,
    };
    const devPayload = {
      id: "mac-1",
      computerId: "comp-1",
      name: "Studio",
      platform: "darwin",
      access: { kind: "device", scopes: ["admin", "files"], expiresAt: Date.now() + 60_000 },
      network: { connected: true, peers: [] },
      capabilities: { files: true },
    };
    const state = { privateUp: false, boundPrivate: false };
    const calls = [];
    const rawFetch = async (input, init = {}) => {
      const url = new URL(String(input), PUBLIC_ORIGIN);
      const isSignedFunnel = new Headers(init.headers).has("Reach-Device-Key");
      calls.push({
        url: url.href,
        method: init.method || "GET",
        funnel: isSignedFunnel,
      });
      if (isSignedFunnel) {
        if (url.pathname === "/api/health")
          return Response.json({ product: "Reach", instance: "inst-1", transport: "funnel" });
        if (url.pathname === "/api/device") return Response.json(devPayload);
        return Response.json({}, { status: 404 });
      }
      if (!state.privateUp) {
        return new Response("Not found.", { status: 404 });
      }
      if (url.pathname === "/api/health")
        return Response.json({ product: "Reach", instance: "inst-1", transport: "private" });
      if (url.pathname === "/api/device/bind-private" && init.method === "POST") {
        state.boundPrivate = true;
        return Response.json({ ok: true, device: devPayload });
      }
      if (url.pathname === "/api/device") {
        if (!state.boundPrivate) return Response.json({ error: "unbound" }, { status: 401 });
        return Response.json(devPayload);
      }
      return Response.json({}, { status: 404 });
    };
    dom.window.fetch = rawFetch;

    try {
      const devTransport = await dom.load("/src/device-transport.ts");
      const { createPrivateRecovery } = await dom.load("/src/app-watch.ts");
      const transport = await dom.load("/src/tailnet-transport.ts");

      // 1. Private-first probe fails rapidly when Tailscale is off, and Funnel probe succeeds!
      const t0 = Date.now();
      const privHit = await devTransport.probePrivateOrigin([PUBLIC_ORIGIN, PRIVATE_ORIGIN], {
        timeoutMs: 850,
        expectedInstance: "inst-1",
        fetcher: rawFetch,
      });
      assert.equal(privHit, null);
      assert.ok(Date.now() - t0 < 850);

      // Activate Funnel transport (Funnel-first session).
      devTransport.activateFunnelTransport(PUBLIC_ORIGIN, "funnel");
      dom.document.documentElement.dataset.connection = "funnel";

      let current = {
        peer: {
          id: "mac-1",
          computerId: "comp-1",
          name: "Studio",
          url: PUBLIC_ORIGIN,
          token: "UNIFIED_TOKEN",
          platform: "darwin",
        },
        device: structuredClone(devPayload),
      };
      const saved = [{ ...current.peer }];
      const handoffs = [];
      const recovery = createPrivateRecovery(config, {
        current: () => current,
        selected: () => current.peer,
        peers: () => saved,
        nativeFetch: rawFetch,
        funnel: {
          fetch: (input, init) => devTransport.funnelDeviceFetch(PUBLIC_ORIGIN, input, init),
          activate: (originUrl) => devTransport.activateFunnelTransport(originUrl, "funnel"),
          bindPrivate: async (privOrigin, tok) => {
            const res = await rawFetch(`${privOrigin}/api/device/bind-private`, {
              method: "POST",
              headers: { Authorization: `Bearer ${tok}` },
            });
            return res.ok;
          },
        },
        handoff(change) {
          handoffs.push(change);
          current = { peer: change.peer, device: change.device };
        },
      });

      // 2. Tailscale turns ON -> auto-binds private identity & upgrades to "native"!
      state.privateUp = true;
      await recovery.check();
      assert.equal(handoffs.length, 1);
      assert.equal(handoffs[0].mode, "native");
      assert.equal(transport.privateWay(), "native");
      assert.equal(dom.document.documentElement.dataset.connection, undefined);
      const preservedKey = current.peer.workspaceKey;
      assert.ok(preservedKey, "workspaceKey is preserved across Funnel -> Private upgrade");

      // 3. Tailscale turns OFF -> rapidly falls back to "funnel" keeping the exact same workspaceKey!
      state.privateUp = false;
      await recovery.check();
      assert.equal(handoffs.length, 2);
      assert.equal(handoffs[1].mode, "funnel");
      assert.equal(transport.privateWay(), "funnel");
      assert.equal(dom.document.documentElement.dataset.connection, "funnel");
      assert.equal(current.peer.workspaceKey, preservedKey);

      recovery.stop();
    } finally {
      globalThis.EventTarget = oldEventTarget;
      await dom.close();
    }
  },
);
