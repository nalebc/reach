import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// A page whose code loads when first opened (Screen, Terminals) still opens
// when the connection drops while it loads, and Try again loads it afresh,
// never the failure React kept. Windows CI, Oct 25: one stylesheet the phone
// couldn't fetch left Screen on "This screen couldn't open" for good.
let dom, lazyPage, ScreenBoundary, view;
before(async () => {
  dom = await startDom();
  ({ lazyPage } = await dom.load("/src/lazy-page.ts"));
  ScreenBoundary = (await dom.load("/src/ScreenBoundary.tsx")).default;
});
after(() => dom?.close());
afterEach(async () => {
  await view?.unmount();
  view = null;
});
const h = (...args) => dom.React.createElement(...args);
const loaded = (text) => ({ default: () => h("p", { className: "loaded-page" }, text) });
const open = async (Page) => (view = await dom.render(h(ScreenBoundary, null, h(Page))));
// What Vite's preload rejects with when a page's stylesheet can't be fetched
// (the CI case): before the page's script is imported, so asking again is a
// first fetch. (Chrome keeps a failed script import; that one needs a reload.)
const dropped = () => new Error("Unable to preload CSS for /assets/r2-KeyRow-test.css");

test("a page whose load fails once opens on its own", async () => {
  let calls = 0;
  const Page = lazyPage(async () => {
    if (++calls === 1) throw dropped();
    return loaded("The screen");
  }, [0]);
  await open(Page);
  await dom.waitFor(() => dom.document.querySelector(".loaded-page"));
  assert.equal(calls, 2);
  assert.doesNotMatch(dom.document.body.textContent, /couldn’t open/);
  assert.deepEqual(dom.errors, []);
});

test("after every try fails, Try again loads the page afresh", async () => {
  let calls = 0,
    down = true;
  const Page = lazyPage(async () => {
    calls++;
    if (down) throw dropped();
    return loaded("The screen");
  }, [0, 0]);
  await open(Page);
  await dom.waitFor(() => dom.document.body.textContent.includes("This screen couldn’t open"));
  assert.equal(calls, 3, "the first try and two more");
  await settle(100);
  assert.equal(calls, 3, "nothing more is asked while the page says it couldn't open");
  down = false;
  [...dom.document.querySelectorAll("button")].find((b) => b.textContent.includes("Try again")).click();
  await dom.waitFor(() => dom.document.querySelector(".loaded-page"));
  assert.equal(calls, 4, "Try again asks once more");
  assert.ok(dom.errors.length > 0 && dom.errors.every((e) => e.includes("Unable to preload CSS")), dom.errors.join("\n"));
  dom.errors.length = 0;
});

test("a page that couldn't load loads afresh when it's opened again", async () => {
  let calls = 0,
    down = true;
  const Page = lazyPage(async () => {
    calls++;
    if (down) throw dropped();
    return loaded("The screen");
  }, []);
  await open(Page);
  await dom.waitFor(() => dom.document.body.textContent.includes("This screen couldn’t open"));
  await view.unmount();
  down = false;
  await open(Page);
  await dom.waitFor(() => dom.document.querySelector(".loaded-page"));
  assert.equal(calls, 2);
  dom.errors.length = 0;
});

test("a stylesheet that failed is put back before the page loads again", async () => {
  const href = "/assets/r2-KeyRow-test.css";
  const dead = dom.document.createElement("link");
  dead.rel = "stylesheet";
  dead.href = href;
  dead.crossOrigin = "";
  dom.document.head.append(dead);
  dead.dispatchEvent(new dom.window.Event("error"));
  let sheets;
  const Page = lazyPage(async () => {
    sheets = [...dom.document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => l.getAttribute("href") === href);
    return loaded("The screen");
  }, []);
  await open(Page);
  await dom.waitFor(() => dom.document.querySelector(".loaded-page"));
  assert.equal(sheets.length, 1, "one link for it");
  assert.notEqual(sheets[0], dead, "a fresh one, fetched again");
  assert.equal(sheets[0].crossOrigin, "", "as Vite made it");
  assert.equal(dead.isConnected, false);
  sheets[0].remove();
  assert.deepEqual(dom.errors, []);
});
