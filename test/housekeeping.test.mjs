import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { housekeeping, pruneHelpers, trimLog } from "../scripts/housekeeping.mjs";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-house-"));

test("only the newest build of each helper stays; other files are untouched", () => {
  const quick = dir();
  const write = (name, ageS) => {
    fs.writeFileSync(path.join(quick, name), "x");
    const t = Date.now() / 1000 - ageS;
    fs.utimesSync(path.join(quick, name), t, t);
  };
  write("reach-claude-compose-aaaaaaaaaaaa", 300);
  write("reach-claude-compose-bbbbbbbbbbbb", 10);
  write("reach-claude-compose-cccccccccccc", 200);
  write("reach-mac-prompts-dddddddddddd", 900);
  write("reach-input-v2", 900);
  write("clients.json", 900);
  write("reach-screen-stream-eeeeeeeeeeee-123.tmp", 3600);
  write("reach-screen-stream-ffffffffffff-456.tmp", 5);
  assert.deepEqual(pruneHelpers(quick).sort(), ["reach-claude-compose-aaaaaaaaaaaa", "reach-claude-compose-cccccccccccc"]);
  assert.deepEqual(fs.readdirSync(quick).sort(), [
    "clients.json",
    "reach-claude-compose-bbbbbbbbbbbb",
    "reach-input-v2",
    "reach-mac-prompts-dddddddddddd",
    "reach-screen-stream-ffffffffffff-456.tmp",
  ], "an unfinished old build's temp file goes; a build in progress stays");
});

test("a log past 1 MB keeps its latest 256 KB, from a whole line; a small one is left alone", () => {
  const folder = dir();
  const big = path.join(folder, "setup.log");
  const lines = Array.from({ length: 30000 }, (_, n) => `line ${n} ${"x".repeat(40)}`).join("\n") + "\n";
  fs.writeFileSync(big, lines);
  assert.equal(trimLog(big), true);
  const text = fs.readFileSync(big, "utf8");
  assert.ok(text.length <= 256 * 1024 + 40);
  assert.match(text, /^… \(earlier lines removed\)\nline \d+ x+\n/);
  assert.ok(text.endsWith(`line 29999 ${"x".repeat(40)}\n`));
  const small = path.join(folder, "small.log");
  fs.writeFileSync(small, "hello\n");
  assert.equal(trimLog(small), false);
  assert.equal(fs.readFileSync(small, "utf8"), "hello\n");
});

test("housekeeping never throws on a fresh computer with nothing there yet", () => {
  assert.deepEqual(housekeeping(path.join(dir(), "missing"), { logDirs: ["/nonexistent"] }), []);
});
