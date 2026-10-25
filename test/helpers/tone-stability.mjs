// One brief underrun can cover a silent sample and a recovering fade. Count
// that as one episode, while still rejecting long gaps or repeated underruns.
// `explained` underruns followed a measured stall of the computer's own sound
// source (sourceStalls/explainedDropouts below): each may add one brief blip.
export function toneStability(levels, late, { explained = 0 } = {}) {
  let blips = 0, off = 0, previous = false;
  for (const level of levels) {
    const bad = !Number.isFinite(level) || level < 0.165 || level > 0.2;
    if (bad) { off++; if (!previous) blips++; }
    previous = bad;
  }
  const valid = Number.isInteger(late) && late >= 0 && Number.isInteger(explained) && explained >= 0 && explained <= late;
  return {
    off, blips,
    passed: levels.length === 40 && levels.every(Number.isFinite) && valid &&
      off <= 2 + 2 * explained && blips <= 1 + explained && late - explained <= 1,
  };
}

// The sound helper sends a packet every 20 ms. A gap longer than the player's
// starting buffer (100 ms) between two of its packets, as Reach received
// them, is the source itself running behind the clock: a starved CI machine
// (Oct 19, Intel macOS: the helper paused 100–163 ms again and again, and the
// browser's gaps matched its own to within 3 ms). No player can play sound
// that hasn't been made. Gaps are measured at the helper, before Reach's
// relay, so a delay Reach itself adds is never one of them.
export function sourceStalls(helperPackets, { minGapMs = 100 } = {}) {
  const stalls = [];
  for (let i = 1; i < helperPackets.length; i++) {
    const gapMs = helperPackets[i].wallMs - helperPackets[i - 1].wallMs;
    if (gapMs >= minGapMs) stalls.push({ startWallMs: helperPackets[i - 1].wallMs, endWallMs: helperPackets[i].wallMs, gapMs });
  }
  return stalls;
}

// How many of the browser's dry-queue reports a source stall accounts for:
// each stall explains at most one, reported during it or within `afterMs`
// of its end (the queue drains during the stall; its report crosses the
// worklet's port). A queue that runs dry while packets come on time, or
// twice for one stall, still counts against the player.
export function explainedDropouts(lates, stalls, { afterMs = 300 } = {}) {
  const used = new Set();
  let explained = 0;
  for (const late of [...lates].sort((a, b) => a.wallMs - b.wallMs)) {
    const at = stalls.findIndex((stall, index) => !used.has(index) &&
      late.wallMs >= stall.startWallMs && late.wallMs <= stall.endWallMs + afterMs);
    if (at >= 0) { used.add(at); explained++; }
  }
  return explained;
}
