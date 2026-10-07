import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { archiveBase, extractArchive } from "../server/archives.mjs";
import { zipFixture, tarFixture } from "./helpers/archive-fixtures.mjs";

async function fixture(t, name, bytes) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "reach-archives-")));
  const privateDir = path.join(dir, "private"), shared = path.join(dir, "shared");
  await fsp.mkdir(privateDir); await fsp.mkdir(shared);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(shared, name); await fsp.writeFile(file, bytes);
  const run = options => extractArchive(file, { stagingRoot: privateDir, ...options });
  const clean = async () => { assert.deepEqual(await fsp.readdir(privateDir), []); assert.deepEqual(await fsp.readdir(shared), [name]); };
  return { dir, shared, privateDir, file, run, clean };
}

test("archives are named after themselves, without the extension", () => {
  for (const [name, expected] of [["Photos.zip", "Photos"], ["site.tar.gz", "site"], ["backup.TGZ", "backup"], ["notes.txt", null], [".zip", null]]) assert.equal(archiveBase(name), expected);
});

test("genuine ZIP loose files extract without replacing previous copies", async t => {
  const f = await fixture(t, "Bundle.zip", zipFixture([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b", deflate: true }]));
  assert.equal(await f.run(), "Bundle");
  assert.equal(await fsp.readFile(path.join(f.shared, "Bundle", "b.txt"), "utf8"), "b");
  assert.equal(await f.run(), "Bundle 2");
  assert.deepEqual(await fsp.readdir(f.privateDir), []);
});

test("one contained folder is kept with ordinary dotfiles and no archive permission bits", async t => {
  const f = await fixture(t, "Project-main.zip", zipFixture([{ name: "Project/README.md", data: "# hi", mode: 0o104777 }, { name: "Project/.gitignore", data: "build" }, { name: "__MACOSX/._file", data: "metadata" }]));
  assert.equal(await f.run(), "Project");
  assert.equal(await fsp.readFile(path.join(f.shared, "Project", ".gitignore"), "utf8"), "build");
  if (process.platform !== "win32") assert.equal((await fsp.stat(path.join(f.shared, "Project", "README.md"))).mode & 0o7777, 0o600);
});

test("TAR, gzip TAR and long PAX names use the portable bounded parser", async t => {
  for (const [name, gzip] of [["Bundle.tar", false], ["Bundle.tar.gz", true], ["Bundle.tgz", true]]) {
    const long = "long".repeat(30) + ".txt";
    const f = await fixture(t, name, await tarFixture([{ name: "./folder/" + long, data: "portable" }], gzip));
    assert.equal(await f.run(), "folder");
    assert.equal(await fsp.readFile(path.join(f.shared, "folder", long), "utf8"), "portable");
  }
});

test("malformed archives and unsupported bzip2/xz leave no output", async t => {
  for (const name of ["bad.zip", "bad.tar", "bad.tar.gz", "bad.tar.bz2", "bad.tar.xz"]) {
    const f = await fixture(t, name, Buffer.from("not an archive"));
    await assert.rejects(f.run(), { status: /bz2|xz/.test(name) ? 415 : 422 }); await f.clean();
  }
});

test("ZIP and TAR reject traversal, absolute paths, Windows aliases and misleading names", async t => {
  for (const name of ["../escape", "/absolute", "C:/drive", "back\\slash", "file:stream", "CON.txt", "trailing.", "trailing ", "a/../b", "a//b", "bad\u202ename"]) {
    for (const format of ["zip", "tar"]) {
      const bytes = format === "zip" ? zipFixture([{ name, data: "attack" }]) : await tarFixture([{ name, data: "attack" }]);
      const f = await fixture(t, `bad.${format}`, bytes);
      await assert.rejects(f.run(), { status: 422 }); await f.clean();
    }
  }
});

test("ZIP symlinks/encryption and TAR links/devices/FIFOs are refused", async t => {
  for (const entry of [{ name: "alias", mode: 0o120777, data: "../outside" }, { name: "encrypted", encrypted: true, data: "hidden" }]) {
    const f = await fixture(t, "bad.zip", zipFixture([entry])); await assert.rejects(f.run(), { status: 422 }); await f.clean();
  }
  for (const type of ["symlink", "link", "fifo", "block-device", "character-device"]) {
    const f = await fixture(t, "bad.tar", await tarFixture([{ name: "alias", type, header: { linkname: type.endsWith("link") ? "../outside" : "" } }]));
    await assert.rejects(f.run(), { status: 422 }); await f.clean();
  }
});

test("duplicate files, case/Unicode aliases, and file-directory conflicts are refused", async t => {
  for (const names of [["same", "same"], ["File", "file"], ["é", "e\u0301"], ["parent", "parent/child"], ["Parent/a", "parent/b"]]) {
    const f = await fixture(t, "bad.zip", zipFixture(names.map(name => ({ name, data: "x" }))));
    await assert.rejects(f.run(), { status: 422 }); await f.clean();
  }
});

test("compressed and expanded byte counts, entry counts, and false ZIP sizes fail closed", async t => {
  for (const [entries, limits] of [
    [[{ name: "a", data: "x" }], { inputBytes: 5 }],
    [[{ name: "a", data: "x".repeat(10000), deflate: true }], { fileBytes: 100 }],
    [[{ name: "a", data: "1234" }, { name: "b", data: "1234" }], { outputBytes: 7 }],
    [[{ name: "a" }, { name: "b" }], { entries: 1 }],
  ]) {
    const f = await fixture(t, "bad.zip", zipFixture(entries)); await assert.rejects(f.run({ limits }), { status: 413 }); await f.clean();
  }
  const f = await fixture(t, "bad.zip", zipFixture([{ name: "bomb", data: "x".repeat(1000), deflate: true, size: 1 }]));
  await assert.rejects(f.run(), { status: 422 }); await f.clean();
  const g = await fixture(t, "bad.tar.gz", await tarFixture([{ name: "bomb", data: "x".repeat(1000) }], true));
  await assert.rejects(g.run({ limits: { fileBytes: 100 } }), { status: 413 }); await g.clean();
});

test("parallel extractions reserve distinct destinations without replacing an existing empty folder", async t => {
  const f = await fixture(t, "Bundle.zip", zipFixture([{ name: "a", data: "ok" }]));
  await fsp.mkdir(path.join(f.shared, "Bundle")); const original = await fsp.stat(path.join(f.shared, "Bundle"));
  const names = await Promise.all([f.run(), f.run()]);
  assert.deepEqual(new Set(names), new Set(["Bundle 2", "Bundle 3"]));
  assert.equal((await fsp.stat(path.join(f.shared, "Bundle"))).ino, original.ino);
  assert.deepEqual(await fsp.readdir(path.join(f.shared, "Bundle")), []);
});

test("revocation before publication and during destination copy removes only the new output", async t => {
  for (const atDestination of [false, true]) {
    const f = await fixture(t, "Bundle.zip", zipFixture([{ name: "a", data: "safe" }])); let calls = 0;
    await assert.rejects(f.run({ authorize() {
      calls++;
      if (atDestination ? fs.existsSync(path.join(f.shared, "Bundle")) : calls === 3) throw Object.assign(Error("revoked"), { status: 401 });
    } }), { status: 401 });
    await f.clean();
  }
});

test("source mutation after opening and pre-aborted extraction are refused", async t => {
  const f = await fixture(t, "Bundle.zip", zipFixture([{ name: "a", data: "safe" }])); let calls = 0;
  await assert.rejects(f.run({ authorize() { if (++calls === 2) fs.appendFileSync(f.file, "changed"); } }), { status: 409 });
  await f.clean();
  const controller = new AbortController(); controller.abort(Object.assign(Error("cancelled"), { status: 409 }));
  await assert.rejects(f.run({ signal: controller.signal }), { status: 409 }); await f.clean();
});
