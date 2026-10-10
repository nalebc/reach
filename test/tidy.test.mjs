import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneUploads, tidyData } from "../server/tidy.mjs";

// Reach's files stay small while it runs (reliability audit, Oct 10): logs
// capped, old command histories and old uploads cleared.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-tidy-"));
const aged = (file, days) => {
  const t = (NOW - days * DAY) / 1000;
  fs.utimesSync(file, t, t);
};
const IMG = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd.png`;
const FILE = (n) => `1111111${n}-aaaa-4bbb-8ccc-dddddddddddd`;

test("files sent over 30 days ago go only when the disk is low, unless something Reach keeps names them; pictures stay", () => {
  const data = dir();
  fs.mkdirSync(path.join(data, "agent-images"));
  fs.mkdirSync(path.join(data, "agent-files"));
  for (const [n, days] of [[1, 40], [2, 40], [3, 5]]) {
    fs.writeFileSync(path.join(data, "agent-images", IMG(n)), "png");
    aged(path.join(data, "agent-images", IMG(n)), days);
  }
  for (const [n, days] of [[1, 40], [2, 40], [3, 5]]) {
    fs.mkdirSync(path.join(data, "agent-files", FILE(n)));
    fs.writeFileSync(path.join(data, "agent-files", FILE(n), "notes.pdf"), "pdf");
    aged(path.join(data, "agent-files", FILE(n)), days);
  }
  // A message still waiting names image 2 and file 2; a chat's list of
  // pictures it already has doesn't keep anything.
  fs.writeFileSync(path.join(data, "agent-outbox.json"), JSON.stringify({ chat: [{ images: [path.join(data, "agent-images", IMG(2))], text: `see ${path.join(data, "agent-files", FILE(2), "notes.pdf")}` }] }));
  fs.writeFileSync(path.join(data, "image-repeats.json"), JSON.stringify({ "codex:x": [IMG(1)] }));
  fs.writeFileSync(path.join(data, "agent-images", "not-an-upload.txt"), "x");
  aged(path.join(data, "agent-images", "not-an-upload.txt"), 400);
  // Room on the disk: nothing goes.
  assert.deepEqual(pruneUploads(data, { now: () => NOW, free: () => 50 * 1024 ** 3 }), []);
  // Under 5 GB free: old files nobody names go; pictures never (chats' histories show them from here).
  const removed = pruneUploads(data, { now: () => NOW, free: () => 1024 ** 3 });
  assert.deepEqual(removed, [`agent-files/${FILE(1)}`]);
  assert.deepEqual(fs.readdirSync(path.join(data, "agent-images")).sort(), [IMG(1), IMG(2), IMG(3), "not-an-upload.txt"].sort());
  assert.deepEqual(fs.readdirSync(path.join(data, "agent-files")).sort(), [FILE(2), FILE(3)].sort());
});

test("logs over 1 MB keep their latest part; crash.log stays smaller; old command histories go", async () => {
  const data = dir();
  const state = dir();
  fs.mkdirSync(path.join(state, "logs"));
  const big = (file, size) => fs.writeFileSync(file, `${"old line\n".repeat(Math.ceil(size / 9))}newest line\n`);
  big(path.join(data, "tailscale.log"), 2 * 1024 * 1024);
  big(path.join(data, "claude-box-kept.jsonl"), 2 * 1024 * 1024);
  big(path.join(data, "crash.log"), 300 * 1024);
  big(path.join(state, "setup.log"), 2 * 1024 * 1024);
  big(path.join(state, "logs", "companion.log"), 2 * 1024 * 1024);
  fs.writeFileSync(path.join(data, "small.log"), "tiny\n");
  fs.mkdirSync(path.join(data, "browser-commands"), { mode: 0o700 });
  for (let n = 0; n < 8; n++) {
    const file = path.join(data, "browser-commands", `commands-2026-09-0${n + 1}T00-00-00-000Z.jsonl`);
    fs.writeFileSync(file, "{}\n");
    aged(file, n < 2 ? 40 : 1 + n);
  }
  const { trimmed, archives } = await tidyData({ dataDir: data, logFiles: [path.join(state, "setup.log")], logDirs: [path.join(state, "logs")], now: () => NOW });
  assert.equal(trimmed.length, 5);
  for (const file of [path.join(data, "tailscale.log"), path.join(data, "claude-box-kept.jsonl"), path.join(state, "setup.log"), path.join(state, "logs", "companion.log")]) {
    assert.ok(fs.statSync(file).size <= 300 * 1024, file);
    assert.ok(fs.readFileSync(file, "utf8").endsWith("newest line\n"), file);
  }
  assert.ok(fs.statSync(path.join(data, "crash.log")).size <= 70 * 1024);
  assert.equal(fs.readFileSync(path.join(data, "small.log"), "utf8"), "tiny\n");
  assert.equal(archives.length, 3, "only the newest 5 stay, none older than 30 days");
  assert.equal(fs.readdirSync(path.join(data, "browser-commands")).length, 5);
});
