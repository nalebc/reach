import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { toneStability } from "./helpers/tone-stability.mjs";

// Numeric clocks retained from actual native-helper/Chrome runs. The post's
// AudioContext clock estimates worklet delivery; offsets and generated samples
// are models, not an actual render-thread, network or physical-device test.
const captures = JSON.parse(fs.readFileSync(new URL("./fixtures/sound-post-cadences.json", import.meta.url), "utf8"));
const source = fs.readFileSync(new URL("../src/sound-worklet.js", import.meta.url), "utf8");

for (const capture of captures.fixtures) for (const tone of [false, true]) for (const delay of [0, 128, 256, 512]) {
  test(`${capture.id}: modeled ${tone ? "stereo tone" : "constant samples"} with ${delay} frames delivery delay`, () => {
    const rate = capture.rate;
    const clock = { sampleRate: rate, currentTime: 0, Float32Array, Math };
    let Sound;
    const late = [];
    clock.AudioWorkletProcessor = class {
      constructor() { this.port = { postMessage: message => late.push({ frame: Math.round(clock.currentTime * rate), ...message }) }; }
    };
    clock.registerProcessor = (_name, value) => { Sound = value; };
    vm.runInNewContext(source, clock);
    const sound = new Sound();
    const history = new Float32Array(2048), levels = [];
    let nextPost = 0, nextSample = 0, mediaFrame = 0, historyAt = 0, energy = 0;
    const sampleEnd = capture.sampleFrames.at(-1) + Math.round(rate * 0.1);
    const end = Math.max(capture.posts.at(-1)[0] + delay + 128, sampleEnd);
    assert.equal(capture.sampleFrames.length, 40);
    for (let frame = 0; frame <= end; frame += 128) {
      clock.currentTime = frame / rate;
      while (nextSample < capture.sampleFrames.length && capture.sampleFrames[nextSample] <= frame) {
        levels.push(Math.sqrt(Math.max(0, energy) / history.length));
        nextSample++;
      }
      while (nextPost < capture.posts.length && capture.posts[nextPost][0] + delay <= frame) {
        const frames = capture.posts[nextPost++][1];
        const samples = new Float32Array(2 * frames);
        if (!tone) samples.fill(0.182);
        else for (let i = 0; i < frames; i++) {
          samples[2 * i] = Math.sin(2 * Math.PI * 440 * (mediaFrame + i) / rate) * 12000 / 32768;
          samples[2 * i + 1] = Math.sin(2 * Math.PI * 660 * (mediaFrame + i) / rate) * 12000 / 32768;
        }
        mediaFrame += frames;
        sound.port.onmessage({ data: { type: "samples", samples } });
      }
      const left = new Float32Array(128), right = new Float32Array(128);
      sound.process([], [[left, right]]);
      for (let i = 0; i < 128; i++) {
        energy -= history[historyAt] ** 2;
        history[historyAt] = (left[i] + right[i]) / 2;
        energy += history[historyAt] ** 2;
        historyAt = (historyAt + 1) % history.length;
      }
      assert.ok(sound.target <= Math.round(rate * 0.4), "the existing recovery target cap stays 400ms");
      assert.ok(sound.count >= 0 && sound.count <= sound.size, "the bounded media queue stays valid");
    }
    assert.equal(nextPost, capture.posts.length, "every captured numeric post is delivered once, in order");
    const drains = late.filter(event => event.frame >= capture.sampleFrames[0] && event.frame <= sampleEnd);
    const quality = toneStability(levels, drains.length);
    assert.equal(quality.passed, true, JSON.stringify({ ...quality, drains, lowSamples: levels.map((value, sample) => ({ value, sample })).filter(({ value }) => value < 0.165 || value > 0.2) }));
  });
}
