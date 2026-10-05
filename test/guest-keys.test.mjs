import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGuestKeys, GUEST_TAG } from "../server/guest-keys.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Invite keys against a fake Tailscale API: keys are single-use, tagged and
// lasting; guest devices are removed when their invitation ends or is
// revoked; nothing that isn't Reach's own guest device is ever touched.
function fakeTailscale({ secret = "tskey-client-abc-123", devices = [] } = {}) {
  const api = { calls: [], devices, keys: [], deleted: [], tokens: 0 };
  api.request = async (url, init = {}) => {
    const u = new URL(url);
    const route = u.pathname.replace("/api/v2", "");
    api.calls.push(`${init.method || "GET"} ${route}`);
    const json = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
    });
    if (route === "/oauth/token") {
      const form = new URLSearchParams(init.body);
      if (
        form.get("client_secret") !== secret ||
        form.get("grant_type") !== "client_credentials"
      )
        return json(401, { message: "invalid client" });
      api.tokens++;
      return json(200, {
        access_token: `token-${api.tokens}`,
        expires_in: 3600,
      });
    }
    if (!/^Bearer token-\d+$/.test(init.headers?.Authorization || ""))
      return json(401, {});
    if (route === "/tailnet/-/devices")
      return json(200, { devices: api.devices });
    if (route === "/tailnet/-/keys" && init.method === "POST") {
      const body = JSON.parse(init.body);
      const key = {
        id: `k${api.keys.length + 1}`,
        key: `tskey-auth-k${api.keys.length + 1}`,
        body,
      };
      api.keys.push(key);
      return json(200, { id: key.id, key: key.key });
    }
    if (route.startsWith("/tailnet/-/keys/") && init.method === "DELETE") {
      api.deleted.push(route);
      return json(200, {});
    }
    if (route.startsWith("/device/") && init.method === "DELETE") {
      const id = decodeURIComponent(route.slice(8));
      api.deleted.push(`device ${id}`);
      api.devices = api.devices.filter((d) => d.nodeId !== id);
      return json(200, {});
    }
    return json(404, { message: "not found" });
  };
  return api;
}

test("setup saves the OAuth client only after Tailscale accepts it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-keys-"));
  try {
    const api = fakeTailscale();
    const keys = createGuestKeys({
      dataDir: dir,
      self: "dev-a",
      request: api.request,
    });
    assert.equal(keys.configured(), false);
    await assert.rejects(
      keys.setup({ clientId: "id", clientSecret: "nope" }),
      /starts with tskey-client-/,
    );
    await assert.rejects(
      keys.setup({ clientId: "id", clientSecret: "tskey-client-wrong" }),
      /didn't accept the OAuth client/,
    );
    assert.equal(keys.configured(), false);
    await keys.setup({
      clientId: " id ",
      clientSecret: " tskey-client-abc-123 ",
    });
    assert.equal(keys.configured(), true);
    // The check made a short key and deleted it again.
    assert.deepEqual(api.deleted, ["/tailnet/-/keys/k1"]);
    const saved = fs.statSync(path.join(dir, "tailscale-oauth.json"));
    assert.equal(saved.mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, "tailscale-oauth.json"))),
      {
        version: 1,
        clientId: "id",
        clientSecret: "tskey-client-abc-123",
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one single-use, tagged, lasting key per invitation; devices removed when it ends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-keys-"));
  try {
    let clock = Date.parse("2026-10-05T10:00:00Z");
    const api = fakeTailscale();
    const keys = createGuestKeys({
      dataDir: dir,
      self: "dev-a",
      request: api.request,
      now: () => clock,
    });
    await keys.setup({ clientId: "id", clientSecret: "tskey-client-abc-123" });
    const tokensAfterSetup = api.tokens;
    const invite = await keys.createInvite({
      ttlSeconds: 3600,
      clientIds: ["guest-1"],
    });
    assert.match(invite.key, /^tskey-auth-/);
    assert.match(invite.hostname, new RegExp(`^${keys.prefix}[a-z0-9]{10}$`));
    assert.deepEqual(api.keys.at(-1).body, {
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: false,
            preauthorized: true,
            tags: [GUEST_TAG],
          },
        },
      },
      expirySeconds: 3600,
      description: `Reach guest ${invite.hostname.slice(keys.prefix.length)}`,
    });
    assert.equal(api.tokens, tokensAfterSetup, "the access token is reused");
    const created = new Date(clock).toISOString();
    const ours = {
      nodeId: "nGuest",
      hostname: invite.hostname,
      tags: [GUEST_TAG],
      created,
    };
    const repeat = {
      nodeId: "nGuest2",
      hostname: `${invite.hostname}-1`,
      tags: [GUEST_TAG],
      created,
    };
    const strangerOld = {
      nodeId: "nUnknown",
      hostname: `${keys.prefix}zzzzzzzzzz`,
      tags: [GUEST_TAG],
      created: "2026-10-01T00:00:00Z",
    };
    const strangerNew = {
      nodeId: "nFresh",
      hostname: `${keys.prefix}yyyyyyyyyy`,
      tags: [GUEST_TAG],
      created,
    };
    const otherMac = {
      nodeId: "nOtherMac",
      hostname: "rg-ffff-abcdefghij",
      tags: [GUEST_TAG],
      created: "2026-10-01T00:00:00Z",
    };
    const notGuest = {
      nodeId: "nLaptop",
      hostname: invite.hostname,
      tags: ["tag:server"],
      created: "2026-10-01T00:00:00Z",
    };
    const untagged = {
      nodeId: "nPhone",
      hostname: invite.hostname,
      created: "2026-10-01T00:00:00Z",
    };
    api.devices = [
      ours,
      repeat,
      strangerOld,
      strangerNew,
      otherMac,
      notGuest,
      untagged,
    ];
    // While the invitation lasts: only the old unknown guest device goes.
    assert.equal(await keys.reconcile(), 1);
    assert.deepEqual(
      api.devices.map((d) => d.nodeId),
      ["nGuest", "nGuest2", "nFresh", "nOtherMac", "nLaptop", "nPhone"],
    );
    // After it ends: both of its devices, and the now-old unknown one.
    clock += 3601 * 1000;
    assert.equal(await keys.reconcile(), 3);
    assert.deepEqual(
      api.devices.map((d) => d.nodeId),
      ["nOtherMac", "nLaptop", "nPhone"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revoking the guest removes their device at once; other invitations stay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-keys-"));
  try {
    const api = fakeTailscale();
    const keys = createGuestKeys({
      dataDir: dir,
      self: "dev-a",
      request: api.request,
    });
    await keys.setup({ clientId: "id", clientSecret: "tskey-client-abc-123" });
    const a = await keys.createInvite({
      ttlSeconds: 3600,
      clientIds: ["guest-a"],
    });
    const b = await keys.createInvite({
      ttlSeconds: 3600,
      clientIds: ["guest-b"],
    });
    const now = new Date().toISOString();
    api.devices = [
      { nodeId: "nA", hostname: a.hostname, tags: [GUEST_TAG], created: now },
      { nodeId: "nB", hostname: b.hostname, tags: [GUEST_TAG], created: now },
    ];
    assert.equal(await keys.revokeClient("someone-else"), 0);
    const keyOfA = api.keys.find((k) =>
      k.body.description.endsWith(a.hostname.slice(keys.prefix.length)),
    ).id;
    assert.equal(await keys.revokeClient("guest-a"), 1);
    assert.deepEqual(
      api.devices.map((d) => d.nodeId),
      ["nB"],
    );
    // The cancelled link's key is deleted, so it can't let anyone in later.
    assert.ok(api.deleted.includes(`/tailnet/-/keys/${keyOfA}`), JSON.stringify(api.deleted));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/guests with key: one link, no orphan invitation when keys aren't set up", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-keys-srv-"));
  const api = fakeTailscale();
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    port: 0,
    tailscaleOwner: { userId: "42", login: "o@example.test" },
    guestKeys: { request: api.request },
  });
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const before = reach.auth.list().length;
  await assert.rejects(
    reach.guestKeys.createInvite({ ttlSeconds: 600 }),
    /run \.\/reach invites/,
  );
  await reach.guestKeys.setup({
    clientId: "id",
    clientSecret: "tskey-client-abc-123",
  });
  const invite = await reach.guestKeys.createInvite({
    ttlSeconds: 600,
    clientIds: ["x"],
  });
  assert.match(invite.key, /^tskey-auth-/);
  assert.equal(reach.auth.list().length, before);
  assert.ok(owner.token);
});

test(
  "set up from the phone: checked with Tailscale, kept on the computer, never sent back; guests can't",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const http = await import("node:http");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-keys-phone-"));
    const socketDir = fs.mkdtempSync("/tmp/reach-keys-sock-");
    const socketPath = path.join(socketDir, "s");
    const api = fakeTailscale();
    const owner = { userId: "42", login: "o@example.test" };
    const whois = (node) => ({
      Node: { StableID: node, User: 42, Name: `${node}.t.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z" },
      UserProfile: { ID: 42, LoginName: owner.login },
    });
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, "private"),
      port: 0,
      publicOrigin: "https://mac-a.t.ts.net:8443",
      tailscaleOwner: owner,
      tailscaleIdentity: { lookup: async () => whois("nPhone") },
      tailscaleStatus: async () => ({ Self: { TailscaleIPs: ["100.64.0.5", "fd7a::5"] }, Peer: {} }),
      guestKeys: { request: api.request },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    await reach.listenPrivate(socketPath);
    t.after(async () => {
      await reach.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(socketDir, { recursive: true, force: true });
    });
    const phone = reach.auth.issue("My iPhone", ALL_SCOPES, "device", {
      tailscale: { userId: "42", nodeId: "nPhone" },
    });
    const call = (route, token, body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            path: route,
            method: body ? "POST" : "GET",
            headers: {
              Host: "localhost",
              "X-Forwarded-For": "100.64.0.9",
              "Tailscale-User-Login": owner.login,
              Authorization: `Bearer ${token}`,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
          },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, text, json: JSON.parse(text || "null") }));
          },
        );
        req.once("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    const before = await call("/api/guests/keys", phone.token);
    assert.deepEqual(before.json, {
      configured: false,
      policy: {
        tagOwners: { "tag:reach-guest": ["autogroup:admin"] },
        grants: [{ src: ["tag:reach-guest"], dst: ["100.64.0.5"], ip: ["tcp:8443"] }],
      },
    });
    const wrong = await call("/api/guests/keys", phone.token, { clientId: "id", clientSecret: "tskey-client-wrong" });
    assert.equal(wrong.status, 502);
    const ok = await call("/api/guests/keys", phone.token, { clientId: "id", clientSecret: "tskey-client-abc-123" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { configured: true });
    assert.doesNotMatch(ok.text + (await call("/api/guests/keys", phone.token)).text, /tskey-client/);
    assert.equal((await call("/api/guests/keys", phone.token)).json.configured, true);
    // An invited guest, even with full access, can't see or change it.
    const invite = reach.auth.inviteGuest({ name: "G", ttlSeconds: 600, full: true });
    const guest = reach.auth.redeemGuest(invite.invitation, { userId: "42", nodeId: "nPhone" });
    assert.equal((await call("/api/guests/keys", guest.token)).status, 403);
    assert.equal((await call("/api/guests/keys", guest.token, { clientId: "x", clientSecret: "tskey-client-x" })).status, 403);
  },
);
