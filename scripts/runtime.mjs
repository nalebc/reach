import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Background mode runs on Reach's own pinned Node.js, never the system's
// (upgrades and version managers move it). The ./reach script downloads it
// for a source checkout; an installed `reach` downloads the same build here.
// Keep in step with the `reach` script (a test checks they match).
export const NODE_VERSION = "22.23.3";
export const NODE_BUILDS = {
  "darwin-arm64":
    "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
  "darwin-x64":
    "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8",
  "linux-arm64":
    "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
  "linux-x64":
    "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
};

export async function ensureRuntime(
  state,
  {
    platform = process.platform,
    arch = process.arch,
    download = globalThis.fetch,
    log = console.log,
  } = {},
) {
  const target = `${platform}-${arch}`;
  const expected = NODE_BUILDS[target];
  if (!expected)
    throw Error("Background mode supports Mac and Linux (arm64 or x64).");
  const dir = path.join(state, "runtime");
  const runtime = path.join(dir, `node-v${NODE_VERSION}-${target}`);
  if (fs.existsSync(path.join(runtime, "bin", "node"))) return runtime;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(dir, "download."));
  try {
    log("Reach: preparing a private Node.js runtime (first time only)…");
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${target}.tar.gz`;
    const response = await download(url, { redirect: "error" });
    if (!response.ok)
      throw Error(`Couldn't download Node.js (${response.status}).`);
    const data = Buffer.from(await response.arrayBuffer());
    // Nothing is unpacked unless it is exactly the build Reach pins.
    const actual = crypto.createHash("sha256").update(data).digest("hex");
    if (actual !== expected)
      throw Error("Node.js checksum mismatch; stopping.");
    const archive = path.join(stage, "node.tar.gz");
    fs.writeFileSync(archive, data, { mode: 0o600 });
    execFileSync("tar", ["-xzf", archive, "-C", stage], { stdio: "ignore" });
    fs.renameSync(path.join(stage, `node-v${NODE_VERSION}-${target}`), runtime);
    return runtime;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
