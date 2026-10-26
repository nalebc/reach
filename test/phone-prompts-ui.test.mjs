import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// First-run matrix S (Add to Home Screen) and N (get the Tailscale app):
// one suggestion at a time on Home, each coming back from time to time and
// stopping once done (src/PhonePrompts.tsx, src/nudges.ts).
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15";
const APP_URL = "https://studio.example.ts.net";
let dom, React, PhonePrompts, nudges, clock;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: PhonePrompts } = await dom.load("/src/PhonePrompts.tsx"));
  nudges = await dom.load("/src/nudges.ts");
});
after(() => dom?.close());

// A phone: its browser, whether Reach is opened from the Home Screen, and
// whether this page runs its own Tailscale node (no app).
function phone({ ua = IPHONE, homeScreen = false, browserNode = false } = {}) {
  Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: ua });
  Object.defineProperty(dom.window.navigator, "platform", { configurable: true, value: ua === MAC ? "MacIntel" : "iPhone" });
  Object.defineProperty(dom.window.navigator, "maxTouchPoints", { configurable: true, value: ua === MAC ? 0 : 5 });
  dom.window.matchMedia = globalThis.matchMedia = (q) => ({
    matches: q.includes("standalone") ? homeScreen : true,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  });
  if (browserNode) dom.document.documentElement.dataset.connection = "browser";
  else delete dom.document.documentElement.dataset.connection;
}
beforeEach(() => {
  dom.window.localStorage.clear();
  delete dom.document.documentElement.dataset.connection;
});
const $ = (s) => dom.document.querySelector(s);
const prompt = () => $(".phone-prompt");
// A failed test must not leave its prompt behind for the next one.
const views = new Set();
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
const show = async (props = {}) => {
  const view = await dom.render(React.createElement(PhonePrompts, { owner: true, url: APP_URL, ...props }));
  views.add(view);
  const unmount = view.unmount.bind(view);
  view.unmount = async () => (views.delete(view), unmount());
  await settle(4200);
  return view;
};
const click = async (el) => {
  assert.ok(el, "it's there");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(30);
};

test("iPhone with the Tailscale app, in Safari: Add to Home Screen, then the two Share steps", async () => {
  phone();
  dom.window.navigator.share = async () => {};
  const view = await show();
  assert.equal(prompt()?.getAttribute("aria-label"), "Add Reach to your Home Screen");
  await click([...prompt().querySelectorAll("button")].find((b) => b.textContent === "Add"));
  const sheet = $('[role=dialog][aria-label="Add to Home Screen"]');
  assert.ok(sheet, "the steps open");
  assert.match(sheet.textContent, /Add to Home Screen/);
  assert.match(sheet.textContent, /Open Reach from your Home Screen/);
  await view.unmount();
  delete dom.window.navigator.share;
  assert.deepEqual(dom.errors, []);
});

test("Android: Add runs the browser's own install prompt, kept from page load", async () => {
  phone({ ua: ANDROID });
  let prompted = 0;
  const offer = new dom.window.Event("beforeinstallprompt");
  offer.prompt = async () => void prompted++;
  offer.userChoice = Promise.resolve({ outcome: "accepted" });
  dom.window.dispatchEvent(offer);
  const view = await show();
  await click([...prompt().querySelectorAll("button")].find((b) => b.textContent === "Add"));
  await settle(30);
  assert.equal(prompted, 1);
  assert.equal(prompt(), null, "added: gone");
  assert.equal(nudges.readNudge("home-screen").done, true, "never again");
  await view.unmount();
});

test("Android without an install prompt (Firefox, Samsung): the menu steps instead", async () => {
  phone({ ua: ANDROID });
  const view = await show();
  await click([...prompt().querySelectorAll("button")].find((b) => b.textContent === "Add"));
  assert.match($('[role=dialog]').textContent, /Add to Home screen.*Install app/);
  await view.unmount();
});

test("opened from the Home Screen: never suggested, and remembered as added", async () => {
  phone({ homeScreen: true });
  const view = await show();
  assert.equal(prompt(), null);
  assert.equal(nudges.readNudge("home-screen").done, true);
  await view.unmount();
});

test("a desktop browser, a guest or an agent never sees it", async () => {
  phone({ ua: MAC });
  let view = await show();
  assert.equal(prompt(), null, "desktop");
  await view.unmount();
  phone();
  view = await show({ owner: false });
  assert.equal(prompt(), null, "not your own device");
  await view.unmount();
});

test("Not now: back a week later, three times at most; storage blocked keeps it to this visit", async () => {
  phone();
  let view = await show();
  await click(prompt().querySelector('[aria-label="Not now"]'));
  assert.equal(prompt(), null);
  await view.unmount();
  view = await show();
  assert.equal(prompt(), null, "not the next day");
  await view.unmount();
  // A week later.
  const week = 7 * 24 * 60 * 60 * 1000;
  const state = nudges.readNudge("home-screen");
  dom.window.localStorage.setItem("reach.nudge.home-screen", JSON.stringify({ ...state, lastAt: state.lastAt - week }));
  view = await show();
  assert.ok(prompt(), "back after a week");
  await view.unmount();
  dom.window.localStorage.setItem("reach.nudge.home-screen", JSON.stringify({ dismissed: 3, lastAt: 0, done: false }));
  view = await show();
  assert.equal(prompt(), null, "three times is enough");
  await view.unmount();
});

test("in the browser without the Tailscale app: get the app (for this phone), never Home Screen", async () => {
  phone({ browserNode: true });
  const view = await show({ url: "https://studio.example.ts.net" });
  assert.equal(prompt()?.getAttribute("aria-label"), "Get the Tailscale app");
  assert.match(prompt().textContent, /Get the Tailscale app to open Reach any time · faster too/);
  assert.equal(prompt().querySelector("a").href, "https://apps.apple.com/app/tailscale/id1470499037");
  assert.equal(dom.document.querySelectorAll(".phone-prompt").length, 1, "one at a time");
  await view.unmount();
  phone({ ua: ANDROID, browserNode: true });
  const android = await show();
  assert.equal(prompt().querySelector("a").href, "https://play.google.com/store/apps/details?id=com.tailscale.ipn");
  await android.unmount();
});

test("the approved Tailscale app connection becomes active: its suggestion goes and never comes back", async () => {
  phone({ browserNode: true });
  const view = await show();
  assert.ok(prompt());
  dom.window.dispatchEvent(new dom.window.Event("reach-tailscale-app-on"));
  await settle(30);
  assert.equal(prompt(), null);
  assert.equal(nudges.readNudge("tailscale-app").done, true);
  await view.unmount();
});

test("getting the app: back on a visit a day later, three times; then only Home's small link", async () => {
  phone({ browserNode: true });
  let view = await show();
  await click(prompt().querySelector('[aria-label="Not now"]'));
  await view.unmount();
  view = await show();
  assert.equal(prompt(), null, "not again the same day");
  await view.unmount();
  const day = 24 * 60 * 60 * 1000;
  const state = nudges.readNudge("tailscale-app");
  dom.window.localStorage.setItem("reach.nudge.tailscale-app", JSON.stringify({ ...state, lastAt: state.lastAt - day }));
  view = await show();
  assert.ok(prompt(), "a day later");
  await view.unmount();
  dom.window.localStorage.setItem("reach.nudge.tailscale-app", JSON.stringify({ dismissed: 3, lastAt: 0, done: false }));
  view = await show();
  assert.equal(prompt(), null);
  assert.equal(nudges.nudgeRetired("tailscale-app"), true);
  await view.unmount();
});

test("the app connection on a phone never suggests getting the app", async () => {
  phone();
  const view = await show();
  assert.notEqual(prompt()?.getAttribute("aria-label"), "Get the Tailscale app");
  await view.unmount();
});

// S9: what a phone reads to put Reach on its Home Screen.
test("Home Screen metadata: standalone from /, icons, iPhone title", () => {
  const manifest = JSON.parse(fs.readFileSync("public/manifest.webmanifest", "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.ok(manifest.icons.some((i) => i.sizes === "192x192") && manifest.icons.some((i) => i.sizes === "512x512"));
  for (const page of ["index.html", "start.html"]) {
    const html = fs.readFileSync(page, "utf8");
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/, page);
    assert.match(html, /apple-touch-icon/, page);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Reach"/, page);
  }
});

test("private browsing (storage blocked): Not now holds for this visit, nothing breaks", async () => {
  phone();
  const real = Object.getOwnPropertyDescriptor(dom.window, "localStorage");
  const blocked = {
    getItem() {
      throw new dom.window.DOMException("blocked", "SecurityError");
    },
    setItem() {
      throw new dom.window.DOMException("blocked", "SecurityError");
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => blocked });
  try {
    const view = await show();
    assert.ok(prompt());
    await click(prompt().querySelector('[aria-label="Not now"]'));
    await view.unmount();
    const again = await show();
    assert.equal(prompt(), null, "not again during this visit");
    await again.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete globalThis.localStorage;
  }
});

// N3, N6: the way in, said the same in Home, More and Settings; signed in
// from the browser, "faster with the app" is a link to it.
test("More names the connection as Home does: Tailscale app, or Tailscale in browser", async () => {
  const { default: MoreSheet } = await dom.load("/src/MoreSheet.tsx");
  dom.window.HTMLDialogElement.prototype.showModal ??= function () {
    this.open = true;
  };
  const peer = { id: "mac", name: "Studio", url: APP_URL, token: "t", platform: "darwin" };
  const more = () =>
    dom.render(
      React.createElement(MoreSheet, {
        peer,
        device: { id: "mac", name: "Studio", platform: "darwin", capabilities: {} },
        places: ["files"],
        current: "overview",
        settings: true,
        peers: [peer],
        active: "mac",
        connections: { mac: { state: "connected" } },
        onNavigate() {},
        onChoose() {},
        onAdd() {},
        onClose() {},
      }),
    );
  phone();
  let view = await more();
  assert.match(view.container.querySelector(".more-computer small").textContent, /Tailscale app$/);
  await view.unmount();
  phone({ browserNode: true });
  view = await more();
  assert.match(view.container.querySelector(".more-computer small").textContent, /Tailscale in browser/);
  await view.unmount();
});
