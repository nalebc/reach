import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".html": "text/html", ".webmanifest": "application/manifest+json", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream" };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const meta = /<meta name="reach-shell-build" content="[a-f0-9]{64}">/g;
// Only current Vite output and this explicit public list: never a dist scan,
// which would include old builds, agent runtimes and unrelated local files.
export function writeOfflineShell(dist) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"));
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
  const icons = JSON.parse(fs.readFileSync(path.join(dist, "manifest.webmanifest"), "utf8")).icons;
  for (const icon of icons || []) if (/^\/assets\/[\w.-]+\.png$/.test(icon.src)) names.add(icon.src.slice(1));
  const indexPath = path.join(dist, "index.html");
  const html = fs.readFileSync(indexPath, "utf8").replace(meta, "");
  const entries = [];
  for (const name of [...names].sort()) {
    if (name === "index.html") continue;
    if (!/^(?:assets\/[\w.-]+|pdfjs\/(?:jbig2_nowasm_fallback|openjpeg_nowasm_fallback)\.js|manifest\.webmanifest|favicon\.svg)$/.test(name))
      throw Error("Non-public file in offline interface graph.");
    const file = path.join(dist, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || !mime[path.extname(name)]) throw Error("Invalid offline interface asset.");
    entries.push({ path: "/" + name, bytes: stat.size, sha256: digest(fs.readFileSync(file)), type: mime[path.extname(name)] });
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
