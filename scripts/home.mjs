import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Installed with npm (`npm install -g @nalebc/reach`), Reach's folder holds no
// sources and is replaced on every upgrade, so its state (pairings, settings,
// logs) lives in ~/.reach. A source checkout keeps using its own .reach folder.
export const packaged = !fs.existsSync(
  new URL("../src/main.tsx", import.meta.url),
);

export function stateDir(
  root,
  { installed = packaged, home = os.homedir(), env = process.env } = {},
) {
  if (env.REACH_HOME) return path.resolve(env.REACH_HOME);
  return installed ? path.join(home, ".reach") : path.join(root, ".reach");
}

// The command to show in help and hints.
export const command = packaged ? "reach" : "./reach";
