import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openConfined, readUpTo } from "../server/confined-file.mjs";

// A file Reach checked by path, then used: opened once and proven to be the
// one checked (CodeQL js/file-system-race on Files' editor and Full
// control's writes; owner, Oct 12: fixed before 0.1.0, not dismissed).
const scratch = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-confined-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("the file checked is the file read, up to its limit", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "hello");
  const { handle, size } = await openConfined(file, fs.constants.O_RDONLY, () => file);
  try {
    assert.equal(size, 5);
    assert.equal((await readUpTo(handle, 5)).toString(), "hello");
    assert.equal(await readUpTo(handle, 4), null, "more than the limit reads as too large");
  } finally {
    await handle.close();
  }
});

test("a link put in the file's place is never followed", { skip: process.platform === "win32" }, async (t) => {
  const dir = scratch(t);
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "secret");
  const file = path.join(dir, "notes.txt");
  fs.symlinkSync(outside, file);
  await assert.rejects(openConfined(file, fs.constants.O_RDWR, () => file), (e) => e.status === 403 && /Links are not opened/.test(e.message));
  assert.equal(fs.readFileSync(outside, "utf8"), "secret");
});

test("a pipe in the file's place doesn't hold Reach; a folder is not a file", { skip: process.platform === "win32" }, async (t) => {
  const dir = scratch(t);
  const pipe = path.join(dir, "notes.txt");
  execFileSync("mkfifo", [pipe]);
  await assert.rejects(openConfined(pipe, fs.constants.O_RDONLY, () => pipe), (e) => e.status === 400);
  await assert.rejects(openConfined(dir, fs.constants.O_RDONLY, () => dir), (e) => e.status === 400);
});

test("a file swapped after it was opened, or a path that now leads elsewhere, is refused before any use", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "first");
  // Replaced by another file between the open and the check.
  await assert.rejects(
    openConfined(file, fs.constants.O_RDWR, () => {
      fs.writeFileSync(path.join(dir, "other.txt"), "other");
      fs.renameSync(path.join(dir, "other.txt"), file);
      return file;
    }),
    (e) => e.status === 409,
  );
  // The checks, run again, put it somewhere else (or refuse it).
  await assert.rejects(openConfined(file, fs.constants.O_RDONLY, () => path.join(dir, "moved.txt")), (e) => e.status === 409);
  await assert.rejects(
    openConfined(file, fs.constants.O_RDONLY, () => {
      throw Object.assign(new Error("Stay inside the shared folder."), { status: 403 });
    }),
    (e) => e.status === 403,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "other", "nothing was written");
});
