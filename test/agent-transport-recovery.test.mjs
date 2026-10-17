import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { main, socketOf } from "../scripts/agent-remote.mjs";
import { agentKey, funnelGateway, httpsSend } from "../scripts/agent-funnel.mjs";
import { testCertificate } from "./helpers/headless-chrome.mjs";

const PUBLIC = "https://computer.fixture.ts.net";
const PRIVATE = `${PUBLIC}:8443`;
const hex = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("hex");
const storedState = () => ({
  _machinekey: hex(`privkey:${"1".repeat(64)}`),
  "_current-profile": hex("profile-fixture"),
  _profiles: hex({ fixture: { ID: "fixture", Key: "profile-fixture", NodeID: "n-fixture" } }),
  "profile-fixture": hex({ Config: { PrivateNodeKey: `privkey:${"2".repeat(64)}`, NodeID: "n-fixture" } }),
});
const head = (value, status = 200) => {
  let bytes = Buffer.from(JSON.stringify(value));
  return { status, headers: ["Content-Type", "application/json"],
    read: async () => { const next = bytes; bytes = null; return next; }, cancel() {} };
};

// Exercises the real saved-credential main -> open -> shared-holder path.
// DNS, TLS delivery and the embedded Go node are synthetic, with no network,
// login, provider action or actual Tailscale process. Windows CI exercises
// this same fixture's real ACL setup and named-pipe holder path.
function fixture(t, { address = "100.64.0.20", saved = true, via = "funnel" } = {}) {
  const priorExitListeners = new Set(process.listeners("exit"));
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "reach-agent-route-")));
  const home = path.join(root, "agent-home"), conn = path.join(home, "computer");
  let used = false;
  t.after(async () => {
    // The holder can answer its own calls before net.Server's listening
    // callback runs. Let that actual socket become ready before removing its
    // folder, so the production chmod does not race fixture teardown.
    if (used) await new Promise(resolve => {
      const socket = net.connect(socketOf(conn));
      const done = () => { socket.destroy(); resolve(); };
      socket.once("connect", done); socket.once("error", done);
    });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    // The production holder registers per-connection exit cleanup. This
    // fixture already removed its state, so keep only pre-existing handlers.
    for (const listener of process.listeners("exit"))
      if (!priorExitListeners.has(listener)) process.removeListener("exit", listener);
  });
  fs.mkdirSync(conn, { recursive: true, mode: 0o700 });
  const credential = { version: 1, via, origin: via === "funnel" ? PUBLIC : PRIVATE, private: PRIVATE,
    start: PUBLIC, hostname: "reach-agent", token: "t".repeat(43), scopes: ["device", "exec"],
    joinedAt: new Date().toISOString(), expiresAt: Date.now() + 3600_000 };
  fs.writeFileSync(path.join(conn, "credential.json"), JSON.stringify(credential), { mode: 0o600 });
  if (saved) fs.writeFileSync(path.join(conn, "tailnet-state.json"), JSON.stringify(storedState()), { mode: 0o600 });
  const key = agentKey(conn);
  // Trusted-by-hash cached bytes, so the synthetic factory never downloads
  // or executes any WASM. loadTailnet returns the installed fake factory.
  const cache = path.join(home, "tailnet", new URL(PUBLIC).host);
  fs.mkdirSync(cache, { recursive: true });
  const cached = {};
  for (const extension of ["js", "wasm"]) {
    const bytes = Buffer.from(`disposable ${extension} fixture`);
    const file = `fixture.${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.${extension}`;
    fs.writeFileSync(path.join(cache, file), bytes);
    cached[extension === "js" ? "exec" : "wasm"] = file;
  }
  fs.writeFileSync(path.join(cache, "tailnet.json"), JSON.stringify(cached));
  const state = { native: false, embedded: true, starts: 0, probes: 0, sent: [], lost: false, denied: 0, probeDenied: 0 };
  const device = { id: "same-computer", computerId: "same-computer", name: "Disposable", access: { kind: "agent", scopes: ["device", "exec"] } };
  const dispatch = (transport, body) => {
    const signed = JSON.parse(Buffer.from(body).toString("utf8"));
    const payload = JSON.parse(signed.payload);
    assert.equal(payload.audience, PUBLIC);
    assert.equal(payload.token, credential.token);
    assert.ok(crypto.verify("sha256", Buffer.from(signed.payload), { key: crypto.createPublicKey({ key: signed.publicKey, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signed.signature, "base64url")));
    assert.deepEqual(signed.publicKey, key.jwk, "one approved signing key on all routes");
    state.sent.push({ transport, method: payload.method, path: payload.path });
    if (state.denied) return { error: `Authoritative refusal ${state.denied}` };
    return payload.path === "/api/device" ? device : { id: "one-disposable-job", status: "done", exitCode: 0 };
  };
  const oldHome = process.env.REACH_AGENT_HOME, oldFactory = globalThis.reachTailnet;
  process.env.REACH_AGENT_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.REACH_AGENT_HOME; else process.env.REACH_AGENT_HOME = oldHome;
    if (oldFactory === undefined) delete globalThis.reachTailnet; else globalThis.reachTailnet = oldFactory;
  });
  globalThis.reachTailnet = config => {
    state.starts++;
    assert.equal(config.authKey, undefined, "recovery cannot enroll a fresh node");
    assert.equal(config.stateStorage.getState("_machinekey"), storedState()._machinekey);
    return { start: cb => cb.state("Running"), status: () => ({ peers: [{ dnsName: new URL(PRIVATE).hostname, online: true }] }),
      fetch(input) {
        const url = new URL(input.url);
        if (url.pathname === "/api/health") {
          state.probes++;
          assert.ok(!input.headers?.some(value => String(value).includes(credential.token)), "readiness probes carry no credential");
          return { response: state.embedded ? Promise.resolve(head(state.probeDenied ? { error: `Readiness refused ${state.probeDenied}` } : { product: "Reach" }, state.probeDenied || 200)) : Promise.reject(Error("relay unavailable")), abort() {} };
        }
        if (via === "tailnet") {
          assert.ok(input.headers.includes(`Bearer ${credential.token}`));
          state.sent.push({ transport: "embedded", method: input.method, path: url.pathname });
          return { response: state.lost ? Promise.reject(Error("private reply lost")) : Promise.resolve(head(device)), abort() {} };
        }
        assert.equal(url.href, `${PRIVATE}/agent-gateway`);
        const result = dispatch("embedded", input.body);
        const command = JSON.parse(JSON.parse(Buffer.from(input.body).toString("utf8")).payload).path === "/api/jobs";
        return { response: state.lost && command ? Promise.reject(Error("reply lost after dispatch")) : Promise.resolve(head(result, state.denied || 200)), abort() {} };
      } };
  };
  t.mock.method(dns, "lookup", (_host, _options, callback) => {
    const selected = state.native ? address : "203.0.113.7";
    callback(null, selected, net.isIP(selected));
  });
  t.mock.method(globalThis, "fetch", () => assert.fail("recovery cannot download bootstrap files or start a login"));
  t.mock.method(https, "request", (url, options, callback) => {
    const endpoint = new URL(url).origin;
    assert.ok([PUBLIC, PRIVATE].includes(endpoint), "no external requests");
    const req = new EventEmitter();
    req.once("error", () => req.emit("close"));
    req.destroy = error => { queueMicrotask(() => req.emit("error", error || Error("destroyed"))); return req; };
    req.end = body => queueMicrotask(() => {
      const ready = error => {
        if (error) return req.emit("error", error);
        if (via === "direct" && !state.native) return req.emit("error", Object.assign(Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        const socket = new EventEmitter();
        req.emit("socket", socket); socket.emit("connect"); socket.emit("secureConnect");
        let result;
        if (via === "direct") {
          assert.equal(endpoint, PRIVATE); assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
          state.sent.push({ transport: "native", method: options.method, path: new URL(url).pathname }); result = device;
        } else result = dispatch(endpoint === PRIVATE ? "native" : "public", body);
        const res = Readable.from([Buffer.from(JSON.stringify(result))]);
        res.statusCode = state.denied || 200; res.headers = { "content-type": "application/json" }; callback(res);
      };
      if (options.lookup) options.lookup(new URL(url).hostname, { all: true }, ready);
      else ready();
    });
    return req;
  });
  const output = [];
  const call = async (name = "reach_device", args = {}) => {
    used = true;
    const write = process.stdout.write;
    process.stdout.write = function (chunk, ...args) {
      if (typeof chunk !== "string") return write.call(this, chunk, ...args);
      output.push(chunk); args.find(arg => typeof arg === "function")?.(); return true;
    };
    try { return await main(["call", name, JSON.stringify(args), "--computer", "computer"]); }
    finally { process.stdout.write = write; }
  };
  return { state, conn, output, call };
}

for (const address of ["100.64.0.20", "fd7a:115c:a1e0::20"]) {
  test(`a saved signing-key agent prefers existing embedded private to public, then returns to native (${address})`, async t => {
    const f = fixture(t, { address });
    const real = Date.now;
    let offset = 0;
    t.mock.method(Date, "now", () => real() + offset);
    assert.equal(await f.call(), 0);
    assert.deepEqual(f.state.sent.map(call => call.transport), ["embedded", "embedded"], "the persisted private path is usable and authorized for the same signing key");
    offset = 61_000;
    f.state.native = true;
    assert.equal(await f.call(), 0);
    assert.deepEqual(f.state.sent.slice(-2).map(call => call.transport), ["native", "native"], "saved sessions re-evaluate and prefer the installed daemon when it returns");
    assert.equal(f.state.starts, 1, "one saved embedded identity; no new login or node");
  });
}

test("a saved signing-key agent without embedded state falls back publicly without creating a tailnet node", async t => {
  const f = fixture(t, { saved: false });
  assert.equal(await f.call(), 0);
  assert.deepEqual(f.state.sent.map(call => call.transport), ["public", "public"]);
  assert.equal(f.state.starts, 0);
});

test("a saved profile without its pinned runtime keeps public access without downloading or creating a node", async t => {
  const f = fixture(t);
  fs.rmSync(path.join(path.dirname(f.conn), "tailnet"), { recursive: true, force: true });
  await f.call();
  assert.ok(f.state.sent.every(call => call.transport === "public"));
  assert.equal(f.state.starts, 0);
  assert.equal(fs.existsSync(path.join(path.dirname(f.conn), "tailnet")), false, "a cache-only probe creates no download state");
});

test("saved private routes downgrade only before dispatch, and recover from public to embedded without changing the grant", async t => {
  const f = fixture(t);
  const real = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => real() + offset);
  const before = fs.readFileSync(path.join(f.conn, "credential.json"), "utf8");
  f.state.native = true;
  await f.call();
  assert.deepEqual(f.state.sent.map(call => call.transport), ["native", "native"]);
  f.state.native = false;
  await f.call();
  assert.deepEqual(f.state.sent.slice(-2).map(call => call.transport), ["embedded", "embedded"]);
  f.state.embedded = false;
  await f.call();
  assert.deepEqual(f.state.sent.slice(-2).map(call => call.transport), ["public", "public"]);
  f.state.embedded = true;
  offset = 61_000;
  await f.call();
  assert.deepEqual(f.state.sent.slice(-2).map(call => call.transport), ["embedded", "embedded"]);
  assert.equal(fs.readFileSync(path.join(f.conn, "credential.json"), "utf8"), before, "selection changes neither credential nor approved grant");
});

for (const native of [true, false]) {
  test(`private ${native ? "native" : "embedded"} authorization refusals never fall back to bypass the decision`, async t => {
    const f = fixture(t);
    f.state.native = native;
    for (const status of [401, 403, 423, 429]) {
      f.state.denied = status;
      await assert.rejects(f.call(), { status });
    }
    assert.equal(f.state.sent.length, 4);
    assert.ok(f.state.sent.every(call => call.transport === (native ? "native" : "embedded")));
  });
}

test("embedded readiness authentication, lock and rate refusals remain authoritative before any signed request", async t => {
  const f = fixture(t);
  for (const status of [401, 403, 423, 429, 500]) {
    f.state.probeDenied = status;
    await assert.rejects(f.call(), { status });
  }
  assert.equal(f.state.probes, 5);
  assert.deepEqual(f.state.sent, [], "no signed request is attempted on another route after a readiness refusal");
});

test("credential-free health503 permits the still-approved public sibling route before dispatch", async t => {
  const f = fixture(t);
  f.state.probeDenied = 503;
  await f.call();
  assert.deepEqual(f.state.sent.map(call => call.transport), ["public", "public"]);
  assert.equal(f.state.probes, 1);
});

for (const state of [{}, { _machinekey: hex(`privkey:${"1".repeat(64)}`) }, { ...storedState(), _machinekey: hex(`privkey:${"0".repeat(64)}`) }]) {
  test(`incomplete embedded state (${Object.keys(state).length} entries) never creates another node`, async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.conn, "tailnet-state.json"), JSON.stringify(state), { mode: 0o600 });
    await f.call();
    assert.ok(f.state.sent.every(call => call.transport === "public"));
    assert.equal(f.state.starts, 0);
  });
}

for (const via of ["direct", "tailnet"]) {
  test(`legacy ${via} access keeps its approved node and explains alternate-identity approval on failure`, async t => {
    const f = fixture(t, { via });
    f.state.lost = true;
    await assert.rejects(f.call(), /different Tailscale node.*new invitation.*owner approval/);
    assert.ok(f.state.sent.every(call => call.transport === (via === "direct" ? "native" : "embedded")));
    assert.equal(f.state.starts, via === "tailnet" ? 1 : 0);
  });
}

test("an unknown-result embedded command is dispatched once and never replayed publicly", async t => {
  const f = fixture(t);
  // Discovery first succeeds; the command's reply is then lost after the
  // synthetic harmless dispatch. Its result is deliberately unknowable.
  assert.equal(await f.call(), 0);
  f.state.lost = true;
  await assert.rejects(f.call("reach_run_command", { command: "disposable no-op", root: 0 }), /reply lost|Check the result/);
  assert.equal(f.state.sent.filter(call => call.method === "POST").length, 1, "the command was dispatched once before its reply was lost");
  assert.ok(f.state.sent.every(call => call.transport === "embedded"));
});

test("a native private TLS failure before HTTP dispatch can use the public gateway", async t => {
  // Real TCP/TLS: the private peer accepts TCP and closes during the TLS
  // handshake. It receives zero HTTP bytes. Public delivery is synthetic.
  const sockets = new Set();
  const listener = net.createServer(socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.destroy(); });
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => listener.close(resolve)); });
  const nativeRequest = https.request;
  let publicDispatches = 0;
  const client = { secureConnects: 0, encrypted: false, errorObserved: false, cipher: "unobserved" };
  t.mock.method(https, "request", (url, options, callback) => {
    assert.equal(new URL(url).origin, PRIVATE);
    const request = nativeRequest(`https://127.0.0.1:${listener.address().port}/agent-gateway`, { ...options, lookup: undefined }, callback);
    request.on("socket", socket => {
      client.encrypted = socket.encrypted;
      socket.once("secureConnect", () => client.secureConnects++);
      request.once("error", () => { client.errorObserved = true; client.cipher = socket.getCipher(); });
    });
    return request;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tls-before-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gateway = funnelGateway(PUBLIC, agentKey(root), { endpoints: [PRIVATE, PUBLIC], send: async (endpoint, ...args) => {
    if (endpoint === PRIVATE) return httpsSend(endpoint, ...args);
    publicDispatches++;
    return { status: 200, headers: {}, bytes: Buffer.from('{"ok":true}') };
  } });
  assert.equal((await gateway.request("fixture-token", "POST", "/api/jobs", { command: "disposable no-op" })).json.ok, true);
  assert.equal(publicDispatches, 1);
  assert.equal(client.encrypted, true);
  assert.equal(client.secureConnects, 0, "the HTTPS client never completed TLS, so no HTTP application data could leave it");
  assert.equal(client.errorObserved, true);
  assert.ok(client.cipher == null, "no application-data cipher was negotiated");
});

test("after real TLS and HTTP dispatch, lost read and write replies never advance to another route", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tls-after-http-"));
  const certificate = await testCertificate(root, new URL(PRIVATE).hostname);
  const dispatched = [], completed = [];
  const listener = https.createServer(certificate, (req, _res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      dispatched.push(JSON.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")).payload).method);
      req.socket.destroy();
    });
  });
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const nativeRequest = https.request;
  t.mock.method(https, "request", (url, options, callback) => {
    assert.equal(new URL(url).origin, PRIVATE);
    const request = nativeRequest(`https://${new URL(PRIVATE).hostname}:${listener.address().port}/agent-gateway`, {
      ...options, ca: certificate.cert, rejectUnauthorized: true,
      lookup: (_host, opts, cb) => opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4),
    }, callback);
    request.on("socket", socket => socket.once("secureConnect", () => completed.push(socket.authorized)));
    return request;
  });
  let publicDispatches = 0;
  const gateway = funnelGateway(PUBLIC, agentKey(root), { endpoints: [PRIVATE, PUBLIC], send: async (endpoint, ...args) => {
    if (endpoint === PRIVATE) return httpsSend(endpoint, ...args);
    publicDispatches++; return { status: 200, headers: {}, bytes: Buffer.from('{"ok":true}') };
  } });
  for (const method of ["GET", "POST"])
    await assert.rejects(gateway.request("fixture-token", method, "/api/jobs", method === "POST" ? { command: "disposable no-op" } : undefined), error => error.unreachable === false);
  assert.deepEqual(completed, [true, true], "both clients completed authorized TLS");
  assert.deepEqual(dispatched, ["GET", "POST"]);
  assert.equal(publicDispatches, 0, "an unknown result never causes replay on a second route");
});

test("a negotiated client cipher without secureConnect is ambiguous and never permits a replay", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tls-ambiguous-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(https, "request", (_url, _options, _callback) => {
    const request = new EventEmitter(), socket = new EventEmitter();
    socket.getCipher = () => ({ name: "TLS_AES_256_GCM_SHA384" });
    request.end = () => queueMicrotask(() => {
      request.emit("socket", socket); socket.emit("connect");
      request.emit("error", Error("uncertain TLS close")); request.emit("close");
    });
    return request;
  });
  let publicDispatches = 0;
  const gateway = funnelGateway(PUBLIC, agentKey(root), { endpoints: [PRIVATE, PUBLIC], send: async (endpoint, ...args) => {
    if (endpoint === PRIVATE) return httpsSend(endpoint, ...args);
    publicDispatches++; return { status: 200, headers: {}, bytes: Buffer.from('{"ok":true}') };
  } });
  await assert.rejects(gateway.request("fixture-token", "POST", "/api/jobs", { command: "disposable no-op" }), error => error.unreachable === false);
  assert.equal(publicDispatches, 0);
});
