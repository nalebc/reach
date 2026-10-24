import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { writeOfflineShell } from "../scripts/offline-shell.mjs";
import { startDom } from "./dom/harness.mjs";
import { PUBLIC_CSP } from "../server/public-start.mjs";

const origin = "https://computer.fixture.ts.net:8443", sha = body => crypto.createHash("sha256").update(body).digest("hex");
const entry = (url, text, type) => { const body = Buffer.from(text); return { path: url, bytes: body.length, sha256: sha(body), type, body }; };
function fixture(version = "one") {
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), glue = Buffer.from("/* fixed Go loader fixture */");
  const runtime = [entry(`/tailnet/reach-tailnet.${sha(wasm).slice(0, 12)}.wasm`, wasm, "application/wasm"),
    entry(`/tailnet/wasm_exec.${sha(glue).slice(0, 12)}.js`, glue, "text/javascript")];
  const entries = [entry("/index.html", `<html><head></head><body>${version}</body></html>`, "text/html"),
    entry(`/assets/app-${version}.js`, `console.log('${version}')`, "text/javascript")];
  return { manifest: { version: 1, build: sha(version), entries }, runtime,
    config: { product: "Reach", origin, home: "https://computer.fixture.ts.net", instance: "fixture", name: "Private computer name",
      faceId: true, token: "CACHE-MUST-NEVER-CONTAIN-THIS", tailnet: { wasm: runtime[0].path.slice(9), exec: runtime[1].path.slice(9) } } };
}
function worker({ buckets = new Map(), clients = [{ id: "a", url: origin + "/" }], fault = () => false,
  beforeMatch = () => {}, now = () => Date.now() } = {}) {
  const events = {}, puts = [], network = [];
  const caches = { open: async name => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const data = buckets.get(name), key = value => typeof value === "string" ? value : value.url;
    return { match: async value => { await beforeMatch(name, key(value)); return data.get(key(value))?.clone(); }, keys: async () => [...data.keys()].map(url => new Request(url)),
      delete: async value => data.delete(key(value)), put: async (value, response) => {
        if (await fault(name, key(value))) throw Error("quota exceeded");
        puts.push({ cache: name, key: key(value) }); data.set(key(value), response.clone());
      } };
  } };
  const self = { location: { origin }, addEventListener(name, callback) { (events[name] ||= []).push(callback); },
    clients: { matchAll: async () => clients, claim: async () => {} }, skipWaiting() {}, registration: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    { self, caches, URL, Response, Request, Headers, ArrayBuffer, Uint8Array, TextDecoder, TextEncoder, atob, crypto: crypto.webcrypto, setTimeout, clearTimeout,
      Date: class extends Date { static now() { return now(); } },
      fetch: async request => { network.push(request.url); throw Error("private listener unavailable"); } });
  const message = async (action, data = {}, source = clients[0]) => {
    const pending = [], values = [];
    for (const callback of events.message) callback({ source, origin: new URL(source.url).origin,
      data: { type: "reach-static-shell-v1", action, ...data }, ports: [{ postMessage: value => values.push(value) }], waitUntil: value => pending.push(value) });
    await Promise.all(pending); return values[0];
  };
  const fetch = async (url, { mode = "navigate", method = "GET", token } = {}) => {
    let answer;
    const request = { url: new URL(url, origin).href, mode, method, headers: new Headers(token ? { Authorization: token } : {}) };
    for (const callback of events.fetch) callback({ request, clientId: "a", resultingClientId: "cold", respondWith(value) { assert.equal(answer, undefined); answer = value; } });
    return answer ? await answer : null;
  };
  const begin = (f, source) => message("begin", { manifest: f.manifest, config: f.config, runtime: f.runtime }, source);
  const save = async (f, source = clients[0]) => {
    const result = await begin(f, source); assert.equal(result.ok, true, JSON.stringify(result));
    for (const e of result.missing) {
      const body = [...f.manifest.entries, ...f.runtime].find(value => value.path === e.path).body;
      const answer = await message("put", { job: result.job, path: e.path, body: Uint8Array.from(body).buffer }, source);
      assert.equal(answer.ok, true);
    }
    return message("commit", { job: result.job }, source);
  };
  return { message, begin, save, fetch, buckets, puts, clients, network };
}

test("a complete public cohort cold-loads query/deep links without caching or intercepting computer traffic", async () => {
  const w = worker(), f = fixture();
  const saved = await w.save(f); assert.equal(saved.ok, true);
  const page = await w.fetch("/files/example?page=files&reach-update=12");
  assert.match(await page.text(), /one/); assert.equal(page.headers.get("X-Reach-Cached-Shell"), f.manifest.build);
  assert.equal(page.headers.get("Content-Security-Policy"), PUBLIC_CSP, "cached owner pages keep the exact private Tailscale policy");
  for (const [name, value] of [["X-Content-Type-Options", "nosniff"], ["Referrer-Policy", "no-referrer"], ["X-Frame-Options", "DENY"],
    ["Strict-Transport-Security", "max-age=31536000"]]) assert.equal(page.headers.get(name), value);
  for (const [url, options] of [["/api/device", {}], ["/api/files/content?root=0", {}], ["/api/auth/requests", { method: "POST" }],
    ["/guest", {}], ["/agent", {}], ["/ws/presence", {}], ["/assets/app-one.js", { mode: "cors", token: "Bearer SECRET" }],
    ["https://public.fixture.ts.net/", {}]]) assert.equal(await w.fetch(url, options), null, url);
  const records = [...w.buckets.get("reach-static-cohorts-v1").values()];
  assert.equal((await Promise.all(records.map(value => value.clone().text()))).join("\n").includes("CACHE-MUST-NEVER-CONTAIN-THIS"), false);
  const bootstrap = await w.message("bootstrap", { build: f.manifest.build });
  assert.deepEqual(JSON.parse(JSON.stringify(bootstrap.config)), { product: "Reach", origin, home: "https://computer.fixture.ts.net", instance: "fixture", name: "Reach", tailnet: f.config.tailnet });
});

test("incomplete, mismatched and invalid public-code preparations never promote an active cohort", async () => {
  for (const kind of ["missing", "wrong-hash", "api-path", "cross-origin", "duplicate", "runtime-hash", "oversized", "mime"]) {
    const w = worker(), f = fixture();
    if (kind === "api-path") f.manifest.entries[1].path = "/api/files/content";
    if (kind === "cross-origin") f.manifest.entries[1].path = "https://evil.test/app.js";
    if (kind === "duplicate") f.manifest.entries.push(f.manifest.entries[0]);
    if (kind === "runtime-hash") f.runtime[0].sha256 = "0".repeat(64);
    if (kind === "oversized") f.runtime[0].bytes = 65 * 1024 * 1024;
    if (kind === "mime") f.manifest.entries[1].type = "text/html";
    const begun = await w.begin(f);
    if (["missing", "wrong-hash"].includes(kind)) {
      assert.equal(begun.ok, true);
      if (kind === "wrong-hash") assert.equal((await w.message("put", { job: begun.job, path: f.manifest.entries[0].path, body: new Uint8Array(f.manifest.entries[0].bytes).buffer })).ok, false);
      assert.equal((await w.message("commit", { job: begun.job })).ok, false);
    } else assert.equal(begun.ok, false, kind);
    assert.equal([...w.buckets.get("reach-static-cohorts-v1").keys()].some(key => key.endsWith("/active")), false, kind);
  }
});

test("quota failure retains the previous complete cohort and shared large-client bytes are not duplicated", async () => {
  let denied = false;
  const w = worker({ fault: (name, key) => denied && name === "reach-static-cohorts-v1" && key.endsWith("/active") });
  const one = fixture(), two = fixture("two"); await w.save(one);
  const before = w.puts.filter(value => value.cache === "reach-static-bytes-v1").length;
  denied = true; assert.equal((await w.save(two)).ok, false); denied = false;
  assert.match(await (await w.fetch("/")).text(), /one/);
  assert.equal(w.puts.filter(value => value.cache === "reach-static-bytes-v1").length - before, 2, "the two unchanged runtime bodies are shared");
  assert.equal((await w.save(two)).ok, true);
  assert.match(await (await w.fetch("/")).text(), /two/);
});

test("a runtime at the measured production Go size is stored once across complete interface versions", async () => {
  const w = worker(), one = fixture(), two = fixture("two");
  // Both retained production builds measured on 2026-10-24 are 34,963,375
  // decoded WASM bytes. This is a size/hash/cache model, not Go execution.
  const body = Buffer.alloc(34963375), digest = sha(body);
  const runtime = entry(`/tailnet/reach-tailnet.${digest.slice(0, 12)}.wasm`, body, "application/wasm");
  for (const f of [one, two]) { f.runtime[0] = runtime; f.config.tailnet.wasm = runtime.path.slice(9); }
  assert.equal((await w.save(one)).ok, true); assert.equal((await w.save(two)).ok, true);
  assert.equal(w.puts.filter(value => value.key.endsWith(digest)).length, 1);
  assert.equal(w.buckets.get("reach-static-bytes-v1").get(new URL("/__reach-static-v1/body/" + digest, origin).href).headers.get("Content-Length"), String(body.length));
});

test("retirement, cancellation and another client cannot commit a late preparation", async () => {
  for (const kind of ["retire", "cancel", "another-client"]) {
    const clients = [{ id: "a", url: origin + "/" }, { id: "b", url: origin + "/" }], w = worker({ clients }), f = fixture();
    const begun = await w.begin(f);
    if (kind === "retire") await w.message("retire");
    if (kind === "cancel") await w.message("cancel", { job: begun.job });
    assert.equal((await w.message("commit", { job: begun.job }, kind === "another-client" ? clients[1] : clients[0])).ok, false, kind);
    assert.equal((await w.message("pin", { build: f.manifest.build })).enabled, false);
  }
});

test("cancellation or retirement during a held cache write cannot publish a late complete cohort", async () => {
  for (const action of ["cancel", "retire"]) {
    let hold = false, entered, resume;
    const gate = new Promise(resolve => { entered = resolve; });
    const w = worker({ fault: async (name, key) => {
      if (hold && name === "reach-static-cohorts-v1" && key.includes("/cohort/")) {
        hold = false; entered(); await new Promise(resolve => { resume = resolve; });
      }
      return false;
    } });
    const one = fixture(), two = fixture("two"); await w.save(one);
    const begun = await w.begin(two);
    for (const entry of begun.missing) {
      const data = [...two.manifest.entries, ...two.runtime].find(value => value.path === entry.path);
      await w.message("put", { job: begun.job, path: entry.path, body: Uint8Array.from(data.body).buffer });
    }
    hold = true; const committing = w.message("commit", { job: begun.job }); await gate;
    const cancelling = w.message(action, { job: begun.job }); resume();
    assert.equal((await committing).ok, false, action); await cancelling;
    if (action === "cancel") assert.match(await (await w.fetch("/")).text(), /one/);
    else assert.equal((await w.message("pin", { build: two.manifest.build })).enabled, false);
  }
});

test("concurrent clients cannot exceed the two-cohort bound or cancel another client's job", async () => {
  const clients = [{ id: "a", url: origin + "/" }, { id: "b", url: origin + "/" }], w = worker({ clients });
  const one = fixture(), two = fixture("two"), three = fixture("three");
  await w.save(one); await w.message("pin", { build: one.manifest.build });
  const left = await w.begin(two, clients[0]), right = await w.begin(three, clients[1]);
  assert.equal(left.ok, true); assert.equal(right.ok, true);
  assert.equal((await w.message("cancel", { job: left.job }, clients[1])).ok, false);
  for (const [job, f, source] of [[left.job, two, clients[0]], [right.job, three, clients[1]]]) {
    for (const entry of [...f.manifest.entries, ...f.runtime]) await w.message("put", { job, path: entry.path, body: Uint8Array.from(entry.body).buffer }, source);
  }
  assert.equal((await w.message("commit", { job: left.job }, clients[0])).ok, true);
  assert.equal((await w.message("commit", { job: right.job }, clients[1])).ok, false, "the still-live first code cohort remains pinned");
  const cohorts = [...w.buckets.get("reach-static-cohorts-v1").keys()].filter(key => key.includes("/cohort/"));
  assert.equal(cohorts.length, 2);
});

test("abandoned expired jobs release capacity while live jobs and cohort pins remain protected", async () => {
  let now = 1000;
  const clients = ["a", "b", "c"].map(id => ({ id, url: origin + "/" })), w = worker({ clients, now: () => now });
  const f = fixture(), first = await w.begin(f, clients[0]), second = await w.begin(f, clients[1]);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal((await w.begin(f, clients[2])).ok, false, "two active preparations retain their slots");
  now += 120001;
  assert.equal((await w.begin(f, clients[2])).ok, true, "a later page can prepare after both abandoned jobs expire");
  for (const [job, source] of [[first.job, clients[0]], [second.job, clients[1]]]) {
    assert.equal((await w.message("put", { job, path: f.manifest.entries[0].path, body: Uint8Array.from(f.manifest.entries[0].body).buffer }, source)).ok, false);
    assert.equal((await w.message("commit", { job }, source)).ok, false);
  }
});

test("cancellation, retirement or expiry during final pointer read-back rolls back a late publication", async () => {
  for (const action of ["cancel", "retire", "expire"]) {
    let arm = false, hold = false, entered, resume, now = 1000;
    const gate = new Promise(resolve => { entered = resolve; });
    const w = worker({ now: () => now,
      fault: (name, key) => { if (arm && name === "reach-static-cohorts-v1" && key.endsWith("/active")) { arm = false; hold = true; } return false; },
      beforeMatch: async (name, key) => {
        if (hold && name === "reach-static-cohorts-v1" && key.endsWith("/active")) {
          hold = false; entered(); await new Promise(resolve => { resume = resolve; });
        }
      },
    });
    const one = fixture(), two = fixture("two"); await w.save(one);
    const begun = await w.begin(two);
    for (const entry of begun.missing) {
      const data = [...two.manifest.entries, ...two.runtime].find(value => value.path === entry.path);
      await w.message("put", { job: begun.job, path: entry.path, body: Uint8Array.from(data.body).buffer });
    }
    arm = true; const committing = w.message("commit", { job: begun.job }); await gate;
    const cancelled = action === "expire" ? (now += 120001, Promise.resolve()) : w.message(action, { job: begun.job });
    resume(); assert.equal((await committing).ok, false, action); await cancelled;
    if (action === "retire") assert.equal((await w.message("pin", { build: two.manifest.build })).enabled, false);
    else assert.match(await (await w.fetch("/")).text(), /one/);
  }
});

test("live and unknown old clients prevent eviction of their complete lazy-code cohort", async () => {
  const clients = [{ id: "a", url: origin + "/" }, { id: "b", url: origin + "/" }], w = worker({ clients });
  const one = fixture(), two = fixture("two"), three = fixture("three");
  await w.save(one); await w.message("pin", { build: one.manifest.build }, clients[0]);
  await w.message("pin", { build: two.manifest.build }, clients[1]); await w.save(two, clients[1]);
  await w.message("pin", { build: two.manifest.build }, clients[1]);
  assert.equal((await w.begin(three, clients[1])).ok, false, "a live older page keeps its lazy modules");
  const restarted = worker({ buckets: w.buckets, clients });
  assert.equal((await restarted.begin(three, clients[1])).ok, false, "unknown live pages after worker restart are conservative pins");
  clients.shift(); await w.message("pin", { build: three.manifest.build }, clients[0]);
  assert.equal((await w.save(three, clients[0])).ok, true);
  assert.match(await (await w.fetch("/")).text(), /three/);
});

test("lost static bytes yield an inert reconnect explanation rather than a partial cached interface", async () => {
  const w = worker(), f = fixture(); await w.save(f);
  const bytes = w.buckets.get("reach-static-bytes-v1");
  bytes.delete([...bytes.keys()].find(key => key.endsWith(f.runtime[0].sha256)));
  assert.match(await (await w.fetch("/")).text(), /Turn Tailscale back on/);
});

test("the build manifest follows only the current dependency graph and refuses private/symlink entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-offline-manifest-"));
  try {
    fs.mkdirSync(path.join(dir, ".vite")); fs.mkdirSync(path.join(dir, "assets")); fs.mkdirSync(path.join(dir, "pdfjs"));
    for (const name of ["jbig2_nowasm_fallback", "openjpeg_nowasm_fallback"]) fs.writeFileSync(path.join(dir, "pdfjs", name + ".js"), "/* fixed */");
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body></body></html>");
    fs.writeFileSync(path.join(dir, "manifest.webmanifest"), '{"icons":[]}'); fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");
    fs.writeFileSync(path.join(dir, "assets/current.js"), "current"); fs.writeFileSync(path.join(dir, "assets/lazy.js"), "lazy");
    fs.writeFileSync(path.join(dir, "assets/stale.js"), "PRIVATE-CANARY");
    const manifest = { "index.html": { file: "assets/current.js", dynamicImports: ["lazy"] }, lazy: { file: "assets/lazy.js" } };
    const write = () => fs.writeFileSync(path.join(dir, ".vite/manifest.json"), JSON.stringify(manifest)); write();
    const result = writeOfflineShell(dir);
    assert.ok(result.entries.some(entry => entry.path === "/assets/lazy.js"));
    assert.equal(JSON.stringify(result).includes("stale"), false);
    assert.equal(writeOfflineShell(dir).build, result.build, "repeat generation is stable");
    manifest.lazy.file = "../private.json"; write(); assert.throws(() => writeOfflineShell(dir));
    manifest.lazy.file = "assets/link.js"; write();
    // Directory junctions exercise the same no-follow entry rule on Windows
    // without requiring that runner to grant the file-symlink privilege.
    fs.symlinkSync(path.join(dir, process.platform === "win32" ? "assets" : "assets/current.js"), path.join(dir, "assets/link.js"),
      process.platform === "win32" ? "junction" : "file");
    assert.throws(() => writeOfflineShell(dir), /Invalid offline/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


for (const replacement of [Buffer.from("a distinct longer build generation"), Buffer.alloc(8 * 1024 * 1024 + 1)])
  test(`a renamed build input (${replacement.length} bytes) cannot publish checked metadata from the previous file`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-offline-build-race-")), original = fs.lstatSync;
    let replaced = false;
    try {
      fs.mkdirSync(path.join(dir, ".vite")); fs.mkdirSync(path.join(dir, "assets")); fs.mkdirSync(path.join(dir, "pdfjs"));
      fs.writeFileSync(path.join(dir, ".vite/manifest.json"), JSON.stringify({ "index.html": { file: "assets/current.js" } }));
      fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body></body></html>");
      fs.writeFileSync(path.join(dir, "manifest.webmanifest"), '{"icons":[]}'); fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");
      for (const name of ["jbig2_nowasm_fallback", "openjpeg_nowasm_fallback"]) fs.writeFileSync(path.join(dir, "pdfjs", name + ".js"), "/* fixed */");
      const file = path.join(dir, "assets/current.js"), next = path.join(dir, "replacement.tmp");
      fs.writeFileSync(file, "current"); fs.writeFileSync(next, replacement);
      // Deterministically schedule a real filesystem rename in the exact
      // production check/read window, without replacing its read operation.
      fs.lstatSync = function (...args) {
        const checked = original.apply(this, args);
        if (!replaced && args[0] === file) { fs.renameSync(next, file); replaced = true; }
        return checked;
      };
      assert.throws(() => writeOfflineShell(dir), /Invalid offline interface asset/);
      assert.equal(replaced, true);
      assert.equal(fs.existsSync(path.join(dir, "offline-shell.json")), false, "a mixed generation is never published");
    } finally { fs.lstatSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
  });

// Real client/controller modules with a modeled worker command channel and
// own private node. The separate Chrome test exercises real CacheStorage,
// service workers, HTTP, device approval, CORS and closed-listener navigation.
async function clientFixture(pathname = "") {
  const f = fixture(), calls = [], messages = [];
  const stateHex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
  const state = { _machinekey: stateHex(`privkey:${"1".repeat(64)}`), _profiles: stateHex({ fixture: { Key: "profile", NodeID: "node" } }),
    "_current-profile": stateHex("profile"), profile: stateHex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "node" } }) };
  const peer = { id: "computer", computerId: "machine", name: "Computer", platform: "fixture", url: origin, token: "OWN-BROWSER" };
  const native = { ...peer, token: "OWN-NATIVE" };
  const value = { device: { id: peer.id, computerId: peer.computerId, access: { kind: "device", scopes: ["admin", "files"], expiresAt: Date.now() + 60000 } },
    commits: 0, registrations: 0, updates: 0, nativeReads: 0, activationListeners: new Set() };
  const routes = {
    [f.runtime[0].path]: () => new Response("controlled runtime"),
    "/offline-shell.json": () => Response.json({ ...f.manifest, entries: f.manifest.entries.map(({ body, ...entry }) => entry) }),
    "/reach-start.json": () => Response.json(f.config),
    ...Object.fromEntries(f.manifest.entries.map(entry => [entry.path, () => new Response(entry.body)])),
  };
  const dom = await startDom({ url: origin + pathname, routes: Object.fromEntries(Object.entries(routes).map(([path, answer]) => [path, () => {
    value.nativeReads++; if (value.nativeUnavailable) throw TypeError("Native network unavailable"); return answer();
  }])) });
  const original = { Go: globalThis.Go, factory: globalThis.reachTailnet, instantiate: WebAssembly.instantiateStreaming };
  const append = dom.document.head.append.bind(dom.document.head);
  dom.document.head.append = (...nodes) => { append(...nodes); for (const script of nodes) if (script.tagName === "SCRIPT") queueMicrotask(() => script.onload?.()); };
  globalThis.Go = class { importObject = {}; run() { return new Promise(() => {}); } };
  WebAssembly.instantiateStreaming = async () => ({ instance: {} });
  const node = { start(cb) { cb.state("Running"); }, status() { return { self: { state: "Running" }, peers: [] }; },
    wake() {}, login() { throw Error("No enrollment during static preparation"); }, logout() { throw Error("No logout"); },
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, headers: request.headers });
      const answer = (async () => {
        if (path === "/api/device") { await value.beforeDevice?.(); return Response.json(value.device, { status: value.status || 200 }); }
        if (path === "/offline-shell.json") return Response.json({ ...f.manifest, entries: f.manifest.entries.map(({ body, ...entry }) => entry) });
        if (path === "/reach-start.json") return Response.json(f.config);
        const entry = [...f.manifest.entries, ...f.runtime].find(entry => entry.path === path);
        return entry ? new Response(entry.body) : new Response(null, { status: 404 });
      })();
      return { abort() {}, response: answer.then(async response => {
        const body = new Uint8Array(await response.arrayBuffer()); let used = false;
        return { status: response.status, statusText: response.statusText, headers: [],
          read: async () => used ? null : (used = true, body), cancel() {} };
      }) };
    }, websocket() { throw Error("Static preparation cannot open a socket"); } };
  globalThis.reachTailnet = () => node;
  for (const [key, entry] of Object.entries(state)) localStorage.setItem("reach.tailnet:" + key, entry);
  localStorage.setItem("reach.devices", JSON.stringify([native])); localStorage.setItem("reach.active", native.id);
  localStorage.setItem("reach.browser.devices", JSON.stringify([peer])); localStorage.setItem("reach.browser.active", peer.id);
  const browserNode = await dom.load("/src/browser-node.ts"), transport = await dom.load("/src/tailnet-transport.ts");
  assert.equal(await browserNode.existingBrowserNode(f.config), node);
  dom.window.fetch = globalThis.fetch;
  transport.bindPrivatePeer(native, "native"); transport.installTailnet(node, "fixture.ts.net", "browser");
  dom.document.documentElement.dataset.connection = "browser";
  const serviceWorker = { state: "activated", addEventListener(_name, listener) { value.activationListeners.add(listener); },
    removeEventListener(_name, listener) { value.activationListeners.delete(listener); }, postMessage(command, [port]) {
    messages.push(command);
    void (async () => {
      let reply = { ok: true };
      if (command.action === "hello") reply.version = value.protocolVersion ?? 1;
      if (command.action === "bootstrap") reply.config = f.config;
      if (command.action === "runtime") reply.entries = f.runtime.map(({ body, ...entry }) => entry);
      if (command.action === "begin") { await value.beforeBegin?.(); reply.job = "owned-job"; reply.missing = f.manifest.entries.map(({ body, ...entry }) => entry); }
      if (command.action === "commit") value.commits++;
      port.postMessage(reply);
    })();
  } };
  Object.defineProperty(dom.window.navigator, "serviceWorker", { configurable: true, value: {
    register: async () => { value.registrations++; return value.registration; },
    getRegistration: async () => value.registration,
  } });
  value.registration = { active: serviceWorker, update: async () => { value.updates++; await value.beforeUpdate?.(); } };
  const client = await dom.load("/src/offline-shell.ts");
  return Object.assign(value, { f, dom, peer, native, calls, messages, client, transport, serviceWorker,
    close: async () => { globalThis.Go = original.Go; globalThis.reachTailnet = original.factory; WebAssembly.instantiateStreaming = original.instantiate; await dom.close(); } });
}

test("browser code staging freshly authenticates only its exact saved own peer and never caches the grant", async () => {
  for (const pathname of ["/", "/files"]) {
    const f = await clientFixture(pathname);
    try {
      assert.equal(await f.client.prepareOfflineShell(null), true, pathname);
      assert.equal(f.commits, 1);
      assert.equal(f.registrations, 0); assert.equal(f.updates, 0, "an available private browser route never requires native worker-update fetch");
      assert.equal(f.calls.filter(call => call.path === "/api/device").length, 2);
      for (const call of f.calls) assert.deepEqual(call.headers, call.path === "/api/device" ? ["authorization", "Bearer OWN-BROWSER"] : []);
      const records = JSON.stringify(f.messages);
      assert.equal(records.includes("OWN-BROWSER"), false); assert.equal(records.includes("OWN-NATIVE"), false);
      assert.equal(records.includes('"scopes"'), false);
    } finally { await f.close(); }
  }
});

test("native setup explicitly updates, waits for activation and probes capability before any cache write", async () => {
  const f = await clientFixture();
  try {
    f.transport.usePrivateWay("native"); delete f.dom.document.documentElement.dataset.connection;
    f.registration.active = { state: "activated", postMessage() { throw Error("Do not send cache commands to the legacy worker"); } };
    f.registration.installing = f.serviceWorker; f.serviceWorker.state = "installing";
    const saving = f.client.prepareOfflineShell(null);
    await f.dom.waitFor(() => f.activationListeners.size === 1);
    assert.equal(f.registrations, 1); assert.equal(f.updates, 1); assert.equal(f.messages.length, 0);
    f.serviceWorker.state = "activated"; f.registration.active = f.serviceWorker; f.registration.installing = null;
    for (const changed of [...f.activationListeners]) changed();
    assert.equal(await saving, true); assert.equal(f.messages[0].action, "hello"); assert.equal(f.activationListeners.size, 0);
    const reads = f.nativeReads;
    f.nativeUnavailable = true;
    const meta = f.dom.document.createElement("meta"); meta.name = "reach-shell-build"; meta.content = f.f.manifest.build; f.dom.document.head.append(meta);
    assert.equal((await f.client.offlineBootstrap()).origin, origin);
    assert.equal(f.nativeReads, reads); assert.equal(f.registrations, 1); assert.equal(f.updates, 1,
      "offline bootstrap must not register, update or fetch the native worker");
  } finally { await f.close(); }
});

test("aborting pending worker update or activation detaches the wait and cannot later write a cohort", async () => {
  for (const stage of ["update", "activation"]) {
    const f = await clientFixture(), halt = new AbortController();
    try {
      f.transport.usePrivateWay("native"); delete f.dom.document.documentElement.dataset.connection;
      f.registration.installing = f.serviceWorker; f.serviceWorker.state = "installing";
      let entered, resume; const ready = new Promise(resolve => { entered = resolve; });
      if (stage === "update") f.beforeUpdate = () => { entered(); return new Promise(resolve => { resume = resolve; }); };
      const saving = f.client.prepareOfflineShell(null, { signal: halt.signal });
      if (stage === "update") await ready;
      else await f.dom.waitFor(() => f.activationListeners.size === 1);
      halt.abort(); assert.equal(await saving, false); assert.equal(f.activationListeners.size, 0);
      if (resume) resume();
      f.serviceWorker.state = "activated";
      for (const changed of [...f.activationListeners]) changed();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.messages.length, 0); assert.equal(f.commits, 0);
    } finally { await f.close(); }
  }
});

test("an incompatible active worker receives only a capability probe and cannot begin a preparation", async () => {
  const f = await clientFixture();
  try {
    f.protocolVersion = 0;
    assert.equal(await f.client.prepareOfflineShell(null), false);
    assert.deepEqual(f.messages.map(value => value.action), ["hello"]); assert.equal(f.commits, 0);
    assert.equal(f.calls.filter(call => call.path === "/offline-shell.json").length, 0);
  } finally { await f.close(); }
});

test("copied native, missing approval, changed identity and revoked grants cannot stage through a browser node", async () => {
  for (const kind of ["copied-native", "missing", "identity", "revoked", "wrong-device"]) {
    const f = await clientFixture();
    try {
      if (kind === "copied-native") localStorage.setItem("reach.browser.devices", JSON.stringify([f.native]));
      if (kind === "missing") localStorage.removeItem("reach.browser.devices");
      if (kind === "identity") localStorage.removeItem("reach.tailnet:_machinekey");
      if (kind === "revoked") f.status = 403;
      if (kind === "wrong-device") f.device.id = "another-computer";
      assert.equal(await f.client.prepareOfflineShell(null), false, kind); assert.equal(f.commits, 0, kind);
      assert.equal(f.calls.some(call => call.path === "/offline-shell.json"), false, kind);
      assert.equal(JSON.stringify(f.calls).includes("OWN-NATIVE"), false, kind);
      if (["copied-native", "missing", "identity"].includes(kind)) assert.equal(f.calls.length, 0, kind);
    } finally { await f.close(); }
  }
});

test("selection, forgetting, scope changes and abort fence a held static preparation before promotion", async () => {
  for (const kind of ["selection", "forget", "scope", "abort"]) {
    const f = await clientFixture(), halt = new AbortController();
    try {
      let entered, resume;
      const ready = new Promise(resolve => { entered = resolve; });
      f.beforeBegin = () => { entered(); return new Promise(resolve => { resume = resolve; }); };
      const saving = f.client.prepareOfflineShell(null, { signal: halt.signal }); await ready;
      if (kind === "selection") localStorage.setItem("reach.browser.active", "another");
      if (kind === "forget") localStorage.removeItem("reach.browser.devices");
      if (kind === "scope") f.device.access.scopes = ["admin"];
      if (kind === "abort") halt.abort();
      resume(); assert.equal(await saving, false, kind); assert.equal(f.commits, 0, kind);
      assert.equal(localStorage.getItem("reach.offline-shell.enabled"), null, kind);
    } finally { await f.close(); }
  }
});
