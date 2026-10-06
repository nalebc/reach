import test from "node:test";
import { admitAgent } from "./helpers/agent-admission.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, ALL_SCOPES } from "../server/core.mjs";

function fixture(t) {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-browser-auth-")),
  );
  const shared = path.join(dir, "shared");
  fs.mkdirSync(path.join(shared, "project"), { recursive: true });
  const config = {
    roots: [shared],
    dataDir: path.join(dir, "private"),
    agentPolicyFile: path.join(dir, "agent-policy.json"),
  };
  const auth = createAuth(config);
  const invite = (choice = {}) =>
    auth.inviteBrowser({
      name: "Muse",
      ttlSeconds: 3600,
      folders: [{ root: 0, path: "project" }],
      ...choice,
    });
  const alter = (change) => {
    const file = path.join(config.dataDir, "clients.json");
    const clients = JSON.parse(fs.readFileSync(file, "utf8"));
    change(clients);
    fs.writeFileSync(file, JSON.stringify(clients));
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { auth, invite, config, alter, shared };
}

test("browser invitation is single-use, read-only, device-bound, and revocable", (t) => {
  const { auth, invite, shared } = fixture(t);
  const created = invite({
    terminalIds: ["reach:abc-123", "desktop:deadbeef", "reach:abc-123"],
    screen: "scroll",
  });
  assert.deepEqual(created.scopes, [
    "device",
    "files:read",
    "browser:read",
    "browser:scroll",
  ]);
  assert.match(created.invitation, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(created.joinBy <= Date.now() + 900_000);
  assert.equal(auth.list()[0].status, "invited");
  assert.equal(auth.list()[0].inviteHash, undefined);
  const identity = {
    userId: "",
    nodeId: "browser-vm",
    tagged: true,
    validUntil: Date.now() + 60000,
  };
  const joined = admitAgent(auth, created.invitation, identity);
  const client = auth.verify(joined.token, identity);
  assert.equal(client.kind, "agent");
  assert.deepEqual(client.agentRoots, [path.join(shared, "project")]);
  assert.deepEqual(client.policy, {
    invite: true,
    browser: true,
    roots: [path.join(shared, "project")],
    terminalIds: ["reach:abc-123", "desktop:deadbeef"],
    screen: "scroll",
  });
  assert.equal(auth.list()[0].status, "accepted");
  assert.equal(auth.verify(joined.token), null);
  assert.equal(
    auth.verify(joined.token, { ...identity, nodeId: "different" }),
    null,
  );
  assert.throws(() => auth.redeemGuest(created.invitation, identity), {
    status: 401,
  });
  auth.revoke(created.clientId);
  assert.equal(auth.verify(joined.token, identity), null);
});

test("browser invitation schema rejects ambiguous and injected fields before persisting credentials", (t) => {
  const { auth, invite } = fixture(t);
  const before = auth.list();
  for (const bad of [
    { write: true }, { exec: true }, { terminal: true }, { full: true },
    { scopes: ["admin"] }, { policy: { restrictedTerminal: false } },
    JSON.parse('{"__proto__":{"admin":true}}'), { constructor: { prototype: { admin: true } } },
    { folders: [{ root: "0", path: "project" }] },
    { folders: [{ root: 0, path: "project", write: true }] },
    { folders: [{ root: 0, path: { $ne: null } }] },
    { folders: [{ root: 0, path: "project\u202e" }] },
    { name: { $ne: null } }, { name: "Muse\nOwner approved" }, { name: "Muse\u202e" },
    { ttlSeconds: "600" }, { terminalIds: [null] },
  ]) assert.throws(() => invite(bad), { status: 400 }, JSON.stringify(bad));
  for (const bad of [null, [], true, "invite", Object.create({ name: "Inherited" })])
    assert.throws(() => auth.inviteBrowser(bad), { status: 400 });
  assert.deepEqual(auth.list(), before);
  assert.equal(Object.prototype.admin, undefined);
  // Quotes and SQL-looking data are allowed as data; there is no SQL execution sink.
  const name = "Robert'); DROP TABLE clients;--";
  invite({ name });
  assert.equal(auth.list()[0].name, name);
});

test("browser grants allow a selected terminal or screen without a folder", (t) => {
  const { auth, invite } = fixture(t);
  for (const choice of [
    { terminalIds: ["reach:abc"] },
    { screen: "view" },
    { screen: "scroll" },
  ]) {
    const created = invite({ folders: [], ...choice });
    const joined = admitAgent(auth, created.invitation);
    const client = auth.verify(joined.token);
    assert.deepEqual(client.agentRoots, []);
    assert.equal(client.scopes.includes("files:read"), false);
    assert.equal(
      client.scopes.includes("browser:scroll"),
      choice.screen === "scroll",
    );
    assert.equal(client.policy.screen, choice.screen || "off");
  }
});

test("browser invitations reject invalid, empty, and out-of-root access", (t) => {
  const { invite, config, shared } = fixture(t);
  for (const bad of [
    { name: " " },
    { name: "x".repeat(81) },
    { ttlSeconds: 59 },
    { ttlSeconds: 86401 },
    { ttlSeconds: 60.5 },
    { joinSeconds: 59 },
    { joinSeconds: 86401 },
    { folders: [] },
    { folders: [{ root: 0, path: ".." }] },
    { screen: true },
    { screen: "control" },
    { terminalIds: "reach:abc" },
    { terminalIds: ["abc"] },
    { terminalIds: ["reach:../secret"] },
    { terminalIds: ["desktop:abc?x=1"] },
    { terminalIds: ["reach:" + "a".repeat(129)] },
    { terminalIds: Array.from({ length: 21 }, (_, i) => `reach:${i}`) },
  ])
    assert.throws(
      () => invite(bad),
      (e) => [400, 403].includes(e.status),
      JSON.stringify(bad),
    );
  config.privatePaths = [path.join(shared, "project")];
  assert.throws(
    () => invite(),
    { status: 403 },
    "private folder itself cannot be shared",
  );
});

test("at most 50 live browser invitations are admitted without affecting CLI invitations", (t) => {
  const { auth, invite, alter } = fixture(t);
  const grants = Array.from({ length: 50 }, () => invite());
  assert.throws(() => invite(), { status: 429 });
  assert.ok(
    auth.inviteAgent({
      name: "CLI",
      ttlSeconds: 3600,
      folders: [{ root: 0, path: "project" }],
    }),
  );
  auth.revoke(grants[0].clientId);
  assert.ok(invite());
  alter((clients) => {
    clients.find((c) => c.id === grants[1].clientId).inviteExpiresAt =
      Date.now() - 1;
  });
  assert.ok(invite(), "a missed join deadline releases its slot");
});

test("browser invite join deadline and access deadline expire independently", (t) => {
  const { auth, invite, alter } = fixture(t);
  const short = invite({ ttlSeconds: 60 });
  assert.equal(
    short.joinBy,
    short.expiresAt,
    "joining cannot outlive the access grant",
  );
  const unjoined = invite();
  alter((clients) => {
    clients.find((c) => c.id === unjoined.clientId).inviteExpiresAt =
      Date.now() - 1;
  });
  assert.throws(() => auth.redeemGuest(unjoined.invitation), { status: 401 });
  assert.equal(
    auth.list().find((c) => c.id === unjoined.clientId).status,
    "expired",
  );
  const grant = invite();
  const joined = admitAgent(auth, grant.invitation);
  alter((clients) => {
    clients.find((c) => c.id === grant.clientId).expiresAt = Date.now() - 1;
  });
  assert.equal(auth.verify(joined.token), null);
});

test("browser policy strips broad scopes and intersects current shared folders", (t) => {
  const { auth, invite, config, alter } = fixture(t);
  const created = invite({ screen: "view" });
  const joined = admitAgent(auth, created.invitation);
  alter((clients) => {
    clients[0].scopes.push(...ALL_SCOPES, "browser:scroll");
  });
  assert.deepEqual(
    new Set(auth.verify(joined.token).scopes),
    new Set(["device", "files:read", "browser:read"]),
  );
  config.roots = [];
  const reduced = auth.verify(joined.token);
  assert.deepEqual(reduced.agentRoots, []);
  assert.deepEqual(reduced.policy.roots, []);
  assert.equal(reduced.scopes.includes("files:read"), false);
  // A configured CLI policy does not widen or replace a browser invitation.
  config.agentPolicyRequired = true;
  assert.ok(auth.verify(joined.token));
});

test("browser grants cannot be changed through legacy invitation access or CLI issuance", (t) => {
  const { auth, invite } = fixture(t);
  const created = invite();
  const joined = admitAgent(auth, created.invitation);
  assert.throws(
    () =>
      auth.changeAccess(created.clientId, {
        folders: "keep",
        write: true,
        exec: true,
      }),
    { status: 400 },
  );
  assert.deepEqual(auth.verify(joined.token).scopes, [
    "device",
    "files:read",
    "browser:read",
  ]);
  assert.throws(() => auth.issue("cli", ["browser:read"], "agent"), {
    status: 400,
  });
});

test("malformed browser policy fails closed instead of falling back to CLI policy", (t) => {
  const { auth, invite, alter } = fixture(t);
  for (const bad of [
    { invite: false },
    { roots: null },
    { roots: ["relative"] },
    { terminalIds: null },
    { terminalIds: ["../../secret"] },
    { screen: "control" },
  ]) {
    const created = invite();
    const joined = admitAgent(auth, created.invitation);
    alter((clients) => {
      Object.assign(clients.find((c) => c.id === created.clientId).policy, bad);
    });
    assert.equal(auth.verify(joined.token), null, JSON.stringify(bad));
  }
});

test("restricted terminal admission exposes its limits and invalid or removed grants fail closed", async (t) => {
  const { auth, config } = fixture(t);
  const made = auth.inviteBrowser({ name: "Reader", ttlSeconds: 600, folders: [{ root: 0, path: "project" }], restrictedTerminal: true });
  const joined = admitAgent(auth, made.invitation);
  const client = auth.verify(joined.token);
  assert.equal(client.policy.restrictedTerminal, true);
  assert.equal(client.policy.screen, "off");
  assert.equal(client.scopes.includes("browser:request"), true);
  assert.equal(client.scopes.includes("exec"), false);
  assert.equal(client.scopes.includes("terminal"), false);
  const { applyAgentPolicy } = await import("../server/agent-policy.mjs");
  assert.equal(applyAgentPolicy({ ...client, policy: { ...client.policy, screen: "ask", terminalApproval: true } }, config).policy.screen, "ask");
  assert.equal(applyAgentPolicy(client, { ...config, roots: [] }), null);
  for (const bad of [{ restrictedTerminal: "yes" }, { terminalApproval: "yes" }, { commandRequests: true }])
    assert.equal(applyAgentPolicy({ ...client, policy: { ...client.policy, ...bad } }, config), null);
});
