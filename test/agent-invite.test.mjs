import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { createGuestKeys, GUEST_TAG } from "../server/guest-keys.mjs";

// Inviting an agent from the phone: its own folders and access, joined once
// within a short window, bound to the Tailscale device that joined, and never
// screen, apps, your terminals or managing access.

async function start(t, { policy } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-invite-"));
  const files = path.join(dir, "files");
  for (const d of ["Projects/acme", "Projects/other"])
    fs.mkdirSync(path.join(files, d), { recursive: true });
  fs.writeFileSync(path.join(files, "Projects/acme/brief.txt"), "brief");
  fs.writeFileSync(path.join(files, "Projects/other/secret.txt"), "secret");
  const agentPolicyFile = path.join(dir, "agent-policy.json");
  if (policy)
    fs.writeFileSync(
      agentPolicyFile,
      JSON.stringify({
        version: 1,
        profiles: { work: { scopes: ["files:read"], roots: [files] } },
      }),
    );
  const reach = await createReach({
    roots: [files],
    dataDir: path.join(dir, "private"),
    agentPolicyFile,
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({
      status: r.status,
      body: await r.json().catch(() => null),
    }));
  const invite = (extra = {}) =>
    call("/api/agents/invitations", {
      method: "POST",
      body: {
        name: "Builder",
        ttlSeconds: 7 * 86400,
        folders: [{ root: 0, path: "Projects/acme" }],
        ...extra,
      },
    });
  const redeem = (invitation) =>
    call("/api/invitations/redeem", {
      token: "",
      method: "POST",
      body: { invitation },
    });
  return { reach, call, invite, redeem, owner, files, dir };
}

test("an invited agent gets exactly its folder and access, nothing of yours", async (t) => {
  const { call, invite, redeem, files } = await start(t);
  const before = Date.now();
  const created = await invite({ write: true, exec: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.scopes, [
    "device",
    "files:read",
    "files:write",
    "exec",
  ]);
  // A one-time invitation, joined within 15 minutes, lasting 7 days.
  assert.match(created.body.invitation, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(created.body.joinBy - before <= 900_000 + 1000);
  assert.ok(created.body.expiresAt - before >= 7 * 86400_000 - 1000);
  const listed = (await call("/api/clients")).body.clients.find(
    (c) => c.id === created.body.clientId,
  );
  assert.equal(listed.status, "invited");
  assert.equal(listed.kind, "agent");

  const joined = await redeem(created.body.invitation);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.kind, "agent");
  assert.deepEqual(joined.body.scopes, created.body.scopes);
  assert.equal(
    (await redeem(created.body.invitation)).status,
    401,
    "used once",
  );
  const as = (route, opts = {}) =>
    call(route, { token: joined.body.token, ...opts });

  // Its folder, nothing beside it.
  const acme = fs.realpathSync.native(path.join(files, "Projects/acme"));
  const device = (await as("/api/device")).body;
  assert.deepEqual(
    device.roots.map((r) => r.path),
    [acme],
  );
  assert.deepEqual(
    (await as("/api/files?root=0&path=")).body.items.map((i) => i.name),
    ["brief.txt"],
  );
  assert.equal((await as("/api/files?root=0&path=..")).status, 403);
  assert.equal(
    (await as("/api/files/content?root=0&path=../other/secret.txt")).status,
    403,
  );

  // Commands start in its folder only, within its time limit.
  const job = await as("/api/jobs", {
    method: "POST",
    body: { root: 0, path: "", command: "pwd" },
  });
  assert.equal(job.status, 202, JSON.stringify(job.body));
  let done;
  for (let i = 0; i < 100 && !done; i++) {
    const j = (await as(`/api/jobs/${job.body.id}`)).body;
    if (j.status !== "running") done = j;
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fs.realpathSync.native(done.output.trim()), acme);
  assert.equal(
    (
      await as("/api/jobs", {
        method: "POST",
        body: { root: 0, path: "../other", command: "pwd" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await as("/api/jobs", {
        method: "POST",
        body: { root: 0, path: "", command: "pwd", timeoutMs: 31 * 60000 },
      })
    ).status,
    403,
  );

  // Never: your screen, apps, your terminals, or managing access.
  for (const [route, method, body] of [
    ["/api/screen/displays", "GET"],
    ["/api/apps", "GET"],
    ["/api/terminals/desktop", "GET"],
    ["/api/clients", "GET"],
    ["/api/agents/invitations", "POST", { name: "x", ttlSeconds: 600 }],
    ["/api/guests", "POST", { name: "x", ttlSeconds: 600, full: true }],
    ["/api/guests/key", "POST", { ttlSeconds: 600 }],
    ["/api/settings", "GET"],
    ["/api/fleet/computers", "GET"],
  ])
    assert.equal((await as(route, { method, body })).status, 403, route);

  assert.equal(
    (await call("/api/clients")).body.clients.find(
      (c) => c.id === joined.body.clientId,
    ).status,
    "accepted",
  );
  // Revoked: gone at once.
  assert.equal(
    (await call(`/api/clients/${joined.body.clientId}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.equal((await as("/api/device")).status, 401);
});

test("only you invite agents: not guests, even with full access", async (t) => {
  const { call, invite, reach } = await start(t);
  const grant = reach.auth.inviteGuest({
    name: "G",
    ttlSeconds: 600,
    full: true,
  });
  const guest = reach.auth.redeemGuest(grant.invitation);
  const tried = await call("/api/agents/invitations", {
    token: guest.token,
    method: "POST",
    body: {
      name: "Sneaky",
      ttlSeconds: 600,
      folders: [{ root: 0, path: "" }],
    },
  });
  assert.equal(tried.status, 403);
  assert.equal((await invite()).status, 201);
});

test("agent invitations: what's refused, and a join window that ran out", async (t) => {
  const { call, invite, redeem, reach, dir } = await start(t);
  for (const bad of [
    { folders: [] },
    { folders: [{ root: 0, path: "../" }] },
    { ttlSeconds: 91 * 86400 },
    { ttlSeconds: 30 },
    { joinSeconds: 30 },
    { joinSeconds: 2 * 86400 },
    { write: "yes" },
    { name: " " },
    { name: "x".repeat(81) },
  ])
    assert.ok(
      [400, 403].includes((await invite(bad)).status),
      JSON.stringify(bad),
    );
  // Screen or apps can't be asked for: they're simply not given.
  const asked = await invite({ screen: "control", apps: "all", full: true });
  assert.deepEqual(asked.body.scopes, ["device", "files:read"]);

  // Not joined in time: refused, and shown as expired.
  const late = await invite({ joinSeconds: 60 });
  const file = path.join(dir, "private", "clients.json");
  const clients = JSON.parse(fs.readFileSync(file, "utf8"));
  clients.find((c) => c.id === late.body.clientId).inviteExpiresAt =
    Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(clients));
  assert.equal((await redeem(late.body.invitation)).status, 401);
  assert.equal(
    (await call("/api/clients")).body.clients.find(
      (c) => c.id === late.body.clientId,
    ).status,
    "expired",
  );
  assert.ok(reach);
});

test("an agent's credential works only on the Tailscale device that joined", async (t) => {
  const { invite, reach } = await start(t);
  const created = await invite();
  const node = {
    userId: "tagged-devices",
    nodeId: "nAgent",
    tagged: true,
    validUntil: Date.now() + 60000,
  };
  const joined = reach.auth.redeemGuest(created.body.invitation, node);
  assert.equal(reach.auth.verify(joined.token, node)?.id, joined.clientId);
  assert.equal(
    reach.auth.verify(joined.token, { ...node, nodeId: "nElsewhere" }),
    null,
  );
  assert.equal(reach.auth.verify(joined.token), null);
});

test("an agent policy file doesn't lock out agents you invited", async (t) => {
  const { invite, redeem, call } = await start(t, { policy: true });
  const created = await invite({ exec: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const joined = await redeem(created.body.invitation);
  const device = await call("/api/device", { token: joined.body.token });
  assert.equal(device.status, 200);
  assert.equal(device.body.roots.length, 1);
  assert.deepEqual(device.body.access.scopes, ["device", "files:read", "exec"]);
});

test("an agent's invite key lasts its join window; its device lasts the invitation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-key-"));
  try {
    let clock = Date.parse("2026-10-05T10:00:00Z");
    const devices = [];
    const keys = [];
    const request = async (url, init = {}) => {
      const route = new URL(url).pathname.replace("/api/v2", "");
      const json = (body) => ({
        ok: true,
        status: 200,
        json: async () => body,
      });
      if (route === "/oauth/token")
        return json({ access_token: "token-1", expires_in: 3600 });
      if (route === "/tailnet/-/keys" && init.method === "POST") {
        keys.push(JSON.parse(init.body));
        return json({
          id: `k${keys.length}`,
          key: `tskey-auth-k${keys.length}`,
        });
      }
      if (route === "/tailnet/-/devices") return json({ devices });
      if (route.startsWith("/device/") && init.method === "DELETE") {
        const id = decodeURIComponent(route.slice(8));
        devices.splice(
          devices.findIndex((d) => d.nodeId === id),
          1,
        );
        return json({});
      }
      return json({});
    };
    const guestKeys = createGuestKeys({
      dataDir: dir,
      self: "dev-a",
      request,
      now: () => clock,
    });
    await guestKeys.setup({
      clientId: "id",
      clientSecret: "tskey-client-abc-123",
    });
    const made = await guestKeys.createInvite({
      ttlSeconds: 30 * 86400,
      keySeconds: 900,
      clientIds: ["agent-1"],
    });
    assert.equal(keys.at(-1).expirySeconds, 900);
    devices.push({
      nodeId: "nAgent",
      hostname: made.hostname,
      tags: [GUEST_TAG],
      created: new Date(clock).toISOString(),
    });
    // Long after the join window: the agent stays.
    clock += 3 * 86400_000;
    assert.equal(await guestKeys.reconcile(), 0);
    assert.equal(devices.length, 1);
    // Revoked: its device goes.
    assert.equal(await guestKeys.revokeClient("agent-1"), 1);
    assert.equal(devices.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
