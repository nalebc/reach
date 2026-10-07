import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildTailnet, tailnetDigest } from "../scripts/build-tailnet.mjs";
import { assertReleaseAssets } from "../scripts/release-assets.mjs";

test("release builds require Go; development can explicitly tolerate its absence", async () => {
  const go = path.join(os.tmpdir(), "reach-no-such-go-executable");
  assert.equal(await buildTailnet({ go }), null);
  await assert.rejects(buildTailnet({ go, required: true }), /Go is required/);
});

test("packaging rejects missing, stale and corrupted browser connectivity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-release-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => assertReleaseAssets(root), /incomplete/);
  for (const file of ["dist/index.html", "dist/start.html", "dist/agent.mjs", "bin/reach.mjs", "server/index.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "fixture");
  }
  assert.throws(() => assertReleaseAssets(root), /missing or stale/);
  const dir = path.join(root, "tailnet/dist");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { source: tailnetDigest() };
  for (const [key, ext] of [["wasm", "wasm"], ["exec", "js"]]) {
    const data = Buffer.from(key);
    const hash = crypto.createHash("sha256").update(data).digest("hex").slice(0, 12);
    const name = `${key}.${hash}.${ext}`;
    manifest[key] = name;
    for (const suffix of ["", ".br", ".gz"]) fs.writeFileSync(path.join(dir, name + suffix), data);
  }
  const save = () => fs.writeFileSync(path.join(dir, "tailnet.json"), JSON.stringify(manifest));
  save();
  assert.doesNotThrow(() => assertReleaseAssets(root));
  manifest.source = "outdated"; save();
  assert.throws(() => assertReleaseAssets(root), /missing or stale/);
  manifest.source = tailnetDigest(); save();
  fs.writeFileSync(path.join(dir, manifest.wasm), "damaged");
  assert.throws(() => assertReleaseAssets(root), /integrity/);
  fs.writeFileSync(path.join(dir, manifest.wasm), "wasm");
  fs.rmSync(path.join(dir, manifest.exec + ".br"));
  assert.throws(() => assertReleaseAssets(root), /Compressed/);
});
