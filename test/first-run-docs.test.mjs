import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const read = file => fs.readFileSync(file, "utf8");
const matrix = () => read("docs/FIRST_RUN_MATRIX.md");
const row = id => matrix().split("\n").find(line => line.startsWith(`| ${id} |`));

test("first-run matrix names the current socket limit, launch text and proving tests", () => {
  assert.match(row("T9"), /20/);
  assert.doesNotMatch(row("T9"), /over 14/);
  assert.match(row("T16"), /Open on your phone/);
  assert.doesNotMatch(row("T16"), /Reach is ready/);
  for (const id of ["A4", "A6"]) assert.match(row(id), /`agent-session-ui`/);
  assert.match(row("D2"), /`outside-terminal`/);
  assert.match(row("P3"), /`tailscale-auth`/);
});

test("install docs name macOS 13 for Tailscale 1.104 and the signed-out Linux command", () => {
  assert.match(read("README.md"), /macOS 13/);
  const guide = read("docs/GUIDE.md");
  assert.match(guide, /macOS 13/);
  assert.match(guide, /signed out[^\n]*sudo tailscale up --operator=\$USER/i);
  assert.doesNotMatch(guide, /wait for \*\*Reach is ready\*\*/);
});
