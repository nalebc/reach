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

// The scene plays in its own layer on the page (it outlives the page that
// started it), so it's looked for in the document.
const $ = (selector) => dom.document.querySelector(selector);
const gone = () => dom.waitFor(() => !$(".mascot-intro"));

test("plays the first time only, and leaves when its fade ends", async () => {
  let view = await dom.render(motion());
  const intro = await dom.waitFor(() => $(".mascot-intro"));
  for (const part of [
    ".intro-walker",
    ".intro-arm",
    ".intro-dark",
    ".intro-logo",
    ".intro-mac",
  ])
    assert.ok(!!$(part), part);
  // A part finishing its own animation doesn't end the intro.
  end($(".intro-logo"), "intro-found");
  await settle();
  assert.equal(!!$(".mascot-intro"), true);
  end(intro, "intro-out");
  await gone();
  await view.unmount();
  view = await dom.render(motion());
  await settle(50);
  assert.equal($(".mascot-intro"), null, "not again");
  await view.unmount();
});

test("keeps playing when the page that started it goes away (an invitation accepted in a second)", async () => {
  // The invitation page shows it, then makes way for Reach almost at once.
  const invitation = await dom.render(motion());
  const intro = await dom.waitFor(() => $(".mascot-intro"));
  await invitation.unmount();
  await settle(50);
  assert.equal($(".mascot-intro"), intro, "still playing");
  // Reach's own page doesn't start a second one.
  const reach = await dom.render(motion());
  await settle(50);
  assert.equal(dom.document.querySelectorAll(".mascot-intro").length, 1);
  end(intro, "intro-out");
  await gone();
  await reach.unmount();
  assert.deepEqual(dom.errors, []);
});

test("the Skip button, or a tap anywhere, skips it", async () => {
  const view = await dom.render(motion());
  const intro = await dom.waitFor(() => $(".mascot-intro"));
  const skip = $("button.intro-skip-button");
  assert.equal(skip.textContent, "Skip");
  skip.click();
  await settle();
  assert.match(intro.className, /leaving/);
  end(intro, "intro-skip");
  await gone();
  await view.unmount();
});

test("never plays with motion turned off or reduced", async () => {
  for (const value of [{ enabled: false }, { reduced: true }]) {
    dom.window.localStorage.clear();
    const view = await dom.render(motion(value));
    await settle(50);
    assert.equal(!!$(".mascot-intro"), false);
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});
