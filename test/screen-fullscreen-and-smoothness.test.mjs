import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

const immersiveCss = fs.readFileSync(
  new URL("../src/screen-immersive.css", import.meta.url),
  "utf8",
);
const chromeCss = fs.readFileSync(
  new URL("../src/screen-chrome.css", import.meta.url),
  "utf8",
);
const atmosphereCss = fs.readFileSync(
  new URL("../src/atmosphere.css", import.meta.url),
  "utf8",
);

test("fullscreen screen viewer uses pure black background with no gray boxes around the stage", () => {
  assert.match(
    immersiveCss,
    /\.simple-screen\.screen-expanded,\s*\.simple-screen\.screen-immersive,\s*\.simple-screen:fullscreen\s*\{[^}]*background:\s*#000;/,
  );
  assert.match(
    immersiveCss,
    /\.simple-screen\.screen-expanded \.remote-stage,\s*\.simple-screen\.screen-immersive \.remote-stage,\s*\.simple-screen:fullscreen \.remote-stage\s*\{[^}]*background:\s*#000;/,
  );
  assert.match(
    immersiveCss,
    /html:has\(\.screen-expanded, \.screen-immersive\),\s*body:has\(\.screen-expanded, \.screen-immersive\)\s*\{[^}]*background:\s*#000;/,
  );
  assert.match(
    chromeCss,
    /\.simple-screen\.screen-immersive\[data-chrome="overlay"\]:not\(\.screen-typing\)\s*\{[^}]*background:\s*#000;/,
  );
  assert.match(
    atmosphereCss,
    /\.screen-expanded,\s*\.screen-viewer:fullscreen\s*\{[^}]*background:\s*#000;/,
  );
});

let dom, React, DesktopSurface, DesktopInputQueue;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.localStorage.setItem("reach.twoFingerScrollHint", "1");
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      this.callback([{ contentRect: { width: 1000, height: 500 } }]);
    }
    disconnect() {}
  };
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
  ({ DesktopInputQueue } = await dom.load("/src/desktop-input-queue.ts"));
});
after(() => dom?.close());

test("DesktopInputQueue does not stall a scroll behind a pointer move and preserves large fast-flick scroll deltas", async () => {
  let now = 1000;
  const sent = [];
  const queue = new DesktopInputQueue(
    (id, action) => sent.push({ id, action }),
    (message) => {
      throw Error(message);
    },
    8,
    () => now,
  );

  // Move followed immediately by scroll at the same timestamp must both send immediately.
  const pMove = queue.enqueue({ type: "move", x: 0.5, y: 0.5 });
  const pScroll = queue.enqueue({ type: "scroll", dx: 0, dy: -40 });
  assert.equal(sent.length, 2, "move must not throttle an immediate scroll");
  assert.equal(sent[0].action.type, "move");
  assert.equal(sent[1].action.type, "scroll");
  queue.acknowledge(sent[0].id, { ok: true });
  queue.acknowledge(sent[1].id, { ok: true });
  await Promise.all([pMove, pScroll]);

  // Two large scroll bursts exceeding 120 must not discard travel distance.
  now += 2; // Inside 8ms throttle window so both queue.
  const s1 = queue.enqueue({ type: "scroll", dx: 0, dy: -90 });
  const s2 = queue.enqueue({ type: "scroll", dx: 0, dy: -80 });
  now += 20;
  await settle(20);
  now += 20;
  await settle(20);
  const scrollDeltas = sent
    .slice(2)
    .filter((entry) => entry.action.type === "scroll")
    .reduce((sum, entry) => sum + entry.action.dy, 0);
  for (const entry of sent.slice(2)) queue.acknowledge(entry.id, { ok: true });
  await Promise.all([s1, s2]);
  assert.equal(scrollDeltas, -170, "fast flick deltas must not be clamped away");
  queue.close();
});

test("DesktopSurface recovers cleanly when setPointerCapture throws or a mouse button releases outside the window", async () => {
  const sent = [];
  dom.window.HTMLElement.prototype.setPointerCapture = function () {
    throw new dom.window.DOMException("No active pointer", "InvalidStateError");
  };
  const view = await dom.render(
    React.createElement(DesktopSurface, {
      canvas: React.createRef(),
      width: 1000,
      height: 500,
      ready: true,
      connecting: false,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      touchScroll: true,
      touchAssist: false,
      send: async (action) => (sent.push(action), {}),
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget() {},
      resetKey: "k",
      initialCursor: null,
    }),
  );
  const stage = view.container.querySelector(".remote-stage");
  const canvas = stage.querySelector("canvas");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  canvas.width = 1000;
  canvas.height = 500;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });

  // Tap still succeeds even when setPointerCapture throws.
  stage.dispatchEvent(
    new dom.window.PointerEvent("pointerdown", {
      pointerId: 1,
      isPrimary: true,
      clientX: 400,
      clientY: 250,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      button: 0,
    }),
  );
  stage.dispatchEvent(
    new dom.window.PointerEvent("pointerup", {
      pointerId: 1,
      isPrimary: true,
      clientX: 400,
      clientY: 250,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      button: 0,
    }),
  );
  await settle(10);
  assert.equal(sent.filter((a) => a.type === "click").length, 1);

  // Wheel events at the same cursor position don't spam redundant move actions.
  sent.length = 0;
  stage.dispatchEvent(
    new dom.window.WheelEvent("wheel", {
      clientX: 300,
      clientY: 200,
      deltaY: 40,
      bubbles: true,
      cancelable: true,
    }),
  );
  stage.dispatchEvent(
    new dom.window.WheelEvent("wheel", {
      clientX: 300,
      clientY: 200,
      deltaY: 40,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle(10);
  assert.equal(sent.filter((a) => a.type === "move").length, 1);
  assert.equal(sent.filter((a) => a.type === "scroll").length, 2);

  await view.unmount();
});
