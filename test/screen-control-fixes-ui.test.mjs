import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startDom, settle, typeInto } from "./dom/harness.mjs";
import { transpile } from "./helpers/transpile.mjs";

// What the end-to-end screen control runs found on real devices (Oct 18,
// test/journeys/screen-control*.test.mjs), held here in the shared surface:
// iOS's late mouse events after a tap, its swallowed second tap, a finger
// that rests and wobbles, a mouse that drags at once, a typing burst, and
// typing that outlives a reconnect. Mocked: the stream and the input socket.

let dom, React, DesktopSurface;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
  dom.window.localStorage.setItem("reach.twoFingerScrollHint", "1");
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback([{ contentRect: { width: 1000, height: 500 } }]); }
    disconnect() {}
  };
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
});
after(() => dom?.close());

async function surface(props = {}) {
  const sent = [];
  const view = await dom.render(React.createElement(DesktopSurface, {
    canvas: React.createRef(), width: 1000, height: 500, ready: true, connecting: false,
    canControl: true, mode: "direct", drag: false, clickMode: "left", touchScroll: true, touchAssist: false,
    doubleClick: true, send: async (action) => (sent.push(action), {}), onDragEnd() {}, onFeedback() {}, onInteraction() {},
    onTextTarget() {}, resetKey: "k", initialCursor: null, ...props,
  }));
  const stage = view.container.querySelector(".remote-stage"), canvas = stage.querySelector("canvas");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  canvas.width = 1000; canvas.height = 500;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  const of = (type) => sent.filter((a) => a.type === type);
  return { view, stage, canvas, sent, of };
}
const pointer = (s, type, x, y, pointerType = "touch") => s.canvas.dispatchEvent(new dom.window.PointerEvent(type, {
  pointerId: pointerType === "touch" ? 1 : 2, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType, button: 0,
}));
const mouse = (target, type, x = 300, y = 200, detail = 1) => {
  const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, detail });
  target.dispatchEvent(event);
  return event;
};
async function tap(s, x, y) {
  pointer(s, "pointerdown", x, y);
  await settle(5);
  pointer(s, "pointerup", x, y);
  await settle(10);
}

test("a tap's late mouse events can't take focus from the keyboard, and land only where the finger pressed", async () => {
  const s = await surface();
  const outside = dom.document.createElement("button");
  let pressed = 0;
  outside.addEventListener("click", () => pressed++);
  dom.document.body.append(outside);
  await tap(s, 300, 200);
  // iOS: ~200 ms after the finger lifted, the same tap as mouse events.
  assert.equal(mouse(s.canvas, "mousedown").defaultPrevented, true, "no focus move to the picture");
  // The key row opened under the finger: the late click lands there.
  mouse(outside, "mousedown");
  mouse(outside, "click");
  assert.equal(pressed, 0, "a late click on a control the finger never pressed does nothing");
  // A real press on it, and a keyboard's Enter, still work.
  outside.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  mouse(outside, "click");
  mouse(outside, "click", 0, 0, 0);
  assert.equal(pressed, 2);
  // Long after the tap, a mouse is a mouse.
  await settle(1050);
  assert.equal(mouse(s.canvas, "mousedown").defaultPrevented, false);
  outside.remove();
  await s.view.unmount();
});

test("iOS's swallowed second tap still double-clicks, once, at the first tap's point", async () => {
  const s = await surface();
  await tap(s, 300, 200);
  // WebKit recognized the double-tap: no touch events, only dblclick.
  mouse(s.canvas, "click");
  mouse(s.canvas, "dblclick");
  await settle(10);
  const clicks = s.of("click");
  assert.equal(clicks.length, 2);
  assert.deepEqual(clicks.map((c) => c.clickState), [1, 2]);
  assert.equal(clicks[1].clickId, clicks[0].clickId);
  assert.deepEqual([clicks[1].x, clicks[1].y], [clicks[0].x, clicks[0].y]);
  assert.deepEqual(clicks[1].pair, { x: 8 / 1000, y: 8 / 500 });
  await s.view.unmount();
  // Both taps delivered (Chrome, Android): the dblclick adds nothing.
  const t = await surface();
  await tap(t, 300, 200);
  await tap(t, 303, 201);
  mouse(t.canvas, "dblclick");
  await settle(10);
  assert.deepEqual(t.of("click").map((c) => c.clickState), [1, 2]);
  assert.deepEqual(t.of("click")[1].pair, { x: 8 / 1000, y: 8 / 500 }, "the computer gets the phone's own tolerance");
  await t.view.unmount();
});

test("a dblclick after two delivered taps that weren't a pair adds nothing; a tap the page answered late still clicks", async () => {
  const s = await surface();
  await tap(s, 300, 200);
  await tap(s, 700, 300);
  mouse(s.canvas, "dblclick", 700, 300);
  await settle(10);
  assert.deepEqual(s.of("click").map((c) => c.clickState), [1, 1]);
  await s.view.unmount();
  // The page busy for longer than a hold while the finger rests: the hold's
  // timer couldn't run, the finger lifted; it's still a tap, never nothing.
  const t = await surface();
  pointer(t, "pointerdown", 300, 200);
  for (const end = Date.now() + 450; Date.now() < end; );
  pointer(t, "pointerup", 300, 200);
  await settle(20);
  assert.equal(t.of("click").length, 1);
  assert.deepEqual(t.sent.filter((a) => a.type === "down" || a.type === "up"), []);
  await t.view.unmount();
});

test("a resting finger that wobbles clicks where it went down; a moving one drags", async () => {
  const s = await surface();
  pointer(s, "pointerdown", 300, 200);
  await settle(450);
  for (const dx of [3, -2, 4, 1]) {
    pointer(s, "pointermove", 300 + dx, 200 + dx / 2);
    await settle(20);
  }
  pointer(s, "pointerup", 304, 202);
  await settle(20);
  assert.deepEqual(s.sent.map((a) => a.type), ["down", "up"]);
  assert.deepEqual([s.sent[1].x, s.sent[1].y], [s.sent[0].x, s.sent[0].y], "released where it went down: nothing selected");
  s.sent.length = 0;
  pointer(s, "pointerdown", 300, 200);
  await settle(450);
  pointer(s, "pointermove", 360, 200);
  pointer(s, "pointerup", 360, 200);
  await settle(20);
  assert.deepEqual(s.sent.map((a) => a.type), ["down", "move", "up"]);
  await s.view.unmount();
});

test("a mouse or Pencil pressed and moved drags at once; a finger's long press is never a right-click", async () => {
  for (const pointerType of ["mouse", "pen"]) {
    const s = await surface();
    pointer(s, "pointerdown", 300, 200, pointerType);
    pointer(s, "pointermove", 340, 220, pointerType);
    pointer(s, "pointerup", 360, 230, pointerType);
    await settle(20);
    assert.deepEqual(s.sent.filter((a) => a.type !== "move").map((a) => a.type), ["down", "up"], pointerType);
    assert.equal(s.of("click").length, 0);
    await s.view.unmount();
  }
  const s = await surface();
  pointer(s, "pointerdown", 300, 200);
  await settle(420);
  s.stage.dispatchEvent(new dom.window.MouseEvent("contextmenu", { clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
  pointer(s, "pointerup", 300, 200);
  await settle(1050);
  assert.equal(s.sent.filter((a) => a.button === "right").length, 0, "Android's long-press contextmenu");
  s.stage.dispatchEvent(new dom.window.MouseEvent("contextmenu", { clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
  await settle(10);
  assert.equal(s.sent.filter((a) => a.button === "right").length, 1, "a mouse's right button");
  await s.view.unmount();
});

test("trackpad mode starts from where the computer's pointer really is", async () => {
  const s = await surface({ mode: "trackpad", hostCursor: () => ({ x: 0.9, y: 0.1, at: performance.now() }) });
  await tap(s, 300, 200);
  assert.deepEqual([s.of("click")[0].x, s.of("click")[0].y], [0.9, 0.1]);
  await s.view.unmount();
});

const queueModule = async () => {
  const source = await fs.readFile(new URL("../src/desktop-input-queue.ts", import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`);
};

test("typing waiting in the queue goes as one edit, exactly as typed", async () => {
  const { mergeTyping, DesktopInputQueue } = await queueModule();
  const edit = (d, text) => ({ type: "type-edit", focus: "f", delete: d, text });
  assert.deepEqual(mergeTyping(edit(0, "ab"), edit(0, "c")), edit(0, "abc"));
  assert.deepEqual(mergeTyping(edit(1, "ab"), edit(1, "x")), edit(1, "ax"));
  assert.deepEqual(mergeTyping(edit(0, "a👩🏽‍💻"), edit(1, "")), edit(0, "a"), "graphemes, as typing-edit counts them");
  assert.deepEqual(mergeTyping(edit(2, "a"), edit(3, "z")), edit(4, "z"));
  assert.equal(mergeTyping(edit(0, "a"), { ...edit(0, "b"), focus: "g" }), null, "another field");
  assert.equal(mergeTyping(edit(0, "a"), { type: "key", key: "enter" }), null);
  assert.deepEqual(mergeTyping({ type: "text", text: "he" }, { type: "text", text: "y" }), { type: "text", text: "hey" });
  // A burst far beyond the queue's 32 places: nothing fails, nothing lost.
  const sent = [];
  let failed = "";
  const queue = new DesktopInputQueue((id, action) => sent.push({ id, action }), (m) => (failed = m), 1);
  const done = [];
  for (const ch of "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    done.push(queue.enqueue(edit(0, ch)));
  assert.equal(failed, "");
  assert.equal(sent.length, 1);
  queue.acknowledge(sent[0].id, { ok: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].action.text + sent[1].action.text, "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  queue.acknowledge(sent[1].id, { ok: true });
  assert.equal((await Promise.all(done)).length, 62, "every letter's promise settles");
});
