import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";

const source = await fs.readFile(
  new URL("../src/terminal-keys.ts", import.meta.url),
  "utf8",
);
const outputText = transpile(source);
const { arrowKey, controlKey } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("arrows follow the terminal's cursor mode", () => {
  assert.equal(arrowKey("up", false), "\x1b[A");
  assert.equal(arrowKey("left", false), "\x1b[D");
  // Codex, vim and less switch to application mode.
  assert.equal(arrowKey("up", true), "\x1bOA");
  assert.equal(arrowKey("right", true), "\x1bOC");
});

test("sticky Ctrl turns the next character into its control code", () => {
  assert.equal(controlKey("c"), "\x03");
  assert.equal(controlKey("C"), "\x03");
  assert.equal(controlKey("d"), "\x04");
  assert.equal(controlKey("z"), "\x1a");
  assert.equal(controlKey("["), "\x1b");
  assert.equal(controlKey(" "), "\x00");
  assert.equal(controlKey("1"), null);
  assert.equal(controlKey("ab"), null);
});
