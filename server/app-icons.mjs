import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exec } from "./platform.mjs";
import { windowsBinary } from "./desktop-native.mjs";
import { windowsShellFolder } from "./windows-shell-data.mjs";
export { useWindowsShellFolder as useAppIconFolder } from "./windows-shell-data.mjs";

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
export async function readWindowsIcons(targets, { size = 64, dataDir = windowsShellFolder(), build = windowsBinary, spawn = spawnChild, authorize = () => {} } = {}) {
  if (!targets.length) return [];
  if (!dataDir) return targets.map(() => null);
  const file = await build({ dataDir }, "app-icons");
  authorize();
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
export const readAppIcons = async (appIds, { authorize = () => {} } = {}) => {
  authorize();
  return process.platform === "darwin"
    ? readMacIcons(appIds)
    : process.platform === "win32"
      ? readWindowsIcons(appIds, { authorize }).catch(() => appIds.map(() => null))
      : appIds.map(() => null);
};
export const readAppIcon = async (appId) => (await readAppIcons([appId]))[0];

// One native lookup at a time, deduplicated across clients. Ids requested while
// a lookup runs are read together in the next one. Both failures and successes
// expire; the bounded cache never holds an entire large app library.
export function createAppIconCache(readMany = readAppIcons) {
  const cache = new Map();
  const waiting = new Map();
  let reading = null, scheduled = null, closed = false, stopping;
  const authorize = () => {
    if (closed) throw Object.assign(new Error("Reach is shutting down."), { status: 503 });
  };
  const schedule = () => {
    if (!closed && !scheduled) scheduled = setImmediate(pump);
  };
  const pump = () => {
    scheduled = null;
    if (closed || reading || !waiting.size) return;
    const batch = [...waiting].slice(0, 48);
    for (const [id] of batch) waiting.delete(id);
    // Register ownership before invoking a reader: it may still be building
    // its native helper, and its completion includes the actual child close.
    reading = Promise.resolve().then(async () => {
      let results = [];
      try {
        if (!closed) results = await readMany(batch.map(([id]) => id), { authorize });
      } catch {}
      batch.forEach(([, entry], i) => entry.resolve(results?.[i] ?? null));
    });
    void reading.then(() => {
      reading = null;
      if (waiting.size) schedule();
    });
  };
  const get = (id) => {
    if (closed) return Promise.resolve(null);
    const cached = cache.get(id);
    if (cached && cached.expires > Date.now()) return cached.result;
    let result = waiting.get(id)?.result;
    if (!result) {
      const entry = {};
      result = entry.result = new Promise((r) => (entry.resolve = r));
      waiting.set(id, entry);
    }
    // Let the rest of a burst (a whole screen of icons) join this lookup.
    schedule();
    cache.delete(id);
    cache.set(id, { result, expires: Date.now() + 10 * 60 * 1000 });
    if (cache.size > 160) cache.delete(cache.keys().next().value);
    return result;
  };
  get.close = () => {
    if (stopping) return stopping;
    closed = true;
    if (scheduled) clearImmediate(scheduled);
    scheduled = null;
    for (const entry of waiting.values()) entry.resolve(null);
    waiting.clear();
    cache.clear();
    // Never start queued lookups during shutdown. The current reader keeps
    // its existing native deadline; returning early can leave its exe locked.
    return stopping = (reading || Promise.resolve()).then(() => {});
  };
  return get;
}
