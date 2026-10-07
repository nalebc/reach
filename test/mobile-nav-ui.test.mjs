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
async function bar(current) {
  const calls = [];
  const view = await dom.render(
    React.createElement(MobileNav, {
      items,
      current,
      moreOpen: false,
      onNavigate: (id) => calls.push(["go", id]),
      onMore: () => calls.push(["more"]),
    }),
  );
  const nav = view.container.querySelector("nav.mobile-nav");
  const active = () =>
    [...nav.querySelectorAll("button.active")].map((b) =>
      b.getAttribute("aria-label"),
    );
  return { view, calls, nav, active };
}

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
