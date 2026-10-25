import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peers = [
  {
    id: "mac",
    name: "Studio",
    url: "https://studio.tail.ts.net",
    token: "t",
    platform: "darwin",
  },
  {
    id: "pc",
    name: "Desk PC",
    url: "https://pc.tail.ts.net",
    token: "u",
    platform: "win32",
  },
];
let dom, React, ComputerMenu;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: ComputerMenu } = await dom.load("/src/ComputerMenu.tsx"));
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
after(async () => dom?.close());
async function sheet(props = {}) {
  const calls = [];
  const view = await dom.render(
    React.createElement(ComputerMenu, {
      peers,
      active: "mac",
      connections: {
        mac: { state: "connected" },
        pc: { state: "disconnected" },
      },
      onChoose: (id) => calls.push(["choose", id]),
      onAdd: () => calls.push(["add"]),
      onWaiting: () => {},
      onClose: () => calls.push(["close"]),
      ...props,
    }),
  );
  return { view, calls, root: view.container };
}

test("the computer picker shows every computer immediately and switches with one tap", async () => {
  const { view, calls, root } = await sheet();
  const rows = [...root.querySelectorAll(".computer-menu-row")];
  assert.deepEqual(
    rows.map((r) => r.querySelector("strong").textContent),
    ["Studio", "Desk PC"],
  );
  assert.equal(rows[0].getAttribute("aria-pressed"), "true");
  assert.match(rows[0].textContent, /Online.*macOS.*Tailscale/);
  assert.match(rows[1].textContent, /Offline.*Windows/);
  rows[1].click();
  root.querySelector(".computer-menu-add").click();
  assert.deepEqual(calls, [["choose", "pc"], ["close"], ["add"]]);
  assert.equal(root.querySelector('nav[aria-label="Go to"]'), null);
  await view.unmount();
});

test("the page behind stays still while the sheet is open", async () => {
  const { window } = dom;
  const body = window.document.body;
  Object.defineProperty(window, "scrollY", { value: 230, configurable: true });
  const moves = [];
  const scrollTo = window.scrollTo;
  window.scrollTo = (x, y) => moves.push([x, y]);
  try {
    const { view } = await sheet();
    assert.equal(body.style.position, "fixed", "the page is pinned");
    assert.equal(body.style.top, "-230px", "where it was");
    assert.equal(body.style.overflow, "hidden");
    assert.equal(
      window.document.documentElement.style.overscrollBehavior,
      "none",
      "no rubber band",
    );
    // A second popup on top shares the hold.
    const { holdPage } = await dom.load("/src/page-hold.ts");
    const inner = holdPage();
    inner();
    assert.equal(body.style.position, "fixed", "still held by the sheet");
    await view.unmount();
    assert.equal(body.style.position, "");
    assert.equal(body.style.top, "");
    assert.equal(window.document.documentElement.style.overscrollBehavior, "");
    assert.deepEqual(moves, [[0, 230]], "back to the same place");
  } finally {
    window.scrollTo = scrollTo;
    delete window.scrollY;
  }
});

test("a swipe on the sheet moves nothing, unless it lands on something that scrolls", async () => {
  const { window } = dom;
  const { view, root } = await sheet();
  const dialog = window.document.querySelector("dialog.computer-menu");
  const swipe = (target) => {
    const event = new window.Event("touchmove", {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(swipe(root.querySelector(".computer-menu-row")), true, "a row");
  assert.equal(swipe(dialog), true, "the dimmed area");
  // A list taller than its box inside a popup still scrolls.
  const list = window.document.createElement("div");
  list.style.overflowY = "auto";
  Object.defineProperty(list, "scrollHeight", { value: 900 });
  Object.defineProperty(list, "clientHeight", { value: 300 });
  const item = window.document.createElement("p");
  list.append(item);
  dialog.querySelector(".screen-popup-body").append(list);
  assert.equal(swipe(item), false, "a long list");
  const slider = window.document.createElement("input");
  slider.type = "range";
  dialog.querySelector(".screen-popup-body").append(slider);
  assert.equal(swipe(slider), false, "a slider");
  list.remove();
  slider.remove();
  await view.unmount();
  assert.equal(swipe(dialog), false, "let go once closed");
});

test("dragging the sheet down by its handle closes it; a short pull springs back", async () => {
  const { window } = dom;
  const pointer = (type, target, y) => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY: y,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    target.dispatchEvent(event);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const { view, calls } = await sheet();
  const dialog = window.document.querySelector("dialog.computer-menu");
  const handle = dialog.querySelector(".sheet-handle");
  assert.ok(handle, "a real handle to hold");

  // A short pull: the sheet follows, then settles back; the tap that ends
  // the pull doesn't count as a tap on the dimmed area.
  pointer("pointerdown", handle, 100);
  pointer("pointermove", window, 118);
  assert.equal(dialog.style.translate, "0 18px", "follows the finger");
  pointer("pointerup", window, 118);
  dialog.click();
  await wait(260);
  assert.equal(dialog.style.translate, "");
  assert.deepEqual(calls, []);

  // The close button in the header is still a button, not a handle.
  pointer("pointerdown", dialog.querySelector("header .icon-button"), 100);
  pointer("pointermove", window, 400);
  assert.equal(dialog.style.translate, "");
  pointer("pointerup", window, 400);

  // Pulled well down (from the header too): it slides away and closes.
  pointer("pointerdown", dialog.querySelector("header h2"), 100);
  pointer("pointermove", window, 250);
  pointer("pointermove", window, 400);
  pointer("pointerup", window, 400);
  await wait(260);
  assert.deepEqual(calls, [["close"]]);
  await view.unmount();
});

test("opening the sheet focuses the sheet, not its close button (no ring on iPhone)", async () => {
  const { view } = await sheet();
  const dialog = dom.window.document.querySelector("dialog.computer-menu");
  assert.equal(dom.window.document.activeElement, dialog);
  assert.notEqual(
    dom.window.document.activeElement,
    dialog.querySelector(".icon-button"),
  );
  await view.unmount();
});
