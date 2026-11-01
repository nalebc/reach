import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reach's design tokens live in src/tokens.css only. These checks keep the
// drift they replaced from coming back: four stylesheets once each set the
// page colours on :root (whichever loaded last won), corners used 25
// lengths and weights 12 values.
const src = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);
const sheets = fs
  .readdirSync(src)
  .filter((f) => f.endsWith(".css"))
  .map((f) => [f, fs.readFileSync(path.join(src, f), "utf8")]);
const BASE = [
  "--bg",
  "--panel",
  "--border",
  "--muted",
  "--lime",
  "--lime-ink",
  "--radius",
];

test("only tokens.css sets the base tokens on :root", () => {
  const tokens = fs.readFileSync(path.join(src, "tokens.css"), "utf8");
  for (const name of [
    ...BASE,
    "--surface-0",
    "--surface-2",
    "--ink",
    "--ink-2",
    "--needs-you",
  ])
    assert.match(tokens, new RegExp(`^\\s*${name}:`, "m"), name);
  for (const [file, css] of sheets) {
    if (file === "tokens.css") continue;
    for (const block of css.matchAll(
      /(?:^|\})\s*([^{}]*:root[^{}]*)\{([^}]*)\}/g,
    )) {
      for (const name of BASE)
        assert.doesNotMatch(
          block[2],
          new RegExp(`(^|[;\\s])${name}\\s*:`),
          `${file} sets ${name} on ${block[1].trim()}`,
        );
    }
  }
});

test("every page's first stylesheet brings the tokens", () => {
  for (const file of ["styles.css", "start.css"])
    assert.match(
      fs.readFileSync(path.join(src, file), "utf8"),
      /^@import "\.\/tokens\.css";$/m,
      file,
    );
});

test("corners come from the radius scale", () => {
  for (const [file, css] of sheets) {
    if (file === "tokens.css") continue;
    for (const [, value] of css.matchAll(
      /border(?:-[a-z]+)*-radius:\s*([^;}]+)/g,
    ))
      assert.doesNotMatch(
        value,
        /(^|[\s(])\d*\.?\d+(px|rem|em)\b/,
        `${file}: border-radius ${value.trim()}`,
      );
  }
});

test("weights are 400, 500, 600 or 700", () => {
  for (const [file, css] of sheets) {
    if (file === "type.css") continue; // @font-face ranges
    for (const [, weight] of css.matchAll(/font-weight:\s*(\d+)/g))
      assert.ok(
        ["400", "500", "600", "700"].includes(weight),
        `${file}: font-weight ${weight}`,
      );
    for (const [, weight] of css.matchAll(/\bfont:\s*(\d{3})\s/g))
      assert.ok(
        ["400", "500", "600", "700"].includes(weight),
        `${file}: font ${weight}`,
      );
  }
});

test("page and sheet titles use the display face", () => {
  const css = Object.fromEntries(sheets);
  for (const [file, selector] of [
    ["people-hub.css", ".ppl-head h1"],
    ["people-hub.css", ".ppl-page .ppl-hero h1"],
    ["settings-list.css", ".gs-head h1"],
    ["sub-page.css", ".sub-page > h1"],
    ["sheet.css", ".screen-popup.reach-sheet .screen-popup-body > header h2"],
  ]) {
    const at = css[file].indexOf(`${selector} {`);
    assert.ok(at >= 0, `${file}: ${selector}`);
    const rule = css[file].slice(at, css[file].indexOf("}", at));
    assert.match(
      rule,
      /font:[^;]*var\(--font-display\)/,
      `${file}: ${selector}`,
    );
  }
});
