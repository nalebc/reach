import jsQR from "jsqr";

// Decode the pixels printed by qrcode-terminal, rather than intercepting
// qr.generate or trusting the adjacent "Open on your phone" text.
export function scanTerminalQRs(output) {
  const lines = String(output).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^▄{23,}$/.test(lines[i])) continue;
    const width = lines[i].length, rows = [lines[i]];
    while (i + 1 < lines.length && lines[i + 1].length === width && /^[ █▀▄]+$/.test(lines[i + 1])) rows.push(lines[++i]);
    const height = rows.length * 2 - 1;
    if (height !== width) continue;
    const scale = 6, margin = 4, size = (width + margin * 2) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    const halves = { "█": [255, 255], "▀": [255, 0], "▄": [0, 255], " ": [0, 0] };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const raw = y + 1; // The terminal's top black half-row is outside the QR.
      const value = halves[rows[Math.floor(raw / 2)][x]][raw % 2];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const at = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = value;
      }
    }
    const decoded = jsQR(pixels, size, size);
    if (decoded) found.push(decoded.data);
  }
  return found;
}
