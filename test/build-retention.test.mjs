import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import config from "../vite.config.mjs";

test("full builds preserve old lazy chunks for phones still using the previous interface", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reach-build-retention-")));
  try {
    await fs.writeFile(path.join(root, "index.html"), '<script type="module" src="/entry.js"></script>');
    await fs.writeFile(path.join(root, "entry.js"), 'window.openViewer = () => import("./viewer.js");');
    await fs.writeFile(path.join(root, "viewer.js"), 'export default "old viewer";');
    const options = {
      configFile: false, root, logLevel: "silent",
      build: { ...config.build, rollupOptions: { input: path.join(root, "index.html") } },
    };
    await build(options);
    const assets = path.join(root, "dist/assets");
    const oldViewer = (await fs.readdir(assets)).find(name => name.startsWith("viewer-"));
    assert.ok(oldViewer);
    const oldContent = await fs.readFile(path.join(assets, oldViewer), "utf8");
    await fs.writeFile(path.join(root, "viewer.js"), 'export default "new viewer";');
    await build(options);
    assert.equal(await fs.readFile(path.join(assets, oldViewer), "utf8"), oldContent);
    assert.equal((await fs.readdir(assets)).filter(name => name.startsWith("viewer-")).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
