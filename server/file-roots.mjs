import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Start in Home, with the rest of the computer one tap away. OS permissions
// still decide what can be read; Reach never elevates its process privileges.
export function defaultFileRoots({
  platform = process.platform,
  home = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const volumes =
    platform === "win32"
      ? Array.from(
          { length: 26 },
          (_, i) => `${String.fromCharCode(65 + i)}:\\`,
        ).filter(exists)
      : ["/"];
  return [...new Set([home, paths.parse(home).root, ...volumes])];
}

export function fileRootName(folder) {
  if (folder === path.parse(folder).root)
    return process.platform === "win32" ? `Drive ${folder}` : "Computer";
  if (folder === fs.realpathSync(os.homedir())) return "Home";
  return path.basename(folder) || folder;
}
