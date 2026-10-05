import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Two people on one Mac: the Screen page never takes control silently. When
// someone else controls, Control says who and becomes Take over (for you, from
// a guest); a guest gets no Take over from you. When control changes hands,
// the button goes back to Control.
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
const mac = { holder: null, sent: [] };
let dom, React, Screen;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": (init) => {
        const body = JSON.parse(init.body);
        mac.sent.push(body);
        if (mac.holder && body.enabled && !(body.takeover && mac.holder.canTakeOver))
          return new Response(
            JSON.stringify({
              error: `${mac.holder.name} is controlling the screen. You can watch.`,
              holder: { name: mac.holder.name, guest: mac.holder.guest },
              canTakeOver: mac.holder.canTakeOver,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        return { enabled: body.enabled };
      },
      "/api/screen/displays": () => ({
        displays: [{ id: "primary", name: "Built-in", primary: true, width: 1470, height: 956, x: 0, y: 0 }],
      }),
    },
  });
  React = dom.React;
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  mac.holder = null;
  mac.sent = [];
});
const button = (label) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label,
  );
async function screen(changes = '{"control":"a"}') {
  let setChanges;
  function Host() {
    const [value, set] = React.useState(changes);
    setChanges = set;
    return React.createElement(Screen, { peer, device, changes: value, toast: () => {}, onChanged: () => {} });
  }
  const view = await dom.render(React.createElement(Host));
  await dom.waitFor(() => button("Control"));
  return {
    view,
    changed: async (value) => {
      setChanges(value);
      await settle(30);
    },
  };
}

test("Control while your guest controls says who and becomes Take over", async () => {
  mac.holder = { name: "Ali", guest: true, canTakeOver: true };
  const { view } = await screen();
  button("Control").click();
  await dom.waitFor(() => button("Take over"));
  assert.match(dom.document.body.textContent, /Ali is controlling the screen/);
  assert.deepEqual(mac.sent, [{ enabled: true }], "asked, never took it silently");
  button("Take over").click();
  await dom.waitFor(() => button("Stop"));
  assert.deepEqual(mac.sent.at(-1), { enabled: true, takeover: true });
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("a guest gets no Take over from the owner; Control comes back when it's free", async () => {
  mac.holder = { name: "Owner", guest: false, canTakeOver: false };
  const { view, changed } = await screen();
  button("Control").click();
  await settle(100);
  assert.equal(button("Take over"), undefined);
  assert.ok(button("Control"));
  assert.match(dom.document.body.textContent, /Owner is controlling the screen/);
  // The owner lets go: the live connection says control changed hands.
  mac.holder = null;
  await changed('{"control":"b"}');
  assert.doesNotMatch(dom.document.body.textContent, /is controlling the screen/);
  button("Control").click();
  await dom.waitFor(() => button("Stop"));
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
