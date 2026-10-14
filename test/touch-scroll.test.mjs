import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
const source = await fs.readFile(
  new URL("../src/touch-scroll.ts", import.meta.url),
  "utf8",
);
const { TouchScroll } = await import(
  `data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`
);

test("slow finger movement stays precise, faster swipes progressively travel farther in either axis", () => {
  for (const axis of ["x", "y"]) {
    const distances = [];
    for (const interval of [100, 32, 16, 8]) {
      const scroll = new TouchScroll();
      scroll.begin({ x: 0, y: 0 }, 0);
      let total = 0;
      for (let i = 1; i <= 12; i++) {
        const point = { x: 0, y: 0, [axis]: -i * 20 };
        const step = scroll.move(point, interval * i);
        total += Math.abs(step[axis === "x" ? "dx" : "dy"]);
        assert.equal(step[axis === "x" ? "dy" : "dx"], 0);
      }
      distances.push(total);
    }
    assert.equal(distances[0], 240);
    for (let i = 1; i < distances.length; i++)
      assert.ok(distances[i] > distances[i - 1]);
    assert.ok(distances.at(-1) <= 720, "acceleration stays bounded");
  }
});

test("coasting decays smoothly with comparable distance on 60 Hz and 120 Hz screens", () => {
  const travel = [];
  for (const interval of [1000 / 60, 1000 / 120]) {
    const scroll = new TouchScroll();
    scroll.begin({ x: 0, y: 0 }, 0);
    scroll.move({ x: 0, y: -100 }, 50);
    assert.equal(scroll.lift(50), true);
    let total = 0,
      previous = Infinity;
    for (let at = 50 + interval; at < 1700; at += interval) {
      const step = scroll.step(at);
      if (!step) break;
      assert.ok(step.dy < 0 && Math.abs(step.dy) <= previous);
      assert.ok(Math.abs(step.dy) <= 120 && step.dx === 0);
      previous = Math.abs(step.dy);
      total -= step.dy;
    }
    assert.equal(scroll.coasting, false);
    assert.ok(total > 500);
    travel.push(total);
  }
  assert.ok(
    Math.abs(travel[0] - travel[1]) < 5,
    "refresh rate must not change the fling's distance",
  );
});

test("resting before lift, tiny movement and a suspended frame produce no stale fling", () => {
  const scroll = new TouchScroll();
  scroll.begin({ x: 0, y: 0 }, 0);
  scroll.move({ x: 0, y: -100 }, 50);
  scroll.move({ x: 0, y: -100 }, 200);
  assert.equal(
    scroll.lift(200),
    false,
    "stationary events do not renew old velocity",
  );
  scroll.begin({ x: 0, y: 0 }, 200);
  scroll.move({ x: 0, y: -3 }, 216);
  assert.equal(scroll.lift(216), false);
  scroll.begin({ x: 0, y: 0 }, 300);
  scroll.move({ x: 0, y: -100000 }, 316);
  assert.equal(scroll.lift(316), true);
  assert.ok(Math.abs(scroll.step(332).dy) <= 120);
  assert.equal(scroll.step(1000), null);
  assert.equal(scroll.coasting, false);
});

test("reversal uses the new direction; reset immediately discards momentum", () => {
  const scroll = new TouchScroll();
  scroll.begin({ x: 0, y: 0 }, 0);
  scroll.move({ x: 0, y: -100 }, 50);
  const reversed = scroll.move({ x: 0, y: -60 }, 66);
  assert.ok(reversed.dy > 0);
  assert.equal(scroll.lift(66), true);
  assert.ok(scroll.step(82).dy > 0);
  scroll.reset();
  assert.equal(scroll.coasting, false);
  assert.equal(scroll.step(98), null);
});
