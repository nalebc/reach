// The courier's portrait, shared by the app mark, browser icon and phone icons.
// The original pixel portrait remains crisp at notification sizes.
// Export with Node's standard library so every build uses the same artwork.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const background = "#18241f";
// The selected logo portrait, kept as pixel geometry for every export size.
const rect = (x, y, width, height, fill) => ({ x, y, width, height, fill });
const shapes = [
  rect(19, 48, 26, 5, "#101b16"),
  rect(23, 46, 18, 11, "#80ad95"),
  rect(29, 51, 6, 3, "#d7f3e2"),
  rect(10, 27, 6, 15, "#5c7d6b"),
  rect(18, 12, 28, 38, "#bce7ce"),
  rect(12, 18, 40, 26, "#bce7ce"),
  rect(18, 15, 28, 3, "#e5f7e8"),
  rect(18, 44, 28, 3, "#a3cdb5"),
  rect(46, 21, 3, 20, "#a3cdb5"),
  rect(20, 25, 24, 15, "#213e31"),
  rect(18, 28, 28, 9, "#213e31"),
  rect(24, 28, 4, 7, "#f5f4d9"),
  rect(36, 28, 4, 7, "#f5f4d9"),
];
const svgShape = (shape) =>
  `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${shape.fill}"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="14" fill="${background}"/><g shape-rendering="crispEdges">${shapes.map(svgShape).join("")}</g></svg>\n`;

const rgb = (hex) => Buffer.from(hex.slice(1), "hex");
const crc = (data) => {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (name, data) => {
  const type = Buffer.from(name);
  const header = Buffer.alloc(4),
    trailer = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  trailer.writeUInt32BE(crc(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, trailer]);
};
const png = (size) => {
  const pixels = Buffer.alloc(size * size * 3);
  const paint = (x, y, width, height, color) => {
    const startX = Math.round((x * size) / 64);
    const endX = Math.round(((x + width) * size) / 64);
    const startY = Math.round((y * size) / 64);
    const endY = Math.round(((y + height) * size) / 64);
    for (let row = startY; row < endY; row++)
      for (let col = startX; col < endX; col++)
        color.copy(pixels, (row * size + col) * 3);
  };
  paint(0, 0, 64, 64, rgb(background));
  for (const shape of shapes)
    paint(shape.x, shape.y, shape.width, shape.height, rgb(shape.fill));
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++)
    pixels.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2; // Opaque RGB; iOS app icons cannot have alpha.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
const save = (name, data) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || !fs.readFileSync(file).equals(Buffer.from(data)))
    fs.writeFileSync(file, data);
};
save("src/assets/reach-mascot.svg", svg);
save("public/favicon.svg", svg);
const version = createHash("sha256").update(svg).digest("hex").slice(0, 10);
const icon = (size) => `/assets/reach-mascot-${version}-${size}.png`;
for (const size of [180, 192, 512]) save(`public${icon(size)}`, png(size));
// Only branding references are generated; preserve every other app setting.
for (const name of ["index.html", "start.html", "agent.html"]) {
  let html = fs.readFileSync(path.join(root, name), "utf8");
  html = html.replace(
    /href="\/favicon\.svg(?:\?[^"]*)?"/,
    `href="/favicon.svg?brand=${version}"`,
  );
  if (name !== "agent.html") {
    const link = `<link rel="apple-touch-icon" sizes="180x180" href="${icon(180)}"/>`;
    html = /<link[^>]*rel="apple-touch-icon"[^>]*>/.test(html)
      ? html.replace(/<link[^>]*rel="apple-touch-icon"[^>]*>/, link)
      : html.replace('<link rel="manifest"', `${link}<link rel="manifest"`);
  }
  save(name, html);
}
const manifestPath = "public/manifest.webmanifest";
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, manifestPath), "utf8"),
);
manifest.icons = [192, 512].map((size) => ({
  src: icon(size),
  sizes: `${size}x${size}`,
  type: "image/png",
  purpose: "any",
}));
manifest.icons.push({
  src: `/favicon.svg?brand=${version}`,
  sizes: "any",
  type: "image/svg+xml",
  purpose: "any",
});
save(manifestPath, JSON.stringify(manifest) + "\n");
const workerPath = "public/sw.js";
const worker = fs.readFileSync(path.join(root, workerPath), "utf8");
save(
  workerPath,
  worker.replace(
    /"\/(?:icons\/reach-192|assets\/reach-mascot-[a-f0-9]+-192)\.png"/,
    JSON.stringify(icon(192)),
  ),
);
// Keep the addresses cached by existing Home Screen installations current too.
save("public/apple-touch-icon.png", png(180));
save("public/icons/reach-192.png", png(192));
save("public/icons/reach-512.png", png(512));
save(
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
  png(1024),
);
console.log("Built Reach mascot icons (SVG, web, iPhone, Android).");
