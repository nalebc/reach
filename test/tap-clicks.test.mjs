import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
import { inputAction } from "../server/desktop-protocol.mjs";
const source = await fs.readFile(
  new URL("../src/tap-clicks.ts", import.meta.url),
  "utf8",
);
const { TapClicks, DOUBLE_TAP_MS } = await import(
  `data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`
);
const point = { x: 0.3, y: 0.4 },
  image = { width: 1000, height: 500 };

test("two rapid taps form one pair without delaying the first click or turning a third tap into three clicks", () => {
  const clicks = new TapClicks();
  const first = clicks.next(point, 0, "touch", image);
  const secondPoint = { x: 0.305, y: 0.405 };
  const second = clicks.next(secondPoint, 150, "touch", image);
  assert.deepEqual(second.point, secondPoint, "a double-click never substitutes the first tap's point");
  const third = clicks.next(point, 250, "touch", image);
  const fourth = clicks.next(point, 300, "touch", image);
  assert.deepEqual(
    [first.clickState, second.clickState, third.clickState, fourth.clickState],
    [1, 2, 1, 2],
  );
  assert.equal(first.clickId, second.clickId);
  assert.equal(third.clickId, fourth.clickId);
  assert.notEqual(first.clickId, third.clickId);
});
test("slow, distant, backward-clock and mixed-pointer taps are independent clicks", () => {
  for (const [at, next, pointer] of [
    [DOUBLE_TAP_MS + 1, point, "touch"],
    [-1, point, "touch"],
    [100, { x: 0.309, y: 0.4 }, "touch"],
    [100, point, "mouse"],
  ]) {
    const clicks = new TapClicks();
    const first = clicks.next(point, 0, "touch", image);
    const second = clicks.next(next, at, pointer, image);
    assert.equal(second.clickState, 1);
    assert.notEqual(first.clickId, second.clickId);
  }
});
test("pairing uses rendered CSS pixels through zoom, Retina scaling and keyboard resizing; mouse and pen stay precise", () => {
  for (const pointer of ["touch", "mouse", "pen"]) {
    const clicks = new TapClicks();
    clicks.next(point, 0, pointer, image);
    assert.equal(
      clicks.next({ x: 0.306, y: 0.4 }, 100, pointer, image).clickState,
      pointer === "touch" ? 2 : 1,
    );
  }
  for (const [width, expected] of [
    [500, 1],
    [2000, 1],
  ]) {
    const clicks = new TapClicks();
    clicks.next(point, 0, "touch", image);
    assert.equal(
      clicks.next({ x: 0.31, y: 0.4 }, 100, "touch", {
        width,
        height: width / 2,
      }).clickState,
      expected,
    );
  }
  const resized = new TapClicks();
  resized.next(point, 0, "touch", image);
  assert.equal(
    resized.next(point, 100, "touch", { width: 600, height: 300 }).clickState,
    2,
  );
});
test("canceling a gesture forgets the pair without reusing its identity", () => {
  const clicks = new TapClicks();
  const first = clicks.next(point, 0, "touch", image);
  clicks.reset();
  const second = clicks.next(point, 100, "touch", image);
  assert.equal(second.clickState, 1);
  assert.notEqual(first.clickId, second.clickId);
  clicks.reset(first.clickId);
  assert.equal(
    clicks.next(point, 150, "touch", image).clickState,
    2,
    "a delayed error from an older pair cannot cancel the new one",
  );
});
test("a keyboard reflow uses the newly visible target and never turns a letterbox tap into a click", () => {
  for (const secondPoint of [{ x: 0.3, y: 0.1 }, null]) {
    const clicks = new TapClicks();
    clicks.next(
      point,
      0,
      "touch",
      image,
    );
    const second = clicks.next(
      secondPoint,
      100,
      "touch",
      image,
    );
    if (secondPoint) {
      assert.equal(second.clickState, 1);
      assert.deepEqual(second.point, secondPoint);
    } else assert.equal(second, undefined);
  }
  const unchanged = new TapClicks();
  unchanged.next(point, 0, "touch", image);
  assert.equal(
    unchanged.next(null, 100, "touch", image),
    undefined,
    "an ordinary margin tap must never click",
  );
});
test("the shared input protocol carries a single physical click for each half of the double-click", () => {
  for (const clickState of [1, 2]) {
    const action = {
      type: "click",
      ...point,
      button: "left",
      count: 1,
      clickId: 7,
      clickState,
    };
    assert.deepEqual(inputAction(action), action);
  }
  const basic = { type: "click", ...point, button: "left", count: 1 };
  for (const changes of [
    { clickState: 2 },
    { clickId: 0 },
    { clickId: -1 },
    { clickId: "1" },
    { clickId: 2147483648 },
    { clickId: 1, clickState: 3 },
    { clickId: 1, clickState: 2, count: 2 },
    { clickId: 1, button: "right" },
    { clickId: 1, type: "down" },
    { clickId: 1, type: "move" },
  ])
    assert.throws(
      () => inputAction({ ...basic, ...changes }),
      /Invalid click sequence/,
    );
});
test("a double-tap's second click may carry its pairing tolerance, validated like a touch's and passed on whole", async () => {
  const second = { type: "click", ...point, button: "left", count: 1, clickId: 7, clickState: 2 };
  assert.deepEqual(
    inputAction({ ...second, pair: { x: 0.02, y: 0.1, extra: true } }),
    { ...second, pair: { x: 0.02, y: 0.1 } },
    "only x and y go on to the helper",
  );
  assert.equal(inputAction(second).pair, undefined, "none asked, none sent");
  for (const pair of [null, 0, {}, { x: 0, y: 0.02 }, { x: 0.02, y: -0.01 }, { x: 0.11, y: 0.02 },
    { x: 0.02, y: Infinity }, { x: "0.02", y: 0.02 }, { x: NaN, y: 0.02 }])
    assert.throws(() => inputAction({ ...second, pair }), /Invalid double-tap tolerance/, JSON.stringify(pair));
  // Only on the second click of an explicit left double-tap.
  for (const changes of [
    { clickState: 1 },
    { clickId: undefined, clickState: undefined },
    { type: "down", clickId: undefined, clickState: undefined },
    { button: "right", clickId: undefined, clickState: undefined },
  ])
    assert.throws(
      () => inputAction({ ...second, ...changes, pair: { x: 0.02, y: 0.02 } }),
      /Invalid (double-tap tolerance|click sequence)/,
      JSON.stringify(changes),
    );
  assert.throws(() => inputAction({ ...second, clickState: 1, pair: { x: 0.02, y: 0.02 } }), /Invalid double-tap tolerance/);
  // The control connection hands it to the computer's helper unchanged.
  const { EventEmitter } = await import("node:events");
  const { desktopConnection } = await import("../server/desktop-connection.mjs");
  const { ScreenControl } = await import("../server/screen.mjs");
  // The owner's own phone (a device): a Windows PC lets only the owner control.
  const owner = { id: "owner", kind: "device", scopes: ["admin", "screen"] };
  const control = new ScreenControl();
  control.acquire(owner, true);
  const helped = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, sent: [],
    send(m) { this.sent.push(JSON.parse(m)); },
    close() { this.readyState = 2; },
  });
  desktopConnection(ws, {
    config: { screen: true }, auth: { verify: () => owner }, control, scanner: null,
    create: async () => ({ async send(action) { helped.push(action); return { ok: true, clickState: 2 }; }, stop() {} }),
  });
  const message = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  // Waits by the clock, not by turns: Windows' timers tick every ~15 ms.
  const until = async (check) => {
    for (const end = Date.now() + 10000; !check() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
    assert.ok(check(), `the computer said: ${JSON.stringify(ws.sent)}`);
  };
  message({ type: "auth", token: "T", display: "primary" });
  await until(() => ws.sent.some((m) => m.type === "ready"));
  message({ type: "input", id: 1, action: { ...second, pair: { x: 0.03, y: 0.05 } } });
  await until(() => ws.sent.some((m) => m.type === "ack" || m.type === "error"));
  assert.deepEqual(helped.at(-1), { ...second, pair: { x: 0.03, y: 0.05 } }, JSON.stringify(ws.sent));
  ws.readyState = 3;
  ws.emit("close", 1000);
});
test("a double-tap is the same spot on the glass, even when the picture moved between the two taps", () => {
  const clicks = new TapClicks();
  const first = clicks.next(point, 0, "touch", image, { x: 120, y: 340 });
  // The first tap opened the keyboard; the view made room for it: the same
  // spot on the glass now shows a point well above the first.
  const second = clicks.next({ x: 0.3, y: 0.1 }, 150, "touch", image, { x: 122, y: 341 });
  assert.equal(second.clickState, 2);
  assert.equal(second.clickId, first.clickId);
  assert.deepEqual(second.point, point, "the pair goes where the finger first aimed");
  // Two spots on the glass showing two targets: two taps.
  const other = new TapClicks();
  other.next(point, 0, "touch", image, { x: 120, y: 340 });
  assert.equal(other.next({ x: 0.4, y: 0.4 }, 150, "touch", image, { x: 160, y: 340 }).clickState, 1);
});
test("a finger that followed the moved picture to the same target is a pair too", () => {
  const clicks = new TapClicks();
  clicks.next(point, 0, "touch", image, { x: 120, y: 340 });
  const second = clicks.next(point, 150, "touch", image, { x: 120, y: 300 });
  assert.equal(second.clickState, 2);
  assert.deepEqual(second.point, point);
});
