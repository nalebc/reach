import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The first page's intro: once per phone, skippable, never with reduced
// motion, and gone when its own fade ends.
let dom, React, MascotIntro, MotionContext;
before(async () => {
  dom = await startDom({ mobile: true });
  // A phone without the reduced-motion setting.
  const media = dom.window.matchMedia;
  globalThis.matchMedia = dom.window.matchMedia = (query) =>
    /reduced-motion/.test(query) ? { ...media(query), matches: false } : media(query);
  React = dom.React;
  ({ default: MascotIntro } = await dom.load("/src/MascotIntro.tsx"));
  ({ MotionContext } = await dom.load("/src/motion.ts"));
});
after(async () => dom?.close());
beforeEach(() => dom.window.localStorage.clear());

const motion = (value) =>
  React.createElement(
    MotionContext.Provider,
    {
      value: {
        enabled: true,
        reduced: false,
        hidden: false,
        toggle() {},
        ...value,
      },
    },
    React.createElement(MascotIntro),
  );
const end = (element, animationName) => {
  const event = new dom.window.Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  element.dispatchEvent(event);
};

test("plays the first time only, and leaves when its fade ends", async () => {
  let view = await dom.render(motion());
  const intro = view.container.querySelector(".mascot-intro");
  assert.ok(!!intro, "shown on the first visit");
  for (const part of [
    ".intro-walker",
    ".intro-arm",
    ".intro-dark",
    ".intro-logo",
    ".intro-mac",
  ])
    assert.ok(!!view.container.querySelector(part), part);
  // A part finishing its own animation doesn't end the intro.
  end(view.container.querySelector(".intro-logo"), "intro-found");
  await settle();
  assert.equal(!!view.container.querySelector(".mascot-intro"), true);
  end(intro, "intro-out");
  await settle();
  assert.equal(!!view.container.querySelector(".mascot-intro"), false);
  await view.unmount();
  view = await dom.render(motion());
  assert.equal(
    view.container.querySelector(".mascot-intro"),
    null,
    "not again",
  );
  await view.unmount();
});

test("the Skip button, or a tap anywhere, skips it", async () => {
  const view = await dom.render(motion());
  const intro = view.container.querySelector(".mascot-intro");
  const skip = view.container.querySelector("button.intro-skip-button");
  assert.equal(skip.textContent, "Skip");
  skip.click();
  await settle();
  assert.match(intro.className, /leaving/);
  end(intro, "intro-skip");
  await settle();
  assert.equal(!!view.container.querySelector(".mascot-intro"), false);
  await view.unmount();
});

test("never plays with motion turned off or reduced", async () => {
  for (const value of [{ enabled: false }, { reduced: true }]) {
    dom.window.localStorage.clear();
    const view = await dom.render(motion(value));
    assert.equal(!!view.container.querySelector(".mascot-intro"), false);
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});
