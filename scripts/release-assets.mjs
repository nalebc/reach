import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { tailnetCurrent } from "./build-tailnet.mjs";

export function assertReleaseAssets(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  for (const file of ["dist/index.html", "dist/start.html", "dist/agent.mjs", "bin/reach.mjs", "server/index.mjs"])
    if (!fs.existsSync(path.join(root, file))) throw Error(`Release is incomplete: ${file}. Run npm run build:release first.`);
  const dir = path.join(root, "tailnet/dist");
  if (!tailnetCurrent(dir)) throw Error("Browser connectivity is missing or stale. Run npm run build:release first.");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "tailnet.json"), "utf8"));
  for (const key of ["wasm", "exec"]) {
    const name = manifest[key];
    if (typeof name !== "string" || path.basename(name) !== name) throw Error("Invalid browser client manifest.");
    const data = fs.readFileSync(path.join(dir, name));
    const hash = crypto.createHash("sha256").update(data).digest("hex").slice(0, 12);
    if (!name.includes(`.${hash}.`)) throw Error(`Browser client integrity check failed: ${key}.`);
    for (const suffix of [".br", ".gz"])
      if (!fs.existsSync(path.join(dir, name + suffix))) throw Error(`Compressed browser client is missing: ${key}${suffix}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertReleaseAssets();
  console.log("Release assets are complete and current.");
}
