import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Home's live preview streams only while it's in view: scrolled past for a
// few seconds, the Mac stops capturing it; back in view, it starts at once.
let dom, React, useOnScreen;
let fire;
before(async () => {
  dom = await startDom();
  React = dom.React;
  class FakeObserver {
    constructor(callback) { fire = (isIntersecting) => callback([{ isIntersecting }]); }
    observe() {}
    disconnect() {}
  }
  dom.window.IntersectionObserver = FakeObserver;
  globalThis.IntersectionObserver = FakeObserver;
  ({ useOnScreen } = await dom.load("/src/HomeLive.tsx"));
});
after(async () => dom?.close());

test("in view at first; off screen only after the grace period; back in view at once", async () => {
  const seen = [];
  function Probe() {
    const ref = React.useRef(null);
    const on = useOnScreen(ref, 150);
    seen.push(on);
    return React.createElement("section", { ref });
  }
  const view = await dom.render(React.createElement(Probe));
  assert.equal(seen.at(-1), true);
  dom.update(() => fire(false));
  await settle(60);
  assert.equal(seen.at(-1), true, "a quick scroll past keeps it");
  dom.update(() => fire(true));
  dom.update(() => fire(false));
  await settle(250);
  assert.equal(seen.at(-1), false, "off screen past the grace: stopped");
  dom.update(() => fire(true));
  await settle(10);
  assert.equal(seen.at(-1), true, "back in view: at once");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
