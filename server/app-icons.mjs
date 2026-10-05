import { fileURLToPath } from "node:url";
import { exec } from "./platform.mjs";

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
export const readAppIcons = async (appIds) =>
  process.platform === "darwin" ? readMacIcons(appIds) : appIds.map(() => null);
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
