import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startDom } from "./dom/harness.mjs";

let dom, openReach;
before(async () => {
  dom = await startDom();
  ({ openReach } = await dom.load("/src/app-boot.ts"));
});
after(async () => dom?.close());
afterEach(() => {
  dom.document.body.replaceChildren();
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  dom.errors.length = 0;
});

function page({ publicStart = false } = {}) {
  const root = dom.document.createElement("div");
  root.id = "root";
  const loading = dom.document.createElement("main");
  loading.id = publicStart ? "start" : "reach-startup";
  loading.textContent = "Opening Reach…";
  if (publicStart) dom.document.body.append(loading, root);
  else {
    root.append(loading);
    dom.document.body.append(root);
  }
  return { root, loading };
}

test("the initial HTML stays visible before any JavaScript or stylesheet can load", async () => {
  for (const filename of ["index.html", "start.html"]) {
    const html = await fs.readFile(new URL(`../${filename}`, import.meta.url), "utf8");
    const parsed = new dom.window.DOMParser().parseFromString(html, "text/html");
    const loading = parsed.querySelector('[role="status"]');
    assert.match(loading.textContent, /Opening Reach/);
    assert.match(loading.textContent, /refresh/);
    assert.match(loading.getAttribute("style"), /min-height:100dvh/);
  }
});

test("a failed workspace import leaves the public connection screen attached with an explicit reload", async () => {
  const { root, loading } = page({ publicStart: true });
  let rejectLoad;
  const started = openReach(() => new Promise((_resolve, reject) => { rejectLoad = reject; }), loading);
  assert.equal(loading.isConnected, true);
  assert.equal(root.childElementCount, 0);
  rejectLoad(new Error("Cannot fetch workspace chunk"));
  assert.equal(await started, false);
  assert.equal(loading.isConnected, true);
  assert.match(loading.querySelector('[role="alert"]').textContent, /Reach couldn't open/);
  assert.equal(loading.querySelector("a").textContent, "Reload Reach");
  assert.equal(dom.errors.length, 1, "the load failure remains available to diagnostics");
});

test("recovery preserves saved owner and guest access, the invitation fragment, and the current connection URL", async () => {
  const { loading } = page();
  const original = "/guest?connection=browser#i=fixture-invitation";
  dom.window.history.replaceState(null, "", original);
  dom.window.localStorage.setItem("reach.devices", "saved-owner-pairing");
  dom.window.sessionStorage.setItem("reach.guest-session", "saved-guest-access");
  assert.equal(await openReach(() => Promise.reject(new Error("Private diagnostic only"))), false);
  const url = new URL(loading.querySelector("a").href);
  assert.equal(url.origin, dom.window.location.origin);
  assert.equal(url.pathname, "/guest");
  assert.equal(url.searchParams.get("connection"), "browser");
  assert.match(url.searchParams.get("reach-update"), /^\d+$/);
  assert.equal(url.hash, "#i=fixture-invitation");
  assert.equal(dom.window.location.pathname + dom.window.location.search + dom.window.location.hash, original, "failed loads never retry or navigate automatically");
  assert.equal(dom.window.localStorage.getItem("reach.devices"), "saved-owner-pairing");
  assert.equal(dom.window.sessionStorage.getItem("reach.guest-session"), "saved-guest-access");
  assert.doesNotMatch(loading.textContent, /Private diagnostic only/);
});

test("successful startup removes the loading view only after the import finishes", async () => {
  const { root, loading } = page({ publicStart: true });
  let complete;
  const started = openReach(() => new Promise(resolve => { complete = resolve; }), loading);
  assert.equal(loading.isConnected, true);
  root.textContent = "Workspace is open";
  complete({});
  assert.equal(await started, true);
  assert.equal(loading.isConnected, false);
  assert.equal(root.textContent, "Workspace is open");
  assert.deepEqual(dom.errors, []);
});

test("an import that already replaced the startup view can still display recovery in the root", async () => {
  const { root, loading } = page();
  const started = openReach(async () => {
    loading.remove();
    throw new Error("Module evaluation failed");
  }, loading);
  assert.equal(await started, false);
  assert.match(root.querySelector('[role="alert"]').textContent, /Reach couldn't open/);
});
