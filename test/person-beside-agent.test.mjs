import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Real HTTP/WS authorization through the private Unix ingress. WhoIs and
// daemon status are synthetic; no actual tailnet or desktop is touched.
test("people beside an active agent need bound identity and pinned-owner approval", {
  skip: process.platform === "win32" && "Private Unix ingress is POSIX-only", timeout: 30000,
}, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-person-beside-")));
  const socketDir = fs.mkdtempSync("/tmp/reach-person-socket-");
  const socketPath = path.join(socketDir, "s"), shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  const nodes = { 1: "phone", 2: "other", 3: "browser", 4: "native", 5: "late", 6: "host" };
  const identity = nodeId => ({ nodeId, userId: "42", tagged: false, validUntil: Date.now() + 600000 });
  let agent = null, reach;
  const peers = Object.fromEntries(Object.values(nodes).filter(id => id !== "host").map(id => [id,
    { ID: id, UserID: 42, OS: id === "phone" ? "iOS" : ["browser", "late"].includes(id) ? "js" : "darwin", Online: true }]));
  reach = await createReach({
    name: "Fixture Mac", roots: [shared], dataDir: path.join(root, "state"), screen: false, publicOrigin: "https://fixture.test:8443",
    tailscaleOwner: { userId: "42", login: "owner@example.test" },
    tailscaleIdentity: { lookup: async ip => ({ Node: { StableID: nodes[Number(ip.split(".").at(-1))], User: 42,
      Name: "fixture.test.ts.net.", KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: "owner@example.test" } }) },
    browserHostGuard: {
      lookup: async () => ({ BackendState: "Running", Self: { ID: "host" }, Peer: peers }),
      clients: () => [...(reach?.auth.list() || []), ...(agent ? [agent] : [])],
    },
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  await reach.listenPrivate(socketPath);
  const call = (route, { from = 1, token, method = "GET", body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: { Host: "fixture.test",
      "Tailscale-User-Login": "owner@example.test", "X-Forwarded-For": `100.64.0.${from}`, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); });
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(Error("fixture HTTP deadline")));
    req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const owner = reach.auth.issue("Owner phone", ALL_SCOPES, "device", { tailscale: identity("phone") });
  const other = reach.auth.issue("Other owner", ALL_SCOPES, "device", { tailscale: identity("other") });
  const invite = name => reach.auth.inviteGuest({ name, ttlSeconds: 600, full: true, fullControlVersion: 1 });
  const early = invite("Browser person"), nativeInvite = invite("Native person");
  const browser = reach.auth.redeemGuest(early.invitation, identity("browser"));
  const native = reach.auth.redeemGuest(nativeInvite.invitation, identity("native"));
  agent = { id: "active-agent", kind: "agent", policy: { browser: true, preset: "full", fullControlVersion: 1 }, expiresAt: Date.now() + 600000,
    browserAppApprover: { nodeId: "phone", userId: "42", clientId: owner.clientId } };
  // Pre-existing browser credentials cannot bypass by having a different node.
  const waiting = await call("/api/device", { from: 3, token: browser.token });
  assert.equal(waiting.status, 403); assert.equal(waiting.body.waiting, true, JSON.stringify(waiting.body));
  assert.equal((await call("/api/device", { from: 4, token: native.token })).status, 200);
  const ws = (from, token) => {
    const socket = new WebSocket(`ws+unix:${socketPath}:/ws/presence`, { headers: { Host: "fixture.test", "Tailscale-User-Login": "owner@example.test", "X-Forwarded-For": `100.64.0.${from}` }, handshakeTimeout: 5000 });
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    return socket;
  };
  await assert.rejects(once(ws(3, browser.token), "open"));
  const allow = (token, from = 1, id = browser.clientId) => call(`/api/guests/${id}/allow`, { from, token, method: "POST" });
  assert.equal((await allow(native.token, 4)).status, 403, "a person cannot approve another person");
  assert.equal((await allow(other.token, 2)).status, 403, "another owner is not the pinned supervisor");
  assert.equal((await allow(owner.token)).status, 200, "pinned owner approves while the agent remains active");
  assert.equal((await call("/api/device", { from: 3, token: browser.token })).status, 200);
  assert.notEqual((await call("/api/device", { from: 6, token: browser.token })).status, 200, "host cannot reuse a bound token");
  assert.equal((await call("/api/clients", { from: 3, token: browser.token })).status, 403);
  const live = ws(3, browser.token);
  const [message] = await once(live, "message");
  assert.equal(JSON.parse(String(message)).type, "presence");
  const late = invite("New browser person");
  const opened = await call("/api/guest/redeem", { from: 5, method: "POST", body: { invitation: late.invitation } });
  assert.equal(opened.status, 200); assert.equal(opened.body.waiting, true);
  const hostInvite = invite("Host attempt");
  assert.equal((await call("/api/guest/redeem", { from: 6, method: "POST", body: { invitation: hostInvite.invitation } })).status, 403);
  assert.ok(reach.auth.unopenedInvitation(hostInvite.invitation), "refusal does not spend the invitation");
  const closed = once(live, "close");
  reach.auth.revoke(browser.clientId);
  const [code] = await closed;
  assert.notEqual(code, 1000, "ongoing authorization ends the revoked live connection");
  agent = null;
  assert.equal((await call("/api/device", { from: 5, token: opened.body.token })).body.waiting, true, "ending the agent does not substitute for approval");
  assert.equal((await call("/api/device/access", { from: 5, token: opened.body.token, method: "DELETE" })).status, 200);
});
