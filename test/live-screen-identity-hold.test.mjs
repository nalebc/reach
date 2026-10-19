import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// The owner's live screen and terminal while an agent has app access, through
// the private Unix ingress, as this Mac's Tailscale identity lookups come
// slowly, fail for a moment, then fail for good. WhoIs, daemon status, the
// screen and the terminal are stand-ins: no tailnet, screen or shell is
// touched. The guard keeps the identity 2 s here (5 s in Reach) and holds a
// lapse 4 s (5 s in Reach), so the whole story fits in seconds.
test("a live screen and terminal ride out slow host lookups and a short lapse, and end only after the hold", {
  skip: process.platform === "win32" && "Private Unix ingress is POSIX-only", timeout: 60000,
}, async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-identity-hold-")));
  const socketDir = fs.mkdtempSync("/tmp/reach-hold-socket-");
  const socketPath = path.join(socketDir, "s");
  const identity = (nodeId) => ({ nodeId, userId: "42", tagged: false, validUntil: Date.now() + 600000 });
  let mode = "ok", lookups = 0, agent = null, reach;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.join(" "));
  reach = await createReach({
    name: "Fixture Mac", roots: [root], dataDir: path.join(root, "state"), screen: true, publicOrigin: "https://fixture.test:8443",
    tailscaleOwner: { userId: "42", login: "owner@example.test" },
    tailscaleIdentity: { lookup: async () => ({ Node: { StableID: "phone", User: 42, Name: "phone.test.ts.net.", KeyExpiry: "0001-01-01T00:00:00Z" },
      UserProfile: { ID: 42, LoginName: "owner@example.test" } }) },
    browserHostGuard: {
      maxAgeMs: 2000,
      lookup: async () => {
        lookups++;
        if (mode === "fail") throw Error("tailscale status timed out");
        // 1.7 s of a 5 s lifetime, at this test's 2 s.
        if (mode === "slow") await delay(700);
        return { BackendState: "Running", Self: { ID: "host" }, Peer: { phone: { ID: "phone", UserID: 42, OS: "iOS" } } };
      },
      clients: () => [...(reach?.auth.list() || []), ...(agent ? [agent] : [])],
    },
    identityHoldMs: 4000,
    remoteScreenFactory: async () => () => ({ next: async () => Buffer.from("picture"), stop() {} }),
  });
  const sockets = [];
  t.after(async () => {
    console.warn = warn;
    for (const ws of sockets) ws.terminate();
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  await reach.listenPrivate(socketPath);
  const owner = reach.auth.issue("Owner phone", ALL_SCOPES, "device", { tailscale: identity("phone") });
  // An agent with app access: the host guard is on.
  agent = { id: "active-agent", kind: "agent", policy: { browser: true, preset: "full", fullControlVersion: 1 }, expiresAt: Date.now() + 600000,
    browserAppApprover: { nodeId: "phone", userId: "42", clientId: owner.clientId } };
  const open = (route) => {
    const ws = new WebSocket(`ws+unix:${socketPath}:${route}`, { headers: { Host: "fixture.test",
      "Tailscale-User-Login": "owner@example.test", "X-Forwarded-For": "100.64.0.1" }, handshakeTimeout: 5000 });
    sockets.push(ws);
    ws.on("error", () => {});
    ws.closed = null;
    ws.on("close", (code) => { ws.closed = { code, at: Date.now() }; });
    return ws;
  };
  // The live screen: every picture acknowledged, as a phone does.
  const screen = open("/ws/screen");
  const frames = [], messages = [];
  screen.on("message", (data, binary) => {
    if (!binary) return messages.push(JSON.parse(String(data)));
    frames.push(Date.now());
    screen.send(JSON.stringify({ type: "ack", id: data.readUInt32BE(0) }));
  });
  await once(screen, "open");
  screen.send(JSON.stringify({ type: "auth", token: owner.token, protocol: 2, display: "1", format: "jpeg", quality: "saver" }));
  // A terminal: what it shows and what's typed into it, written down.
  const written = [];
  const session = { id: "fixture-session", clientId: owner.clientId, cwd: root, status: "running", buffer: "ready",
    listeners: new Set(), proc: { write: (data) => written.push(data), kill() {}, resize() {} } };
  reach.terminals.sessions.set(session.id, session);
  const terminal = open("/ws/terminal");
  const shown = [];
  terminal.on("message", (data) => shown.push(JSON.parse(String(data))));
  await once(terminal, "open");
  terminal.send(JSON.stringify({ type: "auth", token: owner.token, sessionId: session.id }));
  const until = async (check, ms = 5000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await delay(10);
    assert.ok(check(), "timed out waiting for state");
  };
  await until(() => frames.length >= 5 && shown.some((m) => m.type === "snapshot"));
  const framesSince = (at) => frames.filter((f) => f >= at).length;
  const output = (data) => { for (const listener of session.listeners) listener({ type: "output", data }); };

  // Slow lookups (0.7 s of a 2 s lifetime): the identity never lapses.
  mode = "slow";
  const slowFrom = Date.now();
  for (let second = 0; second < 5; second++) {
    const from = Date.now();
    await delay(1000);
    assert.ok(framesSince(from) > 5, `pictures kept coming in second ${second + 1}`);
  }
  assert.equal(screen.closed, null);
  assert.equal(terminal.closed, null);
  assert.ok(lookups >= 5, `${lookups} lookups`);
  assert.equal(logged.some((l) => /screen stream (held|reconnecting)/.test(l)), false, logged.join("\n"));
  assert.ok(framesSince(slowFrom) > 25);

  // Lookups fail for a moment: once the copy lapses nothing goes out, and
  // nothing closes; Tailscale answers again within the hold and it all goes on.
  mode = "fail";
  await until(() => frames.length && Date.now() - frames.at(-1) > 1200, 6000);
  const lapsedAfter = frames.at(-1);
  output("while held");
  terminal.send(JSON.stringify({ type: "input", data: "typed while held" }));
  await delay(300);
  assert.equal(framesSince(lapsedAfter + 1), 0, "no picture on a stale identity");
  assert.equal(shown.some((m) => m.data === "while held"), false, "no terminal output on a stale identity");
  assert.deepEqual(written, [], "nothing typed on a stale identity");
  mode = "ok";
  // (Written here at once; shown on the phone once its message arrives.)
  await until(() => framesSince(lapsedAfter + 1) > 0 && written.length > 0 &&
    shown.some((m) => m.data === "while held"), 4000);
  assert.equal(screen.closed, null);
  assert.equal(terminal.closed, null);
  assert.ok(shown.some((m) => m.data === "while held"), "held output shown once confirmed");
  assert.deepEqual(written, ["typed while held"], "held input written once confirmed, once");
  const held = logged.filter((l) => /screen stream held/.test(l));
  assert.equal(held.length, 1, `one line for the lapse: ${logged.join("\n")}`);
  assert.match(held[0], /Checking this (Mac|computer|PC)'s connection/);

  // Lookups fail for good: the hold ends it, retryable, after 4 s without a
  // picture.
  mode = "fail";
  await until(() => screen.closed && terminal.closed, 15000);
  const last = frames.at(-1);
  assert.equal(screen.closed.code, 1012);
  assert.ok(screen.closed.at - last >= 3500, `held ${screen.closed.at - last} ms without a picture before closing`);
  const error = messages.findLast((m) => m.type === "error");
  assert.equal(error.retryable, true);
  assert.match(error.error, /Checking this (Mac|computer|PC)'s connection/);
  assert.equal(terminal.closed.code, 1012, "the terminal reconnects too");
  assert.equal(logged.filter((l) => /screen stream reconnecting/.test(l)).length, 1, logged.join("\n"));
});

// Real WebSocket framing through the fixture's private socket; identity and
// terminal writes are controlled stand-ins. Capture this fixture's server
// socket only to exercise CLOSING before its asynchronous close event.
async function heldTerminal(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-terminal-hold-")));
  const socketDir = fs.mkdtempSync("/tmp/reach-terminal-hold-socket-");
  const socketPath = path.join(socketDir, "s");
  let agent, failed = false, reach, terminal, serverSocket;
  const emit = WebSocketServer.prototype.emit;
  t.mock.method(WebSocketServer.prototype, "emit", function (event, ...args) {
    if (event === "connection" && args[1]?.url === "/ws/terminal") serverSocket = args[0];
    return Reflect.apply(emit, this, [event, ...args]);
  });
  t.after(async () => {
    terminal?.terminate();
    serverSocket?.terminate();
    await reach?.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  reach = await createReach({
    name: "Fixture Mac", roots: [root], dataDir: path.join(root, "state"), screen: true,
    publicOrigin: "https://fixture.test:8443", tailscaleOwner: { userId: "42", login: "owner@example.test" },
    tailscaleIdentity: { lookup: async () => ({ Node: { StableID: "phone", User: 42, Name: "phone.test.ts.net.",
      KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: "owner@example.test" } }) },
    browserHostGuard: {
      maxAgeMs: 150,
      lookup: async () => {
        if (failed) throw Error("fixture identity lookup unavailable");
        return { BackendState: "Running", Self: { ID: "host" },
          Peer: { phone: { ID: "phone", UserID: 42, OS: "iOS" } } };
      },
      clients: () => [...(reach?.auth.list() || []), ...(agent ? [agent] : [])],
    },
    identityHoldMs: 5000,
  });
  await reach.listenPrivate(socketPath);
  const owner = reach.auth.issue("Owner phone", ALL_SCOPES, "device", {
    tailscale: { nodeId: "phone", userId: "42", tagged: false, validUntil: Date.now() + 600000 },
  });
  agent = { id: "active-agent", kind: "agent", policy: { browser: true, preset: "full", fullControlVersion: 1 },
    expiresAt: Date.now() + 600000, browserAppApprover: { nodeId: "phone", userId: "42", clientId: owner.clientId } };
  const activeAgent = agent;
  const written = [], shown = [], sentWhileNotOpen = [];
  const session = { id: "fixture-session", clientId: owner.clientId, cwd: root, status: "running", buffer: "ready",
    listeners: new Set(), proc: { write: (data) => written.push(data), kill() {}, resize() {} } };
  reach.terminals.sessions.set(session.id, session);
  terminal = new WebSocket(`ws+unix:${socketPath}:/ws/terminal`, { headers: { Host: "fixture.test",
    "Tailscale-User-Login": "owner@example.test", "X-Forwarded-For": "100.64.0.1" }, handshakeTimeout: 5000 });
  terminal.on("error", () => {});
  terminal.on("message", (data) => shown.push(JSON.parse(String(data))));
  await once(terminal, "open");
  const snapshot = once(terminal, "message");
  terminal.send(JSON.stringify({ type: "auth", token: owner.token, sessionId: session.id }));
  await snapshot;
  assert.ok(shown.some((message) => message.type === "snapshot"));
  assert.ok(serverSocket);
  const send = serverSocket.send;
  t.mock.method(serverSocket, "send", function (...args) {
    if (this.readyState !== WebSocket.OPEN) sentWhileNotOpen.push(String(args[0]));
    return Reflect.apply(send, this, args);
  });
  const output = (data) => { for (const listener of session.listeners) listener({ type: "output", data }); };
  failed = true;
  // Let the ordinary one-second credential check and short host cache lapse.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  output("held output");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(shown.some((message) => message.data === "held output"), false);
  assert.deepEqual(written, []);
  return {
    terminal, serverSocket, session, written, sentWhileNotOpen,
    async queue(...messages) {
      for (const message of messages) {
        const received = once(serverSocket, "message");
        terminal.send(message);
        await received;
      }
      assert.deepEqual(written, [], "held frames have not reached the terminal");
    },
    // Ending app access is a genuine allowed transition: the same phone's
    // credential remains valid, and no new device or grant is admitted.
    recover() { agent = null; },
    holdAgain() { agent = activeAgent; },
    output,
    revoke() { reach.auth.revoke(owner.clientId); },
  };
}

for (const invalid of ["{", "null"]) {
  test(`terminal held buffer stops at an invalid frame (${invalid})`, {
    skip: process.platform === "win32" && "Private Unix ingress is POSIX-only", timeout: 15000,
  }, async (t) => {
    const fixture = await heldTerminal(t);
    await fixture.queue(invalid, JSON.stringify({ type: "input", data: "must not run" }));
    const closed = once(fixture.terminal, "close");
    fixture.recover();
    fixture.output("after recovery");
    assert.deepEqual(fixture.written, [], "a refusal ends the entire buffered input flush");
    assert.deepEqual(fixture.sentWhileNotOpen, [], "no output is resumed after close begins");
    const [code] = await closed;
    assert.equal(code, 4001);
  });
}

test("terminal held buffer never resumes on a CLOSING socket", {
  skip: process.platform === "win32" && "Private Unix ingress is POSIX-only", timeout: 15000,
}, async (t) => {
  const fixture = await heldTerminal(t);
  await fixture.queue(JSON.stringify({ type: "input", data: "must not run" }));
  const closed = once(fixture.terminal, "close");
  fixture.serverSocket.close(1000);
  assert.equal(fixture.serverSocket.readyState, WebSocket.CLOSING);
  fixture.recover();
  // A frame already received as closing begins, before the close event.
  fixture.serverSocket.emit("message", Buffer.from('{"type":"ping"}'));
  assert.deepEqual(fixture.written, []);
  assert.deepEqual(fixture.sentWhileNotOpen, []);
  await closed;
});

test("terminal held buffer rechecks authorization before every input", {
  skip: process.platform === "win32" && "Private Unix ingress is POSIX-only", timeout: 15000,
}, async (t) => {
  const fixture = await heldTerminal(t);
  await fixture.queue(JSON.stringify({ type: "input", data: "first" }), JSON.stringify({ type: "input", data: "must not run" }));
  fixture.session.proc.write = (data) => { fixture.written.push(data); fixture.revoke(); };
  const closed = once(fixture.terminal, "close");
  fixture.recover();
  fixture.output("after recovery");
  assert.deepEqual(fixture.written, ["first"], "a later buffered input cannot use the earlier credential decision");
  assert.deepEqual(fixture.sentWhileNotOpen, []);
  const [code] = await closed;
  assert.equal(code, 4001);
});

test("terminal held buffer preserves a renewed hold without replaying an executed write", {
  skip: process.platform === "win32" && "Private Unix ingress is POSIX-only", timeout: 15000,
}, async (t) => {
  const fixture = await heldTerminal(t);
  await fixture.queue(JSON.stringify({ type: "input", data: "first" }), JSON.stringify({ type: "input", data: "second" }));
  fixture.session.proc.write = (data) => {
    fixture.written.push(data);
    if (data === "first") fixture.holdAgain();
  };
  fixture.recover();
  fixture.output("first recovery");
  assert.deepEqual(fixture.written, ["first"], "the next input waits for a new host identity check");
  const received = once(fixture.serverSocket, "message");
  fixture.terminal.send(JSON.stringify({ type: "input", data: "third" }));
  await received;
  assert.deepEqual(fixture.written, ["first"], "an active hold overrides the recent credential decision");
  fixture.recover();
  fixture.output("second recovery");
  assert.deepEqual(fixture.written, ["first", "second", "third"], "only unsent input is resumed, once and in order");
});
