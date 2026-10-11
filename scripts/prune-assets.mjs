import nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The interface's earlier builds are kept so a phone still running the
// previous one finds its lazy chunks (vite.config.mjs, emptyOutDir: false),
// but nothing ever removed them: a checkout's dist/ grew to 9,854 files and
// 430 MB (Oct 10), and a package packed from it would have shipped every one.
// After each build, files of earlier builds go once they're a day old (open
// phones reload onto a new build within a minute, src/build-reload.ts, and
// one back after days reloads first; three days still kept 10,584 files on a
// checkout several agents edited all day).
// A release build keeps only its own (keepMs 0).
//
// Only Vite's own output (named r2-…) is touched, and only with this build's
// manifest to say what's current: never blind.
const DAY = 24 * 60 * 60 * 1000;
export function pruneAssets(dist, { keepMs = DAY, now = Date.now(), fs = nodeFs } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dist, ".vite", "manifest.json"), "utf8"));
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const current = new Set();
  for (const entry of Object.values(manifest || {}))
    for (const file of [entry?.file, ...(entry?.css || []), ...(entry?.assets || [])])
      if (typeof file === "string") current.add(path.basename(file));
  if (!current.size) return { removed: 0, bytes: 0 };
  const dir = path.join(dist, "assets");
  let removed = 0,
    bytes = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed, bytes };
  }
  // Each file with its compressed copies, decided together.
  const groups = new Map();
  for (const name of names) {
    const base = name.replace(/\.(?:br|gz)$/, "");
    if (!/^r2-/.test(base) || current.has(base)) continue;
    groups.set(base, [...(groups.get(base) || []), name]);
  }
  for (const [base, files] of groups) {
    // When it was built: the file itself (its .br and .gz are rewritten by
    // every full build), or the copy left when it's gone.
    let built = Infinity;
    for (const name of files.includes(base) ? [base] : files)
      try {
        built = Math.min(built, fs.statSync(path.join(dir, name)).mtimeMs);
      } catch {
        /* gone meanwhile */
      }
    if (!Number.isFinite(built) || now - built < keepMs) continue;
    for (const name of files)
      try {
        bytes += fs.statSync(path.join(dir, name)).size;
        fs.rmSync(path.join(dir, name), { force: true });
        removed++;
      } catch {
        /* gone already */
      }
  }
  return { removed, bytes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const release = process.argv.includes("--release");
  const dist = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) || "dist");
  const { removed, bytes } = pruneAssets(dist, release ? { keepMs: 0 } : {});
  if (removed) console.log(`Removed ${removed} files of earlier interface builds (${(bytes / 1048576).toFixed(1)} MB).`);
}
