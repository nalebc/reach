import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";
import { codexSocketBridge, openWindowsCodexSocket, windowsCodexSocketPath } from "../server/agent-sessions/windows-codex-socket.mjs";
import { createCodexDaemon } from "../server/agent-sessions/codex-daemon.mjs";

// These deliberately modeled children exercise the Node stream/control and
// delivery contract on all platforms. They cannot establish Windows AF_UNIX,
// connected-peer credentials, real Codex compatibility or device acceptance.
function childModel() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = 0;
  child.kill = () => { child.kills++; return true; };
  return child;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const local = String.raw`C:\Users\Me\.codex\app-server-control\app-server-control.sock`;

test("Windows AF_UNIX endpoints are absolute local paths, with no device/remote/alternate spelling", () => {
  for (const file of [local, String.raw`\\?\C:\Users\Me\.codex\control.sock`, String.raw`C:\Users\Élodie\.codex\control.sock`])
    assert.equal(windowsCodexSocketPath(file), true, file);
  for (const file of ["", null, "/tmp/s", String.raw`C:control.sock`, String.raw`\\host\share\control.sock`, String.raw`\\.\pipe\codex`,
    String.raw`C:\Users\Me\..\control.sock`, String.raw`C:\Users\Me\control.sock:stream`, String.raw`C:\Users\Me\NUL`,
    String.raw`C:\Users\Me\dir.\control.sock`, String.raw`C:\Users\Me/dir\control.sock`, local + "\n", local + "\\"])
    assert.equal(windowsCodexSocketPath(file), false, String(file));
});

test("modeled helper must authenticate on stderr before ws can write a handshake", async (t) => {
  const child = childModel();
  const sent = [];
  child.stdin.on("data", (data) => sent.push(data));
  const connecting = codexSocketBridge(child);
  let resolved = false;
  connecting.then(() => { resolved = true; });
  child.stderr.write("rea");
  await tick();
  assert.equal(resolved, false);
  assert.deepEqual(sent, []);
  child.stderr.write("dy 1\n");
  const stream = await connecting;
  t.after(() => stream.destroy());
  await new Promise((resolve, reject) => stream.write(Buffer.from([0, 255, 128, 10]), (error) => error ? reject(error) : resolve()));
  assert.deepEqual(Buffer.concat(sent), Buffer.from([0, 255, 128, 10]));
  assert.equal(stream.connecting, false);
});

test("modeled security refusal, invalid readiness, early exit and timeout fail closed without relaying", async () => {
  for (const answer of ["error acl\n", "error reparse\n", "error elevation\n", "error identity\n", "ready 2\n", "ready 1 with-extra-data\n", "x".repeat(1025),
    Buffer.from([...Buffer.from("ready 1\n")].map((byte) => byte | 128))]) {
    const child = childModel();
    const connecting = codexSocketBridge(child);
    child.stderr.write(answer);
    await assert.rejects(connecting, (error) => error.status === 503 && error.code === "CODEX_SOCKET_REFUSED");
    await tick();
    assert.equal(child.kills, 1, answer.slice(0, 32));
    assert.equal(child.stdin.readableLength, 0);
  }
  const exited = childModel();
  const connecting = codexSocketBridge(exited);
  exited.emit("close", 1, null);
  await assert.rejects(connecting, /securely connect/);
  const silent = childModel();
  // Keep one referenced handle while exercising the production unref'd timer.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(codexSocketBridge(silent, { timeout: 15 }), /securely connect/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(silent.kills, 1);
});

test("a final modeled reply survives child close and stream backpressure byte-for-byte", async (t) => {
  const child = childModel();
  const connecting = codexSocketBridge(child);
  child.stderr.write("ready 1\n");
  const stream = await connecting;
  t.after(() => stream.destroy());
  const payload = Buffer.alloc(512 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  child.stdout.end(payload);
  // Consume only after the child has closed. Destroying at close loses the
  // final buffered WebSocket response when the HTTP parser is backpressured.
  child.emit("close", 0, null);
  const received = [];
  for await (const chunk of stream) received.push(chunk);
  assert.deepEqual(Buffer.concat(received), payload);
});

test("helper integrity is checked immediately before spawn, and cancellation never spawns later", async () => {
  const calls = [];
  const child = childModel();
  const options = {
    dataDir: "private-data",
    prepareHelper: async (dir) => (calls.push(["prepare", dir]), { file: "fresh.exe", sha256: "verified" }),
    unchanged: (file, hash) => calls.push(["unchanged", file, hash]),
    start: (file, args, launch) => {
      calls.push(["spawn", file, args, launch]);
      queueMicrotask(() => child.stderr.write("ready 1\n"));
      return child;
    },
  };
  const stream = await openWindowsCodexSocket(local, options);
  stream.destroy();
  assert.deepEqual(calls.slice(0, 2), [["prepare", "private-data"], ["unchanged", "fresh.exe", "verified"]]);
  assert.deepEqual(calls[2].slice(0, 3), ["spawn", "fresh.exe", [local, String(process.pid)]]);
  assert.equal(calls[2][3].shell, undefined);
  for (const key of Object.keys(calls[2][3].env)) assert.doesNotMatch(key, /^(NODE_|REACH_|COR_|COMPlus_|DOTNET_|CORECLR_)/iu);
  const count = calls.length;
  await assert.rejects(openWindowsCodexSocket(local, { ...options, unchanged: () => { throw Error("changed"); } }), /changed/);
  assert.equal(calls.length, count + 1, "integrity failure never reaches spawn");
  const controller = new AbortController();
  await assert.rejects(openWindowsCodexSocket(local, { ...options, signal: controller.signal, prepareHelper: async () => {
    controller.abort();
    return { file: "fresh.exe", sha256: "verified" };
  } }), { name: "AbortError" });
  assert.equal(calls.length, count + 1);
});

test("modeled private preparation failure preserves finite diagnostics without native messages or paths",async()=>{
  const raw=String.raw`C:\Users\private-person\secret-token`;
  const failure=Object.assign(Error(`native output ${raw}`),{code:"EPRIVATESTAGE",status:503,
    stage:{phase:"ancestors",reason:"owner",exception:"System.InvalidCastException",innerException:"none",id:"InvalidCastException",line:53,stdout:raw},stderr:raw,stdout:raw});
  await assert.rejects(openWindowsCodexSocket(local,{dataDir:"private-data",prepareHelper:async()=>{throw failure;},start:()=>assert.fail("preparation never reached spawn")}),error=>{
    assert.equal(error.code,"CODEX_SOCKET_PREPARE");assert.equal(error.status,503);assert.equal(error.prepareCode,"EPRIVATESTAGE");assert.equal(error.prepareStatus,503);
    assert.deepEqual(error.stage,{phase:"ancestors",reason:"owner",exception:"System.InvalidCastException",innerException:"none",id:"InvalidCastException",line:53});
    assert.ok(!error.message.includes(raw));assert.ok(!JSON.stringify(error).includes(raw));assert.equal(error.cause,undefined);return true;
  });
  await assert.rejects(openWindowsCodexSocket(local,{prepareHelper:async()=>{throw Object.assign(Error(raw),{code:raw,status:99999,stage:{phase:raw,reason:raw,exception:raw,innerException:raw,id:raw,line:Infinity}});}}),error=>{
    assert.equal(error.code,"CODEX_SOCKET_PREPARE");assert.equal(error.status,503);assert.equal(error.prepareCode,undefined);assert.equal(error.prepareStatus,undefined);
    assert.ok(!JSON.stringify(error).includes(raw));assert.ok(!error.message.includes(raw));return true;
  });
});

test("aborting a modeled pending or live helper shuts it down once", async () => {
  for (const ready of [false, true]) {
    const child = childModel(), controller = new AbortController();
    const connecting = codexSocketBridge(child, { signal: controller.signal });
    let stream;
    if (ready) { child.stderr.write("ready 1\n"); stream = await connecting; }
    const closing = ready && new Promise((resolve) => stream.once("close", resolve));
    controller.abort();
    if (!ready) await assert.rejects(connecting, { name: "AbortError" });
    else await closing;
    assert.equal(child.kills, 1);
  }
});

test("closing the daemon during modeled native connection setup aborts before any WebSocket handshake", async () => {
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const daemon = createCodexDaemon({ platform: "win32", locate: async () => "codex.exe", run: async () => ({ stdout: JSON.stringify({ socketPath: local }) }),
    check: async () => ({ status: "available", version: "0.163.0" }),
    connectWindowsSocket: (endpoint, { signal }) => new Promise((resolve, reject) => {
      assert.equal(endpoint, local);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      enter();
    }),
    Socket: class { constructor() { assert.fail("native validation has not finished"); } },
  });
  const request = daemon.rpc("thread/list");
  await entered;
  daemon.close();
  await assert.rejects(request, { name: "AbortError" });
  await assert.rejects(daemon.rpc("thread/list"), /closed/u);
});

test("closing during a stalled modeled WebSocket handshake also stops the verified native child", async () => {
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const child = childModel();
  class Socket extends EventEmitter {
    constructor(url, options) {
      super();
      this.bridge = options.createConnection();
      this.bridge.once("close", () => this.emit("error", Error("fixture connection ended")));
      enter();
    }
    terminate() { this.bridge.destroy(); }
  }
  const daemon = createCodexDaemon({ platform: "win32", locate: async () => "codex.exe", run: async () => ({ stdout: JSON.stringify({ socketPath: local }) }),
    check: async () => ({ status: "available", version: "0.163.0" }), Socket,
    connectWindowsSocket: (endpoint, options) => {
      const connecting = codexSocketBridge(child, options);
      child.stderr.write("ready 1\n");
      return connecting;
    },
  });
  const request = daemon.rpc("thread/list");
  await entered;
  daemon.close();
  await assert.rejects(request, /didn't answer/u);
  assert.equal(child.kills, 1);
});

test("real ws over a modeled native bridge keeps one connection and never replays an unknown mutation", async (t) => {
  const server = http.createServer(), wss = new WebSocketServer({ server });
  const methods = [], children = [];
  let connections = 0;
  wss.on("connection", (socket) => {
    connections++;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      methods.push(message.method);
      if (message.id == null) return;
      if (message.method === "turn/start") return socket.terminate(); // delivered; reply lost
      socket.send(JSON.stringify({ id: message.id, result: message.method === "initialize" ? { userAgent: "codex_cli_rs/0.163.0 (Windows)" } : { data: [] } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const connectWindowsSocket = async (endpoint, { signal }) => {
    assert.equal(endpoint, local);
    const connection = net.connect(server.address().port, "127.0.0.1");
    const child = childModel(); children.push(child);
    child.stdin = new Writable({ write(chunk, encoding, callback) { connection.write(chunk, encoding, callback); }, final(callback) { connection.end(callback); } });
    connection.pipe(child.stdout);
    child.kill = () => { child.kills++; connection.destroy(); return true; };
    connection.on("error", () => child.emit("error", Error("fixture connection failed")));
    connection.on("close", () => child.emit("close", 0, null));
    const bridge = codexSocketBridge(child, { signal });
    connection.once("connect", () => child.stderr.write("ready 1\n"));
    return bridge;
  };
  const daemon = createCodexDaemon({ platform: "win32", locate: async () => "codex.exe", run: async () => ({ stdout: JSON.stringify({ socketPath: local }) }),
    check: async () => ({ status: "available", version: "0.163.0" }),
    checkSocket: async () => { assert.fail("AF_UNIX requires connected-peer validation, never a pipe check"); },
    connect: () => { assert.fail("no Node pipe or TCP fallback"); }, connectWindowsSocket, requestTimeout: 2000 });
  t.after(async () => {
    daemon.close();
    for (const child of children) child.kill();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.equal(connections, 1);
  await assert.rejects(daemon.rpc("turn/start", { threadId: "disposable" }), (error) => error.code === "AGENT_DELIVERY_UNKNOWN");
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
  assert.equal(connections, 2);
  assert.equal(methods.filter((method) => method === "turn/start").length, 1);
});
