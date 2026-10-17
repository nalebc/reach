import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Real src/start.ts and private routing in a synthetic browser. These tests
// don't claim that a phone VPN, OS routing or a Tailscale node was exercised.
const ORIGIN = "https://mac.t.ts.net";
const CONFIG = { product: "Reach", origin: ORIGIN + ":8443", home: ORIGIN, name: "Mac", instance: "i1", tailnet: { wasm: "client.wasm", exec: "exec.js" } };
const PEER = { id: "mac", computerId: "computer-1", name: "Mac", url: ORIGIN, token: "NATIVE", platform: "darwin" };
const DEVICE = { id: "mac", computerId: "computer-1", name: "Mac", platform: "darwin", access: { kind: "device", scopes: ["admin", "files"], expiresAt: Date.now() + 60000 } };
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function page({ native = true, peers = [PEER], device = DEVICE, path = "/", config = CONFIG, face = false, userAgent, wasmWait, loaderWait = false, used = false, wasmFails = false, joinWait } = {}) {
  const calls = [], boots = [], controls = { native, device, wait: null, registrations: 0, face };
  const faceAnswer = pending();
  const dom = await startDom({
    url: ORIGIN + path,
    fakes: { "src/main.tsx": "test/dom/fakes/start-workspace.mjs", "src/passkeys.ts": "test/dom/fakes/start-passkeys.mjs" },
    routes: {
      "/reach-start.json": () => config,
      "/tailnet/client.wasm": () => { if (wasmFails) throw TypeError("WASM prefetch unavailable"); return new Response("wasm"); },
      "/api/health": () => new Response("Unavailable", { status: 503 }),
      "/api/device": async (init, url) => {
        calls.push({ url: url.href, token: new Headers(init.headers).get("Authorization"), method: init.method || "GET" });
        if (controls.wait) await controls.wait;
        if (controls.native === false) throw TypeError("Native private connection unavailable");
        if (typeof controls.native === "number") return Response.json({}, { status: controls.native });
        if (controls.deviceBody) {
          const response = Response.json(controls.device);
          response.json = () => { controls.readingDeviceBody = true; return controls.deviceBody; };
          return response;
        }
        return controls.device;
      },
      "/faceid/options": () => ({ id: "challenge", options: {} }),
      "/faceid/join": async () => { controls.joins = (controls.joins || 0) + 1; if (joinWait) await joinWait; return { key: "tskey-auth-test-key-test", hostname: "rf-test", ticket: "ticket" }; },
    },
  });
  if (userAgent) Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: userAgent });
  dom.document.body.innerHTML = '<main id="start"></main><div id="root"></div>';
  localStorage.setItem("reach.ways", "1");
  localStorage.setItem("reach.devices", JSON.stringify(peers));
  localStorage.setItem("reach.browser.devices", JSON.stringify([{ ...PEER, token: "BROWSER" }]));
  if (used) localStorage.setItem("reach.tailnet.used", "1");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "__reachStartTest");
  globalThis.__reachStartTest = { boots, face, faceAnswer: faceAnswer.promise };
  dom.window.fetch = globalThis.fetch;
  const append = dom.document.head.append.bind(dom.document.head);
  dom.document.head.append = (...nodes) => {
    append(...nodes);
    for (const node of nodes) if (node.tagName === "SCRIPT" && !loaderWait) queueMicrotask(() => node.onload?.());
  };
  const instantiate = WebAssembly.instantiateStreaming;
  const oldGo = Object.getOwnPropertyDescriptor(globalThis, "Go");
  const oldNode = Object.getOwnPropertyDescriptor(globalThis, "reachTailnet");
  globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
  WebAssembly.instantiateStreaming = async () => { controls.instantiating = true; if (wasmWait) await wasmWait; return { instance: {} }; };
  const node = { calls: [], status: () => ({ self: { state: controls.nodeState || "Running" }, peers: [{ dnsName: "mac.t.ts.net.", online: true }] }), wake() {},
    start(cb) { controls.starts = (controls.starts || 0) + 1; this.cb = cb; }, login() { this.calls.push("login"); }, logout() { this.calls.push("logout"); } };
  globalThis.reachTailnet = options => { controls.registrations++; controls.constructorOptions = options; controls.constructed?.(); return node; };
  await dom.load("/src/start.ts");
  return { dom, calls, boots, controls, node, faceAnswer,
    text: () => dom.document.body.textContent,
    wake: event => event === "visibilitychange" ? dom.document.dispatchEvent(new dom.window.Event(event)) : dom.window.dispatchEvent(new dom.window.Event(event)),
    close: async () => {
      // Stop the startup watcher before the fixture restores browser globals.
      dom.window.dispatchEvent(new dom.window.Event("pagehide"));
      await settle();
      WebAssembly.instantiateStreaming = instantiate;
      for (const [name, descriptor] of [["Go", oldGo], ["reachTailnet", oldNode], ["__reachStartTest", previous]]) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
      delete globalThis.__reachHomeOrigin;
      await dom.close();
    },
  };
}

const clients = [
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"],
  ["iPad", "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"],
  ["iPad desktop Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"],
  ["Android", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36"],
  ["Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15"],
  ["Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36"],
];
for (const [client, userAgent] of clients) test(`${client}: a public owner start prefers its existing native approval inline before constructing a browser node`, async () => {
  const f = await page({ userAgent, device: { ...DEVICE, platform: client === "Windows" ? "win32" : "darwin" } });
  try {
    await f.dom.waitFor(() => f.boots.length, 500);
    assert.equal(f.boots.length, 1);
    assert.equal(f.boots[0].url, ORIGIN + "/", "same-origin storage and its approval remain available");
    assert.equal(f.boots[0].way, "native");
    assert.equal(f.boots[0].peers[0].token, "NATIVE");
    assert.equal(f.boots[0].selected.token, "NATIVE");
    assert.equal(f.controls.registrations, 0, "the already-approved native device needs no browser identity");
    assert.deepEqual(f.calls, [{ url: ORIGIN + "/api/device", token: "Bearer NATIVE", method: "GET" }]);
  } finally { await f.close(); }
});

test("an older duplicate native approval cannot bypass the saved replacement", async () => {
  const f = await page({ native: 403, peers: [PEER, { ...PEER, token: "REPLACED" }] });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    assert.equal(f.boots.length, 0);
    assert.deepEqual(f.calls.map(call => call.token), ["Bearer REPLACED"]);
  } finally { await f.close(); }
});

for (const event of ["online", "visibilitychange", "timer"]) test(`a waiting public owner start automatically uses native approval after ${event}`, async () => {
  const f = await page({ native: false });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    f.node.cb.state("NeedsLogin");
    assert.match(f.text(), /Sign in with Tailscale/);
    f.controls.native = true;
    if (event !== "timer") f.wake(event);
    await f.dom.waitFor(() => f.boots.length, event === "timer" ? 6500 : 1000);
    assert.equal(f.boots[0].way, "native");
    const transport = await f.dom.load("/src/tailnet-transport.ts");
    assert.equal(transport.tailnetNode(), f.node, "an existing browser node remains available without duplicating its identity");
    const checked = f.calls.length;
    f.node.cb.authURL("https://login.tailscale.com/late");
    f.node.cb.state("NeedsLogin");
    f.node.cb.state("Running");
    f.wake("online");
    await settle(50);
    assert.equal(f.boots.length, 1, "late browser callbacks cannot mount a second workspace");
    assert.equal(f.calls.length, checked, "the startup watcher stops at handoff");
    assert.deepEqual(f.node.calls, ["login"], "a late callback cannot initiate another login");
    assert.equal(f.dom.document.getElementById("start"), null, "late sign-in UI cannot replace the workspace");
    assert.match(f.text(), /Workspace opened/);
  } finally { await f.close(); }
});

test("a waiting public start kept in the back-forward cache still recovers its native route", async () => {
  const f = await page({ native: false });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent("pagehide", { persisted: true }));
    f.controls.native = true;
    f.wake("online");
    await f.dom.waitFor(() => f.boots.length, 1000);
    assert.equal(f.boots[0].way, "native");
  } finally { await f.close(); }
});

for (const status of [401, 403, 423, 429, 500]) test(`public start cannot use a native approval refused with ${status}`, async () => {
  const f = await page({ native: status });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    assert.equal(f.boots.length, 0);
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls.every(call => call.token === "Bearer NATIVE"));
  } finally { await f.close(); }
});

for (const [name, device] of [
  ["another computer ID", { ...DEVICE, computerId: "other" }],
  ["another device ID", { ...DEVICE, id: "other" }],
]) test(`public owner recovery does not substitute ${name}`, async () => {
  const f = await page({ device });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    assert.equal(f.boots.length, 0);
  } finally { await f.close(); }
});

for (const [name, access] of [
  ["guest", { ...DEVICE.access, kind: "guest", scopes: ["files"] }],
  ["restricted", { ...DEVICE.access, scopes: ["files"] }],
]) test(`a usable native ${name} approval retains its own grant instead of substituting a browser owner`, async () => {
  const f = await page({ peers: [{ ...PEER, token: "OLD_OWNER" }, PEER], device: { ...DEVICE, access } });
  try {
    await f.dom.waitFor(() => f.boots.length, 1000);
    assert.equal(f.boots[0].selected.token, "NATIVE");
    assert.equal(f.boots[0].way, "native");
    assert.equal(f.controls.registrations, 0);
    assert.deepEqual(f.calls.map(call => call.token), ["Bearer NATIVE"]);
    assert.equal(JSON.parse(localStorage.getItem("reach.browser.devices"))[0].token, "BROWSER", "another device's owner approval is untouched");
  } finally { await f.close(); }
});

for (const mutation of ["removed", "replaced"]) test(`a saved native approval ${mutation} while its authentication is pending cannot open the workspace`, async () => {
  const wait = pending();
  const f = await page({ native: false });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    f.controls.native = true;
    f.controls.wait = wait.promise;
    f.wake("online");
    await f.dom.waitFor(() => f.calls.length === 2, 500);
    if (mutation === "removed") localStorage.removeItem("reach.devices");
    else localStorage.setItem("reach.devices", JSON.stringify([{ ...PEER, token: "REPLACED" }]));
    wait.resolve();
    await settle(50);
    assert.equal(f.boots.length, 0);
  } finally { wait.resolve(); await f.close(); }
});

test("native and browser readiness racing can claim the public-start workspace only once", async () => {
  const wait = pending();
  const f = await page({ native: false });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    f.controls.native = true;
    f.controls.wait = wait.promise;
    f.wake("online");
    await f.dom.waitFor(() => f.calls.length === 2, 500);
    f.node.cb.state("Running");
    await f.dom.waitFor(() => f.boots.length === 1, 1000);
    wait.resolve();
    await settle(50);
    assert.equal(f.boots.length, 1);
    assert.equal(f.boots[0].way, "browser");
  } finally { wait.resolve(); await f.close(); }
});

test("native recovery during WASM loading cancels an unstarted browser identity", async () => {
  const wasm = pending();
  const f = await page({ native: false, wasmWait: wasm.promise });
  try {
    await f.dom.waitFor(() => f.controls.instantiating, 1000);
    f.controls.native = true;
    f.wake("online");
    await f.dom.waitFor(() => f.boots.length, 1000);
    wasm.resolve();
    await settle(50);
    assert.equal(f.controls.registrations, 0, "an abandoned startup cannot generate another Tailscale identity");
    assert.equal(f.boots.length, 1);
    assert.equal(f.dom.document.getElementById("start"), null);
  } finally { wasm.resolve(); await f.close(); }
});

for (const face of [false, true]) test(`a native win between ${face ? "Face ID" : "fresh browser"} construction and startup continuation cannot start the abandoned node`, async () => {
  const wasm = pending(), deviceBody = pending();
  const f = await page({ native: false, config: { ...CONFIG, faceId: face }, face, wasmWait: wasm.promise });
  try {
    if (face) {
      await f.dom.waitFor(() => f.dom.document.querySelector(".start-action")?.textContent === "Continue with Face ID", 1000);
      f.dom.document.querySelector(".start-action").click();
      f.faceAnswer.resolve({ id: "credential" });
    }
    await f.dom.waitFor(() => f.controls.instantiating, 1000);
    f.controls.nodeState = "NoState";
    f.controls.deviceBody = deviceBody.promise;
    f.controls.native = true;
    f.wake("online");
    await f.dom.waitFor(() => f.controls.readingDeviceBody, 1000);
    // Resolve authenticated native readiness synchronously in reachTailnet.
    // That check claims the workspace before browserMode resumes from its
    // await, after the new node object exists but before node.start runs.
    f.controls.constructed = () => deviceBody.resolve(DEVICE);
    wasm.resolve();
    await f.dom.waitFor(() => f.boots.length, 1000);
    await settle(50);
    assert.equal(f.controls.registrations, 1, "the constructor-to-continuation gap was reached");
    assert.equal(!!f.controls.constructorOptions.authKey, face, "the Face ID case carries its new enrollment key");
    assert.equal(f.boots[0].way, "native");
    assert.equal(f.boots[0].selected.token, "NATIVE");
    assert.equal(f.controls.starts || 0, 0, "native handoff cannot start/enroll an abandoned fresh node");
    const transport = await f.dom.load("/src/tailnet-transport.ts");
    assert.equal(transport.tailnetNode(), undefined, "an unstarted NoState node cannot block later saved private recovery");
    assert.equal(f.boots.length, 1);
  } finally { wasm.resolve(); deviceBody.resolve(DEVICE); f.faceAnswer.resolve({}); await f.close(); }
});

test("native recovery cancels a stalled browser loader without leaving it cached", async () => {
  const f = await page({ native: false, loaderWait: true });
  try {
    const loader = await f.dom.waitFor(() => f.dom.document.querySelector('script[src="/tailnet/exec.js"]'), 1000);
    f.controls.native = true;
    f.wake("online");
    await f.dom.waitFor(() => f.boots.length, 1000);
    assert.equal(loader.isConnected, false, "the abandoned loader is cancelled");
    assert.equal(f.controls.registrations, 0);
    assert.equal(f.controls.instantiating, undefined);
    assert.equal(f.boots.length, 1);
  } finally { await f.close(); }
});

for (const [name, waitingForFace, used] of [["native opens", false, true], ["Face ID waits", true, true], ["a new Face ID start waits", true, false]]) test(`an abandoned WASM prefetch rejection is observed while ${name}`, async () => {
  const f = await page({ native: !waitingForFace, config: { ...CONFIG, faceId: waitingForFace }, face: waitingForFace, used, wasmFails: true });
  try {
    await f.dom.waitFor(() => waitingForFace ? /Continue with Face ID/.test(f.text()) : f.boots.length, 1000);
    await settle(50);
    assert.deepEqual(f.dom.errors, []);
    assert.equal(f.controls.registrations, 0);
  } finally { await f.close(); }
});

for (const [name, peers] of [
  ["no native approval", []],
  ["a browser-only approval", [{ ...PEER, transport: "funnel" }]],
  ["another computer address", [{ ...PEER, url: "https://other.t.ts.net" }]],
]) test(`public start with ${name} never probes using an ineligible credential`, async () => {
  const f = await page({ peers });
  try {
    await f.dom.waitFor(() => f.node.cb, 1000);
    assert.equal(f.boots.length, 0);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

for (const path of ["/guest#invite=" + "s".repeat(43), "/agent"]) test(`${path.split("#")[0]} never opens a saved owner's native workspace`, async () => {
  const f = await page({ path });
  try {
    if (path.startsWith("/agent")) await f.dom.waitFor(() => /This link is for an AI agent/.test(f.text()), 500);
    else await f.dom.waitFor(() => f.node.cb, 1000);
    assert.equal(f.boots.length, 0);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("a Face ID reply arriving after native recovery cannot redeem a key or reopen startup", async () => {
  const f = await page({ native: false, config: { ...CONFIG, faceId: true }, face: true });
  try {
    await f.dom.waitFor(() => f.dom.document.querySelector(".start-action")?.textContent === "Continue with Face ID", 1000);
    f.dom.document.querySelector(".start-action").click();
    f.controls.native = true;
    f.wake("online");
    await f.dom.waitFor(() => f.boots.length, 1000);
    f.faceAnswer.resolve({ id: "credential" });
    await settle(50);
    assert.equal(f.controls.joins || 0, 0, "the abandoned Face ID operation cannot redeem another identity");
    assert.equal(sessionStorage.getItem("reach.face.ticket"), null);
    assert.equal(f.controls.registrations, 0);
    assert.equal(f.boots.length, 1);
    assert.match(f.text(), /Workspace opened/);
  } finally { f.faceAnswer.resolve({}); await f.close(); }
});

test("an already requested Face ID join reply cannot save a ticket or enroll after native recovery", async () => {
  const join = pending();
  const f = await page({ native: false, config: { ...CONFIG, faceId: true }, face: true, joinWait: join.promise });
  try {
    await f.dom.waitFor(() => f.dom.document.querySelector(".start-action")?.textContent === "Continue with Face ID", 1000);
    f.dom.document.querySelector(".start-action").click();
    f.faceAnswer.resolve({ id: "credential" });
    await f.dom.waitFor(() => f.controls.joins === 1, 1000);
    f.controls.native = true;
    f.wake("online");
    await f.dom.waitFor(() => f.boots.length, 1000);
    join.resolve();
    await settle(50);
    assert.equal(sessionStorage.getItem("reach.face.ticket"), null);
    assert.equal(localStorage.getItem("reach.tailnet.face"), null);
    assert.equal(f.controls.registrations, 0);
    assert.equal(f.boots.length, 1);
    assert.match(f.text(), /Workspace opened/);
  } finally { join.resolve(); f.faceAnswer.resolve({}); await f.close(); }
});
