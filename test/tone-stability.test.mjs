import test from "node:test";
import assert from "node:assert/strict";
import { toneStability } from "./helpers/tone-stability.mjs";
const tone = () => Array(40).fill(0.183);

test("one dry queue with a silent reading and a recovering fade is one brief blip", () => {
  const levels = tone(); levels[12] = 0; levels[13] = 0.119;
  assert.deepEqual(toneStability(levels, 1), { off: 2, blips: 1, passed: true });
  assert.equal(toneStability(tone(), 0).passed, true);
});
test("repeated gaps, a long gap and persistent wrong levels still fail", () => {
  const repeated = tone(); repeated[12] = 0; repeated[30] = 0;
  const long = tone(); long.splice(12, 3, 0, 0, 0.119);
  for (const [levels, late] of [[repeated, 1], [long, 1], [tone(), 2], [Array(40).fill(0), 1], [Array(40).fill(0.119), 0]])
    assert.equal(toneStability(levels, late).passed, false);
});
test("missing or invalid readings and counters cannot certify sound stability", () => {
  const invalid = tone(); invalid[4] = NaN;
  for (const [levels, late] of [[tone().slice(0, 10), 0], [invalid, 0], [tone(), -1], [tone(), NaN]])
    assert.equal(toneStability(levels, late).passed, false);
});
