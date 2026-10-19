import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// A queue-model regression from the retained real Intel CI failure. This
// replaces audio with constant samples and estimates worklet delivery from
// the captured AudioContext frame; actual browser/helper checks stay separate.
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/sound-intel-post-cadence.json", import.meta.url), "utf8"));
const source = fs.readFileSync(new URL("../src/sound-worklet.js", import.meta.url), "utf8");
function playback(rate = 48000) {
  const state = { sampleRate: rate, currentTime: 0, Float32Array, Math };
  const late = [];
  let Sound;
  state.AudioWorkletProcessor = class {
    constructor() { this.port = { postMessage: message => late.push({ frame: Math.round(state.currentTime * rate), ...message }) }; }
  };
  state.registerProcessor = (_name, processor) => { Sound = processor; };
  vm.runInNewContext(source, state);
  const sound = new Sound();
  return { sound, state, late,
    feed(frames) { sound.port.onmessage({ data: { type: "samples", samples: new Float32Array(2 * frames).fill(0.182) } }); },
    block() {
      const left = new Float32Array(128), right = new Float32Array(128);
      sound.process([], [[left, right]]);
      state.currentTime += 128 / rate;
      return left;
    },
  };
}
for (const offset of [0, 128, 256, 512]) {
  test(`captured Intel packet cadence avoids a second drain with ${offset} frames of modeled delivery delay`, () => {
    const p = playback(fixture.rate);
    let position = 0;
    const end = fixture.posts.at(-1)[0] + offset + 512;
    for (let frame = 0; frame < end; frame += 128) {
      p.state.currentTime = frame / fixture.rate;
      while (position < fixture.posts.length && fixture.posts[position][0] + offset <= frame) p.feed(fixture.posts[position++][1]);
      p.block();
      assert.ok(p.sound.target <= Math.round(fixture.rate * 0.4), "recovery remains within the existing 400ms limit");
    }
    assert.equal(position, fixture.posts.length, "every captured post is delivered once");
    const steady = p.late.filter(e => e.frame >= fixture.sampleFrames[0] && e.frame <= fixture.sampleFrames.at(-1));
    assert.equal(steady.length, 1, "the actual old cadence produced two drains; recovery must absorb the next batch gap");
  });
}
for (const rate of [44100, 48000]) {
  const frames = ms => Math.round(rate * ms / 1000);
  const drain = p => { p.feed(frames(100)); for (let i = 0; i < Math.ceil(frames(100) / 128) + 1; i++) p.block(); assert.equal(p.late.length, 1); };
  test(`a slow first packet does not change the initial 100ms queue at ${rate}Hz`, () => {
    const p = playback(rate);
    p.feed(frames(20)); p.block(); p.state.currentTime += 1;
    p.feed(frames(80));
    assert.ok(p.block().some(v => v > 0), "first playback still starts with 100ms accumulated");
    assert.equal(p.late.length, 0);
  });
  test(`quiet and clear do not treat an intentional pause as network lateness at ${rate}Hz`, () => {
    for (const type of ["quiet", "clear"]) {
      const p = playback(rate); drain(p);
      p.sound.port.onmessage({ data: { type } }); p.state.currentTime += 1;
      p.feed(frames(140));
      assert.ok(p.block().some(v => v > 0), `${type} retains the learned queue without learning from the intentional gap`);
      assert.equal(p.late.length, 1);
    }
  });
  test(`a long delivery gap cannot grow recovery past 400ms at ${rate}Hz`, () => {
    const p = playback(rate); drain(p); p.state.currentTime += 10;
    p.feed(frames(400));
    assert.ok(p.block().some(v => v > 0), "400ms of new sound is sufficient even after a long gap");
    assert.ok(p.sound.target <= frames(400));
  });
  test(`empty sample messages cannot hide a real recovery gap or end quiet at ${rate}Hz`, () => {
    const p = playback(rate); drain(p); p.state.currentTime += 1;
    p.feed(0);
    assert.equal(p.sound.target, frames(140), "an empty message does not inflate the queue");
    p.state.currentTime += 0.01; p.feed(frames(140));
    assert.ok(p.block().every(v => v === 0), "the real packet still observes the full delivery gap");
    p.feed(frames(260));
    assert.ok(p.block().some(v => v > 0));
    const quiet = playback(rate); quiet.feed(frames(100));
    quiet.sound.port.onmessage({ data: { type: "quiet" } }); quiet.feed(0);
    for (let i = 0; i < Math.ceil(frames(100) / 128) + 1; i++) quiet.block();
    assert.equal(quiet.late.length, 0, "an empty sample message is not new sound after quiet");
  });
}
