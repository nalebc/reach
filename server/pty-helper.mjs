import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// node-pty publishes its macOS helper without the executable bit (checked in
// the node-pty 1.1.0 tarball), and terminals can't start without it. Reach
// sets it when it starts, rather than in an install script. Returns a message
// when it can't (an installation owned by another user).
export function ensurePtyHelper({
  platform = process.platform,
  arch = process.arch,
  resolve = createRequire(import.meta.url).resolve,
} = {}) {
  if (platform !== "darwin") return null;
  let helper;
  try {
    const root = path.dirname(resolve("node-pty/package.json"));
    // Where node-pty keeps it: its prebuilt helper, or one built here (a
    // version laying it out otherwise has terminals say so, not fail silently).
    const places = [path.join(root, "prebuilds", `darwin-${arch}`, "spawn-helper"), path.join(root, "build", "Release", "spawn-helper")];
    helper = places.find((p) => fs.existsSync(p));
    if (!helper) return `Terminals can't start: node-pty's spawn-helper isn't in ${places.join(" or ")}. Reinstall Reach's dependencies (npm install).`;
    const { mode } = fs.statSync(helper);
    if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o755);
    return null;
  } catch (e) {
    if (!helper || e.code === "ENOENT") return null;
    // Installed by another user (e.g. `sudo npm install -g`): needs sudo too.
    let sudo = "";
    try {
      if (fs.statSync(helper).uid !== process.getuid?.()) sudo = "sudo ";
    } catch {}
    return `Terminals need Reach's terminal helper to be executable. Run: ${sudo}chmod +x "${helper}"`;
  }
}
