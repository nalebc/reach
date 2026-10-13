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
  if (folder === fs.realpathSync.native(os.homedir())) return "Home";
  return path.basename(folder) || folder;
}

// What the computer's own file browser hides, unless "hidden" is asked for.
// Finder: names starting with a dot. Explorer: items with the hidden or
// system attribute, which Node can't read, so known by name and place
// (parity audit #29): a few files anywhere, the profile's own items in
// Home, Windows' own at a drive's root.
const EVERYWHERE = /^(?:desktop\.ini|thumbs\.db)$/i;
const IN_HOME =
  /^(?:appdata|ntuser\..+|application data|cookies|local settings|my documents|nethood|printhood|recent|sendto|start menu|templates)$/i;
const AT_DRIVE_ROOT =
  /^(?:\$recycle\.bin|\$winreagent|\$windows\.~bt|\$windows\.~ws|\$sysreset|system volume information|recovery|config\.msi|msocache|programdata|documents and settings|pagefile\.sys|swapfile\.sys|hiberfil\.sys|dumpstack\.log(?:\.tmp)?|bootmgr|bootnxt|boot)$/i;
export function hiddenByOs(name, dir, { platform = process.platform, home = os.homedir() } = {}) {
  if (name.startsWith(".")) return true;
  if (platform !== "win32") return false;
  if (EVERYWHERE.test(name)) return true;
  const here = path.win32.resolve(dir).toLowerCase();
  if (here === path.win32.resolve(home).toLowerCase() && IN_HOME.test(name)) return true;
  return /^[a-z]:\\$/.test(here) && AT_DRIVE_ROOT.test(name);
}
