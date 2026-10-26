import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Pausing Reach from the phone, through the real Screen, AppThread and pause
// components. The video stream, input socket and canvas are stand-ins
// (test/dom/fakes); `computer.lease` models the Mac's control grant. Each
// test checks what the phone asks of the computer, so a stream or control
// that keeps running while paused, or doesn't come back after, fails it.

const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "test-token",
  platform: "darwin",
};
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
  capabilities: {
    files: true,
    terminal: true,
    apps: true,
    screen: true,
    codex: false,
  },
};
const PAUSED = JSON.stringify({ paused: true });
const ON = JSON.stringify({});

let dom, React, Screen, AppThread, PauseButton, computer;
const asked = [];
// The computer's answer to a pause, when it refuses one.
let refuse = "";
let holdPause;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      // The Mac grants control, like server/screen.mjs.
      "/api/screen/control": (init) => {
        const { enabled } = JSON.parse(init.body);
        asked.push(["control", enabled]);
        if (enabled) computer.lease = true;
        return { enabled };
      },
      "/api/settings/pause": async (init) => {
        if (refuse) throw new Error(refuse);
        const { paused } = JSON.parse(init.body);
        asked.push(["pause", paused]);
        if (holdPause) await holdPause;
        return { paused };
      },
      "/api/screen/displays": () => ({ displays: [] }),
      "/api/screen/apps/t1/fields": () => ({ fields: [], complete: true }),
    },
  });
  React = dom.React;
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ default: AppThread } = await dom.load("/src/AppThread.tsx"));
  ({ PauseButton } = await dom.load("/src/PauseControl.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  asked.length = 0;
  refuse = "";
  holdPause = undefined;
  computer.reset();
});

const button = (label) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent.trim() === label,
  );
const cover = () => dom.document.querySelector(".paused-cover");

// A page whose computer's change fingerprints the test sets, as its live
// connection would.
async function withChanges(Component, props, changes) {
  let set;
  function Host() {
    const [value, setValue] = React.useState(changes);
    set = setValue;
    return React.createElement(Component, { ...props, changes: value });
  }
  const view = await dom.render(React.createElement(Host));
  return {
    view,
    change: async (value) => {
      dom.update(() => set(value));
      await settle(30);
    },
  };
}

test("the Screen stops streaming and controlling while paused, and both come back on resume", async () => {
  computer.lease = false;
  const { view, change } = await withChanges(
    Screen,
    { peer, device, toast() {}, onChanged() {} },
    ON,
  );
  try {
    button("Control").click();
    await dom.waitFor(() => computer.connected === "primary");
    assert.deepEqual(computer.stream, {
      display: "primary",
      thread: undefined,
    });

    computer.stream = null;
    await change(PAUSED);
    // A slow runner can take longer than change()'s own pause to let go.
    await dom.waitFor(() => computer.connected === null && cover(), 2000);
    // No video asked for, control let go, and the screen says why.
    assert.equal(computer.stream, null);
    assert.equal(computer.connected, null);
    assert.ok(cover(), "the paused cover shows");
    assert.equal(
      dom.document.querySelector(".screen-state").textContent.trim(),
      "Paused",
    );
    assert.equal(!!button("Control"), false, "no Control while paused");
    assert.equal(!!dom.document.querySelector(".error-line"), false);

    // Resume from the cover asks the computer, then everything returns as
    // soon as it says it's on again.
    button("Resume").click();
    await dom.waitFor(() => asked.some(([what]) => what === "pause"));
    await change(ON);
    await dom.waitFor(() => computer.connected === "primary");
    assert.deepEqual(computer.stream, {
      display: "primary",
      thread: undefined,
    });
    assert.equal(!!cover(), false);
    assert.deepEqual(asked, [
      ["control", true],
      ["control", false],
      ["pause", false],
      ["control", true],
    ]);
    assert.deepEqual(dom.errors, []);
  } finally {
    await view.unmount();
  }
});

test("control the Mac ended because of the pause comes back on resume, without an error", async () => {
  computer.lease = false;
  const { view, change } = await withChanges(
    Screen,
    { peer, device, toast() {}, onChanged() {} },
    ON,
  );
  button("Control").click();
  await dom.waitFor(() => computer.connected === "primary");
  // The Mac's input socket closes first, with its reason, then the change
  // arrives.
  computer.endInput("Reach is paused on this Mac.");
  await settle(30);
  assert.equal(!!dom.document.querySelector(".error-line"), false);
  await change(PAUSED);
  await change(ON);
  await dom.waitFor(() => computer.connected === "primary");
  assert.deepEqual(
    asked.filter(([, enabled]) => enabled === true),
    [
      ["control", true],
      ["control", true],
    ],
  );
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("someone invited sees the pause but can't resume it; a screen that wasn't controlled isn't taken over", async () => {
  const guest = {
    ...device,
    access: {
      kind: "guest",
      scopes: ["screen", "screen:control"],
      expiresAt: Date.now() + 60000,
    },
  };
  const { view, change } = await withChanges(
    Screen,
    { peer, device: guest, toast() {}, onChanged() {} },
    PAUSED,
  );
  assert.ok(cover());
  assert.equal(!!button("Resume"), false);
  assert.match(cover().textContent, /Reach is paused on this Mac/);
  await change(ON);
  await dom.waitFor(() => computer.stream?.display === "primary");
  assert.deepEqual(asked, []);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("an open app shows the pause and comes back by itself on resume", async () => {
  const running = {
    id: "t1",
    appId: "/Applications/Safari.app",
    name: "Safari",
    state: "running",
    createdAt: "2026-10-05T00:00:00Z",
    display: "901",
    region: { x: 0, y: 0, w: 393, h: 852 },
    size: { w: 800, h: 900 },
    scale: 2,
  };
  const held = {
    ...running,
    state: "paused",
    held: true,
    display: undefined,
    region: undefined,
    size: undefined,
  };
  let set;
  let left = 0;
  function Host() {
    const [state, setState] = React.useState({
      thread: running,
      paused: false,
    });
    set = setState;
    return React.createElement(AppThread, {
      peer,
      thread: state.thread,
      threads: [state.thread],
      paused: state.paused,
      owner: true,
      onLeave: () => left++,
      onSwitch() {},
      onReturn() {},
      onQuit() {},
      onReopen() {},
      onUpdate() {},
    });
  }
  const view = await dom.render(React.createElement(Host));
  await dom.waitFor(() => computer.stream?.thread === "t1");
  computer.stream = null;
  set({ thread: held, paused: true });
  await settle(30);
  assert.equal(computer.stream, null);
  assert.ok(cover(), "the paused cover shows instead of 'back on the Mac'");
  assert.doesNotMatch(dom.document.body.textContent, /Open again/);
  button("Back to Reach").click();
  assert.equal(left, 1);
  set({ thread: running, paused: false });
  await dom.waitFor(() => computer.stream?.thread === "t1");
  assert.equal(!!cover(), false);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("right after resume, an app on its way back says it's opening, never 'back on the Mac'", async () => {
  const returning = {
    id: "t1",
    appId: "/Applications/Safari.app",
    name: "Safari",
    state: "paused",
    held: true,
    createdAt: "2026-10-05T00:00:00Z",
  };
  const view = await dom.render(
    React.createElement(AppThread, {
      peer,
      thread: returning,
      threads: [returning],
      paused: false,
      owner: true,
      onLeave() {},
      onSwitch() {},
      onReturn() {},
      onQuit() {},
      onReopen() {},
      onUpdate() {},
    }),
  );
  const text = dom.document.body.textContent;
  assert.match(text, /Opening Safari…/);
  assert.doesNotMatch(text, /Open again|back on the Mac/);
  assert.equal(!!cover(), false);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("the pause pill says Pause, or Paused when on, and names the computer it pauses", async () => {
  const pill = (platform, paused) =>
    dom.render(React.createElement(PauseButton, { peer, paused, platform }));
  // On: an icon and the word, not pressed.
  let view = await pill("darwin", false);
  let on = dom.document.querySelector("button.pause-button");
  assert.equal(on.getAttribute("aria-label"), "Pause Reach on your Mac");
  assert.equal(on.getAttribute("aria-pressed"), "false");
  assert.equal(on.textContent.trim(), "Pause");
  assert.ok(on.querySelector("svg"), "an icon beside the word");
  assert.equal(on.classList.contains("is-paused"), false);
  await view.unmount();
  // Paused: the same name, pressed, lit, and the word says so.
  view = await pill("darwin", true);
  on = dom.document.querySelector("button.pause-button");
  assert.equal(on.getAttribute("aria-label"), "Pause Reach on your Mac");
  assert.equal(on.getAttribute("aria-pressed"), "true");
  assert.equal(on.textContent.trim(), "Paused");
  assert.equal(on.classList.contains("is-paused"), true);
  assert.equal(on.getAttribute("title"), "Resume Reach on your Mac");
  await view.unmount();
  // A Windows host is named as such.
  view = await pill("win32", true);
  on = dom.document.querySelector("button.pause-button");
  assert.equal(on.getAttribute("aria-label"), "Pause Reach on your Windows PC");
  assert.equal(on.textContent.trim(), "Paused");
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("the pause button switches at once and asks the computer; a refusal puts it back", async () => {
  const toasts = [];
  const view = await dom.render(
    React.createElement(PauseButton, {
      peer,
      paused: false,
      platform: "darwin",
      toast: (m) => toasts.push(m),
    }),
  );
  let confirm;
  holdPause = new Promise(resolve => { confirm = resolve; });
  const pause = button("Pause Reach on your Mac");
  assert.equal(pause.getAttribute("aria-pressed"), "false");
  pause.click();
  await dom.waitFor(
    () => button("Pause Reach on your Mac")?.getAttribute("aria-pressed") === "true",
  );
  assert.equal(button("Pause Reach on your Mac").textContent.trim(), "Paused");
  assert.deepEqual(asked, [["pause", true]]);
  assert.equal(pause.getAttribute("aria-busy"), "true");
  assert.equal(pause.disabled, true);
  assert.deepEqual(toasts, [], "success waits for the computer");
  pause.click();
  assert.equal(asked.length, 1, "pending tap cannot submit twice");
  confirm();
  await dom.waitFor(() => toasts.length === 1);
  assert.deepEqual(toasts, ["Reach paused"]);
  toasts.length = 0;
  holdPause = undefined;
  await view.unmount();

  // Not the owner (or the computer can't): it says why and stays as it was.
  refuse = "Only the owner can pause Reach.";
  const shown = await dom.render(
    React.createElement(PauseButton, {
      peer,
      paused: false,
      platform: "win32",
      toast: (m) => toasts.push(m),
    }),
  );
  button("Pause Reach on your Windows PC").click();
  await dom.waitFor(() => toasts.length === 1);
  await settle(30);
  assert.equal(button("Pause Reach on your Windows PC").getAttribute("aria-pressed"), "false");
  assert.equal(button("Pause Reach on your Windows PC").textContent.trim(), "Pause");
  assert.deepEqual(toasts, ["Only the owner can pause Reach."]);
  assert.deepEqual(dom.errors, []);
  await shown.unmount();
});
