import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneAssets } from "../scripts/prune-assets.mjs";

// A checkout's dist/ kept every build's chunks forever (9,854 files, 430 MB
// on Oct 10), and a package packed from it shipped all of them. Earlier
// builds' files now go once a few days old; a release keeps only its own.
const DAY = 24 * 60 * 60 * 1000;
function dist(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-prune-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(path.join(root, ".vite"));
  const write = (name, ageDays) => {
    const file = path.join(assets, name);
    fs.writeFileSync(file, name);
    const when = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(file, when, when);
  };
  // This build: an entry, a lazy chunk, its stylesheet.
  fs.writeFileSync(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({
      "index.html": { file: "assets/r2-index-NEW.js", css: ["assets/r2-index-NEW.css"], dynamicImports: ["src/Screen.tsx"] },
      "src/Screen.tsx": { file: "assets/r2-Screen-NEW.js" },
    }),
  );
  for (const name of ["r2-index-NEW.js", "r2-index-NEW.js.br", "r2-index-NEW.css", "r2-Screen-NEW.js"]) write(name, 30);
  // Earlier builds: a week old, and from this morning.
  for (const name of ["r2-Screen-OLD.js", "r2-Screen-OLD.js.br", "r2-Screen-OLD.js.gz"]) write(name, 7);
  write("r2-Screen-RECENT.js", 0.2);
  // Not Vite's output (the brand images from public/): never touched.
  write("reach-mascot-abc-180.png", 90);
  return { root, assets, names: () => fs.readdirSync(assets).sort() };
}

test("after a build, earlier builds' files go once a day old, with their compressed copies", (t) => {
  const d = dist(t);
  const result = pruneAssets(d.root);
  assert.equal(result.removed, 3);
  assert.deepEqual(d.names(), [
    "r2-Screen-NEW.js",
    "r2-Screen-RECENT.js",
    "r2-index-NEW.css",
    "r2-index-NEW.js",
    "r2-index-NEW.js.br",
    "reach-mascot-abc-180.png",
  ]);
});

test("a release keeps only its own build", (t) => {
  const d = dist(t);
  pruneAssets(d.root, { keepMs: 0 });
  assert.deepEqual(d.names(), ["r2-Screen-NEW.js", "r2-index-NEW.css", "r2-index-NEW.js", "r2-index-NEW.js.br", "reach-mascot-abc-180.png"]);
});

test("without this build's manifest, nothing is removed", (t) => {
  const d = dist(t);
  fs.rmSync(path.join(d.root, ".vite"), { recursive: true });
  assert.deepEqual(pruneAssets(d.root, { keepMs: 0 }), { removed: 0, bytes: 0 });
  assert.equal(d.names().length, 9, "all nine stay");
  fs.mkdirSync(path.join(d.root, ".vite"));
  fs.writeFileSync(path.join(d.root, ".vite", "manifest.json"), "{}");
  assert.equal(pruneAssets(d.root, { keepMs: 0 }).removed, 0, "an empty manifest says nothing is current: never trusted");
});

test("the build writes the manifest the prune reads, and runs it", () => {
  const config = fs.readFileSync("vite.config.mjs", "utf8");
  assert.match(config, /manifest: true/);
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts.build, /vite build && .*node scripts\/prune-assets\.mjs/);
  assert.match(pkg.scripts["build:release"], /node scripts\/prune-assets\.mjs --release/);
  assert.match(fs.readFileSync("server/live-interface.mjs", "utf8"), /pruneAssets\(path\.join\(root, "dist"\)\)/);
});

// Stopping Reach while it rebuilds the interface (an edit saved a moment
// before Ctrl+C) stops the build too, quietly: shutdown waited on it.
test("a rebuild running when Reach stops is stopped with it, without a warning", async () => {
  const { watchInterface } = await import("../server/live-interface.mjs");
  const { EventEmitter } = await import("node:events");
  let changed;
  const watch = (dir, options, listener) => {
    changed = listener;
    return Object.assign(new EventEmitter(), { close() {}, unref() {} });
  };
  let aborted = false;
  const warnings = [];
  const stop = watchInterface({
    root: "/r",
    watch,
    delay: 1,
    log: { warn: (w) => warnings.push(w) },
    onBuilt() {},
    build: (root, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        }),
      ),
  });
  changed();
  await new Promise((r) => setTimeout(r, 30));
  stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(aborted, true);
  assert.deepEqual(warnings, []);
});
