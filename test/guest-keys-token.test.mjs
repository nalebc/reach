import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGuestKeys, GUEST_TAG } from "../server/guest-keys.mjs";
import { parsePolicy } from "../server/tailnet-policy.mjs";

// Invite links set up from one pasted Tailscale API access token: Reach adds
// its tag and grant to the policy (checked by Tailscale, never overwriting a
// concurrent edit), creates its own limited OAuth client, keeps only that.
const TOKEN = "tskey-api-kAbc123CNTRL-SecretPart9";
const POLICY = `// my policy
{
\t"grants": [
\t\t// everyone
\t\t{"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
\t],
}
`;

function fakeTailscale({ policy = POLICY, invalid = "", raceOnWrite = false, etag = '"v1"' } = {}) {
  const api = { policy, etag, writes: 0, clients: [], deleted: [], calls: [], authKeys: 0 };
  api.request = async (url, init = {}) => {
    const route = new URL(url).pathname.replace("/api/v2", "");
    const method = init.method || "GET";
    api.calls.push(`${method} ${route}`);
    const reply = (status, body, headers = {}) => ({
      ok: status < 400,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });
    const auth = init.headers?.Authorization || "";
    if (route === "/oauth/token") {
      const form = new URLSearchParams(init.body);
      const c = api.clients.find((x) => x.id === form.get("client_id"));
      return c && c.key === form.get("client_secret")
        ? reply(200, { access_token: `oauth-${c.id}`, expires_in: 3600 })
        : reply(401, { message: "invalid client" });
    }
    if (auth.startsWith("Bearer oauth-")) {
      // Reach's own client: the setup check (devices, a short key).
      if (route === "/tailnet/-/devices") return reply(200, { devices: [] });
      if (route === "/tailnet/-/keys" && method === "POST")
        return reply(200, { id: `a${++api.authKeys}`, key: `tskey-auth-a${api.authKeys}-x` });
      if (route.startsWith("/tailnet/-/keys/") && method === "DELETE") return reply(200, {});
      return reply(404, {});
    }
    if (auth !== `Bearer ${TOKEN}`) return reply(401, { message: "unauthorized" });
    if (route === "/tailnet/-/acl" && method === "GET") {
      assert.equal(init.headers.Accept, "application/hujson");
      return reply(200, api.policy, { etag: api.etag });
    }
    if (route === "/tailnet/-/acl/validate") {
      assert.equal(init.headers["Content-Type"], "application/hujson");
      return reply(200, invalid ? { message: invalid, data: [] } : "");
    }
    if (route === "/tailnet/-/acl" && method === "POST") {
      if (raceOnWrite) api.etag = '"v2"'; // someone saved in between
      if (init.headers["If-Match"] !== undefined && init.headers["If-Match"] !== api.etag)
        return reply(412, { message: "precondition failed" });
      api.policy = init.body;
      api.etag = `"v${++api.writes + 1}"`;
      return reply(200, api.policy);
    }
    if (route === "/tailnet/-/keys" && method === "POST") {
      const body = JSON.parse(init.body);
      const c = { id: `k${api.clients.length + 1}CNTRL`, body };
      c.key = `tskey-client-${c.id}-secret`;
      api.clients.push(c);
      return reply(200, { id: c.id, key: c.key });
    }
    if (route.startsWith("/tailnet/-/keys/") && method === "DELETE") {
      api.deleted.push(route.split("/").pop());
      return reply(200, {});
    }
    return reply(404, { message: "not found" });
  };
  return api;
}
const setupDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-token-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const where = { addresses: ["100.64.0.5"], port: 8443 };
// Nothing on disk ever holds the access token.
const tokenOnDisk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tokenOnDisk(p) : fs.readFileSync(p, "utf8").includes("tskey-api-");
  });

test("one token: rules added (comments kept), Reach's own limited client saved, token never kept", async (t) => {
  const dir = setupDir(t);
  const api = fakeTailscale();
  const keys = createGuestKeys({ dataDir: dir, self: "dev-a", request: api.request });
  let seen;
  const result = await keys.setupFromAccessToken({
    accessToken: ` ${TOKEN}\n`,
    ...where,
    confirm: async (plan) => ((seen = plan), true),
  });
  assert.equal(seen.added.length, 2, "confirm saw exactly what changes");
  assert.deepEqual(result.allowAll, []);
  // The policy: tag + grant added, the owner's comments and rule kept.
  const saved = parsePolicy(api.policy);
  assert.deepEqual(saved.tagOwners, { [GUEST_TAG]: ["autogroup:admin"] });
  assert.deepEqual(saved.grants[0], { src: [GUEST_TAG], dst: ["100.64.0.5"], ip: ["tcp:8443"] });
  assert.match(api.policy, /\/\/ my policy/);
  assert.match(api.policy, /\/\/ everyone/);
  // Validated before written, written once with the version it read.
  assert.ok(api.calls.indexOf("POST /tailnet/-/acl/validate") < api.calls.indexOf("POST /tailnet/-/acl"));
  assert.equal(api.writes, 1);
  // Reach's client: guest keys and guest devices only.
  assert.deepEqual(api.clients[0].body, {
    keyType: "client",
    description: "Reach invite links",
    scopes: ["auth_keys", "devices:core"],
    tags: [GUEST_TAG],
  });
  assert.equal(keys.configured(), true);
  assert.equal(tokenOnDisk(dir), false);
});

test("rules already there: the policy isn't written again", async (t) => {
  const dir = setupDir(t);
  const api = fakeTailscale({
    policy: `{"tagOwners": {"${GUEST_TAG}": ["autogroup:admin"]}, "grants": [{"src": ["${GUEST_TAG}"], "dst": ["100.64.0.5"], "ip": ["tcp:8443"]}]}`,
  });
  const keys = createGuestKeys({ dataDir: dir, self: "dev-a", request: api.request });
  const result = await keys.setupFromAccessToken({ accessToken: TOKEN, ...where });
  assert.deepEqual(result.added, []);
  assert.equal(api.writes, 0);
  assert.ok(!api.calls.includes("POST /tailnet/-/acl/validate"));
  assert.equal(keys.configured(), true);
});

test("a wrong or expired token: a plain message, nothing changed", async (t) => {
  const dir = setupDir(t);
  const api = fakeTailscale();
  const keys = createGuestKeys({ dataDir: dir, self: "dev-a", request: api.request });
  await assert.rejects(keys.setupFromAccessToken({ accessToken: "tskey-client-nope-x", ...where }), /starts with tskey-api-/);
  assert.deepEqual(api.calls, [], "a malformed token never leaves the computer");
  await assert.rejects(
    keys.setupFromAccessToken({ accessToken: "tskey-api-kOld999CNTRL-expired", ...where }),
    /didn't accept that token/,
  );
  assert.equal(api.writes, 0);
  assert.equal(api.clients.length, 0);
  assert.equal(keys.configured(), false);
});

test("Tailscale rejects the change, or the policy changed meanwhile, or you decline: nothing written", async (t) => {
  for (const [label, api, confirm, message] of [
    ["invalid", fakeTailscale({ invalid: "test(s) failed" }), undefined, /wouldn't accept the change.*test\(s\) failed/],
    ["race", fakeTailscale({ raceOnWrite: true }), undefined, /changed while Reach was adding/],
    ["declined", fakeTailscale(), async () => false, /Cancelled/],
  ]) {
    const dir = setupDir(t);
    const before = api.policy;
    const keys = createGuestKeys({ dataDir: dir, self: "dev-a", request: api.request });
    await assert.rejects(keys.setupFromAccessToken({ accessToken: TOKEN, ...where, confirm }), message, label);
    assert.equal(api.policy, before, `${label}: policy unchanged`);
    assert.equal(api.clients.length, 0, `${label}: no client made`);
    assert.equal(keys.configured(), false, label);
  }
});

test("if Reach's new client fails its check, it's deleted, not left behind", async (t) => {
  const dir = setupDir(t);
  const api = fakeTailscale();
  const real = api.request;
  // The new client can't get a token (say, scopes not granted).
  api.request = async (url, init) =>
    new URL(url).pathname.endsWith("/oauth/token")
      ? { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => "" }
      : real(url, init);
  const keys = createGuestKeys({ dataDir: dir, self: "dev-a", request: api.request });
  await assert.rejects(keys.setupFromAccessToken({ accessToken: TOKEN, ...where }), /didn't accept the OAuth client/);
  assert.deepEqual(api.deleted, [api.clients[0].id]);
  assert.equal(keys.configured(), false);
});

async function routeFixture(t, { api = fakeTailscale(), beforeStatus } = {}) {
    const http = await import("node:http");
    const { createReach } = await import("../server/index.mjs");
    const { ALL_SCOPES } = await import("../server/core.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-token-route-"));
    const socketDir = fs.mkdtempSync("/tmp/reach-token-sock-");
    const socketPath = path.join(socketDir, "s");
    const owner = { userId: "42", login: "o@example.test" };
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, "private"),
      port: 0,
      publicOrigin: "https://mac-a.t.ts.net:8443",
      tailscaleOwner: owner,
      tailscaleIdentity: {
        lookup: async () => ({
          Node: { StableID: "nPhone", User: 42, Name: "phone.t.ts.net.", KeyExpiry: "0001-01-01T00:00:00Z" },
          UserProfile: { ID: 42, LoginName: owner.login },
        }),
      },
      tailscaleStatus: async () => { await beforeStatus?.(); return { Self: { TailscaleIPs: ["100.64.0.5", "fd7a::5"] }, Peer: {} }; },
      guestKeys: { request: api.request },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    await reach.listenPrivate(socketPath);
    t.after(async () => {
      reach.server.closeAllConnections?.();
      await reach.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(socketDir, { recursive: true, force: true });
    });
    const phone = reach.auth.issue("My iPhone", ALL_SCOPES, "device", {
      tailscale: { userId: "42", nodeId: "nPhone" },
    });
    const post = (token, body) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            path: "/api/guests/keys",
            method: "POST",
            headers: {
              Host: "localhost",
              "X-Forwarded-For": "100.64.0.9",
              "Tailscale-User-Login": owner.login,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, text, json: JSON.parse(text || "null") }));
          },
        );
        req.once("error", reject);
        req.end(JSON.stringify(body));
      });
    return { reach, phone, post, api, dir };
}

test(
  "from the phone: one token sets up invite links; a guest can't",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const { reach, phone, post, api, dir } = await routeFixture(t);
    // A guest (even with full access) can't.
    const invite = reach.auth.inviteGuest({ name: "G", ttlSeconds: 600, full: true });
    const guest = reach.auth.redeemGuest(invite.invitation, { userId: "42", nodeId: "nPhone" });
    assert.equal((await post(guest.token, { accessToken: TOKEN })).status, 403);
    assert.equal(api.writes, 0);
    // The owner's phone: done in one step; the token isn't echoed or kept.
    const ok = await post(phone.token, { accessToken: TOKEN });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.configured, true);
    assert.equal(ok.json.added.length, 2);
    assert.equal(ok.json.allowAll, false);
    assert.doesNotMatch(ok.text, /tskey-/);
    assert.deepEqual(parsePolicy(api.policy).grants[0].dst, ["100.64.0.5"]);
    assert.deepEqual(parsePolicy(api.policy).grants[0].ip, ["tcp:8443"]);
    assert.equal(reach.guestKeys.configured(), true);
    assert.equal(tokenOnDisk(path.join(dir, "private")), false);
  },
);


test("unsafe wildcard policies stop setup before any policy write or key mint", async (t) => {
  for (const policy of [
    '{"grants":[{"src":["*"],"dst":["*"],"ip":["*"]}]}',
    '{"acls":[{"action":"accept","src":["*"],"dst":["tag:server:22"]}]}',
    '{"grants":[{"src":["tag:reach-guest"],"dst":["*"],"ip":["*"]}]}',
    '{"grants":[{"src":["100.64.0.0/10"],"dst":["*"],"ip":["tcp:22"]}]}',
  ]) {
    const api = fakeTailscale({ policy });
    const keys = createGuestKeys({ dataDir: setupDir(t), self: "dev-a", request: api.request });
    await assert.rejects(keys.setupFromAccessToken({ accessToken: TOKEN, ...where, confirm: async () => true }), /Guest access is not isolated/);
    assert.equal(api.writes, 0);
    assert.equal(api.clients.length, 0);
    assert.equal(keys.configured(), false);
  }
});

test("a reviewed default-policy fix validates and narrows the wildcard before minting a guest client", async (t) => {
  const api = fakeTailscale({ policy: '{"grants":[{"src":["*"],"dst":["*"],"ip":["*"]}]}' });
  const keys = createGuestKeys({ dataDir: setupDir(t), self: "dev-a", request: api.request });
  await assert.rejects(
    keys.setupFromAccessToken({ accessToken: TOKEN, ...where }),
    (error) => error.status === 409 && error.canNarrowDefault === true,
  );
  assert.equal(api.writes, 0);
  let reviewed;
  await keys.setupFromAccessToken({
    accessToken: TOKEN, ...where, narrowDefaultWildcard: true,
    confirm: async (plan) => ((reviewed = plan.added), true),
  });
  assert.ok(reviewed.some((line) => line.includes("all devices → tailnet members")));
  assert.deepEqual(parsePolicy(api.policy).grants[1].src, ["autogroup:member"]);
  assert.equal(api.writes, 1);
  assert.equal(api.clients.length, 1);
});


for (const etag of [null, "", "   ", "*"]) {
  test(`policy without a usable version tag (${JSON.stringify(etag)}) never writes or mints`, async t => {
    const api = fakeTailscale({ etag });
    const keys = createGuestKeys({ dataDir: setupDir(t), self: "fixture", request: api.request });
    await assert.rejects(keys.setupFromAccessToken({ accessToken: TOKEN, ...where }), /version|ETag/i);
    assert.equal(api.writes, 0); assert.equal(api.clients.length, 0);
    assert.equal(api.authKeys, 0); assert.equal(keys.configured(), false);
  });
}

const gate = () => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await waiting; } };
};
const routeTest = { skip: process.platform === "win32", timeout: 20000 };

test("invite key setup only accepts paired owner devices, never delegated admin credentials", routeTest, async t => {
  const f = await routeFixture(t);
  for (const kind of ["service", "agent"]) {
    const credential = f.reach.auth.issue(`Fixture ${kind}`, kind === "agent" ? ["files:read"] : ["admin"], kind, {
      tailscale: { userId: "42", nodeId: "nPhone" },
    });
    assert.equal((await f.post(credential.token, { accessToken: TOKEN })).status, 403);
  }
  assert.equal(f.api.calls.length, 0); assert.equal(f.api.writes, 0);
  assert.equal(f.api.clients.length, 0); assert.equal(f.reach.guestKeys.configured(), false);
});

for (const phase of ["status", "validate", "oauth", "devices", "probe-delete"]) {
  test(`revoked owner during ${phase} stops subsequent invitation changes`, routeTest, async t => {
    const pause = gate(), api = fakeTailscale();
    const request = api.request;
    api.request = async (url, init) => {
      const response = await request(url, init), route = new URL(url).pathname;
      if ((phase === "validate" && route.endsWith("/acl/validate")) ||
          (phase === "oauth" && route.endsWith("/oauth/token")) ||
          (phase === "devices" && route.endsWith("/devices")) ||
          (phase === "probe-delete" && init.method === "DELETE" && route.endsWith("/keys/a1"))) await pause.wait();
      return response;
    };
    const f = await routeFixture(t, { api, beforeStatus: phase === "status" ? pause.wait : undefined });
    t.after(() => pause.release());
    const pending = f.post(f.phone.token, { accessToken: TOKEN });
    await pause.entered; f.reach.auth.revoke(f.phone.clientId); pause.release();
    assert.equal((await pending).status, 401);
    const beforeWrite = phase === "status" || phase === "validate";
    assert.equal(api.writes, beforeWrite ? 0 : 1);
    assert.equal(api.clients.length, beforeWrite ? 0 : 1);
    assert.equal(api.authKeys, phase === "probe-delete" ? 1 : 0);
    assert.equal(f.reach.guestKeys.configured(), false, "revoked request never saves credentials");
    if (!beforeWrite) assert.deepEqual(api.deleted, [api.clients[0].id], "new unused client is cleaned up even after revocation");
    if (phase === "oauth") assert.ok(!api.calls.includes("GET /tailnet/-/devices"));
    if (phase === "status") assert.equal(api.calls.length, 0);
  });
}


test("manual OAuth setup also rechecks owner access after token refresh", routeTest, async t => {
  const pause = gate(), api = fakeTailscale();
  const client = { id: "manualCNTRL", key: "tskey-client-manualCNTRL-secret" };
  api.clients.push(client);
  const request = api.request;
  api.request = async (url, init) => {
    const response = await request(url, init);
    if (new URL(url).pathname.endsWith("/oauth/token")) await pause.wait();
    return response;
  };
  const f = await routeFixture(t, { api });
  t.after(() => pause.release());
  const pending = f.post(f.phone.token, { clientId: client.id, clientSecret: client.key });
  await pause.entered; f.reach.auth.revoke(f.phone.clientId); pause.release();
  assert.equal((await pending).status, 401);
  assert.equal(api.writes, 0); assert.equal(api.authKeys, 0);
  assert.deepEqual(api.deleted, [], "an existing owner-supplied client is never deleted as cleanup");
  assert.ok(!api.calls.includes("GET /tailnet/-/devices"));
  assert.equal(f.reach.guestKeys.configured(), false);
});

test("an unchanged policy needs no version precondition because no policy write occurs", async t => {
  const api = fakeTailscale({ etag: null,
    policy: `{"tagOwners":{"${GUEST_TAG}":["autogroup:admin"]},"grants":[{"src":["${GUEST_TAG}"],"dst":["100.64.0.5"],"ip":["tcp:8443"]}]}`,
  });
  const keys = createGuestKeys({ dataDir: setupDir(t), self: "fixture", request: api.request });
  await keys.setupFromAccessToken({ accessToken: TOKEN, ...where });
  assert.equal(api.writes, 0); assert.equal(api.clients.length, 1);
  assert.equal(keys.configured(), true);
});
