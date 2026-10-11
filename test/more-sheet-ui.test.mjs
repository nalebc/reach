import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The More sheet, laid out like Claude's and Codex's menus: the computer
// you're on (tap to switch), the places not in the bottom bar as a list of
// line icons, then Settings.
const peer = {
  id: "mac",
  name: "Studio",
  url: "https://studio.tail.ts.net",
  token: "t",
  platform: "darwin",
};
const other = {
  id: "pc",
  name: "Desk PC",
  url: "https://pc.tail.ts.net",
  token: "u",
  platform: "win32",
};
const device = {
  id: "mac",
  name: "Studio",
  platform: "darwin",
  capabilities: {},
};
const codexIcon = "data:image/png;base64,iVBORw0KGgo=";
let dom, React, MoreSheet;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({
        version: "1",
        logos: { codex: codexIcon },
      }),
      "/api/apps/icons": () => ({ icons: {} }),
    },
  });
  React = dom.React;
  ({ default: MoreSheet } = await dom.load("/src/MoreSheet.tsx"));
  dom.window.HTMLDialogElement.prototype.showModal ??= function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close ??= function () {
    this.open = false;
  };
});
after(async () => dom?.close());

async function sheet(props = {}) {
  const calls = [];
  const view = await dom.render(
    React.createElement(MoreSheet, {
      peer,
      device,
      places: ["files", "apps", "agents", "invite"],
      current: "files",
      settings: true,
      peers: [peer, other],
      active: "mac",
      connections: {
        mac: { state: "connected" },
        pc: { state: "disconnected" },
      },
      onNavigate: (id) => calls.push(["go", id]),
      onChoose: (id) => calls.push(["choose", id]),
      onAdd: () => calls.push(["add"]),
      onClose: () => calls.push(["close"]),
      ...props,
    }),
  );
  return { view, calls, root: view.container };
}
const names = (root, selector) =>
  [...root.querySelectorAll(selector)].map((e) => e.textContent.trim());

test("shows the computer, the places as a list, and Settings at the end", async () => {
  const { view, calls, root } = await sheet();
  assert.equal(
    root.querySelector(".more-computer strong").textContent,
    "Studio",
  );
  assert.match(
    root.querySelector(".more-computer small").textContent,
    /Online.*macOS.*Tailscale/,
  );
  // Its own header: the mascot and a close, no second title from the popup.
  assert.ok(root.querySelector(".more-top .more-mascot .brand-courier"));
  assert.deepEqual(names(root, 'nav[aria-label="Go to"] .more-row-label'), [
    "Files",
    "Apps",
    "Agents & people",
  ]);
  assert.equal(
    root.querySelector('.more-row[aria-current="page"] .more-row-label')
      .textContent,
    "Files",
  );
  // Every place wears a line icon.
  assert.equal(
    root.querySelectorAll('nav[aria-label="Go to"] .app-icon.small svg').length,
    3,
  );
  // The computer you're on wears its platform's mark; "Online" says the rest.
  assert.ok(root.querySelector(".more-computer .app-icon.tone-mac svg"));
  assert.ok(root.querySelector(".more-computer .status-text.on"));

  [...root.querySelectorAll('nav[aria-label="Go to"] .more-row')][1].click();
  root.querySelector('nav[aria-label="Settings"] .more-row').click();
  root.querySelector(".more-top .glass-button").click();
  await settle();
  assert.deepEqual(calls, [["go", "apps"], ["go", "settings"], ["close"]]);
  await view.unmount();
});

test("tapping the computer lists your computers to switch to", async () => {
  const { view, calls, root } = await sheet();
  const card = root.querySelector(".more-computer");
  assert.equal(card.getAttribute("aria-expanded"), "false");
  assert.equal(root.querySelector(".more-computers"), null);
  card.click();
  await settle();
  assert.equal(card.getAttribute("aria-expanded"), "true");
  const rows = [...root.querySelectorAll(".more-computers .more-row")];
  assert.deepEqual(
    rows.map((r) => r.querySelector(".more-row-label").textContent),
    ["Studio", "Desk PC", "Add a computer"],
  );
  assert.equal(rows[0].getAttribute("aria-pressed"), "true");
  assert.ok(rows[0].querySelector(".more-check"));
  // Each computer wears its platform: the Mac its mark, the PC Windows'.
  assert.ok(rows[0].querySelector(".app-icon.tone-mac svg"));
  assert.ok(rows[1].querySelector(".app-icon.tone-windows svg"));
  assert.ok(rows[1].querySelector(".app-icon-dot:not(.on)"), "the PC is off");
  rows[1].click();
  rows[0].click();
  rows[2].click();
  await settle();
  assert.deepEqual(calls, [["choose", "pc"], ["close"], ["add"]]);
  await view.unmount();
});

test("guests see only their places and no Settings", async () => {
  const { view, root } = await sheet({
    settings: false,
    device: { ...device, access: { kind: "guest", scopes: ["files:read"] } },
    places: ["files"],
  });
  assert.deepEqual(names(root, ".more-list .more-row-label"), ["Files"]);
  assert.equal(root.querySelector('nav[aria-label="Settings"]'), null);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
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

test("a place still being checked keeps its row but can't be opened yet", async () => {
  const { view, calls, root } = await sheet({ pending: ["apps"] });
  const rows = [...root.querySelectorAll('nav[aria-label="Go to"] .more-row')];
  assert.deepEqual(
    rows.map((r) => r.querySelector(".more-row-label").textContent),
    ["Files", "Apps", "Agents & people"],
  );
  assert.equal(rows[1].getAttribute("aria-disabled"), "true");
  rows[1].click();
  rows[0].click();
  await settle();
  assert.deepEqual(calls, [["go", "files"]]);
  await view.unmount();
});

test("a swipe on the sheet moves nothing, unless it lands on something that scrolls", async () => {
  const { window } = dom;
  const { view, root } = await sheet();
  const dialog = window.document.querySelector("dialog.more-sheet");
  const swipe = (target) => {
    const event = new window.Event("touchmove", {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(swipe(root.querySelector(".more-row")), true, "a row");
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
  const dialog = window.document.querySelector("dialog.more-sheet");
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
  pointer("pointerdown", dialog.querySelector(".more-top .glass-button"), 100);
  pointer("pointermove", window, 400);
  assert.equal(dialog.style.translate, "");
  pointer("pointerup", window, 400);

  // Pulled well down (from the header too): it slides away and closes.
  pointer("pointerdown", dialog.querySelector(".more-top .more-mascot"), 100);
  pointer("pointermove", window, 250);
  pointer("pointermove", window, 400);
  pointer("pointerup", window, 400);
  await wait(260);
  assert.deepEqual(calls, [["close"]]);
  await view.unmount();
});

test("opening the sheet focuses the sheet, not its close button (no ring on iPhone)", async () => {
  const { view } = await sheet();
  const dialog = dom.window.document.querySelector("dialog.more-sheet");
  assert.equal(dom.window.document.activeElement, dialog);
  assert.notEqual(dom.window.document.activeElement, dialog.querySelector(".glass-button"));
  await view.unmount();
});
