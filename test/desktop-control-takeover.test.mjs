import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { desktopConnection, takeOver } from "../server/desktop-connection.mjs";
import { DesktopInput } from "../server/desktop-native.mjs";
import { ScreenControl } from "../server/screen.mjs";

// The phone replacing its control connection used to end control: its
// cleanup closed without a code (1005), read here as "the phone let go"; and
// a reconnect was refused (409) while the old connection was still open and
// busy, until the phone's six tries ran out. Fake helper processes only:
// nothing here launches a native helper or posts input.

const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out waiting for state");
};
// A helper process that answers each line, except the kinds it's told to
// hold (an action the computer is slow to finish); it exits on stdin's end.
function child() {
  const value = Object.assign(new EventEmitter(), {
    pid: 4321, alive: true, stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: new EventEmitter(), requests: [], hold: new Set(),
  });
  value.finish = () => { if (value.alive) { value.alive = false; value.emit("exit", 0); } };
  value.stdin.end = () => { value.eof = true; };
  value.stdin.write = (line) => {
    const action = JSON.parse(line);
    value.requests.push(action);
    if (!value.hold.has(action.type)) queueMicrotask(() => {
      if (value.alive) value.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true }) + "\n"));
    });
  };
  value.kill = (signal) => { if (signal === "SIGKILL") value.finish(); return true; };
  return value;
}
const phone = { id: "phone", kind: "device", name: "Phone", scopes: ["admin", "screen"] };
function world() {
  const control = new ScreenControl(), connections = new Map(), children = [];
  control.acquire(phone, true);
  const connect = () => {
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, sent: [], send(line) { this.sent.push(JSON.parse(line)); },
      close(code, reason) { this.closedWith = { code, reason }; this.readyState = 2; },
    });
    ws.end = (code) => { ws.readyState = 3; ws.emit("close", code); };
    ws.input = (message) => ws.emit("message", Buffer.from(JSON.stringify(message)), false);
    desktopConnection(ws, {
      config: { screen: true }, auth: { verify: () => phone }, control, scanner: null, grace: 400,
      create: async () => { const process = child(); children.push(process); return new DesktopInput(process); },
      // What server/index.mjs registers each control connection with.
      register: (id, socket) => takeOver(connections, id, socket),
      unregister: (id, socket) => { if (connections.get(id) !== socket) return false; connections.delete(id); return true; },
    });
    ws.input({ type: "auth", token: "T", display: "primary" });
    return ws;
  };
  return { control, connections, children, connect };
}
const ready = (ws) => ws.sent.some((m) => m.type === "ready");

test("a new control connection from the same phone takes over from a busy old one", async () => {
  const w = world();
  const first = w.connect();
  await until(() => ready(first));
  // The old connection is busy: the computer is slow with a click.
  w.children[0].hold.add("click");
  first.input({ type: "input", id: 1, action: { type: "down", x: 0.2, y: 0.2 } });
  first.input({ type: "input", id: 2, action: { type: "click", x: 0.5, y: 0.5 } });
  first.input({ type: "input", id: 3, action: { type: "text", text: "queued behind it" } });
  await until(() => w.children[0].requests.some((a) => a.type === "click"));
  const second = w.connect();
  // The old one ends as superseded and retryable: the lease isn't let go.
  await until(() => first.closedWith);
  assert.deepEqual(first.closedWith.code, 1012);
  assert.deepEqual(first.sent.at(-1), {
    type: "error",
    error: "Desktop control moved to this device's newer connection.",
    retryable: true,
    superseded: true,
  });
  assert.equal(w.connections.get("phone"), second);
  assert.equal(w.children[0].eof, true, "its helper is told to stop (and lets go of the button on exit)");
  // The new helper starts only once the old one exited.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.children.length, 1);
  assert.equal(ready(second), false);
  w.children[0].finish();
  await until(() => ready(second));
  assert.equal(w.children.length, 2);
  first.end(1012);
  assert.equal(w.control.holder()?.clientId, "phone", "control goes on, no new grant");
  assert.equal(w.control.reconnecting("phone"), false);
  // Nothing the old one held is sent again.
  assert.deepEqual(w.children[1].requests.map((a) => a.type), ["heartbeat"]);
  second.input({ type: "input", id: 1, action: { type: "heartbeat" } });
  await until(() => second.sent.some((m) => m.type === "ack" && m.id === 1));
  second.end(1000);
  assert.equal(w.control.holder(), null);
});

test("a close without a code is a drop (grace); 1000 lets go at once; Stop ends control on its own", async () => {
  for (const [code, kept] of [[1005, true], [4002, true], [1006, true], [1000, false]]) {
    const w = world();
    const ws = w.connect();
    await until(() => ready(ws));
    ws.end(code);
    assert.equal(!!w.control.holder(), kept, `${code}`);
    assert.equal(w.control.reconnecting("phone"), kept, `${code}`);
    w.children[0].finish();
    if (kept) {
      // Nobody back within the grace: let go.
      await until(() => !w.control.holder(), 1500);
      assert.equal(w.control.reconnecting("phone"), false);
    }
  }
  // Stop on the phone (/api/screen/control, enabled: false) revokes at
  // once; the connection's close without a code after it keeps nothing.
  const w = world();
  const ws = w.connect();
  await until(() => ready(ws));
  w.control.acquire(phone, false);
  ws.parkControl();
  ws.end(1005);
  assert.equal(w.control.holder(), null);
  assert.equal(w.control.reconnecting("phone"), false);
  w.children[0].finish();
});
