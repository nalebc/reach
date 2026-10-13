import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startDom, settle } from "./dom/harness.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";

// "Clicking opens a keyboard and closes it even if it is not an input"
// (2026-10-06): the phone guessed a field while the Mac's answer was on its
// way. Now the Mac pushes where its text fields are ahead of the tap, and the
// keyboard opens only on a field it named.
let dom, React, DesktopSurface, useDesktopInput;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
  ({ useDesktopInput } = await dom.load("/src/useDesktopInput.ts"));
  dom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.releasePointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.hasPointerCapture ??= () => false;
});
after(() => dom?.close());

const box = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 });
async function surface({ answer, delay = 0, known = null }) {
  const calls = { fields: [], stale: 0 };
  const canvas = React.createRef();
  const view = await dom.render(
    React.createElement(DesktopSurface, {
      canvas, width: 1000, height: 500, ready: true, connecting: false, canControl: true,
      mode: "direct", drag: false, clickMode: "left",
      send: async () => ({}),
      onDragEnd() {}, onFeedback() {}, onInteraction() {}, onTextTarget() {},
      resetKey: "k", initialCursor: null,
      probe: () => new Promise((resolve) => setTimeout(() => resolve(answer), delay)),
      onField: (point, secure) => calls.fields.push({ point, secure }),
      knownField: () => known,
      onStaleFields: () => calls.stale++,
    }),
  );
  view.container.querySelector("canvas").getBoundingClientRect = box;
  return { view, calls, stage: view.container.querySelector(".remote-stage") };
}
const finger = (type, target, x, y) =>
  target.dispatchEvent(
    new dom.window.PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "touch" }),
  );
const click = (stage, x, y) =>
  stage.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));

test("a field the Mac already named opens the keyboard on the tap, probe still on its way", async () => {
  const { view, calls, stage } = await surface({ answer: { field: true }, delay: 200, known: { secure: true } });
  finger("pointerdown", stage, 400, 100);
  finger("pointerup", stage, 400, 100);
  click(stage, 400, 100);
  assert.deepEqual(calls.fields, [{ point: { x: 0.4, y: 0.2 }, secure: true }]);
  await settle(250);
  await view.unmount();
});

test("the probe's own answer wins over the map: no field, no keyboard, map dropped", async () => {
  const { view, calls, stage } = await surface({ answer: { field: false }, known: { secure: false } });
  finger("pointerdown", stage, 400, 100);
  await settle(20);
  finger("pointerup", stage, 400, 100);
  click(stage, 400, 100);
  assert.deepEqual(calls.fields, []);
  assert.equal(calls.stale, 1);
  await view.unmount();
});

class FakeSocket {
  static last;
  constructor() {
    this.sent = [];
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(m) {
    this.sent.push(JSON.parse(m));
  }
  close() {
    this.closed = true;
  }
  push(m) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

test("the phone keeps the Mac's field map, and stops trusting it after an input that could move fields", async () => {
  const realSocket = globalThis.WebSocket;
  dom.window.WebSocket = globalThis.WebSocket = FakeSocket;
  let input;
  const ended = [];
  function Probe() {
    input = useDesktopInput({ url: "http://mac.test", token: "T" }, true, "primary", (m) => ended.push(m));
    return null;
  }
  const view = await dom.render(React.createElement(Probe));
  await settle(10);
  const socket = FakeSocket.last;
  socket.push({ type: "ready", window: 8, typing: true, probe: true, fields: true });
  socket.push({ type: "fields", after: 0, fields: [{ x: 0.3, y: 0.8, w: 0.4, h: 0.05, secure: false }] });
  await settle(10);
  assert.deepEqual(ended, [], "a pushed map never ends control");
  assert.deepEqual(input.fieldAt({ x: 0.5, y: 0.82 }), { x: 0.3, y: 0.8, w: 0.4, h: 0.05, secure: false });
  assert.equal(input.fieldAt({ x: 0.5, y: 0.5 }), null);
  // A click can open a sheet or a page: the map from before it is out of date.
  input.send({ type: "click", x: 0.1, y: 0.1, button: "left", count: 1 }).catch(() => {});
  await settle(5);
  const id = socket.sent.find((m) => m.action?.type === "click").id;
  assert.equal(input.fieldAt({ x: 0.5, y: 0.82 }), null);
  socket.push({ type: "ack", id, ok: true });
  socket.push({ type: "fields", after: id, fields: [{ x: 0.3, y: 0.8, w: 0.4, h: 0.05 }] });
  assert.ok(input.fieldAt({ x: 0.5, y: 0.82 }));
  // A probe or a move changes nothing on screen.
  input.send({ type: "move", x: 0.2, y: 0.2 }).catch(() => {});
  await settle(30);
  assert.ok(input.fieldAt({ x: 0.5, y: 0.82 }));
  input.forgetFields();
  assert.equal(input.fieldAt({ x: 0.5, y: 0.82 }), null);
  assert.deepEqual(ended, []);
  await view.unmount();
  globalThis.WebSocket = realSocket;
});

function connection({ scanner, helper = async () => ({}) }) {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) { this.sent.push(JSON.parse(m)); },
    close() { this.closed = true; },
  });
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => ({ id: "phone", kind: "device", scopes: ["admin", "screen"] }) },
    control: { check() {}, acquire() {}, revoke() {} },
    create: async () => ({ send: helper, stop() {} }),
    ...(scanner !== undefined && { scanner }),
  });
  const send = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  return { ws, send };
}
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
};

test("on the Mac, a second helper looks for fields after a click and pushes the map", async () => {
  const asked = [];
  const { ws, send } = connection({
    scanner: async () => ({
      send: async (a) => (asked.push(a), { fields: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04, secure: false }] }),
      stop() {},
    }),
  });
  send({ type: "auth", token: "T", display: "1" });
  await until(() => ws.sent.some((m) => m.type === "fields"));
  assert.equal(ws.sent.find((m) => m.type === "ready")?.fields, true);
  assert.deepEqual(ws.sent.find((m) => m.type === "fields"), {
    type: "fields", after: 0, fields: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04, secure: false }],
  });
  send({ type: "input", id: 1, action: { type: "click", x: 0.5, y: 0.5, button: "left", count: 1 } });
  await until(() => ws.sent.some((m) => m.type === "fields" && m.after === 1));
  assert.ok(ws.sent.some((m) => m.type === "fields" && m.after === 1), "a fresh map after the click");
  assert.ok(asked.every((a) => a.type === "fields"), "the scanner only looks, never clicks");
  ws.emit("close");
});

test("on the Mac, a failing field scan costs only the map; control stays on", async () => {
  const { ws, send } = connection({
    scanner: async () => ({ send: async () => { throw Object.assign(Error("no"), { refused: true }); }, stop() {} }),
  });
  send({ type: "auth", token: "T", display: "1" });
  await until(() => ws.sent.some((m) => m.type === "ready"));
  send({ type: "input", id: 1, action: { type: "click", x: 0.5, y: 0.5, button: "left", count: 1 } });
  await until(() => ws.sent.some((m) => m.id === 1));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ws.sent.some((m) => m.type === "error"), false);
  assert.equal(ws.closed, undefined);
  ws.emit("close");
});

test("a computer without the scanner says so, and nothing else changes", async () => {
  const { ws, send } = connection({});
  send({ type: "auth", token: "T", display: "1" });
  await until(() => ws.sent.some((m) => m.type === "ready"));
  assert.equal(ws.sent.find((m) => m.type === "ready").fields, false);
  ws.emit("close");
});
