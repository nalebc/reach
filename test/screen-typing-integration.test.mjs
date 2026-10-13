import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "t",
  platform: "darwin",
};
const device = {
  id: "mac",
  name: "Mac",
  platform: "darwin",
  capabilities: { screen: true, apps: false },
  roots: [],
};
let dom, Screen, computer, keyboard, view, stage;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input-probe.mjs",
      "src/remote-keyboard.ts": "test/dom/fakes/remote-keyboard.mjs",
      ...(process.env.REACH_TYPING_BASELINE
        ? { "src/DesktopSurface.tsx": "work/typing-regression-baseline.tsx" }
        : {}),
    },
    routes: {
      "/api/screen/control": () => ({ enabled: true }),
      "/api/screen/displays": () => ({
        displays: [
          {
            id: "primary",
            name: "Built-in",
            primary: true,
            width: 1000,
            height: 600,
            x: 0,
            y: 0,
          },
        ],
      }),
    },
  });
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
  ({ keyboard } = await dom.load("/test/dom/fakes/remote-keyboard.mjs"));
  dom.window.HTMLElement.prototype.setPointerCapture = function () {};
  dom.window.HTMLElement.prototype.releasePointerCapture = function () {};
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  assert.deepEqual(dom.errors, []);
});
after(() => dom.close());
const button = (label) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent.trim() === label,
  );
const sink = () => dom.document.querySelector(".remote-keyboard-sink");
const edits = () =>
  computer.actions.filter((a) => ["type-edit", "text", "key"].includes(a.type));
async function mount(
  replies = {},
  { platform = "darwin", native = false, probing = true } = {},
) {
  computer.reset();
  keyboard.reset(native);
  computer.probeSupported = probing;
  dom.errors.length = 0;
  computer.replies = {
    probe: () => ({ field: true }),
    focus: () => ({
      target: { editable: true, focus: "selected-field", secure: false },
    }),
    ...replies,
  };
  view = await dom.render(
    dom.React.createElement(Screen, {
      peer: { ...peer, platform },
      device: { ...device, platform },
      toast: () => {},
      onChanged: () => {},
    }),
  );
  button("Control").click();
  await dom.waitFor(
    () =>
      button("Open phone keyboard") && !button("Open phone keyboard").disabled,
  );
  stage = view.container.querySelector(".remote-stage");
  const canvas = stage.querySelector("canvas");
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1000,
    height: 600,
    right: 1000,
    bottom: 600,
  });
  return canvas;
}
function pointer(type, x = 400, y = 200) {
  stage.dispatchEvent(
    new dom.window.PointerEvent(type, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}
async function tapStart() {
  pointer("pointerdown");
  await settle(15);
  pointer("pointerup");
}
const click = () =>
  stage.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: 400,
      clientY: 200,
    }),
  );

test("real surface: a host click acknowledged before Safari click still opens and confirms typing", async () => {
  await mount();
  await tapStart();
  await settle(80);
  click();
  await dom.waitFor(() => computer.actions.some((a) => a.type === "focus"));
  await settle(80);
  assert.ok(sink());
  assert.equal(dom.document.activeElement, sink());
  await typeInto(sink(), "restored");
  await settle(30);
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "restored", focus: "selected-field" },
  ]);
  assert.equal(
    computer.actions.filter((a) => a.type === "focus").length,
    1,
    "one confirmation after keyboard activation",
  );
});
test("real surface: slow click buffers early typing, then sends only to the confirmed field", async () => {
  let acknowledge;
  await mount({ click: () => new Promise((r) => (acknowledge = r)) });
  await tapStart();
  click();
  await typeInto(sink(), "hello");
  assert.deepEqual(edits(), []);
  acknowledge({ ok: true });
  await dom.waitFor(() => edits().length);
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "hello", focus: "selected-field" },
  ]);
});
test("real surface: a fresh acknowledged point closes a falsely detected input", async () => {
  let acknowledge, tapped;
  await mount({
    click: (action) =>
      new Promise((resolve) => {
        acknowledge = resolve;
        tapped = action;
      }),
    focus: () => ({ target: { editable: false } }),
  });
  await tapStart();
  click();
  assert.ok(sink());
  await typeInto(sink(), "discard this");
  acknowledge({ point: { x: tapped.x, y: tapped.y } });
  await dom.waitFor(() => !sink(), 1500);
  assert.deepEqual(
    edits(),
    [],
    "an unconfirmed input never receives buffered typing",
  );
});
for (const correction of [0, 0.005]) {
  test(`real surface: acknowledged point ${correction ? "corrected by touch assistance" : "copied by the host"} preserves the keyboard and buffered text`, async () => {
    let acknowledge, tapped;
    await mount({
      click: (action) =>
        new Promise((resolve) => {
          acknowledge = resolve;
          tapped = action;
        }),
    });
    await tapStart();
    click();
    const field = sink();
    await typeInto(field, "hello");
    const landed = { x: tapped.x + correction, y: tapped.y };
    acknowledge({ point: landed });
    await dom.waitFor(() => computer.actions.some((a) => a.type === "focus"));
    await settle(80);
    assert.equal(
      sink() === field,
      true,
      "confirmation must keep the focused editor and its buffer",
    );
    assert.deepEqual(edits(), [
      { type: "type-edit", delete: 0, text: "hello", focus: "selected-field" },
    ]);
    assert.deepEqual(
      computer.actions.find((a) => a.type === "focus"),
      { type: "focus", ...landed },
    );
  });
}
for (const platform of ["darwin", "win32"]) {
  for (const gesture of ["wheel", "navigation"]) {
    test(`real surface (${platform}): ${gesture} cancels an earlier input focus reply`, async () => {
      let confirm;
      await mount(
        {
          probe: () => ({ field: false }),
          focus: () =>
            new Promise((resolve) => {
              confirm = resolve;
            }),
        },
        { platform },
      );
      await tapStart();
      click();
      await dom.waitFor(() => confirm);
      stage.dispatchEvent(
        gesture === "wheel"
          ? new dom.window.WheelEvent("wheel", {
              clientX: 600,
              clientY: 300,
              deltaY: 30,
              bubbles: true,
              cancelable: true,
            })
          : new dom.window.KeyboardEvent("keydown", {
              key: "Tab",
              bubbles: true,
              cancelable: true,
            }),
      );
      confirm({ target: { editable: true, focus: "previous-field" } });
      await settle(80);
      assert.equal(sink(), null);
      assert.ok(
        computer.actions.some(
          (a) => a.type === (gesture === "wheel" ? "scroll" : "key"),
        ),
      );
    });
  }
  test(`real surface (${platform}): tapping the letterbox dismisses the keyboard without clicking the host`, async () => {
    await mount({}, { platform });
    button("Open phone keyboard").click();
    assert.ok(sink());
    computer.actions.length = 0;
    // The canvas's contained image starts at y=50 in this fixture.
    pointer("pointerdown", 400, 20);
    pointer("pointerup", 400, 20);
    click();
    await settle(80);
    assert.equal(sink(), null);
    assert.deepEqual(
      computer.actions.filter((a) => a.type !== "context"),
      [],
    );
  });
  test(`real surface (${platform}): a letterbox tap cancels an earlier focus reply`, async () => {
    let confirm;
    await mount(
      {
        probe: () => ({ field: false }),
        focus: () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      },
      { platform },
    );
    await tapStart();
    click();
    await dom.waitFor(() => confirm);
    pointer("pointerdown", 400, 20);
    pointer("pointerup", 400, 20);
    click();
    confirm({ target: { editable: true, focus: "previous-field" } });
    await settle(80);
    assert.equal(sink(), null);
  });
  test(`real surface (${platform}): a new swipe cancels an earlier focus reply before finger lift`, async () => {
    let confirm;
    await mount(
      {
        probe: () => ({ field: false }),
        focus: () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      },
      { platform },
    );
    await tapStart();
    click();
    await dom.waitFor(() => confirm);
    pointer("pointerdown", 700, 450);
    pointer("pointermove", 700, 400);
    confirm({ target: { editable: true, focus: "previous-field" } });
    await settle(60);
    assert.equal(
      sink(),
      null,
      "an obsolete field must not open a keyboard during a new gesture",
    );
    pointer("pointerup", 700, 400);
  });
  test(`real surface (${platform}): a confirmed keyboard stays open while scrolling`, async () => {
    await mount({}, { platform });
    await tapStart();
    click();
    await dom.waitFor(() => sink());
    await settle(80);
    const field = sink();
    pointer("pointerdown", 700, 450);
    pointer("pointermove", 700, 400);
    pointer("pointerup", 700, 400);
    await settle(60);
    assert.equal(sink() === field, true);
    assert.ok(computer.actions.some((a) => a.type === "scroll"));
    const clicks = computer.actions.filter((a) => a.type === "click").length;
    pointer("pointerdown", 800, 400);
    pointer("pointerup", 800, 400);
    click();
    await settle(40);
    assert.equal(
      sink(),
      null,
      "a tap that stops the scrolling also dismisses typing",
    );
    assert.equal(
      computer.actions.filter((a) => a.type === "click").length,
      clicks,
      "stopping momentum must not click the desktop",
    );
  });
  test(`real surface (${platform}): clicking non-input content dismisses typing using the point captured before keyboard resize`, async () => {
    const canvas = await mount({}, { platform });
    await tapStart();
    click();
    await dom.waitFor(() => sink());
    await settle(80);
    const rectangle = canvas.getBoundingClientRect();
    canvas.getBoundingClientRect = () => ({
      ...rectangle,
      top: sink() ? 0 : 120,
    });
    computer.replies.probe = () => ({ field: false });
    computer.replies.focus = () => ({ target: { editable: false } });
    computer.actions.length = 0;
    pointer("pointerdown", 600, 400);
    await settle(15);
    pointer("pointerup", 603, 401);
    click();
    await settle(80);
    assert.equal(sink(), null);
    const clicked = computer.actions.find((a) => a.type === "click");
    assert.equal(clicked.x, 0.6);
    assert.equal(
      clicked.y,
      0.7,
      "the keyboard resizing the page must not change the tap",
    );
    assert.equal(computer.actions.filter((a) => a.type === "click").length, 1);
    assert.deepEqual(edits(), []);
  });
  test(`native keyboard bridge (${platform}): an outside tap hides the keyboard and removes editing listeners`, async () => {
    await mount({}, { platform, native: true });
    await tapStart();
    click();
    await dom.waitFor(() => keyboard.visible);
    assert.equal(sink(), null, "this fixture uses the native keyboard bridge");
    keyboard.emit("input", { value: "hello" });
    await settle(20);
    assert.deepEqual(edits(), [
      { type: "type-edit", delete: 0, text: "hello", focus: "selected-field" },
    ]);
    pointer("pointerdown", 400, 20);
    pointer("pointerup", 400, 20);
    click();
    await dom.waitFor(() => !keyboard.visible);
    assert.equal(keyboard.hides, 1);
    keyboard.emit("input", { value: "hello ignored" });
    await settle(20);
    assert.equal(edits().length, 1);
  });
}
test("real surface: a canceled new gesture cannot leave an unconfirmed keyboard open", async () => {
  let confirm;
  await mount({
    focus: () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  });
  await tapStart();
  click();
  await dom.waitFor(() => confirm);
  await typeInto(sink(), "discard this");
  pointer("pointerdown", 700, 400);
  pointer("pointercancel", 700, 400);
  confirm({ target: { editable: true, focus: "previous-field" } });
  await settle(80);
  assert.equal(sink(), null);
  assert.deepEqual(edits(), []);
});
test("real surface: a Windows host without field probing can still confirm typing after a click", async () => {
  await mount({}, { platform: "win32", probing: false });
  await tapStart();
  click();
  await dom.waitFor(() => sink());
  assert.equal(
    computer.actions.some((a) => a.type === "probe"),
    false,
  );
  await typeInto(sink(), "windows");
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "windows", focus: "selected-field" },
  ]);
});
test("real surface: secure fields keep the password input while confirming focus", async () => {
  await mount({
    probe: () => ({ field: true, secure: true }),
    focus: () => ({
      target: { editable: true, secure: true, focus: "secure-field" },
    }),
  });
  await tapStart();
  await settle(60);
  click();
  await settle(130);
  assert.equal(sink()?.type, "password");
  await typeInto(sink(), "test-only");
  assert.equal(edits()[0]?.focus, "secure-field");
});
test("real surface: a rejected click cannot later open a stuck keyboard", async () => {
  await mount({ click: () => Promise.reject(Error("Control ended")) });
  await tapStart();
  await settle(40);
  click();
  await settle(100);
  assert.equal(sink(), null);
  assert.equal(
    computer.actions.some((a) => a.type === "focus"),
    false,
  );
  assert.deepEqual(edits(), []);
});
test("real surface: non-text content remains clickable and explicit Type works without field detection", async () => {
  await mount({
    probe: () => ({ field: false, blind: true }),
    focus: () => ({ target: { editable: false } }),
  });
  await tapStart();
  click();
  await settle(90);
  assert.equal(sink(), null);
  button("Open phone keyboard").click();
  await typeInto(sink(), "canvas text");
  assert.deepEqual(edits(), [{ type: "text", text: "canvas text" }]);
});
test("real surface: swiping scrolls the host without clicking or opening a field", async () => {
  await mount();
  pointer("pointerdown", 500, 350);
  await settle(15);
  pointer("pointermove", 500, 300);
  pointer("pointermove", 500, 240);
  pointer("pointerup", 500, 240);
  click();
  await settle(40);
  const scrolls = computer.actions.filter((a) => a.type === "scroll");
  assert.ok(scrolls.length > 0);
  assert.ok(scrolls.every((a) => a.dx === 0 && a.dy < 0 && a.dy >= -120));
  assert.ok(
    -scrolls.reduce((sum, a) => sum + a.dy, 0) > 110,
    "a fast swipe accelerates beyond its finger travel",
  );
  assert.equal(
    computer.actions.some((a) => a.type === "click"),
    false,
  );
  assert.equal(sink(), null);
});
