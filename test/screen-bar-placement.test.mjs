import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The control bar floated over the bottom of the picture even when the Screen
// wasn't full screen and there was room below it. Outside full screen it sits
// under the picture; in full screen it still floats at the bottom center.
const css = fs.readFileSync(new URL("../src/screen-bar.css", import.meta.url), "utf8");

test("outside full screen the control bar sits below the picture", () => {
  const rule = css.match(
    /\.simple-screen:not\(\.screen-expanded\):not\(:fullscreen\) > \.simple-screen-dock\.screen-bar-dock \{([^}]*)\}/,
  );
  assert.ok(rule, "a rule for the non-fullscreen bar");
  assert.match(rule[1], /position: relative;/);
  assert.match(rule[1], /bottom: auto;/);
  assert.match(rule[1], /transform: none;/);
  // It comes after the floating rule so it wins.
  assert.ok(css.indexOf(rule[0]) > css.indexOf("position: absolute;"));
});

test("in full screen the control bar still floats at the bottom", () => {
  assert.match(
    css,
    /\.simple-screen\.screen-immersive > \.simple-screen-dock\.screen-bar-dock,[\s\S]*?position: absolute;[\s\S]*?bottom: max\(12px, env\(safe-area-inset-bottom\)\);/,
  );
});
