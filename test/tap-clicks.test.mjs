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
