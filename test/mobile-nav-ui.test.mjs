import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The phone's bottom bar: the page you're on wears the pill (it glides to
// the tab's place), a page that lives under More lights More, and the Chat
// tab shows how many sessions wait for an answer.
let dom, React, MobileNav;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: MobileNav } = await dom.load("/src/MobileNav.tsx"));
});
after(async () => dom?.close());

const items = [
  { id: "overview", label: "Home", icon: "H" },
  { id: "sessions", label: "Chat", icon: "C", badge: 2 },
  { id: "screen", label: "Screen", icon: "S" },
  { id: "terminal", label: "Terminal", icon: "T" },
];
async function bar(current, initial = items) {
  const calls = [];
  let update;
  function Fixture() {
    const [props, setProps] = React.useState({
      items: initial,
      current,
      moreOpen: false,
      onNavigate: (id) => calls.push(["go", id]),
      onMore: () => calls.push(["more"]),
    });
    update = setProps;
    return React.createElement(MobileNav, props);
  }
  const view = await dom.render(React.createElement(Fixture));
  const nav = view.container.querySelector("nav.mobile-nav");
  const active = () =>
    [...nav.querySelectorAll("button.active")].map((b) =>
      b.getAttribute("aria-label"),
    );
  return { view, calls, nav, active, change: (next) => dom.update(() => update((previous) => ({ ...previous, ...next }))) };
}

const named = (nav, label) => nav.querySelector(`[aria-label="${label}"]`);
const pointer = (target, type, { x = 283, y = 806, id = 1, primary = true } = {}) => dom.update(() => target.dispatchEvent(
  new dom.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: "touch", isPrimary: primary, button: 0, clientX: x, clientY: y }),
));
const nativeClick = (target) => dom.update(() => target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));

test("the page you're on wears the pill, at its tab", async () => {
  const { view, calls, nav, active } = await bar("screen");
  assert.equal(nav.dataset.tab, "2");
  assert.equal(nav.style.getPropertyValue("--tab"), "2");
  assert.equal(nav.style.getPropertyValue("--tabs"), "5", "four tabs and More");
  assert.deepEqual(active(), ["Screen"]);
  assert.equal(
    nav.querySelector('[aria-current="page"]').getAttribute("aria-label"),
    "Screen",
  );
  assert.equal(nav.querySelector(".nav-badge").textContent, "2");
  nav.querySelector('[aria-label="Terminal"]').click();
  nav.querySelector('[aria-label="More workspace options"]').click();
  await settle();
  assert.deepEqual(calls, [["go", "terminal"], ["more"]]);
  await view.unmount();
});

test("a page under More lights More", async () => {
  for (const page of ["files", "settings"]) {
    const { view, nav, active } = await bar(page);
    assert.equal(nav.dataset.tab, "4");
    assert.deepEqual(active(), ["More workspace options"]);
    assert.equal(nav.querySelector('[aria-current="page"]'), null);
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});

// Deterministic models of the real Chrome retargeted native click in
// mobile-nav-chrome-e2e. These do not claim jsdom performs browser hit testing.
test("a changed layout keeps the pressed More action and uses the current handler once", async (t) => {
  const { view, calls, nav, change } = await bar("overview", items.slice(0, 1));
  t.after(() => view.unmount());
  const more = named(nav, "More workspace options");
  pointer(more, "pointerdown");
  pointer(more, "pointerup");
  change({ items, onMore: () => calls.push(["current more"]) });
  nativeClick(named(nav, "Terminal"));
  assert.deepEqual(calls, [["current more"]]);
});

test("a changed layout keeps an eligible pressed page using the current handler", async (t) => {
  const { view, calls, nav, change } = await bar("overview");
  t.after(() => view.unmount());
  const screen = named(nav, "Screen");
  pointer(screen, "pointerdown");
  change({ items: [...items].reverse(), onNavigate: (id) => calls.push(["current go", id]) });
  pointer(screen, "pointerup");
  nativeClick(named(nav, "Terminal"));
  assert.deepEqual(calls, [["current go", "screen"]]);
});

test("a removed pressed page cannot activate itself or its replacement", async (t) => {
  const { view, calls, nav, change } = await bar("overview");
  t.after(() => view.unmount());
  pointer(named(nav, "Screen"), "pointerdown");
  change({ items: items.filter((item) => item.id !== "screen") });
  pointer(nav, "pointerup");
  nativeClick(named(nav, "Terminal"));
  assert.deepEqual(calls, []);
  dom.update(() => named(nav, "Terminal").click());
  assert.deepEqual(calls, [["go", "terminal"]], "the normal current access remains usable");
});

for (const changed of [false, true]) {
  test(`a cancelled pointer cannot navigate with ${changed ? "changed" : "unchanged"} items`, async (t) => {
    const { view, calls, nav, change } = await bar("overview", items.slice(0, 1));
    t.after(() => view.unmount());
    const more = named(nav, "More workspace options");
    pointer(more, "pointerdown");
    if (changed) change({ items });
    pointer(more, "pointercancel");
    nativeClick(changed ? named(nav, "Terminal") : more);
    assert.deepEqual(calls, []);
    dom.update(() => named(nav, "More workspace options").click());
    assert.deepEqual(calls, [["more"]], "keyboard/programmatic click is not trapped by a cancelled touch");
  });
  test(`scroll movement cannot navigate with ${changed ? "changed" : "unchanged"} items, even after returning to the starting point`, async (t) => {
    const { view, calls, nav, change } = await bar("overview", items.slice(0, 1));
    t.after(() => view.unmount());
    const more = named(nav, "More workspace options");
    pointer(more, "pointerdown");
    pointer(more, "pointermove", { y: 760 });
    if (changed) change({ items });
    pointer(more, "pointerup");
    nativeClick(changed ? named(nav, "Terminal") : more);
    assert.deepEqual(calls, []);
    pointer(more, "pointerdown");
    pointer(more, "pointerup");
    nativeClick(more);
    assert.deepEqual(calls, [["more"]], "a fresh tap still works once");
  });
}

test("an unchanged layout never turns a cross-button gesture into navigation", async (t) => {
  const { view, calls, nav } = await bar("overview");
  t.after(() => view.unmount());
  pointer(named(nav, "Screen"), "pointerdown");
  pointer(named(nav, "Terminal"), "pointerup");
  nativeClick(named(nav, "Terminal"));
  assert.deepEqual(calls, []);
});

test("ordinary same-button taps use the current handler after a badge-only update", async (t) => {
  const { view, calls, nav, change } = await bar("overview");
  t.after(() => view.unmount());
  const chat = named(nav, "Chat");
  pointer(chat, "pointerdown");
  change({ items: items.map((item) => ({ ...item, badge: 3 })), onNavigate: (id) => calls.push(["current go", id]) });
  pointer(chat, "pointerup");
  nativeClick(chat);
  assert.deepEqual(calls, [["current go", "sessions"]]);
});

test("keyboard/programmatic clicks use their own target even with an old held pointer", async (t) => {
  const { view, calls, nav, change } = await bar("overview", items.slice(0, 1));
  t.after(() => view.unmount());
  pointer(named(nav, "More workspace options"), "pointerdown");
  change({ items });
  dom.update(() => named(nav, "Terminal").click());
  assert.deepEqual(calls, [["go", "terminal"]]);
});

test("a second finger cancels a held navigation gesture", async (t) => {
  const { view, calls, nav } = await bar("overview");
  t.after(() => view.unmount());
  const more = named(nav, "More workspace options");
  pointer(more, "pointerdown");
  pointer(more, "pointerdown", { id: 2, primary: false });
  pointer(more, "pointerup");
  nativeClick(more);
  assert.deepEqual(calls, []);
});
