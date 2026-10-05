import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// A Mac dialog answered on the live screen: Screen opens on the display it is
// on, zoomed onto it, takes control (the "Show on screen" tap asked for it),
// and says what to do; once the dialog is gone, it says so and goes back.
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
const mac = { sent: [] };
let dom, React, Screen, focusView;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": (init) => (mac.sent.push(JSON.parse(init.body)), { enabled: true }),
      "/api/screen/displays": () => ({
        displays: [
          { id: "1", name: "Built-in", primary: true, width: 1512, height: 982, x: 0, y: 0 },
          { id: "2", name: "Studio Display", primary: false, width: 2560, height: 1440, x: 1512, y: 0 },
        ],
      }),
    },
  });
  React = dom.React;
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ focusView } = await dom.load("/src/desktop-geometry.ts"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  mac.sent = [];
});
const $ = (s) => dom.document.querySelector(s);
const button = (label) => [...dom.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const ask = {
  id: "41",
  title: "“claude” would like to control this computer using accessibility features.",
  // On the second display, 260×314 points.
  bounds: { x: 1512 + 1150, y: 563, width: 260, height: 314 },
  setting: { name: "Accessibility", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" },
  open: true,
};

test("Screen opens on a Mac dialog: its display, zoomed onto it, control on, and what to do", async () => {
  let done = 0;
  const settings = [];
  let setAsk;
  function Host() {
    const [value, set] = React.useState(ask);
    setAsk = set;
    return React.createElement(Screen, {
      peer,
      device,
      changes: '{"control":"a"}',
      toast: () => {},
      onChanged: () => {},
      ask: value,
      onAskDone: () => done++,
      onAskSetting: async () => (settings.push(value.id), "Opened on your Mac: switch on “claude” in Accessibility."),
    });
  }
  const view = await dom.render(React.createElement(Host));
  await dom.waitFor(() => $(".screen-ask"));
  assert.equal($(".screen-ask strong").textContent, ask.title);
  assert.equal($(".screen-ask span").textContent, "Tap its button on the screen below to answer it.");
  // The display it is on, and the dialog's place on it.
  await dom.waitFor(() => $(".fake-desktop[data-focus]"));
  const focus = JSON.parse($(".fake-desktop").getAttribute("data-focus"));
  assert.deepEqual(focus, { x: 1150 / 2560, y: 563 / 1440, width: 260 / 2560, height: 314 / 1440 });
  // Control was asked for by the tap that opened this.
  await dom.waitFor(() => mac.sent.length > 0);
  assert.deepEqual(mac.sent[0], { enabled: true });
  // Its System Settings page, if tapping doesn't do it.
  button("Open setting on Mac").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => $(".screen-ask small").textContent.startsWith("Opened on your Mac"));
  assert.deepEqual(settings, ["41"]);
  // Answered on the Mac: said, and Back.
  setAsk({ ...ask, open: false });
  await dom.waitFor(() => $(".screen-ask.done"));
  assert.equal($(".screen-ask strong").textContent, "Dialog closed");
  button("Back").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(20);
  assert.equal(done, 1);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("the view frames the dialog: zoomed to fill the stage (up to 4×), centered on it", () => {
  // A 260×314 dialog in the middle of a 1512×982 screen, shown on a 375×700 stage at fit width.
  const area = { x: (1512 / 2 - 130) / 1512, y: (982 / 2 - 157) / 982, width: 260 / 1512, height: 314 / 982 };
  const view = focusView(area, 375, 375 * (982 / 1512), 375, 700);
  assert.ok(view.scale > 4 - 1e-9, "a small dialog: as close as allowed");
  assert.ok(Math.abs(view.x) < 1e-6 && Math.abs(view.y) < 1e-6, "centered: no pan for a centered dialog");
  // Off to the right: panned left to bring it to the middle.
  const right = focusView({ ...area, x: 0.75 }, 375, 244, 375, 700);
  assert.ok(right.x < 0);
  // A big area never zooms out below the whole screen.
  assert.equal(focusView({ x: 0, y: 0, width: 1, height: 1 }, 375, 244, 375, 700).scale, 1);
});

test("a Mac password dialog: the password is entered in Reach and sent only to that dialog, never typed blind", async () => {
  const sent = [];
  function Host() {
    return React.createElement(Screen, {
      peer,
      device,
      changes: '{"control":"a"}',
      toast: () => {},
      onChanged: () => {},
      ask: { id: "77", kind: "password", title: "Your Mac is asking for your password", bounds: { x: 600, y: 300, width: 400, height: 250 }, open: true },
      onAskDone: () => {},
      onAskPassword: async (password) => sent.push(password),
    });
  }
  const view = await dom.render(React.createElement(Host));
  await dom.waitFor(() => $(".screen-ask"));
  assert.equal($(".screen-ask span").textContent, "Enter it here: Reach types it only into that dialog. It isn't kept.");
  // No blind keyboard (keys to whatever has focus): the guarded field only.
  assert.equal(button("Type password"), undefined);
  const field = $(".screen-ask .mac-password input[type=password]");
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setValue.call(field, "pw-123");
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle(10);
  $(".screen-ask .mac-password").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await dom.waitFor(() => sent.length === 1);
  assert.deepEqual(sent, ["pw-123"]);
  assert.equal($(".screen-ask .mac-password input").value, "");
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});


test("a dialog without screen coordinates still keeps its guidance and return path", async () => {
  let done = 0;
  const view = await dom.render(React.createElement(Screen, {
    peer, device, toast: () => {}, onChanged: () => {},
    ask: { ...ask, bounds: undefined }, onAskDone: () => done++,
  }));
  await dom.waitFor(() => $(".screen-ask"));
  assert.equal($(".screen-ask strong").textContent, ask.title);
  assert.match($(".screen-ask small").textContent, /approve on the Mac itself/);
  assert.equal($(".fake-desktop[data-focus]"), null);
  button("Done").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(20);
  assert.equal(done, 1);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("screen access off preserves the request and does not start control", async () => {
  let done = 0;
  const view = await dom.render(React.createElement(Screen, {
    peer, device: { ...device, capabilities: { ...device.capabilities, screen: false } },
    toast: () => {}, onChanged: () => {}, ask: { ...ask, bounds: undefined }, onAskDone: () => done++,
  }));
  await dom.waitFor(() => $(".screen-ask"));
  assert.match($(".screen-ask").textContent, /grant it on the Mac first/);
  assert.ok(mac.sent.every((action) => action.enabled === false), "opening an unavailable screen does not acquire control");
  button("Back to request").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(20);
  assert.equal(done, 1);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});
