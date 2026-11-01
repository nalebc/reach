import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { writePortableArchive } from "../scripts/portable-archive.mjs";

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "reach-archive-fixture-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const stage = path.join(root, "stage"), archive = path.join(root, "portable.tar.gz");
  await fsp.mkdir(stage);
  return { root, stage, archive };
}
async function entries(archive) {
  const result = [], extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    const chunks = [];
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("end", () => { result.push({ header, data: Buffer.concat(chunks) }); next(); });
    stream.on("error", error => extract.destroy(error));
  });
  await pipeline(fs.createReadStream(archive), createGunzip(), extract);
  return result;
}

test("portable archives keep bytes and executable modes with neutral ownership and metadata", async t => {
  const h = await fixture(t);
  await fsp.mkdir(path.join(h.stage, "folder"));
  const launcher = path.join(h.stage, "reach");
  await fsp.writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fsp.writeFile(path.join(h.stage, "folder", "data.bin"), Buffer.from([0, 1, 2, 255]));
  await writePortableArchive(h.stage, h.archive);
  const files = await entries(h.archive);
  assert.deepEqual(files.map(item => item.header.name), ["reach/", "reach/folder/", "reach/folder/data.bin", "reach/reach"]);
  for (const { header } of files) {
    assert.equal(header.uid, 0);
    assert.equal(header.gid, 0);
    assert.equal(header.uname, "");
    assert.equal(header.gname, "");
    assert.equal(header.mtime.getTime(), 0);
    assert.deepEqual(Object.keys(header.pax || {}), []);
  }
  assert.deepEqual(files[2].data, Buffer.from([0, 1, 2, 255]));
  assert.equal(files[3].header.mode, (await fsp.stat(launcher)).mode & 0o777);
  assert.equal(files[3].data.toString(), "#!/bin/sh\nexit 0\n");
  const first = await fsp.readFile(h.archive);
  await fsp.utimes(launcher, new Date(), new Date());
  await writePortableArchive(h.stage, h.archive);
  assert.deepEqual(await fsp.readFile(h.archive), first, "host timestamps and ownership cannot change the archive");
});

test("portable archives refuse links and remove an incomplete output", async t => {
  const h = await fixture(t);
  await fsp.mkdir(path.join(h.root, "outside"));
  await fsp.symlink(path.join(h.root, "outside"), path.join(h.stage, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(writePortableArchive(h.stage, h.archive), /regular files and directories/);
  await assert.rejects(fsp.stat(h.archive), { code: "ENOENT" });
  assert.ok(!(await fsp.readdir(h.root)).some(name => name.startsWith(".reach-archive-")));
});

test("an archive cannot be written into its own source tree", async t => {
  const h = await fixture(t);
  await assert.rejects(writePortableArchive(h.stage, path.join(h.stage, "nested.tar.gz")), /outside its source/);
});

test("a pathname replaced after opening cannot supply different archive bytes", async t => {
  const h = await fixture(t), file = path.join(h.stage, "input.txt");
  await fsp.writeFile(file, "original");
  const open = fsp.open.bind(fsp);
  t.mock.method(fsp, "open", async (name, ...options) => {
    const handle = await open(name, ...options);
    if (name === file) {
      await fsp.rename(file, path.join(h.root, "opened.txt"));
      await fsp.writeFile(file, "replacement");
    }
    return handle;
  });
  await assert.rejects(writePortableArchive(h.stage, h.archive), /changed during archiving/);
  await assert.rejects(fsp.stat(h.archive), { code: "ENOENT" });
});
