import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { ScreenControl } from "../server/screen.mjs";

// Fake helpers only: nothing here launches the native helper or posts input.
const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out waiting for state");
};
const owner = { id: "owner", kind: "device", name: "Owner", scopes: ["admin", "screen"] };
const guest = { id: "guest", kind: "guest", name: "Guest", scopes: ["screen", "screen:control"] };

function connect({ client = owner, display = "primary", allowDisplay, slow = {} } = {}) {
  const control = new ScreenControl();
  control.acquire(client, true);
  const sent = [];
  const helper = {
    async send(action) {
      sent.push(action);
      if (slow[action.type]) await new Promise((r) => setTimeout(r, slow[action.type]));
      return action.type === "clipboard-read" ? { ok: true, text: "x" } : { ok: true };
    },
    stop() {},
  };
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close(code) {
      this.readyState = 2;
      this.closedWith = code;
    },
  });
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => client },
    control,
    scanner: null,
    create: async () => helper,
    ...(allowDisplay && { allowDisplay }),
  });
  const message = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  message({ type: "auth", token: "T", display });
  let id = 0;
  const input = (action) => message({ type: "input", id: ++id, action });
  const ack = (n) => ws.sent.find((m) => m.type === "ack" && m.id === n);
  const end = () => {
    ws.readyState = 3;
    ws.emit("close", 1000);
  };
  return { ws, sent, input, ack, end, ready: () => ws.sent.some((m) => m.type === "ready") };
}

test("a button up or release that waited behind a slow action still runs; a late click doesn't", async () => {
  const c = connect({ slow: { click: 1100 } });
  await until(c.ready);
  c.input({ type: "click", x: 0.1, y: 0.1 }); // 1: holds the helper 1.1 s
  c.input({ type: "click", x: 0.2, y: 0.2 }); // 2: late, dropped
  c.input({ type: "down", x: 0.3, y: 0.3 }); // 3: late, dropped
  c.input({ type: "up", x: 0.3, y: 0.3 }); // 4: late, still runs
  c.input({ type: "release" }); // 5: late, still runs
  await until(() => c.ack(5));
  assert.equal(c.ack(2).ok, false);
  assert.match(c.ack(2).error, /waited too long/);
  assert.equal(c.ack(3).ok, false);
  assert.equal(c.ack(4).ok, true);
  assert.equal(c.ack(5).ok, true);
  assert.deepEqual(
    c.sent.map((a) => a.type),
    ["heartbeat", "click", "up", "release"],
  );
  assert.equal(c.ws.readyState, 1, "control stays");
  c.end();
});

test("a probe queued ahead of a tap is skipped so the click isn't held up", async () => {
  const c = connect({ slow: { move: 300 } });
  await until(c.ready);
  c.input({ type: "move", x: 0.1, y: 0.1 }); // 1: busy helper
  c.input({ type: "probe", x: 0.5, y: 0.5 }); // 2: waiting
  c.input({ type: "click", x: 0.5, y: 0.5 }); // 3: queued behind it
  await until(() => c.ack(3));
  assert.deepEqual(c.ack(2), { type: "ack", id: 2, ok: true, skipped: true });
  assert.ok(!c.sent.some((a) => a.type === "probe"));
  // Alone, a probe still runs.
  c.input({ type: "probe", x: 0.5, y: 0.5 });
  await until(() => c.ack(4));
  assert.equal(c.sent.at(-1).type, "probe");
  c.end();
});

test("an invalid or oversized action fails alone; control stays", async () => {
  const c = connect();
  await until(c.ready);
  c.input({ type: "text", text: "é".repeat(4001) }); // 8002 bytes
  c.input({ type: "clipboard-write", text: "a".repeat(16385) });
  c.input({ type: "key", key: "nope" });
  c.input({ type: "click", x: 0.5, y: 0.5 });
  await until(() => c.ack(4));
  for (const n of [1, 2, 3]) assert.equal(c.ack(n).ok, false);
  assert.match(c.ack(1).error, /too large/);
  assert.equal(c.ack(4).ok, true);
  assert.equal(c.ws.readyState, 1);
  assert.deepEqual(c.sent.map((a) => a.type), ["heartbeat", "click"]);
  // A malformed message (not an action) still ends control.
  c.ws.emit("message", Buffer.from(JSON.stringify({ type: "input", id: 1, action: { type: "release" } })), false);
  assert.equal(c.ws.closedWith, 4001);
  c.end();
});

test("only the owner reads a concealed clipboard: the helper is told who asks", async () => {
  for (const [client, isOwner] of [[owner, true], [guest, false]]) {
    const c = connect({ client });
    await until(c.ready);
    c.input({ type: "clipboard-read", owner: true }); // the phone can't claim it
    await until(() => c.ack(1));
    assert.deepEqual(c.sent.at(-1), { type: "clipboard-read", owner: isOwner });
    c.end();
  }
});

test("a hidden app display needs that app shared; losing it mid-control ends control", async () => {
  let shared = false;
  const allowDisplay = (client, display) => display !== "77" || shared;
  const refused = connect({ client: guest, display: "77", allowDisplay });
  await until(() => refused.ws.closedWith !== undefined);
  assert.equal(refused.ws.closedWith, 4001);
  assert.ok(!refused.ready());
  assert.match(refused.ws.sent.find((m) => m.type === "error").error, /isn't shared/);
  refused.end();

  shared = true;
  const c = connect({ client: guest, display: "77", allowDisplay });
  await until(c.ready);
  shared = false;
  c.input({ type: "click", x: 0.5, y: 0.5 });
  await until(() => c.ws.closedWith !== undefined);
  assert.equal(c.ws.closedWith, 4001);
  assert.ok(!c.sent.some((a) => a.type === "click"));
  c.end();

  // An ordinary display is unaffected.
  const plain = connect({ client: guest, display: "1", allowDisplay });
  await until(plain.ready);
  plain.end();
});
