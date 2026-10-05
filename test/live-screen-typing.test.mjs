import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  startDom,
  settle,
  typeInto,
  replaceText,
  backspace,
  press,
} from "./dom/harness.mjs";

// Typing on the live screen from a phone, through the real Screen and
// RemoteTyping components. Only the video stream, input socket and canvas
// are stand-ins (test/dom/fakes). Each test checks exactly what reaches the
// computer, so an extra Backspace or a doubled letter fails it, and that
// React rendered without warnings (a duplicate key once made each letter
// delete the one before it and stacked copies of the key row).

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

let dom, React, Screen, RemoteTyping, computer;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": () => ({ enabled: true }),
      "/api/screen/displays": () => ({
        displays: [
          {
            id: "primary",
            name: "Built-in",
            primary: true,
            width: 1470,
            height: 956,
            x: 0,
            y: 0,
          },
        ],
      }),
    },
  });
  React = dom.React;
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ default: RemoteTyping } = await dom.load("/src/RemoteTyping.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  computer.reset();
});

const typed = () =>
  computer.actions.filter(
    (a) => !["context", "focus", "release"].includes(a.type),
  );
const count = (selector) => dom.document.querySelectorAll(selector).length;
const button = (label) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent.trim() === label,
  );

// RemoteTyping on its own, with a parent that re-renders it (and hands it a
// new target object) between keystrokes, as the screen does on every frame.
async function typingField({ focus } = {}) {
  const sent = [];
  let rerender;
  function Host() {
    const editorRef = React.useRef(null);
    const [, setRevision] = React.useState(0);
    rerender = () => setRevision((n) => n + 1);
    return React.createElement(RemoteTyping, {
      target: focus ? { editable: true, focus } : { editable: true },
      keyRow: true,
      editorRef,
      send: async (action) => {
        sent.push(action);
        return {};
      },
      onClose: () => {},
      onError: (message) => sent.push({ error: message }),
    });
  }
  const view = await dom.render(React.createElement(Host));
  return {
    sent,
    view,
    field: view.container.querySelector(".remote-keyboard-sink"),
    rerender: async () => {
      rerender();
      await settle();
    },
  };
}

test("each letter reaches the computer once and never deletes the letter before it", async () => {
  const { sent, field, rerender, view } = await typingField();
  for (const letter of "hey") {
    await typeInto(field, letter);
    await rerender();
  }
  await typeInto(field, " there");
  assert.deepEqual(sent, [
    { type: "text", text: "h" },
    { type: "text", text: "e" },
    { type: "text", text: "y" },
    { type: "text", text: " there" },
  ]);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("Backspace removes one character, whether the field has text or is empty", async () => {
  const { sent, field, view } = await typingField();
  await typeInto(field, "hi");
  await backspace(field);
  await backspace(field);
  await backspace(field); // Field already empty: the key itself is sent.
  assert.deepEqual(sent, [
    { type: "text", text: "hi" },
    { type: "key", key: "backspace" },
    { type: "key", key: "backspace" },
    { type: "key", key: "backspace", modifiers: [] },
  ]);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("in a field the computer identified, corrections and Enter go to that field", async () => {
  const { sent, field, view } = await typingField({ focus: "field-1" });
  await typeInto(field, "teh");
  // Autocorrect rewrites the word: only the difference is sent.
  await replaceText(field, "the");
  assert.equal(await press(field, "Enter"), false);
  assert.deepEqual(sent, [
    { type: "type-edit", delete: 0, text: "teh", focus: "field-1" },
    { type: "type-edit", delete: 2, text: "he", focus: "field-1" },
    { type: "key", key: "enter", modifiers: [], focus: "field-1" },
  ]);
  assert.equal(field.value, "");
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("each key in the row above the phone keyboard is sent once", async () => {
  const { sent, view } = await typingField();
  for (const label of ["Enter", "tab", "esc", "Left", "Up", "Down", "Right"])
    button(label).click();
  await settle();
  assert.deepEqual(
    sent.map((a) => a.key),
    ["enter", "tab", "escape", "left", "up", "down", "right"],
  );
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

async function controlledScreen() {
  const view = await dom.render(
    React.createElement(Screen, {
      peer,
      device,
      toast: () => {},
      onChanged: () => {},
    }),
  );
  button("Control").click();
  await dom.waitFor(() => button("Open phone keyboard"));
  return view;
}

async function openKeyboard() {
  button("Open phone keyboard").click();
  // "Tap to type" appears after its keyboard check (450 ms), next to the
  // typing field: the pair that once shared a React key. Callers assert what
  // is on screen, so a missing button fails with the counts, not a timeout.
  await dom
    .waitFor(() => dom.document.querySelector(".tap-to-type"), 3000)
    .catch(() => {});
  return dom.document.querySelector(".remote-keyboard-sink");
}
const keyboardParts = () => ({
  fields: count(".remote-keyboard-sink"),
  keyRows: count(".typing-keys"),
  tapToType: count(".tap-to-type"),
});
const oneOfEach = { fields: 1, keyRows: 1, tapToType: 1 };

test("typing on the live screen sends exactly what was typed while frames keep arriving", async () => {
  const view = await controlledScreen();
  const field = await openKeyboard();
  assert.deepEqual(keyboardParts(), oneOfEach);
  for (const letter of "hey") {
    await typeInto(field, letter);
    computer.frame();
    await settle(50);
  }
  await backspace(field);
  computer.frame();
  await settle(50);
  await typeInto(field, "llo");
  computer.frame();
  await settle(50);
  assert.deepEqual(typed(), [
    { type: "text", text: "h" },
    { type: "text", text: "e" },
    { type: "text", text: "y" },
    { type: "key", key: "backspace" },
    { type: "text", text: "llo" },
  ]);
  assert.deepEqual(keyboardParts(), oneOfEach);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("the typing field and key row exist once, however often the keyboard opens", async () => {
  const view = await controlledScreen();
  for (let round = 1; round <= 5; round++) {
    await openKeyboard();
    computer.frame();
    await settle(30);
    assert.deepEqual({ round, ...keyboardParts() }, { round, ...oneOfEach });
    // Done on the phone keyboard: the field loses focus.
    dom.document.querySelector(".remote-keyboard-sink").blur();
    await settle(30);
    computer.frame();
    await settle(30);
    assert.deepEqual(
      {
        round,
        fields: count(".remote-keyboard-sink"),
        keyRows: count(".typing-keys"),
      },
      { round, fields: 0, keyRows: 0 },
    );
  }
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("Screen types with the terminal's key row: esc, tab, a sticky ⌘, arrows, Return", async () => {
  const view = await controlledScreen();
  const field = await openKeyboard();
  const row = dom.document.querySelector(".typing-keys");
  assert.equal(row.classList.contains("key-row"), true, "the shared key row");
  assert.deepEqual(
    [...row.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") || b.textContent.trim(),
    ),
    ["esc", "tab", "⌘", "Left", "Up", "Down", "Right", "Enter"],
  );
  const tap = async (label) => {
    button(label).click();
    await settle();
  };
  await tap("esc");
  await tap("Enter");
  // ⌘ then a letter: a shortcut, not text; it lets go after one use.
  await tap("⌘");
  assert.equal(button("⌘").getAttribute("aria-pressed"), "true");
  await typeInto(field, "c");
  assert.equal(button("⌘").getAttribute("aria-pressed"), "false");
  await typeInto(field, "x");
  // ⌘ then an arrow: to the start of the line.
  await tap("⌘");
  await tap("Left");
  await settle(30);
  assert.deepEqual(typed(), [
    { type: "key", key: "escape", modifiers: [] },
    { type: "key", key: "enter", modifiers: [] },
    { type: "key", key: "c", modifiers: ["meta"] },
    { type: "text", text: "x" },
    { type: "key", key: "left", modifiers: ["meta"] },
  ]);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("Paste puts the phone's clipboard where the cursor is on the computer, in one tap", async () => {
  const view = await controlledScreen();
  const clipboard = { text: "hello from the phone" };
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => clipboard.text, writeText: async () => {} },
  });
  button("Paste from your phone").click();
  await dom.waitFor(() => typed().length === 2);
  assert.deepEqual(typed(), [
    { type: "clipboard-write", text: "hello from the phone" },
    { type: "key", key: "v", modifiers: ["meta"] },
  ]);
  // Nothing copied: nothing is sent.
  clipboard.text = "";
  computer.reset();
  button("Paste from your phone").click();
  await settle(50);
  assert.deepEqual(typed(), []);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});
