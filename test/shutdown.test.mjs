import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createReach } from "../server/index.mjs";
import { approvalStore } from "../server/device-approval.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { createCodexDaemon } from "../server/agent-sessions/codex-daemon.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Ctrl+C must be done by then. The launcher's last-resort deadline (5 s) is
// later, so passing means shutdown finished on its own.
const PROMPT_MS = 4000;
const unix = { skip: process.platform === "win32", timeout: 40000 };
const within = (promise, ms) =>
  Promise.race([promise, sleep(ms).then(() => null)]);
// Unlike events.once, not upset by the error a cut connection reports first.
const closeOf = (emitter) =>
  new Promise((resolve) => emitter.once("close", () => resolve(true)));

// The shared Codex app-server daemon Reach connects to as soon as it listens:
// `codex app-server daemon start` names a Unix socket speaking JSON-RPC over a
// WebSocket (server/agent-sessions/codex-daemon.mjs).
async function fakeCodexDaemon(t) {
  const dir = await fs.mkdtemp("/tmp/reach-codex-"); // Darwin socket path limit
  const socketPath = path.join(dir, "d.sock");
  const executable = path.join(dir, "codex");
  await fs.writeFile(
    executable,
    `#!/bin/sh\necho '${JSON.stringify({ socketPath })}'\n`,
    { mode: 0o755 },
  );
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const daemon = {
    executable,
    socketPath,
    clients: wss.clients,
    initialized: false,
  };
  wss.on("connection", (ws) =>
    ws.on("message", (data) => {
      const message = JSON.parse(data);
      if (message.method === "initialize") daemon.initialized = true;
      if (message.id !== undefined)
        ws.send(JSON.stringify({ id: message.id, result: {} }));
    }),
  );
  await new Promise((r) => server.listen(socketPath, r));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return daemon;
}

// A shared folder holding a large file for a phone to download.
async function sharedFolder(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(root, "movie.mov"), "");
  await fs.truncate(path.join(root, "movie.mov"), 256 * 1024 * 1024);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Reach in the foreground, as ./reach runs it (local, without Tailscale), and
// connected to Codex as it is outside the test runner.
async function startReach(t, { preload } = {}) {
  const root = await sharedFolder(t, "reach-stop-");
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const daemon = await fakeCodexDaemon(t);
  const env = { ...process.env, HOME: home, REACH_CODEX: daemon.executable };
  for (const key of Object.keys(env))
    if (key.startsWith("REACH_") && key !== "REACH_CODEX") delete env[key];
  delete env.NODE_TEST_CONTEXT;
  const entry = pathToFileURL(path.resolve("scripts/launch.mjs")).href;
  const child = spawn(
    process.execPath,
    [
      ...(preload ? ["--import", preload] : []),
      "--input-type=module",
      "-e",
      // Left behind when the test runner dies (killed, timed out): it stops
      // itself, helpers and menu bar item included, rather than run for good.
      `setInterval(() => process.ppid === 1 && process.kill(process.pid, "SIGTERM"), 500).unref(); import { launch } from ${JSON.stringify(entry)}; await launch({ local: true, folders: [${JSON.stringify(root)}], port: 0 }, ${JSON.stringify(root)});`,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = once(child, "exit");
  // SIGKILL: a hung Reach ignores further SIGINT/SIGTERM.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  const deadline = Date.now() + 20000;
  while (!output.includes("Press Enter") || !daemon.initialized) {
    if (child.exitCode !== null || Date.now() > deadline)
      throw Error(`Reach did not start:\n${output}`);
    await sleep(30);
  }
  return {
    child,
    exited,
    root,
    url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0],
    output: () => output,
  };
}

// A phone in the middle of things: an idle keep-alive connection, a live
// WebSocket and a download it reads too slowly to ever finish.
async function connectPhone(t, url, output) {
  const [, a, b] = output.match(/Pairing code: (\d{4}) (\d{4})/);
  const paired = await fetch(url + "/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: a + b, name: "test phone" }),
  });
  const { token } = await paired.json();
  const headers = { Authorization: `Bearer ${token}` };
  const keepAlive = new http.Agent({ keepAlive: true });
  const get = (route, agent) =>
    new Promise((resolve, reject) =>
      http.get(url + route, { agent, headers }, resolve).once("error", reject),
    );
  const health = await get("/api/health", keepAlive);
  health.resume();
  await once(health, "end");
  const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/presence");
  ws.on("error", () => {});
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", token, kind: "phone" }));
  await once(ws, "message");
  const download = await get("/api/files/content?path=movie.mov", false);
  download.on("error", () => {});
  download.pause();
  t.after(() => {
    ws.terminate();
    keepAlive.destroy();
    download.destroy();
  });
  assert.equal(download.statusCode, 200);
  assert.equal(Object.values(keepAlive.freeSockets).flat().length, 1);
  assert.equal(ws.readyState, WebSocket.OPEN);
}

for (const signal of ["SIGINT", "SIGTERM"])
  test(
    `${signal} stops Reach within seconds while a phone is connected`,
    unix,
    async (t) => {
      const reach = await startReach(t);
      await connectPhone(t, reach.url, reach.output());
      reach.child.kill(signal);
      const exit = await within(reach.exited, PROMPT_MS);
      assert.ok(
        exit,
        `Still running ${PROMPT_MS} ms after ${signal}:\n${reach.output()}`,
      );
      assert.deepEqual(exit, [0, null], reach.output());
      await assert.rejects(fetch(reach.url + "/api/health"));
      await assert.rejects(
        fs.access(path.join(reach.root, ".reach", "host-status.json")),
      );
    },
  );

test("a second Ctrl+C quits at once", unix, async (t) => {
  const reach = await startReach(t);
  await connectPhone(t, reach.url, reach.output());
  reach.child.kill("SIGINT");
  // The download keeps the first, graceful stop busy for a moment.
  await sleep(100);
  reach.child.kill("SIGINT");
  assert.deepEqual(await within(reach.exited, 1000), [130, null]);
});

test(
  "Reach still exits when something it started never lets go",
  unix,
  async (t) => {
    // Stands in for a socket or timer some module forgets to close.
    const reach = await startReach(t, {
      preload: "data:text/javascript,setInterval(() => {}, 3600000)",
    });
    reach.child.kill("SIGINT");
    const exit = await within(reach.exited, 9000);
    assert.ok(exit, `Still running 9 s after SIGINT:\n${reach.output()}`);
    assert.deepEqual(exit, [1, null], reach.output());
    assert.match(reach.output(), /took too long/);
    await assert.rejects(
      fs.access(path.join(reach.root, ".reach", "host-status.json")),
    );
  },
);

test(
  "closing Reach cuts off phones on the private Tailscale socket",
  unix,
  async (t) => {
    const root = await sharedFolder(t, "reach-stop-private-");
    const socketDir = await fs.mkdtemp("/tmp/reach-stop-socket-");
    t.after(() => fs.rm(socketDir, { recursive: true, force: true }));
    const socketPath = path.join(socketDir, "s");
    const dataDir = path.join(root, "private");
    const owner = { userId: "42", login: "owner@example.test" };
    const reach = await createReach({
      roots: [root],
      dataDir,
      port: 0,
      tailscaleOwner: owner,
      tailscaleIdentity: {
        lookup: async () => ({
          Node: { StableID: "nPhone", User: 42, Name: "nPhone.test.ts.net." },
          UserProfile: { ID: 42, LoginName: owner.login },
        }),
      },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    await reach.listenPrivate(socketPath);
    // Requests as Tailscale Serve forwards them from the phone.
    const headers = {
      Host: "localhost",
      "X-Forwarded-For": "100.64.0.1",
      "Tailscale-User-Login": owner.login,
    };
    const keepAlive = new http.Agent({ keepAlive: true });
    const request = (route, { body, agent = keepAlive, token } = {}) =>
      new Promise((resolve, reject) =>
        http
          .request(
            {
              socketPath,
              path: route,
              method: body ? "POST" : "GET",
              agent,
              headers: {
                ...headers,
                ...(token && { Authorization: `Bearer ${token}` }),
                ...(body && { "Content-Type": "application/json" }),
              },
            },
            resolve,
          )
          .once("error", reject)
          .end(body && JSON.stringify(body)),
      );
    const json = async (response) => {
      let text = "";
      for await (const chunk of response) text += chunk;
      return JSON.parse(text);
    };
    let ws, download, closing;
    try {
      const asked = await json(
        await request("/api/auth/requests", { body: { name: "Phone" } }),
      );
      approvalStore(dataDir).decide(asked.id, "approve");
      const { token } = await json(
        await request(`/api/auth/requests/${asked.id}`, {
          body: { secret: asked.secret },
        }),
      );
      ws = new WebSocket(`ws+unix:${socketPath}:/ws/presence`, { headers });
      ws.on("error", () => {});
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token, kind: "phone" }));
      await once(ws, "message");
      download = await request("/api/files/content?path=movie.mov", {
        agent: false,
        token,
      });
      download.on("error", () => {});
      download.pause();
      assert.equal(download.statusCode, 200);
      assert.equal(Object.values(keepAlive.freeSockets).flat().length, 1);
      closing = reach.close();
      const closed = await within(
        closing.then(() => true),
        PROMPT_MS,
      );
      assert.ok(closed, `reach.close() still waiting after ${PROMPT_MS} ms`);
      // Cut off, not waited for: reading on finds the connection gone.
      let received = 0;
      download.on("data", (chunk) => (received += chunk.length));
      download.resume();
      if (!download.destroyed) await within(closeOf(download), 2000);
      assert.ok(download.destroyed, "the download was left open");
      assert.ok(received < 256 * 1024 * 1024, "the download was not cut off");
      if (ws.readyState !== WebSocket.CLOSED) await within(closeOf(ws), 1000);
      assert.equal(ws.readyState, WebSocket.CLOSED);
    } finally {
      // Before the fix, close() waits until these let go.
      ws?.terminate();
      download?.destroy();
      keepAlive.destroy();
      await (closing ?? reach.close()).catch(() => {});
    }
  },
);

test("quitting ends agent sign-ins and replies, and lets go of Codex", () => {
  const calls = [];
  const sessions = createAgentSessions({
    daemon: { close: () => calls.push("codex daemon") },
    codex: {},
    codexLive: {},
    claude: {},
    signIn: { cancel: (agent) => calls.push(`${agent} sign-in`) },
    claudeHost: { close: () => calls.push("claude host") },
  });
  sessions.close();
  assert.deepEqual(calls, [
    "claude sign-in",
    "codex sign-in",
    "claude host",
    "codex daemon",
  ]);
});

test(
  "a closed Codex daemon connection drops its socket and never reconnects",
  unix,
  async (t) => {
    const daemon = await fakeCodexDaemon(t);
    let starts = 0;
    const connect = () =>
      createCodexDaemon({
        locate: async () => daemon.executable,
        run: async () => {
          starts++;
          return { stdout: JSON.stringify({ socketPath: daemon.socketPath }) };
        },
      });
    const open = connect();
    await open.rpc("thread/list");
    assert.equal(daemon.clients.size, 1);
    const [socket] = daemon.clients;
    open.close();
    if (socket.readyState !== WebSocket.CLOSED)
      assert.ok(await within(closeOf(socket), 1000), "socket left open");
    await assert.rejects(open.rpc("thread/list"), /closed/);
    assert.equal(starts, 1);
    // Closed while still connecting: nothing is left open either.
    const connecting = connect();
    const pending = connecting.rpc("thread/list");
    connecting.close();
    await assert.rejects(pending, /closed/);
    await sleep(50);
    assert.equal(daemon.clients.size, 0);
  },
);

test("quitting lets each Claude Code reply process go", async () => {
  const procs = [];
  const host = createClaudeHost({
    locate: async () => "/usr/local/bin/claude",
    env: {},
    spawn: () => {
      const proc = new EventEmitter();
      proc.exitCode = null;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { on() {}, write() {}, end: () => (proc.ended = true) };
      proc.kill = () => (proc.exitCode = 143);
      procs.push(proc);
      return proc;
    },
  });
  const id = "11111111-2222-4333-8444-555555555555";
  await host.send(id, { text: "hello" });
  assert.equal(host.drives(id), true);
  host.close();
  assert.equal(host.drives(id), false);
  assert.deepEqual(
    procs.map((p) => p.ended),
    [true],
  );
});
