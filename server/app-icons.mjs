import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exec } from "./platform.mjs";
import { windowsBinary } from "./desktop-native.mjs";

export const valid = (data) =>
  data.startsWith("iVBORw0KGgo") && /^[A-Za-z0-9+/=]+$/.test(data)
    ? `data:image/png;base64,${data}`
    : null;

// Many Mac icons from one native process: launching osascript dominates the
// cost. Targets are app paths or file types (see scripts/native/app-icon.js).
export async function readMacIcons(targets, run = exec) {
  if (!targets.length) return [];
  const { stdout } = await run(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      fileURLToPath(new URL("../scripts/native/app-icon.js", import.meta.url)),
      ...targets,
    ],
    {
      timeout: 5000 + targets.length * 250,
      maxBuffer: targets.length * 64 * 1024,
    },
  );
  const lines = String(stdout).split("\n");
  return targets.map((_, i) => valid((lines[i] || "").trim()));
}
// Windows: the image the shell draws for each app (Start's app id) or
// program (its full path), from scripts/native/app-icons.cs, built into
// Reach's data folder as every Windows helper is (desktop-native.mjs).
let iconFolder = null;
export const useAppIconFolder = (dir) => {
  iconFolder = dir || null;
};
export async function readWindowsIcons(targets, { size = 64, dataDir = iconFolder, build = windowsBinary, spawn = spawnChild } = {}) {
  if (!targets.length) return [];
  if (!dataDir) return targets.map(() => null);
  const file = await build({ dataDir }, "app-icons");
  return new Promise((resolve) => {
    const child = spawn(file, [String(size)], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill(), 5000 + targets.length * 500);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.length > targets.length * 400000) child.kill();
    });
    child.on("error", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/);
      resolve(targets.map((_, i) => valid((lines[i] || "").trim())));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${targets.map((target) => String(target).replace(/[\r\n\0]/g, " ")).join("\n")}\n`);
  });
}
export const readAppIcons = async (appIds) =>
  process.platform === "darwin"
    ? readMacIcons(appIds)
    : process.platform === "win32"
      ? readWindowsIcons(appIds).catch(() => appIds.map(() => null))
      : appIds.map(() => null);
export const readAppIcon = async (appId) => (await readAppIcons([appId]))[0];

// One native lookup at a time, deduplicated across clients. Ids requested while
// a lookup runs are read together in the next one. Both failures and successes
// expire; the bounded cache never holds an entire large app library.
export function createAppIconCache(readMany = readAppIcons) {
  const cache = new Map();
  const waiting = new Map();
  let reading = false;
  const pump = async () => {
    if (reading || !waiting.size) return;
    reading = true;
    const batch = [...waiting].slice(0, 48);
    for (const [id] of batch) waiting.delete(id);
    let results = [];
    try {
      results = await readMany(batch.map(([id]) => id));
    } catch {}
    batch.forEach(([, entry], i) => entry.resolve(results?.[i] ?? null));
    reading = false;
    void pump();
  };
  return (id) => {
    const cached = cache.get(id);
    if (cached && cached.expires > Date.now()) return cached.result;
    let result = waiting.get(id)?.result;
    if (!result) {
      const entry = {};
      result = entry.result = new Promise((r) => (entry.resolve = r));
      waiting.set(id, entry);
    }
    // Let the rest of a burst (a whole screen of icons) join this lookup.
    setImmediate(pump);
    cache.delete(id);
    cache.set(id, { result, expires: Date.now() + 10 * 60 * 1000 });
    if (cache.size > 160) cache.delete(cache.keys().next().value);
    return result;
  };
}
