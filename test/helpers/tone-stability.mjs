// One brief underrun can cover a silent sample and a recovering fade. Count
// that as one episode, while still rejecting long gaps or repeated underruns.
export function toneStability(levels, late) {
  let blips = 0, off = 0, previous = false;
  for (const level of levels) {
    const bad = !Number.isFinite(level) || level < 0.165 || level > 0.2;
    if (bad) { off++; if (!previous) blips++; }
    previous = bad;
  }
  return { off, blips, passed: levels.length === 40 && levels.every(Number.isFinite) && off <= 2 && blips <= 1 && Number.isInteger(late) && late >= 0 && late <= 1 };
}
