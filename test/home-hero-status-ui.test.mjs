import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startDom } from "./dom/harness.mjs";

// Home's live preview names why it shows no fresh picture, as one small pill
// (tap: try again), instead of just staying dark.
let dom, heroStatus;
before(async () => {
  dom = await startDom();
  ({ heroStatus } = await dom.load("/src/HomeLive.tsx"));
});
after(async () => dom?.close());

const quiet = { error: "", cause: "", connecting: false, idle: "" };

test("the pill names the cause in a few words, and says nothing while live or starting", () => {
  assert.equal(heroStatus(quiet), "");
  assert.equal(heroStatus({ ...quiet, connecting: true }), "", "simply connecting");
  assert.equal(heroStatus({ ...quiet, connecting: true, idle: "asleep", cause: "Mac asleep" }), "Mac asleep");
  assert.equal(heroStatus({ ...quiet, connecting: true, idle: "locked", cause: "Mac locked" }), "Mac locked");
  // The helper stopped while the Mac slept: its reason, reconnecting.
  assert.equal(
    heroStatus({ ...quiet, connecting: true, cause: "The Mac is locked. The screen comes back when it's unlocked." }),
    "Mac locked",
  );
  assert.equal(
    heroStatus({
      ...quiet,
      error:
        "Screen Recording is off for Terminal. On your Mac, open System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording on older macOS). Allow Terminal, then quit and reopen Terminal and restart Reach.",
    }),
    "Screen Recording off",
  );
  assert.equal(heroStatus({ ...quiet, error: "Screen access expired or was revoked." }), "Can't show screen");
  assert.equal(
    heroStatus({ ...quiet, connecting: true, cause: "Screen stream stalled. Reconnecting…" }),
    "Reconnecting",
  );
  assert.equal(heroStatus({ ...quiet, connecting: true, idle: "asleep" }, "Windows PC"), "Windows PC asleep");
});

test("the hero shows the pill beside the scene, dims the held picture, and a tap reconnects", async () => {
  const home = await fs.readFile(new URL("../src/HomeLive.tsx", import.meta.url), "utf8");
  // Its own button, beside the scene container (nested buttons aren't allowed).
  assert.match(home, /<\/div>\s*\{heroPill && \(\s*\/\/[^\n]*\n\s*<button\s+className="home-hero-status"/);
  assert.match(home, /onClick=\{\(\) => setHeroRetry\(\(n\) => n \+ 1\)\}/);
  assert.match(home, /"preview",\s*heroRetry,/);
  assert.match(home, /live && heroPill \? "is-held" : ""/);
  const css = await fs.readFile(new URL("../src/home-live.css", import.meta.url), "utf8");
  assert.match(css, /\.home-peek\.is-live\.is-held \{/);
  assert.match(css, /\.home-hero-status \{/);
});
