import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startComputer, phone, skip, word, needsDesktop, macInUse, markInput, desktopTurn, clickTarget } from "../helpers/journey.mjs";

// Updates and Pause. Settings says whether this Reach is up to date (asked
// of npm, as an installed Reach asks). Pause on Home stops Reach using the
// computer: the screen and control end, said where they were; Resume brings
// them back, and a tap clicks again (a window of the test's own, orange
// until a click reaches it, then green, read off the phone's own screen).
const place = (at) => `(() => {
  const c = document.querySelector("canvas.remote-canvas");
  if (!c || c.width <= 300 || getComputedStyle(c).visibility !== "visible") return null;
  const box = c.getBoundingClientRect();
  return { x: box.left + ${at.x} * box.width, y: box.top + ${at.y} * box.height };
})()`;
const orange = ({ r, g, b }) => r > 190 && g > 80 && g < 190 && b < 100 && r > g + 40;
const green = ({ r, g, b }) => g > 130 && g > r + 40 && g > b + 40;
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

test(`Updates: Settings says whether Reach on this ${word} is up to date`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  await page.tap(`.workspace-settings`, "Settings in the header");
  const state = await page.see(
    () => {
      const v = document.querySelector("button.interface-updates .gs-value")?.innerText?.trim();
      return v && v !== "Checking…" && v;
    },
    "Reach's update state",
    90000,
  );
  await page.shot("updates");
  assert.match(state, /^(Up to date|Update to \S+|\S+ available|Ready, installs when idle)$/, `said plainly: ${state}`);
});

test(
  `Pause: Pause on Home stops Reach using this ${word}, and Resume brings its screen and control back`,
  { skip: skip || needsDesktop || macInUse(), timeout: 300000 },
  async (t) => {
    if (!(await desktopTurn(t))) return;
    const computer = await startComputer(t);
    const target = await clickTarget(t, fs.mkdtempSync(path.join(computer.reach.temp, "target-")));
    const page = await phone(t, computer);
    await page.skipIntro();
    // Pause, from Home.
    await page.tap(`button.home-pause[aria-label="Pause Reach on your ${word}"]`, "Pause, on Home");
    await page.see(() => document.querySelector(`button.home-pause[aria-label^="Resume Reach on your"]`), "Pause turned to Resume", 30000);
    await page.see(/· paused/, "Home saying it's paused", 30000);
    await page.shot("paused-home");
    // The screen, paused: said there, with no way to control it.
    await page.tap(`nav.mobile-nav button[aria-label="Screen"]`, "Screen in the bottom bar");
    await page.see(() => document.querySelector(".paused-cover")?.innerText, "the screen paused", 30000);
    await page.see(`Reach isn't using your ${word} right now.`, "why the screen is empty");
    assert.equal(await page.evaluate(`!!document.querySelector('[aria-label="Screen controls"] button[aria-label="Control"]')`), false, "no Control while paused");
    await page.shot("paused-screen");
    // Resume, where the screen would be: the picture and control again.
    await page.tap({ selector: ".paused-cover button", text: "Resume" }, "Resume");
    await page.see({ js: place(target.aside) }, "the live screen again", 120000);
    await showing(page, target, orange, "the target window on the phone's picture", 60000);
    await page.tap(`[aria-label="Screen controls"] button[aria-label="Control"]`, "Control");
    await page.see(() => document.querySelector('[aria-label="Screen controls"] button[aria-pressed="true"]'), "control on", 30000);
    await page.see(() => !/Connecting controls|View only/.test(document.querySelector(".simple-screen-caption")?.innerText || ""), "controls connected", 30000);
    await showing(page, target, orange, "the window, still there", 10000);
    const where = await page.evaluate(place(target.at));
    await page.touch(where.x, where.y);
    markInput();
    await showing(page, target, green, "the window turned green on the phone's picture", 30000);
    assert.equal(target.clicks(), 1, "one click reached the window once resumed, read on the computer");
    await page.shot("resumed");
  },
);
