import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDom } from "./dom/harness.mjs";
import { createAuth, getConfig, ALL_SCOPES } from "../server/core.mjs";
import { createOwnerConnections } from "../server/owner-connections.mjs";
import { createBrowserHostGuard } from "../server/browser-host-guard.mjs";

// Real enrollment, signatures, authorization and recovery; simulated browser
// and private transports. Physical VPN and mobile network changes are separate.
const origin = "https://mac.t.ts.net";
const config = { product: "Reach", origin: origin + ":8443", home: origin, name: "Mac", instance: "i1", tailnet: null };
const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
const browserState = { _machinekey: hex(`privkey:${"1".repeat(64)}`), "_current-profile": hex("profile"),
  _profiles: hex({ fixture: { Key: "profile", NodeID: "browser" } }),
  profile: hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "browser" } }) };
const owner = { userId: "42", login: "owner@example.test" };
const identity = nodeId => ({ ...owner, nodeId, tagged: false, validUntil: Date.now() + 3600000 });
const device = { id: "mac", computerId: "computer-1", name: "Mac", platform: "darwin" };
async function fixture(source = "native", appAgent = false) {
  const dom = await startDom({ url: origin + "/files" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-owner-ui-"));
  for (const [key, value] of Object.entries(browserState)) localStorage.setItem("reach.tailnet:" + key, value);
  const auth = createAuth(getConfig({ dataDir: dir, tailscaleOwner: owner }));
  const service = createOwnerConnections({ auth, owner });
  const grant = auth.issue("Phone", ALL_SCOPES, "device", { tailscale: identity(source) });
  const guard = createBrowserHostGuard({ clients: () => [...auth.list(), ...(appAgent ? [{
    id: "active-agent", kind: "agent", policy: { browser: true, screen: "apps" }, expiresAt: Date.now() + 3600000,
    browserAppApprover: { clientId: grant.clientId, nodeId: source, userId: owner.userId },
  }] : [])], ownerConnectionIncludes: (...args) => auth.ownerConnectionIncludes(...args), trusted: () => true,
    lookup: async () => ({ BackendState: "Running", Self: { ID: "host" }, Peer: { phone: { ID: "native", OS: "iOS", UserID: 42 } } }),
  });
  await guard.refresh();
  const peer = { ...device, url: origin, token: grant.token };
  const saved = { native: [], browser: [] }; saved[source].push(peer);
  const network = { native: true, browser: true, loseReply: false, revoked: false };
  const calls = [];
  const fetcher = role => async (url, init = {}) => {
    const route = new URL(url, origin).pathname, bearer = new Headers(init.headers).get("Authorization");
    calls.push({ role, route, bearer, method: init.method || "GET" });
    if (route === "/reach-start.json") return Response.json(network.metadata || config);
    if (!network[role]) return Response.json({}, { status: 404 }); // public start keeps metadata, not private APIs
    const body = init.body ? JSON.parse(init.body) : {};
    const request = { reachIdentity: identity(role), headers: {}, method: init.method || "GET", originalUrl: route };
    const authorize = connection => guard.assertOwnerConnection(request, connection);
    try {
      if (route === "/api/auth/owner-connection/challenge") {
        assert.equal(bearer, null, "the source credential never crosses identities");
        return Response.json(service.challenge(identity(role), body, authorize));
      }
      if (route === "/api/auth/owner-connection/join") {
        assert.equal(bearer, null);
        const joined = service.join(identity(role), body, authorize);
        if (network.loseReply) { network.loseReply = false; throw TypeError("Reply lost after enrollment committed"); }
        return Response.json({ ...joined, device });
      }
      if (route === "/api/health") return Response.json({ product: "Reach", instance: "i1" });
      const client = auth.verify(bearer?.slice(7), identity(role));
      if (!client) return Response.json({}, { status: 401 });
      guard.assertRequest(request, client);
      if (route === "/api/device/owner-connection") return Response.json(auth.registerOwnerConnection(client.id, body.publicKey, body.role));
      if (route === "/api/device") return Response.json({ ...device, access: { kind: client.kind, scopes: client.scopes } });
      assert.fail("Unexpected endpoint " + route);
    } catch (error) {
      if (error.status) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  };
  dom.window.fetch = fetcher("native");
  const { ownerEnrollment } = await dom.load("/src/owner-connection.ts");
  const transport = await dom.load("/src/tailnet-transport.ts");
  const { createPrivateRecovery } = await dom.load("/src/app-watch.ts");
  const pair = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const candidates = new Map(), registrations = new Map();
  const keys = { pair: async () => pair, candidate: async (key, connection, role) => {
    const id = [key, connection, role].join(":");
    if (!candidates.has(id)) candidates.set(id, crypto.randomBytes(32).toString("base64url"));
    return candidates.get(id);
  }, registration: async (key, binding, value) => {
    if (value) registrations.set(key + ':' + binding, value);
    return registrations.get(key + ':' + binding);
  } };
  const enroll = () => ownerEnrollment(peer, source, config, { keys,
    sourceFetch: (p, route, init) => fetcher(source)(p.url + route, { ...init, headers: { ...init.headers, Authorization: `Bearer ${p.token}` } }),
    targetFetch: fetcher(source === "native" ? "browser" : "native"),
    save: (role, p) => { saved[role] = [p]; transport.bindPrivatePeer(p, role); },
  });
  const node = { status: () => ({ self: { state: "Running" } }), wake() {} };
  transport.installTailnet(node, "t.ts.net", source);
  let current = { peer, device: { ...device, access: { kind: "device", scopes: ALL_SCOPES } } };
  const changes = [];
  const recovery = createPrivateRecovery(config, { current: () => current, selected: () => current.peer,
    peers: role => saved[role], nativeFetch: fetcher("native"), browser: async () => ({ node, fetch: fetcher("browser") }),
    handoff(change) { changes.push(change); current = { peer: change.peer, device: change.device }; },
  });
  return { dom, auth, peer, grant, network, calls, saved, enroll, recovery, changes, keys, fetcher, transport, current: () => current,
    close: async () => { recovery.stop(); guard.stop(); fs.rmSync(dir, { recursive: true, force: true }); await dom.close(); } };
}
for (const platform of ["iPhone", "iPad", "Android"]) test(`${platform} app-first setup with an active app agent switches native → browser → native at the same URL`, async () => {
  const f = await fixture("native", true);
  try {
    Object.defineProperty(f.dom.window.navigator, "userAgent", { configurable: true, value: platform === "Android" ?
      "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36" :
      `Mozilla/5.0 (${platform}; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1` });
    assert.equal(f.saved.browser.length, 0);
    await f.enroll().join(new AbortController().signal);
    assert.notEqual(f.saved.browser[0].token, f.peer.token);
    f.network.native = false;
    await f.recovery.check();
    assert.equal(f.current().peer.token, f.saved.browser[0].token);
    const workspace = f.current().peer.workspaceKey;
    f.network.native = true;
    await Promise.all([f.recovery.check(), f.recovery.check(), f.recovery.check()]);
    assert.equal(f.current().peer.token, f.peer.token);
    assert.equal(f.current().peer.workspaceKey, workspace);
    assert.deepEqual(f.changes.map(c => c.mode), ["browser", "native"]);
    assert.equal(f.dom.window.location.href, origin + "/files");
    assert.ok(f.calls.every(c => c.method === "GET" || c.route.includes("owner-connection")), "handoff replays no actions");
  } finally { await f.close(); }
});
test("browser-first enrollment keeps working with no app, then authorizes its native path without another approval", async () => {
  const f = await fixture("browser");
  try {
    f.network.native = false;
    const enrollment = f.enroll();
    await assert.rejects(enrollment.join(new AbortController().signal));
    await f.recovery.check(); assert.equal(f.changes.length, 0);
    f.network.native = true;
    await enrollment.join(new AbortController().signal);
    await f.recovery.check();
    assert.equal(f.changes[0].mode, "native");
    f.network.native = false; await f.recovery.check();
    assert.equal(f.changes[1].mode, "browser");
    assert.equal(f.current().peer.token, f.peer.token);
  } finally { await f.close(); }
});
test("concurrent enrollment and an unknown join result reuse the persisted candidate without duplicating approvals", async () => {
  const f = await fixture();
  try {
    f.network.loseReply = true;
    await assert.rejects(f.enroll().join(new AbortController().signal), /Reply lost/);
    assert.equal(f.saved.browser.length, 0);
    await Promise.all([f.enroll().join(new AbortController().signal), f.enroll().join(new AbortController().signal)]);
    assert.equal(f.auth.list().length, 2);
    assert.equal(f.saved.browser.length, 1);
  } finally { await f.close(); }
});
test("revoked owner authority cannot enroll or select a new fallback", async () => {
  const f = await fixture();
  try {
    f.auth.revoke(f.grant.clientId);
    await assert.rejects(f.enroll().join(new AbortController().signal));
    f.network.native = false; await f.recovery.check();
    assert.equal(f.saved.browser.length, 0); assert.equal(f.changes.length, 0);
  } finally { await f.close(); }
});

async function observedFixture(dom, node, initialState = "NeedsLogin") {
  const previous = { instantiate: WebAssembly.instantiateStreaming, Go: globalThis.Go, factory: globalThis.reachTailnet };
  WebAssembly.instantiateStreaming = async () => ({ instance: {} });
  globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
  const append = dom.document.head.append.bind(dom.document.head);
  dom.document.head.append = (...nodes) => { append(...nodes); for (const item of nodes) if (item.tagName === "SCRIPT") queueMicrotask(() => item.onload?.()); };
  let callbacks, storage;
  globalThis.reachTailnet = options => { storage = options.stateStorage; return node; };
  node.start = cb => { callbacks = cb; cb.state(initialState); };
  const module = await dom.load("/src/browser-node.ts");
  const settings = { ...config, tailnet: { wasm: "fixture.wasm", exec: "fixture.js" } };
  const retained = await module.createBrowserNode(settings, { wasm: Promise.resolve(new Response("fixture")) });
  retained.start({ state() {}, authURL(url) { module.rememberOwnerBrowserSignIn(retained, url); } });
  return { module, settings, retained, callbacks,
    saveIdentity() { for (const [key, value] of Object.entries(browserState)) storage.setState(key, value); },
    close() { WebAssembly.instantiateStreaming = previous.instantiate; globalThis.Go = previous.Go; globalThis.reachTailnet = previous.factory; },
  };
}
for (const hasURL of [false, true]) test(`owner setup adopts startup's existing browser node (${hasURL ? "sign-in already requested" : "sign-in not requested"})`, async () => {
  const dom = await startDom({ url: origin });
  let fixture;
  try {
    dom.window.fetch = globalThis.fetch;
    const transport = await dom.load("/src/tailnet-transport.ts");
    let logins = 0;
    const node = { status: () => ({ self: { state: "NeedsLogin" } }), login() { logins++; fixture.callbacks.authURL("https://login.tailscale.com/a/fixture"); } };
    fixture = await observedFixture(dom, node);
    transport.installTailnet(fixture.retained, "t.ts.net", "native");
    if (hasURL) fixture.callbacks.authURL("https://login.tailscale.com/a/fixture");
    const one = await fixture.module.ownerBrowserNode(fixture.settings), two = await fixture.module.ownerBrowserNode(fixture.settings);
    assert.equal(one.node, node); assert.equal(two.node, node);
    assert.equal(one.authURL, "https://login.tailscale.com/a/fixture");
    assert.equal(logins, hasURL ? 0 : 1);
    assert.equal(transport.privateWay(), "native", "working native route stays selected during setup");
    fixture.callbacks.state("Running"); fixture.callbacks.state("NeedsLogin");
    assert.equal(logins, hasURL ? 0 : 1, "retained recovery events cannot initiate a later sign-in");
  } finally { fixture?.close(); await dom.close(); }
});

for (const scenario of ["fresh", "copied-native", "replaced-identity"]) test(`automatic setup preserves browser identity eligibility: ${scenario}`, async () => {
  const f = await fixture(); let observed, stop;
  try {
    const module = await f.dom.load("/src/owner-connection.ts");
    // The DOM's key store is simulated; the Chrome test covers real IndexedDB.
    Object.assign(module.browserOwnerKeys, f.keys);
    let shellAttempts = 0;
    if (scenario === "fresh") Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      async register() { shellAttempts++; throw Error("Temporary worker update failure"); },
    } });
    let servedConfig;
    const node = { status: () => ({ self: { state: "Running" } }), wake() {},
      fetch(request) {
        let read = false;
        const headers = Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2));
        return { abort() {}, response: f.fetcher("browser")(request.url, { ...request, headers, body: request.body ? new TextDecoder().decode(request.body) : undefined }).then(async response => {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { status: response.status, statusText: response.statusText, headers: [], read: async () => read ? null : (read = true, bytes), cancel() {} };
        }) };
      },
    };
    observed = await observedFixture(f.dom, node, "Running"); observed.saveIdentity(); servedConfig = observed.settings; f.network.metadata = servedConfig;
    f.transport.installTailnet(node, "t.ts.net", "native");
    globalThis.fetch = f.dom.window.fetch;
    localStorage.setItem("reach.devices", JSON.stringify([f.peer]));
    localStorage.setItem("reach.browser.identity-lineage", "setup-v1");
    if (scenario !== "fresh") localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...f.peer,
      token: scenario === "copied-native" ? f.peer.token : "OLD-BROWSER", browserIdentity: "0".repeat(64) }]));
    const states = [];
    stop = module.watchOwnerEnrollment(f.peer, state => states.push(state));
    await f.dom.waitFor(() => ["ready", "error"].includes(states.at(-1)?.state), 3000);
    if (scenario !== "fresh") {
      assert.equal(states.at(-1)?.state, "error");
      assert.equal(f.calls.some(call => call.role === "browser" && call.bearer), false, "a copied or replaced approval never crosses browser identities");
      assert.equal(f.auth.list().length, 1, "invalid saved state never creates another approval");
      return;
    }
    assert.equal(states.at(-1)?.state, "ready", JSON.stringify(states));
    assert.ok(shellAttempts >= 1);
    const attempts = shellAttempts;
    const enrollmentCalls = f.calls.filter(call => call.method === "POST").length;
    window.dispatchEvent(new Event("online"));
    await f.dom.waitFor(() => shellAttempts > attempts, 1000);
    assert.equal(f.calls.filter(call => call.method === "POST").length, enrollmentCalls, "retrying startup preparation never repeats enrollment");
    const saved = JSON.parse(localStorage.getItem("reach.browser.devices"))[0];
    assert.match(saved.browserIdentity, /^[a-f0-9]{64}$/);
    assert.equal(await observed.module.browserPeerEligible(saved), true);
    f.saved.browser = [saved]; f.network.native = false;
    await f.recovery.check(); assert.equal(f.changes.at(-1)?.mode, "browser");
    f.network.native = true; await f.recovery.check(); assert.equal(f.changes.at(-1)?.mode, "native");
  } finally { stop?.(); observed?.close(); await f.close(); }
});

for (const scenario of ['prepared', 'legacy-unprepared', 'cold-start', 'cold-start-concurrent']) test(`app-off owner sign-in resumes safely: ${scenario}`, async () => {
  const f = await fixture(); let observed, stop, view;
  let state = 'NeedsLogin', wakes = 0;
  try {
    const module = await f.dom.load('/src/owner-connection.ts');
    Object.assign(module.browserOwnerKeys, f.keys);
    const node = { status: () => ({ self: { state } }), wake() { wakes++; },
      login() { observed.callbacks.authURL('https://login.tailscale.com/a/fixture'); },
      fetch(request) {
        let read = false;
        const headers = Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2));
        return { abort() {}, response: f.fetcher('browser')(request.url, { ...request, headers, body: request.body ? new TextDecoder().decode(request.body) : undefined }).then(async response => {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { status: response.status, statusText: response.statusText, headers: [], read: async () => read ? null : (read = true, bytes), cancel() {} };
        }) };
      },
    };
    observed = await observedFixture(f.dom, node); observed.saveIdentity(); f.network.metadata = observed.settings;
    f.transport.installTailnet(node, 't.ts.net', 'native');
    globalThis.fetch = f.dom.window.fetch;
    localStorage.setItem('reach.devices', JSON.stringify([f.peer]));
    if (scenario !== 'legacy-unprepared') {
      const states = [];
      stop = module.watchOwnerEnrollment(f.peer, value => states.push(value));
      await f.dom.waitFor(() => states.at(-1)?.state === 'signin');
      assert.equal(f.calls.filter(c => c.route === '/api/device/owner-connection').length, 1, 'proof is registered before sign-in finishes');
      stop(); stop = undefined;
    }
    const sourcePosts = f.calls.filter(c => c.role === 'native' && c.method === 'POST').length;
    f.network.native = false;
    let approval = null;
    if (!scenario.startsWith('cold-start')) {
      const { default: OwnerConnection } = await f.dom.load('/src/OwnerConnection.tsx');
      view = await f.dom.render(f.dom.React.createElement(OwnerConnection, {
        peer: f.peer, device: null, visible: true, reconnect: true,
        beginBrowser: (config, browser) => { approval = { config, browser }; },
      }));
      await f.dom.waitFor(() => f.dom.document.querySelector('.owner-connection-details a'));
      assert.equal(f.dom.document.querySelector('details').open, true, 'sign-in remains visible without a live device');
      assert.match(f.dom.document.body.textContent, /Connect securely in this browser/);
      window.dispatchEvent(new Event('online'));
      assert.equal(wakes, 1, 'a changed network wakes the suspended relay');
    }
    state = 'Running'; observed.callbacks.state(state);
    if (scenario === 'cold-start') await module.resumeOwnerConnection(observed.settings, node, new AbortController().signal);
    if (scenario === 'cold-start-concurrent') await Promise.all([1, 2].map(() => module.resumeOwnerConnection(observed.settings, node, new AbortController().signal)));
    if (scenario === 'legacy-unprepared') {
      await f.dom.waitFor(() => approval);
      assert.equal(approval.browser, node);
      assert.equal(f.auth.list().length, 1, 'missing proof requires ordinary approval, not another node inheriting native credentials');
      assert.equal(localStorage.getItem('reach.browser.devices'), null);
    } else {
      await f.dom.waitFor(() => localStorage.getItem('reach.browser.devices'));
      const saved = JSON.parse(localStorage.getItem('reach.browser.devices'))[0];
      assert.notEqual(saved.token, f.peer.token);
      assert.equal(await observed.module.browserPeerEligible(saved), true);
      f.saved.browser = [saved];
      await f.recovery.check();
      assert.equal(f.changes.at(-1)?.mode, 'browser');
      f.network.native = true; await f.recovery.check();
      assert.equal(f.changes.at(-1)?.mode, 'native');
      assert.equal(f.auth.list().length, 2);
    }
    assert.equal(f.calls.filter(c => c.role === 'native' && c.method === 'POST').length, sourcePosts, 'source proof is not re-registered after native loss');
    assert.equal(f.calls.some(c => c.role === 'browser' && c.bearer === `Bearer ${f.peer.token}`), false);
    assert.equal(f.dom.window.location.origin, origin);
  } finally { await view?.unmount(); stop?.(); observed?.close(); await f.close(); }
});

test('a persisted registration cannot enroll after its source approval is revoked', async () => {
  const f = await fixture();
  try {
    await f.enroll().prepare(new AbortController().signal);
    f.auth.revoke(f.grant.clientId); f.network.native = false;
    await assert.rejects(f.enroll().join(new AbortController().signal), /no longer approved/);
    assert.equal(f.saved.browser.length, 0);
  } finally { await f.close(); }
});
