import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, MobileNav;
before(async () => {
  dom = await startDom({ mobile: true });
  ({ default: MobileNav } = await dom.load("/src/MobileNav.tsx"));
});
after(async () => dom?.close());
const items = [
  { id: "overview", label: "Home", icon: "H" },
  { id: "screen", label: "Screen", icon: "S" },
  { id: "tools", label: "Tools", icon: "T", badge: 2 },
];
test("all three tabs navigate directly; Screen is one tap away from every tool", async () => {
  for (const page of [
    "overview",
    "screen",
    "tools",
    "files",
    "sessions",
    "terminal",
    "settings",
  ]) {
    const calls = [];
    const view = await dom.render(
      dom.React.createElement(MobileNav, {
        items,
        current: page,
        onNavigate: (id) => calls.push(id),
      }),
    );
    const nav = view.container.querySelector("nav");
    const section = ["overview", "screen"].includes(page) ? page : "tools";
    const label = items.find((i) => i.id === section).label;
    assert.equal(
      nav.querySelector('[aria-current="page"]').getAttribute("aria-label"),
      label,
    );
    assert.equal(nav.style.getPropertyValue("--tabs"), "3");
    assert.equal(nav.querySelectorAll("button").length, 3);
    assert.equal(nav.querySelector('[aria-haspopup="dialog"]'), null);
    nav.querySelector('[aria-label="Screen"]').click();
    nav.querySelector('[aria-label="Tools"]').click();
    await settle();
    assert.deepEqual(calls, ["screen", "tools"]);
    assert.equal(nav.querySelector(".nav-badge").textContent, "2");
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});

async function bar(current, initial = items) {
  const calls = [];
  let update;
  function Fixture() {
    const [props, setProps] = dom.React.useState({
      items: initial,
      current,
      onNavigate: (id) => calls.push(["go", id]),
    });
    update = setProps;
    return dom.React.createElement(MobileNav, props);
  }
  const view = await dom.render(dom.React.createElement(Fixture));
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

// Deterministic models of the real Chrome retargeted native click in
// mobile-nav-chrome-e2e. These do not claim jsdom performs browser hit testing.
test("a changed layout keeps the pressed Tools action and uses the current handler once", async (t) => {
  const { view, calls, nav, change } = await bar("overview", items.filter((item) => item.id !== "screen"));
  t.after(() => view.unmount());
  const more = named(nav, "Tools");
  pointer(more, "pointerdown");
  pointer(more, "pointerup");
  change({ items, onNavigate: (id) => calls.push(["current go", id]) });
  nativeClick(named(nav, "Home"));
  assert.deepEqual(calls, [["current go", "tools"]]);
});

test("a changed layout keeps an eligible pressed page using the current handler", async (t) => {
  const { view, calls, nav, change } = await bar("overview");
  t.after(() => view.unmount());
  const screen = named(nav, "Screen");
  pointer(screen, "pointerdown");
  change({ items: [...items].reverse(), onNavigate: (id) => calls.push(["current go", id]) });
  pointer(screen, "pointerup");
  nativeClick(named(nav, "Home"));
  assert.deepEqual(calls, [["current go", "screen"]]);
});

test("a removed pressed page cannot activate itself or its replacement", async (t) => {
  const { view, calls, nav, change } = await bar("overview");
  t.after(() => view.unmount());
  pointer(named(nav, "Screen"), "pointerdown");
  change({ items: items.filter((item) => item.id !== "screen") });
  pointer(nav, "pointerup");
  nativeClick(named(nav, "Home"));
  assert.deepEqual(calls, []);
  dom.update(() => named(nav, "Home").click());
  assert.deepEqual(calls, [["go", "overview"]], "the normal current access remains usable");
});

for (const changed of [false, true]) {
  test(`a cancelled pointer cannot navigate with ${changed ? "changed" : "unchanged"} items`, async (t) => {
    const { view, calls, nav, change } = await bar("overview", items.filter((item) => item.id !== "screen"));
    t.after(() => view.unmount());
    const more = named(nav, "Tools");
    pointer(more, "pointerdown");
    if (changed) change({ items });
    pointer(more, "pointercancel");
    nativeClick(changed ? named(nav, "Home") : more);
    assert.deepEqual(calls, []);
    dom.update(() => named(nav, "Tools").click());
    assert.deepEqual(calls, [["go", "tools"]], "keyboard/programmatic click is not trapped by a cancelled touch");
  });
  test(`scroll movement cannot navigate with ${changed ? "changed" : "unchanged"} items, even after returning to the starting point`, async (t) => {
    const { view, calls, nav, change } = await bar("overview", items.filter((item) => item.id !== "screen"));
    t.after(() => view.unmount());
    const more = named(nav, "Tools");
    pointer(more, "pointerdown");
    pointer(more, "pointermove", { y: 760 });
    if (changed) change({ items });
    pointer(more, "pointerup");
    nativeClick(changed ? named(nav, "Home") : more);
    assert.deepEqual(calls, []);
    pointer(more, "pointerdown");
    pointer(more, "pointerup");
    nativeClick(more);
    assert.deepEqual(calls, [["go", "tools"]], "a fresh tap still works once");
  });
}

test("an unchanged layout never turns a cross-button gesture into navigation", async (t) => {
  const { view, calls, nav } = await bar("overview");
  t.after(() => view.unmount());
  pointer(named(nav, "Screen"), "pointerdown");
  pointer(named(nav, "Home"), "pointerup");
  nativeClick(named(nav, "Home"));
  assert.deepEqual(calls, []);
});

test("ordinary same-button taps use the current handler after a badge-only update", async (t) => {
  const { view, calls, nav, change } = await bar("overview");
  t.after(() => view.unmount());
  const chat = named(nav, "Tools");
  pointer(chat, "pointerdown");
  change({ items: items.map((item) => ({ ...item, badge: 3 })), onNavigate: (id) => calls.push(["current go", id]) });
  pointer(chat, "pointerup");
  nativeClick(chat);
  assert.deepEqual(calls, [["current go", "tools"]]);
});

test("keyboard/programmatic clicks use their own target even with an old held pointer", async (t) => {
  const { view, calls, nav, change } = await bar("overview", items.filter((item) => item.id !== "screen"));
  t.after(() => view.unmount());
  pointer(named(nav, "Tools"), "pointerdown");
  change({ items });
  dom.update(() => named(nav, "Home").click());
  assert.deepEqual(calls, [["go", "overview"]]);
});

test("a second finger cancels a held navigation gesture", async (t) => {
  const { view, calls, nav } = await bar("overview");
  t.after(() => view.unmount());
  const more = named(nav, "Tools");
  pointer(more, "pointerdown");
  pointer(more, "pointerdown", { id: 2, primary: false });
  pointer(more, "pointerup");
  nativeClick(more);
  assert.deepEqual(calls, []);
});
