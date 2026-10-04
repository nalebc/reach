import { fileURLToPath } from "node:url";
import { exec } from "./platform.mjs";

export async function readAppIcon(appId) {
  if (process.platform !== "darwin") return null;
  const { stdout } = await exec(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      fileURLToPath(new URL("../scripts/native/app-icon.js", import.meta.url)),
      appId,
    ],
    { timeout: 5000, maxBuffer: 64 * 1024 },
  );
  const data = stdout.trim();
  if (!data.startsWith("iVBORw0KGgo") || !/^[A-Za-z0-9+/=]+$/.test(data))
    return null;
  return `data:image/png;base64,${data}`;
}

// One native lookup at a time, deduplicated across clients. Both failures and
// successes expire; the bounded cache never holds an entire large app library.
export function createAppIconCache(read = readAppIcon) {
  const cache = new Map();
  let queue = Promise.resolve();
  return (id) => {
    const cached = cache.get(id);
    if (cached && cached.expires > Date.now()) return cached.result;
    const result = queue.then(() => read(id)).catch(() => null);
    queue = result.then(() => undefined);
    cache.delete(id);
    cache.set(id, { result, expires: Date.now() + 10 * 60 * 1000 });
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return result;
  };
}
