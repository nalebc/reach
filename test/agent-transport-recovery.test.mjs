import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { main, savedTailnet, socketOf } from "../scripts/agent-remote.mjs";
import { agentKey, funnelGateway, httpsSend, tailnetLookup } from "../scripts/agent-funnel.mjs";
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
function storedProfile(t) {
  const conn = fs.mkdtempSync(path.join(os.tmpdir(), "reach-saved-profile-"));
  t.after(() => fs.rmSync(conn, { recursive: true, force: true }));
  const file = path.join(conn, "tailnet-state.json");
  fs.writeFileSync(file, JSON.stringify(storedState()), { mode: 0o600 });
  return { conn, file };
}
const closed = fd => assert.throws(() => fs.fstatSync(fd), { code: "EBADF" }, "the saved-profile descriptor is always closed");
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
  t.mock.method(dns, "lookup", (_host, options, callback) => {
    const selected = state.native ? address : "203.0.113.7";
    if (options.all) callback(null, [{ address: selected, family: net.isIP(selected) }]);
    else callback(null, selected, net.isIP(selected));
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

test("a checked saved profile is read once from its opened file and cannot change identity before node startup", async t => {
  const f = fixture(t), file = path.join(f.conn, "tailnet-state.json");
  const before = fs.statSync(file, { bigint: true });
  const readFile = fs.readFileSync, read = fs.readSync;
  let pathReads = 0, swaps = 0, blocked = false;
  const replace = () => {
    if (swaps++) return;
    try { fs.renameSync(file, file + ".opened"); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      blocked = true; return;
    }
    fs.writeFileSync(file, JSON.stringify({ ...storedState(), _machinekey: hex(`privkey:${"3".repeat(64)}`) }), { mode: 0o600 });
  };
  t.mock.method(fs, "readFileSync", (input, ...args) => {
    if (input === file) { pathReads++; replace(); }
    return readFile(input, ...args);
  });
  t.mock.method(fs, "readSync", (fd, ...args) => {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev === before.dev && opened.ino === before.ino) replace();
    return read(fd, ...args);
  });
  await f.call();
  assert.ok(swaps > 0, "the replacement race was exercised at the actual state read");
  assert.equal(pathReads, 0, "neither validation nor node startup reopens the named state file");
  assert.deepEqual(f.state.sent.map(call => call.transport), ["embedded", "embedded"], "only the original approved profile starts");
  assert.equal(f.state.starts, 1);
  if (blocked) assert.equal(JSON.parse(readFile(file, "utf8"))._machinekey, storedState()._machinekey, "Windows denied replacing the open file");
});

test("a saved profile returns its descriptor-bound snapshot and closes the descriptor", t => {
  const { conn, file } = storedProfile(t), open = fs.openSync, readFile = fs.readFileSync;
  let fd, flags, pathReads = 0;
  t.mock.method(fs, "openSync", (input, options, ...args) => {
    const opened = open(input, options, ...args);
    if (input === file) { fd = opened; flags = options; }
    return opened;
  });
  t.mock.method(fs, "readFileSync", (input, ...args) => {
    if (input === file) pathReads++;
    return readFile(input, ...args);
  });
  assert.deepEqual(savedTailnet(conn), storedState());
  assert.equal(pathReads, 0, "profile bytes are never reopened by path");
  if (fs.constants.O_NOFOLLOW) assert.ok(flags & fs.constants.O_NOFOLLOW);
  if (fs.constants.O_NONBLOCK) assert.ok(flags & fs.constants.O_NONBLOCK);
  closed(fd);
});

test("without O_NOFOLLOW, exact bigint device and inode mismatches reject a saved profile before reading", t => {
  const { conn, file } = storedProfile(t), open = fs.openSync, fstat = fs.fstatSync, lstat = fs.lstatSync;
  const identity = 2n ** 55n;
  let fd, reads = 0, mismatch;
  t.mock.method(fs, "openSync", (...args) => (fd = open(...args)));
  t.mock.method(fs, "fstatSync", (...args) => Object.assign(Object.create(fstat(...args)), { dev: identity, ino: identity }));
  t.mock.method(fs, "lstatSync", (input, ...args) => {
    const named = lstat(input, ...args);
    return input === file ? Object.assign(Object.create(named), { dev: identity, ino: identity, [mismatch]: identity + 1n }) : named;
  });
  t.mock.method(fs, "readSync", () => { reads++; throw Error("an identity mismatch must not read any bytes"); });
  for (mismatch of ["dev", "ino"]) {
    assert.equal(savedTailnet(conn, { noFollow: 0 }), null);
    closed(fd);
  }
  assert.equal(reads, 0, "Windows-style identity checks fail closed even beyond Number's exact integer range");
});

test("a saved profile replaced after open is rejected, or the operating system prevents the replacement", t => {
  const { conn, file } = storedProfile(t), open = fs.openSync;
  let fd, blocked = false, reads = 0;
  t.mock.method(fs, "openSync", (...args) => {
    const opened = open(...args);
    if (fd !== undefined || args[0] !== file) return opened;
    fd = opened;
    try { fs.renameSync(file, file + ".opened"); }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      blocked = true; return fd;
    }
    fs.writeFileSync(file, JSON.stringify(storedState()), { mode: 0o600 });
    return fd;
  });
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (...args) => { reads++; return read(...args); });
  assert.deepEqual(savedTailnet(conn, { noFollow: 0 }), blocked ? storedState() : null);
  if (!blocked) assert.equal(reads, 0, "a new file at the checked name cannot supply private identity bytes");
  closed(fd);
});

test("a saved-profile symlink is rejected by native and no-O_NOFOLLOW checks without reading its target", t => {
  const { conn, file } = storedProfile(t), target = path.join(conn, "target.json");
  fs.renameSync(file, target);
  let modeled = false;
  try { fs.symlinkSync(target, file, "file"); }
  catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    // A Windows runner may not grant symlink creation. Still exercise its
    // real descriptor + named metadata check with a reparse-point model.
    modeled = true;
    fs.copyFileSync(target, file);
    const lstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (input, ...args) => input === file
      ? Object.assign(Object.create(lstat(input, ...args)), { isFile: () => false, isSymbolicLink: () => true })
      : lstat(input, ...args));
    t.diagnostic("Windows symlink creation denied; exercising a modeled reparse-point lstat result");
  }
  const open = fs.openSync, descriptors = [];
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); descriptors.push(fd); return fd; });
  let reads = 0;
  t.mock.method(fs, "readSync", () => { reads++; throw Error("a linked profile must never be read"); });
  assert.equal(savedTailnet(conn), null);
  assert.equal(savedTailnet(conn, { noFollow: 0 }), null);
  assert.equal(reads, 0);
  assert.ok(descriptors.length > 0, "the no-O_NOFOLLOW fallback actually opened a descriptor");
  for (const fd of descriptors) closed(fd);
  if (!modeled) assert.equal(fs.readFileSync(target, "utf8"), JSON.stringify(storedState()));
});

test("nonregular saved profiles are refused without blocking on a POSIX FIFO", { timeout: 5000 }, t => {
  const { conn, file } = storedProfile(t), open = fs.openSync;
  fs.unlinkSync(file);
  const descriptors = [];
  let pipe = false, flags;
  t.mock.method(fs, "openSync", (input, options, ...args) => {
    flags = options;
    // Fail instead of hanging this regression if O_NONBLOCK is removed.
    if (pipe && !(options & fs.constants.O_NONBLOCK)) throw Error("FIFO open would block");
    const fd = open(input, options, ...args); descriptors.push(fd); return fd;
  });
  let reads = 0;
  t.mock.method(fs, "readSync", () => { reads++; throw Error("nonregular state must not be read"); });
  fs.mkdirSync(file);
  assert.equal(savedTailnet(conn), null);
  fs.rmdirSync(file);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [file], { timeout: 2000 });
    pipe = true;
    assert.equal(savedTailnet(conn), null);
    assert.ok(flags & fs.constants.O_NONBLOCK, "the actual FIFO is opened without waiting for a writer");
  }
  assert.equal(reads, 0);
  for (const fd of descriptors) closed(fd);
});

test("oversized, growing or malformed saved profiles fail closed and release their descriptors", t => {
  const { conn, file } = storedProfile(t), open = fs.openSync, fstat = fs.fstatSync, read = fs.readSync;
  let fd, reads = 0, grow = false;
  t.mock.method(fs, "openSync", (...args) => {
    const opened = open(...args);
    if (args[0] === file && typeof args[1] === "number" && !(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR))) fd = opened;
    return opened;
  });
  t.mock.method(fs, "fstatSync", (...args) => {
    const stat = fstat(...args);
    if (grow) { grow = false; fs.appendFileSync(file, " "); }
    return stat;
  });
  t.mock.method(fs, "readSync", (...args) => { reads++; return read(...args); });
  fs.truncateSync(file, 2 * 1024 * 1024 + 1);
  assert.equal(savedTailnet(conn), null);
  assert.equal(reads, 0, "oversized files are rejected before allocating or reading their contents");
  closed(fd);
  fs.writeFileSync(file, JSON.stringify(storedState()));
  grow = true;
  assert.equal(savedTailnet(conn), null, "growth beyond the descriptor's measured bound is rejected");
  assert.ok(reads > 0);
  closed(fd);
  fs.writeFileSync(file, "{");
  assert.equal(savedTailnet(conn), null, "a parse failure also closes the opened file");
  closed(fd);
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

const lookup = (options) => new Promise(resolve => tailnetLookup("computer.fixture.ts.net", options, (error, ...answers) => resolve({ error, answers })));
for (const candidates of [
  [{ address: "100.64.0.20", family: 4 }, { address: "100.64.0.21", family: 4 }],
  [{ address: "fd7a:115c:a1e0::20", family: 6 }, { address: "fd7a:115c:a1e0::21", family: 6 }],
]) {
  test(`private DNS preserves every IPv${candidates[0].family} answer and the single-address callback contract`, async t => {
    const options = { all: true, verbatim: true }, calls = [];
    t.mock.method(dns, "lookup", (_hostname, requested, callback) => {
      calls.push(requested);
      if (requested.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    });
    assert.deepEqual(await lookup(options), { error: null, answers: [candidates] });
    assert.deepEqual(await lookup({ all: false }), { error: null, answers: [candidates[0].address, candidates[0].family] });
    assert.deepEqual(await lookup(undefined), { error: null, answers: [candidates[0].address, candidates[0].family] });
    assert.ok(calls.every(call => call.all === true), "select private candidates from the complete DNS answer");
    assert.equal(calls[0].verbatim, true);
    assert.deepEqual(options, { all: true, verbatim: true }, "the caller's options stay unchanged");
  });
}

test("private DNS filters public and loopback answers before returning eligible private addresses", async t => {
  const candidates = [
    { address: "203.0.113.7", family: 4 }, { address: "fd7a:115c:a1e0::20", family: 6 },
    { address: "::1", family: 6 }, { address: "100.64.0.20", family: 4 },
    { address: "2001:db8::7", family: 6 }, { address: "127.0.0.1", family: 4 },
  ];
  t.mock.method(dns, "lookup", (_hostname, requested, callback) => requested.all
    ? callback(null, candidates) : callback(null, candidates[0].address, candidates[0].family));
  assert.deepEqual(await lookup({ all: true }), { error: null, answers: [[candidates[1], candidates[3]]] });
  assert.deepEqual(await lookup({}), { error: null, answers: [candidates[1].address, candidates[1].family] });
});

test("private DNS without a private candidate fails closed in both callback forms", async t => {
  let candidates;
  t.mock.method(dns, "lookup", (_hostname, requested, callback) => requested.all
    ? callback(null, candidates) : callback(null, candidates[0]?.address, candidates[0]?.family));
  for (candidates of [[], [{ address: "203.0.113.7", family: 4 }, { address: "2001:db8::7", family: 6 }]])
    for (const options of [{ all: true }, {}]) {
      const result = await lookup(options);
      assert.equal(result.error?.code, "ENOTTAILNET");
      assert.deepEqual(result.answers, []);
    }
});

test("private DNS preserves resolver errors without returning any address", async t => {
  const error = Object.assign(Error("fixture DNS unavailable"), { code: "EAI_AGAIN" });
  t.mock.method(dns, "lookup", (_hostname, _options, callback) => callback(error));
  for (const options of [{ all: true }, {}]) assert.deepEqual(await lookup(options), { error, answers: [] });
});

test("native private DNS tries the available IPv4 route before public when the first IPv6 route fails", { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-private-dns-"));
  const hostname = new URL(PUBLIC).hostname, certificate = await testCertificate(root, hostname);
  let privateDispatches = 0, publicDispatches = 0;
  const server = https.createServer(certificate, (req, res) => {
    req.resume(); req.on("end", () => { privateDispatches++; res.end('{"private":true}'); });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const endpoint = `${PUBLIC}:${server.address().port}`;
  const candidates = [{ address: "fd7a:115c:a1e0::20", family: 6 }, { address: "203.0.113.7", family: 4 }, { address: "100.64.0.20", family: 4 }];
  const dnsCalls = [], nodeCalls = [], nodeAnswers = [];
  t.mock.method(dns, "lookup", (host, options, callback) => {
    assert.equal(host, hostname); dnsCalls.push({ ...options });
    queueMicrotask(() => options.all ? callback(null, candidates) : callback(null, candidates[0].address, candidates[0].family));
  });
  const originalRequest = https.request;
  let socket;
  t.mock.method(https, "request", (url, options, callback) => {
    const request = originalRequest(url, { ...options, ca: certificate.cert, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 10,
      lookup: (host, requested, answer) => {
        nodeCalls.push({ ...requested });
        options.lookup(host, requested, (error, found, family) => {
          if (error) return answer(error);
          nodeAnswers.push(...found);
          // Map only already-filtered private IPs into disposable loopback
          // sockets. Actual Node address selection and TLS stay intact;
          // the fixture cannot send HTTP to an off-tailnet DNS answer.
          const mapped = new Map([[candidates[0].address, "::1"], [candidates[2].address, "127.0.0.1"]]);
          if (found.some(item => !mapped.has(item.address))) return answer(Error("An off-tailnet address reached Node's private connector"));
          answer(null, found.map(item => ({ ...item, address: mapped.get(item.address) })), family);
        });
      },
    }, callback);
    request.on("socket", value => { socket = value; });
    return request;
  });
  const gateway = funnelGateway(PUBLIC, agentKey(root), { endpoints: [endpoint, PUBLIC], send: async (target, ...args) => {
    if (target === endpoint) return httpsSend(target, ...args);
    publicDispatches++; return { status: 200, headers: {}, bytes: Buffer.from('{"private":false}') };
  } });
  const response = await gateway.request("disposable-token", "GET", "/api/device");
  assert.equal(response.endpoint, endpoint, "a reachable native private alternative precedes public fallback");
  assert.equal(nodeCalls[0].all, true, "real Node requested every address for family selection");
  assert.equal(dnsCalls[0].all, true, "the resolver preserves every candidate");
  assert.deepEqual(nodeAnswers, [candidates[0], candidates[2]], "no public DNS address is passed to Node's connector");
  assert.deepEqual(socket.autoSelectFamilyAttemptedAddresses, [`::1:${server.address().port}`, `127.0.0.1:${server.address().port}`], "the actual client tried IPv6 then the usable IPv4 address");
  assert.equal(privateDispatches, 1);
  assert.equal(publicDispatches, 0);
});
