// After `vite build`: write .br and .gz next to each built script and
// stylesheet, so the companion serves them compressed with no work per request.
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const dir = path.resolve(process.argv[2] || "dist", "assets");
let before = 0,
  after = 0;
for (const name of await fs.readdir(dir)) {
  if (!/\.(?:js|css|svg|json|webmanifest)$/.test(name)) continue;
  const file = path.join(dir, name);
  const data = await fs.readFile(file);
  const br = await brotli(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  await fs.writeFile(`${file}.br`, br);
  await fs.writeFile(`${file}.gz`, await gzip(data, { level: 9 }));
  before += data.length;
  after += br.length;
}
console.log(
  `Compressed assets: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (brotli)`,
);
