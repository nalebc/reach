import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import { inputAction } from "../server/desktop-protocol.mjs";

const { outputText } = ts.transpileModule(
  await fs.readFile(new URL("../src/scroll-speed.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
);
const { scrollSpeed, TRAVEL, STEP } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("scroll handle: still near the press point, nothing scrolls", () => {
  for (const offset of [0, 3, -6, 6]) assert.equal(scrollSpeed(offset), 0);
});

test("scroll handle: finger down scrolls down the page, up scrolls up", () => {
  assert.ok(scrollSpeed(30) < 0, "down → negative dy (toward the end of the page)");
  assert.ok(scrollSpeed(-30) > 0, "up → positive dy (toward the top)");
  assert.equal(scrollSpeed(30), -scrollSpeed(-30));
});

test("scroll handle: further is faster, and every event is accepted by the host", () => {
  let previous = 0;
  for (let offset = 7; offset <= TRAVEL; offset++) {
    const speed = Math.abs(scrollSpeed(offset));
    assert.ok(speed >= previous, `speed grows with distance at ${offset}px`);
    assert.ok(speed <= STEP);
    previous = speed;
    for (const dy of [scrollSpeed(offset), scrollSpeed(-offset)])
      assert.doesNotThrow(() => inputAction({ type: "scroll", dx: 0, dy }));
  }
  assert.ok(Math.abs(scrollSpeed(TRAVEL)) >= 60, "full travel scrolls quickly");
});
