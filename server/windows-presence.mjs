import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsBinary } from "./desktop-native.mjs";

const exec = promisify(execFile);

// How long this PC has had no keyboard or mouse input (seconds) and whether
// it's locked, from scripts/native/presence.cs: the Windows twin of the
// Mac's ioreg readings (agent-sessions/claude-import.mjs). A field Windows
// wouldn't give is null, never guessed. The helper is built into Reach's
// data folder, as every Windows helper is (desktop-native.mjs).
let folder = null;
export const usePresenceFolder = (dir) => {
  folder = dir || null;
};
export async function windowsPresence({ dataDir = folder, run = exec, build = windowsBinary } = {}) {
  if (!dataDir) throw Error("Reach's data folder isn't known yet.");
  const file = await build({ dataDir }, "presence");
  const { stdout } = await run(file, [], { timeout: 5000, windowsHide: true });
  const value = JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
  return {
    idleSeconds: Number.isFinite(value?.idleMs) && value.idleMs >= 0 ? value.idleMs / 1000 : null,
    locked: typeof value?.locked === "boolean" ? value.locked : null,
  };
}
