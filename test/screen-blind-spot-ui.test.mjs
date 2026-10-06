import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Typing where the Mac can't see (a game, a canvas, a remote desktop): its
// text fields can't be found on a tap, so the keyboard can't open by itself.
// After a tap there, Screen shows its Type button; a tap where the Mac can
// see hides it again. Without it there was no way to type in those apps.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const device = {
  id: "mac",
  name: "Mac",
  platform: "darwin",
  arch: "arm64",
  release: "25.0",
  roots: [],
  memory: { total: 1, free: 1 },
  uptime: 1,
  network: { connected: true, peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
};

let screenDom, React, Screen, computer;
let surfaceDom, DesktopSurface;
before(async () => {
  screenDom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input-probe.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface-props.mjs",
    },
    routes: {
      "/api/screen/control": () => ({ enabled: true }),
      "/api/screen/displays": () => ({
        displays: [{ id: "primary", name: "Built-in", primary: true, width: 1470, height: 956, x: 0, y: 0 }],
      }),
    },
  });
  React = screenDom.React;
  ({ default: Screen } = await screenDom.load("/src/Screen.tsx"));
  ({ computer } = await screenDom.load("/test/dom/fakes/computer.mjs"));

});
after(async () => {
  await screenDom?.close();
  await surfaceDom?.close();
});
beforeEach(() => {
  if (screenDom) screenDom.errors.length = 0;
  computer.reset();
  computer.surface = null;
  computer.probeSupported = true;
});

const typeButton = () =>
  [...screenDom.document.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "Open phone keyboard");

test("Type remains available whether or not the computer can detect a field", async () => {
  const view = await screenDom.render(
    React.createElement(Screen, { peer, device, toast: () => {}, onChanged: () => {} }),
  );
  [...screenDom.document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Control").click();
  await screenDom.waitFor(() => computer.surface?.canControl);
  assert.equal(typeButton().length, 1, "manual keyboard stays available alongside detection");
  computer.surface.onBlind(true);
  await settle(20);
  assert.equal(typeButton().length, 1, "a game or a canvas: the button is there");
  computer.surface.onBlind(false);
  await settle(20);
  assert.equal(typeButton().length, 1);
  await view.unmount();
  assert.deepEqual(screenDom.errors, []);
});

test("the surface passes on the Mac's word that it can't see under the finger", async () => {
  await screenDom.close();
  screenDom = null;
  surfaceDom = await startDom({ mobile: true });
  ({ default: DesktopSurface } = await surfaceDom.load("/src/DesktopSurface.tsx"));
  surfaceDom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
  surfaceDom.window.HTMLElement.prototype.releasePointerCapture ??= function () {};
  surfaceDom.window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  const React = surfaceDom.React;
  const said = [];
  let answer = { field: false, blind: true };
  const canvas = React.createRef();
  const view = await surfaceDom.render(
    React.createElement(DesktopSurface, {
      canvas,
      width: 1000,
      height: 500,
      ready: true,
      connecting: false,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      send: async () => ({}),
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget() {},
      resetKey: "k",
      initialCursor: null,
      probe: async () => answer,
      onField() {},
      onBlind: (blind) => said.push(blind),
    }),
  );
  const video = view.container.querySelector("canvas");
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 });
  const stage = view.container.querySelector(".remote-stage");
  const tap = async (x, y) => {
    for (const type of ["pointerdown", "pointerup"])
      stage.dispatchEvent(
        new surfaceDom.window.PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "touch" }),
      );
    await settle(20);
  };
  await tap(400, 100);
  answer = { field: false };
  await tap(500, 300);
  assert.deepEqual(said, [true, false]);
  await view.unmount();
  assert.deepEqual(surfaceDom.errors, []);
});
