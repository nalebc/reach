import test from "node:test";
import assert from "node:assert/strict";
import { toneStability, sourceStalls, explainedDropouts } from "./helpers/tone-stability.mjs";
import { createToneTiming, observeToneSource, observeToneWebSockets, observeTonePort } from "./helpers/tone-timing.mjs";
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

// Packets every 20 ms from `from`, with the given pauses (start offset, length) in ms.
const packets = (from, count, pauses = []) => {
  const out = [];
  let at = from;
  for (let i = 0; i < count; i++) {
    out.push({ wallMs: at });
    const pause = pauses.find(([offset]) => at - from < offset + 20 && at - from >= offset);
    at += pause ? pause[1] : 20;
  }
  return out;
};
test("a dropout right after the sound source itself stalled is explained; one per stall", () => {
  // Oct 19 on Intel macOS: the helper paused 135 ms and 139 ms 140 ms apart;
  // the browser ran dry once in each.
  const helper = packets(1000, 200, [[900, 135], [1040, 139]]);
  const stalls = sourceStalls(helper);
  assert.deepEqual(stalls.map((s) => s.gapMs), [135, 139]);
  const lates = [{ wallMs: stalls[0].startWallMs + 110 }, { wallMs: stalls[1].startWallMs + 120 }];
  assert.equal(explainedDropouts(lates, stalls), 2);
  const levels = tone(); levels[2] = 0.124; levels[4] = 0;
  assert.equal(toneStability(levels, 2, { explained: 2 }).passed, true);
  assert.equal(toneStability(levels, 2).passed, false, "without the measured stalls it still fails");
});
test("dropouts with the source on time, a relay delay, or two for one stall still fail", () => {
  const onTime = packets(1000, 200);
  assert.deepEqual(sourceStalls(onTime), [], "regular 20 ms packets are no stall, however many dropouts");
  const twoDry = [{ wallMs: 2000 }, { wallMs: 2600 }];
  assert.equal(explainedDropouts(twoDry, sourceStalls(onTime)), 0);
  const levels = tone(); levels[5] = 0; levels[20] = 0;
  assert.equal(toneStability(levels, 2, { explained: 0 }).passed, false);
  // Reach holding packets after the helper sent them on time: the browser
  // sees a gap, the helper doesn't, so it explains nothing.
  assert.equal(explainedDropouts([{ wallMs: 1500 }], sourceStalls(onTime)), 0);
  // One stall can't excuse a second, later dry queue.
  const one = sourceStalls(packets(1000, 200, [[900, 150]]));
  assert.equal(explainedDropouts([{ wallMs: one[0].startWallMs + 120 }, { wallMs: one[0].endWallMs + 200 }], one), 1);
  // A dropout long after a stall isn't its doing.
  assert.equal(explainedDropouts([{ wallMs: one[0].endWallMs + 900 }], one), 0);
});
test("explained dropouts can't exceed the dropouts, and shorter pauses aren't stalls", () => {
  assert.equal(toneStability(tone(), 0, { explained: 1 }).passed, false);
  assert.equal(toneStability(tone(), 1, { explained: -1 }).passed, false);
  assert.deepEqual(sourceStalls(packets(1000, 100, [[500, 99]])), []);
});

test("timing retains only finite allowlisted metadata, with 512 events per kind and 40 samples", () => {
  let now = 0;
  const timing = createToneTiming({ now: () => now, wall: () => now + 1700000000000 });
  const kinds = ["helper-info", "helper-packet", "helper-end", "socket-packet", "worklet-post", "worklet-quiet", "worklet-late", "clock-sample"];
  const secret = "private audio, https://private.example/?token=secret and raw failure";
  const values = {
    rate: 48000, channels: 2, frames: 960, sequence: 0, bytes: 984, quiet: 0,
    audioTime: 1, audioFrame: 48000, targetMs: 140, level: 0.183, sample: 0,
    samples: new Float32Array([0.123]), url: secret, token: secret, error: Error(secret),
  };
  for (let i = 0; i < 1200; i++) {
    now = i ? i + 999 : 0;
    values.sequence = i;
    for (const kind of kinds) timing.record(kind, values);
  }
  timing.record("untrusted-kind", values);
  timing.record("__proto__", values);
  const snapshot = timing.snapshot();
  assert.deepEqual(Object.keys(snapshot.streams), kinds);
  for (const stream of Object.values(snapshot.streams)) {
    assert.equal(stream.count, 1200);
    assert.equal(stream.overwritten, 688);
    assert.equal(stream.events.length, 512);
    assert.equal(stream.maxGapMs, 1000, "the maximum gap survives after its events roll out");
    assert.equal(stream.maxGapAtMs, 1000);
    assert.equal(stream.events.some((event) => Object.keys(event).some((key) => ["samples", "url", "token", "error"].includes(key))), false);
    assert.equal(stream.events.some((event) => Object.values(event).some((value) => !Number.isFinite(value))), false);
  }
  assert.equal(snapshot.streams["helper-packet"].events[0].sequence, 688);
  assert.equal(snapshot.streams["helper-packet"].events.at(-1).sequence, 1199);
  assert.deepEqual(Object.keys(snapshot.streams["helper-end"].events[0]), ["tMs", "wallMs"]);
  assert.equal(/private|secret|"url"|"token"|"error"/.test(JSON.stringify(snapshot)), false);
  assert.ok(JSON.stringify(snapshot).length < 1000000, "all streams together stay below a fixed report size");
  const returned = timing.record("helper-info", { rate: Infinity, channels: "secret" });
  returned.token = secret;
  snapshot.streams["helper-packet"].events[0].token = secret;
  assert.deepEqual(Object.keys(timing.snapshot().streams["helper-info"].events.at(-1)), ["tMs", "wallMs"]);
  assert.equal(/secret/.test(JSON.stringify(timing.snapshot())), false);
  for (let i = 0; i < 600; i++) {
    now++;
    assert.equal(timing.sample(0.183, { audioTime: i / 10, rate: 48000, token: secret }), 0.183);
  }
  const sampled = timing.snapshot();
  assert.equal(sampled.sampleCount, 600);
  assert.equal(sampled.samples.length, 40);
  assert.equal(sampled.samples[0].sample, 560);
  assert.equal(sampled.samples.at(-1).sample, 599);
  assert.ok(Number.isNaN(timing.sample(NaN)));
  assert.equal(Object.hasOwn(timing.snapshot().samples.at(-1), "level"), false);
});

test("helper observation delivers the same arguments, receiver, return and error exactly once", () => {
  const timing = createToneTiming();
  const info = { rate: 48000, channels: 2 };
  const samples = new Int16Array(1920);
  const receiver = {}, result = Promise.resolve(123), failure = Error("private raw failure");
  const calls = [];
  const handlers = {
    onInfo(...args) { calls.push([this, ...args]); return info; },
    onSamples(...args) { calls.push([this, ...args]); return result; },
    onEnd(...args) { calls.push([this, ...args]); throw failure; },
  };
  const observed = observeToneSource(handlers, timing);
  assert.equal(observed.onInfo.call(receiver, info), info);
  assert.equal(observed.onSamples.call(receiver, samples, info), result);
  assert.throws(() => observed.onEnd.call(receiver, failure), (error) => error === failure);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], receiver);
  assert.equal(calls[0][1], info);
  assert.equal(calls[1][0], receiver);
  assert.equal(calls[1][1], samples);
  assert.equal(calls[1][2], info);
  assert.equal(calls[2][0], receiver);
  assert.equal(calls[2][1], failure);
  assert.equal(timing.snapshot().streams["helper-packet"].events[0].frames, 960);
  assert.equal(timing.snapshot().streams["helper-end"].count, 1);
  assert.doesNotMatch(JSON.stringify(timing.snapshot()), /private raw failure/);
  const brokenObserver = observeToneSource(handlers, { record() { throw Error("observer only"); } });
  assert.equal(brokenObserver.onSamples.call(receiver, samples, info), result);
  assert.equal(calls.length, 4);
});

test("socket observation preserves native construction and the original packet delivery", () => {
  const timing = createToneTiming();
  const failure = Error("native construction failed");
  let constructions = 0;
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor(...args) {
      super(); constructions++;
      if (args[0] === "throw") throw failure;
      this.args = args;
    }
  }
  const scope = { WebSocket: Socket };
  observeToneWebSockets(scope, timing, () => ({ audioTime: 2, audioFrame: 96000, rate: 48000 }));
  class Child extends scope.WebSocket {}
  const protocols = ["private-protocol"];
  const socket = new Child("wss://private.example/?token=secret", protocols);
  assert.ok(socket instanceof Child);
  assert.ok(socket instanceof Socket);
  assert.ok(socket instanceof scope.WebSocket);
  assert.equal(scope.WebSocket.OPEN, Socket.OPEN);
  assert.equal(socket.args[1], protocols);
  assert.throws(() => new scope.WebSocket("throw"), (error) => error === failure);
  assert.equal(constructions, 2);
  const packet = new ArrayBuffer(16), view = new DataView(packet);
  view.setUint8(0, 1); view.setUint8(1, 1); view.setUint8(2, 2);
  view.setUint32(4, 48000, true); view.setUint32(8, 123, true); view.setUint16(12, 960, true);
  const before = new Uint8Array(packet).slice();
  let deliveries = 0;
  socket.addEventListener("message", (event) => { deliveries++; assert.equal(event.data, packet); });
  socket.dispatchEvent(new MessageEvent("message", { data: packet }));
  assert.equal(deliveries, 1);
  assert.deepEqual(new Uint8Array(packet), before);
  const observed = timing.snapshot().streams["socket-packet"];
  assert.equal(observed.count, 1);
  assert.equal(observed.events[0].sequence, 123);
  assert.equal(observed.events[0].frames, 960);
  assert.equal(observed.events[0].audioTime, 2);
  assert.doesNotMatch(JSON.stringify(timing.snapshot()), /private|secret/);
});

test("port observation preserves transfer overloads, native promises and failures without replay", async () => {
  const timing = createToneTiming();
  const result = Promise.resolve(123), failure = Error("private native failure");
  const calls = [];
  let fail = false;
  class Port extends EventTarget {
    postMessage(...args) {
      calls.push([this, ...args]);
      if (fail) throw failure;
      structuredClone(args[0], Array.isArray(args[1]) ? { transfer: args[1] } : args[1]);
      return result;
    }
  }
  const port = new Port();
  observeTonePort(port, timing, () => ({ audioTime: 1, audioFrame: 48000, rate: 48000 }));
  const samples = new Float32Array(16), message = { type: "samples", samples }, transfer = [samples.buffer];
  assert.equal(port.postMessage(message, transfer), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], port);
  assert.equal(calls[0][1], message);
  assert.equal(calls[0][2], transfer);
  assert.equal(samples.buffer.byteLength, 0, "the native call transferred the original buffer");
  assert.equal(timing.snapshot().streams["worklet-post"].events[0].frames, 8);
  const quiet = { type: "quiet" }, options = { transfer: [] };
  assert.equal(port.postMessage(quiet, options), result);
  assert.equal(calls[1][1], quiet);
  assert.equal(calls[1][2], options);
  fail = true;
  assert.throws(() => port.postMessage({ type: "samples", samples: new Float32Array(16) }), (error) => error === failure);
  assert.equal(calls.length, 3);
  assert.equal(timing.snapshot().streams["worklet-post"].count, 1, "a failed post is not reported as delivered");
  const late = { type: "late", target: 0.14, error: failure };
  let deliveries = 0;
  port.addEventListener("message", (event) => { deliveries++; assert.equal(event.data, late); });
  port.dispatchEvent(new MessageEvent("message", { data: late }));
  assert.equal(deliveries, 1);
  assert.equal(timing.snapshot().streams["worklet-late"].events[0].targetMs, 140);
  assert.doesNotMatch(JSON.stringify(timing.snapshot()), /private native failure/);
  const rejected = Promise.reject(failure), rejectedPort = new Port();
  rejectedPort.postMessage = () => rejected;
  observeTonePort(rejectedPort, timing);
  const returned = rejectedPort.postMessage(quiet);
  assert.equal(returned, rejected);
  await assert.rejects(returned, (error) => error === failure);
});
