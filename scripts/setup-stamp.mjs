import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// What a checkout's install and builds were made from (bootstrap.mjs
// prepare): its npm packages, the phone interface's sources, and every file
// Reach for agents was built from (as esbuild listed them beside it). Each
// file is named as it is under `root`, so the same tree gives the same stamp.
export function digest(files, root = process.cwd()) {
  const h = crypto.createHash("sha256");
  function visit(file) {
    const at = path.resolve(root, file);
    // One stat: a missing file counts as absent, not as an error.
    const stat = fs.statSync(at, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(at).sort())
        visit(path.join(file, name));
    } else {
      h.update(file);
      h.update(fs.readFileSync(at));
    }
  }
  files.forEach(visit);
  return h.digest("hex");
}
export const dependenciesStamp = (root = process.cwd()) =>
  `${digest(["package.json", "package-lock.json"], root)}:${process.versions.modules}:${process.platform}:${process.arch}`;
export const sourceStamp = (root = process.cwd()) =>
  digest([
    "src",
    "public",
    "index.html",
    "start.html",
    "vite.config.mjs",
    "tsconfig.json",
  ], root);
export function agentStamp(root = process.cwd()) {
  let files;
  try { files = JSON.parse(fs.readFileSync(path.resolve(root, "dist/.agent-inputs.json"), "utf8")); } catch { return ""; }
  return Array.isArray(files) && files.length && files.every((file) => typeof file === "string") ? digest(files, root) : "";
}
// The stamp bootstrap keeps in setup.json once a checkout is installed and built.
export const setupStamp = (root = process.cwd()) => ({
  dependencies: dependenciesStamp(root),
  source: sourceStamp(root),
  agent: agentStamp(root),
});
