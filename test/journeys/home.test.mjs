import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { startComputer, phone, skip, word, desktop } from "../helpers/journey.mjs";

// Home, the first page a new phone sees once it's in: the computer's card
// with its own name, its status and what's live on it, and the Access card
// (who may use it, one tap from Agents & people and Invite). Its words name
// the computer as it is: "Mac" on a Mac, "Windows PC" on a Windows PC.
const name = os.hostname().replace(/\.local$/, "");

test(`Home: a new phone signs in, and Home shows this ${word} by its name, online, with only you on it`, { skip, timeout: 240000 }, async (t) => {
  const computer = await startComputer(t);
  const page = await phone(t, computer);
  await page.skipIntro();
  const title = await page.see(() => document.querySelector(".home-hero-text h1")?.textContent, "the computer's card");
  assert.equal(title, name, "the card names the computer as it names itself");
  await page.see(/Online · Tailscale/, "the computer online over Tailscale");
  // Its screen, live inside the card, or why not, said on it.
  if (desktop)
    await page.see(
      () => /· live/.test(document.querySelector(".home-hero-text")?.innerText || "") || document.querySelector(".home-hero-status")?.innerText,
      "the screen live on the card, or why not",
      90000,
    );
  // What runs on it: its own terminals as they are, or how to start one.
  const live = await page.see(() => document.querySelector(".home-section")?.innerText, `"Live on your ${word}"`);
  assert.match(live, new RegExp(`^Live on your ${word}\\n`));
  assert.match(live, /\b(Start|New)\b/);
  // The Access card: only you so far, Agents & people one tap away.
  const access = await page.see(() => document.querySelector(".home-access")?.innerText, "the Access card");
  assert.match(access, /Only you/);
  assert.match(access, /Agents & people/);
  assert.match(access, /Invite/);
  // Its words never name the other platform.
  const other = word === "Mac" ? /\bWindows PC\b|\bPC\b/ : /\bMac\b/;
  assert.doesNotMatch(await page.text(), other);
  await page.shot("home");
  await page.tap(".home-access-who", "the Access card");
  await page.see(`Who can use ${name}`, "Agents & people, opened from the card");
  await page.see(/This device/, "this phone among your devices");
  await page.shot("agents-and-people");
});
