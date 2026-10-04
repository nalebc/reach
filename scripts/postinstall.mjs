// node-pty 1.1.0's macOS prebuilt helper can arrive without its executable bit.
import fs from "node:fs";
import path from "node:path";
if (process.platform === "darwin") {
  const directory = path.join(
    "node_modules",
    "node-pty",
    "prebuilds",
    `darwin-${process.arch}`,
  );
  const helper = path.join(directory, "spawn-helper");
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
