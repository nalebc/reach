import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { archiveBase, extractArchive } from "../server/archives.mjs";

const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), "reach-archives-"));
// tar writes zips too (bsdtar), so the test needs nothing else installed.
const zip = (cwd, out, ...items) =>
  execFileSync("tar", ["-a", "-cf", out, ...items], { cwd });

test("archives are named after themselves, without the extension", () => {
  assert.equal(archiveBase("Photos.zip"), "Photos");
  assert.equal(archiveBase("site.tar.gz"), "site");
  assert.equal(archiveBase("backup.TGZ"), "backup");
  assert.equal(archiveBase("notes.txt"), null);
  assert.equal(archiveBase(".zip"), null);
});

test("loose files land in a folder named after the archive", async () => {
  const dir = await scratch();
  await fs.writeFile(path.join(dir, "a.txt"), "a");
  await fs.writeFile(path.join(dir, "b.txt"), "b");
  zip(dir, "Bundle.zip", "a.txt", "b.txt");
  await fs.rm(path.join(dir, "a.txt"));
  await fs.rm(path.join(dir, "b.txt"));
  assert.equal(await extractArchive(path.join(dir, "Bundle.zip")), "Bundle");
  assert.equal(
    await fs.readFile(path.join(dir, "Bundle", "b.txt"), "utf8"),
    "b",
  );
  // Again: a second copy, never over the first.
  assert.equal(await extractArchive(path.join(dir, "Bundle.zip")), "Bundle 2");
  const left = (await fs.readdir(dir)).filter((n) =>
    n.startsWith(".reach-unzip"),
  );
  assert.deepEqual(left, []);
});

test("one folder inside comes out as itself", async () => {
  const dir = await scratch();
  await fs.mkdir(path.join(dir, "Project"));
  await fs.writeFile(path.join(dir, "Project", "README.md"), "# hi");
  zip(dir, "Project-main.zip", "Project");
  await fs.rm(path.join(dir, "Project"), { recursive: true });
  assert.equal(
    await extractArchive(path.join(dir, "Project-main.zip")),
    "Project",
  );
  assert.equal(
    await fs.readFile(path.join(dir, "Project", "README.md"), "utf8"),
    "# hi",
  );
});

test("a broken archive fails cleanly", async () => {
  const dir = await scratch();
  await fs.writeFile(path.join(dir, "bad.zip"), "not a zip");
  await assert.rejects(extractArchive(path.join(dir, "bad.zip")), {
    status: 422,
  });
  assert.deepEqual(await fs.readdir(dir), ["bad.zip"]);
});
