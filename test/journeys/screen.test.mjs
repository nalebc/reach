import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startComputer, phone, skip, word, needsDesktop, macInUse, markInput, desktopTurn, clickTarget } from "../helpers/journey.mjs";

// Screen and control: the computer's live screen on the phone, and a tap
// that clicks where it lands. The target is a window of the test's own,
// orange until a click reaches it, then green, so the step's outcome is on
// the phone's own picture, and the computer says so too, apart from Reach.
// A tap goes only where the phone's picture shows that window: never
// anywhere else on a Mac someone owns.

// Where the phone's picture shows a share of the display ({ x, y } from 0
// to 1), on the page, once the picture is live.
const place = (at) => `(() => {
  const c = document.querySelector("canvas.remote-canvas");
  if (!c || c.width <= 300 || getComputedStyle(c).visibility !== "visible") return null;
  const box = c.getBoundingClientRect();
  return { x: box.left + ${at.x} * box.width, y: box.top + ${at.y} * box.height, width: c.width, height: c.height };
})()`;
// As the picture carries them (its video changes colours a little).
const orange = ({ r, g, b }) => r > 190 && g > 80 && g < 190 && b < 100 && r > g + 40;
const green = ({ r, g, b }) => g > 130 && g > r + 40 && g > b + 40;
// Until the phone shows `check`'s colour where the window is, as a person
// sees it (the phone's own screen); then that spot.
async function showing(page, target, check, what, ms) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    const spot = await page.evaluate(place(target.aside));
    if (!spot) continue;
    last = { ...spot, ...(await page.pixel(spot.x, spot.y)) };
    if (check(last)) return last;
  }
  let file;
  try { file = await page.shot(`failed-${what}`); } catch {}
  await page.recordFailure(what, file, { sample: last, target: target.snapshot() });
  assert.fail(`The phone never showed ${what}: last ${JSON.stringify(last)}. Screenshot: ${file}`);
}

test(
  `Screen: this ${word}'s live screen shows on the phone, and a tap clicks where it lands`,
  { skip: skip || needsDesktop || macInUse(), timeout: 300000 },
  async (t) => {
    if (!(await desktopTurn(t))) return;
    const computer = await startComputer(t);
    const target = await clickTarget(t, fs.mkdtempSync(path.join(computer.reach.temp, "target-")));
    const page = await phone(t, computer);
    await page.skipIntro();
    await page.tap(`nav.mobile-nav button[aria-label="Screen"]`, "Screen in the bottom bar");
    // Frames: the picture, live, with the target window in it.
    const seen = await page.see({ js: place(target.at) }, "the live screen", 120000);
    assert.ok(seen.width > 300 && seen.height > 150, `a frame of the screen (${seen.width}×${seen.height})`);
    await showing(page, target, orange, "the target window on the phone's picture", 60000);
    await page.shot("live");
    await page.tap(`[aria-label="Screen controls"] button[aria-label="Control"]`, "Control");
    await page.see(() => document.querySelector('[aria-label="Screen controls"] button[aria-pressed="true"]'), "control on", 30000);
    await page.see(() => !/Connecting controls|View only/.test(document.querySelector(".simple-screen-caption")?.innerText || ""), "controls connected", 30000);
    // The tap, at the window's middle, where the phone's picture shows it.
    await showing(page, target, orange, "the window, still there", 10000);
    const where = await page.evaluate(place(target.at));
    await page.touch(where.x, where.y);
    markInput();
    await showing(page, target, green, "the window turned green on the phone's picture", 30000);
    assert.equal(target.clicks(), 1, "one click reached the window, read on the computer");
    await page.shot("clicked");
  },
);
