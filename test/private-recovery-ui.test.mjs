import test from "node:test";
import assert from "node:assert/strict";
import { startDom, typeInto } from "./dom/harness.mjs";

// Synthetic mobile DOM and private transports, not an OS VPN/network test.
const origin = "https://mac.t.ts.net";
const config = { product: "Reach", origin: origin + ":8443", home: origin, name: "Mac", instance: "i1", tailnet: null };
const peer = token => ({ id: "mac", computerId: "computer-1", name: "Mac", url: origin, token, platform: "darwin" });
const device = { id: "mac", computerId: "computer-1", name: "Mac", platform: "darwin", access: { kind: "device", scopes: ["admin", "files"], expiresAt: Date.now() + 60000 }, network: { connected: true, peers: [] }, capabilities: { files: true } };
const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
const savedState = () => ({
  _machinekey: hex(`privkey:${"1".repeat(64)}`),
  "_current-profile": hex("profile-fixture"),
  _profiles: hex({ fixture: { ID: "fixture", Key: "profile-fixture", NodeID: "n-fixture" } }),
  "profile-fixture": hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "n-fixture" } }),
});
const saveBrowserState = state => {
  for (const key of Object.keys(localStorage)) if (key.startsWith("reach.tailnet:")) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(state)) localStorage.setItem(`reach.tailnet:${key}`, value);
};

test("a previously approved phone automatically leaves browser relay for its own native private credential", async () => {
  const dom = await startDom({ url: origin });
  dom.document.documentElement.dataset.connection = "browser";
  const calls = [], changes = [];
  const nativeFetch = async (url, init) => {
    calls.push([String(url), new Headers(init?.headers).get("Authorization")]);
    return Response.json(String(url).endsWith("/api/health") ? { product: "Reach", instance: "i1" } : device);
  };
  dom.window.fetch = nativeFetch;
  let stop;
  try {
    const { watchForApp } = await dom.load("/src/app-watch.ts");
    stop = watchForApp(config, 5, {
      mode: () => "browser",
      current: () => ({ peer: peer("BROWSER"), device }),
      peers: way => [peer(way === "native" ? "APP" : "BROWSER")],
      nativeFetch,
      browser: async () => { throw Error("the working browser node does not need starting"); },
      handoff: change => changes.push(change),
    });
    await dom.waitFor(() => changes.length, 300);
    assert.equal(changes[0].mode, "native");
    assert.equal(changes[0].peer.token, "APP");
    assert.deepEqual(calls, [[origin + "/api/device", "Bearer APP"]]);
    assert.equal(dom.document.querySelector(".start-switch"), null, "no tap required");
  } finally {
    if (typeof stop === "function") stop(); else clearInterval(stop);
    await dom.close();
  }
});

async function fixture(mode = "browser") {
  const dom = await startDom({ url: origin });
  const oldEventTarget = globalThis.EventTarget;
  globalThis.EventTarget = dom.window.EventTarget;
  const traffic = [], changes = [], sockets = [];
  const network = { native: true, browser: true, instance: "i1", candidate: structuredClone(device), writesFail: false };
  const answer = async (route, input, init = {}) => {
    const url = String(input), token = new Headers(init.headers).get("Authorization");
    traffic.push({ route, url, token, method: init.method || "GET" });
    if (!network[route]) throw TypeError("private route unavailable");
    if (network.writesFail && init.method === "POST") throw TypeError("write answer was lost");
    if (url.endsWith("/api/health") && network.healthStatus) return Response.json({}, { status: network.healthStatus });
    if (url.endsWith("/api/health")) return Response.json({ product: "Reach", instance: network.instance });
    if (network.pendingDevice) await network.pendingDevice;
    if (network[route + "Status"]) return Response.json({}, { status: network[route + "Status"] });
    if (token !== `Bearer ${route === "native" ? "APP" : "BROWSER"}`) return Response.json({}, { status: 401 });
    return Response.json(network.candidate);
  };
  dom.window.fetch = (input, init) => answer("native", input, init);
  dom.window.WebSocket = class {
    sent = [];
    constructor(url) { this.url = String(url); sockets.push(this); }
    send(data) { this.sent.push(data); }
    close(code) { this.closed = code; }
  };
  const node = {
    fetch(request) {
      let done = false;
      return {
        abort() {},
        response: answer("browser", request.url, { ...request, headers: Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2)) }).then(async response => {
          const bytes = new Uint8Array(await response.arrayBuffer());
          return { status: response.status, statusText: "OK", headers: [], read: async () => done ? null : (done = true, bytes), cancel() {} };
        }),
      };
    },
    websocket(url, cb) { const socket = { url, cb, sent: [], send(data) { this.sent.push(data); }, close(code) { this.closed = code; }, buffered() { return 0; } }; sockets.push(socket); return socket; },
  };
  const transport = await dom.load("/src/tailnet-transport.ts");
  transport.installTailnet(node, "t.ts.net", mode);
  if (mode === "browser") dom.document.documentElement.dataset.connection = "browser";
  let current = { peer: peer(mode === "native" ? "APP" : "BROWSER"), device: structuredClone(device) };
  let selected = current.peer;
  const { createPrivateRecovery } = await dom.load("/src/app-watch.ts");
  const saved = { native: [peer("APP")], browser: [peer("BROWSER")] };
  const options = {
    current: () => current,
    selected: () => selected,
    peers: way => saved[way],
    nativeFetch: (input, init) => answer("native", input, init),
    browser: async () => ({ node, fetch: (input, init) => answer("browser", input, init) }),
    handoff(change) { changes.push(change); current = { peer: change.peer, device: change.device }; },
  };
  const recovery = createPrivateRecovery(config, options);
  return { dom, transport, recovery, traffic, changes, network, saved, sockets, node,
    current: () => current, setCurrent: value => { current = value; }, setSelected: value => { selected = value; },
    close: async () => { recovery.stop(); globalThis.EventTarget = oldEventTarget; await dom.close(); },
  };
}

const mobiles = [
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"],
  ["iPad", "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"],
  ["iPad desktop Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"],
  ["Android", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36"],
];
for (const [mobile, userAgent] of mobiles) test(`${mobile} mocked private handoff: native loss uses its approved browser device and automatically returns`, async () => {
  const f = await fixture("native");
  Object.defineProperty(f.dom.window.navigator, "userAgent", { configurable: true, value: userAgent });
  if (mobile.startsWith("iPad")) {
    Object.defineProperty(f.dom.window.navigator, "platform", { configurable: true, value: "MacIntel" });
    Object.defineProperty(f.dom.window.navigator, "maxTouchPoints", { configurable: true, value: 5 });
  }
  try {
    await f.recovery.check();
    assert.equal(f.changes.length, 0, "healthy native route remains preferred");
    f.network.native = false;
    await f.recovery.check();
    assert.equal(f.current().peer.token, "BROWSER");
    assert.equal(f.transport.tailnetBrowser(), true);
    f.network.native = true;
    await f.recovery.check();
    assert.equal(f.current().peer.token, "APP");
    assert.equal(f.transport.tailnetBrowser(), false);
    assert.deepEqual(f.changes.map(change => change.mode), ["browser", "native"]);
    assert.ok(f.traffic.filter(call => call.token).every(call => call.token === `Bearer ${call.route === "native" ? "APP" : "BROWSER"}`), "each mode uses only its own approved credential");
  } finally { await f.close(); }
});

for (const status of [401, 403, 423, 429, 500]) test(`a running native health ${status} does not select an alternate identity`, async () => {
  const f = await fixture("native");
  try {
    f.network.healthStatus = status;
    await f.recovery.check();
    assert.equal(f.changes.length, 0);
    assert.equal(f.transport.privateWay(), "native");
    assert.equal(f.traffic.filter(call => call.route === "browser").length, 0);
  } finally { await f.close(); }
});

test("a transient private bootstrap metadata failure is retried on wake without changing the mounted owner", async () => {
  const dom = await startDom({ url: origin });
  let metadata = 0, stop;
  const traffic = [];
  dom.window.fetch = async input => {
    const url = String(input);
    traffic.push(url);
    if (url.endsWith("/reach-start.json")) {
      metadata++;
      if (metadata === 1) throw TypeError("temporary metadata connection loss");
      return Response.json(config);
    }
    return Response.json({ product: "Reach" });
  };
  try {
    const { watchPrivateRecovery } = await dom.load("/src/app-watch.ts");
    stop = watchPrivateRecovery({ current: () => ({ peer: peer("APP"), device }), handoff() { assert.fail("working owner must stay mounted"); } });
    await dom.waitFor(() => metadata === 1);
    await dom.waitFor(() => true);
    dom.window.dispatchEvent(new dom.window.Event("online"));
    await dom.waitFor(() => metadata === 2, 300);
    await dom.waitFor(() => traffic.some(url => url.endsWith("/api/health")));
    stop();
    dom.window.dispatchEvent(new dom.window.Event("online"));
    assert.equal(metadata, 2, "stopped recovery cannot restart bootstrap");
  } finally { stop?.(); await dom.close(); }
});

test("an asset fetch failure before any standby node exists can recover without login or duplicate nodes", async () => {
  const dom = await startDom({ url: origin });
  const originalInstantiate = WebAssembly.instantiateStreaming;
  let attempts = 0, registrations = 0, starts = 0, state = "Running";
  try {
    saveBrowserState(savedState());
    const { existingBrowserNode } = await dom.load("/src/browser-node.ts");
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => {
      append(...nodes);
      for (const script of nodes) if (script.tagName === "SCRIPT") queueMicrotask(() => script.onload());
    };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    WebAssembly.instantiateStreaming = async () => {
      if (++attempts === 1) throw TypeError("WASM asset connection loss");
      return { instance: {} };
    };
    const node = { start(cb) { starts++; cb.state(state); }, status: () => ({ self: { state } }), login() { assert.fail("no login"); } };
    globalThis.reachTailnet = () => { registrations++; return node; };
    const readyConfig = { ...config, tailnet: { wasm: "client.wasm", exec: "exec.js" } };
    assert.equal(await existingBrowserNode(readyConfig), null);
    assert.equal(registrations, 0);
    assert.equal(await existingBrowserNode(readyConfig), node);
    assert.equal(await existingBrowserNode(readyConfig), node);
    assert.equal(attempts, 2);
    assert.equal(registrations, 1);
    assert.equal(starts, 1);
    state = "NeedsLogin";
    assert.equal(await existingBrowserNode(readyConfig), null, "an earlier Running result cannot cache expired authorization");
    state = "Running";
    assert.equal(await existingBrowserNode(readyConfig), node);
    assert.equal(registrations, 1);
    assert.equal(starts, 1);
  } finally {
    WebAssembly.instantiateStreaming = originalInstantiate;
    delete globalThis.Go;
    delete globalThis.reachTailnet;
    await dom.close();
  }
});

for (const boundary of ["loader", "WASM"]) for (const mutation of ["clear", "replace"]) test(`standby profile ${mutation} during ${boundary} loading cannot start a fresh identity or resurrect storage`, async () => {
  const dom = await startDom({ url: origin });
  const originalInstantiate = WebAssembly.instantiateStreaming;
  const initial = { ...savedState(), extra: hex("existing preference") };
  const replacement = {
    _machinekey: hex(`privkey:${"3".repeat(64)}`),
    "_current-profile": hex("profile-replacement"),
    _profiles: hex({ replacement: { ID: "replacement", Key: "profile-replacement", NodeID: "n-replacement" } }),
    "profile-replacement": hex({ Config: { PrivateNodeKey: `privkey:${"4".repeat(64)}`, NodeID: "n-replacement" } }),
  };
  let script, releaseWasm, heldWasm = false, runs = 0, starts = 0;
  const registrations = [];
  const node = { start(cb) { starts++; cb.state("Running"); }, status: () => ({ self: { state: "Running" } }), login() { assert.fail("recovery must not log in"); } };
  try {
    saveBrowserState(initial);
    localStorage.setItem("reach.guest:private-guest-state", "separate-guest-value");
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => { append(...nodes); script = nodes.find(node => node.tagName === "SCRIPT"); };
    globalThis.Go = class { importObject = {}; run() { runs++; return new Promise(() => {}); } };
    WebAssembly.instantiateStreaming = async () => {
      if (boundary === "WASM" && !heldWasm) {
        heldWasm = true;
        return new Promise(resolve => { releaseWasm = resolve; });
      }
      return { instance: {} };
    };
    globalThis.reachTailnet = configuration => { registrations.push(configuration); return node; };
    const { existingBrowserNode } = await dom.load("/src/browser-node.ts");
    const readyConfig = { ...config, tailnet: { wasm: "client.wasm", exec: "exec.js" } };
    const starting = existingBrowserNode(readyConfig);
    assert.ok(script, "startup waits at the loader with the original profile validated");
    if (boundary === "WASM") {
      script.onload();
      await dom.waitFor(() => releaseWasm);
    }
    const changed = mutation === "clear" ? {} : replacement;
    saveBrowserState(changed);
    if (boundary === "loader") script.onload();
    else releaseWasm({ instance: {} });
    assert.equal(await starting, null);
    assert.equal(registrations.length, 0, "stop before constructing another identity");
    assert.equal(runs, 0, "the changed profile cannot start a Go runtime");
    assert.deepEqual(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith("reach.tailnet:")).map(key => [key.slice("reach.tailnet:".length), localStorage.getItem(key)])), changed);
    saveBrowserState(initial);
    assert.equal(await existingBrowserNode(readyConfig), node, "a later complete approval may retry rejected preload");
    assert.equal(registrations.length, 1);
    assert.equal(starts, 1);
    const store = registrations[0].stateStorage;
    for (const [key, value] of Object.entries(initial)) assert.equal(store.getState(key), value);
    assert.equal(store.getState("private-guest-state"), "", "owner snapshot never borrows guest state");
    const updated = hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "n-fixture", Hostname: "updated-by-runtime" } });
    store.setState("profile-fixture", updated);
    const profiles = hex({ fixture: { ID: "fixture", Key: "profile-fixture", NodeID: "n-fixture", Name: "runtime update" } });
    store.setState("_profiles", profiles);
    store.setState("_current-profile", initial["_current-profile"]);
    store.setState("new-runtime-preference", hex("new preference"));
    assert.equal(store.getState("profile-fixture"), updated);
    assert.equal(localStorage.getItem("reach.tailnet:profile-fixture"), updated);
    assert.equal(store.getState("_profiles"), profiles);
    assert.equal(localStorage.getItem("reach.tailnet:_profiles"), profiles);
    assert.equal(localStorage.getItem("reach.tailnet:_current-profile"), initial["_current-profile"]);
    assert.equal(store.getState("new-runtime-preference"), hex("new preference"));
    assert.equal(localStorage.getItem("reach.tailnet:new-runtime-preference"), hex("new preference"));
    saveBrowserState(changed);
    assert.equal(store.getState("_machinekey"), initial._machinekey, "constructed node keeps the identity it validated");
    store.setState("_current-profile", initial["_current-profile"]);
    store.setState("profile-fixture", updated);
    assert.deepEqual(Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith("reach.tailnet:")).map(key => [key.slice("reach.tailnet:".length), localStorage.getItem(key)])), changed, "runtime writes cannot resurrect or overwrite state another tab cleared/replaced");
    assert.equal(localStorage.getItem("reach.guest:private-guest-state"), "separate-guest-value");
    assert.equal(registrations.length, 1);
    assert.equal(starts, 1);
  } finally {
    WebAssembly.instantiateStreaming = originalInstantiate;
    delete globalThis.Go;
    delete globalThis.reachTailnet;
    await dom.close();
  }
});

test("cancelled standby preload also observes a rejected prefetched WASM asset", async () => {
  let rejectAsset, first = true, script;
  const failedAsset = new Promise((resolve, reject) => { rejectAsset = reject; });
  const dom = await startDom({ url: origin, routes: { "/tailnet/client.wasm": () => {
    if (first) { first = false; return failedAsset; }
    return Response.json({});
  } } });
  const originalInstantiate = WebAssembly.instantiateStreaming;
  let starts = 0;
  const node = { start(cb) { starts++; cb.state("Running"); }, status: () => ({ self: { state: "Running" } }), login() { assert.fail("no login"); } };
  try {
    saveBrowserState(savedState());
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => { append(...nodes); script = nodes.find(node => node.tagName === "SCRIPT"); };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    WebAssembly.instantiateStreaming = async wasm => { await wasm; return { instance: {} }; };
    globalThis.reachTailnet = () => node;
    const { existingBrowserNode } = await dom.load("/src/browser-node.ts");
    const readyConfig = { ...config, tailnet: { wasm: "client.wasm", exec: "exec.js" } };
    const starting = existingBrowserNode(readyConfig);
    saveBrowserState({});
    rejectAsset(TypeError("WASM fetch lost while the profile was cleared"));
    script.onload();
    assert.equal(await starting, null);
    assert.equal(starts, 0);
    saveBrowserState(savedState());
    assert.equal(await existingBrowserNode(readyConfig), node);
    assert.equal(starts, 1);
  } finally {
    WebAssembly.instantiateStreaming = originalInstantiate;
    delete globalThis.Go;
    delete globalThis.reachTailnet;
    await dom.close();
  }
});

for (const stalled of ["loader", "WASM fetch"]) test(`a stalled ${stalled} recovers without duplicate nodes on modeled WebKit without throwIfAborted`, async t => {
  let releaseFetch, reached, firstAsset = true, firstScript = true;
  const fetchWait = new Promise(resolve => { releaseFetch = resolve; });
  const boundary = new Promise(resolve => { reached = resolve; });
  const dom = await startDom({ url: origin, routes: { "/tailnet/client.wasm": () => {
    if (stalled === "WASM fetch" && firstAsset) { firstAsset = false; return fetchWait; }
    return Response.json({});
  } } });
  const originalInstantiate = WebAssembly.instantiateStreaming;
  const throwIfAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "throwIfAborted");
  const abortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason");
  const scripts = [], changes = [], traffic = [];
  let nativeOn = false, current = { peer: peer("APP"), device }, checking, recovery, registrations = 0, runs = 0;
  try {
    Object.defineProperty(AbortSignal.prototype, "throwIfAborted", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal.prototype, "reason", { configurable: true, get: () => undefined });
    saveBrowserState(savedState());
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => {
      append(...nodes);
      for (const script of nodes) if (script.tagName === "SCRIPT") {
        scripts.push(script);
        if (stalled === "loader" && firstScript) { firstScript = false; reached(); }
        else queueMicrotask(() => script.onload?.());
      }
    };
    dom.window.fetch = globalThis.fetch;
    dom.window.WebSocket = class { send() {} close() {} };
    globalThis.Go = class { importObject = {}; run() { runs++; return new Promise(() => {}); } };
    WebAssembly.instantiateStreaming = async wasm => {
      if (stalled === "WASM fetch" && firstAsset === false && registrations === 0) reached();
      await wasm;
      return { instance: {} };
    };
    const browserFetch = async (input, init = {}) => {
      traffic.push({ route: "browser", path: new URL(String(input)).pathname, token: new Headers(init.headers).get("Authorization") });
      return Response.json(device);
    };
    const node = {
      start(cb) { cb.state("Running"); }, status: () => ({ self: { state: "Running" } }), wake() {},
      login() { assert.fail("recovery cannot enroll/log in a new identity"); },
      fetch() { assert.fail("the deterministic probe supplies its browser fetch directly"); }, websocket() {},
    };
    globalThis.reachTailnet = () => { registrations++; return node; };
    const { existingBrowserNode, createBrowserNode } = await dom.load("/src/browser-node.ts");
    const { createPrivateRecovery } = await dom.load("/src/app-watch.ts");
    const { privateWay } = await dom.load("/src/tailnet-transport.ts");
    const readyConfig = { ...config, tailnet: { wasm: "client.wasm", exec: "exec.js" } };
    recovery = createPrivateRecovery(readyConfig, {
      current: () => current,
      peers: route => [peer(route === "native" ? "APP" : "BROWSER")],
      nativeFetch: async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        traffic.push({ route: "native", path, token: new Headers(init.headers).get("Authorization") });
        if (!nativeOn) throw TypeError("OS route unavailable");
        return Response.json(path === "/api/health" ? { product: "Reach" } : device);
      },
      browser: async () => { const restored = await existingBrowserNode(readyConfig); return restored ? { node: restored, fetch: browserFetch } : null; },
      handoff(change) { changes.push(change); current = { peer: change.peer, device: change.device }; },
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    checking = recovery.check();
    assert.equal(await Promise.race([boundary.then(() => true), checking.then(() => false)]), true, "preload must reach its asset phase rather than fail on an unsupported AbortSignal method");
    assert.equal(recovery.check(), checking, "one pending check while preload is in progress");
    nativeOn = true;
    t.mock.timers.tick(8000);
    const completed = await Promise.race([checking.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
    assert.equal(completed, true, "bounded preload releases the serialized recovery check");
    assert.equal(registrations, 0);
    assert.equal(runs, 0);
    await recovery.check();
    assert.equal(traffic.filter(call => call.route === "native" && call.path === "/api/health").length, 2, "native return is checked after the bounded preload");
    assert.equal(current.peer.token, "APP");
    nativeOn = false;
    await recovery.check();
    assert.equal(current.peer.token, "BROWSER", "a later attempt can retry the assets and use its own approval");
    assert.equal(registrations, 1);
    assert.equal(runs, 1);
    releaseFetch(Response.json({}));
    scripts[0].onload?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(registrations, 1, "the cancelled loader/fetch cannot start a second node when it eventually completes");
    nativeOn = true;
    await recovery.check();
    assert.equal(privateWay(), "native");
    assert.equal(current.peer.token, "APP");
    assert.deepEqual(changes.map(change => change.mode), ["browser", "native"]);
    assert.ok(traffic.filter(call => call.token).every(call => call.token === `Bearer ${call.route === "native" ? "APP" : "BROWSER"}`));
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(createBrowserNode(readyConfig, { signal: cancelled.signal }), error => error?.name === "AbortError");
    assert.equal(registrations, 1, "an already aborted signal without reason cannot construct another identity");
  } finally {
    recovery?.stop();
    releaseFetch(Response.json({}));
    for (const script of scripts) script.onload?.();
    await checking?.catch(() => {});
    t.mock.timers.reset();
    if (throwIfAborted) Object.defineProperty(AbortSignal.prototype, "throwIfAborted", throwIfAborted);
    else delete AbortSignal.prototype.throwIfAborted;
    if (abortReason) Object.defineProperty(AbortSignal.prototype, "reason", abortReason);
    else delete AbortSignal.prototype.reason;
    WebAssembly.instantiateStreaming = originalInstantiate;
    delete globalThis.Go;
    delete globalThis.reachTailnet;
    await dom.close();
  }
});

for (const refused of ["native-guest", "native-restricted", "browser-401", "browser-403", "browser-guest", "browser-wrong-id", "browser-wrong-computer", "guest-tab", "funnel-tab"]) test(`boot restoration cannot borrow owner rights for ${refused}`, async () => {
  const f = await fixture("native");
  try {
    f.setCurrent(null);
    if (refused === "native-guest") f.network.candidate.access.kind = "guest";
    else if (refused === "native-restricted") f.network.candidate.access.scopes = ["files"];
    else {
      f.saved.native.length = 0;
      if (refused.startsWith("browser-4")) f.network.browserStatus = Number(refused.slice(-3));
      if (refused === "browser-guest") f.network.candidate.access.kind = "guest";
      if (refused === "browser-wrong-id") f.network.candidate.id = "another-id";
      if (refused === "browser-wrong-computer") f.network.candidate.computerId = "another-computer";
      if (refused === "guest-tab") (await f.dom.load("/src/api.ts")).setGuestPeers([]);
      if (refused === "funnel-tab") f.setSelected({ ...peer("INVITATION"), transport: "funnel" });
    }
    await f.recovery.check();
    assert.equal(f.changes.length, 0);
    assert.equal(f.transport.privateWay(), "native");
    if (refused.startsWith("native-") || refused.endsWith("-tab")) assert.equal(f.traffic.filter(call => call.route === "browser").length, 0);
  } finally {
    (await f.dom.load("/src/api.ts")).setGuestPeers(undefined);
    await f.close();
  }
});

for (const nativeApproval of ["missing", 401, 403]) test(`a fresh private page restores its approved browser owner when native approval is ${nativeApproval}`, async () => {
  const dom = await startDom({ url: origin, fakes: { "src/browser-node.ts": "test/dom/fakes/private-recovery-node.mjs" } });
  const oldFetch = globalThis.fetch, oldSocket = globalThis.WebSocket;
  const traffic = [];
  const serve = async (route, input, init = {}) => {
    const path = new URL(String(input), origin).pathname, token = new Headers(init.headers).get("Authorization");
    traffic.push({ route, path, token, method: init.method || "GET" });
    if (path === "/reach-start.json") return Response.json({ ...config, tailnet: { wasm: "fixture.wasm", exec: "fixture.js" } });
    if (path === "/api/health") return Response.json({ product: "Reach", instance: "new-runtime" });
    if (path === "/api/device") return route === "native" ? Response.json({}, { status: nativeApproval === "missing" ? 401 : nativeApproval }) : Response.json(device);
    if (["/api/terminals", "/api/chats", "/api/handoffs"].includes(path)) return Response.json([]);
    return Response.json({ sessions: [], agents: [], activities: [], shortcuts: [], access: [], models: [], modes: [], commands: [] });
  };
  dom.window.fetch = (input, init) => serve("native", input, init);
  globalThis.fetch = (input, init) => dom.window.fetch(input, init);
  class Socket { static OPEN = 1; readyState = 1; send() {} close() { this.readyState = 3; } }
  dom.window.WebSocket = globalThis.WebSocket = Socket;
  globalThis.__reachPrivateRecoveryNode = {
    wake() {},
    fetch(request) {
      let done = false;
      return { abort() {}, response: serve("browser", request.url, { ...request, headers: Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2)) }).then(async response => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, statusText: "OK", headers: [], read: async () => done ? null : (done = true, bytes), cancel() {} };
      }) };
    },
    websocket() { return { send() {}, close() {}, buffered: () => 0 }; },
  };
  localStorage.setItem("reach.ways", "1");
  if (nativeApproval !== "missing") localStorage.setItem("reach.devices", JSON.stringify([peer("APP")]));
  localStorage.setItem("reach.browser.devices", JSON.stringify([peer("BROWSER")]));
  saveBrowserState(savedState());
  let view, restoredBeforeUnmount = false;
  try {
    const { default: App } = await dom.load("/src/App.tsx");
    view = await dom.render(dom.React.createElement(App));
    const dispose = view.unmount;
    view.unmount = async () => {
      const installed = globalThis.WebSocket;
      restoredBeforeUnmount ||= installed !== Socket;
      // Fence the cleanup too: a failing isolation assertion must never
      // let a React effect reach Node's real networking implementation.
      globalThis.WebSocket = Socket;
      try { await dispose(); } finally { globalThis.WebSocket = installed; }
    };
    await dom.waitFor(() => dom.document.documentElement.dataset.connection === "browser" && dom.document.querySelector(".home-live"), 1000);
    assert.ok(traffic.some(call => call.route === "browser" && call.path === "/api/health" && !call.token));
    assert.ok(traffic.some(call => call.route === "browser" && call.path === "/api/device" && call.token === "Bearer BROWSER"));
    assert.ok(traffic.every(call => call.method === "GET" || call.path === "/api/device/door-key"), "restoration only reads; the mounted app may request its existing public asset door key");
    assert.ok(traffic.filter(call => call.path === "/api/device/door-key").length <= 1);
    assert.ok(traffic.filter(call => call.token).every(call => call.token === `Bearer ${call.route === "native" ? "APP" : "BROWSER"}`));
    assert.equal(localStorage.getItem("reach.devices"), nativeApproval === "missing" ? null : JSON.stringify([peer("APP")]));
    assert.deepEqual(dom.errors, []);
  } finally {
    // Passive effects can still run while React unmounts. Keep every
    // transport fake installed until its workspace has been disposed.
    await view?.unmount();
    globalThis.fetch = oldFetch;
    globalThis.WebSocket = oldSocket;
    delete globalThis.__reachPrivateRecoveryNode;
    await dom.close();
    assert.equal(restoredBeforeUnmount, false, "the private transport fixture must remain installed until React is unmounted");
  }
});

test("private workspace continuity is in memory only and cannot persist an old credential or survive reload", async () => {
  const dom = await startDom({ url: origin });
  try {
    const api = await dom.load("/src/api.ts");
    for (const route of ["native", "browser"]) {
      if (route === "browser") dom.document.documentElement.dataset.connection = "browser";
      else delete dom.document.documentElement.dataset.connection;
      const saved = { ...peer("CURRENT"), workspaceKey: '["previous-private-credential"]' };
      api.savePeers([saved]);
      const raw = localStorage.getItem(api.peersKey());
      assert.equal(raw.includes("previous-private-credential"), false);
      assert.deepEqual(JSON.parse(raw), [peer("CURRENT")]);
      localStorage.setItem(api.peersKey(), JSON.stringify([saved]));
      assert.deepEqual(api.readPrivatePeers(route), [peer("CURRENT")], "old/malformed saved continuity labels cannot suppress credential replacement on reload");
      assert.deepEqual(api.readPeers(), [peer("CURRENT")]);
    }
  } finally { await dom.close(); }
});

test("held browser peers stay on their browser identity after upgrade; stale socket auth never crosses to native", async () => {
  const f = await fixture();
  try {
    await f.recovery.check();
    assert.equal(f.transport.privateWay(), "native");
    assert.equal(f.transport.peerUsesBrowserTailnet(peer("BROWSER")), true);
    assert.equal(f.transport.peerUsesBrowserTailnet(peer("APP")), false);
    await f.dom.window.fetch(origin + "/api/files", { headers: { Authorization: "Bearer BROWSER" } });
    assert.equal(f.traffic.at(-1).route, "browser");
    const socket = new f.dom.window.WebSocket(origin.replace("https:", "wss:") + "/ws/presence");
    socket.send(JSON.stringify({ type: "auth", token: "BROWSER" }));
    assert.deepEqual(socket.sent, []);
    assert.equal(socket.closed, 4000);
    const allowed = new f.dom.window.WebSocket(origin.replace("https:", "wss:") + "/ws/presence");
    allowed.send(JSON.stringify({ type: "auth", token: "APP" }));
    assert.deepEqual(allowed.sent, [JSON.stringify({ type: "auth", token: "APP" })]);
    await assert.rejects(async () => f.dom.window.fetch("https://other.t.ts.net/api/files", { headers: { Authorization: "Bearer BROWSER" } }), /another computer/);
  } finally { await f.close(); }
});

test("a changed Reach runtime instance does not block return to the same authenticated computer", async () => {
  const f = await fixture("native");
  try {
    f.network.native = false;
    await f.recovery.check();
    f.network.native = true;
    f.network.instance = "new-runtime-after-restart";
    await f.recovery.check();
    assert.equal(f.current().peer.token, "APP");
    assert.equal(f.current().device.computerId, "computer-1");
  } finally { await f.close(); }
});

test("held native peers never send their token through the browser node after native loss, and an unknown write is not replayed", async () => {
  const f = await fixture("native");
  try {
    f.network.writesFail = true;
    await assert.rejects(f.dom.window.fetch(origin + "/api/tasks", { method: "POST", headers: { Authorization: "Bearer APP" }, body: "{}" }), /answer was lost/);
    f.network.native = false;
    await f.recovery.check();
    await assert.rejects(f.dom.window.fetch(origin + "/api/files", { headers: { Authorization: "Bearer APP" } }), /unavailable/);
    assert.equal(f.traffic.at(-1).route, "native");
    assert.equal(f.traffic.filter(call => call.method === "POST").length, 1, "recovery never retries an action");
    assert.equal(f.transport.peerUsesBrowserTailnet(peer("BROWSER")), true);
    assert.equal(f.transport.peerUsesBrowserTailnet(peer("APP")), false);
    const stale = new f.dom.window.WebSocket(origin.replace("https:", "wss:") + "/ws/presence");
    const wire = f.sockets.at(-1);
    wire.cb.open("");
    stale.send(JSON.stringify({ type: "auth", token: "APP" }));
    assert.deepEqual(wire.sent, [], "native credential cannot enter the browser socket");
    assert.equal(wire.closed, 4000);
    const allowed = new f.dom.window.WebSocket(origin.replace("https:", "wss:") + "/ws/presence");
    const browserWire = f.sockets.at(-1);
    browserWire.cb.open("");
    allowed.send(JSON.stringify({ type: "auth", token: "BROWSER" }));
    assert.deepEqual(browserWire.sent, [JSON.stringify({ type: "auth", token: "BROWSER" })]);
  } finally { await f.close(); }
});

for (const refused of ["unapproved", "wrong-computer", "guest-grant", "different-scopes"]) test(`working browser path is retained when preferred native identity is ${refused}`, async () => {
  const f = await fixture();
  try {
    if (refused === "unapproved") f.saved.native[0].token = "not-approved";
    if (refused === "wrong-computer") f.network.candidate.computerId = "another-computer";
    if (refused === "guest-grant") f.network.candidate.access.kind = "guest";
    if (refused === "different-scopes") f.network.candidate.access.scopes = ["admin", "files", "exec"];
    await f.recovery.check();
    assert.equal(f.changes.length, 0);
    assert.equal(f.transport.privateWay(), "browser");
    assert.equal(f.current().peer.token, "BROWSER");
  } finally { await f.close(); }
});

test("node-bound guest and agent grants never select the owner's saved native credential", async () => {
  for (const kind of ["guest", "agent"]) {
    const f = await fixture();
    try {
      f.setCurrent({ peer: peer("INVITED"), device: { ...device, access: { ...device.access, kind } } });
      await f.recovery.check();
      assert.deepEqual(f.traffic, []);
      assert.equal(f.changes.length, 0);
      assert.equal(f.transport.privateWay(), "browser");
    } finally { await f.close(); }
  }
});

test("no approved alternate means no browser startup or new authorization", async () => {
  const f = await fixture("native");
  try {
    f.saved.browser.length = 0;
    f.network.native = false;
    await f.recovery.check();
    assert.equal(f.changes.length, 0);
    assert.equal(f.traffic.filter(call => call.route === "browser").length, 0);
    assert.equal(f.transport.privateWay(), "native");
  } finally { await f.close(); }
});

test("a delayed preferred-route probe cannot switch a stopped or newly restricted workspace", async () => {
  for (const change of ["stop", "guest", "scope-change"]) {
    const f = await fixture();
    let release;
    f.network.pendingDevice = new Promise(resolve => { release = resolve; });
    try {
      const checking = f.recovery.check();
      await f.dom.waitFor(() => f.traffic.length);
      if (change === "stop") f.recovery.stop();
      else f.setCurrent({ ...f.current(), device: { ...device, access: { ...device.access, ...(change === "guest" ? { kind: "guest" } : { scopes: ["admin"] }) } } });
      release();
      await checking;
      assert.equal(f.changes.length, 0, change);
      assert.equal(f.transport.privateWay(), "browser");
    } finally { release(); await f.close(); }
  }
});

test("standby startup restores only a saved browser profile and never asks it to log in", async () => {
  const dom = await startDom({ url: origin });
  const originalInstantiate = WebAssembly.instantiateStreaming;
  const registrations = [], scripts = [];
  try {
    const { existingBrowserNode } = await dom.load("/src/browser-node.ts");
    const readyConfig = { ...config, tailnet: { wasm: "client.wasm", exec: "exec.js" } };
    assert.equal(await existingBrowserNode(readyConfig), null);
    assert.deepEqual(registrations, [], "no saved identity means no registration/login");
    saveBrowserState(savedState());
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => {
      append(...nodes);
      for (const script of nodes) if (script.tagName === "SCRIPT") { scripts.push(script.src); queueMicrotask(() => script.onload()); }
    };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    WebAssembly.instantiateStreaming = async response => { assert.equal((await response).status, 200); return { instance: {} }; };
    let state = "NoState", starts = 0;
    const node = {
      start(cb) { starts++; state = "NeedsLogin"; cb.state(state); cb.authURL("https://login.tailscale.com/unused"); state = "Running"; cb.state(state); },
      status() { return { self: { state } }; },
      login() { assert.fail("recovery must not log in"); },
    };
    globalThis.reachTailnet = configuration => { registrations.push(configuration); return node; };
    assert.equal(await existingBrowserNode(readyConfig), null, "NeedsLogin keeps the active route unchanged");
    assert.equal(await existingBrowserNode(readyConfig), node, "late Running reuses the same node");
    assert.equal(registrations.length, 1);
    assert.equal(starts, 1);
    assert.equal(registrations[0].authKey, undefined);
    assert.equal(registrations[0].stateStorage.getState("_current-profile"), hex("profile-fixture"));
    assert.deepEqual(scripts, [origin + "/tailnet/exec.js"], "ordinary same-origin script loading, no blob/eval");
    assert.equal(dom.document.body.textContent, "", "no sign-in or invitation UI opened");
    state = "NeedsLogin";
    assert.equal(await existingBrowserNode(readyConfig), null, "an existing node that later loses authorization is unavailable");
    state = "Running";
    assert.equal(await existingBrowserNode(readyConfig), node);
    assert.equal(starts, 1);
  } finally {
    WebAssembly.instantiateStreaming = originalInstantiate;
    delete globalThis.Go;
    delete globalThis.reachTailnet;
    await dom.close();
  }
});

test("standby startup timeout retains the same node and can observe late recovery without re-enrollment", async t => {
  const dom = await startDom({ url: origin });
  const originalInstantiate = WebAssembly.instantiateStreaming;
  let state = "Starting", starts = 0, registrations = 0, report, started;
  const starting = new Promise(resolve => { started = resolve; });
  const node = { status: () => ({ self: { state } }), start(cb) { starts++; report = cb; started(); }, login() { assert.fail("no recovery login"); } };
  try {
    saveBrowserState(savedState());
    const { existingBrowserNode } = await dom.load("/src/browser-node.ts");
    const { privateWay } = await dom.load("/src/tailnet-transport.ts");
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => {
      append(...nodes);
      for (const script of nodes) if (script.tagName === "SCRIPT") queueMicrotask(() => script.onload());
    };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    globalThis.reachTailnet = () => { registrations++; return node; };
    WebAssembly.instantiateStreaming = async () => ({ instance: {} });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const configWithClient = { ...config, tailnet: { wasm: "client.wasm", exec: "exec.js" } };
    const restoring = existingBrowserNode(configWithClient);
    await starting;
    t.mock.timers.tick(8000);
    assert.equal(await restoring, null);
    assert.equal(await existingBrowserNode(configWithClient), null);
    assert.equal(privateWay(), "native");
    state = "NeedsLogin";
    report.state(state);
    assert.equal(await existingBrowserNode(configWithClient), null);
    state = "Running";
    report.state(state);
    assert.equal(await existingBrowserNode(configWithClient), node);
    assert.equal(starts, 1);
    assert.equal(registrations, 1);
  } finally {
    t.mock.timers.reset();
    WebAssembly.instantiateStreaming = originalInstantiate;
    delete globalThis.Go;
    delete globalThis.reachTailnet;
    await dom.close();
  }
});

test("incomplete/corrupt persisted browser state cannot construct a new Tailscale identity", async () => {
  const dom = await startDom({ url: origin });
  const originalInstantiate = WebAssembly.instantiateStreaming;
  const registrations = [];
  try {
    const append = dom.document.head.append.bind(dom.document.head);
    dom.document.head.append = (...nodes) => {
      append(...nodes);
      for (const script of nodes) if (script.tagName === "SCRIPT") queueMicrotask(() => script.onload());
    };
    globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
    WebAssembly.instantiateStreaming = async () => ({ instance: {} });
    globalThis.reachTailnet = configuration => {
      registrations.push(configuration);
      return { start(cb) { cb.state("Running"); }, status() { return { self: { state: "Running" } }; } };
    };
    const { existingBrowserNode } = await dom.load("/src/browser-node.ts");
    const variants = {
      "profile pointer alone": { "_current-profile": hex("profile-fixture") },
      "machine key alone": { _machinekey: hex(`privkey:${"1".repeat(64)}`) },
      "missing machine key": { ...savedState(), _machinekey: "" },
      "zero machine key": { ...savedState(), _machinekey: hex(`privkey:${"0".repeat(64)}`) },
      "corrupt hex": { ...savedState(), _profiles: "not-hex" },
      "corrupt JSON": { ...savedState(), _profiles: hex("not JSON") },
      "missing profile preferences": { ...savedState(), "profile-fixture": "" },
      "unrelated node": { ...savedState(), "profile-fixture": hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "another-node" } }) },
      "zero node key": { ...savedState(), "profile-fixture": hex({ Config: { PrivateNodeKey: `privkey:${"0".repeat(64)}`, NodeID: "n-fixture" } }) },
    };
    for (const [reason, state] of Object.entries(variants)) {
      saveBrowserState(state);
      assert.equal(await existingBrowserNode({ ...config, tailnet: { wasm: "client.wasm", exec: "exec.js" } }), null, reason);
    }
    assert.deepEqual(registrations, []);
    assert.equal(dom.document.querySelectorAll("script").length, 0, "refuse before loading or constructing a runtime");
  } finally {
    WebAssembly.instantiateStreaming = originalInstantiate;
    delete globalThis.Go;
    delete globalThis.reachTailnet;
    await dom.close();
  }
});

test("mounted phone composer, acknowledged outbox and unknown in-flight send survive both private handoffs", async () => {
  const chatId = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const chat = { agent: "codex", id: chatId, title: "Keep this draft", cwd: "/work", origin: "app", inApp: true, status: "idle", archived: false, updatedAt: Date.now(), createdAt: Date.now(), held: null };
  const dom = await startDom({ url: origin, fakes: { "src/browser-node.ts": "test/dom/fakes/private-recovery-node.mjs" } });
  const oldFetch = globalThis.fetch, oldSocket = globalThis.WebSocket;
  const traffic = [];
  let nativeOn = true, releaseSend, wakes = 0;
  const sendResult = new Promise(resolve => { releaseSend = resolve; });
  const queued = [{ id: "acknowledged-before-recovery", text: "Queued before recovery", images: 0, at: Date.now() }];
  const currentDevice = { ...device, capabilities: { files: true, terminal: true, apps: true, screen: true } };
  const serve = async (route, input, init = {}) => {
    const path = new URL(String(input), origin).pathname;
    const token = new Headers(init.headers).get("Authorization");
    traffic.push({ route, path, token, method: init.method || "GET" });
    if (route === "native" && !nativeOn) throw TypeError("OS private route unavailable");
    if (path === "/reach-start.json") return Response.json({ ...config, tailnet: { wasm: "fixture.wasm", exec: "fixture.js" } });
    if (path === "/api/health") return Response.json({ product: "Reach", instance: "i1" });
    if (token && token !== `Bearer ${route === "native" ? "APP" : "BROWSER"}`) return Response.json({}, { status: 401 });
    if (path === "/api/device") return Response.json(currentDevice);
    if (path.endsWith("/messages") && init.method === "POST") return Response.json(await sendResult);
    if (path === "/api/sessions") return Response.json({ sessions: [chat], errors: {} });
    if (path === "/api/sessions/health") return Response.json({ agents: [{ agent: "codex", name: "Codex", installed: true, signedIn: true, usable: true, supported: true }] });
    if (path === "/api/sessions/logos") return Response.json({ version: "1", logos: {} });
    if (path === "/api/sessions/models") return Response.json({ models: [], modes: [], mode: null });
    if (path.endsWith("/live")) {
      await new Promise(resolve => setTimeout(resolve, 30));
      return Response.json({ version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0, outbox: queued });
    }
    if (path === `/api/sessions/codex/${chatId}`) return Response.json({ session: chat, items: [] });
    if (["/api/terminals", "/api/chats", "/api/handoffs"].includes(path)) return Response.json([]);
    return Response.json({ sessions: [], agents: [], activities: [], shortcuts: [], access: [], models: [], modes: [], commands: [] });
  };
  dom.window.fetch = (input, init) => serve("native", input, init);
  globalThis.fetch = (input, init) => dom.window.fetch(input, init);
  class Socket {
    static OPEN = 1; static CLOSED = 3;
    readyState = 1;
    constructor(url) { this.url = String(url); }
    send() {}
    close() { this.readyState = 3; }
  }
  dom.window.WebSocket = globalThis.WebSocket = Socket;
  const node = {
    wake() { wakes++; },
    fetch(request) {
      let done = false;
      return { abort() {}, response: serve("browser", request.url, { ...request, headers: Array.from({ length: request.headers.length / 2 }, (_, i) => request.headers.slice(i * 2, i * 2 + 2)) }).then(async response => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, statusText: "OK", headers: [], read: async () => done ? null : (done = true, bytes), cancel() {} };
      }) };
    },
    websocket() { return { send() {}, close() {}, buffered: () => 0 }; },
  };
  globalThis.__reachPrivateRecoveryNode = node;
  for (const [key, value] of Object.entries({
    "reach.ways": "1", "reach.devices": JSON.stringify([peer("APP")]), "reach.active": "mac",
    "reach.browser.devices": JSON.stringify([peer("BROWSER")]), "reach.browser.active": "mac",
    "reach.chatAgent": "codex", "reach.tailnet:_current-profile": "existing-approved-browser",
  })) localStorage.setItem(key, value);
  saveBrowserState(savedState());
  let view;
  try {
    const { default: App } = await dom.load("/src/App.tsx");
    view = await dom.render(dom.React.createElement(App));
    (await dom.waitFor(() => dom.document.querySelector('.mobile-nav [aria-label="Chat"]'))).click();
    (await dom.waitFor(() => [...dom.document.querySelectorAll(".chat-card")].find(card => /Keep this draft/.test(card.textContent)))).click();
    const input = await dom.waitFor(() => dom.document.querySelector('textarea[aria-label="Message"]'));
    await typeInto(input, "Send once even if its answer is late");
    const send = await dom.waitFor(() => dom.document.querySelector('[aria-label="Send"]:not(:disabled)'));
    send.click();
    await dom.waitFor(() => traffic.some(call => call.path.endsWith("/messages")));
    const pending = await dom.waitFor(() => dom.document.querySelector(".as-user.pending"));
    await typeInto(input, "Keep this newer unsent draft");
    await dom.waitFor(() => /Queued before recovery/.test(dom.document.body.textContent));
    const before = structuredClone(dom.window.history.state);
    nativeOn = false;
    dom.window.dispatchEvent(new dom.window.Event("online"));
    await dom.waitFor(() => dom.document.documentElement.dataset.connection === "browser");
    await dom.waitFor(() => dom.document.querySelector('textarea[aria-label="Message"]') === input && input.value === "Keep this newer unsent draft");
    assert.equal(dom.document.querySelector(".as-user.pending"), pending, "unknown in-flight send stays mounted");
    await dom.waitFor(() => /Queued before recovery/.test(dom.document.body.textContent));
    nativeOn = true;
    dom.window.dispatchEvent(new dom.window.Event("online"));
    await dom.waitFor(() => !dom.document.documentElement.dataset.connection);
    let returned;
    try { returned = await dom.waitFor(() => dom.document.querySelector('textarea[aria-label="Message"]')); }
    catch (error) {
      error.message += `\nUI: ${dom.document.body.textContent.slice(-1800)}\nErrors: ${JSON.stringify(dom.errors)}\nRecent requests: ${JSON.stringify(traffic.slice(-18))}`;
      throw error;
    }
    assert.equal(returned, input, "the composer stays mounted through the return to native");
    assert.equal(input.value, "Keep this newer unsent draft");
    assert.deepEqual(dom.window.history.state, before, "navigation stays in the same document");
    queued.push({ id: "original-send-ack", text: "Send once even if its answer is late", images: 0, at: Date.now() });
    releaseSend({ messageId: "original-send-ack", queued: true });
    await dom.waitFor(() => !dom.document.querySelector('[aria-label="Send"]').disabled);
    assert.equal(input.value, "Keep this newer unsent draft", "late acknowledgement cannot replace the new draft");
    assert.equal(traffic.filter(call => call.path.endsWith("/messages")).length, 1, "one write across both recoveries");
    assert.ok(wakes > 0, "the existing standby node wakes on recovery");
    assert.ok(traffic.filter(call => call.token).every(call => call.token === `Bearer ${call.route === "native" ? "APP" : "BROWSER"}`));
    assert.deepEqual(dom.errors, []);
  } finally {
    releaseSend({ queued: true });
    await view?.unmount();
    globalThis.fetch = oldFetch;
    globalThis.WebSocket = oldSocket;
    delete globalThis.__reachPrivateRecoveryNode;
    await dom.close();
  }
});
