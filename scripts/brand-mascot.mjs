// The courier's portrait as pixel geometry on a 64-unit grid: the one source
// for the app icons (build-brand.mjs) and the terminal banner below.
const rect = (x, y, width, height, fill) => ({ x, y, width, height, fill });
export const background = "#18241f";
export const shapes = [
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

// The portrait's color at a point, or null outside it (the terminal shows
// through there, so the mascot sits on any theme).
const colorAt = (x, y) => {
  let fill = null;
  for (const s of shapes)
    if (x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height)
      fill = s.fill;
  return fill;
};
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
// The nearest color in xterm's 256-color cube, for terminals without truecolor
// (Apple Terminal).
const cube = (hex) => {
  const steps = [0, 95, 135, 175, 215, 255];
  const nearest = (v) =>
    steps.reduce((best, step, i) => (Math.abs(step - v) < Math.abs(steps[best] - v) ? i : best), 0);
  const [r, g, b] = channels(hex).map(nearest);
  return 16 + 36 * r + 6 * g + b;
};

// The mascot drawn with half blocks (two pixels per character), one line per
// entry. Empty when the terminal can't show color.
export function terminalMascot({ depth = 1, step = 3, left = 2 } = {}) {
  if (depth < 8) return [];
  const paint = (hex, ground) => {
    if (depth >= 24) return `\x1b[${ground ? 48 : 38};2;${channels(hex).join(";")}m`;
    return `\x1b[${ground ? 48 : 38};5;${cube(hex)}m`;
  };
  // Sample each cell's center, cropped to the figure (x 10–52, y 12–57).
  const columns = [],
    rows = [];
  for (let x = 10; x < 52; x += step) columns.push(x + step / 2);
  for (let y = 12; y < 57; y += step) rows.push(y + step / 2);
  if (rows.length % 2) rows.push(Infinity);
  const lines = [];
  for (let r = 0; r < rows.length; r += 2) {
    let line = " ".repeat(left);
    for (const x of columns) {
      const top = colorAt(x, rows[r]),
        bottom = colorAt(x, rows[r + 1]);
      if (!top && !bottom) line += " ";
      else if (top && bottom)
        line += `${paint(top)}${paint(bottom, true)}▀\x1b[0m`;
      else if (top) line += `${paint(top)}▀\x1b[0m`;
      else line += `${paint(bottom)}▄\x1b[0m`;
    }
    lines.push(line.replace(/ +$/, ""));
  }
  return lines;
}

// The startup banner: the mascot beside Reach's name, or just the name where
// color isn't available (logs, pipes, NO_COLOR).
export function banner(title, stream = process.stdout) {
  const depth =
    stream.isTTY && typeof stream.getColorDepth === "function" ? stream.getColorDepth() : 1;
  const art = terminalMascot({ depth });
  if (!art.length) return `  ${title}`;
  const middle = Math.floor(art.length / 2);
  return art
    .map((line, i) => (i === middle ? `${line}   \x1b[1m${title}\x1b[0m` : line))
    .join("\n");
}
