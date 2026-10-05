import fs from "node:fs";
import path from "node:path";
const dest = "release/reach";
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const item of [
  "server",
  "dist",
  "scripts",
  "package.json",
  "package-lock.json",
  "README.md",
  "docs",
  "reach",
  "reach.cmd",
  "reach-agent",
  "reach-agent.cmd",
  "src",
  "public",
  "index.html",
  "tsconfig.json",
  "vite.config.mjs",
])
  if (fs.existsSync(item))
    fs.cpSync(item, path.join(dest, item), { recursive: true });
console.log(
  "Release staged in release/reach. Copy it to another computer and run ./reach (Mac/Linux) or .\\reach.cmd (Windows).",
);
