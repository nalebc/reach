import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto, press } from "./dom/harness.mjs";

// Typing outlives what used to end it: the controls reconnecting (sleep, a
// network change, a private ↔ public handoff), Tab and Esc moving the
// computer's focus, a sticky ⌘ with Return. Keystrokes made meanwhile wait
// remain local across a reconnect until an explicit send to the current field.
// A fresh guard alone cannot prove an old field survived. Mocked bridge/socket;
// these cases do not execute UIKit or native desktop input.
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
async function mount(focus, native = false) {
  computer.reset();
  keyboard.reset(native);
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
async function typingInField(native = false) {
  pointer("pointerdown");
  await settle(15);
  pointer("pointerup");
  await dom.waitFor(() => focusChecks().length);
  await settle(80);
  if (native) await dom.waitFor(() => keyboard.visible);
  else assert.equal(dom.document.activeElement, sink());
}

test("controls reconnecting keep waiting typing local until explicit send to the current field", async () => {
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
  await settle(80);
  assert.equal(focusChecks().length, checks, "no automatic rebind from a fresh guard");
  assert.equal(edits().length, 1, "waiting text stays on the phone");
  button("Send waiting typing to current field").click();
  await dom.waitFor(() => edits().length === 2);
  assert.equal(focusChecks().length, checks + 1, "an explicit send checks the field now");
  assert.deepEqual(focusChecks().at(-1), { type: "focus" });
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "ab", focus: "first" },
    { type: "type-edit", delete: 0, text: "cd", focus: "second" },
  ]);
  assert.equal(sink(), field);
});

test("a noneditable reconnect target keeps the waiting draft until a later explicit valid target", async () => {
  let editable = true;
  await mount(() => (editable ? { editable: true, focus: "first", secure: false } : { editable: false }));
  await typingInField();
  computer.blink(true);
  await settle(30);
  await typeInto(sink(), "lost");
  editable = false;
  computer.blink(false);
  await settle(60);
  button("Send waiting typing to current field").click();
  await dom.waitFor(() => /Waiting typing kept/.test(dom.document.body.textContent));
  assert.ok(sink(), "the local draft and keyboard survive a refused target");
  assert.deepEqual(edits(), []);
  editable = true;
  button("Send waiting typing to current field").click();
  await dom.waitFor(() => edits().length === 1);
  assert.equal(edits()[0].text, "lost", "known-unsent text was retained");
});

test("a focus confirmation from before a second reconnect cannot unblock waiting typing", async () => {
  await mount(() => ({ editable: true, focus: "initial", secure: false }));
  await typingInField();
  computer.blink(true);
  await settle(40);
  await typeInto(sink(), "waiting");
  computer.blink(false);
  await settle(40);
  let finishOldFocus;
  computer.replies.focus = () => new Promise((resolve) => { finishOldFocus = resolve; });
  button("Send waiting typing to current field").click();
  await dom.waitFor(() => finishOldFocus);
  computer.blink(true);
  await settle(40);
  computer.blink(false);
  await settle(40);
  finishOldFocus({ target: { editable: true, focus: "obsolete-connection", secure: false } });
  await settle(80);
  assert.deepEqual(edits(), [], "an obsolete focus reply is not a fresh explicit send");
  assert.ok(button("Send waiting typing to current field"));
  computer.replies.focus = () => ({ target: { editable: true, focus: "current-connection", secure: false } });
  button("Send waiting typing to current field").click();
  await dom.waitFor(() => edits().length === 1);
  assert.deepEqual(edits()[0], { type: "type-edit", delete: 0, text: "waiting", focus: "current-connection" });
});

for (const native of [false, true]) test(`${native ? "native bridge" : "web"}: replacement editable field receives no queued typing automatically and unknown dispatched input is never replayed`, async () => {
  let focus = "old-field", rejectOld;
  await mount(() => ({ editable: true, focus, secure: false }), native);
  await typingInField(native);
  computer.replies["type-edit"] = () => new Promise((_, reject) => { rejectOld = reject; });
  if (native) keyboard.emit("input", { value: "ab" });
  else await typeInto(sink(), "ab");
  await dom.waitFor(() => edits().length === 1);
  computer.blink(true);
  await settle(40);
  if (native) keyboard.emit("input", { value: "abcd" });
  else await typeInto(sink(), "cd");
  // A close cannot say whether the already-dispatched "ab" reached the host.
  rejectOld(Error("Connection closed; input delivery is unknown"));
  await settle(30);
  focus = "replacement-editable-field";
  computer.replies["type-edit"] = () => ({ ok: true });
  const checks = focusChecks().length;
  computer.blink(false);
  await settle(80);
  assert.equal(focusChecks().length, checks);
  assert.equal(edits().length, 1);
  // A pointer can focus a new field without discarding the local waiting draft.
  pointer("pointerdown"); pointer("pointerup");
  await settle(80);
  assert.equal(focusChecks().length, checks, "clicking cannot silently unblock old typing");
  assert.equal(edits().length, 1);
  button("Send waiting typing to current field").click();
  await dom.waitFor(() => edits().length === 2);
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "ab", focus: "old-field" },
    { type: "type-edit", delete: 0, text: "cd", focus: "replacement-editable-field" },
  ], "only known-unsent cd may be explicitly sent; unknown ab is never replayed");
});

test("native bridge secure Return resets its shadow only after the shell confirms a context reset", async () => {
  await mount(() => ({ editable: true, focus: "password", secure: true }), true);
  await typingInField(true);
  keyboard.emit("input", { value: "ab" });
  keyboard.emit("key", { key: "enter", contextReset: true });
  keyboard.emit("input", { value: "c" });
  await dom.waitFor(() => edits().length === 3);
  assert.deepEqual(edits(), [
    { type: "type-edit", delete: 0, text: "ab", focus: "password" },
    { type: "key", key: "enter", modifiers: [], focus: "password" },
    { type: "type-edit", delete: 0, text: "c", focus: "password" },
  ]);
});

test("an older native shell without contextReset keeps its retained Return context in sync", async () => {
  await mount(() => ({ editable: true, focus: "password", secure: true }), true);
  await typingInField(true);
  keyboard.emit("input", { value: "ab" });
  keyboard.emit("key", { key: "enter" });
  keyboard.emit("input", { value: "abc" });
  await dom.waitFor(() => edits().length === 3);
  assert.equal(edits()[2].delete, 0);
  assert.equal(edits()[2].text, "c", "old native text ab remains the diff baseline");
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
