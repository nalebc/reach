import test from "node:test";
import assert from "node:assert/strict";
import { startComputer, phone, skip } from "../helpers/journey.mjs";

// Settings, as the owner's phone opens it from More: how the phone is
// connected (a dot and a word, nothing to choose), then this computer, and
// at the end which Reach it runs.
test("Settings: the connection with its dot, and Reach's version", { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  await page.see(() => document.querySelector(".home-hero-text h1")?.textContent, "Home");
  await page.tap('button[aria-label="More workspace options"]', "More");
  await page.see(() => document.querySelector(".more-sheet"), "More");
  await page.shot("more");
  await page.tap({ selector: "button.more-row", text: "Settings" }, "Settings");
  const route = await page.see(() => document.querySelector(".connection-row .conn-status")?.textContent, "the connection row");
  assert.equal(route, "Tailscale app", "the phone reaches it over Tailscale, said in words");
  const tone = await page.evaluate(`document.querySelector(".connection-row .conn-status").className`);
  assert.match(tone, /\bbest\b/, "the preferred private route: the green dot");
  const version = await page.see(() => document.querySelector(".interface-updates .reach-version")?.textContent, "Reach's version");
  assert.match(version, /^Version \d+\.\d+\.\d+/);
  await page.shot("settings");
  // Scrolled to the end, the last row sits clear of the floating bottom bar.
  const layout = await page.evaluate(`(() => {
    const end = document.querySelector(".gs-end");
    let box = end.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    (box || document.scrollingElement).scrollTop = 1e6;
    const nav = document.querySelector("nav.mobile-nav")?.getBoundingClientRect();
    return JSON.stringify({ scroller: (box || document.scrollingElement).className, end: end.getBoundingClientRect().bottom, nav: nav ? nav.top : null });
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await page.shot("settings-end");
  const { end, nav, scroller } = JSON.parse(layout);
  if (nav !== null) assert.ok(end <= nav, `Forget this computer clears the bottom bar (${scroller}: row ends ${end}, bar starts ${nav})`);
});
