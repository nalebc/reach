import test, { before } from "node:test";
import assert from "node:assert/strict";

// How the phone plays what arrives (src/sound-worklet.js), run here with a
// stand-in for the browser's audio thread: 128 frames a block at 48 kHz.
const RATE = 48000;
let Sound;
before(async () => {
  globalThis.sampleRate = RATE;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { sent: [], postMessage: (m) => this.port.sent.push(m) };
    }
  };
  globalThis.registerProcessor = (name, processor) => {
    assert.equal(name, "reach-sound");
    Sound = processor;
  };
  await import("../src/sound-worklet.js");
});
const ms = (n) => Math.round((RATE * n) / 1000);
// Stereo frames of a constant level, as the hook posts them.
const frames = (n, level = 0.5) => new Float32Array(2 * n).fill(level);
const block = (sound) => {
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  sound.process([], [[left, right]]);
  globalThis.currentTime += 128 / RATE;
  return { left, right };
};
const feed = (sound, n, level) => sound.port.onmessage({ data: { type: "samples", samples: frames(n, level) } });

test("nothing plays until a tenth of a second is here; then it fades in, without a click", () => {
  const sound = new Sound();
  feed(sound, ms(60));
  assert.deepEqual([...block(sound).left.slice(0, 4)], [0, 0, 0, 0], "still filling");
  feed(sound, ms(40));
  const { left, right } = block(sound);
  assert.ok(left[0] > 0 && left[0] < 0.01, `starts near silence: ${left[0]}`);
  assert.ok(left[127] > left[0], "and rises");
  assert.equal(right[64], left[64]);
  // After 5 ms it plays at full level.
  for (let i = 0; i < 3; i++) block(sound);
  assert.equal(block(sound).left[100], 0.5);
});

test("running dry fades out what's left and waits longer next time; a silent computer doesn't count", () => {
  const sound = new Sound();
  feed(sound, ms(100));
  let played = 0;
  // 100 ms is 37.5 blocks: the 38th is short, and fades out to silence.
  let last;
  while ((last = block(sound)).left[127] !== 0 || played < 37) played++;
  assert.ok(last.left[0] > 0 && last.left.at(-1) === 0);
  for (let i = 1; i < 64; i++) if (last.left[i]) assert.ok(last.left[i] <= last.left[i - 1] + 1e-9, "only fades");
  assert.deepEqual(sound.port.sent.at(-1), { type: "late", target: 0.14 });
  // Now it waits for 140 ms before playing again.
  feed(sound, ms(120));
  assert.equal(block(sound).left[64], 0);
  feed(sound, ms(20));
  assert.ok(block(sound).left[64] > 0);
  // The computer went quiet (its packets said so): running dry then is no
  // fault of the link, and the queue stays as long as it was.
  const quiet = new Sound();
  feed(quiet, ms(100));
  quiet.port.onmessage({ data: { type: "quiet" } });
  for (let i = 0; i < 40; i++) block(quiet);
  assert.deepEqual(quiet.port.sent, []);
});

test("a burst after a stall keeps only the newest tenth of a second: late sound is worse than a skip", () => {
  const sound = new Sound();
  feed(sound, ms(100), 0.1);
  block(sound);
  // A stalled link delivers half a second at once.
  feed(sound, ms(500), 0.9);
  assert.ok(Math.abs(sound.count - ms(100)) <= 1, `${sound.count} frames queued`);
  // What's kept is the newest, faded in again.
  const { left } = block(sound);
  assert.ok(left[0] < 0.05 && left[127] > left[0]);
  for (let i = 0; i < 4; i++) block(sound);
  assert.equal(block(sound).left[64], Math.fround(0.9));
});

test("twenty calm seconds take 20 ms off the queue, never below 60 ms", () => {
  const sound = new Sound();
  sound.target = ms(100);
  sound.calmSince = globalThis.currentTime;
  for (let s = 0; s < 120; s++) {
    globalThis.currentTime += 1;
    sound.relax();
  }
  assert.equal(sound.target, ms(60));
});

test("the worklet loads as its own file from Reach: inlined as a data: address, the page's policy would refuse it", async () => {
  // Vite inlines a file this small unless told not to (Oct 13: the first
  // build did, and script-src 'self' blocks a data: worklet on the phone).
  const fs = await import("node:fs/promises");
  const hook = await fs.readFile(new URL("../src/useScreenSound.ts", import.meta.url), "utf8");
  assert.match(hook, /from "\.\/sound-worklet\.js\?url&no-inline"/);
  assert.doesNotMatch(await fs.readFile(new URL("../src/sound-worklet.js", import.meta.url), "utf8"), /^\s*import\s/m, "a worklet loads on its own");
});
