import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// "New invite link" (Agents & people): a computer never keeps a link, so for
// someone who hasn't used theirs the owner makes a new one. The old link
// stops working; who, what and until when stay; once used, nothing to renew.

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-new-link-"));
  const files = path.join(dir, "files");
  fs.mkdirSync(path.join(files, "work"), { recursive: true });
  const reach = await createReach({ roots: [files], dataDir: path.join(dir, "private") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES).token;
  const call = (route, { token = owner, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { reach, call };
}

test("a person who hasn't opened their link gets a new one; the old stops working", async (t) => {
  const { reach, call } = await start(t);
  const made = await call("/api/guests", {
    method: "POST",
    body: { name: "Ali", ttlSeconds: 3600, folders: [{ root: 0, path: "work" }] },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const before = reach.auth.list().find((c) => c.id === made.body.clientId);

  const renewed = await call(`/api/guests/${made.body.clientId}/link`, { method: "POST", body: {} });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.notEqual(renewed.body.invitation, made.body.invitation);
  assert.match(renewed.body.url, new RegExp(`/guest#invite=${renewed.body.invitation}$`));
  const after = reach.auth.list().find((c) => c.id === made.body.clientId);
  assert.equal(after.expiresAt, before.expiresAt, "the same end");
  assert.deepEqual(after.scopes, before.scopes, "the same access");
  assert.equal(after.status, "invited");

  const old = await call("/api/guest/redeem", { token: "", method: "POST", body: { invitation: made.body.invitation } });
  assert.notEqual(old.status, 200, "the old link no longer works");
  const joined = await call("/api/guest/redeem", { token: "", method: "POST", body: { invitation: renewed.body.invitation } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));

  // Opened: nothing to send again.
  const again = await call(`/api/guests/${made.body.clientId}/link`, { method: "POST", body: {} });
  assert.equal(again.status, 409);
  // The guest itself can't ask for links.
  const asGuest = await call(`/api/guests/${made.body.clientId}/link`, { token: joined.body.token, method: "POST", body: {} });
  assert.equal(asGuest.status, 403);
  // Joined in the browser: their page asks for its door key, over this
  // private connection, for the public link (pairing-window.test.mjs).
  const door = await call("/api/device/door-key", { token: joined.body.token, method: "POST", body: {} });
  assert.equal(door.status, 200, JSON.stringify(door.body));
  assert.match(door.body.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(door.body.expiresAt, after.expiresAt);
  assert.ok(reach.auth.doorKeyKnown(door.body.key));
});

test("an agent whose join window lapsed gets a new link and a new window", async (t) => {
  const { reach, call } = await start(t);
  const made = await call("/api/agents/invitations", {
    method: "POST",
    body: { name: "Builder", ttlSeconds: 7 * 86400, joinSeconds: 900, folders: [{ root: 0, path: "work" }] },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  // The window passes unused.
  const file = path.join(reach.config.dataDir, "clients.json");
  const clients = JSON.parse(fs.readFileSync(file, "utf8"));
  const stored = clients.find((c) => c.id === made.body.clientId);
  stored.createdAt = new Date(Date.now() - 3600000).toISOString();
  stored.inviteExpiresAt = Date.now() - 3600000 + 900000;
  fs.writeFileSync(file, JSON.stringify(clients));
  assert.equal(reach.auth.list().find((c) => c.id === made.body.clientId).status, "expired");

  const renewed = await call(`/api/guests/${made.body.clientId}/link`, { method: "POST", body: {} });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.ok(renewed.body.joinBy > Date.now() + 800000 && renewed.body.joinBy <= Date.now() + 900000, "a fresh 15 minutes");
  assert.equal(renewed.body.expiresAt, made.body.expiresAt, "the same end");
  assert.equal(reach.auth.list().find((c) => c.id === made.body.clientId).status, "invited");
});
