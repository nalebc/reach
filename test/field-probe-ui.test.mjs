import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startDom, settle } from "./dom/harness.mjs";
import { inputAction } from "../server/desktop-protocol.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";

// Typing on the live screen without a Type button: on touch-down the phone
// asks the Mac whether a text field is under the finger. When the answer is
// back before the finger lifts, the tap's own click opens the keyboard
// (Safari opens it only then). The real DesktopSurface, with finger events.
let dom, React, DesktopSurface;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
  dom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.releasePointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.hasPointerCapture ??= () => false;
});
after(() => dom?.close());

async function surface({ answer, delay = 0, probing = true } = {}) {
  const calls = { probes: [], fields: [], sent: [] };
  const canvas = React.createRef();
  const view = await dom.render(
    React.createElement(DesktopSurface, {
      canvas,
      width: 1000,
      height: 500,
      ready: true,
      connecting: false,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      send: async (action) => {
        calls.sent.push(action);
        return {};
      },
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget() {},
      resetKey: "k",
      initialCursor: null,
      ...(probing && {
        probe: (point) => {
          calls.probes.push(point);
          return new Promise((resolve) =>
            setTimeout(() => resolve(answer), delay),
          );
        },
        onField: (point, secure) => calls.fields.push({ point, secure }),
      }),
    }),
  );
  // jsdom has no layout: the video fills a 1000×500 box at the origin.
  const video = view.container.querySelector("canvas");
  video.width = 1000;
  video.height = 500;
  video.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
    right: 1000,
    bottom: 500,
    x: 0,
    y: 0,
  });
  return { view, calls, stage: view.container.querySelector(".remote-stage") };
}
const finger = (type, target, x, y) =>
  target.dispatchEvent(
    new dom.window.PointerEvent(type, {
      pointerId: 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    }),
  );
// A tap as Safari delivers it: down, (time passes), up, then click.
async function tap(stage, x, y, holdMs = 30) {
  finger("pointerdown", stage, x, y);
  await settle(holdMs);
  finger("pointerup", stage, x, y);
  stage.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: x,
      clientY: y,
    }),
  );
  await settle(10);
}

test("a tap on a text field opens the keyboard on that tap, no Type button", async () => {
  const { view, calls, stage } = await surface({
    answer: { field: true, secure: false },
  });
  await tap(stage, 400, 100);
  assert.deepEqual(calls.probes, [{ x: 0.4, y: 0.2 }]);
  assert.deepEqual(calls.fields, [
    { point: { x: 0.4, y: 0.2 }, secure: false },
  ]);
  // The click still goes to the Mac, as any tap's does.
  assert.deepEqual(
    calls.sent.filter((a) => a.type === "click"),
    [{ type: "click", x: 0.4, y: 0.2, button: "left", count: 1 }],
  );
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("a password field says so, for a password keyboard", async () => {
  const { view, calls, stage } = await surface({
    answer: { field: true, secure: true },
  });
  await tap(stage, 500, 250);
  assert.deepEqual(calls.fields, [{ point: { x: 0.5, y: 0.5 }, secure: true }]);
  await view.unmount();
});

test("a tap on anything else opens no keyboard", async () => {
  const { view, calls, stage } = await surface({ answer: { field: false } });
  await tap(stage, 400, 100);
  assert.equal(calls.probes.length, 1);
  assert.deepEqual(calls.fields, []);
  await view.unmount();
});

test("an unsure answer opens no keyboard (no flash open and shut on a non-field)", async () => {
  const { view, calls, stage } = await surface({ answer: { field: false, uncertain: true } });
  await tap(stage, 400, 100);
  assert.deepEqual(calls.fields, []);
  await view.unmount();
});

test("a quick tap on a non-field opens no keyboard while the probe is still pending", async () => {
  const { view, calls, stage } = await surface({
    answer: { field: false },
    delay: 80,
  });
  await tap(stage, 400, 100, 10);
  await settle(120);
  assert.deepEqual(calls.fields, []);
  await view.unmount();
});

test("a field confirmed between the finger lifting and the click still opens on that tap", async () => {
  const { view, calls, stage } = await surface({ answer: { field: true, secure: true }, delay: 5 });
  finger("pointerdown", stage, 400, 100);
  finger("pointerup", stage, 400, 100);
  await settle(20);
  stage.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 400, clientY: 100 }));
  assert.deepEqual(calls.fields, [{ point: { x: 0.4, y: 0.2 }, secure: true }]);
  await view.unmount();
});

test("an answer meant for an earlier touch never opens the keyboard on a later one", async () => {
  // The first touch's answer ("a field") lands during the second touch; the
  // second touch's own answer only comes after its tap.
  const delays = [0, 200];
  const fields = [];
  const canvas = React.createRef();
  let n = 0;
  const second = await dom.render(
    React.createElement(DesktopSurface, {
      canvas,
      width: 1000,
      height: 500,
      ready: true,
      connecting: false,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      send: async () => ({}),
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget() {},
      resetKey: "k",
      initialCursor: null,
      probe: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ field: true }), delays[n++]),
        ),
      onField: (point, secure) => fields.push({ point, secure }),
    }),
  );
  const video = second.container.querySelector("canvas");
  video.width = 1000;
  video.height = 500;
  video.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
    right: 1000,
    bottom: 500,
    x: 0,
    y: 0,
  });
  const area = second.container.querySelector(".remote-stage");
  finger("pointerdown", area, 100, 100);
  finger("pointerup", area, 100, 100);
  finger("pointerdown", area, 900, 400);
  await settle(20); // the first answer lands now
  finger("pointerup", area, 900, 400);
  area.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(250);
  // Its own answer came too late for the tap, so no keyboard at all.
  assert.deepEqual(fields, []);
  await second.unmount();
});

test("a computer that can't answer is never asked", async () => {
  const { view, calls, stage } = await surface({ probing: false });
  await tap(stage, 400, 100);
  assert.deepEqual(calls.probes, []);
  assert.deepEqual(
    calls.sent.map((a) => a.type),
    ["click"],
  );
  await view.unmount();
});

test("the probe is checked like any desktop action, and the computer says it can answer", async () => {
  assert.deepEqual(inputAction({ type: "probe", x: 0.25, y: 1 }), {
    type: "probe",
    x: 0.25,
    y: 1,
  });
  for (const bad of [{ x: -1, y: 0 }, { x: 0.5 }, { x: "0.5", y: 0.5 }])
    assert.throws(
      () => inputAction({ type: "probe", ...bad }),
      /Invalid probe/,
    );
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close() {},
  });
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => ({ id: "phone", kind: "device", scopes: ["admin", "screen"] }) },
    control: { check() {}, acquire() {}, revoke() {} },
    create: async () => ({ send: async () => ({ cursor: null }), stop() {} }),
  });
  ws.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "auth", token: "T", display: "1" })),
    false,
  );
  const end = Date.now() + 1000;
  while (!ws.sent.some((m) => m.type === "ready") && Date.now() < end)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(ws.sent.find((m) => m.type === "ready")?.probe, true);
  ws.emit("close");
});

// "I can no longer scroll" (2026-10-06): a one-finger scroll sent a move with
// every step, which kept the steps from merging; control ended in seconds.
test("a one-finger scroll puts the pointer there once, then sends only scroll steps", async () => {
  const canvas = React.createRef();
  const sent = [];
  const view = await dom.render(
    React.createElement(DesktopSurface, {
      canvas, width: 1000, height: 500, ready: true, connecting: false, canControl: true,
      mode: "direct", drag: false, clickMode: "left", touchScroll: true,
      send: async (action) => (sent.push(action), {}),
      onDragEnd() {}, onFeedback() {}, onInteraction() {}, onTextTarget() {},
      resetKey: "k", initialCursor: null,
    }),
  );
  const video = view.container.querySelector("canvas");
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 });
  const stage = view.container.querySelector(".remote-stage");
  finger("pointerdown", stage, 500, 400);
  for (let y = 390; y >= 100; y -= 10) {
    finger("pointermove", stage, 500, y);
    await settle(16);
  }
  finger("pointerup", stage, 500, 100);
  await settle(20);
  const kinds = sent.map((a) => a.type).filter((t) => t === "move" || t === "scroll");
  assert.equal(kinds.filter((t) => t === "move").length, 1, "one move");
  assert.ok(kinds.filter((t) => t === "scroll").length > 10, "the scroll steps");
  assert.equal(kinds[0], "move");
  await view.unmount();
});

test("on the Mac, a move or scroll that waited too long is let go; control stays on", async () => {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) { this.sent.push(JSON.parse(m)); },
    close() { this.closed = true; },
  });
  let release;
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => ({ id: "phone", kind: "device", scopes: ["admin", "screen"] }) },
    control: { check() {}, acquire() {}, revoke() {} },
    create: async () => ({
      // The first action holds the helper 1.2 s; the next ones wait behind it.
      send: async (a) => (a.type === "key" ? new Promise((r) => (release = () => r({})), setTimeout(() => release(), 1200)) : {}),
      stop() {},
    }),
  });
  const send = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  send({ type: "auth", token: "T", display: "1" });
  for (const end = Date.now() + 1000; !ws.sent.some((m) => m.type === "ready") && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  send({ type: "input", id: 1, action: { type: "key", key: "a" } });
  send({ type: "input", id: 2, action: { type: "scroll", dx: 0, dy: -5 } });
  for (const end = Date.now() + 2000; !ws.sent.some((m) => m.id === 2) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.equal(ws.sent.find((m) => m.id === 2)?.skipped, true, "the late scroll let go");
  assert.equal(ws.sent.some((m) => m.type === "error"), false, "control stays on");
  ws.emit("close");
});

// "I start typing and it goes back to view only" (2026-10-06): any action the
// Mac's helper turned down (a typing target a web editor rebuilt) ended
// control. Now only that action fails.
test("on the Mac, an action the helper turns down fails alone; control stays on", async () => {
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
    create: async () => ({
      send: async (a) => {
        if (a.type === "text") throw Object.assign(new Error("The typing target changed. Tap the text field again."), { status: 403, refused: true });
        return {};
      },
      stop() {},
    }),
  });
  const send = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  send({ type: "auth", token: "T", display: "1" });
  for (const end = Date.now() + 1000; !ws.sent.some((m) => m.type === "ready") && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  send({ type: "input", id: 1, action: { type: "text", text: "hi" } });
  send({ type: "input", id: 2, action: { type: "key", key: "enter" } });
  for (const end = Date.now() + 1000; !ws.sent.some((m) => m.id === 2) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ws.sent.find((m) => m.id === 1), { type: "ack", id: 1, ok: false, error: "The typing target changed. Tap the text field again." });
  assert.ok(ws.sent.find((m) => m.id === 2)?.type === "ack", "the next action still runs");
  assert.equal(ws.sent.some((m) => m.type === "error"), false, "control stays on");
  assert.notEqual(ws.closed, true);
  ws.emit("close");
});

test("the helper's word that an action was turned down, or that control can't go on, reaches the server as such", async () => {
  const { readFileSync } = await import("node:fs");
  const swift = readFileSync(new URL("../scripts/native/desktop-input.swift", import.meta.url), "utf8");
  // Only no Accessibility and a lost display end control (code 2, "fatal").
  assert.match(swift, /if e\.code == 2 \{ result\["fatal"\] = true \}/);
  assert.equal((swift.match(/code: 2\)/g) || []).length, 2);
  // A rebuilt web field still counts: same app, same kind, mostly the same place.
  assert.match(swift, /CFEqual\(expected, current\) \|\| sameField\(current\)/);
  const native = readFileSync(new URL("../server/desktop-native.mjs", import.meta.url), "utf8");
  assert.match(native, /value\.fatal \? \{\} : \{ refused: true \}/);
});
