import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { DesktopInput } from "../server/desktop-native.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { ScreenControl } from "../server/screen.mjs";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Inert process events only. Nothing in this file launches a native helper or
// posts input; exit is deliberately separate from EOF and request rejection.
const flush = () => new Promise((resolve) => setImmediate(resolve));
const until = async (check) => {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "timed out waiting for lifecycle state");
};
function child() {
  const value = Object.assign(new EventEmitter(), {
    pid: 12345, alive: true, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: new EventEmitter(), requests: [], signals: [], hold: new Set(),
  });
  value.finish = () => { if (value.alive) { value.alive = false; value.emit("exit", 0); } };
  value.stdin.end = () => { value.eof = true; };
  value.stdin.write = (line) => {
    const action = JSON.parse(line); value.requests.push(action);
    if (!value.hold.has(action.type)) queueMicrotask(() => {
      if (value.alive) value.stdout.emit("data", Buffer.from(JSON.stringify(value.answer?.(action) ?? { ok: true }) + "\n"));
    });
  };
  value.kill = (signal) => { value.signals.push(signal); if (signal === "SIGKILL") value.finish(); return true; };
  return value;
}
const phone = { id: "phone", kind: "device", name: "Fixture phone", scopes: ["admin", "screen"] };
function world({ created = () => {}, parkFor } = {}) {
  const control = new ScreenControl(), clients = new Map([[phone.id, phone]]), connections = new Map(), children = [], sockets = [];
  control.acquire(phone, true);
  const connect = (client = phone) => {
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, sent: [], send(line) { this.sent.push(JSON.parse(line)); },
      close(code, reason) { this.closedWith = { code, reason }; this.readyState = 2; },
    });
    ws.end = (code = 1000) => { ws.readyState = 3; ws.emit("close", code); };
    ws.input = (message) => ws.emit("message", Buffer.from(JSON.stringify(message)), false);
    sockets.push(ws);
    desktopConnection(ws, {
      config: { screen: true }, auth: { verify: (token) => clients.get(token) }, control, scanner: null, parkFor,
      create: async () => { const process = child(); children.push(process); created(process); return new DesktopInput(process); },
      register: (id, socket) => {
        const current = connections.get(id);
        if (current?.readyState === 1) throw Object.assign(Error("already connected"), { retryable: true });
        current?.endControl?.("Desktop control reconnecting…", true);
        connections.set(id, socket);
      },
      unregister: (id, socket) => { if (connections.get(id) !== socket) return false; connections.delete(id); return true; },
    });
    ws.input({ type: "auth", token: client.id, display: "primary" });
    return ws;
  };
  return { control, clients, children, connect, async close() {
    for (const ws of sockets) ws.end();
    for (const process of children) process.finish();
    await control.waitForInputStop(); control.clear();
  } };
}
const ready = (ws) => ws.sent.some((message) => message.type === "ready");

test("request rejection does not release native ownership before actual exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const process = child(); process.hold.add("text");
  const input = new DesktopInput(process);
  const request = input.send({ type: "text", text: "fixture" });
  let exited = false; void input.terminated.then(() => { exited = true; });
  input.stop();
  await assert.rejects(request, /disconnected/);
  await Promise.resolve();
  assert.equal(exited, false); assert.equal(process.eof, true);
  t.mock.timers.tick(500);
  assert.deepEqual(process.signals, ["SIGTERM"]); assert.equal(exited, false);
  t.mock.timers.tick(1000);
  await input.terminated;
  assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL"]); assert.equal(exited, true);
});

test("confirmed spawn failure settles termination without retaining phantom ownership", async () => {
  const process = child(); delete process.pid;
  const input = new DesktopInput(process);
  process.emit("error", Error("fixture spawn failed"));
  await input.terminated;
  assert.equal(input.stopped, true); assert.deepEqual(process.signals, []);
});

test("reconnect waits for old native exit and never replays its queued input", async () => {
  const w = world();
  try {
    const first = w.connect(); await until(() => ready(first));
    w.children[0].hold.add("text");
    first.input({ type: "input", id: 1, action: { type: "text", text: "fixture" } });
    await until(() => w.children[0].requests.some((action) => action.type === "text"));
    first.input({ type: "input", id: 2, action: { type: "key", key: "a", modifiers: [] } });
    first.end(1006);
    const second = w.connect(); await flush();
    assert.equal(w.control.inputStopping(), true);
    assert.equal(w.children.length, 1, "replacement must not start while old native cleanup can post input");
    assert.equal(ready(second), false);
    w.children[0].finish(); await until(() => ready(second));
    second.input({ type: "input", id: 1, action: { type: "key", key: "b", modifiers: [] } });
    await until(() => second.sent.some((message) => message.type === "ack" && message.id === 1));
    assert.deepEqual(w.children[0].requests.map(({ type }) => type), ["heartbeat", "text"]);
    assert.deepEqual(w.children[1].requests.map(({ type }) => type), ["heartbeat", "key"]);
    assert.equal(w.children[1].requests[1].key, "b");
  } finally { await w.close(); }
});

test("Control off parks the connection and Control again resumes on the same helper", async () => {
  const w = world({ parkFor: 200 });
  try {
    const ws = w.connect(); await until(() => ready(ws));
    ws.input({ type: "input", id: 1, action: { type: "key", key: "a", modifiers: [] } });
    await until(() => ws.sent.some((message) => message.type === "ack" && message.id === 1));
    // Control off: the lease goes now (others can take it), the helper stays.
    w.control.acquire(phone, false); ws.parkControl();
    assert.equal(w.control.holder(), null);
    assert.ok(ws.sent.some((message) => message.type === "parked"));
    ws.input({ type: "input", id: 2, action: { type: "key", key: "b", modifiers: [] } });
    await until(() => ws.sent.some((message) => message.type === "ack" && message.id === 2));
    assert.equal(ws.sent.find((message) => message.id === 2).ok, false);
    assert.equal(ws.closedWith, undefined); assert.equal(w.children[0].alive, true);
    ws.parkControl(); assert.equal(ws.closedWith, undefined, "a second Control off keeps it parked");
    // Control again: same socket, same helper, a fresh input window.
    w.control.acquire(phone, true); ws.sent.length = 0;
    ws.input({ type: "resume" }); await until(() => ready(ws));
    ws.input({ type: "input", id: 1, action: { type: "key", key: "c", modifiers: [] } });
    await until(() => ws.sent.some((message) => message.type === "ack" && message.id === 1 && message.ok !== false));
    assert.equal(w.children.length, 1);
    assert.deepEqual(w.children[0].requests.map((action) => action.key ?? action.type), ["heartbeat", "a", "release", "heartbeat", "c"]);
    // Left parked past its minute: the connection ends.
    w.control.acquire(phone, false); ws.parkControl();
    await until(() => ws.closedWith?.code === 4001);
  } finally { await w.close(); }
});

test("CLOSING replacement retires old helper before its delayed close callback", async () => {
  const w = world();
  try {
    const first = w.connect(); await until(() => ready(first));
    first.readyState = 2; // peer close handshake begun, close callback has not run
    const second = w.connect(); await flush();
    assert.equal(w.children[0].eof, true);
    assert.equal(w.control.inputStopping(), true);
    assert.equal(w.children.length, 1);
    first.end(1006); // cannot revoke the replacement registration
    w.children[0].finish(); await until(() => ready(second));
    assert.equal(w.control.holder()?.clientId, phone.id);
  } finally { await w.close(); }
});

test("takeover also waits for the previous phone's helper to exit", async () => {
  const w = world(), other = { ...phone, id: "other-phone" };
  try {
    const first = w.connect(); await until(() => ready(first));
    w.clients.set(other.id, other); w.control.acquire(other, true, { takeover: true });
    first.endControl("Another phone took over."); first.end(4001);
    const second = w.connect(other); await flush();
    assert.equal(w.children.length, 1);
    w.children[0].finish(); await until(() => ready(second));
    assert.equal(w.control.holder()?.clientId, other.id);
  } finally { await w.close(); }
});

test("revoked or closed reconnect waiters never create a replacement helper", async () => {
  for (const ending of ["revoked", "closed"]) {
    const w = world();
    try {
      const first = w.connect(); await until(() => ready(first)); first.end(1006);
      const second = w.connect(); await flush();
      if (ending === "revoked") { w.clients.delete(phone.id); w.control.revoke(phone.id); }
      else second.end(1000);
      w.children[0].finish(); await flush(); await flush();
      assert.equal(w.children.length, 1, ending);
      assert.equal(ready(second), false, ending);
      if (ending === "revoked") assert.equal(second.closedWith?.code, 4001);
    } finally { await w.close(); }
  }
});

test("failed startup readiness retires its already spawned helper", async () => {
  const w = world({ created: (process) => { process.answer = () => ({ error: "fixture startup failure", fatal: true }); } });
  try {
    const first = w.connect(); await until(() => first.closedWith);
    assert.equal(ready(first), false); assert.equal(w.children[0].eof, true);
    assert.equal(w.control.inputStopping(), true, "startup failure still owns native cleanup");
    w.children[0].finish(); await w.control.waitForInputStop();
    assert.equal(w.control.inputStopping(), false);
  } finally { await w.close(); }
});

test("revoking a phone grant does not let an agent overlap its retiring native helper", async () => {
  const w = world(), calls = [];
  const policy = { invite: true, browser: true, preset: "full", roots: [] };
  const client = { id: "agent", kind: "agent", name: "Fixture agent", policy, scopes: presetScopes(policy), expiresAt: Date.now() + 60000 };
  const agent = createAgentDesktop({ screen: true }, {
    available: () => true, verifyClient: () => client, pauses: createAgentPauses(),
    phoneControls: () => !!w.control.holder() || w.control.inputStopping(),
    spawnHelper: async () => ({ async send(request, beforeSend) { beforeSend?.(); calls.push(request); return { ok: true }; }, stop() {} }),
  });
  try {
    const first = w.connect(); await until(() => ready(first));
    w.control.revoke(phone.id); first.endControl("Revoked."); first.end(4001);
    assert.equal(w.control.holder(), null); assert.equal(w.control.inputStopping(), true);
    await assert.rejects(agent.act(client, { type: "key", key: "a" }, () => client), (error) => error.status === 409 && error.kind === "paused");
    assert.equal(calls.length, 0);
    w.children[0].finish(); await w.control.waitForInputStop();
    await agent.act(client, { type: "key", key: "a" }, () => client);
    assert.equal(calls.filter((request) => request.op === "act").length, 1);
  } finally { agent.close(); await w.close(); }
});

test("HTTP fallback refuses while a disconnected desktop helper is still retiring", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-input-retirement-")), children = [];
  const reach = await createReach({ roots: [root], dataDir: path.join(root, "state"), port: 0, screen: true,
    desktopInputFactory: async () => { const process = child(); children.push(process); return new DesktopInput(process); },
  });
  let ws;
  try {
    await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${reach.server.address().port}`, owner = reach.auth.issue("fixture phone", ALL_SCOPES);
    const post = (route, body) => fetch(base + route, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/screen/control", { enabled: true })).status, 200);
    ws = new WebSocket(base.replace("http:", "ws:") + "/ws/screen-input");
    const messages = []; ws.on("message", (data) => messages.push(JSON.parse(data)));
    await once(ws, "open"); ws.send(JSON.stringify({ type: "auth", token: owner.token, display: "primary" }));
    await until(() => messages.some((message) => message.type === "ready"));
    ws.terminate(); await until(() => children[0].eof);
    assert.equal((await post("/api/screen/control", { enabled: true })).status, 200);
    // Intentionally invalid action: even a broken retirement check cannot
    // reach a platform input helper from this HTTP regression on any OS.
    const result = await post("/api/screen/input", { type: "fixture-do-not-execute" });
    assert.equal(result.status, 409, await result.text());
    children[0].finish();
    await until(() => !children[0].alive);
    const recovered = await post("/api/screen/input", { type: "fixture-do-not-execute" });
    assert.equal(recovered.status, 400, "retirement ended; ordinary payload validation resumes");
  } finally {
    ws?.terminate(); for (const process of children) process.finish();
    await reach.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
