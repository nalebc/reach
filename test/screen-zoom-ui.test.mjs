import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// The live screen's zoom pill ("100% · Fit") shows only once there's a picture
// to zoom: while connecting it sat on the connecting scene's words.
let dom, React, DesktopSurface;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
});
after(() => dom?.close());

const surface = (ready) =>
  dom.render(
    React.createElement(DesktopSurface, {
      canvas: React.createRef(),
      width: 1000,
      height: 500,
      ready,
      connecting: !ready,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      send: async () => ({}),
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget() {},
      resetKey: "k",
      initialCursor: null,
    }),
  );
const fit = () => dom.document.querySelector('[aria-label="Fit entire screen"]');

test("no zoom pill while the screen is still connecting", async () => {
  const view = await surface(false);
  assert.equal(fit(), null);
  await view.unmount();
});

test("the zoom pill is there once the screen shows", async () => {
  const view = await surface(true);
  assert.match(fit().textContent, /100% · Fit/);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
