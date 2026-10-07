import test from "node:test";
import assert from "node:assert/strict";
import {
  browserAppSessionActive,
  browserHostNode,
  createBrowserHostGuard,
} from "../server/browser-host-guard.mjs";

const status = (id = "nHost") => ({ BackendState: "Running", Self: { ID: id, Online: true },
  Peer: {
    one: { ID: "nPhone", UserID: 42, OS: "iOS", Online: true },
    two: { ID: "nOther", UserID: 42, OS: "darwin", Online: true },
    browser: { ID: "nWasm", UserID: 42, OS: "js", Online: true },
  },
});
function fixture(options = {}) {
  let time = 1000, active = false, reply = status(), calls = 0;
  const owner = (nodeId = "nPhone") => ({ id: `owner:${nodeId}`, kind: "device", scopes: ["admin"],
    expiresAt: 100000, tailscale: { nodeId, userId: "42" } });
  const grant = (nodeId = "nPhone") => ({ id: "muse", kind: "agent", policy: { browser: true, screen: "apps" }, expiresAt: 100000,
    browserAppApprover: { nodeId, userId: "42", clientId: `owner:${nodeId}` } });
  let records;
  const trusted = new WeakSet();
  const guard = createBrowserHostGuard({
    clients: () => records ?? [owner(), owner("nOther"), owner("nWasm"), ...(active ? [grant()] : [])],
    lookup: async () => { calls++; if (reply instanceof Error) throw reply; return reply; },
    trusted: (req) => trusted.has(req), now: () => time,
    ...options,
  });
  const request = (nodeId = "nPhone", { trust = true, url = "/api/agents/browser-invitations", method = "POST" } = {}) => {
    const req = { method, originalUrl: url, headers: {},
      reachIdentity: { nodeId, userId: "42", validUntil: 100000, tagged: false } };
    if (trust) trusted.add(req);
    return req;
  };
  return { guard, request, owner, grant, calls: () => calls,
    setActive: (value) => { active = value; }, setTime: (value) => { time = value; },
    setReply: (value) => { reply = value; }, setClients: (value) => { records = value; } };
}

test("only trusted local status supplies the host's stable node ID", () => {
  assert.equal(browserHostNode(status()), "nHost");
  for (const value of [null, {}, { BackendState: "Stopped", Self: { ID: "nHost" } },
    { BackendState: "Running", Self: { DNSName: "nHost", ID: 123 } },
    { ...status(), Self: { ID: "nHost", Online: false } },
    { ...status(), Self: { ID: "nHost", Expired: true } },
    { ...status(), Self: { ID: "nHost\n" } }])
    assert.throws(() => browserHostNode(value), { status: 503 });
});

test("app invitations guard the host before redemption and until expiry", () => {
  const client = { kind: "agent", policy: { browser: true, screen: "apps" }, expiresAt: 2000 };
  for (const state of ["invited", "pending", "approved", "accepted"])
    assert.equal(browserAppSessionActive({ ...client, status: state }, 1000), true);
  assert.equal(browserAppSessionActive(client, 2000), false);
  assert.equal(browserAppSessionActive({ ...client, expiresAt: undefined }, 1000), true);
  assert.equal(browserAppSessionActive({ ...client, kind: "device" }, 1000), false);
  assert.equal(browserAppSessionActive({ ...client, policy: { browser: true, screen: "ask" } }, 1000), false);
});

test("host access is blocked for reads, owner admission and existing WS checks", async () => {
  const f = fixture();
  assert.equal(f.guard.allows(f.request("nHost"), f.owner("nHost")), true);
  f.setActive(true);
  assert.equal(f.guard.allows(f.request(), f.owner()), false, "unknown self fails closed even for phone");
  await f.guard.refresh();
  for (const url of ["/api/files", "/api/auth/requests", "/api/auth/passkeys", "/api/agents/browser-invitations", "/ws/screen"]) {
    const host = f.request("nHost", { url, method: "GET" });
    assert.equal(f.guard.allows(host, f.owner("nHost")), false, url);
    assert.throws(() => f.guard.assertRequest(host, f.owner("nHost")), { status: 403 });
  }
  assert.equal(f.guard.allows(f.request(), f.owner()), true);
  const reusedSocket = f.request("nHost", { url: "/ws/screen", method: "GET" });
  f.setActive(false);
  assert.equal(f.guard.allows(reusedSocket, f.owner("nHost")), true);
  f.setActive(true);
  assert.equal(f.guard.allows(reusedSocket, f.owner("nHost")), false);
});

test("headers, untrusted identities and expired identity cache cannot bypass the guard", async () => {
  const f = fixture(); f.setActive(true); await f.guard.refresh();
  const fake = f.request("nPhone", { trust: false });
  fake.headers = { "tailscale-user-login": "owner", "x-forwarded-for": "100.64.0.2", "x-reach-node-id": "nPhone" };
  assert.equal(f.guard.allows(fake, f.owner()), false);
  const missing = f.request(); delete missing.reachIdentity;
  assert.equal(f.guard.allows(missing, f.owner()), false);
  const expired = f.request(); expired.reachIdentity.validUntil = 1000;
  assert.equal(f.guard.allows(expired, f.owner()), false);
  f.setTime(6000);
  assert.equal(f.guard.allows(f.request(), f.owner()), false);
  f.setReply(Error("daemon unavailable"));
  await assert.rejects(f.guard.refresh(), { status: 503 });
  assert.equal(f.guard.allows(f.request(), f.owner()), false);
});

test("signed browser agents only bypass the host guard for their narrow routes", async () => {
  const f = fixture(); f.setActive(true);
  const agent = { id: "muse", kind: "agent", policy: { browser: true }, scopes: ["browser:read"], expiresAt: 2000 };
  const request = (url, method = "GET") => f.request("nHost", { url, method, trust: false });
  assert.equal(f.guard.allows(request("/api/browser?x=1"), agent), true);
  assert.equal(f.guard.allows(request("/api/browser"), null), false);
  for (const url of ["/api/agents/browser-requests/id", "/api/auth/requests", "/api/browser/../agents", "/api/%62rowser", "/ws/screen"])
    assert.equal(f.guard.allows(request(url), agent), false, url);
  assert.equal(f.guard.allows(request("/api/browser", "POST"), agent), false);
  const ws = request("/api/browser"); ws.headers.upgrade = "websocket";
  assert.equal(f.guard.allows(ws, agent), false);
  assert.equal(f.guard.allows(request("/api/browser"), { ...agent, kind: "device" }), false);
  f.setTime(2000);
  assert.equal(f.guard.allows(request("/api/browser"), agent), false);
});

test("invitation reservation closes the pre-persistence race and transfers to active grants", async () => {
  let resolve;
  const f = fixture({ lookup: () => new Promise((done) => { resolve = done; }) });
  const pending = f.guard.beginInvitation(f.request(), f.owner());
  assert.equal(f.guard.isActive(), true, "pending guard is raised synchronously");
  assert.equal(f.guard.allows(f.request("nHost"), f.owner("nHost")), false);
  await Promise.resolve(); resolve(status());
  const release = await pending;
  assert.equal(f.guard.isActive(), true);
  f.setActive(true); release(); release();
  assert.equal(f.guard.isActive(), true, "persisted invitation owns the guard now");
  f.setActive(false);
  assert.equal(f.guard.isActive(), false);
});

test("only a verified remote Tailscale owner may create app invitations", async () => {
  const f = fixture();
  await assert.rejects(f.guard.beginInvitation(f.request("nHost"), f.owner("nHost")), { status: 403 });
  assert.equal(f.guard.isActive(), false);
  await assert.rejects(f.guard.beginInvitation(f.request("nPhone", { trust: false }), f.owner()), { status: 403 });
  for (const owner of [null, { ...f.owner(), kind: "agent" }, { ...f.owner(), scopes: [] },
    { ...f.owner(), expiresAt: 1000 }, { ...f.owner(), tailscale: undefined }, f.owner("nOther")])
    await assert.rejects(f.guard.beginInvitation(f.request(), owner), { status: 403 });
  assert.equal(f.guard.isActive(), false);
  const release = await f.guard.beginInvitation(f.request(), f.owner());
  assert.deepEqual(release.approver, { nodeId: "nPhone", userId: "42", clientId: "owner:nPhone" });
  assert.equal(Object.isFrozen(release.approver), true);
  assert.equal(f.guard.isActive(), true); release();
  assert.equal(f.guard.isActive(), false);
});

test("pending invitations are independent and lookup failures release only their own reservation", async () => {
  const f = fixture();
  const releaseOne = await f.guard.beginInvitation(f.request(), f.owner());
  const releaseTwo = await f.guard.beginInvitation(f.request(), f.owner());
  releaseOne(); releaseOne(); assert.equal(f.guard.isActive(), true);
  f.setReply(Error("unavailable"));
  await assert.rejects(f.guard.beginInvitation(f.request(), f.owner()), { status: 503 });
  assert.equal(f.guard.isActive(), true);
  releaseTwo(); assert.equal(f.guard.isActive(), false);
});

test("invalidation and stale async lookup never revive a previous host identity", async () => {
  const f = fixture(); f.setActive(true); await f.guard.refresh();
  assert.equal(f.calls(), 1); await f.guard.refresh(); assert.equal(f.calls(), 1);
  f.guard.invalidate();
  assert.equal(f.guard.allows(f.request(), f.owner()), false);
  f.setReply(status("nPhone")); await f.guard.refresh();
  assert.equal(f.guard.allows(f.request(), f.owner()), false, "new host identity is now blocked");
  let resolve;
  const g = fixture({ lookup: () => new Promise((done) => { resolve = done; }) });
  g.setActive(true); const pending = g.guard.refresh(); await Promise.resolve();
  g.guard.invalidate(); resolve(status());
  await assert.rejects(pending, { status: 503 });
  assert.equal(g.guard.allows(g.request(), g.owner()), false);
});

test("a host identity refreshed every 2 s never lapses for the checks between refreshes", async () => {
  // A live screen refreshes the guard every 2 s and checks it every second
  // (trackIdentity, server/index.mjs): no second may find the cache lapsed.
  const f = fixture(); f.setActive(true);
  for (let t = 1000; t <= 31000; t += 1000) {
    f.setTime(t);
    if ((t - 1000) % 2000 === 0) await f.guard.refresh();
    assert.equal(f.guard.fresh(), true, `fresh at ${t}`);
    assert.equal(f.guard.allows(f.request(), f.owner()), true, `allowed at ${t}`);
  }
  assert.ok(f.calls() >= 6 && f.calls() <= 16, `refreshed ${f.calls()} times in 30 s`);
  // While a refresh is in flight, the copy still within its lifetime serves;
  // a lapsed one does not.
  let resolve;
  const started = () => new Promise((done) => setImmediate(done));
  const g = fixture({ lookup: () => new Promise((done) => { resolve = done; }) });
  g.setActive(true);
  const first = g.guard.refresh(); await started(); resolve(status()); await first;
  g.setTime(4000);
  const second = g.guard.refresh(); await started();
  assert.equal(g.guard.allows(g.request(), g.owner()), true, "kept during the refresh");
  resolve(status()); await second;
  assert.equal(g.guard.fresh(), true);
  g.setTime(20000);
  const third = g.guard.refresh(); await started();
  assert.equal(g.guard.fresh(), false);
  assert.equal(g.guard.allows(g.request(), g.owner()), false, "a lapsed copy never serves");
  resolve(status()); await third;
  assert.equal(g.guard.allows(g.request(), g.owner()), true);
});

test("an unreadable or ambiguous client list fails closed", async () => {
  for (const clients of [() => { throw Error("unreadable grants"); }, () => undefined]) {
    const f = fixture({ clients }); await f.guard.refresh();
    assert.equal(f.guard.isActive(), true);
    assert.equal(f.guard.allows(f.request("nHost"), f.owner("nHost")), false);
  }
});

test("only pinned issuer nodes can reach APIs or public admission while app access is active", async () => {
  const f = fixture(); f.setActive(true); await f.guard.refresh();
  for (const url of ["/api/files", "/api/auth/requests", "/api/agents/browser-invitations"]) {
    assert.equal(f.guard.allows(f.request("nPhone", { url }), f.owner()), true);
    assert.equal(f.guard.allows(f.request("nOther", { url }), f.owner("nOther")), false);
    assert.equal(f.guard.allows(f.request("nOther", { url }), null), false);
  }
  await assert.rejects(f.guard.beginInvitation(f.request("nOther"), f.owner("nOther")), { status: 403 });
  const release = await f.guard.beginInvitation(f.request(), f.owner());
  assert.deepEqual(release.approver, f.grant().browserAppApprover);
  release();
});

test("browser/WASM tailnet nodes on the host cannot create invitations or use owner bearers", async () => {
  const f = fixture();
  await assert.rejects(f.guard.beginInvitation(f.request("nWasm"), f.owner("nWasm")), { status: 403 });
  assert.equal(f.guard.isActive(), false);
  f.setActive(true);
  assert.equal(f.guard.allows(f.request("nWasm"), f.owner("nWasm")), false);
  // Even a pre-existing record that pins a browser node is denied.
  f.setClients([f.owner("nWasm"), f.grant("nWasm")]);
  assert.equal(f.guard.allows(f.request("nWasm"), f.owner("nWasm")), false);
});

test("unknown, expired, tagged or mismatched peer enrollment cannot approve", async () => {
  for (const patch of [{ OS: "" }, { OS: "browser" }, { OS: "wasm" }, { OS: undefined },
    { UserID: 9 }, { Expired: true }, { Online: false }, { Tags: ["tag:agent"] },
    { KeyExpiry: new Date(500).toISOString() }]) {
    const f = fixture(); const value = status(); Object.assign(value.Peer.one, patch); f.setReply(value);
    await assert.rejects(f.guard.beginInvitation(f.request(), f.owner()), { status: 403 });
  }
  const f = fixture(); const value = status(); delete value.Peer; f.setReply(value);
  await assert.rejects(f.guard.beginInvitation(f.request(), f.owner()), { status: 403 });
});

test("persisted pins survive guard recreation, but expired invitations and revoked issuers do not grant privileges", async () => {
  const f = fixture();
  const release = await f.guard.beginInvitation(f.request(), f.owner());
  const created = { ...f.grant(), browserAppApprover: release.approver };
  f.setClients([f.owner(), created]); release();
  const restarted = fixture(); restarted.setClients([restarted.owner(), created]); await restarted.guard.refresh();
  assert.equal(restarted.guard.allows(restarted.request(), restarted.owner()), true);
  restarted.setClients([created]);
  assert.equal(restarted.guard.allows(restarted.request(), restarted.owner()), false, "revoking issuer removes its pin");
  restarted.setClients([restarted.owner(), { ...created, expiresAt: 1000 }]);
  assert.equal(restarted.guard.isActive(), false);
  assert.equal(restarted.guard.allows(restarted.request("nHost"), restarted.owner("nHost")), true);
});

test("missing or fabricated approver records lock owner APIs instead of selecting another device", async () => {
  const f = fixture(); await f.guard.refresh();
  for (const browserAppApprover of [undefined, {}, { nodeId: "nPhone", userId: "42", clientId: "missing" },
    { nodeId: "nOther", userId: "42", clientId: f.owner().id }]) {
    f.setClients([f.owner(), { ...f.grant(), browserAppApprover }]);
    assert.equal(f.guard.isActive(), true);
    assert.equal(f.guard.allows(f.request(), f.owner()), false);
  }
});

test("revoking, expiring or changing an app invitation's creator also stops its agent", async () => {
  const f = fixture();
  const client = { ...f.grant(), scopes: ["browser:read", "browser:request"] };
  const request = () => f.request("nHost", { url: "/api/browser/apps", method: "GET", trust: false });
  f.setClients([f.owner(), client]);
  assert.equal(f.guard.allows(request(), client), true);
  for (const owner of [null, { ...f.owner(), expiresAt: 1000 },
    { ...f.owner(), scopes: [] }, { ...f.owner(), kind: "agent" },
    { ...f.owner(), tailscale: { nodeId: "nOther", userId: "42" } }]) {
    f.setClients([...(owner ? [owner] : []), client]);
    assert.equal(f.guard.allows(request(), client), false);
  }
  // A separate app invitation's valid approver cannot rescue an orphaned one.
  f.setClients([f.owner("nOther"), client, { ...f.grant("nOther"), id: "another-agent" }]);
  assert.equal(f.guard.allows(request(), client), false);
  f.setClients([f.owner(), client]);
  assert.equal(f.guard.allows(request(), { ...client, browserAppApprover: { ...client.browserAppApprover, clientId: "new-owner" } }), false);
});
