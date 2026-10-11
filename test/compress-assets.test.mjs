import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressAssets } from "../scripts/compress-assets.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-compress-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "assets"));
  const file = path.join(dir, "assets", "r2-main.js");
  await fs.writeFile(file, "original interface".repeat(100));
  await fs.utimes(file, 1, 1);
  return { dir, file };
}

async function verify(file) {
  const raw = await fs.readFile(file);
  assert.deepEqual(brotliDecompressSync(await fs.readFile(`${file}.br`)), raw);
  assert.deepEqual(gunzipSync(await fs.readFile(`${file}.gz`)), raw);
}

test("retained interface assets reuse both compressed copies without rewriting them", async (t) => {
  const { dir, file } = await fixture(t);
  assert.equal((await compressAssets(dir)).compressed, 1);
  await verify(file);
  for (const ext of ["br", "gz"]) await fs.utimes(`${file}.${ext}`, 10, 10);
  const result = await compressAssets(dir);
  assert.equal(result.compressed, 0);
  assert.equal(result.reused, 1);
  for (const ext of ["br", "gz"])
    assert.equal((await fs.stat(`${file}.${ext}`)).mtimeMs, 10000);
});

test("changed sources and missing or empty copies are compressed again", async (t) => {
  const { dir, file } = await fixture(t);
  await compressAssets(dir);
  for (const ext of ["br", "gz"]) await fs.utimes(`${file}.${ext}`, 10, 10);
  await fs.writeFile(file, "updated interface".repeat(100));
  assert.equal((await compressAssets(dir)).compressed, 1);
  await verify(file);
  for (const ext of ["br", "gz"]) {
    await fs.rm(`${file}.${ext}`);
    assert.equal((await compressAssets(dir)).compressed, 1);
    await verify(file);
    await fs.writeFile(`${file}.${ext}`, "");
    assert.equal((await compressAssets(dir)).compressed, 1);
    await verify(file);
  }
  assert.deepEqual((await fs.readdir(path.join(dir, "assets"))).sort(), [
    "r2-main.js",
    "r2-main.js.br",
    "r2-main.js.gz",
  ]);
});
