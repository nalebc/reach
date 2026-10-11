// After `vite build`: write .br and .gz next to each built script and
// stylesheet, so the companion serves them compressed with no work per request.
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
// An interrupted write must never look like a fresh, reusable copy.
async function save(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function compressAssets(dist) {
  const dir = path.resolve(dist, "assets");
  let before = 0,
    after = 0,
    compressed = 0,
    reused = 0;
  for (const name of await fs.readdir(dir)) {
    if (!/\.(?:js|css|svg|json|webmanifest)$/.test(name)) continue;
    const file = path.join(dir, name);
    const source = await fs.stat(file);
    // Vite keeps older builds for phones that are still open. Recompressing
    // all of them at Brotli quality 11 made each restart take minutes.
    const copies = await Promise.all(
      ["br", "gz"].map((ext) =>
        fs.stat(`${file}.${ext}`).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }),
      ),
    );
    if (
      copies.every((copy) => copy?.size > 0 && copy.mtimeMs >= source.mtimeMs)
    ) {
      reused++;
      continue;
    }
    const data = await fs.readFile(file);
    const br = await brotli(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });
    await save(`${file}.br`, br);
    await save(`${file}.gz`, await gzip(data, { level: 9 }));
    compressed++;
    before += data.length;
    after += br.length;
  }
  return { before, after, compressed, reused };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const { before, after, compressed, reused } = await compressAssets(
    process.argv[2] || "dist",
  );
  console.log(
    `Compressed ${compressed} assets: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (brotli); reused ${reused} unchanged assets.`,
  );
}
