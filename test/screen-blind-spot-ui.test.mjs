import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// Manual typing remains available with or without automatic field detection.
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
});
beforeEach(() => {
  if (screenDom) screenDom.errors.length = 0;
  computer.reset();
  computer.surface = null;
  computer.probeSupported = true;
});

const typeButton = () =>
  [...screenDom.document.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "Open phone keyboard");

test("Type remains available with or without field detection", async () => {
  for (const probeSupported of [true, false]) {
    computer.probeSupported = probeSupported;
    const view = await screenDom.render(
      React.createElement(Screen, { peer, device, toast: () => {}, onChanged: () => {} }),
    );
    [...screenDom.document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Control").click();
    await screenDom.waitFor(() => computer.surface?.canControl);
    assert.equal(typeButton().length, 1, "manual keyboard stays available alongside detection");
    await view.unmount();
    computer.surface = null;
  }
  assert.deepEqual(screenDom.errors, []);
});
