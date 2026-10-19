import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { guestRefusal } from "../server/windows-guest-screen.mjs";
import { ScreenControl } from "../server/screen.mjs";

// Fake helpers only: nothing here launches the native helper or posts input.
const until = async (check, ms = 3000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; )
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "timed out waiting for state");
};
const owner = { id: "owner", kind: "device", name: "Owner", scopes: ["admin", "screen"] };
const guest = { id: "guest", kind: "guest", name: "Guest", scopes: ["screen", "screen:control"] };

function connect({ client = owner, display = "primary", allowDisplay, slow = {}, platform = "darwin", guestScreen = null } = {}) {
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
    platform,
    guestScreen,
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
  const c = connect({ slow: { click: 1100, down: 1100 } });
  await until(c.ready);
  c.input({ type: "click", x: 0.1, y: 0.1 }); // 1: holds the helper 1.1 s
  c.input({ type: "click", x: 0.2, y: 0.2 }); // 2: late, dropped
  c.input({ type: "down", x: 0.3, y: 0.3 }); // 3: late, dropped
  c.input({ type: "move", x: 0.4, y: 0.4 }); // 4: its drag: nothing is held, not moved
  c.input({ type: "up", x: 0.4, y: 0.4 }); // 5: its up: nothing went down to let go of
  c.input({ type: "release" }); // 6: late, still runs
  await until(() => c.ack(6));
  assert.equal(c.ack(2).ok, false);
  assert.match(c.ack(2).error, /waited too long/);
  assert.equal(c.ack(3).ok, false);
  assert.deepEqual(c.ack(4), { type: "ack", id: 4, ok: true, skipped: true });
  assert.deepEqual(c.ack(5), { type: "ack", id: 5, ok: true, skipped: true });
  assert.equal(c.ack(6).ok, true);
  assert.deepEqual(
    c.sent.map((a) => a.type),
    ["heartbeat", "click", "release"],
  );
  // A button that did go down is let go, however late its up.
  c.input({ type: "down", x: 0.5, y: 0.5 }); // 7: runs, holds the helper 1.1 s
  c.input({ type: "move", x: 0.6, y: 0.6 }); // 8: late: the next one stands for it
  c.input({ type: "up", x: 0.6, y: 0.6 }); // 9: late, still runs
  await until(() => c.ack(9));
  assert.equal(c.ack(7).ok, true);
  assert.equal(c.ack(9).ok, true);
  assert.equal(c.ack(9).skipped, undefined);
  assert.deepEqual(c.sent.slice(3).map((a) => a.type), ["down", "up"]);
  assert.equal(c.ws.readyState, 1, "control stays");
  c.end();
});

test("typing dropped late takes the rest of that typing with it: no holes, no drift", async () => {
  const c = connect({ slow: { scroll: 1100 } });
  await until(c.ready);
  const typed = () => c.sent.filter((a) => ["text", "type-edit", "key"].includes(a.type));
  c.input({ type: "scroll", dx: 0, dy: 5 }); // 1: holds the helper 1.1 s
  for (const text of ["p", "a", "s", "s"]) c.input({ type: "text", text }); // 2-5: late
  await until(() => c.ack(5));
  // Sent before the phone heard: dropped, though not late themselves.
  c.input({ type: "type-edit", focus: "f1", delete: 1, text: "sw" }); // 6
  for (const text of ["o", "r", "d"]) c.input({ type: "text", text }); // 7-9
  c.input({ type: "key", key: "enter" }); // 10
  await until(() => c.ack(10));
  for (let n = 2; n <= 10; n++) {
    assert.equal(c.ack(n).ok, false, `${n}`);
    assert.equal(c.ack(n).error, "Typing was too slow to reach the computer. Nothing after it was typed — type it again.");
  }
  assert.deepEqual(typed(), [], "nothing after the hole was typed");
  // The app-in-front poll comes on its own timer: typing is still over.
  c.input({ type: "context" }); // 11
  c.input({ type: "text", text: "x" }); // 12
  await until(() => c.ack(12));
  assert.equal(c.ack(11).ok, true);
  assert.equal(c.ack(12).ok, false);
  // The phone did something else (a tap): typing is its own again.
  c.input({ type: "click", x: 0.3, y: 0.3 }); // 13
  c.input({ type: "text", text: "password" }); // 14
  await until(() => c.ack(14));
  assert.equal(c.ack(14).ok, true);
  assert.deepEqual(typed(), [{ type: "text", text: "password" }]);
  assert.equal(c.ws.readyState, 1, "control stays");
  c.end();
});

test("a heartbeat (the phone has every answer) ends a dropped typing run; a late key starts one", async () => {
  const c = connect({ slow: { scroll: 1100 } });
  await until(c.ready);
  c.input({ type: "scroll", dx: 0, dy: 5 }); // 1: holds the helper 1.1 s
  c.input({ type: "key", key: "a", modifiers: ["meta"] }); // 2: late
  c.input({ type: "text", text: "b" }); // 3
  await until(() => c.ack(3));
  c.input({ type: "heartbeat" }); // 4
  c.input({ type: "text", text: "c" }); // 5
  await until(() => c.ack(5));
  assert.equal(c.ack(2).ok, false);
  assert.match(c.ack(2).error, /^Typing was too slow/);
  assert.equal(c.ack(3).ok, false);
  assert.equal(c.ack(4).ok, true);
  assert.equal(c.ack(5).ok, true);
  assert.deepEqual(c.sent.filter((a) => ["text", "key"].includes(a.type)), [{ type: "text", text: "c" }]);
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

// A Windows PC that can paint password managers black in a guest's picture
// (parity audit #12) lets them control, as a Mac does, and its helper is told
// who reads the clipboard (a concealed copy stays the owner's, #13). One
// that can't (its check failed, or none) refuses a guest's control with the
// reason, before any helper starts: never blind control.
test("on Windows a guest controls once Reach can hide private windows there, the helper told it isn't the owner; refused with the reason when it can't; the owner reads the clipboard", async () => {
  const ready = { refusal: () => "" };
  const allowed = connect({ client: guest, platform: "win32", guestScreen: ready });
  await until(allowed.ready);
  allowed.input({ type: "clipboard-read", owner: true });
  await until(() => allowed.ack(1));
  assert.deepEqual(allowed.sent.at(-1), { type: "clipboard-read", owner: false });
  allowed.end();
  for (const guestScreen of [null, { refusal: () => guestRefusal("Screen capture could not hide private windows.") }]) {
    const c = connect({ client: guest, platform: "win32", guestScreen });
    await until(() => c.ws.readyState !== 1);
    assert.equal(c.ws.closedWith, 4001);
    assert.ok(c.ws.sent.some((m) => /owner can watch or control/.test(m.error || "")), JSON.stringify(c.ws.sent));
    assert.deepEqual(c.sent, [], "no helper was asked anything");
    c.end();
  }
  const mine = connect({ client: owner, platform: "win32" });
  await until(mine.ready);
  mine.input({ type: "clipboard-read" });
  await until(() => mine.ack(1));
  assert.equal(mine.ack(1).ok, true);
  assert.deepEqual(mine.sent.at(-1), { type: "clipboard-read", owner: true });
  mine.end();
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
