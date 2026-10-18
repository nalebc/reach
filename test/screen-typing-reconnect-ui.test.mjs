import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto, press } from "./dom/harness.mjs";

// Typing outlives what used to end it: the controls reconnecting (sleep, a
// network change, a private ↔ public handoff), Tab and Esc moving the
// computer's focus, a sticky ⌘ with Return. Keystrokes made meanwhile wait
// and go to the same field once the computer confirms it again; another
// field, or none, ends typing and says so. Mocked: stream and input socket.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const device = { id: "mac", name: "Mac", platform: "darwin", capabilities: { screen: true, apps: false }, roots: [] };
let dom, Screen, computer, keyboard, view, stage;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input-probe.mjs",
      "src/remote-keyboard.ts": "test/dom/fakes/remote-keyboard.mjs",
    },
    routes: {
      "/api/screen/control": () => ({ enabled: true }),
      "/api/screen/displays": () => ({
        displays: [{ id: "primary", name: "Built-in", primary: true, width: 1000, height: 600, x: 0, y: 0 }],
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
  [...dom.document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const sink = () => dom.document.querySelector(".remote-keyboard-sink");
const edits = () => computer.actions.filter((a) => ["type-edit", "text", "key"].includes(a.type));
const focusChecks = () => computer.actions.filter((a) => a.type === "focus");
async function mount(focus) {
  computer.reset();
  keyboard.reset(false);
  computer.probeSupported = true;
  dom.errors.length = 0;
  computer.replies = {
    probe: () => ({ field: true }),
    focus: (action) => ({ target: focus(action) }),
  };
  view = await dom.render(dom.React.createElement(Screen, { peer, device, toast: () => {}, onChanged: () => {} }));
  button("Control").click();
  await dom.waitFor(() => button("Open phone keyboard") && !button("Open phone keyboard").disabled);
  stage = view.container.querySelector(".remote-stage");
  stage.querySelector("canvas").getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 });
}
const pointer = (type) =>
  stage.dispatchEvent(new dom.window.PointerEvent(type, {
    pointerId: 1, pointerType: "touch", button: 0, clientX: 400, clientY: 200, bubbles: true, cancelable: true,
  }));
// A tap on a field: the keyboard opens and the computer confirms the field.
async function typingInField() {
  pointer("pointerdown");
  await settle(15);
  pointer("pointerup");
  await dom.waitFor(() => focusChecks().length);
  await settle(80);
  assert.equal(dom.document.activeElement, sink());
}

test("controls reconnecting while typing: the keyboard stays, letters wait, then reach the same field", async () => {
  let token = "first";
  await mount(() => ({ editable: true, focus: token, secure: false }));
  await typingInField();
  await typeInto(sink(), "ab");
  await settle(20);
  const field = sink();
  computer.blink(true);
  await settle(30);
  assert.equal(sink(), field, "the same typing field, still there");
  await typeInto(sink(), "cd");
  await settle(20);
  token = "second";
  const checks = focusChecks().length;
  computer.blink(false);
  await dom.waitFor(() => edits().length === 2);
  assert.equal(focusChecks().length, checks + 1, "the field confirmed again");
  assert.deepEqual(focusChecks().at(-1), focusChecks()[0], "at the point that was tapped");
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "ab", focus: "first" },
    { type: "type-edit", delete: 0, text: "cd", focus: "second" },
  ]);
  assert.equal(sink(), field);
});

test("another field after the reconnect: typing ends, says so, and nothing goes astray", async () => {
  let editable = true;
  await mount(() => (editable ? { editable: true, focus: "first", secure: false } : { editable: false }));
  await typingInField();
  computer.blink(true);
  await settle(30);
  await typeInto(sink(), "lost");
  editable = false;
  computer.blink(false);
  await dom.waitFor(() => !sink());
  assert.deepEqual(edits(), []);
  assert.match(dom.document.body.textContent, /text field changed/);
});

test("Tab and Esc reach the computer and typing goes on in the field that has its focus now", async () => {
  let token = "first";
  await mount(() => ({ editable: true, focus: token, secure: false }));
  await typingInField();
  token = "next";
  await press(sink(), "Tab");
  await dom.waitFor(() => focusChecks().length === 2);
  assert.deepEqual(focusChecks().at(-1), { type: "focus" }, "wherever the focus went");
  await settle(30);
  await typeInto(sink(), "x");
  await press(sink(), "Escape");
  await dom.waitFor(() => focusChecks().length === 3);
  await settle(30);
  assert.deepEqual(edits(), [
    { type: "key", key: "tab", modifiers: [], focus: "first" },
    { type: "type-edit", delete: 0, text: "x", focus: "next" },
    { type: "key", key: "escape", modifiers: [], focus: "next" },
  ]);
  assert.ok(sink(), "still typing");
});

test("a sticky ⌘ goes with Return and Backspace too, then lets go", async () => {
  await mount(() => ({ editable: true, focus: "f", secure: false }));
  await typingInField();
  const command = () => button("⌘");
  command().click();
  await settle();
  await press(sink(), "Enter");
  command().click();
  await settle();
  await press(sink(), "Backspace");
  await typeInto(sink(), "q");
  await settle(30);
  assert.deepEqual(edits(), [
    { type: "key", key: "enter", modifiers: ["meta"], focus: "f" },
    { type: "key", key: "backspace", modifiers: ["meta"], focus: "f" },
    { type: "type-edit", delete: 0, text: "q", focus: "f" },
  ]);
  assert.equal(command().getAttribute("aria-pressed"), "false");
});

test("a key-row key sends the word still being composed first (Android's keyboard, Japanese, Chinese)", async () => {
  await mount(() => ({ editable: true, focus: "f", secure: false }));
  await typingInField();
  const field = sink();
  const { InputEvent, CompositionEvent } = dom.window;
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, field.value + "ls");
  field.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ls", inputType: "insertCompositionText", isComposing: true }));
  await settle();
  assert.deepEqual(edits(), [], "nothing sent while composing");
  button("Enter").click();
  await settle(30);
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "ls", focus: "f" },
    { type: "key", key: "enter", modifiers: [], focus: "f" },
  ]);
});
