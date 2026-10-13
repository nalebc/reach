import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// "Some clicks were not doing anything also, when control is disabled we
// should not have click feedback show. Can you redesign the click feedback
// i dont like that one. Make it like waves" (Oct 12). Every tap reaches the
// Mac or says why in one line; a wave shows only for a click the Mac did.
let dom, React, DesktopSurface, TAP_RETRY_MS;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  dom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.releasePointerCapture ??= function () {};
  dom.window.localStorage.setItem("reach.twoFingerScrollHint", "1");
  // jsdom has no layout: the stage is a 1000×500 box, as the picture.
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback([{ contentRect: { width: 1000, height: 500 } }]); }
    unobserve() {}
    disconnect() {}
  };
  ({ default: DesktopSurface, TAP_RETRY_MS } = await dom.load("/src/DesktopSurface.tsx"));
});
after(() => dom?.close());

async function surface(initial = {}) {
  const sent = [], said = [];
  let set, answer = async () => ({});
  function Host() {
    const [props, setProps] = React.useState(initial);
    set = setProps;
    return React.createElement(DesktopSurface, {
      canvas: React.createRef(), width: 1000, height: 500, ready: true, connecting: false, canControl: true,
      mode: "direct", drag: false, clickMode: "left", touchScroll: true,
      send: (action) => (sent.push(action), answer(action)),
      onDragEnd() {}, onFeedback: (text) => said.push(text), onInteraction() {}, onTextTarget() {},
      resetKey: "k", initialCursor: null, ...props,
    });
  }
  const view = await dom.render(React.createElement(Host));
  const box = { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 };
  view.container.querySelector("canvas").getBoundingClientRect = () => box;
  const stage = view.container.querySelector(".remote-stage");
  return {
    view, sent, said, stage,
    clicks: () => sent.filter((a) => a.type === "click"),
    waves: () => [...view.container.querySelectorAll(".screen-wave")],
    props: (next) => dom.update(() => set((was) => ({ ...was, ...next }))),
    answer: (fn) => { answer = fn; },
  };
}
const finger = (stage, type, x, y, id = 1) =>
  stage.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "touch" }));
async function tap(stage, x = 300, y = 200, holdMs = 20) {
  finger(stage, "pointerdown", x, y);
  await settle(holdMs);
  finger(stage, "pointerup", x, y);
  await settle(10);
}
const said = (s) => s.said.filter(Boolean).at(-1);

test("only watching: a tap leaves no mark, sends nothing, and says why", async () => {
  const s = await surface({ canControl: false, blocked: "View only · tap Control to use it" });
  await tap(s.stage);
  await settle(50);
  assert.deepEqual(s.sent, []);
  assert.equal(s.waves().length, 0, "no click feedback while control is off");
  assert.equal(said(s), "View only · tap Control to use it");
  // A long press too: said, not lost.
  s.said.length = 0;
  await tap(s.stage, 300, 200, 450);
  assert.equal(said(s), "View only · tap Control to use it");
  await s.view.unmount();
});

test("a wave shows only once the Mac did the click", async () => {
  const s = await surface();
  let done;
  s.answer(() => new Promise((resolve) => { done = resolve; }));
  await tap(s.stage, 300, 200);
  assert.deepEqual(s.clicks(), [{ type: "click", x: 0.3, y: 0.4, button: "left", count: 1 }]);
  assert.equal(s.waves().length, 0, "nothing while it is on its way");
  done({});
  await settle(10);
  const [wave] = s.waves();
  assert.ok(wave, "the wave once it was done");
  assert.equal(wave.className, "screen-wave click");
  assert.equal(wave.getAttribute("aria-hidden"), "true");
  assert.equal(wave.style.left, "300px", "from the exact tap point");
  assert.equal(wave.style.top, "200px");
  assert.equal(wave.querySelectorAll("span").length, 2, "a thin ring and its echo");
  await settle(650);
  assert.equal(s.waves().length, 0, "and it goes by itself");
  await s.view.unmount();
});

test("a click the Mac turned down shows no wave and says why", async () => {
  const s = await surface();
  s.answer(async () => { throw Error("The Mac is showing one of its own dialogs."); });
  await tap(s.stage);
  await settle(20);
  assert.equal(s.waves().length, 0);
  assert.equal(said(s), "Tap not sent · The Mac is showing one of its own dialogs");
  await s.view.unmount();
});

test("double-click shows two quick waves, right-click an inward ring, a drag none", async () => {
  const double = await surface({ clickMode: "double" });
  await tap(double.stage);
  await settle(10);
  assert.equal(double.clicks()[0].count, 2);
  assert.equal(double.waves()[0].className, "screen-wave double");
  await double.view.unmount();

  const right = await surface({ clickMode: "right" });
  await tap(right.stage);
  await settle(10);
  assert.equal(right.clicks()[0].button, "right");
  assert.equal(right.waves()[0].className, "screen-wave right");
  await right.view.unmount();

  const drag = await surface({ drag: true });
  finger(drag.stage, "pointerdown", 300, 200);
  for (let x = 310; x <= 400; x += 10) finger(drag.stage, "pointermove", x, 200);
  finger(drag.stage, "pointerup", 400, 200);
  await settle(20);
  assert.deepEqual(drag.sent.filter((a) => ["down", "up"].includes(a.type)).map((a) => a.type), ["down", "up"]);
  assert.equal(drag.waves().length, 0, "a drag shows no wave");
  await drag.view.unmount();
});

test("the waves are compositor-only, about 400 ms, in Reach green, and a still dot with less motion", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /screen-click-ripple/, "the old mark is gone");
  assert.match(css, /\.screen-wave \{[^}]*color: var\(--lime/);
  for (const [, name, body] of css.matchAll(/@keyframes (screen-wave[\w-]*) \{([\s\S]*?)\n\}/g)) {
    const props = [...body.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
    assert.ok(props.length, name);
    for (const prop of props) assert.ok(["opacity", "transform"].includes(prop), `${name} animates only transform and opacity, not ${prop}`);
  }
  for (const [, ms] of css.matchAll(/animation: screen-wave (\d+)ms/g)) assert.ok(ms >= 350 && ms <= 450, `${ms} ms`);
  const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.screen-wave > span[\s\S]*transform: none;[\s\S]*animation: screen-wave-dot/);
  assert.match(reduced, /\.screen-wave > span \+ span \{\s*display: none;/);
});

test("a tap while control reconnects goes once it's back, within a second", async () => {
  const s = await surface({ canControl: false, waitForControl: true, blocked: "Reconnecting controls…" });
  await tap(s.stage);
  assert.deepEqual(s.sent, [], "held, not sent into a closed connection");
  assert.equal(s.waves().length, 0);
  await settle(200);
  s.props({ canControl: true, waitForControl: false, blocked: "" });
  await settle(20);
  assert.deepEqual(s.clicks(), [{ type: "click", x: 0.3, y: 0.4, button: "left", count: 1 }], "delivered once");
  assert.equal(s.waves().length, 1);
  // Never twice.
  s.props({ canControl: false, waitForControl: true });
  s.props({ canControl: true, waitForControl: false });
  await settle(20);
  assert.equal(s.clicks().length, 1);
  await s.view.unmount();
});

test("a tap whose control isn't back within a second is said, and never sent late", async () => {
  const s = await surface({ canControl: false, waitForControl: true, blocked: "Reconnecting controls…" });
  await tap(s.stage);
  await settle(TAP_RETRY_MS + 100);
  assert.equal(said(s), "Tap not sent · Reconnecting controls");
  s.props({ canControl: true, waitForControl: false, blocked: "" });
  await settle(20);
  assert.deepEqual(s.clicks(), [], "not replayed late");
  await s.view.unmount();
});

test("a click caught in a closing connection (never sent) goes again when control is back", async () => {
  const s = await surface();
  s.answer(async () => { throw Object.assign(Error("Desktop control ended."), { notSent: true }); });
  await tap(s.stage);
  await settle(10);
  assert.equal(s.clicks().length, 1);
  s.answer(async () => ({}));
  s.props({ canControl: false, waitForControl: true, blocked: "Reconnecting controls…" });
  await settle(100);
  s.props({ canControl: true, waitForControl: false, blocked: "" });
  await settle(20);
  assert.equal(s.clicks().length, 2, "once more, now that it can arrive");
  assert.equal(s.waves().length, 1);
  // One the Mac may have had (sent, no answer) is never sent twice.
  const t = await surface();
  t.answer(async () => { throw Error("Desktop control ended."); });
  await tap(t.stage);
  t.props({ canControl: false, waitForControl: true });
  t.props({ canControl: true, waitForControl: false });
  await settle(20);
  assert.equal(t.clicks().length, 1);
  assert.equal(said(t), "Tap not sent · Desktop control ended");
  await t.view.unmount();
  await s.view.unmount();
});

test("pan & zoom says taps don't click; a tap the browser cancels says so", async () => {
  const pan = await surface({ mode: "pan" });
  await tap(pan.stage);
  assert.equal(said(pan), "Pan & zoom · taps don't click");
  assert.deepEqual(pan.clicks(), []);
  await pan.view.unmount();
  const s = await surface();
  finger(s.stage, "pointerdown", 300, 200);
  finger(s.stage, "pointercancel", 300, 200);
  await settle(10);
  assert.equal(said(s), "Tap didn't go through · try again");
  assert.deepEqual(s.clicks(), []);
  await s.view.unmount();
  assert.deepEqual(dom.errors, []);
});
