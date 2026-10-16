import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, Surface, active;
before(async () => {
  dom = await startDom({ mobile: true });
  dom.window.HTMLElement.prototype.setPointerCapture = function () {};
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
  ({ default: Surface } = await dom.load("/src/DesktopSurface.tsx"));
});
afterEach(async () => {
  await active?.view.unmount();
  active = null;
  assert.deepEqual(dom.errors, []);
});
after(() => dom.close());
async function surface(props = {}) {
  const sent = [],
    targets = [];
  const view = await dom.render(
    dom.React.createElement(Surface, {
      canvas: dom.React.createRef(),
      width: 1000,
      height: 500,
      ready: true,
      connecting: false,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      doubleClick: true,
      touchScroll: true,
      touchAssist: true,
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget: (point) => targets.push(point),
      resetKey: "k",
      initialCursor: null,
      send: async (a) => (sent.push(a), { clickState: a.clickState }),
      ...props,
    }),
  );
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
  return (active = {
    view,
    stage,
    canvas,
    sent,
    targets,
    clicks: () => sent.filter((a) => a.type === "click"),
  });
}
function pointer(
  s,
  type,
  x = 300,
  y = 200,
  pointerType = "touch",
  pointerId = 1,
) {
  s.stage.dispatchEvent(
    new dom.window.PointerEvent(type, {
      pointerType,
      pointerId,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}
async function tap(s, x = 300, y = 200, pointerType = "touch") {
  pointer(s, "pointerdown", x, y, pointerType);
  pointer(s, "pointerup", x, y, pointerType);
  s.stage.dispatchEvent(
    new dom.window.MouseEvent("click", {
      clientX: x,
      clientY: y,
      bubbles: true,
    }),
  );
  await settle(10);
}
test("middle and extra mouse buttons never send a left click or start a drag", async () => {
  const s = await surface();
  for (const button of [1, 3, 4]) {
    for (const type of ["pointerdown", "pointerup"]) {
      s.stage.dispatchEvent(new dom.window.PointerEvent(type, {
        pointerType: "mouse", pointerId: 1, button,
        clientX: 300, clientY: 200, bubbles: true, cancelable: true,
      }));
    }
  }
  await settle(10);
  assert.deepEqual(s.sent, [], "unsupported buttons must not become primary clicks");
  await tap(s, 300, 200, "mouse");
  assert.equal(s.clicks().length, 1, "the next primary click still works");
  assert.equal(s.clicks()[0].clickState, 1);
});
for (const pointerType of ["touch", "mouse", "pen"]) {
  test(`${pointerType}: rapid clicks send one press per tap and show double-click feedback`, async () => {
    const s = await surface();
    await tap(s, 300, 200, pointerType);
    assert.equal(s.clicks().length, 1, "the first tap is sent immediately");
    await tap(s, 302, 201, pointerType);
    const [first, second] = s.clicks();
    assert.deepEqual(
      s.clicks().map((a) => [a.count, a.clickState]),
      [
        [1, 1],
        [1, 2],
      ],
    );
    assert.equal(first.clickId, second.clickId);
    assert.equal(second.x, 0.302);
    assert.equal(second.y, 0.402);
    assert.deepEqual(second.touch, pointerType === "touch" ? { x: 0.01, y: 0.02 } : undefined,
      "each finger tap gets live hit assistance at its own location");
    assert.ok(s.view.container.querySelector(".screen-wave.double"));
    await tap(s, 300, 200, pointerType);
    assert.equal(
      s.clicks()[2].clickState,
      1,
      "a third tap starts a fresh pair",
    );
  });
}
test("nearby finger taps pair at Fit and while zoomed, with the same accurate coordinate mapping", async () => {
  const s = await surface();
  s.view.container.querySelector('[aria-label="Zoom in"]').click();
  await settle(15);
  await tap(s);
  await tap(s, 305, 202);
  assert.deepEqual(
    s.clicks().map((a) => a.clickState),
    [1, 2],
  );
  assert.equal(s.clicks()[0].x, 0.34);
  assert.equal(s.clicks()[1].x, 0.344);
});
test("distant taps and the explicit double/right modes do not form an extra double-click", async () => {
  const s = await surface();
  await tap(s);
  await tap(s, 350, 200);
  assert.deepEqual(
    s.clicks().map((a) => a.clickState),
    [1, 1],
  );
  await s.view.unmount();
  active = null;
  for (const clickMode of ["double", "right"]) {
    const exact = await surface({ clickMode });
    await tap(exact);
    await tap(exact);
    assert.deepEqual(
      exact.clicks().map((a) => a.count),
      clickMode === "double" ? [2, 2] : [1, 1],
    );
    assert.ok(exact.clicks().every((a) => a.clickId === undefined));
    await exact.view.unmount();
    active = null;
  }
});
test("rapid taps on nearby controls stay at their own locations and do not preserve the previous input", async () => {
  const repeats = [];
  const s = await surface({ onInteraction: (repeat) => repeats.push(repeat) });
  await tap(s, 300, 200);
  await tap(s, 312, 200);
  assert.deepEqual(s.clicks().map((a) => [a.x, a.y, a.clickState]),
    [[0.3, 0.4, 1], [0.312, 0.4, 1]]);
  assert.deepEqual(repeats, [false, false]);
});
test("image movement maps the next tap to the visible target instead of the previous location", async () => {
  const s = await surface();
  await tap(s, 300, 200);
  s.canvas.getBoundingClientRect = () => ({ left: 0, top: 150, width: 1000, height: 500 });
  await tap(s, 300, 200);
  assert.deepEqual(s.clicks().map((a) => [a.x, a.y, a.clickState]),
    [[0.3, 0.4, 1], [0.3, 0.1, 1]]);
});
test("touch double-taps keep both touchdown points through phone/tablet aspect ratios, letterboxing and Retina frames", async () => {
  for (const [width, height] of [[390, 844], [844, 390], [768, 1024], [1280, 720]]) {
    const s = await surface();
    s.canvas.width = 3200; s.canvas.height = 1800;
    const left = 20, top = 30;
    s.canvas.getBoundingClientRect = () => ({ left, top, width, height });
    const scale = Math.min(width / 3200, height / 1800),
      imageW = 3200 * scale, imageH = 1800 * scale,
      imageLeft = left + (width - imageW) / 2, imageTop = top + (height - imageH) / 2,
      x = imageLeft + imageW * 0.17, y = imageTop + imageH * 0.79;
    // A small lift drift does not change where each separate finger landed.
    for (const dx of [0, 4]) {
      pointer(s, "pointerdown", x + dx, y);
      pointer(s, "pointerup", x + dx + 3, y + 2);
      await settle(10);
    }
    const [first, second] = s.clicks();
    assert.deepEqual(s.clicks().map((a) => a.clickState), [1, 2]);
    assert.ok(Math.abs(first.x - 0.17) < 1e-8 && Math.abs(first.y - 0.79) < 1e-8);
    assert.ok(Math.abs(second.x - (0.17 + 4 / imageW)) < 1e-8 && Math.abs(second.y - 0.79) < 1e-8);
    assert.deepEqual(second.touch, { x: 10 / imageW, y: 10 / imageH });
    await s.view.unmount(); active = null;
  }
});
test("cancel, a swipe, a held drag, wheel scrolling and an outside-image tap break the pair", async () => {
  for (const kind of ["cancel", "swipe", "hold", "wheel", "outside", "two"]) {
    const s = await surface();
    await tap(s);
    if (kind === "wheel")
      s.stage.dispatchEvent(
        new dom.window.WheelEvent("wheel", {
          clientX: 300,
          clientY: 200,
          deltaY: 30,
          bubbles: true,
          cancelable: true,
        }),
      );
    else if (kind === "outside") await tap(s, -10, 200);
    else {
      pointer(s, "pointerdown");
      if (kind === "cancel") pointer(s, "pointercancel");
      else if (kind === "two") {
        pointer(s, "pointerdown", 400, 200, "touch", 2);
        pointer(s, "pointerup", 400, 200, "touch", 2);
        pointer(s, "pointerup");
      } else {
        if (kind === "hold") await settle(420);
        else {
          pointer(s, "pointermove", 300, 240);
          await settle(90);
        }
        pointer(s, "pointerup", 300, kind === "hold" ? 200 : 240);
      }
    }
    await settle(10);
    await tap(s);
    assert.equal(s.clicks().at(-1).clickState, 1, kind);
    assert.notEqual(s.clicks().at(-1).clickId, s.clicks()[0].clickId, kind);
    await s.view.unmount();
    active = null;
  }
});
test("a second tap does not wait for the first network acknowledgement, and focus follows the actual double-click point", async () => {
  let acknowledge;
  const sent = [];
  const s = await surface({
    send: async (a) => {
      sent.push(a);
      return a.clickState === 1
        ? new Promise((resolve) => {
            acknowledge = resolve;
          })
        : { point: { x: 0.31, y: 0.41 }, clickState: 2 };
    },
  });
  await tap(s);
  await tap(s, 305, 202);
  assert.deepEqual(
    sent.map((a) => a.clickState),
    [1, 2],
  );
  assert.deepEqual(s.targets, [{ x: 0.31, y: 0.41 }]);
  assert.equal(
    s.view.container.querySelector(".screen-wave.double").style.left,
    "310px",
  );
  acknowledge({ point: { x: 0.31, y: 0.41 }, clickState: 1 });
  await settle(20);
  assert.equal(s.targets.length, 1, "an older click cannot reopen typing");
});
test("older hosts keep ordinary clicks until they advertise second-click support", async () => {
  const s = await surface({ doubleClick: false });
  await tap(s);
  await tap(s);
  assert.ok(s.clicks().every((a) => a.count === 1 && a.clickId === undefined));
});
test("a new letterbox after keyboard resize cannot send a click to the previous target", async () => {
  const sent = [];
  const s = await surface({
    send: async (a) => (
      sent.push(a),
      {
        point: { x: 0.3, y: 0.4 },
        clickState: a.clickState,
        retargeted: a.clickState === 2,
      }
    ),
  });
  await tap(s);
  s.canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 250,
    width: 1000,
    height: 500,
  });
  await tap(s);
  assert.deepEqual(
    sent.map((a) => [a.count, a.clickState]),
    [[1, 1]],
  );
  assert.deepEqual(s.targets.at(-1), { x: 0.3, y: 0.4 });
  await tap(s, 300, 450);
  assert.equal(sent.at(-1).clickState, 1, "a margin tap breaks the old pair");
});
