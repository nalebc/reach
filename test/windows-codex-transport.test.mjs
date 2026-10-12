import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { PIPE, createCodexDaemon } from "../server/agent-sessions/codex-daemon.mjs";
import { findCodexExecutable } from "../server/capabilities.mjs";
import { spawnable } from "../server/agent-cli.mjs";

// Codex's session service on Windows (audit #2, Oct 12): ws+unix:// can't
// name a drive path or a named pipe, so on Windows the WebSocket rides a
// connection net.connect makes to the pipe. The Mac's stays as it was.
const windows = process.platform === "win32";
const pipeName = () => `\\\\.\\pipe\\reach-test-codex-${crypto.randomBytes(6).toString("hex")}`;
const quiet = { check: async () => ({ status: "available", version: null }), checkSocket: async () => {} };

// A JSON-RPC service as Codex's answers it: lists are empty, other calls
// get {}, and initialize says who it is.
async function service(t, endpoint) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const seen = [];
  wss.on("connection", (socket, req) => {
    seen.push({ url: req.url, host: req.headers.host });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.id == null) return;
      const result = message.method === "initialize" ? { userAgent: "codex_cli_rs/0.163.0 (Windows 11; x86_64)" } : /\/list$/.test(message.method) ? { data: [] } : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
  return seen;
}
// Where a test service listens here: a pipe on Windows, a socket file elsewhere.
async function endpoint(t) {
  if (windows) return pipeName();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-codex-pipe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "s");
}

test("named pipes are told from paths: one name under \\\\.\\pipe\\ or \\\\?\\pipe\\, nothing else", () => {
  for (const pipe of ["\\\\.\\pipe\\codex-ipc", "\\\\?\\pipe\\codex-daemon-1", "\\\\.\\PIPE\\x.y"]) assert.ok(PIPE.test(pipe), pipe);
  for (const other of ["C:\\Users\\me\\.codex\\control.sock", "/tmp/codex.sock", "\\\\.\\pipe\\", "\\\\.\\pipe\\..", "\\\\.\\pipe\\a\\..\\..\\C:\\x", "\\\\.\\pipe\\a/b", "\\\\server\\pipe\\x", "\\\\.\\pipe\\x\n", ""])
    assert.ok(!PIPE.test(other), JSON.stringify(other));
});

test("on Windows the WebSocket names no endpoint and rides net.connect to the pipe; a Mac's URL is unchanged", async (t) => {
  const made = [];
  class Socket extends EventEmitter {
    constructor(url, options) {
      super();
      made.push({ url, options });
      // Not answered: only how it was asked matters here.
      queueMicrotask(() => this.emit("error", Object.assign(new Error("connect ENOENT \\\\.\\pipe\\codex-secret"), { code: "ENOENT" })));
    }
    terminate() {}
  }
  const connected = [];
  const connect = (where) => (connected.push(where), new net.Socket());
  const pipe = "\\\\.\\pipe\\codex-secret";
  const win = createCodexDaemon({ locate: async () => "C:\\codex.exe", run: async () => ({ stdout: JSON.stringify({ socketPath: pipe }) }), Socket, connect, platform: "win32", ...quiet });
  t.after(() => win.close());
  await assert.rejects(win.rpc("thread/list"), (e) => {
    // Said plainly, without the pipe's name (Node's own error carries it).
    assert.equal(e.message, "Codex's session service didn't answer on this Windows PC.");
    assert.equal(e.status, 503);
    return true;
  });
  assert.equal(made[0].url, "ws://localhost/");
  assert.equal(made[0].options.handshakeTimeout, 8000);
  made[0].options.createConnection({ path: "ignored" });
  assert.deepEqual(connected, [pipe], "net.connect gets the pipe itself");
  // The Mac: ws+unix:// on its socket, exactly as before.
  const mac = createCodexDaemon({ locate: async () => "/fake/codex", run: async () => ({ stdout: '{"socketPath":"/tmp/codex-daemon-501/s.sock"}' }), Socket, connect, platform: "darwin", ...quiet });
  t.after(() => mac.close());
  await assert.rejects(mac.rpc("thread/list"), /ENOENT/);
  assert.deepEqual(made[1], { url: "ws+unix:///tmp/codex-daemon-501/s.sock:/", options: { handshakeTimeout: 8000 } });
  assert.equal(connected.length, 1, "a Mac never takes the Windows route");
});

test("on Windows a service that isn't on a named pipe is refused before connecting, without its path", async (t) => {
  const connected = [];
  const daemon = createCodexDaemon({
    locate: async () => "C:\\codex.exe",
    run: async () => ({ stdout: JSON.stringify({ socketPath: "C:\\Users\\me\\.codex\\app-server-control\\control.sock" }) }),
    connect: (where) => (connected.push(where), new net.Socket()),
    platform: "win32",
    ...quiet,
  });
  t.after(() => daemon.close());
  await assert.rejects(daemon.rpc("thread/list"), (e) => {
    assert.equal(e.message, "Codex's session service isn't on a named pipe, the only kind Reach can open on this Windows PC.");
    assert.doesNotMatch(e.message, /control\.sock|Users/);
    return e.status === 503;
  });
  assert.deepEqual(connected, []);
});

test("a real WebSocket through the injected connection: initialize, then calls", async (t) => {
  const at = await endpoint(t);
  const seen = await service(t, at);
  const pipe = "\\\\.\\pipe\\codex-daemon-test";
  const asked = [];
  const daemon = createCodexDaemon({
    locate: async () => "C:\\codex.exe",
    run: async () => ({ stdout: JSON.stringify({ socketPath: pipe }) }),
    // Where the test's service really is (a socket file off Windows).
    connect: (where) => (asked.push(where), net.connect(at)),
    platform: "win32",
    ...quiet,
  });
  t.after(() => daemon.close());
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.deepEqual(asked, [pipe]);
  assert.deepEqual(seen, [{ url: "/", host: "localhost" }]);
  assert.equal((await daemon.compatibility()).serviceVersion, "0.163.0");
  if (windows) return;
  // The service hears what a Mac's ws+unix:// connection sends.
  const mac = createCodexDaemon({ locate: async () => "/fake/codex", run: async () => ({ stdout: JSON.stringify({ socketPath: at }) }), platform: "darwin", ...quiet });
  t.after(() => mac.close());
  await mac.rpc("thread/list");
  assert.deepEqual(seen[1], seen[0]);
});

test("on Windows a pipe nobody serves fails plainly, without the pipe's name", async (t) => {
  const missing = windows ? pipeName() : path.join(await endpoint(t), "..", "nobody");
  const daemon = createCodexDaemon({
    locate: async () => "C:\\codex.exe",
    run: async () => ({ stdout: JSON.stringify({ socketPath: "\\\\.\\pipe\\codex-nobody" }) }),
    connect: () => net.connect(missing),
    platform: "win32",
    connectTimeout: 2000,
    ...quiet,
  });
  t.after(() => daemon.close());
  await assert.rejects(daemon.rpc("thread/list"), (e) => {
    assert.equal(e.message, "Codex's session service didn't answer on this Windows PC.");
    assert.doesNotMatch(e.message, /pipe|nobody/);
    return e.status === 503;
  });
});

test("on real Windows, Codex's session service is reached on a named pipe with Node's own net.connect", { skip: !windows }, async (t) => {
  const pipe = pipeName();
  const seen = await service(t, pipe);
  const daemon = createCodexDaemon({ locate: async () => "C:\\codex.exe", run: async () => ({ stdout: JSON.stringify({ socketPath: pipe }) }), ...quiet });
  t.after(() => daemon.close());
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.deepEqual(await daemon.rpc("test/ping"), {});
  assert.equal(seen.length, 1, "one connection for both calls");
});

// What Codex itself reports on Windows isn't known yet (audit #2). Where
// the runner has Codex, its daemon is started and its answer kept.
test("on real Windows with Codex installed, its session service is on a named pipe Reach reaches", { skip: !windows, timeout: 120000 }, async (t) => {
  const codex = await findCodexExecutable();
  if (!codex) return t.skip("Codex isn't installed on this runner.");
  const cli = spawnable(codex);
  const { stdout } = await promisify(execFile)(cli.file, [...cli.args, "app-server", "daemon", "start"], { timeout: 60000, maxBuffer: 65536, windowsHide: true });
  const status = JSON.parse(stdout.trim().split("\n").pop());
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile("reports/windows-codex-daemon.json", JSON.stringify({ codex: path.basename(codex), status }, null, 2));
  assert.ok(PIPE.test(status.socketPath), `Codex reported ${JSON.stringify(status.socketPath)}`);
  const daemon = createCodexDaemon({ locate: async () => codex, run: async () => ({ stdout }), ...quiet });
  t.after(() => daemon.close());
  assert.ok(Array.isArray((await daemon.rpc("thread/list", { limit: 1 })).data));
});
