import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// "Add ability to scroll down and all, scroll horizontal" (Oct 12): two
// fingers scroll the Mac both ways in every touch mode, pinch still zooms,
// and one finger does what it did. The real DesktopSurface, finger events.
let dom, React, DesktopSurface;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.releasePointerCapture ??= function () {};
  // The hint is said once per phone; these tests are past it.
  dom.window.localStorage.setItem("reach.twoFingerScrollHint", "1");
  // jsdom has no layout: the stage is a 1000×500 box, as the picture.
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback([{ contentRect: { width: 1000, height: 500 } }]); }
    unobserve() {}
    disconnect() {}
  };
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
});
after(() => dom?.close());

async function surface(mode, { canControl = true } = {}) {
  const sent = [];
  const view = await dom.render(
    React.createElement(DesktopSurface, {
      canvas: React.createRef(), width: 1000, height: 500, ready: true, connecting: false, canControl,
      mode, drag: false, clickMode: "left", touchScroll: true, compact: true,
      send: async (action) => (sent.push(action), {}),
      onDragEnd() {}, onFeedback() {}, onInteraction() {}, onTextTarget() {},
      resetKey: "k", initialCursor: null,
    }),
  );
  const box = { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 };
  view.container.querySelector("canvas").getBoundingClientRect = () => box;
  const stage = view.container.querySelector(".remote-stage");
  stage.getBoundingClientRect = () => box;
  return { view, sent, stage };
}
const finger = (stage, type, id, x, y) =>
  stage.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "touch" }));
// Two fingers 200 px apart moving together by (dx, dy) in small steps.
async function twoFingers(stage, dx, dy, { spread = 0 } = {}) {
  finger(stage, "pointerdown", 1, 400, 250);
  finger(stage, "pointerdown", 2, 600, 250);
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    finger(stage, "pointermove", 1, 400 + dx * t - spread * t, 250 + dy * t);
    finger(stage, "pointermove", 2, 600 + dx * t + spread * t, 250 + dy * t);
    // About a frame between steps, as a finger moves.
    await settle(16);
  }
  finger(stage, "pointerup", 1, 400 + dx - spread, 250 + dy);
  finger(stage, "pointerup", 2, 600 + dx + spread, 250 + dy);
  await settle(40);
}
const total = (sent, axis) => sent.filter((a) => a.type === "scroll").reduce((sum, a) => sum + a[axis], 0);
const zoomed = (view) => /^(\d+)%/.exec(view.container.querySelector('[aria-label="Fit entire screen"]')?.textContent || "100%")?.[1];

for (const mode of ["direct", "pan", "trackpad"]) {
  test(`${mode}: two fingers scroll the Mac down, up and sideways; pinch still zooms`, async () => {
    const down = await surface(mode);
    await twoFingers(down.stage, 0, -200);
    const scrolls = down.sent.filter((a) => a.type === "scroll");
    assert.ok(scrolls.length >= 2, `scroll steps (${scrolls.length})`);
    // The content follows the fingers, as the one-finger scroll does.
    assert.ok(total(down.sent, "dy") < -150, `down: ${total(down.sent, "dy")}`);
    assert.equal(total(down.sent, "dx"), 0);
    for (const step of scrolls) {
      assert.ok(Number.isInteger(step.dx) && Number.isInteger(step.dy), "whole pixels");
      assert.ok(Math.abs(step.dy) <= 120 && Math.abs(step.dx) <= 120, "clamped");
    }
    // The pointer is put under the fingers once (trackpad: it is already
    // at the cursor), then only scroll steps; nothing is clicked.
    const moves = down.sent.filter((a) => a.type === "move");
    assert.equal(moves.length, mode === "trackpad" ? 0 : 1);
    assert.equal(down.sent.some((a) => ["click", "down"].includes(a.type)), false);
    assert.equal(zoomed(down.view), "100", "a scroll is not a zoom");
    await down.view.unmount();

    const sideways = await surface(mode);
    await twoFingers(sideways.stage, 160, 0);
    assert.ok(total(sideways.sent, "dx") > 120, `sideways: ${total(sideways.sent, "dx")}`);
    assert.equal(total(sideways.sent, "dy"), 0);
    await sideways.view.unmount();

    const pinch = await surface(mode);
    await twoFingers(pinch.stage, 0, 0, { spread: 120 });
    assert.equal(pinch.sent.some((a) => a.type === "scroll"), false, "a pinch sends no scroll");
    assert.ok(Number(zoomed(pinch.view)) > 100, "and zooms in");
    await pinch.view.unmount();
    assert.deepEqual(dom.errors, []);
  });
}

test("a scroll whose fingers drift apart stays a scroll", async () => {
  const s = await surface("direct");
  finger(s.stage, "pointerdown", 1, 400, 250);
  finger(s.stage, "pointerdown", 2, 600, 250);
  // First the fingers travel together, then they drift 15 % apart.
  for (let i = 1; i <= 10; i++) {
    finger(s.stage, "pointermove", 1, 400, 250 - i * 10);
    finger(s.stage, "pointermove", 2, 600, 250 - i * 10);
    await settle(16);
  }
  for (let i = 1; i <= 10; i++) {
    finger(s.stage, "pointermove", 1, 400 - i * 1.5, 150 - i * 10);
    finger(s.stage, "pointermove", 2, 600 + i * 1.5, 150 - i * 10);
    await settle(16);
  }
  finger(s.stage, "pointerup", 1, 385, 50);
  finger(s.stage, "pointerup", 2, 615, 50);
  await settle(40);
  assert.ok(total(s.sent, "dy") < -150);
  assert.equal(zoomed(s.view), "100");
  await s.view.unmount();
});

test("only watching, two fingers move the picture and send nothing", async () => {
  const s = await surface("direct", { canControl: false });
  await twoFingers(s.stage, 0, -200);
  assert.deepEqual(s.sent, []);
  await s.view.unmount();
});

test("one finger keeps its old meaning: direct scrolls, trackpad moves the cursor", async () => {
  const direct = await surface("direct");
  finger(direct.stage, "pointerdown", 1, 500, 400);
  for (let y = 390; y >= 200; y -= 10) {
    finger(direct.stage, "pointermove", 1, 500, y);
    await settle(16);
  }
  finger(direct.stage, "pointerup", 1, 500, 200);
  await settle(20);
  assert.ok(direct.sent.filter((a) => a.type === "scroll").length > 5);
  await direct.view.unmount();
  const pad = await surface("trackpad");
  finger(pad.stage, "pointerdown", 1, 500, 400);
  for (let y = 390; y >= 200; y -= 10) finger(pad.stage, "pointermove", 1, 500, y);
  finger(pad.stage, "pointerup", 1, 500, 200);
  await settle(20);
  assert.equal(pad.sent.some((a) => a.type === "scroll"), false);
  assert.ok(pad.sent.filter((a) => a.type === "move").length > 5);
  await pad.view.unmount();
});

test("the hint is said once, the first time the phone can control", async () => {
  dom.window.localStorage.removeItem("reach.twoFingerScrollHint");
  const said = [];
  const render = () =>
    dom.render(
      React.createElement(DesktopSurface, {
        canvas: React.createRef(), width: 1000, height: 500, ready: true, connecting: false, canControl: true,
        mode: "direct", drag: false, clickMode: "left", send: async () => ({}),
        onDragEnd() {}, onFeedback: (text) => said.push(text), onInteraction() {}, onTextTarget() {},
        resetKey: "k", initialCursor: null,
      }),
    );
  const first = await render();
  await first.unmount();
  const second = await render();
  await second.unmount();
  assert.deepEqual(said.filter(Boolean), ["Two fingers to scroll"]);
});
