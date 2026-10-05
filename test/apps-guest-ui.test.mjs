import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// A guest on the Apps page: they watch the apps the owner has open on their
// phone, and can't open others. The page used to offer every app on the Mac,
// and every tap answered "Only the computer's owner can open or close apps".
const THREAD = {
  id: "t1",
  appId: "/Applications/Google Chrome.app",
  name: "Google Chrome",
  state: "running",
  createdAt: "2026-10-05T10:00:00Z",
  display: "901",
  region: { x: 352, y: 30, w: 500, h: 1084 },
  size: { w: 852, h: 1130 },
  scale: 2,
};
const mac = { threads: [] };
let dom, React, Apps;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
    },
    routes: {
      "/api/apps": () => [
        { id: THREAD.appId, name: THREAD.name },
        { id: "/System/Applications/Calculator.app", name: "Calculator" },
        { id: "/System/Applications/Notes.app", name: "Notes" },
      ],
      "/api/screen/apps": () => mac.threads,
    },
  });
  React = dom.React;
  ({ default: Apps } = await dom.load("/src/Apps.tsx"));
});
after(async () => dom?.close());

const peer = { id: "a", name: "Mac A", url: "https://reach.test:8443", token: "T", platform: "darwin" };
const guest = {
  name: "Mac A",
  platform: "darwin",
  features: {},
  access: { kind: "guest", scopes: ["device", "screen", "screen:control", "apps:open"] },
};
const page = (device, changes = "a") =>
  dom.render(
    React.createElement(Apps, {
      peer,
      device,
      toast: () => {},
      screen: () => {},
      changes: JSON.stringify({ apps: changes }),
    }),
  );
const names = () => [...dom.document.querySelectorAll(".app-tile")].map((t) => t.textContent.trim());

test("a guest sees no Mac apps to tap, and says when nothing is open yet", async () => {
  mac.threads = [];
  const view = await page(guest);
  await settle(200);
  assert.deepEqual(names(), []);
  assert.equal(dom.document.querySelector(".apps-search"), null, "nothing to search");
  assert.match(dom.document.body.textContent, /No apps open yet/);
  await view.unmount();
});

test("a guest sees the apps open on the owner's phone, to watch", async () => {
  mac.threads = [THREAD];
  const view = await page(guest, "b");
  await dom.waitFor(() => dom.document.querySelector('[aria-label="On your phone"]'));
  assert.match(dom.document.querySelector('[aria-label="On your phone"]').textContent, /Google Chrome/);
  assert.equal(dom.document.querySelector('[aria-label="All apps"]'), null);
  assert.doesNotMatch(dom.document.body.textContent, /No apps open yet/);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("the owner still gets every app to open", async () => {
  mac.threads = [];
  const view = await page({ name: "Mac A", platform: "darwin", features: {} }, "c");
  await dom.waitFor(() => names().length === 3);
  assert.ok(dom.document.querySelector(".apps-search"));
  await view.unmount();
});
