import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { createScreenControlDiagnostics, SCREEN_CONTROL_DIAGNOSTICS } from "./helpers/screen-control-diagnostics.mjs";

test("screen diagnostics retain connection causes and timing without credentials or input contents", () => {
  const diagnostics = createScreenControlDiagnostics();
  const secret = "PRIVATE_CANARY_TOKEN_TEXT_FOCUS_URL";
  for (const type of ["auth", "input", "ack", "ready", "error", "fields"]) {
    diagnostics.record({ t: 120417, socket: 2, dir: "in", token: secret, url: secret,
      m: { type, id: 40, token: secret, text: secret, focus: secret, target: { focus: secret, text: secret }, fields: [secret],
        action: { type: "type-edit", text: secret, focus: secret, extra: { token: secret } },
        ok: false, retryable: true, superseded: false, error: "Checking this phone's connection. Reconnecting…" } });
  }
  diagnostics.record({ t: 120418, socket: 2, dir: "close", code: 1012, reason: "Desktop control reconnecting", token: secret });
  const result = diagnostics.drain();
  assert.equal(result.events.length, 7);
  assert.deepEqual(result.events.at(-1), { dir: "close", t: 120418, socket: 2, code: 1012, reason: "Desktop control reconnecting" });
  assert.equal(result.events[4].error, "Checking this phone's connection. Reconnecting…");
  assert.equal(result.events[4].retryable, true);
  assert.equal(result.events[1].action, "type-edit");
  assert.equal(result.events[1].id, 40);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY|token|focus|text|url|target|fields":/i);
});

test("unexpected and malformed protocol values cannot become archived strings or nested objects", () => {
  const diagnostics = createScreenControlDiagnostics(), secret = "PRIVATE_CANARY";
  for (const value of [null, undefined, true, 1, secret, [], [secret], { token: secret }]) diagnostics.record(value);
  for (const value of [secret, { token: secret }, [secret], null, Infinity, { toJSON: () => secret }]) {
    diagnostics.record({ dir: "in", socket: value, t: value, code: value, reason: value,
      m: { type: value, id: value, action: { type: value }, ok: value, retryable: value, window: value, error: value } });
  }
  const result = diagnostics.drain();
  assert.equal(result.events.length, 6);
  assert.equal(result.events[0].type, "unknown");
  assert.equal(result.events[0].error, "[redacted unexpected message]");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY|token|toJSON/);
});

test("bounded traffic preserves the causal lifecycle across a heartbeat flood and resets on drain", () => {
  const diagnostics = createScreenControlDiagnostics();
  diagnostics.record({ dir: "in", socket: 1, m: { type: "error", error: "Checking this phone's connection. Reconnecting…", retryable: true } });
  diagnostics.record({ dir: "close", socket: 1, code: 1012, reason: "Desktop control reconnecting" });
  diagnostics.record({ dir: "open", socket: 2 });
  for (let i = 1; i <= 10000; i++) diagnostics.record({ dir: "out", socket: 2, t: i * 500, m: { type: "input", id: i, action: { type: "heartbeat" } } });
  const result = diagnostics.drain();
  assert.equal(result.events.length, 256);
  assert.equal(result.dropped, 9747);
  assert.deepEqual(result.lifecycle.map(value => value.type || value.dir), ["error", "close", "open"]);
  assert.equal(result.events.at(-1).id, 10000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100000);
  assert.deepEqual(diagnostics.drain(), { version: 1, events: [], dropped: 0, lifecycle: [], lifecycleDropped: 0 });
  for (let i = 0; i < 100; i++) diagnostics.record({ dir: "close", socket: i + 1, code: 1012 });
  const bounded = diagnostics.drain();
  assert.equal(bounded.lifecycle.length, 32);
  assert.equal(bounded.lifecycleDropped, 68);
});

test("the exact standalone browser bootstrap preserves the same privacy and close metadata", () => {
  const browser = vm.runInNewContext(SCREEN_CONTROL_DIAGNOSTICS);
  browser.record({ dir: "out", socket: 1, m: { type: "auth", token: "PRIVATE_CANARY" } });
  browser.record({ dir: "close", socket: 1, code: 1012, reason: "Desktop control reconnecting" });
  const result = JSON.parse(JSON.stringify(browser.drain()));
  assert.deepEqual(result.events, [
    { dir: "out", socket: 1, type: "auth" },
    { dir: "close", socket: 1, code: 1012, reason: "Desktop control reconnecting" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY|token/);
});

// Inert WebSocket events verify the journey observer preserves delivery;
// this is not native input, an operating-system run or a physical client.
test("the installed journey trace observes socket replacement and heartbeats without changing delivery", () => {
  const source = fs.readFileSync(new URL("./journeys/screen-control.test.mjs", import.meta.url), "utf8");
  const assignment = source.slice(source.indexOf("const TRACE = "), source.indexOf("\n\nconst place = "));
  const script = vm.runInNewContext(assignment + "; TRACE", { SCREEN_CONTROL_DIAGNOSTICS });
  class Socket {
    constructor() { this.url = "wss://private.test/ws/screen-input"; this.sent = []; this.handlers = {}; }
    send(value) { this.sent.push(value); return "original send result"; }
    emit(name, value) { this.handlers[name]?.call(this, value); }
  }
  for (const name of ["onmessage", "onclose", "onopen", "onerror"])
    Object.defineProperty(Socket.prototype, name, {
      configurable: true,
      get() { return this.handlers[name]; },
      set(value) { this.handlers[name] = value; },
    });
  const window = {}, context = { window, WebSocket: Socket, performance: { now: () => 120417 }, HTMLElement: { prototype: { focus() {} } }, addEventListener() {} };
  vm.runInNewContext(script, context);
  const first = new Socket(), second = new Socket();
  const delivered = [];
  for (const socket of [first, second])
    for (const name of ["onmessage", "onclose", "onopen", "onerror"])
      socket[name] = function (value) { delivered.push({ socket: this, name, value }); };
  const auth = JSON.stringify({ type: "auth", token: "PRIVATE_CANARY_TOKEN" });
  assert.equal(first.send(auth), "original send result");
  assert.equal(first.sent[0], auth);
  first.emit("onopen", {});
  first.send(JSON.stringify({ type: "input", id: 1, action: { type: "heartbeat" } }));
  first.emit("onmessage", { data: JSON.stringify({ type: "ack", id: 1, ok: true }) });
  first.send(JSON.stringify({ type: "input", id: 2, action: { type: "type-edit", text: "PRIVATE_CANARY_TEXT", focus: "PRIVATE_CANARY_FOCUS" } }));
  first.emit("onmessage", { data: JSON.stringify({ type: "error", retryable: true, error: "Checking this phone's connection. Reconnecting…" }) });
  first.emit("onclose", { code: 1012, reason: "Desktop control reconnecting" });
  second.emit("onopen", {});
  second.emit("onmessage", { data: JSON.stringify({ type: "ready", window: 8 }) });
  assert.equal(delivered.length, 6);
  assert.equal(delivered[0].socket, first);
  assert.equal(delivered[5].socket, second);
  const result = JSON.parse(JSON.stringify(window.__scDiagnostics.drain()));
  assert.deepEqual(result.events.filter(value => value.action === "heartbeat" || value.type === "ack").map(value => [value.socket, value.dir, value.id]), [[1, "out", 1], [1, "in", 1]]);
  assert.deepEqual(result.lifecycle.map(value => [value.socket, value.type || value.dir]), [[1, "open"], [1, "error"], [1, "close"], [2, "open"], [2, "ready"]]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY|token|focus|text|private\.test/i);
});
