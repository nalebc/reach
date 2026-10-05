import fs from "node:fs";
import path from "node:path";
const dest = "release/reach";
if (!fs.existsSync("tailnet/dist/tailnet.json"))
  throw Error("Build the browser connection first: node scripts/build-tailnet.mjs --required");
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const item of [
  "LICENSE",
  "bin",
  "tailnet/main.go",
  "tailnet/go.mod",
  "tailnet/go.sum",
  "tailnet/dist",
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
  "start.html",
  "tsconfig.json",
  "vite.config.mjs",
])
  if (fs.existsSync(item)) {
    const target = path.join(dest, item);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(item, target, { recursive: true });
  }
console.log(
  "Release staged in release/reach. Copy it to another computer and run ./reach (Mac/Linux) or .\\reach.cmd (Windows).",
);
