import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../vite.config.mjs";

// Reach's typefaces ship with its interface: every font the stylesheet names
// is a real WOFF2 file in the repository, with its license beside it and in
// the notices, and the build never turns one into a data: URL (CSP's
// font-src 'self' would refuse it and the page would quietly fall back).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const typeCss = fs.readFileSync(path.join(repo, "src/type.css"), "utf8");

test("every typeface in type.css is a bundled WOFF2 with its license", () => {
  const urls = [...typeCss.matchAll(/url\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(urls.map((u) => path.basename(u)).sort(), [
    "inter-latin-wght-normal.woff2",
    "manrope-latin-wght-normal.woff2",
  ]);
  const notices = fs.readFileSync(
    path.join(repo, "docs/THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  for (const url of urls) {
    const file = path.join(repo, "src", url);
    assert.equal(
      fs.readFileSync(file).subarray(0, 4).toString("latin1"),
      "wOF2",
      url,
    );
    const license = fs.readFileSync(
      path.join(path.dirname(file), "LICENSE"),
      "utf8",
    );
    assert.match(license, /SIL Open Font License, Version 1\.1/);
  }
  assert.match(notices, /^## Inter typeface$/m);
  assert.match(notices, /^## Manrope typeface$/m);
  assert.doesNotMatch(typeCss, /https?:\/\//, "no third-party font requests");
});

test("the build keeps fonts as files, never data: URLs", () => {
  const resolved =
    typeof config === "function"
      ? config({ command: "build", mode: "production" })
      : config;
  const limit = resolved.build.assetsInlineLimit;
  assert.equal(typeof limit, "function");
  const font = Buffer.from("wOF2");
  for (const name of ["a.woff2", "b.woff", "c.ttf", "D.OTF"])
    assert.equal(limit(name, font), false, name);
  assert.equal(limit("icon.svg", Buffer.from("<svg/>")), undefined);
});

test("every page entry loads the typefaces", () => {
  for (const entry of [
    "src/main.tsx",
    "src/funnel-agent-entry.tsx",
    "src/start.ts",
  ])
    assert.match(
      fs.readFileSync(path.join(repo, entry), "utf8"),
      /^import "\.\/type\.css";$/m,
      entry,
    );
});
