import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { startComputer, phone, skip, word, desktop } from "../helpers/journey.mjs";

// Home, the first page a new phone sees once it's in: the computer's card
// with its screen preview and status; access management lives in Tools. Its words name
// the computer as it is: "Mac" on a Mac, "Windows PC" on a Windows PC.
const name = os.hostname().replace(/\.local$/, "");

test(`Home: a new phone signs in, and Home shows this ${word} by its name, online, with only you on it`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  const title = await page.see(() => document.querySelector(".workspace-computer")?.textContent, "the computer's card");
  assert.ok(title.includes(name), "the header names the computer as it names itself");
  await page.see(() => document.querySelector(".home-connection summary")?.getAttribute("aria-label") === "Connection details: Connected", "the computer connected");
  // Its screen, live inside the card, or why not, said on it.
  if (desktop)
    await page.see(
      () => /Live preview/.test(document.querySelector(".home-preview-state")?.innerText || "") || document.querySelector(".home-hero-status")?.innerText,
      "the screen live on the card, or why not",
      90000,
    );
  assert.equal(await page.evaluate(`!!document.querySelector(".home-section, .home-stories, .home-now")`), false, "Home has no chat activity section");
  assert.equal(await page.evaluate(`!!document.querySelector(".home-access, .home-presence")`), false, "alone, no access inventory on Home");
  // Its words never name the other platform.
  const other = word === "Mac" ? /\bWindows PC\b|\bPC\b/ : /\bMac\b/;
  assert.doesNotMatch(await page.text(), other);
  await page.shot("home");
  await page.tap('[aria-label="Tools"]', "Tools");
  await page.tap('[aria-label="Agents & people"]', "access management");
  // Agents & people, its own page. Whether it names the computer again
  // depends on how many this phone has (jsdom: computer-name-ui.test.mjs).
  await page.see(() => document.querySelector(".ppl-head h1")?.textContent === "Agents & people", "Agents & people, opened from Tools");
  await page.see(/This device/, "this phone among your devices");
  await page.shot("agents-and-people");
});
