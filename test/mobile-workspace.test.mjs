import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";
let dom, terminalTouch, writeSnapshot, plainKeyboard, useScreenPresentation;
before(async () => {
  dom = await startDom();
  ({ terminalTouch, writeSnapshot, plainKeyboard } = await dom.load("/src/terminal-options.ts"));
  ({ useScreenPresentation } = await dom.load("/src/useScreenPresentation.ts"));
});
after(() => dom.close());
const touch = (el, type, points) => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: points });
  el.dispatchEvent(event);
  return event;
};

test("scrolling terminal history does not focus the keyboard or switch sessions", () => {
  const el = dom.document.createElement("div");
  el.innerHTML = '<div class="xterm"><div class="xterm-screen"></div></div>';
  dom.document.body.append(el);
  let line = 300, clicks = 0;
  const term = { rows: 24, buffer: { active: { type: "normal" } }, scrollLines: (n) => { line += n; } };
  const remove = terminalTouch(el, term);
  el.addEventListener("click", () => clicks++);
  touch(el, "touchstart", [{ clientX: 100, clientY: 100 }]);
  const move = touch(el, "touchmove", [{ clientX: 101, clientY: 208 }]);
  touch(el, "touchend", []);
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(line, 294, "dragging down reveals earlier lines");
  assert.equal(move.defaultPrevented, true);
  assert.equal(clicks, 0, "no synthetic click after scrolling");
  remove();
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(clicks, 1, "cleanup removes the touch adapter");
  el.remove();
});

test("terminal programs get wheel scrolling; two-finger gestures stay with the browser", () => {
  const el = dom.document.createElement("div");
  el.innerHTML = '<div class="xterm"></div>';
  dom.document.body.append(el);
  const wheel = [];
  el.addEventListener("wheel", (e) => wheel.push(e.deltaY));
  const remove = terminalTouch(el, { buffer: { active: { type: "alternate" } } });
  touch(el, "touchstart", [{ clientX: 100, clientY: 100 }]);
  touch(el, "touchmove", [{ clientX: 100, clientY: 50 }]);
  assert.deepEqual(wheel, [50]);
  touch(el, "touchstart", [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }]);
  const move = touch(el, "touchmove", [{ clientX: 100, clientY: 50 }, { clientX: 200, clientY: 100 }]);
  assert.equal(move.defaultPrevented, false);
  assert.deepEqual(wheel, [50]);
  remove(); el.remove();
});

test("snapshot updates keep history in place; following output still follows", () => {
  const calls = [];
  let finish;
  const term = {
    buffer: { active: { viewportY: 40, baseY: 100 } },
    reset() { this.buffer.active.viewportY = 0; },
    write(text, done) { finish = done; },
    scrollToBottom() { calls.push("bottom"); },
    scrollToLine(line) { calls.push(line); },
  };
  writeSnapshot(term, "new output");
  assert.deepEqual(calls, [], "restore after xterm has processed the snapshot");
  finish();
  assert.deepEqual(calls, [40]);
  term.buffer.active.viewportY = 100;
  writeSnapshot(term, "next output"); finish();
  assert.deepEqual(calls, [40, "bottom"]);
  const textarea = dom.document.createElement("textarea");
  plainKeyboard({ textarea });
  assert.equal(textarea.style.fontSize, "16px", "focus must not trigger Safari's small-input zoom");
});

test("screen fullscreen opened from a scrolled page fits the visible viewport and restores the page", async () => {
  const { React, window } = dom;
  let y = 420;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  window.scrollTo = (o) => { y = o.top; };
  function Screen() {
    const ref = React.useRef(null);
    const state = useScreenPresentation(ref, false);
    return React.createElement("section", { ref, id: "viewer" },
      React.createElement("button", { onClick: state.toggleFullscreen }, "Full screen"));
  }
  const view = await dom.render(React.createElement(Screen));
  dom.document.querySelector("#viewer button").click();
  await dom.waitFor(() => dom.document.querySelector("#viewer").style.getPropertyValue("--screen-height"));
  assert.equal(y, 0);
  assert.equal(dom.document.body.style.top, "0px");
  await view.unmount();
  assert.equal(y, 420);
});
