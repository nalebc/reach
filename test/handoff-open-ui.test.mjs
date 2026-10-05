import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Home's "needs you" card for an app an agent handed you: Open goes to the
// Apps page, which opens exactly that app (its stream starts on its thread).
let dom, React, Apps, handoffs, computer;
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
  agent: "Claude",
};
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
    },
    routes: {
      "/api/apps": () => [{ id: THREAD.appId, name: THREAD.name }],
      "/api/screen/apps": () => [THREAD],
      "/api/screen/apps/t1/fields": () => ({ fields: [], complete: true }),
    },
  });
  React = dom.React;
  ({ default: Apps } = await dom.load("/src/Apps.tsx"));
  handoffs = await dom.load("/src/handoffs.tsx");
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(async () => dom?.close());

const peer = {
  id: "a",
  name: "Mac A",
  url: "https://reach.test:8443",
  token: "T",
  platform: "darwin",
};
const device = { name: "Mac A", platform: "darwin", features: {} };

test("Apps opens the app an agent handed you, once", async () => {
  computer.reset();
  handoffs.requestOpenThread("a", "t1");
  const view = await dom.render(
    React.createElement(Apps, {
      peer,
      device,
      toast: () => {},
      screen: () => {},
      changes: JSON.stringify({ apps: "x" }),
    }),
  );
  await dom.waitFor(() => computer.stream);
  assert.deepEqual(computer.stream, { display: "901", thread: "t1" });
  assert.equal(handoffs.takeOpenRequest("a"), null, "taken");
  await view.unmount();
});

test("without a request, Apps opens nothing by itself", async () => {
  computer.reset();
  const view = await dom.render(
    React.createElement(Apps, {
      peer,
      device,
      toast: () => {},
      screen: () => {},
      changes: JSON.stringify({ apps: "x" }),
    }),
  );
  await settle(150);
  assert.equal(computer.stream, null);
  await view.unmount();
});
