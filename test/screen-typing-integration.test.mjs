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
let dom, Screen, computer, view, stage;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input-probe.mjs",
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
async function mount(replies = {}) {
  computer.reset();
  computer.probeSupported = true;
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
      peer,
      device,
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
  assert.deepEqual(
    computer.actions.filter((a) => a.type === "scroll"),
    [
      { type: "scroll", dx: 0, dy: -50 },
      { type: "scroll", dx: 0, dy: -60 },
    ],
  );
  assert.equal(
    computer.actions.some((a) => a.type === "click"),
    false,
  );
  assert.equal(sink(), null);
});
