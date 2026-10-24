import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".html": "text/html", ".webmanifest": "application/manifest+json", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream" };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
// Read one bounded build input from the descriptor whose regular-file identity
// was checked. A concurrent replacement or write aborts this generation.
const readInput = file => {
  const max = 8 * 1024 * 1024, invalid = () => Error("Invalid offline interface asset.");
  const checked = fs.lstatSync(file, { bigint: true });
  if (!checked.isFile() || checked.size > BigInt(max)) throw invalid();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const same = (a, b) => b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    if (!same(checked, opened)) throw invalid();
    const body = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < body.length) {
      const count = fs.readSync(fd, body, length, body.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length !== Number(opened.size) || !same(opened, fs.fstatSync(fd, { bigint: true }))) throw invalid();
    return body.subarray(0, length);
  } finally { fs.closeSync(fd); }
};
const meta = /<meta name="reach-shell-build" content="[a-f0-9]{64}">/g;
// Only current Vite output and this explicit public list: never a dist scan,
// which would include old builds, agent runtimes and unrelated local files.
export function writeOfflineShell(dist) {
  const manifest = JSON.parse(readInput(path.join(dist, ".vite/manifest.json")).toString("utf8"));
  const visited = new Set(), names = new Set(["index.html", "manifest.webmanifest", "favicon.svg",
    "pdfjs/jbig2_nowasm_fallback.js", "pdfjs/openjpeg_nowasm_fallback.js"]);
  function visit(key) {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (!entry || typeof entry.file !== "string") throw Error("Incomplete offline interface graph.");
    visited.add(key);
    for (const name of [entry.file, ...(entry.css || []), ...(entry.assets || [])]) names.add(name);
    for (const key of [...(entry.imports || []), ...(entry.dynamicImports || [])]) visit(key);
  }
  visit("index.html");
  const icons = JSON.parse(readInput(path.join(dist, "manifest.webmanifest")).toString("utf8")).icons;
  for (const icon of icons || []) if (/^\/assets\/[\w.-]+\.png$/.test(icon.src)) names.add(icon.src.slice(1));
  const indexPath = path.join(dist, "index.html");
  const html = readInput(indexPath).toString("utf8").replace(meta, "");
  const entries = [];
  for (const name of [...names].sort()) {
    if (name === "index.html") continue;
    if (!/^(?:assets\/[\w.-]+|pdfjs\/(?:jbig2_nowasm_fallback|openjpeg_nowasm_fallback)\.js|manifest\.webmanifest|favicon\.svg)$/.test(name))
      throw Error("Non-public file in offline interface graph.");
    if (!mime[path.extname(name)]) throw Error("Invalid offline interface asset.");
    const body = readInput(path.join(dist, name));
    entries.push({ path: "/" + name, bytes: body.length, sha256: digest(body), type: mime[path.extname(name)] });
  }
  if (entries.length > 510 || entries.reduce((n, e) => n + e.bytes, 0) > 24 * 1024 * 1024) throw Error("Offline interface graph is too large.");
  const build = digest(html + JSON.stringify(entries));
  const page = html.replace("</head>", `<meta name="reach-shell-build" content="${build}"></head>`);
  if (page === html) throw Error("Offline interface has no document head.");
  fs.writeFileSync(indexPath, page);
  entries.unshift({ path: "/index.html", bytes: Buffer.byteLength(page), sha256: digest(page), type: "text/html" });
  const result = { version: 1, build, entries };
  fs.writeFileSync(path.join(dist, "offline-shell.json"), JSON.stringify(result) + "\n");
  return result;
}
