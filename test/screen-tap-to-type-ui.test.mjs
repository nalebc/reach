import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle, typeInto } from "./dom/harness.mjs";

// The live screen opens the phone keyboard on the tap itself when the Mac
// said (on touch-down) that a text field is there, and keeps that keyboard
// when the Mac then confirms the field: no Type button, no second tap.
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
let dom, React, Screen, computer;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input-probe.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface-props.mjs",
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
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  computer.reset();
  computer.surface = null;
  computer.probeSupported = true;
});
const button = (label) =>
  [...dom.document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === label || b.textContent.trim() === label,
  );
async function controlled() {
  const view = await dom.render(
    React.createElement(Screen, {
      peer,
      device,
      toast: () => {},
      onChanged: () => {},
    }),
  );
  button("Control").click();
  await dom.waitFor(
    () => computer.surface?.canControl && button("Open phone keyboard"),
  );
  return view;
}
const sink = () => dom.document.querySelector(".remote-keyboard-sink");

test("the surface asks the Mac about the field under the finger", async () => {
  computer.replies.probe = () => ({ field: true, secure: false });
  const view = await controlled();
  const answer = await computer.surface.probe({ x: 0.3, y: 0.6 });
  assert.deepEqual(answer, { field: true, secure: false });
  assert.deepEqual(
    computer.actions.filter((a) => a.type === "probe"),
    [{ type: "probe", x: 0.3, y: 0.6 }],
  );
  await view.unmount();
});

test("a tap on a field opens the keyboard at once, and it stays when the Mac confirms the field", async () => {
  computer.replies.focus = () => ({
    target: { editable: true, focus: "field-1", secure: false },
  });
  const view = await controlled();
  const point = { x: 0.3, y: 0.6 };
  // The tap's click: the keyboard opens within it.
  computer.surface.onField(point, false);
  const field = sink();
  assert.ok(field, "the typing field is there");
  assert.equal(
    dom.document.activeElement,
    field,
    "and focused: the keyboard is up",
  );
  // Then the click's acknowledgement: the Mac says what it focused.
  computer.surface.onTextTarget(point);
  await settle(120);
  assert.equal(sink(), field, "the same field, never remounted");
  assert.equal(dom.document.activeElement, field);
  // Typing now goes to that field, guarded.
  await typeInto(field, "hi");
  assert.deepEqual(
    computer.actions.filter((a) => a.type === "type-edit"),
    [{ type: "type-edit", delete: 0, text: "hi", focus: "field-1" }],
  );
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("if the Mac says it wasn't a field after all, the keyboard closes", async () => {
  computer.replies.focus = () => ({ target: { editable: false } });
  const view = await controlled();
  const point = { x: 0.3, y: 0.6 };
  computer.surface.onField(point, false);
  assert.ok(sink());
  computer.surface.onTextTarget(point);
  await settle(120);
  assert.equal(
    dom.document.querySelectorAll(".remote-keyboard-sink").length,
    0,
  );
  await view.unmount();
});

test("an older Reach that can't answer is never asked", async () => {
  computer.probeSupported = false;
  const view = await controlled();
  assert.equal(computer.surface.probe, undefined);
  assert.equal(computer.surface.onField, undefined);
  await view.unmount();
});
