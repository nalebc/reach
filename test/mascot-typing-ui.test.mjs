import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// While an agent works, Reach's mascot sits with a laptop on its lap and types
// (the Working line); still when motion is off or reduced.
let dom, React, MascotTyping, MotionContext;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: MascotTyping } = await dom.load("/src/MascotTyping.tsx"));
  ({ MotionContext } = await dom.load("/src/motion.ts"));
});
after(async () => dom?.close());

const render = (value) =>
  dom.render(
    React.createElement(
      MotionContext.Provider,
      { value: { enabled: true, reduced: false, hidden: false, toggle() {}, ...value } },
      React.createElement(MascotTyping),
    ),
  );

test("the mascot sits with the laptop on its lap and types: hands tapping, the screen's light on its face", async () => {
  const view = await render({});
  const art = dom.document.querySelector("svg.mascot-typing");
  assert.equal(art.getAttribute("aria-hidden"), "true");
  assert.ok(art.classList.contains("playing"));
  // Two poses per hand, shown in turn.
  assert.equal(art.querySelectorAll(".mt-hand.mt-left").length, 2);
  assert.equal(art.querySelectorAll(".mt-hand.mt-right").length, 2);
  assert.ok(art.querySelector(".mt-glow"));
  assert.ok(art.querySelector(".mt-logo"));
  await view.unmount();
});

test("still when motion is reduced, off, or the page is hidden", async () => {
  for (const value of [{ reduced: true }, { enabled: false }, { hidden: true }]) {
    const view = await render(value);
    assert.equal(dom.document.querySelector("svg.mascot-typing").classList.contains("playing"), false);
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});

