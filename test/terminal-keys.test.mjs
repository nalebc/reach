import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";

const source = await fs.readFile(
  new URL("../src/terminal-keys.ts", import.meta.url),
  "utf8",
);
const outputText = transpile(source);
const { arrowKey, controlKey, pastable, pasteQuestion, inputPieces } = await import(
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

test("pasted text keeps tabs and line breaks, never control codes that act as keys", () => {
  assert.equal(pastable("a\tb\r\nc\n"), "a\tb\r\nc\n");
  // An end-of-paste marker inside the clipboard can't close a bracketed
  // paste early and run what follows.
  assert.equal(pastable("echo hi\x1b[201~rm -rf ~\n"), "echo hi[201~rm -rf ~\n");
  assert.equal(pastable("x\x03\x04\x7f\x9by"), "xy");
  assert.equal(pastable("déjà vu ✓ 😀"), "déjà vu ✓ 😀");
});

test("a paste with line breaks asks before running them", () => {
  assert.equal(pasteQuestion("git status"), null);
  assert.equal(pasteQuestion("git status\n"), "Pasting this runs a command. Paste it?");
  assert.equal(
    pasteQuestion("cd app\r\nnpm test\nnpm run build"),
    "Pasting this runs 2 commands, one per line. Paste it?",
  );
});

test("long input goes in pieces under the server's limit, never splitting a character", () => {
  assert.deepEqual(inputPieces(""), []);
  assert.deepEqual(inputPieces("short"), ["short"]);
  const long = "x".repeat(20000);
  const pieces = inputPieces(long);
  assert.deepEqual(pieces.map((p) => p.length), [8192, 8192, 3616]);
  assert.equal(pieces.join(""), long);
  // 😀 is two UTF-16 units: one straddling a boundary moves whole to the next piece.
  const emoji = `${"x".repeat(8191)}😀tail`;
  const split = inputPieces(emoji);
  assert.deepEqual(split.map((p) => p.length), [8191, 6]);
  assert.equal(split[1], "😀tail");
  assert.equal(split.join(""), emoji);
  // Every piece fits the 64 KB frame even when each character escapes to six bytes.
  const worst = "\x01".repeat(30000);
  for (const piece of inputPieces(worst))
    assert.ok(Buffer.byteLength(JSON.stringify({ type: "input", data: piece })) < 65536);
});
