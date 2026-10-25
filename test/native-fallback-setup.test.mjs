import test from "node:test";
import assert from "node:assert/strict";
import { startDom, typeInto } from "./dom/harness.mjs";

const origin = "https://mac.t.ts.net:8443";
const config = { product: "Reach", origin, home: "https://mac.t.ts.net", name: "Mac", instance: "fixture", tailnet: { wasm: "fixture.wasm", exec: "fixture.js" } };
const peer = { id: "mac", computerId: "computer", name: "Mac", platform: "darwin", url: origin, token: "NATIVE" };
const device = { id: "mac", computerId: "computer", name: "Mac", platform: "darwin", access: { kind: "device", scopes: ["admin", "files"], expiresAt: Date.now() + 600000 } };
const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
const identity = {
  _machinekey: hex(`privkey:${"1".repeat(64)}`), _profiles: hex({ fixture: { Key: "profile", NodeID: "fixture-node" } }),
  "_current-profile": hex("profile"), profile: hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "fixture-node" } }),
};

async function setupFixture() {
  const traffic = [], states = [], controllers = [];
  const f = { native: true, nativeDevice: structuredClone(device), browserDevice: structuredClone(device), status: "pending", registrations: 0, starts: 0, logins: 0, wakes: 0, creates: 0, polls: 0, metadata: config, current: { peer, device }, states, traffic };
  const dom = await startDom({ url: origin, routes: {
    "/reach-start.json": () => f.metadata,
    "/tailnet/fixture.wasm": () => new Response("fixture"),
    "/api/health": () => f.native ? { product: "Reach" } : Promise.reject(TypeError("native off")),
    "/api/device": init => {
      traffic.push({ route: "native", path: "/api/device", token: new Headers(init.headers).get("Authorization") });
      if (!f.native) throw TypeError("native off");
      return f.nativeAnswer?.(init) || f.nativeDevice;
    },
  } });
  const oldInstantiate = WebAssembly.instantiateStreaming, oldGo = globalThis.Go, oldFactory = globalThis.reachTailnet;
  WebAssembly.instantiateStreaming = async () => ({ instance: {} });
  globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
  const append = dom.document.head.append.bind(dom.document.head);
  dom.document.head.append = (...nodes) => {
    append(...nodes);
    for (const script of nodes) if (script.tagName === "SCRIPT") queueMicrotask(() => script.onload?.());
  };
  let callbacks, state = "NeedsLogin", stored;
  const answer = async request => {
    const path = new URL(request.url).pathname;
    const headers = new Headers(Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2)));
    const item = { route: "browser", path, method: request.method, token: headers.get("Authorization"), body: request.body ? JSON.parse(new TextDecoder().decode(request.body)) : undefined };
    traffic.push(item);
    if (path === "/api/health") return Response.json({ product: "Reach" });
    if (path === "/api/auth/method") return Response.json(f.method || { method: "tailscale", eligible: true });
    if (path === "/api/auth/requests") {
      f.creates++;
      return f.createAnswer?.(item) || Response.json({ id: "request-one", secret: "browser-request-secret", verification: "123 456", expiresAt: Date.now() + 60000 });
    }
    if (path === "/api/auth/requests/request-one") {
      f.polls++;
      return f.pollAnswer?.(item) || Response.json({ status: f.status, ...(f.status === "approved" ? { token: "BROWSER" } : {}) });
    }
    if (path === "/api/device") return f.browserAnswer?.(item) || (headers.get("Authorization") === "Bearer BROWSER"
      ? Response.json(f.browserDevice) : Response.json({}, { status: 403 }));
    return Response.json({}, { status: 404 });
  };
  const node = {
    start(cb) { f.starts++; callbacks = cb; cb.state(state); },
    status() { return { self: { state }, peers: [] }; },
    login() { f.logins++; callbacks.authURL("https://login.tailscale.com/a/fixture"); },
    wake() { f.wakes++; if (f.wakeCompletes) { f.wakeCompletes = false; f.running(); } }, logout() { throw Error("setup must not log out the retained node"); },
    fetch(request) {
      let read = false;
      return { abort() {}, response: answer(request).then(async response => {
        const body = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, statusText: response.statusText, headers: [], read: async () => read ? null : (read = true, body), cancel() {} };
      }) };
    }, websocket() { throw Error("setup cannot open workspace action sockets"); },
  };
  globalThis.reachTailnet = configuration => { f.registrations++; f.lineageAtRegistration = localStorage.getItem("reach.browser.identity-lineage"); assert.equal(configuration.authKey, undefined); stored = configuration.stateStorage; return node; };
  dom.window.fetch = globalThis.fetch;
  localStorage.setItem("reach.devices", JSON.stringify([peer])); localStorage.setItem("reach.active", peer.id);
  const nativeBytes = localStorage.getItem("reach.devices");
  const module = await dom.load("/src/native-fallback.ts");
  const browserModule = await dom.load("/src/browser-node.ts");
  const transport = await dom.load("/src/tailnet-transport.ts");
  f.make = () => { const run = module.createFallbackSetup({ current: () => f.current, changed: value => states.push(value) }); controllers.push(run); return run; };
  f.running = () => { for (const [key, value] of Object.entries(identity)) stored.setState(key, value); state = "Running"; callbacks.state(state); };
  f.state = value => { state = value; callbacks.state(value); };
  f.writeState = (key, value) => stored.setState(key, value);
  f.ready = async () => dom.waitFor(() => states.some(value => value.phase === "ready"), 2500);
  return Object.assign(f, { dom, node, module, browserModule, transport, nativeBytes,
    close: async () => {
      for (const run of controllers) run.stop();
      WebAssembly.instantiateStreaming = oldInstantiate; globalThis.Go = oldGo; globalThis.reachTailnet = oldFactory;
      await dom.close();
    },
  });
}

// DOM and controlled private identity tests; real browser boundaries have a
// separate Chrome test. These do not enroll a physical phone or Tailscale node.
test("forgetting a browser identity preserves native approvals at a private port", async () => {
  const dom = await startDom({ url: "https://mac.t.ts.net:8443/" });
  try {
    const native = '[{"id":"mac","token":"NATIVE"}]';
    localStorage.setItem("reach.devices", native);
    localStorage.setItem("reach.active", "mac");
    localStorage.setItem("reach.browser.devices", "[old-browser]");
    localStorage.setItem("reach.browser.active", "old");
    localStorage.setItem("reach.browser.identity-lineage", "setup-v1");
    const { forgetSaved } = await dom.load("/src/face-start.ts");
    forgetSaved();
    assert.equal(localStorage.getItem("reach.devices"), native);
    assert.equal(localStorage.getItem("reach.active"), "mac");
    assert.equal(localStorage.getItem("reach.browser.devices"), null);
    assert.equal(localStorage.getItem("reach.browser.active"), null);
    assert.equal(localStorage.getItem("reach.browser.identity-lineage"), null);
  } finally { await dom.close(); }
});

test("forgetting a portless legacy browser identity still retires its old approval", async () => {
  const dom = await startDom({ url: "https://mac.t.ts.net/" });
  try {
    localStorage.setItem("reach.devices", "[legacy-browser]");
    localStorage.setItem("reach.active", "old");
    localStorage.setItem("reach.browser.identity-lineage", "setup-v1");
    const { forgetSaved } = await dom.load("/src/face-start.ts");
    forgetSaved();
    assert.equal(localStorage.getItem("reach.devices"), null);
    assert.equal(localStorage.getItem("reach.active"), null);
    assert.equal(localStorage.getItem("reach.ways"), "1");
    assert.equal(localStorage.getItem("reach.browser.identity-lineage"), null);
  } finally { await dom.close(); }
});

test("explicit same-origin fallback gets its own approval, keeps native work, and supports both handoffs", async () => {
  const f = await setupFixture();
  let recovery;
  try {
    const run = f.make(); const first = run.start();
    assert.equal(run.start(), first, "concurrent setup taps share one startup");
    await first;
    assert.equal(f.states.at(-1).phase, "sign-in");
    assert.equal(f.states.at(-1).signIn, "https://login.tailscale.com/a/fixture");
    assert.equal(f.creates, 0, "network sign-in does not grant Reach access");
    f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    assert.equal(f.states.at(-1).code, "123 456");
    assert.equal(localStorage.getItem("reach.browser.devices"), null);
    f.status = "approved"; f.state("Running");
    await f.ready();
    const approved = JSON.parse(localStorage.getItem("reach.browser.devices"));
    assert.equal(approved[0].token, "BROWSER"); assert.equal(approved[0].url, origin);
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
    assert.equal(localStorage.getItem("reach.active"), peer.id);
    assert.equal(f.transport.privateWay(), "native");
    assert.equal(f.transport.tailnetNode(), undefined, "setup never installs workspace routing");
    assert.equal(f.dom.document.documentElement.dataset.connection, undefined);
    assert.equal(f.creates, 1); assert.equal(f.registrations, 1); assert.equal(f.starts, 1); assert.equal(f.logins, 1);
    assert.ok(f.traffic.filter(call => call.route === "browser").every(call => call.token !== "Bearer NATIVE"));
    assert.ok(f.traffic.filter(call => call.route === "native").every(call => call.token === "Bearer NATIVE"));
    assert.ok(f.traffic.filter(call => call.method === "POST").every(call => call.path === "/api/auth/requests" || call.path === "/api/auth/requests/request-one"), "no approval or workspace action is submitted");
    run.stop();
    const { createPrivateRecovery } = await f.dom.load("/src/app-watch.ts");
    const changes = [];
    recovery = createPrivateRecovery(config, { current: () => f.current, selected: () => f.current.peer,
      handoff(change) { changes.push(change.mode); f.current = { peer: change.peer, device: change.device }; },
      browser: async wake => {
        const node = await f.browserModule.existingBrowserNode(config, { wake });
        return node ? { node, fetch: (input, init) => f.transport.tailnetFetch(node, input, init) } : null;
      },
    });
    f.native = false; await recovery.check();
    f.native = true; await recovery.check();
    assert.deepEqual(changes, ["browser", "native"]);
    assert.equal(f.registrations, 1); assert.equal(f.starts, 1); assert.equal(f.creates, 1);
  } finally { recovery?.stop(); await f.close(); }
});

test("cancel/reopen retains the started node and a late request receipt without replaying create", async () => {
  const f = await setupFixture();
  let release;
  try {
    f.createAnswer = () => new Promise(resolve => { release = () => resolve(Response.json({ id: "request-one", secret: "late-secret", verification: "654 321", expiresAt: Date.now() + 60000 })); });
    const first = f.make(); await first.start(); f.running();
    await f.dom.waitFor(() => f.creates === 1);
    first.stop();
    const reopened = f.make(); await reopened.start();
    release();
    try { await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval"); }
    catch (error) { error.message += JSON.stringify({ states: f.states, creates: f.creates, polls: f.polls, traffic: f.traffic }); throw error; }
    assert.equal(f.states.at(-1).code, "654 321");
    assert.equal(f.creates, 1); assert.equal(f.starts, 1); assert.equal(f.registrations, 1); assert.equal(f.logins, 1);
    f.status = "approved"; f.state("Running"); await f.ready();
    assert.equal(JSON.parse(localStorage.getItem("reach.browser.devices"))[0].token, "BROWSER");
  } finally { release?.(); await f.close(); }
});

test("an uncertain delivered create is not automatically repeated on reopen", async () => {
  const f = await setupFixture();
  try {
    f.createAnswer = () => Promise.reject(TypeError("answer lost after delivery"));
    const first = f.make(); await first.start(); f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "request-unknown"); first.stop();
    const reopened = f.make(); await reopened.start();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "request-unknown");
    assert.equal(f.creates, 1);
    f.createAnswer = undefined;
    reopened.requestAgain();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    assert.equal(f.creates, 2, "only a new explicit action requests approval again");
  } finally { await f.close(); }
});

for (const refused of ["wrong-device", "wrong-computer", "guest", "different-scopes", "incomplete-identity", "identity-during-native-check", "native-revoked", "native-scope", "selection", "forgotten", "browser-replaced"]) {
  test(`setup refuses readiness after ${refused}`, async () => {
    const f = await setupFixture();
    try {
      const run = f.make(); await run.start(); f.running();
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
      if (refused === "wrong-device") f.browserDevice.id = "other";
      if (refused === "wrong-computer") f.browserDevice.computerId = "other";
      if (refused === "guest") f.browserDevice.access.kind = "guest";
      if (refused === "different-scopes") f.browserDevice.access.scopes.push("exec");
      if (refused === "incomplete-identity") localStorage.removeItem("reach.tailnet:_machinekey");
      if (refused === "identity-during-native-check") f.nativeAnswer = () => { localStorage.removeItem("reach.tailnet:_machinekey"); return f.nativeDevice; };
      if (refused === "native-revoked") f.nativeAnswer = () => Response.json({}, { status: 401 });
      if (refused === "native-scope") f.nativeDevice.access.scopes = ["admin"];
      if (refused === "selection") f.current = { peer: { ...peer, token: "OTHER" }, device };
      if (refused === "forgotten") localStorage.removeItem("reach.devices");
      if (refused === "browser-replaced") localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "NEWER-BROWSER" }]));
      f.status = "approved"; f.state("Running");
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(f.states.some(value => value.phase === "ready"), false);
      const saved = JSON.parse(localStorage.getItem("reach.browser.devices") || "[]");
      assert.equal(saved.some(value => value.token === "BROWSER"), false);
      if (refused === "incomplete-identity") assert.equal(f.traffic.some(call => call.route === "browser" && call.token === "Bearer BROWSER"), false,
        "refuse an invalidated browser node before dispatching an authenticated token");
      assert.equal(f.creates, 1);
    } finally { await f.close(); }
  });
}

test("saving an approved fallback merges unrelated saved peers without touching native bytes", async () => {
  const f = await setupFixture();
  try {
    const run = f.make(); await run.start(); f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    const other = { ...peer, id: "other", computerId: "other-computer", url: "https://other.t.ts.net:8443", token: "OTHER" };
    localStorage.setItem("reach.browser.devices", JSON.stringify([other]));
    f.status = "approved"; f.state("Running"); await f.ready();
    assert.deepEqual(JSON.parse(localStorage.getItem("reach.browser.devices")).map(value => value.token), ["OTHER", "BROWSER"]);
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
  } finally { await f.close(); }
});

for (const refused of ["storage", "manifest", "account", "denied"]) test(`setup handles ${refused} without approving or replacing the native grant`, async () => {
  const f = await setupFixture();
  let restore;
  try {
    if (refused === "storage") {
      const original = f.dom.window.Storage.prototype.setItem;
      f.dom.window.Storage.prototype.setItem = () => { throw Error("site data blocked"); };
      restore = () => { f.dom.window.Storage.prototype.setItem = original; };
    }
    if (refused === "manifest") f.metadata = { ...config, tailnet: null };
    if (refused === "account") f.method = { method: "tailscale", eligible: false };
    const run = f.make(); await run.start();
    if (refused === "account" || refused === "denied") f.running();
    if (refused === "denied") {
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
      f.status = "denied"; f.state("Running");
    }
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "error");
    if (refused === "denied") {
      f.state("Running"); f.state("Running");
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(f.creates, 1, "duplicate network notifications cannot request approval after a denial");
    }
    assert.equal(f.states.some(value => value.phase === "ready"), false);
    assert.equal(localStorage.getItem("reach.browser.devices"), null);
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
    assert.equal(f.transport.privateWay(), "native");
    if (refused !== "denied") assert.equal(f.creates, 0);
  } finally { restore?.(); await f.close(); }
});

test("copied or malformed approval tokens never send any known native credential through the browser node", async () => {
  for (const kind of ["current", "saved-other", "bound-removed"]) {
    const f = await setupFixture();
    try {
      const token = kind === "current" ? "NATIVE" : kind === "saved-other" ? "OTHER-NATIVE" : "REMOVED-NATIVE";
      if (kind === "saved-other") localStorage.setItem("reach.devices", JSON.stringify([peer,
        { ...peer, id: "other", computerId: "other", token, url: "https://other.t.ts.net:8443" }]));
      if (kind === "bound-removed") f.transport.bindPrivatePeer({ ...peer, token }, "native");
      localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token }]));
      const run = f.make(); await run.start(); f.running();
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
      assert.equal(f.traffic.some(call => call.route === "browser" && call.token === `Bearer ${token}`), false, kind);
      // Even a malformed approved response cannot turn that credential into
      // a browser credential. Refuse it before any authenticated dispatch.
      f.pollAnswer = () => Response.json({ status: "approved", token }); f.state("Running");
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "error");
      assert.equal(f.traffic.some(call => call.route === "browser" && call.token === `Bearer ${token}`), false, kind);
      assert.equal(f.states.some(state => state.phase === "ready"), false);
      assert.equal(f.creates, 1);
    } finally { await f.close(); }
  }
});

test("existing fallback readiness rechecks the same saved approval and identity after the final native read", async () => {
  for (const change of ["removed", "replaced", "identity", "binding"]) {
    const f = await setupFixture();
    try {
      const first = f.make(); await first.start(); f.running();
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
      f.status = "approved"; f.state("Running"); await f.ready(); first.stop();
      let checked = false;
      f.browserAnswer = () => { checked = true; return Response.json(f.browserDevice); };
      f.nativeAnswer = () => {
        if (checked) {
          if (change === "removed") localStorage.removeItem("reach.browser.devices");
          if (change === "replaced") localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "NEWER" }]));
          if (change === "identity") localStorage.removeItem("reach.tailnet:_machinekey");
          if (change === "binding") {
            const saved = JSON.parse(localStorage.getItem("reach.browser.devices"));
            saved[0].browserIdentity = "0".repeat(64);
            localStorage.setItem("reach.browser.devices", JSON.stringify(saved));
          }
        }
        return f.nativeDevice;
      };
      const before = f.states.length;
      await f.make().start();
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "error");
      assert.equal(f.states.slice(before).some(value => value.phase === "ready"), false, change);
      assert.equal(f.creates, 1, "forget/replacement must not create another approval automatically");
    } finally { await f.close(); }
  }
});

test("saved approval provenance never probes an old token through an identity first created by setup", async () => {
  const f = await setupFixture();
  try {
    const unrelated = { ...peer, id: "other", computerId: "other", url: "https://other.t.ts.net:8443", token: "UNRELATED" };
    const stale = { ...peer, token: "STALE-BROWSER" };
    const before = JSON.stringify([unrelated, stale]);
    localStorage.setItem("reach.browser.devices", before);
    f.browserAnswer = item => item.token === "Bearer STALE-BROWSER" ? Response.json(f.browserDevice) : undefined;
    const run = f.make(); await run.start(); f.running();
    await f.dom.waitFor(() => ["ready", "approval"].includes(f.states.at(-1)?.phase));
    assert.equal(f.traffic.some(call => call.route === "browser" && call.token === "Bearer STALE-BROWSER"), false,
      "a newly complete profile cannot authorize dispatch of an older saved credential");
    assert.equal(f.states.some(state => state.phase === "ready"), false);
    assert.equal(f.creates, 1, "the new browser identity needs its own explicit approval request");
    assert.equal(f.lineageAtRegistration, "setup-v1", "new lineage must persist before a node can create keys");
    assert.equal(await f.browserModule.browserPeerEligible(stale), false, "recovery also refuses the old unbound token");
    assert.equal(localStorage.getItem("reach.browser.devices"), before, "requesting approval preserves every existing record");
    f.status = "approved"; f.state("Running"); await f.ready(); run.stop();
    assert.deepEqual(JSON.parse(localStorage.getItem("reach.browser.devices")).map(value => value.token), ["UNRELATED", "BROWSER"]);
    const checked = f.states.length;
    await f.make().start();
    await f.dom.waitFor(() => f.states.slice(checked).some(state => state.phase === "ready"));
    assert.equal(f.creates, 1, "the newly authenticated and saved approval may be checked on reopen");
  } finally { await f.close(); }
});

test("saved approval provenance retains an initially absent identity across explicit close and reopen", async () => {
  const f = await setupFixture();
  try {
    const before = JSON.stringify([{ ...peer, token: "STALE-BROWSER" }]);
    localStorage.setItem("reach.browser.devices", before);
    f.method = { method: "tailscale", eligible: false };
    const first = f.make(); await first.start(); f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "error"); first.stop();
    assert.equal(f.browserModule.savedBrowserProfile(), "profile", "setup has now persisted its new identity");
    f.method = undefined;
    f.browserAnswer = item => item.token === "Bearer STALE-BROWSER" ? Response.json(f.browserDevice) : undefined;
    const offset = f.traffic.length, stateOffset = f.states.length;
    await f.make().start();
    await f.dom.waitFor(() => ["ready", "approval"].includes(f.states.at(-1)?.phase));
    assert.equal(f.traffic.slice(offset).some(call => call.route === "browser" && call.token === "Bearer STALE-BROWSER"), false,
      "reopening cannot retroactively associate an old approval with the newly written profile");
    assert.equal(f.states.slice(stateOffset).some(state => state.phase === "ready"), false);
    assert.equal(f.creates, 1); assert.equal(f.registrations, 1); assert.equal(f.starts, 1);
    assert.equal(localStorage.getItem("reach.browser.devices"), before);
  } finally { await f.close(); }
});

test("saved approval provenance compares identity keys and NodeID rather than just the profile pointer", async () => {
  for (const changed of ["machine-key", "node-key", "node-id"]) {
    const f = await setupFixture();
    try {
      for (const [key, value] of Object.entries(identity)) localStorage.setItem("reach.tailnet:" + key, value);
      const browserIdentity = await f.browserModule.browserApprovalIdentity().binding();
      localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "STALE-BROWSER", browserIdentity }]));
      f.browserAnswer = item => item.token === "Bearer STALE-BROWSER" ? Response.json(f.browserDevice) : undefined;
      const run = f.make(); await run.start(); f.running();
      if (changed === "machine-key") f.writeState("_machinekey", hex(`privkey:${"4".repeat(64)}`));
      if (changed === "node-key") f.writeState("profile", hex({ Config: { PrivateNodeKey: `privkey:${"5".repeat(64)}`, NodeID: "fixture-node" } }));
      if (changed === "node-id") {
        f.writeState("_profiles", hex({ fixture: { Key: "profile", NodeID: "replacement-node" } }));
        f.writeState("profile", hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "replacement-node" } }));
      }
      assert.equal(f.browserModule.savedBrowserProfile(), "profile");
      assert.equal(f.browserModule.browserNodeIdentityCurrent(f.node), true, "the retained node owns these persisted writes");
      assert.equal(await f.browserModule.browserPeerEligible({ browserIdentity }), false, changed);
      await f.dom.waitFor(() => ["ready", "approval"].includes(f.states.at(-1)?.phase));
      assert.equal(f.traffic.some(call => call.route === "browser" && call.token === "Bearer STALE-BROWSER"), false, changed);
      assert.equal(f.states.some(state => state.phase === "ready"), false, changed);
      assert.equal(f.creates, 1, changed);
    } finally { await f.close(); }
  }
});

test("saved approval provenance permits a complete unchanged identity with ordinary preference writes", async () => {
  const f = await setupFixture();
  try {
    for (const [key, value] of Object.entries(identity)) localStorage.setItem("reach.tailnet:" + key, value);
    assert.equal(await f.browserModule.browserPeerEligible({}), true, "preexisting complete legacy recovery remains eligible without a new-lineage marker");
    // Model a prior independently approved and bound browser record.
    const browserIdentity = await f.browserModule.browserApprovalIdentity().binding();
    localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "BROWSER", browserIdentity }]));
    const run = f.make(); await run.start();
    f.writeState("auxiliary", hex({ lastCheck: 42 }));
    f.writeState("profile", hex({ WantRunning: true, Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "fixture-node" } }));
    f.state("Running"); await f.ready();
    assert.equal(f.creates, 0, "the existing approved identity does not need another approval");
    assert.ok(f.traffic.some(call => call.route === "browser" && call.token === "Bearer BROWSER"));
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
  } finally { await f.close(); }
});

test("saved approval removed or replaced during a held digest is refused before credential dispatch", async () => {
  for (const change of ["removed", "replaced"]) {
    const f = await setupFixture();
    const original = crypto.subtle.digest;
    let release;
    try {
      for (const [key, value] of Object.entries(identity)) localStorage.setItem("reach.tailnet:" + key, value);
      const browserIdentity = await f.browserModule.browserApprovalIdentity().binding();
      localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "BROWSER", browserIdentity }]));
      await f.make().start();
      crypto.subtle.digest = function (...args) {
        const pending = original.apply(this, args);
        return new Promise((resolve, reject) => { release = () => pending.then(resolve, reject); });
      };
      f.state("Running");
      await f.dom.waitFor(() => release);
      if (change === "removed") localStorage.removeItem("reach.browser.devices");
      else localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "REPLACED", browserIdentity }]));
      release();
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "error");
      assert.equal(f.traffic.some(call => call.route === "browser" && call.token === "Bearer BROWSER"), false, change);
      assert.equal(f.states.some(state => state.phase === "ready"), false);
      assert.equal(f.creates, 0, "forgetting an approval never creates another request automatically");
    } finally { release?.(); crypto.subtle.digest = original; await f.close(); }
  }
});

test("a full module reload cannot bind an older approval to a newly persisted browser identity", async () => {
  let snapshot;
  const first = await setupFixture();
  try {
    localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...peer, token: "STALE-BROWSER" }]));
    first.method = { method: "tailscale", eligible: false };
    await first.make().start(); first.running();
    await first.dom.waitFor(() => first.states.at(-1)?.phase === "error");
    assert.equal(first.browserModule.savedBrowserProfile(), "profile");
    assert.equal(first.creates, 0);
    snapshot = Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index); return [key, localStorage.getItem(key)];
    }));
  } finally { await first.close(); }
  const reloaded = await setupFixture();
  try {
    for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value);
    const before = localStorage.getItem("reach.browser.devices");
    reloaded.browserAnswer = item => item.token === "Bearer STALE-BROWSER" ? Response.json(reloaded.browserDevice) : undefined;
    await reloaded.make().start(); reloaded.running();
    await reloaded.dom.waitFor(() => ["ready", "approval"].includes(reloaded.states.at(-1)?.phase));
    assert.equal(reloaded.traffic.some(call => call.route === "browser" && call.token === "Bearer STALE-BROWSER"), false,
      "the new page must refuse unbound legacy credentials before dispatch");
    assert.equal(reloaded.states.some(state => state.phase === "ready"), false);
    assert.equal(reloaded.creates, 1);
    assert.equal(await reloaded.browserModule.browserPeerEligible(JSON.parse(before)[0]), false);
    assert.equal(localStorage.getItem("reach.browser.devices"), before);
  } finally { await reloaded.close(); }
});

test("a newly authenticated bound approval survives a full module reload without another create", async () => {
  let snapshot;
  const first = await setupFixture();
  try {
    await first.make().start(); first.running();
    await first.dom.waitFor(() => first.states.at(-1)?.phase === "approval");
    first.status = "approved"; first.state("Running"); await first.ready();
    await first.dom.waitFor(() => first.states.at(-1)?.cold === "unavailable");
    assert.equal(first.creates, 1, "unsupported/failed cold preparation keeps the separately approved warm fallback");
    const saved = JSON.parse(localStorage.getItem("reach.browser.devices"))[0];
    assert.match(saved.browserIdentity, /^[a-f0-9]{64}$/);
    assert.equal(localStorage.getItem("reach.browser.identity-lineage"), "setup-v1");
    assert.equal(JSON.stringify(saved).includes("privkey:"), false);
    snapshot = Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index); return [key, localStorage.getItem(key)];
    }));
  } finally { await first.close(); }
  const reloaded = await setupFixture();
  try {
    for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value);
    await reloaded.make().start(); reloaded.running(); await reloaded.ready();
    await reloaded.dom.waitFor(() => reloaded.states.at(-1)?.cold === "unavailable");
    assert.equal(reloaded.creates, 0);
    assert.equal(await reloaded.browserModule.browserPeerEligible(JSON.parse(localStorage.getItem("reach.browser.devices"))[0]), true);
    assert.ok(reloaded.traffic.some(call => call.route === "browser" && call.token === "Bearer BROWSER"));
    assert.equal(localStorage.getItem("reach.devices"), reloaded.nativeBytes);
  } finally { await reloaded.close(); }
});

test("refusing the durable lineage marker prevents construction of a missing browser identity", async () => {
  const f = await setupFixture();
  const original = f.dom.window.Storage.prototype.setItem;
  f.dom.window.Storage.prototype.setItem = function (key, value) {
    if (key === "reach.browser.identity-lineage") throw Error("quota exceeded");
    return original.call(this, key, value);
  };
  try {
    await f.make().start();
    assert.equal(f.states.at(-1)?.phase, "error");
    assert.equal(f.registrations, 0); assert.equal(f.starts, 0); assert.equal(f.creates, 0);
    assert.equal(localStorage.getItem("reach.tailnet:_machinekey"), null);
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
  } finally { f.dom.window.Storage.prototype.setItem = original; await f.close(); }
});

test("a refused approval-record write preserves prior records and never reports readiness", async () => {
  const f = await setupFixture();
  let restore;
  try {
    const before = JSON.stringify([{ ...peer, id: "other", computerId: "other", url: "https://other.t.ts.net:8443", token: "UNRELATED" }]);
    localStorage.setItem("reach.browser.devices", before);
    await f.make().start(); f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    const original = f.dom.window.Storage.prototype.setItem;
    f.dom.window.Storage.prototype.setItem = function (key, value) {
      if (key === "reach.browser.devices") throw Error("quota exceeded");
      return original.call(this, key, value);
    };
    restore = () => { f.dom.window.Storage.prototype.setItem = original; };
    f.status = "approved"; f.state("Running");
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "error");
    assert.equal(f.states.some(state => state.phase === "ready"), false);
    assert.equal(localStorage.getItem("reach.browser.devices"), before);
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
    assert.equal(f.creates, 1);
  } finally { restore?.(); await f.close(); }
});

test("a failed identity write cannot promise fallback permanence using a complete older disk identity", async () => {
  const f = await setupFixture();
  let restore;
  try {
    const first = f.make(); await first.start(); f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    f.status = "approved"; f.state("Running"); await f.ready(); first.stop();
    const original = f.dom.window.Storage.prototype.setItem;
    f.dom.window.Storage.prototype.setItem = function (key, value) {
      if (key === "reach.tailnet:profile") throw Error("quota exceeded");
      return original.call(this, key, value);
    };
    restore = () => { f.dom.window.Storage.prototype.setItem = original; };
    f.writeState("profile", hex({ Config: { PrivateNodeKey: `privkey:${"3".repeat(64)}`, NodeID: "fixture-node" } }));
    assert.equal(f.browserModule.savedBrowserProfile(), "profile", "old on-disk state alone is still structurally complete");
    assert.equal(f.browserModule.browserNodeIdentityCurrent(f.node), false, "the failed writer must invalidate persistence proof");
    const before = f.states.length, trafficBefore = f.traffic.length;
    await f.make().start();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "error");
    assert.equal(f.states.slice(before).some(value => value.phase === "ready"), false);
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
    assert.equal(f.creates, 1);
    assert.equal(f.traffic.slice(trafficBefore).some(call => call.route === "browser" && call.token === "Bearer BROWSER"), false);
  } finally { restore?.(); await f.close(); }
});

test("an explicit reopened setup can sign in a retained node again after Running then NeedsLogin", async () => {
  const f = await setupFixture();
  try {
    const first = f.make(); await first.start(); f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    f.status = "approved"; f.state("Running"); await f.ready();
    f.state("NeedsLogin"); first.stop();
    const before = f.states.length;
    await f.make().start();
    assert.equal(f.logins, 2, "the new explicit action may request a new sign-in URL");
    assert.ok(f.states.slice(before).some(value => value.phase === "sign-in" && value.signIn === "https://login.tailscale.com/a/fixture"));
    assert.equal(f.starts, 1); assert.equal(f.registrations, 1);
  } finally { await f.close(); }
});

for (const terminal of ["ready", "denied"]) test(`a ${terminal} setup cannot initiate login from a later NeedsLogin callback`, async () => {
  const f = await setupFixture();
  try {
    const first = f.make(); await first.start(); f.running();
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    f.status = "approved"; f.state("Running"); await f.ready(); first.stop();
    if (terminal === "denied") { localStorage.removeItem("reach.browser.devices"); f.status = "pending"; }
    const before = f.states.length;
    await f.make().start();
    if (terminal === "denied") {
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
      f.status = "denied"; f.state("Running");
      await f.dom.waitFor(() => f.states.at(-1)?.phase === "error");
    } else await f.dom.waitFor(() => f.states.slice(before).some(value => value.phase === "ready"));
    const phase = f.states.at(-1).phase;
    f.state("NeedsLogin");
    assert.equal(f.logins, 1, "terminal sheets do not ask to sign in again");
    assert.equal(f.states.at(-1).phase, phase);
  } finally { await f.close(); }
});

test("returning from a modeled paused SSO wakes the same setup node while native stays healthy", async () => {
  const f = await setupFixture();
  const now = Date.now; let clock = now(), hidden = false;
  Date.now = () => clock;
  Object.defineProperty(f.dom.document, "hidden", { configurable: true, get: () => hidden });
  try {
    const run = f.make(); await run.start();
    f.wakeCompletes = true;
    hidden = true; f.dom.document.dispatchEvent(new f.dom.window.Event("visibilitychange"));
    clock += 1000; hidden = false; f.dom.document.dispatchEvent(new f.dom.window.Event("visibilitychange"));
    assert.equal(f.wakes, 0, "short visibility changes retain the existing three-second threshold");
    hidden = true; f.dom.document.dispatchEvent(new f.dom.window.Event("visibilitychange")); f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide"));
    clock += 3001; hidden = false;
    f.dom.document.dispatchEvent(new f.dom.window.Event("visibilitychange"));
    f.dom.window.dispatchEvent(new f.dom.window.Event("pageshow")); f.dom.window.dispatchEvent(new f.dom.window.Event("focus"));
    assert.equal(f.wakes, 1, "one foreground transition is not reset by focus/pageshow");
    Date.now = now;
    await f.dom.waitFor(() => f.states.at(-1)?.phase === "approval");
    assert.equal(f.native, true); assert.equal(f.transport.privateWay(), "native");
    assert.equal(f.logins, 1); assert.equal(f.registrations, 1); assert.equal(f.starts, 1); assert.equal(f.creates, 1);
    f.dom.window.dispatchEvent(new f.dom.window.Event("online"));
    assert.equal(f.wakes, 2, "a new network event can wake the retained setup node");
    run.stop();
    hidden = true; f.dom.window.dispatchEvent(new f.dom.window.Event("pagehide")); clock += 4000; hidden = false;
    f.dom.window.dispatchEvent(new f.dom.window.Event("pageshow")); f.dom.window.dispatchEvent(new f.dom.window.Event("online"));
    assert.equal(f.wakes, 2, "stopping removes resume/network observers");
  } finally { Date.now = now; await f.close(); }
});

test("Settings setup labels the missing prerequisite and preserves mounted work through approval", async () => {
  const f = await setupFixture();
  let view;
  try {
    // jsdom does not implement modal dialog presentation; Chrome covers it.
    f.dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    f.dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const { default: FallbackSetup, FallbackNotice } = await f.dom.load("/src/FallbackSetup.tsx");
    view = await f.dom.render(f.dom.React.createElement(f.dom.React.Fragment, null,
      f.dom.React.createElement("textarea", { "aria-label": "Unsent work", defaultValue: "Keep this draft" }),
      f.dom.React.createElement(FallbackNotice, { peer, device }),
      f.dom.React.createElement(FallbackSetup, { peer, device })));
    const draft = view.container.querySelector("textarea");
    await typeInto(draft, "Keep this unsent work exactly");
    const unsent = draft.value;
    assert.match(view.container.textContent, /Setup needed/);
    assert.match(view.container.textContent, /Turn Tailscale back on/);
    const button = [...view.container.querySelectorAll("button")].find(value => value.textContent.includes("Set up fallback"));
    button.click();
    await f.dom.waitFor(() => view.container.querySelector('a[href^="https://login.tailscale.com/"]'));
    f.running();
    await f.dom.waitFor(() => view.container.querySelector(".approval-code"));
    assert.equal(draft.value, unsent);
    f.status = "approved"; f.state("Running");
    await f.dom.waitFor(() => view.container.textContent.includes("Fallback is ready."), 2500);
    await f.dom.waitFor(() => view.container.textContent.includes("approval is kept"));
    [...view.container.querySelectorAll("button")].find(value => value.textContent === "Done").click();
    await f.dom.waitFor(() => !view.container.querySelector("dialog"));
    assert.equal(view.container.querySelector("textarea"), draft);
    assert.equal(draft.value, unsent);
    assert.equal(f.transport.privateWay(), "native");
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
    assert.match(view.container.textContent, /Keep open/);
    assert.deepEqual(f.dom.errors, []);
  } finally { await view?.unmount(); await f.close(); }
});

// Home's suggestion (src/PhonePrompts.tsx): offered while the app connection
// is up, before Tailscale is turned off, and it opens the same setup.
async function homeOffer(f, props = {}) {
  f.dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  f.dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  f.dom.window.matchMedia ??= query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  const { default: PhonePrompts } = await f.dom.load("/src/PhonePrompts.tsx");
  const view = await f.dom.render(f.dom.React.createElement(PhonePrompts, { owner: true, url: peer.url, peer, device, ...props }));
  return view;
}
const offer = view => view.container.querySelector('[aria-label="Keep Reach when Tailscale is off"]');

test("Home offers the one-time fallback setup on the app connection and opens the same setup", async () => {
  const f = await setupFixture();
  let view;
  try {
    view = await homeOffer(f);
    await f.dom.waitFor(() => offer(view), 6000);
    assert.equal(f.starts, 0, "the suggestion alone starts no browser node");
    [...offer(view).querySelectorAll("button")].find(value => value.textContent === "Set up").click();
    await f.dom.waitFor(() => view.container.querySelector('a[href^="https://login.tailscale.com/"]'));
    f.running();
    await f.dom.waitFor(() => view.container.querySelector(".approval-code"));
    f.status = "approved"; f.state("Running");
    await f.dom.waitFor(() => view.container.textContent.includes("Fallback is ready."), 2500);
    await f.dom.waitFor(() => view.container.textContent.includes("approval is kept"));
    [...view.container.querySelectorAll("button")].find(value => value.textContent === "Done").click();
    await f.dom.waitFor(() => !view.container.querySelector("dialog"));
    assert.equal(offer(view), null, "set up: not suggested again");
    assert.equal(f.transport.privateWay(), "native");
    assert.equal(localStorage.getItem("reach.devices"), f.nativeBytes);
    assert.deepEqual(f.dom.errors, []);
  } finally { await view?.unmount(); await f.close(); }
});

test("Home's fallback suggestion waits after Not now and is never shown to guests or without the app", async () => {
  const f = await setupFixture();
  const views = [];
  try {
    const first = await homeOffer(f); views.push(first);
    await f.dom.waitFor(() => offer(first), 6000);
    offer(first).querySelector('[aria-label="Not now"]').click();
    await f.dom.waitFor(() => !offer(first));
    assert.equal(JSON.parse(localStorage.getItem("reach.nudge.fallback")).dismissed, 1);
    await first.unmount(); views.length = 0;
    const later = await homeOffer(f); views.push(later);
    await new Promise(resolve => setTimeout(resolve, 4500));
    assert.equal(offer(later), null, "put away: not again the same day");
    await later.unmount(); views.length = 0;
    localStorage.removeItem("reach.nudge.fallback");
    const guest = { ...device, access: { ...device.access, kind: "guest" } };
    const notOwner = { ...device, access: { ...device.access, scopes: ["files"] } };
    for (const props of [{ device: guest }, { device: notOwner }, { owner: false }, { peer: undefined }]) {
      const view = await homeOffer(f, props); views.push(view);
    }
    await new Promise(resolve => setTimeout(resolve, 4500));
    assert.ok(views.every(view => !offer(view)), "only the owner's own approved device on the app connection");
    assert.equal(f.starts, 0);
    assert.deepEqual(f.dom.errors, []);
  } finally { for (const view of views) await view.unmount(); await f.close(); }
});
