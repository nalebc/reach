import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const source = await fs.readFile(
  new URL("../src/screen-pointer.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { screenPoint } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("screen coordinates: fit view, Retina frame, corners and unloaded frames", () => {
  const box = { left: 20, top: 80, width: 800, height: 450 };
  assert.deepEqual(screenPoint(420, 305, box, 3200, 1800), { x: 0.5, y: 0.5 });
  assert.deepEqual(screenPoint(20, 80, box, 1600, 900), { x: 0, y: 0 });
  assert.deepEqual(screenPoint(820, 530, box, 1600, 900), { x: 1, y: 1 });
  assert.equal(screenPoint(19, 80, box, 1600, 900), null);
  assert.equal(screenPoint(20, 80, box, 0, 0), null);
  assert.equal(screenPoint(NaN, 80, box, 1600, 900), null);
  assert.equal(screenPoint(20, 80, { ...box, width: 0 }, 1600, 900), null);
});
test("fullscreen letterboxing never turns black bars into remote clicks", () => {
  const wide = { left: 0, top: 50, width: 1200, height: 400 };
  assert.deepEqual(screenPoint(600, 250, wide, 1600, 900), { x: 0.5, y: 0.5 });
  assert.equal(screenPoint(20, 250, wide, 1600, 900), null);
  const portrait = { left: 0, top: 60, width: 390, height: 700 };
  assert.deepEqual(screenPoint(195, 410, portrait, 1600, 900), {
    x: 0.5,
    y: 0.5,
  });
  assert.equal(screenPoint(195, 80, portrait, 1600, 900), null);
  assert.equal(screenPoint(195, 740, portrait, 1600, 900), null);
});
test("zoom and scroll keep remote coordinates at the same location", () => {
  const image = { left: -300, top: -140, width: 1800, height: 1012.5 };
  assert.deepEqual(screenPoint(1050, 113.125, image, 3200, 1800), {
    x: 0.75,
    y: 0.25,
  });
  // Resizing changes CSS dimensions, never the normalized remote target.
  assert.deepEqual(
    screenPoint(
      405,
      20,
      { left: 0, top: 0, width: 540, height: 500 },
      1600,
      900,
    ),
    null,
  );
  const resized = { left: 10, top: 20, width: 400, height: 225 };
  assert.deepEqual(screenPoint(310, 76.25, resized, 3200, 1800), {
    x: 0.75,
    y: 0.25,
  });
});

const geometrySource = await fs.readFile(
  new URL("../src/desktop-geometry.ts", import.meta.url),
  "utf8",
);
const geometry = ts.transpileModule(geometrySource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { typingView } = await import(
  `data:text/javascript;base64,${Buffer.from(geometry).toString("base64")}`
);
test("typing keeps the tapped field visible across keyboard resize, orientation and display aspect ratios", () => {
  for (const [screenW, screenH] of [
    [1440, 900],
    [3200, 1800],
    [1080, 1920],
  ]) {
    for (const [width, height] of [
      [390, 640],
      [390, 280],
      [844, 100],
      [320, 35],
    ]) {
      const fit = Math.min(width / screenW, height / screenH),
        baseW = screenW * fit,
        baseH = screenH * fit;
      for (const point of [
        { x: 0.03, y: 0.05 },
        { x: 0.9, y: 0.92 },
        { x: 0.5, y: 0.5 },
      ]) {
        const view = typingView(
          { scale: 1, x: 0, y: 0 },
          point,
          baseW,
          baseH,
          width,
          height,
        );
        const left = (width - baseW * view.scale) / 2 + view.x,
          top = (height - baseH * view.scale) / 2 + view.y;
        const px = left + point.x * baseW * view.scale,
          py = top + point.y * baseH * view.scale;
        assert(px >= 0 && px <= width, `field x ${px} outside ${width}`);
        assert(py >= 0 && py <= height, `field y ${py} outside ${height}`);
        assert(view.scale >= 1 && view.scale <= 4);
        const mapped = screenPoint(
          px,
          py,
          { left, top, width: baseW * view.scale, height: baseH * view.scale },
          screenW,
          screenH,
        );
        assert(Math.abs(mapped.x - point.x) < 1e-8);
        assert(Math.abs(mapped.y - point.y) < 1e-8);
      }
    }
  }
  assert.equal(
    typingView(
      { scale: 4, x: 30, y: 50 },
      { x: 0.5, y: 0.5 },
      390,
      244,
      390,
      280,
    ).scale,
    4,
  );
});

test("opening the phone keyboard never increases the user's screen zoom", () => {
  for (const scale of [1, 1.5, 2, 4]) {
    const view = typingView({ scale, x: 0, y: 0 }, { x: .8, y: .9 }, 390, 244, 390, 280);
    assert.equal(view.scale, scale);
  }
});
