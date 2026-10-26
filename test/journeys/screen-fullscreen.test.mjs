import test from "node:test";
import assert from "node:assert/strict";
import { startComputer, phone, skip, needsDesktop } from "../helpers/journey.mjs";

// Fullscreen, as a video plays it: the computer's picture and nothing else,
// upright or on its side. The controls float over it and fade until the
// screen is touched. This only looks: nothing is tapped on the picture and
// nothing reaches the desktop. The picture is painted grey before it can
// show (the computer is someone's), so screenshots keep only its place.
const MASK = `(() => { if (document.getElementById("journey-mask")) return; const s = document.createElement("style"); s.id = "journey-mask"; s.textContent = "canvas.remote-canvas, video { filter: brightness(0) invert(0.55) !important; }"; (document.head || document.documentElement).append(s); })()`;
const BOXES = `JSON.stringify(Object.fromEntries([["viewer", ".simple-screen"], ["stage", ".remote-stage"], ["picture", "canvas.remote-canvas"], ["toolbar", ".simple-screen-toolbar"], ["dock", ".simple-screen-dock"]].map(([k, s]) => {
  const e = document.querySelector(s); if (!e) return [k, null];
  const r = e.getBoundingClientRect();
  return [k, { x: r.x, y: r.y, w: r.width, h: r.height, opacity: Number(getComputedStyle(e).opacity) }];
}).concat([["window", { w: innerWidth, h: innerHeight }]])))`;
const turn = (page, w, h, type, angle) =>
  page.tab.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 3, mobile: true, screenWidth: w, screenHeight: h, screenOrientation: { type, angle } });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function fillsTheScreen(boxes, what) {
  const { viewer, stage, picture, window: win } = boxes;
  const near = (a, b) => Math.abs(a - b) <= 1;
  assert.ok(near(viewer.w, win.w) && near(viewer.h, win.h), `${what}: the screen view covers the phone (${JSON.stringify(viewer)})`);
  assert.ok(near(stage.y, viewer.y) && near(stage.h, viewer.h) && near(stage.w, viewer.w), `${what}: no row is kept for the controls (${JSON.stringify(stage)})`);
  assert.ok(near(picture.w, stage.w) || near(picture.h, stage.h), `${what}: the picture as big as it fits (${JSON.stringify(picture)})`);
  assert.ok(near(picture.y - stage.y, stage.y + stage.h - picture.y - picture.h), `${what}: centred top to bottom`);
  assert.ok(near(picture.x - stage.x, stage.x + stage.w - picture.x - picture.w), `${what}: centred side to side`);
}

test("Screen fullscreen: the picture alone, upright and on its side, controls fading", { skip: skip || needsDesktop, timeout: 300000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.tab.send("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("DOMContentLoaded", ${MASK.replace(/^\(|\)\(\)$/g, "")})` });
  await page.evaluate(MASK);
  await turn(page, 390, 844, "portraitPrimary", 0);
  await page.skipIntro();
  await page.evaluate(MASK);
  await page.tap(`nav.mobile-nav button[aria-label="Screen"]`, "Screen in the bottom bar");
  await page.see(() => { const c = document.querySelector("canvas.remote-canvas"); return c && c.width > 300 && getComputedStyle(c).visibility === "visible"; }, "the live screen", 120000);
  await page.evaluate(MASK);

  await page.tap(`button[aria-label="Enter fullscreen"]`, "Enter fullscreen");
  await pause(800);
  fillsTheScreen(JSON.parse(await page.evaluate(BOXES)), "upright");
  await page.shot("upright-controls");
  // Untouched for a few seconds: the controls fade, the picture stays put.
  await page.see(() => document.querySelector(".simple-screen.chrome-hidden"), "the controls faded", 10000);
  await pause(400);
  const idle = JSON.parse(await page.evaluate(BOXES));
  fillsTheScreen(idle, "upright, untouched");
  assert.equal(idle.toolbar.opacity, 0, "the name bar faded");
  assert.equal(idle.dock.opacity, 0, "the controls faded");
  await page.shot("upright-alone");

  // On its side, the same.
  await turn(page, 844, 390, "landscapePrimary", 90);
  await pause(1500);
  await page.see(() => document.querySelector(".simple-screen.chrome-hidden"), "the controls faded on its side", 10000);
  await pause(400);
  const side = JSON.parse(await page.evaluate(BOXES));
  fillsTheScreen(side, "on its side");
  assert.equal(side.dock.opacity, 0, "the controls faded on its side");
  await page.shot("side-alone");
});

test("Screen fullscreen on Android: the button hides the browser's own bars too", { skip: skip || needsDesktop, timeout: 300000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer, { kind: "Android" });
  await turn(page, 412, 915, "portraitPrimary", 0);
  await page.tab.send("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("DOMContentLoaded", ${MASK.replace(/^\(|\)\(\)$/g, "")})` });
  await page.evaluate(MASK);
  await page.skipIntro();
  await page.evaluate(MASK);
  await page.tap(`nav.mobile-nav button[aria-label="Screen"]`, "Screen in the bottom bar");
  await page.see(() => { const c = document.querySelector("canvas.remote-canvas"); return c && c.width > 300 && getComputedStyle(c).visibility === "visible"; }, "the live screen", 120000);
  await page.evaluate(MASK);
  await page.tap(`button[aria-label="Enter fullscreen"]`, "Enter fullscreen");
  await page.see(() => document.fullscreenElement?.matches(".simple-screen"), "the browser's own fullscreen", 10000);
  // The controls fade; a finger lifted on the screen brings them back (here
  // on the name bar, so nothing lands on the computer's picture).
  await page.evaluate(`document.querySelector(".simple-screen-toolbar").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }))`);
  await page.tap(`button[aria-label="Exit fullscreen"]`, "Exit fullscreen");
  await page.see(() => !document.fullscreenElement && !document.querySelector(".screen-immersive"), "back to the page", 10000);
});
