import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// Apps on your phone, phone side: the real AppThread and AppSurface, with the
// stream and input socket as stand-ins (test/dom/fakes). Each test checks what
// reaches the Mac, in display coordinates, for a touch on the phone.
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "t",
  platform: "darwin",
};
// Chrome's 500×1084 pt window, flush right under the menu bar of an
// 852×1130 pt hidden display; on the phone it fills 393×852 CSS px.
const chrome = {
  id: "t1",
  appId: "/Applications/Google Chrome.app",
  name: "Google Chrome",
  state: "running",
  createdAt: "2026-10-04T20:00:00.000Z",
  display: "901",
  region: { x: 352, y: 30, w: 500, h: 1084 },
  size: { w: 852, h: 1130 },
  scale: 2,
};
const notes = {
  ...chrome,
  id: "t2",
  appId: "/System/Applications/Notes.app",
  name: "Notes",
  display: "902",
};
const shown = { left: 0, top: 44, width: 393, height: 852 };
const toDisplay = (u, v, t = chrome) => ({
  x: (t.region.x + u * t.region.w) / t.size.w,
  y: (t.region.y + v * t.region.h) / t.size.h,
});
// Display coordinates are fractions; compare them to a millionth.
const rounded = (list) =>
  list.map((a) =>
    Object.fromEntries(
      Object.entries(a).map(([k, v]) => [
        k,
        typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v,
      ]),
    ),
  );
const same = (actual, expected) =>
  assert.deepEqual(rounded(actual), rounded(expected));
// Screen point for a spot on the shown window.
const at = (u, v) => ({
  x: shown.left + u * shown.width,
  y: shown.top + v * shown.height,
});

let dom, React, AppThread, computer;
const requests = [];
// What the Mac answers about text fields and quitting, per test.
const mac = { fields: [], quits: [], holder: null };
// Views still on screen; a failed test must not leave its overlay behind
// for the next one to find.
const views = new Set();
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
    },
    routes: {
      "/api/screen/control": (init) => {
        const body = JSON.parse(init.body);
        requests.push(["control", body]);
        // Someone else controls: the Mac says who, unless this is Take over.
        if (mac.holder && body.enabled && !(body.takeover && mac.holder.canTakeOver))
          return new Response(
            JSON.stringify({
              error: `${mac.holder.name} is controlling the screen. You can watch.`,
              holder: { name: mac.holder.name, guest: true },
              canTakeOver: mac.holder.canTakeOver,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        if (body.takeover) mac.holder = null;
        if (computer.lease !== undefined) computer.lease = body.enabled;
        return { enabled: body.enabled };
      },
      "/api/screen/apps/t1/fields": () => {
        requests.push(["fields"]);
        return { fields: mac.fields, complete: true };
      },
      "/api/screen/apps/t1/quit": (init) => {
        const body = JSON.parse(init.body);
        requests.push(["quit", body]);
        return mac.quits.shift() ?? { quit: true };
      },
      "/api/screen/apps/t1": (init) => {
        const body = JSON.parse(init.body);
        requests.push([init.method, body]);
        return {
          ...chrome,
          region: { x: 0, y: 30, w: body.width, h: body.height },
        };
      },
    },
  });
  React = dom.React;
  ({ default: AppThread } = await dom.load("/src/AppThread.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
});
beforeEach(() => {
  dom.errors.length = 0;
  requests.length = 0;
  mac.fields = [];
  mac.quits = [];
  mac.holder = null;
  computer.reset();
  computer.size = { width: 1000, height: 2168 };
  Object.defineProperty(dom.window, "innerWidth", {
    value: 393,
    configurable: true,
  });
  Object.defineProperty(dom.window, "innerHeight", {
    value: 896,
    configurable: true,
  });
});

async function open(thread = chrome, { connects = true, owner = true, controlKey = "" } = {}) {
  const calls = [];
  let setThread, setKey;
  function Host() {
    const [current, set] = React.useState(thread);
    const [key, setK] = React.useState(controlKey);
    setThread = set;
    setKey = setK;
    return React.createElement(AppThread, {
      peer,
      owner,
      controlKey: key,
      thread: current,
      threads: [chrome, notes],
      onLeave: () => calls.push(["leave"]),
      onSwitch: (t) => calls.push(["switch", t.id]),
      onReturn: (t) => calls.push(["return", t.id]),
      onQuit: (t) => calls.push(["quit", t.id]),
      onReopen: (t) => calls.push(["reopen", t.id]),
      onUpdate: (t) => calls.push(["update", t.region]),
    });
  }
  const rendered = await dom.render(React.createElement(Host));
  const view = {
    unmount: async () => {
      if (!views.delete(view)) return;
      await rendered.unmount();
    },
  };
  views.add(view);
  if (connects) await dom.waitFor(() => computer.input);
  else await settle(30);
  // jsdom has no layout: place the window where a 393×852 phone shows it.
  const frame = dom.document.querySelector(".app-surface-window");
  if (frame)
    frame.getBoundingClientRect = () => ({
      ...shown,
      right: shown.left + shown.width,
      bottom: shown.top + shown.height,
      x: shown.left,
      y: shown.top,
    });
  return {
    view,
    calls,
    surface: dom.document.querySelector(".app-surface"),
    switchTo: async (t) => {
      setThread(t);
      await settle(30);
    },
    // The live connection says control changed hands.
    controlChanged: async (key) => {
      setKey(key);
      await settle(30);
    },
  };
}
// Like a video player: a touch brings the faded controls back.
const controls = async () => {
  const bar = dom.document.querySelector(".app-thread-bar");
  if (bar?.classList.contains("hidden"))
    dom.document
      .querySelector(".app-thread")
      .dispatchEvent(
        new dom.window.PointerEvent("pointerup", { bubbles: true }),
      );
  await settle(10);
};
const pointer = (type, target, { id = 1, x, y }) =>
  target.dispatchEvent(
    new dom.window.PointerEvent(type, {
      pointerId: id,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    }),
  );
const button = (label) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent.trim() === label,
  );

test("an app opens full screen, streaming only its window, with control taken automatically", async () => {
  const { view } = await open();
  assert.deepEqual(computer.stream, { display: "901", thread: "t1" });
  assert.deepEqual(computer.input, { display: "901" });
  assert.deepEqual(
    requests.filter(([kind]) => kind === "control"),
    [["control", { enabled: true }]],
  );
  // The app has the whole screen; its controls show on open, over the top.
  const bar = dom.document.querySelector(
    '[role="toolbar"][aria-label="App controls"]',
  );
  assert.ok(bar);
  assert.equal(bar.classList.contains("hidden"), false);
  assert.equal(
    dom.document.querySelector(".app-thread").getAttribute("aria-label"),
    "Google Chrome",
  );
  await view.unmount();
  // Leaving keeps the app running on the Mac and lets go of control.
  assert.deepEqual(requests.at(-1), ["control", { enabled: false }]);
  assert.deepEqual(dom.errors, []);
});

test("a tap clicks the same spot on the Mac, and a text field opens the phone keyboard for it", async () => {
  computer.replies.focus = () => ({
    target: { editable: true, focus: "field-1" },
  });
  const { view, surface } = await open();
  const spot = at(0.5, 0.5);
  pointer("pointerdown", surface, spot);
  pointer("pointerup", surface, spot);
  await dom.waitFor(() => dom.document.querySelector(".remote-keyboard-sink"));
  const point = toDisplay(0.5, 0.5);
  same(computer.actions.slice(0, 2), [
    { type: "click", ...point, button: "left", count: 1 },
    { type: "focus", ...point },
  ]);
  assert.equal(
    dom.document.querySelectorAll(".remote-keyboard-sink").length,
    1,
  );
  assert.equal(dom.document.querySelectorAll(".typing-keys").length, 1);
  // The terminal's key row, with ⌘ for the Mac.
  assert.deepEqual(
    [...dom.document.querySelectorAll(".typing-keys.key-row button")].map(
      (b) => b.getAttribute("aria-label") || b.textContent.trim(),
    ),
    ["esc", "tab", "⌘", "Left", "Up", "Down", "Right", "Enter"],
  );
  await typeInto(dom.document.querySelector(".remote-keyboard-sink"), "hi");
  assert.deepEqual(computer.actions.at(-1), {
    type: "type-edit",
    delete: 0,
    text: "hi",
    focus: "field-1",
  });
  // Two quick taps are a double click (selects a word).
  await settle(350);
  pointer("pointerdown", surface, spot);
  pointer("pointerup", surface, spot);
  pointer("pointerdown", surface, spot);
  pointer("pointerup", surface, spot);
  await settle(60);
  const clicks = computer.actions
    .filter((a) => a.type === "click")
    .map((a) => a.count);
  assert.deepEqual(clicks, [1, 1, 2]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("a swipe scrolls the app under the finger, and a flick keeps it moving", async () => {
  const { view, surface } = await open();
  const k = chrome.region.w / shown.width; // Mac points per phone pixel
  pointer("pointerdown", surface, { x: 100, y: 400 });
  for (const y of [390, 370, 350]) {
    await settle(16);
    pointer("pointermove", surface, { x: 100, y });
  }
  pointer("pointerup", surface, { x: 100, y: 350 });
  await dom.waitFor(
    () => computer.actions.some((a) => a.momentum === "ended"),
    5000,
  );
  const start = toDisplay(100 / shown.width, (400 - shown.top) / shown.height);
  same(computer.actions.slice(0, 5), [
    { type: "move", ...start },
    { type: "scroll", dx: 0, dy: -10 * k, phase: "began" },
    { type: "scroll", dx: 0, dy: -20 * k, phase: "changed" },
    { type: "scroll", dx: 0, dy: -20 * k, phase: "changed" },
    { type: "scroll", dx: 0, dy: 0, phase: "ended" },
  ]);
  const coast = computer.actions.slice(5);
  assert.equal(coast[0].momentum, "began");
  assert.equal(coast.at(-1).momentum, "ended");
  assert.ok(
    coast.slice(1, -1).every((a) => a.momentum === "changed" && a.dy < 0),
  );
  // A new touch stops the coasting at once.
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("touch and hold right-clicks; hold and move drags", async () => {
  const { view, surface } = await open();
  const spot = at(0.3, 0.3);
  pointer("pointerdown", surface, spot);
  await settle(520);
  pointer("pointerup", surface, spot);
  same(computer.actions, [
    { type: "click", ...toDisplay(0.3, 0.3), button: "right", count: 1 },
  ]);
  computer.actions.length = 0;
  pointer("pointerdown", surface, spot);
  await settle(520);
  const to = at(0.3, 0.5);
  pointer("pointermove", surface, to);
  pointer("pointerup", surface, to);
  await settle(20);
  same(computer.actions, [
    { type: "down", ...toDisplay(0.3, 0.3), button: "left" },
    { type: "move", ...toDisplay(0.3, 0.5) },
    { type: "up", ...toDisplay(0.3, 0.5), button: "left" },
  ]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("two fingers zoom the phone's view without touching the Mac", async () => {
  const { view, surface } = await open();
  pointer("pointerdown", surface, { id: 1, x: 150, y: 400 });
  pointer("pointerdown", surface, { id: 2, x: 250, y: 400 });
  pointer("pointermove", surface, { id: 2, x: 350, y: 400 });
  await settle(30);
  pointer("pointerup", surface, { id: 2, x: 350, y: 400 });
  pointer("pointerup", surface, { id: 1, x: 150, y: 400 });
  assert.deepEqual(computer.actions, []);
  assert.match(
    dom.document.querySelector(".app-surface-window").style.transform,
    /scale\(2\)/,
  );
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("turning the phone sideways reshapes the app's window to the new screen", async () => {
  const { view, calls } = await open();
  Object.defineProperty(dom.window, "innerWidth", {
    value: 852,
    configurable: true,
  });
  Object.defineProperty(dom.window, "innerHeight", {
    value: 393,
    configurable: true,
  });
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  await dom.waitFor(
    () => requests.some(([method]) => method === "PATCH"),
    2000,
  );
  assert.deepEqual(
    requests.find(([method]) => method === "PATCH"),
    ["PATCH", { width: 852, height: 393, scale: 1 }],
  );
  await dom.waitFor(() => calls.some(([kind]) => kind === "update"));
  assert.deepEqual(
    calls.find(([kind]) => kind === "update"),
    ["update", { x: 0, y: 30, w: 852, h: 393 }],
  );
  // Safari's toolbar shrinking the height a little is not a rotation.
  requests.length = 0;
  Object.defineProperty(dom.window, "innerHeight", {
    value: 360,
    configurable: true,
  });
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  await settle(450);
  assert.deepEqual(
    requests.filter(([method]) => method === "PATCH"),
    [],
  );
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("switching apps streams the other window and moves input to its display", async () => {
  const { view, switchTo, calls } = await open();
  await controls();
  button("Switch to Notes").click();
  assert.deepEqual(calls, [["switch", "t2"]]);
  await switchTo(notes);
  assert.deepEqual(computer.stream, { display: "902", thread: "t2" });
  assert.deepEqual(computer.input, { display: "902" });
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("Back keeps the app running; X gives it back to the Mac; a closed window offers to reopen", async () => {
  const first = await open();
  await controls();
  button("Back to Reach").click();
  button("Return Google Chrome to the Mac").click();
  assert.deepEqual(first.calls, [["leave"], ["return", "t1"]]);
  await first.view.unmount();
  // Closed from within the app on the Mac: no stream, no control, one button.
  computer.reset();
  requests.length = 0;
  const closed = await open(
    { ...chrome, state: "closed" },
    { connects: false },
  );
  assert.equal(computer.stream, null);
  assert.equal(computer.input, null);
  assert.deepEqual(requests, []);
  const status = dom.document.querySelector(".app-thread-status");
  assert.match(
    status.textContent,
    /Google Chrome's window was closed on the Mac/,
  );
  assert.equal(dom.document.querySelectorAll(".app-surface").length, 0);
  button("Open again").click();
  assert.deepEqual(closed.calls, [["reopen", "t1"]]);
  await closed.view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("control survives switching apps and leaving Safari, without ever asking to Retry", async () => {
  // The real server: one control grant, revoked when an input connection
  // closes. Each switch and each return to Safari starts a new connection.
  computer.lease = false;
  const { view, switchTo } = await open();
  await dom.waitFor(() => computer.connected === "901");
  const hide = async (hidden) => {
    Object.defineProperty(dom.document, "hidden", {
      value: hidden,
      configurable: true,
    });
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await settle(30);
  };
  for (const [thread, display] of [
    [notes, "902"],
    [chrome, "901"],
    [notes, "902"],
    [chrome, "901"],
  ]) {
    await switchTo(thread);
    await dom.waitFor(() => computer.connected === display, 3000);
  }
  for (let i = 0; i < 2; i++) {
    await hide(true);
    await hide(false);
    await dom.waitFor(() => computer.connected === "901", 3000);
  }
  assert.equal(dom.document.querySelector(".app-thread-error"), null);
  // Control is only let go when leaving the app view, never between apps.
  assert.deepEqual(
    requests.filter(
      ([kind, body]) => kind === "control" && body.enabled === false,
    ),
    [],
  );
  await view.unmount();
  assert.deepEqual(requests.at(-1), ["control", { enabled: false }]);
  Object.defineProperty(dom.document, "hidden", {
    value: false,
    configurable: true,
  });
  assert.deepEqual(dom.errors, []);
});

test("the last frame is kept for 'On your phone' before the app view goes away", async () => {
  const threads = await dom.load("/src/app-threads.ts");
  threads.forgetSnapshot("t1");
  let seen;
  function Host() {
    return React.createElement(AppThread, {
      peer,
      thread: chrome,
      threads: [chrome],
      // Apps re-renders right away: the frame must already be saved.
      onLeave: () => (seen = threads.snapshotOf("t1")),
      onSwitch() {},
      onReturn() {},
      onQuit() {},
      onReopen() {},
      onUpdate() {},
    });
  }
  const view = await dom.render(React.createElement(Host));
  await dom.waitFor(() => computer.input);
  await controls();
  button("Back to Reach").click();
  assert.equal(typeof seen, "string");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("tapping a text field opens the phone keyboard within the same tap", async () => {
  // Safari opens the keyboard only during the tap itself, so this must not
  // wait for the Mac: the field map (window points) says it's a text field.
  mac.fields = [{ x: 100, y: 52, w: 300, h: 30, secure: false }];
  computer.replies.focus = () => ({
    target: { editable: true, focus: "field-9" },
  });
  const { view, surface } = await open();
  await dom.waitFor(() => requests.some(([kind]) => kind === "fields"));
  await settle(20);
  const spot = at(250 / chrome.region.w, 67 / chrome.region.h);
  pointer("pointerdown", surface, spot);
  pointer("pointerup", surface, spot);
  surface.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(dom.document.activeElement?.className, "remote-keyboard-sink");
  // The Mac confirms the field; typing is guarded to it.
  await dom.waitFor(() => computer.actions.some((a) => a.type === "focus"));
  await settle(30);
  await typeInto(dom.document.querySelector(".remote-keyboard-sink"), "hey");
  assert.deepEqual(computer.actions.at(-1), {
    type: "type-edit",
    delete: 0,
    text: "hey",
    focus: "field-9",
  });
  assert.equal(
    dom.document.querySelectorAll(".remote-keyboard-sink").length,
    1,
  );
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("a keyboard opened from an outdated field map closes when the Mac says it isn't a field", async () => {
  mac.fields = [{ x: 100, y: 52, w: 300, h: 30, secure: false }];
  computer.replies.focus = () => ({ target: { editable: false } });
  const { view, surface } = await open();
  await dom.waitFor(() => requests.some(([kind]) => kind === "fields"));
  await settle(20);
  const spot = at(250 / chrome.region.w, 67 / chrome.region.h);
  pointer("pointerdown", surface, spot);
  pointer("pointerup", surface, spot);
  surface.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(
    dom.document.querySelectorAll(".remote-keyboard-sink").length,
    1,
  );
  await dom.waitFor(() => !dom.document.querySelector(".remote-keyboard-sink"));
  // Elsewhere, a tap is just a click: no keyboard.
  const elsewhere = at(0.5, 0.6);
  pointer("pointerdown", surface, elsewhere);
  pointer("pointerup", surface, elsewhere);
  surface.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(80);
  assert.equal(
    dom.document.querySelectorAll(".remote-keyboard-sink").length,
    0,
  );
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("a swipe moves the picture with the finger at once, and the Mac's frames take over", async () => {
  const { view, surface } = await open();
  const follow = dom.document.querySelector(".app-surface-follow");
  pointer("pointerdown", surface, { x: 100, y: 400 });
  pointer("pointermove", surface, { x: 100, y: 390 });
  pointer("pointermove", surface, { x: 100, y: 370 });
  const lead = Number(
    follow.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)?.[2],
  );
  assert.ok(lead <= -25 && lead >= -30, `the picture led by ${lead}px`);
  await settle(120);
  pointer("pointerup", surface, { x: 100, y: 370 });
  // A slow release doesn't fling; the lead hands over to the video.
  await settle(600);
  assert.equal(follow.style.transform, "");
  assert.equal(
    computer.actions.some((a) => a.momentum),
    false,
  );
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("a tap during a fling only stops it, like iOS", async () => {
  const { view, surface } = await open();
  pointer("pointerdown", surface, { x: 100, y: 500 });
  for (const y of [480, 440, 400]) {
    await settle(16);
    pointer("pointermove", surface, { x: 100, y });
  }
  pointer("pointerup", surface, { x: 100, y: 400 });
  await dom.waitFor(() =>
    computer.actions.some((a) => a.momentum === "changed"),
  );
  pointer("pointerdown", surface, { x: 200, y: 300 });
  pointer("pointerup", surface, { x: 200, y: 300 });
  await settle(50);
  assert.ok(computer.actions.some((a) => a.momentum === "ended"));
  assert.equal(
    computer.actions.some((a) => a.type === "click"),
    false,
  );
  // The next tap clicks as usual.
  pointer("pointerdown", surface, { x: 200, y: 300 });
  pointer("pointerup", surface, { x: 200, y: 300 });
  assert.equal(computer.actions.filter((a) => a.type === "click").length, 1);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("Quit asks first when the app has windows on the Mac's own screen, and waits for its questions", async () => {
  mac.quits = [{ confirm: true, others: 2 }, { quit: true }];
  const { view, calls } = await open();
  await controls();
  button("Quit Google Chrome").click();
  await dom.waitFor(() => dom.document.querySelector(".app-thread-confirm"));
  assert.match(
    dom.document.querySelector(".app-thread-confirm").textContent,
    /also has 2 windows on your Mac/,
  );
  button("Quit Google Chrome").click();
  await dom.waitFor(() => calls.some(([kind]) => kind === "quit"));
  assert.deepEqual(
    requests.filter(([kind]) => kind === "quit"),
    [
      ["quit", { confirm: false }],
      ["quit", { confirm: true }],
    ],
  );
  // An app asking to save stays open, and says so.
  mac.quits = [{ quit: false, waiting: true }];
  await controls();
  button("Quit Google Chrome").click();
  await dom.waitFor(() =>
    dom.document
      .querySelector(".app-thread-error")
      ?.textContent.includes("asking something"),
  );
  assert.equal(calls.filter(([kind]) => kind === "quit").length, 1);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("like a video player: controls fade, and a touch brings them back while still reaching the app", async () => {
  const { view, surface } = await open();
  const bar = () => dom.document.querySelector(".app-thread-bar");
  assert.equal(bar().classList.contains("hidden"), false);
  await settle(3200);
  assert.equal(bar().classList.contains("hidden"), true);
  assert.equal(bar().getAttribute("aria-hidden"), "true");
  const spot = at(0.5, 0.6);
  pointer("pointerdown", surface, spot);
  pointer("pointerup", surface, spot);
  await settle(20);
  assert.equal(bar().classList.contains("hidden"), false);
  assert.deepEqual(
    computer.actions.filter((a) => a.type === "click").length,
    1,
  );
  // Using the bar itself doesn't count as touching the app.
  await settle(3200);
  assert.equal(bar().classList.contains("hidden"), true);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("someone else controlling: the app watches and says who, never taking it silently; you can take over", async () => {
  mac.holder = { name: "Ali", canTakeOver: true };
  await open(chrome, { connects: false });
  await dom.waitFor(() => dom.document.querySelector(".app-thread-watching"));
  const banner = dom.document.querySelector(".app-thread-watching");
  assert.equal(banner.querySelector("span").textContent, "Ali is controlling · you’re watching");
  assert.equal(computer.input, null, "no input while watching");
  assert.equal(dom.document.querySelector(".app-thread-error"), null, "not an error, no Retry");
  // One polite ask, no fight: no further attempts on its own.
  await settle(1500);
  assert.deepEqual(
    requests.filter(([kind]) => kind === "control"),
    [["control", { enabled: true }]],
  );
  // Take over is explicit, and only then does input connect.
  dom.document.querySelector(".app-thread-watching button").click();
  await dom.waitFor(() => computer.input);
  assert.deepEqual(requests.filter(([kind]) => kind === "control").at(-1), [
    "control",
    { enabled: true, takeover: true },
  ]);
  assert.equal(dom.document.querySelector(".app-thread-watching"), null);
  assert.deepEqual(dom.errors, []);
});

test("a guest watching the owner gets no Take over, and tries again when control frees up", async () => {
  mac.holder = { name: "Owner", canTakeOver: false };
  const { controlChanged } = await open(chrome, { connects: false, owner: false, controlKey: "k1" });
  await dom.waitFor(() => dom.document.querySelector(".app-thread-watching"));
  assert.equal(dom.document.querySelector(".app-thread-watching button"), null);
  // The owner lets go: the live connection says so, and the guest takes it.
  mac.holder = null;
  await controlChanged("k2");
  await dom.waitFor(() => computer.input);
  assert.equal(dom.document.querySelector(".app-thread-watching"), null);
  assert.deepEqual(dom.errors, []);
});

test("a guest turning their phone doesn't try to reshape the owner's window", async () => {
  await open(chrome, { owner: false });
  Object.defineProperty(dom.window, "innerWidth", { value: 852, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 393, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  await settle(500);
  assert.deepEqual(requests.filter(([method]) => method === "PATCH"), []);
  assert.equal(dom.document.querySelector(".app-thread-error"), null);
  assert.deepEqual(dom.errors, []);
});
