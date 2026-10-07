import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startDom, settle } from "./dom/harness.mjs";
import { inputAction } from "../server/desktop-protocol.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";

// Typing on the live screen without a Type button: on touch-down the phone
// asks the Mac whether a text field is under the finger. When the answer is
// back before the finger lifts, the tap's own click opens the keyboard
// (Safari opens it only then). The real DesktopSurface, with finger events.
let dom, React, DesktopSurface;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: DesktopSurface } = await dom.load("/src/DesktopSurface.tsx"));
  dom.window.HTMLElement.prototype.setPointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.releasePointerCapture ??= function () {};
  dom.window.HTMLElement.prototype.hasPointerCapture ??= () => false;
});
after(() => dom?.close());

async function surface({ answer, delay = 0, probing = true } = {}) {
  const calls = { probes: [], fields: [], sent: [] };
  const canvas = React.createRef();
  const view = await dom.render(
    React.createElement(DesktopSurface, {
      canvas,
      width: 1000,
      height: 500,
      ready: true,
      connecting: false,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      send: async (action) => {
        calls.sent.push(action);
        return {};
      },
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget() {},
      resetKey: "k",
      initialCursor: null,
      ...(probing && {
        probe: (point) => {
          calls.probes.push(point);
          return new Promise((resolve) =>
            setTimeout(() => resolve(answer), delay),
          );
        },
        onField: (point, secure) => calls.fields.push({ point, secure }),
      }),
    }),
  );
  // jsdom has no layout: the video fills a 1000×500 box at the origin.
  const video = view.container.querySelector("canvas");
  video.width = 1000;
  video.height = 500;
  video.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
    right: 1000,
    bottom: 500,
    x: 0,
    y: 0,
  });
  return { view, calls, stage: view.container.querySelector(".remote-stage") };
}
const finger = (type, target, x, y) =>
  target.dispatchEvent(
    new dom.window.PointerEvent(type, {
      pointerId: 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    }),
  );
// A tap as Safari delivers it: down, (time passes), up, then click.
async function tap(stage, x, y, holdMs = 30) {
  finger("pointerdown", stage, x, y);
  await settle(holdMs);
  finger("pointerup", stage, x, y);
  stage.dispatchEvent(
    new dom.window.MouseEvent("click", {
      bubbles: true,
      clientX: x,
      clientY: y,
    }),
  );
  await settle(10);
}

test("a tap on a text field opens the keyboard on that tap, no Type button", async () => {
  const { view, calls, stage } = await surface({
    answer: { field: true, secure: false },
  });
  await tap(stage, 400, 100);
  assert.deepEqual(calls.probes, [{ x: 0.4, y: 0.2 }]);
  assert.deepEqual(calls.fields, [
    { point: { x: 0.4, y: 0.2 }, secure: false },
  ]);
  // The click still goes to the Mac, as any tap's does.
  assert.deepEqual(
    calls.sent.filter((a) => a.type === "click"),
    [{ type: "click", x: 0.4, y: 0.2, button: "left", count: 1 }],
  );
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("a password field says so, for a password keyboard", async () => {
  const { view, calls, stage } = await surface({
    answer: { field: true, secure: true },
  });
  await tap(stage, 500, 250);
  assert.deepEqual(calls.fields, [{ point: { x: 0.5, y: 0.5 }, secure: true }]);
  await view.unmount();
});

test("a tap on anything else opens no keyboard", async () => {
  const { view, calls, stage } = await surface({ answer: { field: false } });
  await tap(stage, 400, 100);
  assert.equal(calls.probes.length, 1);
  assert.deepEqual(calls.fields, []);
  await view.unmount();
});

test("a quick tap reserves the keyboard while a slow field probe is still pending", async () => {
  const { view, calls, stage } = await surface({
    answer: { field: true },
    delay: 80,
  });
  await tap(stage, 400, 100, 10);
  await settle(120);
  assert.deepEqual(calls.fields, [{ point: { x: 0.4, y: 0.2 }, secure: false }]);
  await view.unmount();
});

test("an answer meant for an earlier touch never opens the keyboard on a later one", async () => {
  // The first touch's answer ("a field") lands during the second touch; the
  // second touch's own answer only comes after its tap.
  const delays = [0, 200];
  const fields = [];
  const canvas = React.createRef();
  let n = 0;
  const second = await dom.render(
    React.createElement(DesktopSurface, {
      canvas,
      width: 1000,
      height: 500,
      ready: true,
      connecting: false,
      canControl: true,
      mode: "direct",
      drag: false,
      clickMode: "left",
      send: async () => ({}),
      onDragEnd() {},
      onFeedback() {},
      onInteraction() {},
      onTextTarget() {},
      resetKey: "k",
      initialCursor: null,
      probe: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ field: true }), delays[n++]),
        ),
      onField: (point, secure) => fields.push({ point, secure }),
    }),
  );
  const video = second.container.querySelector("canvas");
  video.width = 1000;
  video.height = 500;
  video.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1000,
    height: 500,
    right: 1000,
    bottom: 500,
    x: 0,
    y: 0,
  });
  const area = second.container.querySelector(".remote-stage");
  finger("pointerdown", area, 100, 100);
  finger("pointerup", area, 100, 100);
  finger("pointerdown", area, 900, 400);
  await settle(20); // the first answer lands now
  finger("pointerup", area, 900, 400);
  area.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(250);
  assert.deepEqual(fields, [{ point: { x: 0.9, y: 0.8 }, secure: false }]);
  await second.unmount();
});

test("a computer that can't answer is never asked", async () => {
  const { view, calls, stage } = await surface({ probing: false });
  await tap(stage, 400, 100);
  assert.deepEqual(calls.probes, []);
  assert.deepEqual(
    calls.sent.map((a) => a.type),
    ["click"],
  );
  await view.unmount();
});

test("the probe is checked like any desktop action, and the computer says it can answer", async () => {
  assert.deepEqual(inputAction({ type: "probe", x: 0.25, y: 1 }), {
    type: "probe",
    x: 0.25,
    y: 1,
  });
  for (const bad of [{ x: -1, y: 0 }, { x: 0.5 }, { x: "0.5", y: 0.5 }])
    assert.throws(
      () => inputAction({ type: "probe", ...bad }),
      /Invalid probe/,
    );
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close() {},
  });
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => ({ id: "phone", scopes: ["admin", "screen"] }) },
    control: { check() {}, acquire() {}, revoke() {} },
    create: async () => ({ send: async () => ({ cursor: null }), stop() {} }),
  });
  ws.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "auth", token: "T", display: "1" })),
    false,
  );
  const end = Date.now() + 1000;
  while (!ws.sent.some((m) => m.type === "ready") && Date.now() < end)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(ws.sent.find((m) => m.type === "ready")?.probe, true);
  ws.emit("close");
});
