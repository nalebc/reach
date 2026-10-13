import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom,
  React,
  DesktopSurface,
  now = 1000,
  sequence = 0,
  savedNow;
const frames = new Map(),
  mounted = new Set();
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
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
  savedNow = Object.getOwnPropertyDescriptor(performance, "now");
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  globalThis.requestAnimationFrame = (callback) => (
    frames.set(++sequence, callback),
    sequence
  );
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
});
afterEach(async () => {
  for (const view of mounted) await view.unmount();
  mounted.clear();
  assert.equal(frames.size, 0, "unmount cancels all scrolling frames");
  assert.deepEqual(dom.errors, []);
});
after(async () => {
  if (savedNow) Object.defineProperty(performance, "now", savedNow);
  else delete performance.now;
  await dom.close();
});

async function surface(props = {}) {
  const sent = [],
    said = [];
  let update;
  const base = {
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
    touchAssist: true,
    send: async (action) => (sent.push(action), {}),
    onDragEnd() {},
    onFeedback: (line) => said.push(line),
    onInteraction() {},
    onTextTarget() {},
    resetKey: "k",
    initialCursor: null,
  };
  function Subject() {
    const [state, setState] = React.useState(props);
    update = (change) =>
      dom.update(() => setState((previous) => ({ ...previous, ...change })));
    return React.createElement(DesktopSurface, { ...base, ...state });
  }
  const view = await dom.render(React.createElement(Subject));
  mounted.add(view);
  const stage = view.container.querySelector(".remote-stage"),
    canvas = stage.querySelector("canvas");
  stage.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
  });
  canvas.width = 1000;
  canvas.height = 500;
  canvas.getBoundingClientRect = () => ({
    left: parseFloat(canvas.style.left),
    top: parseFloat(canvas.style.top),
    width: parseFloat(canvas.style.width),
    height: parseFloat(canvas.style.height),
  });
  return {
    view,
    stage,
    canvas,
    sent,
    said,
    update,
    scrolls: () => sent.filter((a) => a.type === "scroll"),
    cue: () => view.container.querySelector(".screen-gesture-feedback"),
  };
}
const pointer = (s, type, x, y, pointerId = 1) =>
  dom.update(() =>
    s.stage.dispatchEvent(
      new dom.window.PointerEvent(type, {
        pointerId,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
function frame(elapsed = 16) {
  now += elapsed;
  for (const id of [...frames.keys()]) {
    const callback = frames.get(id);
    if (!callback) continue;
    frames.delete(id);
    dom.update(() => callback(now));
  }
}
function swipe(s, { two = false, elapsed = 16, distance = 30 } = {}) {
  pointer(s, "pointerdown", two ? 400 : 500, 400);
  if (two) pointer(s, "pointerdown", 600, 400, 2);
  for (let i = 1; i <= 6; i++) {
    now += elapsed;
    pointer(s, "pointermove", two ? 400 : 500, 400 - i * distance);
    if (two) pointer(s, "pointermove", 600, 400 - i * distance, 2);
    frame(0);
  }
  pointer(s, "pointerup", two ? 400 : 500, 400 - 6 * distance);
  if (two) pointer(s, "pointerup", 600, 400 - 6 * distance, 2);
}

test("faster finger swipes travel farther, coast after lift, then stop without a click", async () => {
  const slow = await surface();
  swipe(slow, { elapsed: 100, distance: 20 });
  const slowTravel = -slow.scrolls().reduce((sum, a) => sum + a.dy, 0);
  assert.equal(slowTravel, 120, "slow scrolling remains one-to-one");
  const fast = await surface();
  swipe(fast, { elapsed: 16, distance: 20 });
  const fastTravel = -fast.scrolls().reduce((sum, a) => sum + a.dy, 0);
  assert.ok(fastTravel > slowTravel * 1.5);
  assert.ok(fast.cue().classList.contains("coast"));
  const lifted = fast.scrolls().length;
  for (let i = 0; i < 5; i++) frame();
  assert.ok(fast.scrolls().length > lifted, "the flick continues after lift");
  for (let i = 0; i < 100; i++) frame();
  assert.equal(fast.cue(), null);
  const stopped = fast.sent.length;
  for (let i = 0; i < 10; i++) frame();
  assert.equal(fast.sent.length, stopped);
  assert.equal(
    fast.sent.some((a) => ["click", "down", "up"].includes(a.type)),
    false,
  );
  assert.equal(fast.sent.filter((a) => a.type === "move").length, 1);
  assert.ok(
    fast
      .scrolls()
      .every(
        (a) =>
          Number.isInteger(a.dx) &&
          Number.isInteger(a.dy) &&
          Math.abs(a.dx) <= 120 &&
          Math.abs(a.dy) <= 120,
      ),
  );
});

test("touching stops a fling without clicking; the next deliberate tap remains accurate", async () => {
  const s = await surface();
  swipe(s);
  for (let i = 0; i < 3; i++) frame();
  pointer(s, "pointerdown", 300, 200);
  const stopped = s.sent.length;
  for (let i = 0; i < 5; i++) frame();
  pointer(s, "pointerup", 300, 200);
  assert.equal(s.sent.length, stopped);
  assert.equal(s.cue(), null);
  pointer(s, "pointerdown", 700, 100);
  pointer(s, "pointerup", 704, 103);
  await settle(5);
  assert.deepEqual(s.sent.at(-1), {
    type: "click",
    x: 0.7,
    y: 0.2,
    button: "left",
    count: 1,
    touch: { x: 0.01, y: 0.02 },
  });
});

test("a new swipe during momentum can reverse direction without inheriting the old flick", async () => {
  const s = await surface();
  swipe(s);
  frame();
  frame();
  pointer(s, "pointerdown", 500, 200);
  const restarted = s.scrolls().length;
  for (let i = 1; i <= 5; i++) {
    now += 16;
    pointer(s, "pointermove", 500, 200 + 30 * i);
    frame(0);
  }
  pointer(s, "pointerup", 500, 350);
  frame();
  frame();
  frame();
  assert.ok(
    s
      .scrolls()
      .slice(restarted)
      .every((a) => a.dy > 0),
  );
  assert.equal(
    s.sent.some((a) => a.type === "click"),
    false,
  );
});

test("horizontal flicks show their direction and fast icon, with motion continuing after lift", async () => {
  const s = await surface();
  pointer(s, "pointerdown", 200, 200);
  for (let i = 1; i <= 6; i++) {
    now += 16;
    pointer(s, "pointermove", 200 + 30 * i, 200);
    frame(0);
  }
  await settle(5); // React commits continuous pointer feedback between frames.
  assert.ok(s.cue(), "a fast horizontal swipe shows its feedback");
  assert.ok(s.cue().classList.contains("fast"));
  assert.equal(
    s.cue().querySelector(".screen-gesture-marker svg").style.transform,
    "rotate(90deg)",
  );
  pointer(s, "pointerup", 380, 200);
  assert.equal(
    s.cue().querySelector(".screen-gesture-marker svg").style.transform,
    "rotate(90deg)",
  );
  frame();
  frame();
  frame();
  assert.ok(s.scrolls().length > 6);
  assert.ok(s.scrolls().every((a) => a.dx > 0 && a.dy === 0));
});

test("scrolling includes the final pointer-up motion for one or two fingers", async () => {
  for (const two of [false, true]) {
    const s = await surface();
    pointer(s, "pointerdown", two ? 400 : 500, 400);
    if (two) pointer(s, "pointerdown", 600, 400, 2);
    now += 32;
    pointer(s, "pointermove", two ? 400 : 500, 350);
    if (two) pointer(s, "pointermove", 600, 350, 2);
    frame(0);
    const before = -s.scrolls().reduce((sum, a) => sum + a.dy, 0);
    now += 32;
    pointer(s, "pointerup", two ? 400 : 500, 300);
    if (two) pointer(s, "pointerup", 600, 300, 2);
    const after = -s.scrolls().reduce((sum, a) => sum + a.dy, 0);
    assert.ok(
      after > before + 50,
      "the last fifty pixels also receive acceleration",
    );
    assert.ok(s.cue()?.classList.contains("coast"));
  }
});

test("a deliberate long press after stopping a flick can still drag", async () => {
  const s = await surface();
  swipe(s);
  frame();
  frame();
  pointer(s, "pointerdown", 300, 200);
  await settle(450);
  assert.deepEqual(s.sent.at(-1), {
    type: "down",
    x: 0.3,
    y: 0.4,
    button: "left",
  });
  assert.ok(s.cue()?.classList.contains("held"));
  pointer(s, "pointermove", 600, 200);
  pointer(s, "pointerup", 600, 200);
  assert.deepEqual(s.sent.at(-1), {
    type: "up",
    x: 0.6,
    y: 0.4,
    button: "left",
  });
  assert.equal(
    s.sent.some((a) => a.type === "click"),
    false,
  );
});

test("two-finger flicks accelerate and coast in every touch mode and while zoomed", async () => {
  for (const mode of ["direct", "trackpad", "pan"]) {
    const s = await surface({ mode });
    dom.update(() =>
      s.view.container.querySelector('[aria-label="Zoom in"]').click(),
    );
    const before = [s.canvas.style.left, s.canvas.style.top];
    swipe(s, { two: true });
    assert.ok(s.cue()?.classList.contains("coast"));
    const lifted = s.scrolls().length;
    frame();
    frame();
    frame();
    assert.ok(s.scrolls().length > lifted);
    assert.deepEqual([s.canvas.style.left, s.canvas.style.top], before);
    assert.equal(
      s.sent.some((a) => a.type === "click" || a.type === "down"),
      false,
    );
  }
});

test("cancel, lost control, paused video, backgrounding and unmount all stop scrolling", async () => {
  for (const reason of [
    "cancel",
    "control",
    "paused",
    "resize",
    "blur",
    "hidden",
    "unmount",
  ]) {
    const s = await surface();
    swipe(s);
    frame();
    frame();
    if (reason === "cancel") {
      pointer(s, "pointerdown", 500, 200);
      pointer(s, "pointermove", 500, 150);
      frame();
      pointer(s, "pointercancel", 500, 150);
    } else if (reason === "control") s.update({ canControl: false });
    else if (reason === "paused") s.update({ stale: true });
    else if (reason === "resize") s.update({ width: 1600, height: 900 });
    else if (reason === "blur")
      dom.update(() => dom.window.dispatchEvent(new dom.window.Event("blur")));
    else if (reason === "hidden") {
      Object.defineProperty(dom.window.document, "hidden", {
        configurable: true,
        value: true,
      });
      dom.update(() =>
        dom.window.document.dispatchEvent(
          new dom.window.Event("visibilitychange"),
        ),
      );
      delete dom.window.document.hidden;
    } else {
      await s.view.unmount();
      mounted.delete(s.view);
    }
    await settle(5); // Let a prop-driven effect commit its feedback update.
    const stopped = s.sent.length;
    for (let i = 0; i < 30; i++) frame();
    assert.equal(s.sent.length, stopped, reason);
    assert.equal(s.cue(), null, reason);
  }
});

test("one-finger panning while zoomed and pinch zoom never launch remote momentum", async () => {
  const s = await surface();
  dom.update(() =>
    s.view.container.querySelector('[aria-label="Zoom in"]').click(),
  );
  swipe(s);
  for (let i = 0; i < 10; i++) frame();
  assert.deepEqual(s.sent, []);
  pointer(s, "pointerdown", 400, 250);
  pointer(s, "pointerdown", 600, 250, 2);
  pointer(s, "pointermove", 200, 250);
  pointer(s, "pointermove", 800, 250, 2);
  pointer(s, "pointerup", 200, 250);
  pointer(s, "pointerup", 800, 250, 2);
  for (let i = 0; i < 10; i++) frame();
  assert.deepEqual(s.sent, []);
});

test("a stalled animation or a refused scroll cannot keep coasting", async () => {
  const s = await surface();
  swipe(s);
  frame(500);
  assert.equal(s.cue(), null);
  const stopped = s.sent.length;
  frame();
  frame();
  assert.equal(s.sent.length, stopped);
  s.update({
    send: async (a) => {
      if (a.type === "scroll") throw Error("Control disconnected");
      return {};
    },
  });
  swipe(s);
  await settle(5);
  assert.equal(s.cue(), null);
  assert.match(s.said.at(-1), /Control disconnected/);
  assert.equal(frames.size, 0);
});
