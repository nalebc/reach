import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

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
  const sent = [], targets = [];
  const view = await dom.render(React.createElement(DesktopSurface, {
    canvas: React.createRef(), width: 1000, height: 500, ready: true, connecting: false,
    canControl: true, mode: "direct", drag: false, clickMode: "left", touchScroll: true, touchAssist: true,
    send: async (action) => (sent.push(action), {}), onDragEnd() {}, onFeedback() {}, onInteraction() {},
    onTextTarget: (point) => targets.push(point), resetKey: "k", initialCursor: null, ...props,
  }));
  const stage = view.container.querySelector(".remote-stage"), canvas = stage.querySelector("canvas");
  stage.getBoundingClientRect = () => ({ left: 20, top: 30, width: 1000, height: 500 });
  canvas.width = 1000; canvas.height = 500;
  canvas.getBoundingClientRect = () => ({ left: 20 + parseFloat(canvas.style.left), top: 30 + parseFloat(canvas.style.top),
    width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) });
  return { view, stage, canvas, sent, targets, clicks: () => sent.filter((a) => a.type === "click") };
}
const finger = (s, type, x, y, pointerType = "touch", pointerId = 1) => s.stage.dispatchEvent(new dom.window.PointerEvent(type, {
  pointerId, clientX: x + 20, clientY: y + 30, bubbles: true, cancelable: true, pointerType,
}));
async function tap(s, x, y, { dx = 0, dy = 0, pointerType = "touch" } = {}) {
  finger(s, "pointerdown", x, y, pointerType);
  finger(s, "pointerup", x + dx, y + dy, pointerType);
  await settle(10);
}
async function zoom(s) {
  s.view.container.querySelector('[aria-label="Zoom in"]').click();
  await settle(10);
}

test("a finger's small lift drift keeps the landing point; mouse and Pencil stay exact", async () => {
  const s = await surface();
  await tap(s, 300, 200, { dx: 5, dy: 3 });
  assert.deepEqual(s.clicks()[0], { type: "click", x: 0.3, y: 0.4, button: "left", count: 1, touch: { x: 0.01, y: 0.02 } });
  for (const pointerType of ["mouse", "pen"]) {
    await tap(s, 300, 200, { dx: 5, dy: 3, pointerType });
    assert.deepEqual(s.clicks().at(-1), { type: "click", x: 0.305, y: 0.406, button: "left", count: 1 });
  }
  await s.view.unmount();
});

test("starting outside the picture or swiping without intermediate events cannot create a stray click", async () => {
  const s = await surface();
  await tap(s, 300, 200, { dx: 20 });
  assert.equal(s.clicks().length, 0);
  await tap(s, -2, 200, { dx: 4 });
  assert.equal(s.clicks().length, 0, "touch-down was outside the image");
  await s.view.unmount();
});

test("touch assistance scales with zoom, and can be disabled or bypassed for right clicks and trackpad", async () => {
  const s = await surface();
  await zoom(s);
  await tap(s, 300, 200);
  assert.deepEqual(s.clicks()[0].touch, { x: 10 / 1250, y: 10 / 625 });
  await s.view.unmount();
  for (const props of [{ touchAssist: false }, { clickMode: "right" }, { mode: "trackpad" }]) {
    const exact = await surface(props);
    await tap(exact, 300, 200);
    assert.equal(exact.clicks()[0].touch, undefined);
    await exact.view.unmount();
  }
});

test("feedback and the typing focus check use where the Mac actually clicked", async () => {
  const sent = [];
  const s = await surface({ send: async (action) => (sent.push(action), { point: { x: 0.31, y: 0.41 } }) });
  await tap(s, 300, 200);
  assert.equal(sent.length, 1);
  const wave = s.view.container.querySelector(".screen-wave");
  assert.equal(wave.style.left, "310px");
  assert.equal(wave.style.top, "205px");
  assert.deepEqual(s.targets, [{ x: 0.31, y: 0.41 }]);
  await s.view.unmount();
});

test("zoomed direct control pans with one finger, including a resting finger; all corners move clear of overlays", async () => {
  const s = await surface();
  await zoom(s);
  const before = s.canvas.style.left;
  finger(s, "pointerdown", 500, 250);
  await settle(450);
  finger(s, "pointermove", 5000, 2500);
  finger(s, "pointerup", 5000, 2500);
  await settle(10);
  assert.notEqual(s.canvas.style.left, before);
  assert.equal(s.canvas.style.left, "48px");
  assert.equal(s.canvas.style.top, "48px");
  assert.deepEqual(s.sent, [], "panning sends no remote scroll, drag or click");
  await tap(s, 48, 48);
  assert.equal(s.clicks()[0].x, 0);
  assert.equal(s.clicks()[0].y, 0);
  finger(s, "pointerdown", 500, 250);
  finger(s, "pointermove", -5000, -2500);
  finger(s, "pointerup", -5000, -2500);
  await settle(10);
  const right = parseFloat(s.canvas.style.left) + parseFloat(s.canvas.style.width),
    bottom = parseFloat(s.canvas.style.top) + parseFloat(s.canvas.style.height);
  assert.equal(right, 952);
  assert.equal(bottom, 452);
  await tap(s, right, bottom);
  assert.equal(s.clicks().at(-1).x, 1);
  assert.equal(s.clicks().at(-1).y, 1);
  await s.view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("explicit Drag still drags on the Mac while zoomed", async () => {
  const s = await surface({ drag: true });
  await zoom(s);
  finger(s, "pointerdown", 300, 200);
  finger(s, "pointermove", 400, 200);
  finger(s, "pointerup", 400, 200);
  await settle(10);
  assert.deepEqual(s.sent.map((a) => a.type), ["down", "move", "up"]);
  assert.equal(s.sent[0].touch, undefined);
  await s.view.unmount();
});

test("two fingers still scroll the Mac while zoomed, without moving the view", async () => {
  const s = await surface();
  await zoom(s);
  const before = [s.canvas.style.left, s.canvas.style.top];
  finger(s, "pointerdown", 400, 250);
  finger(s, "pointerdown", 600, 250, "touch", 2);
  finger(s, "pointermove", 400, 200);
  finger(s, "pointermove", 600, 200, "touch", 2);
  finger(s, "pointerup", 400, 200);
  finger(s, "pointerup", 600, 200, "touch", 2);
  await settle(10);
  assert.ok(s.sent.some((a) => a.type === "scroll" && a.dy < 0));
  assert.deepEqual([s.canvas.style.left, s.canvas.style.top], before);
  assert.equal(s.clicks().length, 0);
  await s.view.unmount();
});

test("a delayed click acknowledgment cannot move a trackpad cursor back after another gesture", async () => {
  let done;
  const sent = [];
  const s = await surface({ mode: "trackpad", send: (action) => {
    sent.push(action);
    return action.type === "click" && !done ? new Promise((resolve) => { done = resolve; }) : Promise.resolve({});
  } });
  await tap(s, 500, 250);
  finger(s, "pointerdown", 500, 250);
  finger(s, "pointermove", 700, 250);
  finger(s, "pointerup", 700, 250);
  done({ point: { x: 0.5, y: 0.5 } });
  await settle(10);
  await tap(s, 500, 250);
  assert.equal(sent.filter((a) => a.type === "click").at(-1).x, 0.7);
  await s.view.unmount();
});
