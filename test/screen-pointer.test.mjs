import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
const source = await fs.readFile(
  new URL("../src/screen-pointer.ts", import.meta.url),
  "utf8",
);
const outputText = transpile(source);
const { screenPoint, screenImageRect, screenTouchTolerance } = await import(
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

test("mapping and finger tolerance share CSS pixels across Retina, zoom, letterboxing and browser scaling", () => {
  for (const box of [
    { left: 20, top: 80, width: 800, height: 450 },
    { left: -300, top: -140, width: 1800, height: 1012.5 },
    { left: 7, top: 15, width: 480, height: 270 },
    { left: 0, top: 60, width: 390, height: 700 },
    { left: 0, top: 50, width: 1200, height: 400 },
  ]) {
    for (const density of [1, 2, 3]) {
      const width = 1600 * density, height = 900 * density;
      const image = screenImageRect(box, width, height), tolerance = screenTouchTolerance(box, width, height);
      assert.ok(Math.abs(tolerance.x * image.width - 10) < 1e-8);
      assert.ok(Math.abs(tolerance.y * image.height - 10) < 1e-8);
      for (const point of [{ x: 0, y: 0 }, { x: 0.003, y: 0.997 }, { x: 0.75, y: 0.25 }, { x: 1, y: 1 }]) {
        const actual = screenPoint(image.left + image.width * point.x, image.top + image.height * point.y, box, width, height);
        assert.ok(Math.abs(actual.x - point.x) < 1e-8);
        assert.ok(Math.abs(actual.y - point.y) < 1e-8);
      }
    }
  }
  const tiny = { left: 0, top: 0, width: 50, height: 25 };
  assert.deepEqual(screenTouchTolerance(tiny, 2000, 1000), { x: 0.1, y: 0.1 }, "bounded for small thumbnails");
  for (const box of [{ ...tiny, width: 0 }, { ...tiny, top: NaN }]) {
    assert.equal(screenImageRect(box, 2000, 1000), null);
    assert.equal(screenTouchTolerance(box, 2000, 1000), undefined);
  }
  assert.equal(screenTouchTolerance(tiny, 0, 0), undefined);
});

test("a held drag clamps to the picture's edges, respecting letterboxing", () => {
  const box = { left: 20, top: 30, width: 1000, height: 1000 };
  assert.equal(screenPoint(520, 80, box, 2000, 1000), null, "a letterbox tap is still ignored");
  assert.deepEqual(screenPoint(520, 80, box, 2000, 1000, true), { x: 0.5, y: 0 });
  assert.deepEqual(screenPoint(-100, 2000, box, 2000, 1000, true), { x: 0, y: 1 });
  assert.equal(screenPoint(520, 80, box, 0, 0, true), null);
});

const geometrySource = await fs.readFile(
  new URL("../src/desktop-geometry.ts", import.meta.url),
  "utf8",
);
const geometry = transpile(geometrySource);
const { typingView, dragView } = await import(
  `data:text/javascript;base64,${Buffer.from(geometry).toString("base64")}`
);

test("edge dragging reveals each side of a zoomed display and stays still in the middle or at Fit", () => {
  const initial = { scale: 2, x: 0, y: 0 };
  assert.deepEqual(dragView(initial, { x: 500, y: 250 }, 0.032, 1000, 500, 1000, 500), initial);
  const fit = { scale: 1, x: 0, y: 0 };
  assert.deepEqual(dragView(fit, { x: 0, y: 0 }, 0.032, 1000, 500, 1000, 500), fit);
  for (const [finger, x, y] of [
    [{ x: 0, y: 0 }, 548, 298],
    [{ x: 1000, y: 500 }, -548, -298],
  ]) {
    let v = initial;
    for (let i = 0; i < 100; i++) v = dragView(v, finger, 0.032, 1000, 500, 1000, 500);
    assert.deepEqual(v, { scale: 2, x, y });
  }
});
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

test("typing on a phone on its side spans the strip above the keyboard, field in view", () => {
  // A 16:10 Mac in the 844×150 strip left above a landscape keyboard.
  const baseW = 240, baseH = 150;
  const view = typingView({ scale: 1, x: 0, y: 0 }, { x: 0.3, y: 0.8 }, baseW, baseH, 844, 150);
  assert.ok(Math.abs(view.scale - 844 / 240) < 1e-9);
  // The whole width shows; the field's row is inside the strip.
  assert.equal(view.x, 0);
  const top = (150 - baseH * view.scale) / 2 + view.y;
  const fieldY = top + 0.8 * baseH * view.scale;
  assert.ok(fieldY >= 0 && fieldY <= 150, `field y ${fieldY}`);
});
