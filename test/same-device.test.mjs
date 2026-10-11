import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createReach } from "../server/index.mjs";
import { approvalStore, sameDevice } from "../server/device-approval.mjs";
import { DevicePresence } from "../server/presence.mjs";

// The same phone in different browsers is one device: approved once, shown
// once. Browsers sharing the phone's Tailscale app are the same Tailscale
// device; browsers that signed in on their own are matched by their name.
const owner = { userId: "42", login: "owner@example.test" };
// This Mac's own Tailscale status, as Reach reads it.
const macStatus = { BackendState: "Running", Self: { ID: "nMac", KeyExpiry: "0001-01-01T00:00:00Z" }, Peer: {} };
const whois = (node, name) => ({
  Node: { StableID: node, User: 42, ComputedName: name, Name: `${name}.t.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z" },
  UserProfile: { ID: 42, LoginName: owner.login },
});

test(
  "another browser on an approved phone asks you once and is counted once",
  { skip: process.platform === "win32", timeout: 20000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-same-"));
    const socketDir = await fs.mkdtemp("/tmp/reach-same-sock-");
    const socketPath = path.join(socketDir, "s");
    const dataDir = path.join(root, "private");
    const devices = new Map([
      ["100.64.0.1", whois("nPhoneApp", "owner-iphone")],
      ["100.64.0.2", whois("nSafari", "iphone-browser")],
      ["100.64.0.3", whois("nChrome", "iphone-browser-1")],
      ["100.64.0.4", whois("nIpad", "ipad-browser")],
    ]);
    const reach = await createReach({
      roots: [root],
      dataDir,
      port: 0,
      tailscaleOwner: owner,
      tailscaleIdentity: { lookup: async (ip) => devices.get(ip) },
      browserHostGuard: { lookup: async () => macStatus },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    await reach.listenPrivate(socketPath);
    const call = (route, from, body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            path: route,
            method: "POST",
            headers: { Host: "localhost", "X-Forwarded-For": from, "Tailscale-User-Login": owner.login, "Content-Type": "application/json" },
          },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "null") }));
          },
        );
        req.once("error", reject);
        req.end(JSON.stringify(body));
      });
    const connect = async (from, approve = false) => {
      const r = (await call("/api/auth/requests", from, { name: "My iPhone" })).json;
      if (approve) approvalStore(dataDir).decide(r.id, "approve");
      return { request: r, result: (await call(`/api/auth/requests/${r.id}`, from, { secret: r.secret })).json };
    };
    try {
      // Safari, through the Tailscale app: approved in the terminal.
      const first = await connect("100.64.0.1", true);
      assert.equal(first.result.status, "approved");
      // Chrome on the same phone, same Tailscale app: its identity alone
      // proves nothing (anything on this Mac can claim it), so you approve it.
      const second = await connect("100.64.0.1");
      assert.equal(second.result.status, "pending");
      approvalStore(dataDir).decide(second.request.id, "approve");
      assert.equal((await call(`/api/auth/requests/${second.request.id}`, "100.64.0.1", { secret: second.request.secret })).json.status, "approved");
      // Browser sign-in (no app): Safari approved in the terminal; then a
      // second browser on that iPhone joins as the same device once approved.
      assert.equal((await connect("100.64.0.2", true)).result.status, "approved");
      const chrome = await connect("100.64.0.3");
      assert.equal(chrome.result.status, "pending", "a different Tailscale device still asks you");
      approvalStore(dataDir).decide(chrome.request.id, "approve");
      assert.equal((await call(`/api/auth/requests/${chrome.request.id}`, "100.64.0.3", { secret: chrome.request.secret })).json.status, "approved");
      const devicesNow = () => reach.auth.list().filter((c) => c.kind === "device");
      let clients = devicesNow();
      const group = (node) => devicesNow().find((c) => c.tailscale.nodeId === node)?.deviceGroup;
      assert.equal(group("nChrome"), "nSafari", "joined Safari's device");
      assert.equal(group("nSafari"), undefined);
      assert.equal(clients.filter((c) => c.tailscale.nodeId === "nPhoneApp").length, 2);
      // An iPad isn't an iPhone.
      await connect("100.64.0.4", true);
      assert.equal(group("nIpad"), undefined);
      clients = devicesNow();
      assert.equal(clients.length, 5);

      // Connected devices: the app phone once, the browser iPhone once, the iPad.
      const presence = new DevicePresence();
      const viewer = clients.find((c) => c.tailscale.nodeId === "nIpad");
      for (const [i, c] of clients.entries()) presence.add({ i }, { ...c, scopes: ["admin"] }, "phone");
      const snapshot = presence.snapshot({ ...viewer, scopes: ["admin"] });
      assert.equal(snapshot.devices.length, 3);
    } finally {
      await reach.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  },
);

// A process on this Mac can claim any of your devices' identities on Reach's
// private socket (it's handed the address it claims), and whatever runs on the
// Mac has the Mac's own. So an identity alone approves nothing, ever: not the
// Mac, not an approved phone (security audit, Oct 9; connections audit,
// Oct 10). Face ID, your approval and a linked computer's ticket do.
test(
  "identity alone approves nothing, and owner routes stay shut while an agent has this Mac",
  { skip: process.platform === "win32", timeout: 20000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-vouch-"));
    const socketDir = await fs.mkdtemp("/tmp/reach-vouch-sock-");
    const socketPath = path.join(socketDir, "s");
    const dataDir = path.join(root, "private");
    const devices = new Map([
      ["100.64.0.1", whois("nPhoneApp", "owner-iphone")],
      ["100.64.0.9", whois("nMac", "owner-mac")],
    ]);
    let reach = null, agent = null;
    reach = await createReach({
      roots: [root],
      dataDir,
      port: 0,
      tailscaleOwner: owner,
      tailscaleIdentity: { lookup: async (ip) => devices.get(ip) },
      browserHostGuard: { lookup: async () => macStatus, clients: () => [...(reach?.auth.list() || []), ...(agent ? [agent] : [])] },
    });
    await reach.listenPrivate(socketPath);
    const call = (route, from, body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { socketPath, path: route, method: "POST",
            headers: { Host: "localhost", "X-Forwarded-For": from, "Tailscale-User-Login": owner.login, "Content-Type": "application/json" } },
          (res) => { let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text || "null") })); },
        );
        req.once("error", reject);
        req.end(JSON.stringify(body));
      });
    const connect = async (from, approve = false) => {
      const r = (await call("/api/auth/requests", from, { name: "Mine" })).json;
      if (approve) approvalStore(dataDir).decide(r.id, "approve");
      return (await call(`/api/auth/requests/${r.id}`, from, { secret: r.secret })).json.status;
    };
    try {
      for (const from of ["100.64.0.9", "100.64.0.1"]) {
        assert.equal(await connect(from, true), "approved");
        assert.equal(await connect(from), "pending", `${from}: an approved device's identity alone`);
      }
      // A ticket no linked computer issued is refused outright.
      assert.equal((await call("/api/auth/requests", "100.64.0.1", { name: "Mine", ticket: "made-up" })).status, 403);
      // The old question "would you let me in by myself?" is gone: like any
      // unknown route, it wants a credential.
      assert.equal((await call("/api/auth/vouched", "100.64.0.1", {})).status, 401);
      // A Full control agent has this Mac: owner routes are closed to it.
      agent = { id: "a1", kind: "agent", policy: { browser: true, preset: "full" }, expiresAt: Date.now() + 60000 };
      assert.equal((await call("/api/auth/requests", "100.64.0.1", { name: "Mine" })).status, 403);
    } finally {
      await reach.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  },
);

test("matching by name only for browser sign-ins of the same kind", () => {
  const auth = {
    list: () => [
      { kind: "device", tailscale: { userId: "42", nodeId: "nA" }, nodeName: "iphone-browser", expiresAt: Date.now() + 1e6 },
      { kind: "device", tailscale: { userId: "42", nodeId: "nB" }, nodeName: "owner-iphone", expiresAt: Date.now() + 1e6 },
      { kind: "device", tailscale: { userId: "7", nodeId: "nC" }, nodeName: "ipad-browser", expiresAt: Date.now() + 1e6 },
      { kind: "guest", tailscale: { userId: "42", nodeId: "nD" }, nodeName: "android-browser", expiresAt: Date.now() + 1e6 },
    ],
  };
  const req = (nodeId, nodeName, userId = "42") => ({ identity: { userId, nodeId }, nodeName });
  assert.deepEqual(sameDevice(auth, req("nX", "iphone-browser-2")), { deviceGroup: "nA" });
  assert.deepEqual(sameDevice(auth, req("nB", "whatever")), { deviceGroup: "nB" });
  assert.deepEqual(sameDevice(auth, req("nY", "owner-iphone-1")), {}, "app devices are never matched by name");
  assert.deepEqual(sameDevice(auth, req("nZ", "ipad-browser")), {}, "another account's device");
  assert.deepEqual(sameDevice(auth, req("nW", "android-browser")), {}, "guests don't count");
});
