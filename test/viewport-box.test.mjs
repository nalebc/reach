import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

let dom, React, useViewportBox;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ useViewportBox } = await dom.load("/src/useViewportBox.ts"));
});
after(() => dom?.close());

test("a full-screen view opened from a page scrolled down starts at the top of the screen, and the page goes back after", async () => {
  const { window } = dom;
  let y = 350;
  const moves = [];
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  Object.defineProperty(window, "scrollX", { configurable: true, get: () => 0 });
  window.scrollTo = (o) => {
    moves.push(o);
    y = o.top;
  };
  function Box() {
    const ref = React.useRef(null);
    useViewportBox(ref, true);
    return React.createElement("div", { ref, className: "box" });
  }
  const view = await dom.render(React.createElement(Box));
  // iOS Safari would draw the fixed view 350 points down: the page is frozen from its top.
  assert.deepEqual(moves, [{ left: 0, top: 0, behavior: "instant" }]);
  assert.equal(dom.document.body.style.position, "fixed");
  assert.equal(dom.document.body.style.top, "0px");
  assert.equal(dom.document.querySelector(".box").style.getPropertyValue("--vv-top"), "0px");
  await view.unmount();
  assert.equal(dom.document.body.style.position, "");
  assert.deepEqual(moves.at(-1), { left: 0, top: 350, behavior: "instant" });
});
