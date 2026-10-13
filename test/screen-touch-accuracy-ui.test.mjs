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
  const sent = [], targets = [], said = [];
  const view = await dom.render(React.createElement(DesktopSurface, {
    canvas: React.createRef(), width: 1000, height: 500, ready: true, connecting: false,
    canControl: true, mode: "direct", drag: false, clickMode: "left", touchScroll: true, touchAssist: true,
    send: async (action) => (sent.push(action), {}), onDragEnd() {}, onFeedback: (message) => said.push(message), onInteraction() {},
    onTextTarget: (point) => targets.push(point), resetKey: "k", initialCursor: null, ...props,
  }));
  const stage = view.container.querySelector(".remote-stage"), canvas = stage.querySelector("canvas");
  stage.getBoundingClientRect = () => ({ left: 20, top: 30, width: 1000, height: 500 });
  canvas.width = 1000; canvas.height = 500;
  canvas.getBoundingClientRect = () => ({ left: stage.getBoundingClientRect().left + parseFloat(canvas.style.left),
    top: stage.getBoundingClientRect().top + parseFloat(canvas.style.top),
    width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) });
  return { view, stage, canvas, sent, targets, said, clicks: () => sent.filter((a) => a.type === "click") };
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

test("a finger tap and its tolerance share the actual rendered image size, including browser scaling", async () => {
  for (const scale of [0.6, 1.4]) {
    const s = await surface();
    // The browser's measured size can differ from the requested CSS size.
    s.canvas.width = 2000; s.canvas.height = 1000;
    s.canvas.getBoundingClientRect = () => ({ left: 20, top: 30, width: 1000 * scale, height: 500 * scale });
    await tap(s, 300 * scale, 200 * scale, { dx: 5, dy: 3 });
    assert.deepEqual(s.clicks()[0], {
      type: "click", x: 0.3, y: 0.4, button: "left", count: 1,
      touch: { x: 10 / (1000 * scale), y: 10 / (500 * scale) },
    });
    await s.view.unmount();
  }
});
test("a frame aspect change preserves its visible pixels, hit coordinates and click feedback through layout catch-up", async () => {
  const s = await surface();
  s.canvas.width = 1000; s.canvas.height = 1000;
  assert.equal(s.canvas.style.objectFit, "contain", "the canvas must render the same containment used by hit testing");
  await tap(s, 400, 200);
  assert.deepEqual(s.clicks()[0], {
    type: "click", x: 0.3, y: 0.4, button: "left", count: 1, touch: { x: 0.02, y: 0.02 },
  });
  const mark = s.view.container.querySelector(".screen-wave.click");
  assert.equal(mark.style.left, "400px");
  assert.equal(mark.style.top, "200px");
  await tap(s, 240, 200);
  assert.equal(s.clicks().length, 1, "the newly visible canvas letterbox is not a target");
  await s.view.unmount();
});

test("a layout shift while a finger rests keeps the original target and does not become a swipe", async () => {
  const s = await surface();
  finger(s, "pointerdown", 300, 200);
  s.stage.getBoundingClientRect = () => ({ left: 70, top: 110, width: 1000, height: 500 });
  // Client coordinates stay still; only the page moved under the finger.
  finger(s, "pointermove", 300, 200);
  finger(s, "pointerup", 300, 200);
  await settle(10);
  assert.deepEqual(s.sent, [{ type: "click", x: 0.3, y: 0.4, button: "left", count: 1, touch: { x: 0.01, y: 0.02 } }]);
  assert.equal(s.canvas.style.left, "0px", "no accidental view pan");
  assert.equal(s.canvas.style.top, "0px");
  await s.view.unmount();
});

test("only a captured finger can finish or cancel its tap or hold", async () => {
  const s = await surface();
  finger(s, "pointerdown", 300, 200);
  finger(s, "pointerup", 800, 400, "touch", 2);
  finger(s, "pointercancel", 800, 400, "touch", 2);
  await settle(10);
  assert.deepEqual(s.sent, [], "an unrelated pointer does not create a tap");
  finger(s, "pointerup", 300, 200);
  await settle(10);
  assert.equal(s.clicks().length, 1);
  assert.equal(s.clicks()[0].x, 0.3);
  s.sent.length = 0;
  finger(s, "pointerdown", 300, 200);
  await settle(450);
  finger(s, "pointerup", 800, 400, "touch", 2);
  finger(s, "pointercancel", 800, 400, "touch", 2);
  await settle(10);
  assert.deepEqual(s.sent.map((a) => a.type), ["down"], "the active hold remains pressed");
  finger(s, "pointerup", 300, 200);
  await settle(10);
  assert.deepEqual(s.sent.map((a) => a.type), ["down", "up"]);
  await s.view.unmount();
});

test("a tap after scrolling, panning or dragging gets a fresh target without a ghost click", async () => {
  for (const kind of ["scroll", "pan", "drag"]) {
    const s = await surface();
    if (kind === "pan") await zoom(s);
    finger(s, "pointerdown", 300, 200);
    if (kind === "drag") await settle(450);
    finger(s, "pointermove", 400, 200);
    if (kind === "scroll") await settle(100); // A rested scroll ends without a fling.
    finger(s, "pointerup", 400, 200);
    await settle(10);
    assert.equal(s.clicks().length, 0);
    const box = s.canvas.getBoundingClientRect();
    await tap(s, box.left - 20 + box.width * 0.7, box.top - 30 + box.height * 0.2, { dx: 4, dy: 3 });
    assert.equal(s.clicks().length, 1);
    assert.ok(Math.abs(s.clicks()[0].x - 0.7) < 1e-8);
    assert.ok(Math.abs(s.clicks()[0].y - 0.2) < 1e-8);
    assert.deepEqual(s.clicks()[0].touch, { x: 10 / box.width, y: 10 / box.height });
    await s.view.unmount();
  }
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

test("a quick swipe pans the zoomed view; all corners move clear of overlays", async () => {
  const s = await surface();
  await zoom(s);
  const before = s.canvas.style.left;
  finger(s, "pointerdown", 500, 250);
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

test("a long press grabs and drags at Fit and while zoomed, without a click or scroll", async () => {
  for (const zoomed of [false, true]) {
    const s = await surface();
    if (zoomed) await zoom(s);
    const before = [s.canvas.style.left, s.canvas.style.top];
    finger(s, "pointerdown", 300, 200);
    // Finger jitter within tap tolerance doesn't turn a hold into a swipe.
    finger(s, "pointermove", 305, 203);
    await settle(450);
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].type, "down");
    assert.ok(Math.abs(s.sent[0].x - (zoomed ? 0.34 : 0.3)) < 1e-8);
    assert.ok(Math.abs(s.sent[0].y - (zoomed ? 0.42 : 0.4)) < 1e-8);
    finger(s, "pointermove", 600, 250);
    finger(s, "pointerup", 600, 250);
    await settle(10);
    assert.deepEqual(s.sent.map((a) => a.type), ["down", "move", "up"]);
    assert.deepEqual([s.canvas.style.left, s.canvas.style.top], before);
    assert.equal(s.sent[0].touch, undefined, "drag starts keep their exact landing point");
    assert.equal(s.view.container.querySelector(".screen-wave"), null);
    assert.match(s.stage.getAttribute("aria-label"), /Long press to drag/);
    await s.view.unmount();
  }
});

test("a drag drops at pointer-up's actual destination even when its last motion wasn't delivered", async () => {
  const s = await surface();
  await zoom(s);
  finger(s, "pointerdown", 300, 200);
  await settle(450);
  finger(s, "pointermove", 600, 250);
  finger(s, "pointerup", 1000, 0);
  await settle(10);
  assert.deepEqual(s.sent.map((a) => a.type), ["down", "move", "move", "up"]);
  assert.deepEqual(s.sent.at(-1), { type: "up", x: 0.9, y: 0.1, button: "left" });
  assert.deepEqual(s.sent.at(-2), { type: "move", x: 0.9, y: 0.1 });
  await s.view.unmount();
});

test("dragging at a zoomed viewport edge reveals the full desktop without releasing the item", async () => {
  const s = await surface();
  await zoom(s);
  finger(s, "pointerdown", 300, 200);
  await settle(450);
  finger(s, "pointermove", 999, 1);
  await settle(750);
  assert.equal(s.sent.filter((a) => a.type === "down").length, 1);
  assert.equal(s.sent.some((a) => ["scroll", "click", "up", "release"].includes(a.type)), false);
  assert.ok(s.sent.filter((a) => a.type === "move").length > 2);
  assert.deepEqual(s.sent.at(-1), { type: "move", x: 1, y: 0 });
  finger(s, "pointerup", 999, 1);
  await settle(10);
  assert.deepEqual(s.sent.at(-1), { type: "up", x: 1, y: 0, button: "left" });
  const sent = s.sent.length;
  await settle(80);
  assert.equal(s.sent.length, sent, "edge panning stops on release");
  await s.view.unmount();
});

test("a canceled drag releases the mouse and stops edge panning", async () => {
  const s = await surface();
  await zoom(s);
  finger(s, "pointerdown", 300, 200);
  await settle(450);
  finger(s, "pointermove", 999, 250);
  await settle(40);
  finger(s, "pointercancel", 999, 250);
  await settle(10);
  assert.equal(s.sent.at(-1).type, "release");
  const count = s.sent.length;
  await settle(80);
  assert.equal(s.sent.length, count);
  await s.view.unmount();
});

test("unmounting while an item is held releases the mouse", async () => {
  const s = await surface();
  finger(s, "pointerdown", 300, 200);
  await settle(450);
  await s.view.unmount();
  assert.deepEqual(s.sent.map((a) => a.type), ["down", "release"]);
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

const gestureCue = (s) => s.view.container.querySelector(".screen-gesture-feedback");

test("a quick tap has no hold feedback; a hold fills a ring then shows Held and Dragging until release", async () => {
  const s = await surface();
  await tap(s, 300, 200);
  await settle(130);
  assert.equal(gestureCue(s), null);
  s.sent.length = 0;
  finger(s, "pointerdown", 300, 200);
  await settle(140);
  assert.ok(gestureCue(s)?.classList.contains("hold"));
  assert.ok(gestureCue(s).querySelector(".screen-hold-progress .progress"));
  assert.match(gestureCue(s).textContent, /Keep holding/);
  assert.deepEqual(s.sent, [], "show progress before sending mouse-down");
  await settle(310);
  assert.ok(gestureCue(s)?.classList.contains("held"));
  assert.match(gestureCue(s).textContent, /Held.*Drag to move/);
  assert.equal(gestureCue(s).querySelector('[role="status"]').textContent, "Held. Drag to move");
  finger(s, "pointermove", 500, 250);
  await settle(10);
  assert.ok(gestureCue(s)?.classList.contains("drag"));
  assert.match(gestureCue(s).textContent, /Dragging.*Lift to drop/);
  finger(s, "pointerup", 500, 250);
  await settle(10);
  assert.equal(gestureCue(s), null);
  assert.deepEqual(s.sent.map((a) => a.type), ["down", "move", "up"]);
  await s.view.unmount();
});

test("Held appears only after the computer acknowledges; lifting prevents a late Held cue", async () => {
  let done;
  const sent = [];
  const s = await surface({ send: (action) => {
    sent.push(action);
    return action.type === "down" ? new Promise((resolve) => { done = resolve; }) : Promise.resolve({});
  } });
  finger(s, "pointerdown", 300, 200);
  await settle(450);
  assert.ok(gestureCue(s)?.classList.contains("grabbing"));
  assert.doesNotMatch(gestureCue(s).textContent, /Held/);
  finger(s, "pointerup", 300, 200);
  done({});
  await settle(10);
  assert.equal(gestureCue(s), null);
  assert.deepEqual(sent.map((a) => a.type), ["down", "up"]);
  await s.view.unmount();
});

test("a refused hold clears its cue, releases the mouse and says why", async () => {
  const s = await surface({ send: async (action) => {
    if (action.type === "down") throw Error("The computer refused the press.");
    return {};
  } });
  finger(s, "pointerdown", 300, 200);
  await settle(450);
  assert.equal(gestureCue(s), null);
  assert.match(s.said.at(-1), /Hold not sent.*computer refused/);
  finger(s, "pointerup", 300, 200);
  await settle(10);
  assert.equal(s.clicks().length, 0);
  await s.view.unmount();
});

test("one-finger scrolling cancels hold progress and shows a direction, then clears on lift", async () => {
  const s = await surface();
  finger(s, "pointerdown", 300, 200);
  await settle(140);
  assert.ok(gestureCue(s)?.classList.contains("hold"));
  finger(s, "pointermove", 400, 200);
  await settle(10);
  assert.ok(gestureCue(s)?.classList.contains("scroll"));
  assert.match(gestureCue(s).textContent, /Scrolling.*Lift to coast/);
  assert.equal(gestureCue(s).querySelector(".screen-gesture-marker svg").style.transform, "rotate(90deg)");
  await settle(300);
  assert.equal(s.sent.some((a) => a.type === "down"), false, "a scroll never becomes a hold");
  assert.ok(s.sent.some((a) => a.type === "scroll" && a.dx > 0));
  finger(s, "pointerup", 400, 200);
  await settle(10);
  assert.equal(gestureCue(s), null);
  await s.view.unmount();
});

test("two fingers offer scrolling and show feedback in every mode, including zoomed control", async () => {
  for (const mode of ["direct", "trackpad", "pan"]) {
    const s = await surface({ mode });
    await zoom(s);
    finger(s, "pointerdown", 400, 250);
    finger(s, "pointerdown", 600, 250, "touch", 2);
    await settle(10);
    assert.ok(gestureCue(s)?.classList.contains("two"));
    assert.match(gestureCue(s).textContent, /Move two fingers together to scroll/);
    await settle(450);
    assert.equal(s.sent.some((a) => a.type === "down"), false);
    finger(s, "pointermove", 400, 240);
    finger(s, "pointermove", 600, 240, "touch", 2);
    await settle(20);
    assert.ok(gestureCue(s)?.classList.contains("scroll"));
    assert.ok(s.sent.some((a) => a.type === "scroll" && a.dy < 0));
    finger(s, "pointerup", 400, 240);
    finger(s, "pointerup", 600, 240, "touch", 2);
    await settle(10);
    assert.equal(gestureCue(s), null);
    await s.view.unmount();
  }
});

test("panning a zoomed view offers two-finger scrolling, and a wheel briefly shows scroll feedback", async () => {
  const s = await surface();
  await zoom(s);
  finger(s, "pointerdown", 300, 200);
  finger(s, "pointermove", 400, 200);
  await settle(10);
  assert.ok(gestureCue(s)?.classList.contains("pan"));
  assert.match(gestureCue(s).textContent, /Moving view.*Two fingers to scroll/);
  finger(s, "pointerup", 400, 200);
  s.stage.dispatchEvent(new dom.window.WheelEvent("wheel", {
    clientX: 320, clientY: 230, deltaY: 40, bubbles: true, cancelable: true,
  }));
  await settle(10);
  assert.ok(gestureCue(s)?.classList.contains("scroll"));
  await settle(280);
  assert.equal(gestureCue(s), null);
  await s.view.unmount();
});

test("canceled holds and view-only touches have no lingering hold or scroll cues", async () => {
  const s = await surface();
  finger(s, "pointerdown", 300, 200);
  await settle(140);
  assert.ok(gestureCue(s));
  finger(s, "pointercancel", 300, 200);
  await settle(310);
  assert.equal(gestureCue(s), null);
  assert.equal(s.sent.length, 0);
  await s.view.unmount();
  const watching = await surface({ canControl: false });
  finger(watching, "pointerdown", 300, 200);
  await settle(450);
  assert.equal(gestureCue(watching), null);
  finger(watching, "pointerdown", 600, 200, "touch", 2);
  finger(watching, "pointermove", 300, 180);
  finger(watching, "pointermove", 600, 180, "touch", 2);
  await settle(10);
  assert.equal(gestureCue(watching), null);
  assert.equal(watching.sent.length, 0);
  await watching.view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("gesture icons stay visible above or beside the thumb, with accessible descriptions and no captions", async () => {
  const { default: Feedback } = await dom.load("/src/ScreenGestureFeedback.tsx");
  for (const [width, height] of [[390, 244], [844, 70], [844, 35]]) {
    for (const point of [{ x: -20, y: -20 }, { x: width + 20, y: height + 20 }, { x: width / 2, y: height / 2 }]) {
      const view = await dom.render(React.createElement(Feedback, { feedback: { kind: "held", point }, width, height }));
      const status = view.container.querySelector(".screen-gesture-status"),
        marker = view.container.querySelector(".screen-gesture-marker");
      const x = parseFloat(marker.style.left), y = parseFloat(marker.style.top), radius = parseFloat(marker.style.width) / 2;
      assert.ok(x - radius >= 4 && x + radius <= width - 4);
      assert.ok(y - radius >= 4 && y + radius <= height - 4);
      const finger = { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) };
      assert.ok(Math.hypot(x - finger.x, y - finger.y) >= 56, "not hidden beneath a thumb");
      assert.equal(marker.getAttribute("aria-hidden"), "true");
      assert.equal(status.getAttribute("role"), "status");
      assert.equal(status.textContent, "Held. Drag to move");
      assert.equal(view.container.querySelector(".screen-gesture-caption"), null);
      await view.unmount();
    }
  }
});

test("a browser context menu during a two-finger scroll cannot create a stray right click", async () => {
  const s = await surface();
  finger(s, "pointerdown", 400, 250);
  finger(s, "pointerdown", 600, 250, "touch", 2);
  s.stage.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
    clientX: 420, clientY: 280, bubbles: true, cancelable: true,
  }));
  await settle(10);
  assert.equal(s.clicks().length, 0);
  await s.view.unmount();
});

test("Mission Control's portrait letterbox maps the window grab and a drag into the top bar to the actual display", async () => {
  const observer = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback([{ contentRect: { width: 393, height: 644 } }]); }
    disconnect() {}
  };
  let s;
  try {
    // The photo has a wide Mac picture centered in a tall phone stage.
    s = await surface({ width: 1470, height: 956 });
    s.canvas.width = 1470; s.canvas.height = 956;
    const top = parseFloat(s.canvas.style.top), imageHeight = parseFloat(s.canvas.style.height);
    assert.ok(top > 150, "large black bars above and below the image");
    const x = 393 * 0.4, y = top + imageHeight * 0.6;
    finger(s, "pointerdown", x, y);
    await settle(450);
    assert.ok(gestureCue(s)?.classList.contains("held"));
    assert.ok(Math.abs(s.sent[0].x - 0.4) < 1e-8);
    assert.ok(Math.abs(s.sent[0].y - 0.6) < 1e-8);
    finger(s, "pointermove", x, top + imageHeight * 0.03);
    await settle(10);
    assert.ok(gestureCue(s)?.classList.contains("drag"));
    assert.ok(Math.abs(s.sent.at(-1).y - 0.03) < 1e-8);
    // Moving into the black bar still reaches the Mac's top screen edge.
    finger(s, "pointerup", x, top - 20);
    await settle(10);
    assert.equal(s.sent.at(-1).type, "up");
    assert.equal(s.sent.at(-1).y, 0);
    assert.ok(Math.abs(s.sent.at(-1).x - 0.4) < 1e-8);
    assert.equal(s.sent.some((a) => ["scroll", "click"].includes(a.type)), false);
  } finally {
    await s?.view.unmount();
    globalThis.ResizeObserver = observer;
  }
});
