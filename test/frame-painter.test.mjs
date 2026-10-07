import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

// The phone shows video without falling behind: one draw per screen refresh,
// always the newest frame; frames it couldn't show are released, not queued.
const { outputText } = ts.transpileModule(
  await fs.readFile(
    new URL("../src/frame-painter.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
);
const { latestFramePainter } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

function setup() {
  const drawn = [],
    closed = [];
  let refresh = null,
    scheduled = 0,
    cancelled = 0;
  const painter = latestFramePainter(
    (frame) => drawn.push(frame.id),
    (callback) => {
      scheduled++;
      refresh = callback;
      return scheduled;
    },
    () => {
      cancelled++;
      refresh = null;
    },
  );
  const frame = (id) => ({ id, close: () => closed.push(id) });
  const tick = () => {
    const run = refresh;
    refresh = null;
    run?.();
  };
  return {
    painter,
    frame,
    tick,
    drawn,
    closed,
    counts: () => ({ scheduled, cancelled }),
  };
}

test("frames that arrive faster than the screen refreshes are skipped, not queued", () => {
  const { painter, frame, tick, drawn, closed, counts } = setup();
  painter.push(frame(1));
  painter.push(frame(2));
  painter.push(frame(3));
  assert.deepEqual(drawn, []);
  assert.equal(counts().scheduled, 1);
  tick();
  assert.deepEqual(drawn, [3]);
  assert.deepEqual(closed, [1, 2, 3]);
  painter.push(frame(4));
  tick();
  assert.deepEqual(drawn, [3, 4]);
  assert.equal(counts().scheduled, 2);
});

test("stopping releases the waiting frame and draws nothing more", () => {
  const { painter, frame, tick, drawn, closed, counts } = setup();
  painter.push(frame(1));
  painter.stop();
  tick();
  assert.deepEqual(drawn, []);
  assert.deepEqual(closed, [1]);
  assert.equal(counts().cancelled, 1);
});

test("a frame is released even when drawing it fails", () => {
  const closed = [];
  let refresh;
  const painter = latestFramePainter(
    () => {
      throw Error("lost canvas");
    },
    (callback) => ((refresh = callback), 1),
    () => {},
  );
  painter.push({ close: () => closed.push(1) });
  assert.throws(() => refresh(), /lost canvas/);
  assert.deepEqual(closed, [1]);
});
