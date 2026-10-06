import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// While Screen connects there's no picture yet: the stream is 0×0. The viewer
// took its shape from that and collapsed to a thin bar, hiding the plug-in
// scene. It keeps a screen's shape instead: 16:10 at first, then the last
// screen's, through a reconnect.
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
let dom, React, Screen, computer;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": () => ({ enabled: true }),
      "/api/screen/displays": () => ({ displays: [] }),
    },
  });
  React = dom.React;
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());

test("the viewer keeps a screen's shape while it connects", async () => {
  computer.size = { width: 0, height: 0 };
  const view = await dom.render(
    React.createElement(Screen, { peer, device, toast: () => {}, onChanged: () => {} }),
  );
  await settle(40);
  const viewer = () => dom.document.querySelector(".simple-screen");
  const shape = () => Number(viewer().style.getPropertyValue("--screen-aspect"));
  assert.equal(shape(), 1.6, "16:10 before any picture, never 0");
  assert.ok(viewer().classList.contains("screen-waiting"), "room for the plug-in scene");
  computer.size = { width: 1512, height: 982 };
  computer.frame();
  await settle();
  assert.equal(shape(), 1512 / 982, "the screen's own shape once it's here");
  computer.size = { width: 0, height: 0 };
  computer.frame();
  await settle();
  assert.equal(shape(), 1512 / 982, "kept through a reconnect");
  await view.unmount();
  computer.reset();
  assert.deepEqual(dom.errors, []);
});

test("while it waits, the stage is tall enough for the scene, and the scene fits it", () => {
  const css = fs.readFileSync(new URL("../src/screen-immersive.css", import.meta.url), "utf8");
  assert.match(css, /\.simple-screen\.screen-waiting:not\(\.screen-expanded\) \.remote-stage \{\s*min-height: clamp\(280px/);
  const identity = fs.readFileSync(new URL("../src/identity.css", import.meta.url), "utf8");
  assert.match(identity, /\.screen-connection \{\s*container-type: size;/);
  assert.match(identity, /\.screen-connection \.connection-device \{\s*width: min\(100%, calc\(\(100cqh/);
});
