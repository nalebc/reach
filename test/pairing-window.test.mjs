import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createReach } from "../server/index.mjs";
import {
  ALL_SCOPES,
  PAIRING_WINDOW_MS,
  closePairingWindow,
  openPairingWindow,
  pairingWindowFile,
} from "../server/core.mjs";

// First-run matrix W1–W4, W8: the pairing window. A phone without the
// Tailscale app joins from the start page at the one address; the start page
// answers the internet only while a window is open, which the computer opens
// for a few minutes (./reach in a terminal, setup, ./reach pair) and the
// first device to get in closes.
const unix = { skip: process.platform === "win32", timeout: 30000 };
const owner = { userId: "42", login: "owner@example.test" };

async function host(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-pairing-"));
  const socketDir = await fs.mkdtemp("/tmp/reach-pw-");
  const socketPath = path.join(socketDir, "s");
  const dataDir = path.join(root, "private");
  const reach = await createReach({
    roots: [root],
    dataDir,
    port: 0,
    tailscaleOwner: owner,
    tailscaleIdentity: { lookup: async () => null },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  // The start page: what the internet gets while a window is open.
  await reach.listenPrivate(socketPath, {
    publicApp: (req, res) => {
      const page = ["/", "/guest"].includes(req.url);
      res.writeHead(page ? 200 : 404, { "Content-Type": "text/plain" });
      res.end(page ? "start page" : "Not found.");
    },
  });
  t.after(async () => {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(socketDir, { recursive: true, force: true });
  });
  // A request from the internet, as Tailscale Funnel marks it.
  const internet = (route = "/guest", headers = {}) =>
    new Promise((resolve, reject) =>
      http
        .get(
          {
            socketPath,
            path: route,
            headers: { Host: "mac.example.ts.net", "Tailscale-Funnel-Request": "?1", ...headers },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        )
        .once("error", reject),
    );
  const upgrade = () =>
    new Promise((resolve) => {
      const socket = net.connect(socketPath, () =>
        socket.write(
          "GET /ws/presence HTTP/1.1\r\nHost: mac.example.ts.net\r\nTailscale-Funnel-Request: ?1\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ),
      );
      let reply = "";
      socket.on("data", (c) => (reply += c));
      socket.on("close", () => resolve(reply));
      socket.on("error", () => resolve(reply));
      setTimeout(() => socket.destroy(), 1500);
    });
  return { reach, dataDir, internet, upgrade };
}

test("the invitation page needs a pairing window; owner bootstrap remains available", unix, async (t) => {
  const { reach, dataDir, internet, upgrade } = await host(t);
  assert.deepEqual(await internet(), { status: 404, body: "Not found." }, "no window: nothing");
  assert.deepEqual(await internet("/"), { status: 200, body: "start page" }, "the stable owner link opens without a window");
  assert.equal(reach.funnelWindow().open, false);

  const until = openPairingWindow(dataDir);
  assert.ok(until - Date.now() <= PAIRING_WINDOW_MS);
  // The public window is capped by the file's recorded write time. Some
  // filesystems record that just before the integer wall-clock millisecond.
  const written = Math.floor((await fs.stat(pairingWindowFile(dataDir))).mtimeMs);
  const window = reach.funnelWindow();
  assert.deepEqual({ open: window.open, until: window.until, reason: window.reason }, { open: true, until: Math.min(until, written + PAIRING_WINDOW_MS), reason: "pairing" });
  assert.deepEqual(await internet(), { status: 200, body: "start page" });
  // Only the start page: never Reach's own API or a live connection.
  assert.equal((await internet("/api/health")).status, 404);
  assert.doesNotMatch(await upgrade(), /101 Switching/);

  // The first device in closes it.
  reach.auth.issue("Phone", ALL_SCOPES, "device");
  await assert.rejects(fs.access(pairingWindowFile(dataDir)));
  assert.equal(reach.funnelWindow().open, false);
  assert.deepEqual(await internet(), { status: 404, body: "Not found." });
  assert.equal((await internet("/")).status, 200, "owner reopening works after setup closes the window");
});

test("a pairing window ends on its own, and never stays open longer than 15 minutes", unix, async (t) => {
  const { reach, dataDir, internet } = await host(t);
  openPairingWindow(dataDir, { now: () => Date.now() - PAIRING_WINDOW_MS - 1000 });
  assert.equal(reach.funnelWindow().open, false, "past its deadline");
  assert.equal((await internet()).status, 404);
  // A window file asking for longer (edited by hand) is held to 15 minutes.
  await fs.writeFile(pairingWindowFile(dataDir), JSON.stringify({ until: Date.now() + 86400000 }));
  const window = reach.funnelWindow();
  assert.equal(window.open, true);
  assert.ok(window.until <= Date.now() + PAIRING_WINDOW_MS);
  // Held to 15 minutes from when it was written, not from each look.
  const real = Date.now;
  t.mock.method(Date, "now", () => real() + 20 * 60_000);
  assert.equal(reach.funnelWindow().open, false, "20 minutes later: closed, whatever the file asks");
  assert.equal((await internet()).status, 404);
  t.mock.restoreAll();
  // A file dated in the future doesn't slide the 15 minutes along with it.
  const ahead = new Date(Date.now() + 86400000);
  await fs.utimes(pairingWindowFile(dataDir), ahead, ahead);
  assert.equal(reach.funnelWindow().open, false, "written tomorrow: closed");
  closePairingWindow(dataDir);
  assert.equal(reach.funnelWindow().open, false);
  // Nonsense in the file opens nothing.
  await fs.writeFile(pairingWindowFile(dataDir), "{not json");
  assert.equal(reach.funnelWindow().open, false);
});

test("an agent's or guest's credential doesn't close a pairing window", unix, async (t) => {
  const { reach, dataDir } = await host(t);
  openPairingWindow(dataDir);
  reach.auth.issue("Agent", ["files"], "agent");
  assert.equal(reach.funnelWindow().reason, "pairing");
});

test("someone who joined in the browser gets through the door with their own key; strangers don't", unix, async (t) => {
  const { reach, internet, upgrade } = await host(t);
  const grant = reach.auth.inviteGuest({ name: "Ali", ttlSeconds: 3600, folders: [{ root: 0, path: "" }] });
  assert.equal(reach.funnelWindow().reason, "invitation");
  reach.auth.redeemGuest(grant.invitation, null);
  // Joined: the door shuts to everyone again.
  assert.equal(reach.funnelWindow().open, false);
  assert.deepEqual(await internet(), { status: 404, body: "Not found." });
  // Their page asks for its key over the private connection, then carries it.
  const { key, expiresAt } = reach.auth.issueDoorKey(grant.clientId);
  assert.equal(expiresAt, grant.expiresAt);
  const cookie = { Cookie: `theme=dark; reach-door=${key}` };
  assert.deepEqual(await internet("/guest", cookie), { status: 200, body: "start page" });
  // Only the page's files: never Reach's API or a live connection.
  assert.equal((await internet("/api/health", cookie)).status, 404);
  assert.doesNotMatch(await upgrade(), /101 Switching/);
  // Someone else's guess, or an old key, gets nothing.
  assert.equal((await internet("/guest", { Cookie: `reach-door=${"x".repeat(43)}` })).status, 404);
  const { key: next } = reach.auth.issueDoorKey(grant.clientId);
  assert.equal((await internet("/guest", cookie)).status, 404, "asking again replaces the key");
  assert.equal((await internet("/guest", { Cookie: `reach-door=${next}` })).status, 200);
  // The key never shows in the access list.
  assert.equal(JSON.stringify(reach.auth.list()).includes("doorHash"), false);
  // Their access ends: their key does too.
  reach.auth.revoke(grant.clientId);
  assert.equal((await internet("/guest", { Cookie: `reach-door=${next}` })).status, 404);
  // Agents don't hold door keys.
  const agent = reach.auth.issue("Agent", ["files"], "agent");
  assert.throws(() => reach.auth.issueDoorKey(agent.clientId), { status: 403 });
  // Your own phone, signed in through the browser, keeps one like a guest.
  const phone = reach.auth.issue("Phone", ["admin"], "device");
  const own = reach.auth.issueDoorKey(phone.clientId);
  assert.equal((await internet("/guest", { Cookie: `reach-door=${own.key}` })).status, 200);
});

// W4: ./reach pair, against the Reach already running (in a terminal or in
// the background), reopens browser sign-in at the one address.
test("./reach pair opens a pairing window at the one address; without one, it says the app is needed", async (t) => {
  const { pairRunningHost } = await import("../scripts/pairing.mjs");
  const { atomicJson } = await import("../server/core.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-pair-window-"));
  const dataDir = path.join(root, ".reach/quick");
  const reach = await createReach({ roots: [root], dataDir });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const localUrl = `http://127.0.0.1:${reach.server.address().port}`;
  const status = { localUrl, origin: localUrl, dataDir, instance: reach.instance, name: "Studio" };
  const said = [];
  const qrs = [];
  const deps = { env: {}, print: (s) => said.push(s), qr: { generate: (url) => qrs.push(url) } };

  // Only the private address known: no window.
  atomicJson(path.join(root, ".reach/host-status.json"), status);
  await pairRunningHost(root, deps);
  await assert.rejects(fs.access(pairingWindowFile(dataDir)));
  assert.match(said.join("\n"), /needs the Tailscale app/);

  // The one address noted by the running Reach.
  atomicJson(path.join(root, ".reach/host-status.json"), { ...status, link: "https://studio.example.ts.net" });
  await pairRunningHost(root, deps);
  assert.equal(reach.funnelWindow().reason, "pairing");
  assert.match(qrs.at(-1), /^https:\/\/studio\.example\.ts\.net\/#pair=\d{8}&name=Studio$/);
  assert.match(said.at(-1), /sign in to Tailscale in its browser for the next 15 minutes/);

  // A linked computer's general link belongs to the fleet home. Its code
  // and pairing window still belong to this computer.
  atomicJson(path.join(root, ".reach/host-status.json"), {
    ...status, origin: "https://studio.example.ts.net:8443", link: "https://first.example.ts.net",
  });
  await pairRunningHost(root, deps);
  assert.match(qrs.at(-1), /^https:\/\/studio\.example\.ts\.net\/#pair=\d{8}&name=Studio$/);

  // A link that isn't a plain one address isn't trusted for it.
  closePairingWindow(dataDir);
  atomicJson(path.join(root, ".reach/host-status.json"), { ...status, link: "https://evil.example/phish?x=1" });
  await pairRunningHost(root, deps);
  await assert.rejects(fs.access(pairingWindowFile(dataDir)));
});

// W2 through the real way in: a phone asks, the computer approves, the phone
// collects its credential. A second browser on that same approved phone
// (its Home Screen copy), once approved, joins as that device and leaves the
// window alone.
test("a phone approved through the real request closes the window; the same phone's next browser doesn't", unix, async (t) => {
  const { approvalStore } = await import("../server/device-approval.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-pw-real-"));
  const socketDir = await fs.mkdtemp("/tmp/reach-pwr-");
  const socketPath = path.join(socketDir, "s");
  const dataDir = path.join(root, "private");
  const whois = (node, name) => ({
    Node: { StableID: node, User: 42, ComputedName: name, Name: `${name}.t.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z" },
    UserProfile: { ID: 42, LoginName: owner.login },
  });
  const devices = new Map([
    ["100.64.0.1", whois("nPhone", "owner-iphone")],
    ["100.64.0.2", whois("nOther", "other-iphone")],
  ]);
  const reach = await createReach({
    roots: [root],
    dataDir,
    port: 0,
    tailscaleOwner: owner,
    tailscaleIdentity: { lookup: async (ip) => devices.get(ip) },
    browserHostGuard: { lookup: async () => ({ BackendState: "Running", Self: { ID: "nMac", KeyExpiry: "0001-01-01T00:00:00Z" }, Peer: {} }) },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  await reach.listenPrivate(socketPath);
  t.after(async () => {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(socketDir, { recursive: true, force: true });
  });
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
          res.on("end", () => resolve(JSON.parse(text || "null")));
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify(body));
    });
  const connect = async (from, approve) => {
    const request = await call("/api/auth/requests", from, { name: "My iPhone" });
    if (approve) approvalStore(dataDir).decide(request.id, "approve");
    return call(`/api/auth/requests/${request.id}`, from, { secret: request.secret });
  };
  openPairingWindow(dataDir);
  assert.equal((await connect("100.64.0.1", true)).status, "approved");
  assert.equal(reach.funnelWindow().open, false, "the phone got in: closed");

  openPairingWindow(dataDir);
  // The same phone, another browser: its identity alone approves nothing
  // (connections audit, Oct 10), so you approve it; as that same device, it
  // leaves the window alone.
  assert.equal((await connect("100.64.0.1", false)).status, "pending");
  assert.equal((await connect("100.64.0.1", true)).status, "approved");
  assert.equal(reach.funnelWindow().reason, "pairing", "still open for the phone it's for");
});

// Oct 10, the owner: "my phone gets full control, I can control the laptop
// and all". The first phone you approve sees the screen at once, without a
// trip to Settings; a choice you made yourself stays.
test("your first approved phone gets screen viewing on; your own Settings choice is kept", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-first-screen-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "private");
  const reach = await createReach({ roots: [root], dataDir, port: 0 });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  try {
    assert.equal(reach.config.screen, false, "off until a phone of yours is in");
    reach.auth.issue("Agent", ["files"], "agent");
    assert.equal(reach.config.screen, false, "an agent isn't your phone");
    const phone = reach.auth.issue("iPhone", ALL_SCOPES, "device");
    assert.equal(reach.config.screen, true);
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const set = (screen) =>
      fetch(url + "/api/settings", {
        method: "POST",
        headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ screen }),
      });
    assert.equal((await set(false)).status, 200);
    assert.equal(reach.config.screen, false);
  } finally {
    await reach.close();
  }
  // Restarted, with that choice: the next device doesn't turn it back on.
  const again = await createReach({ roots: [root], dataDir, port: 0 });
  try {
    assert.equal(again.config.screen, false);
    again.auth.issue("iPad", ALL_SCOPES, "device");
    assert.equal(again.config.screen, false, "you turned it off");
  } finally {
    await again.close();
  }
});
