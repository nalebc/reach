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

test("the view follows the keyboard to where it stops, though iOS reports it only while it is still moving", async () => {
  const { window } = dom;
  // iOS's visual viewport: one resize while the keyboard slides away, none when it stops.
  const viewport = new window.EventTarget();
  Object.assign(viewport, { offsetTop: 0, height: 420 });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => 0 });
  window.scrollTo = () => {};
  function Box() {
    const ref = React.useRef(null);
    useViewportBox(ref, true);
    return React.createElement("div", { ref, className: "box" });
  }
  const view = await dom.render(React.createElement(Box));
  const height = () => dom.document.querySelector(".box").style.getPropertyValue("--vv-height");
  assert.equal(height(), "420px", "keyboard open");
  // The message box lets go (Send), the keyboard starts closing: one report, mid-way.
  viewport.height = 600;
  viewport.dispatchEvent(new window.Event("resize"));
  await new Promise((r) => setTimeout(r, 40));
  // It keeps sliding, then stops, with no further report.
  viewport.height = 780;
  await new Promise((r) => setTimeout(r, 40));
  viewport.height = 852;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(height(), "852px", "the whole screen once the keyboard is gone");
  // A field letting go alone starts the same watch.
  viewport.height = 500;
  dom.document.dispatchEvent(new window.FocusEvent("focusout"));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(height(), "500px");
  await view.unmount();
  delete window.visualViewport;
});

test("while the view is open, Safari scrolling the page underneath (back from the photo picker) is undone at once", async () => {
  const { window } = dom;
  let y = 0;
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
  assert.deepEqual(moves, [], "already at the top");
  // Safari scrolls the frozen page 291 points to show the message box.
  y = 291;
  window.dispatchEvent(new window.Event("scroll"));
  assert.deepEqual(moves, [{ left: 0, top: 0, behavior: "instant" }]);
  assert.equal(y, 0);
  // Coming back from the picker: the size is read again, the page kept at its top.
  y = 120;
  window.dispatchEvent(new window.Event("focus"));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(y, 0);
  await view.unmount();
  // Closed: the page underneath scrolls freely again.
  moves.length = 0;
  y = 500;
  window.dispatchEvent(new window.Event("scroll"));
  assert.deepEqual(moves, []);
});

// Oct 27, an iPhone: "taps and typing do nothing". A sheet (holdPage) and a
// keyboard view (useViewportBox) each saved and put back the page on its
// own, so whichever let go last put back a stale copy: a chat opened under
// a sheet, or a sheet over a chat, left the page pinned with nothing open
// (drawn in one place, tapped in another on an iPhone). Every order of
// opening and closing the two: the page is held exactly while something is
// open, and put back as it was once nothing is.
test("a sheet and a keyboard view, opened and closed in any order, never leave the page pinned", async () => {
  const { window, document } = dom;
  const { holdPage, pageHeld } = await dom.load("/src/page-hold.ts");
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => 0 });
  Object.defineProperty(window, "scrollX", { configurable: true, get: () => 0 });
  window.scrollTo = () => {};
  let setOpen;
  function Chat() {
    const ref = React.useRef(null);
    useViewportBox(ref, true);
    return React.createElement("main", { ref });
  }
  function Root() {
    const [open, set] = React.useState(false);
    setOpen = set;
    return open ? React.createElement(Chat) : null;
  }
  const view = await dom.render(React.createElement(Root));
  const before = document.body.style.cssText;
  const steps = {
    chatOpens: () => dom.update(() => setOpen(true)),
    chatCloses: () => dom.update(() => setOpen(false)),
  };
  const orders = [
    ["sheet", "chatOpens", "sheetCloses", "chatCloses"],
    ["sheet", "chatOpens", "chatCloses", "sheetCloses"],
    ["chatOpens", "sheet", "chatCloses", "sheetCloses"],
    ["chatOpens", "sheet", "sheetCloses", "chatCloses"],
    ["sheet", "sheet2", "chatOpens", "sheetCloses", "chatCloses", "sheet2Closes"],
  ];
  for (const order of orders) {
    const open = new Set();
    const letGo = {};
    for (const step of order) {
      if (step.startsWith("sheet") && !step.endsWith("Closes")) { letGo[step] = holdPage(); open.add(step); }
      else if (step.endsWith("Closes") && step.startsWith("sheet")) { letGo[step.replace("Closes", "")](); open.delete(step.replace("Closes", "")); }
      else { steps[step](); step === "chatOpens" ? open.add("chat") : open.delete("chat"); }
      const held = document.body.style.position === "fixed";
      assert.equal(held, open.size > 0, `${order.join(" → ")}: after ${step}, ${[...open].join(", ") || "nothing"} open, the page ${held ? "pinned" : "free"}`);
      assert.equal(pageHeld(), open.size > 0);
    }
    assert.equal(document.body.style.cssText, before, `${order.join(" → ")}: the page as it was`);
  }
  await view.unmount();
});
