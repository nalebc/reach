import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const source = await fs.readFile(
  new URL("../src/courier-physics.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { position, walkingFoot, joint, itinerary, GRAVITY } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
test("courier jumps reach their landing and accelerate under gravity", () => {
  for (const variant of [0, 1, 2])
    for (const move of itinerary(variant).filter((m) => m.kind === "jump")) {
      near(position(move, 0).y, move.from.y);
      near(position(move, 1).y, move.to.y);
      near(position(move, 1).x, move.to.x);
      const dt = 0.01,
        t = 0.4;
      near(
        (position(move, t + dt).y -
          2 * position(move, t).y +
          position(move, t - dt).y) /
          (dt * move.seconds) ** 2,
        GRAVITY,
      );
      assert.ok(
        position(move, 0.15).y < move.from.y,
        "jump must leave the surface upward",
      );
    }
});
test("a planted foot stays stationary in world space while the body walks", () => {
  const leftFirst = walkingFoot(1, 0, -1),
    leftLater = walkingFoot(5, 0, -1);
  near(-1 + leftFirst.x, -5 + leftLater.x);
  const first = walkingFoot(1, 0),
    later = walkingFoot(5, 0);
  near(1 + first.x, 5 + later.x);
  near(first.y, 0);
  near(later.y, 0);
  assert.ok(walkingFoot(10, 0).y < 0, "swinging foot clears the surface");
});
test("all roaming routes join continuously and every jump has anticipation and landing or grip", () => {
  for (const variant of [0, 1, 2]) {
    const moves = itinerary(variant);
    moves.forEach((move, i) => {
      if (i) assert.deepEqual(move.from, moves[i - 1].to);
      if (move.kind === "jump") {
        assert.equal(moves[i - 1].kind, "crouch");
        assert.ok(["land", "hang"].includes(moves[i + 1].kind));
      }
      if (move.kind === "walk") near(move.from.y, move.to.y);
      for (let t = 0; t <= 1; t += 0.05) {
        const p = position(move, t);
        assert.ok(p.x >= 50 && p.x <= 350);
        assert.ok(p.y >= 12 && p.y <= 212, "stay within the stage");
      }
    });
    assert.deepEqual(moves.at(-1).to, moves[0].from);
  }
});
test("knees and elbows retain bone lengths as limbs bend", () => {
  for (const target of [
    { x: 0, y: 13 },
    { x: 5, y: 8 },
    { x: -4, y: 12 },
  ])
    for (const bend of [-1, 1]) {
      const knee = joint({ x: 0, y: 0 }, target, 8, 8, bend);
      near(Math.hypot(knee.x, knee.y), 8);
      near(Math.hypot(knee.x - target.x, knee.y - target.y), 8);
    }
});
