import test from "node:test";
import assert from "node:assert/strict";
import {
  adpcmEncoder,
  encodeAdpcm,
  Halver,
  INDEX,
  QUIET,
  SoundHub,
  SoundSource,
  STEPS,
  toMono,
} from "../server/screen-sound.mjs";
import { sweepScreenHelpers } from "../server/screen-stream.mjs";
import { deviceCapabilities } from "../server/capabilities.mjs";

// The computer's sound beside its live screen, the part shared by a Mac and
// a Windows PC: its packets, its lighter tiers, one capture for every phone,
// and when it stops. Fake capture sources: nothing is recorded here.

// The phone's decoder in its simplest form (src/sound-codec.ts is checked
// against this in test/screen-sound-ui.test.mjs).
function decode(packet) {
  const channels = packet[2];
  const frames = packet.readUInt16LE(12);
  const predictor = [], index = [];
  for (let c = 0; c < channels; c++) {
    predictor[c] = packet.readInt16LE(16 + 4 * c);
    index[c] = packet[18 + 4 * c];
  }
  const out = new Int16Array(frames * channels);
  const start = 16 + 4 * channels;
  for (let i = 0; i < out.length; i++) {
    const c = i % channels;
    const nibble = i & 1 ? packet[start + (i >> 1)] >> 4 : packet[start + (i >> 1)] & 15;
    const step = STEPS[index[c]];
    let delta = step >> 3;
    if (nibble & 4) delta += step;
    if (nibble & 2) delta += step >> 1;
    if (nibble & 1) delta += step >> 2;
    predictor[c] = Math.max(-32768, Math.min(32767, predictor[c] + (nibble & 8 ? -delta : delta)));
    index[c] = Math.max(0, Math.min(88, index[c] + INDEX[nibble & 7]));
    out[i] = predictor[c];
  }
  return { channels, frames, rate: packet.readUInt32LE(4), sequence: packet.readUInt32LE(8), flags: packet[3], samples: out };
}
// Harmonics like music's, at -12 dBFS: 20 ms a packet at 48 kHz.
const music = (frame, channel) =>
  Math.round(8000 * [110, 220, 440, 880, 1760].reduce((sum, f, k) => sum + Math.sin((2 * Math.PI * f * frame) / 48000 + k + channel) / (k + 1), 0) / 2.3);
const chunk = (index, channels = 2, frames = 960, wave = music) => {
  const samples = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) samples[i * channels + c] = wave(index * frames + i, c);
  return samples;
};
const snr = (original, decoded) => {
  let signal = 0, noise = 0;
  for (let i = 0; i < original.length; i++) {
    signal += original[i] ** 2;
    noise += (original[i] - decoded[i]) ** 2;
  }
  return 10 * Math.log10(signal / noise);
};

test("a packet says its rate, channels and order, and the samples come back close to what the computer played", () => {
  const encoder = adpcmEncoder(2);
  const packets = [];
  for (let p = 0; p < 50; p++) packets.push([chunk(p), encodeAdpcm(encoder, chunk(p), 48000, p + 1)]);
  const [original, packet] = packets[10];
  // 16 bytes, 4 for each channel's state, half a byte a sample: a quarter
  // of the 16-bit samples, about 394 kbps at 48 kHz stereo.
  assert.equal(packet.length, 16 + 8 + 960);
  const decoded = decode(packet);
  assert.deepEqual([decoded.channels, decoded.frames, decoded.rate, decoded.sequence, decoded.flags], [2, 960, 48000, 11, 0]);
  assert.ok(snr(original, decoded.samples) > 35, `SNR ${snr(original, decoded.samples).toFixed(1)} dB`);
  // Any packet starts on its own: a phone joining late, or one lost on the way.
  for (const [original, packet] of [packets[49], packets[23]])
    assert.ok(snr(original, decode(packet).samples) > 35);
});

test("encoding refuses what isn't a packet's worth of samples", () => {
  assert.throws(() => encodeAdpcm(adpcmEncoder(2), new Int16Array(3), 48000, 1));
  assert.throws(() => encodeAdpcm(adpcmEncoder(1), new Int16Array(0), 48000, 1));
  assert.throws(() => encodeAdpcm(adpcmEncoder(1), new Int16Array(65536), 48000, 1));
});

test("half the rate keeps what's heard, removes what would alias, and never loses a sample's place", () => {
  const level = (frequency) => {
    const halver = new Halver(1);
    let input = 0, output = 0;
    for (let p = 0; p < 30; p++) {
      const samples = chunk(p, 1, 960, (i) => Math.round(16000 * Math.sin((2 * Math.PI * frequency * i) / 48000)));
      const half = halver.push(samples);
      assert.equal(half.length, 480);
      if (p < 2) continue;
      for (const v of samples) input += v * v;
      for (const v of half) output += v * v;
    }
    return 10 * Math.log10(output / 480 / (input / 960));
  };
  assert.ok(Math.abs(level(1000)) < 0.5, `1 kHz: ${level(1000).toFixed(2)} dB`);
  assert.ok(level(18000) < -35, `18 kHz: ${level(18000).toFixed(1)} dB`);
  // Windows' packets come in any size (441 frames at 44.1 kHz): every other
  // sample is kept across them all.
  const halver = new Halver(2);
  let frames = 0;
  for (let p = 0; p < 9; p++) frames += halver.push(new Int16Array(441 * 2)).length / 2;
  assert.equal(frames, Math.ceil((9 * 441) / 2));
  assert.deepEqual([...toMono(Int16Array.from([100, 300, -200, -400]))], [200, -300]);
});

// A socket as the hub sees one.
const socket = () => {
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closed: null,
    send: (m) => ws.sent.push(m),
    close(code) {
      ws.readyState = 3;
      ws.closed = code;
    },
  };
  return ws;
};
const json = (ws) => ws.sent.filter((m) => typeof m === "string").map((m) => JSON.parse(m));
const packets = (ws) => ws.sent.filter((m) => Buffer.isBuffer(m)).map(decode);
const count = (ws) => ws.sent.filter((m) => Buffer.isBuffer(m)).length;
const newest = (ws) => {
  for (let i = ws.sent.length - 1; i >= 0; i--) if (Buffer.isBuffer(ws.sent[i])) return decode(ws.sent[i]);
};
// A capture source the test drives: format, samples, and its end.
function fakeSource() {
  const made = [];
  const prepare = async () => (handlers) => {
    const source = {
      handlers,
      info: null,
      stopped: null,
      format(info) {
        source.info = info;
        handlers.onInfo(info);
      },
      play(samples) {
        handlers.onSamples(samples, source.info);
      },
      stop(error) {
        source.stopped = error;
      },
    };
    made.push(source);
    return source;
  };
  return { made, prepare };
}
const tick = () => new Promise((r) => setImmediate(r));

test("one capture for every phone, started by the first and stopped after the last", async () => {
  const { made, prepare } = fakeSource();
  const hub = new SoundHub(prepare, { log: () => {} });
  const a = socket(), b = socket();
  hub.add(a, () => true);
  await tick();
  assert.equal(made.length, 1);
  // Ready once the computer said its format, not before.
  assert.deepEqual(json(a), []);
  made[0].format({ rate: 48000, channels: 2 });
  assert.deepEqual(json(a), [{ type: "ready", codec: "adpcm" }]);
  hub.add(b, () => true);
  assert.deepEqual(json(b), [{ type: "ready", codec: "adpcm" }]);
  made[0].play(chunk(0));
  made[0].play(chunk(1));
  assert.deepEqual(packets(a).map((p) => p.sequence), [1, 2]);
  assert.deepEqual(packets(b).map((p) => [p.rate, p.channels, p.frames]), [[48000, 2, 960], [48000, 2, 960]]);
  assert.equal(made.length, 1, "the second phone shares the capture");
  hub.remove(a);
  assert.equal(made[0].stopped, null);
  hub.remove(b);
  assert.match(made[0].stopped.message, /Nobody is listening/);
  // The next phone starts a new capture.
  hub.add(socket(), () => true);
  await tick();
  assert.equal(made.length, 2);
});

test("a silent computer sends one quiet packet a second, so the phone knows it's there", async () => {
  let now = 1000;
  const { made, prepare } = fakeSource();
  const hub = new SoundHub(prepare, { now: () => now, log: () => {} });
  const ws = socket();
  hub.add(ws, () => true);
  await tick();
  made[0].format({ rate: 48000, channels: 2 });
  // The phone acknowledges what it hears, quiet packets included.
  const play = (samples) => {
    made[0].play(samples);
    const last = newest(ws);
    if (last) hub.ack(ws, last.sequence);
    now += 20;
  };
  for (let i = 0; i < 100; i++) play(new Int16Array(1920));
  const quiet = packets(ws);
  assert.equal(quiet.length, 2, "two seconds of silence, two packets");
  assert.ok(quiet.every((p) => p.flags === QUIET));
  play(chunk(0));
  assert.deepEqual([count(ws), newest(ws).flags], [3, 0], "sound goes at once");
  // Falling silent is said at once, not a second later: the phone's queue
  // then runs dry as silence, not as a late link.
  play(new Int16Array(1920));
  assert.deepEqual([count(ws), newest(ws).flags], [4, QUIET]);
  play(new Int16Array(1920));
  assert.equal(count(ws), 4, "then once a second");
  hub.stop();
});

test("Windows sends nothing while the PC is silent: Reach fills a quiet second itself", { timeout: 5000 }, async () => {
  const { made, prepare } = fakeSource();
  const hub = new SoundHub(prepare, { log: () => {} });
  const ws = socket();
  hub.add(ws, () => true);
  await tick();
  made[0].format({ rate: 44100, channels: 2 });
  await new Promise((r) => setTimeout(r, 2300));
  const quiet = packets(ws);
  assert.ok(quiet.length >= 1 && quiet.every((p) => p.flags === QUIET), JSON.stringify(quiet.map((p) => p.flags)));
  assert.equal(quiet[0].rate, 44100);
  hub.stop();
});

test("a link that backs up gets lighter sound, then skips, then full sound back once it keeps up", async () => {
  let now = 0;
  const { made, prepare } = fakeSource();
  const hub = new SoundHub(prepare, { now: () => now, log: () => {} });
  const ws = socket();
  hub.add(ws, () => true);
  await tick();
  made[0].format({ rate: 48000, channels: 2 });
  const sound = chunk(3);
  const play = (ms, ack = true) => {
    for (let t = 0; t < ms; t += 20) {
      made[0].play(sound);
      const last = newest(ws);
      if (ack && last) hub.ack(ws, last.sequence);
      now += 20;
    }
  };
  play(2000);
  assert.deepEqual(newest(ws).rate, 48000);
  // Nothing acknowledged: after a second the phone's packets wait, and the
  // next seconds step it down: half the rate, then mono.
  const before = count(ws);
  play(3000, false);
  const sent = count(ws) - before;
  assert.ok(sent < 80, `${sent} packets sent unacknowledged in 3 s`);
  assert.equal(json(ws).some((m) => m.type === "error"), false);
  // It catches up: what it hears is lighter, and after 8 good seconds per
  // step it is back at full rate.
  play(1000);
  const light = newest(ws);
  assert.deepEqual([light.rate, light.channels], [24000, 1]);
  play(20000);
  const full = newest(ws);
  assert.deepEqual([full.rate, full.channels], [48000, 2]);
  hub.stop();
});

test("a phone that stops acknowledging for 10 s is let go, to reconnect", async () => {
  let now = 0;
  const { made, prepare } = fakeSource();
  const hub = new SoundHub(prepare, { now: () => now, log: () => {} });
  const ws = socket();
  hub.add(ws, () => true);
  await tick();
  made[0].format({ rate: 48000, channels: 2 });
  for (let t = 0; t <= 10100 && ws.readyState === 1; t += 20) {
    made[0].play(chunk(t / 20));
    now += 20;
  }
  const error = json(ws).find((m) => m.type === "error");
  assert.deepEqual([error.retryable, ws.closed], [true, 1012]);
  assert.match(made[0].stopped.message, /Nobody/);
});

test("pausing ends every phone's sound for a while, and the capture with it", async () => {
  const { made, prepare } = fakeSource();
  const hub = new SoundHub(prepare, { log: () => {} });
  const a = socket(), b = socket();
  hub.add(a, () => true);
  hub.add(b, () => true);
  await tick();
  made[0].format({ rate: 48000, channels: 2 });
  hub.stop("Reach is paused on this Mac.", true);
  for (const ws of [a, b]) {
    assert.deepEqual(json(ws).at(-1), { type: "error", error: "Reach is paused on this Mac.", retryable: true, status: 503 });
    assert.equal(ws.closed, 1012);
  }
  assert.ok(made[0].stopped);
  assert.equal(hub.size, 0);
});

test("access that ends mid-sound ends that phone's sound, not another's", async () => {
  const { made, prepare } = fakeSource();
  const hub = new SoundHub(prepare, { log: () => {} });
  let allowed = true;
  const a = socket(), b = socket();
  hub.add(a, () => allowed);
  hub.add(b, () => true);
  await tick();
  made[0].format({ rate: 48000, channels: 2 });
  made[0].play(chunk(0));
  allowed = false;
  made[0].play(chunk(1));
  assert.deepEqual([packets(a).length, packets(b).length], [1, 2]);
  assert.equal(hub.size, 1);
  assert.equal(made[0].stopped, null);
});

test("a capture that stops says why: retried after a hiccup, not after a refusal", async () => {
  const { made, prepare } = fakeSource();
  const logged = [];
  const hub = new SoundHub(prepare, { log: (m) => logged.push(m) });
  const a = socket();
  hub.add(a, () => true);
  await tick();
  made[0].handlers.onEnd(Error("The PC's sound output changed. Reconnecting."));
  assert.deepEqual(json(a).at(-1), { type: "error", error: "The PC's sound output changed. Reconnecting.", retryable: true, status: 503 });
  const b = socket();
  hub.add(b, () => true);
  await tick();
  made[1].handlers.onEnd(Object.assign(Error("Screen Recording is off for Terminal."), { permanent: true }));
  assert.deepEqual([json(b).at(-1).retryable, b.closed], [false, 4003]);
  assert.equal(logged.length, 2, "the computer's own trouble lands in Reach's log");
});

test("a helper that can't be prepared says why once, without retrying", async () => {
  const hub = new SoundHub(async () => {
    throw Object.assign(Error("This needs Apple's Command Line Tools."), { status: 503 });
  }, { log: () => {} });
  const ws = socket();
  hub.add(ws, () => true);
  await tick();
  assert.deepEqual(json(ws), [{ type: "error", error: "This needs Apple's Command Line Tools.", retryable: false, status: 503 }]);
});

test("four phones at most, as for the screen", async () => {
  const { prepare } = fakeSource();
  const hub = new SoundHub(prepare, { log: () => {} });
  for (let i = 0; i < 4; i++) hub.add(socket(), () => true);
  assert.throws(() => hub.add(socket(), () => true), (e) => e.status === 429);
  hub.stop();
});

test("the helper's packets are read whole, however the pipe cuts them, and a bad one ends it", async () => {
  // A stand-in helper: the format, two packets of samples cut into odd
  // pieces, then a packet of an unknown kind.
  const script = `
    const out = (kind, body) => { const head = Buffer.alloc(5); head.writeUInt32BE(body.length + 1); head[4] = kind.charCodeAt(0); return Buffer.concat([head, body]); };
    const pcm = Buffer.alloc(960 * 4); for (let i = 0; i < 1920; i++) pcm.writeInt16LE(i - 960, i * 2);
    const all = Buffer.concat([out("i", Buffer.from(JSON.stringify({ rate: 48000, channels: 2 }))), out("p", pcm), out("p", pcm), out("x", Buffer.alloc(1))]);
    let at = 0; const next = () => { if (at >= all.length) return setTimeout(() => {}, 5000); process.stdout.write(all.subarray(at, at += 777)); setTimeout(next, 2); }; next();`;
  const seen = [];
  const ended = new Promise((resolve) => {
    new SoundSource(process.execPath, ["-e", script], {
      onInfo: (info) => seen.push(info),
      onSamples: (samples) => seen.push([samples.length, samples[0], samples[1919]]),
      onEnd: resolve,
    });
  });
  const error = await ended;
  assert.deepEqual(seen, [{ rate: 48000, channels: 2 }, [1920, -960, 959], [1920, -960, 959]]);
  assert.match(error.message, /Invalid sound packet/);
});

test("a helper that refuses says its own last line", async () => {
  const error = await new Promise((resolve) => {
    new SoundSource(process.execPath, ["-e", "console.error('starting'); console.error('This PC has no sound output for Reach to hear.'); process.exit(1)"], { onEnd: resolve });
  });
  assert.equal(error.message, "This PC has no sound output for Reach to hear.");
  assert.equal(error.permanent, undefined);
});

test("a sound helper an earlier Reach left running is ended with the screen's", () => {
  const ended = [];
  sweepScreenHelpers({
    dataDir: "/data",
    self: 10,
    platform: "darwin",
    table: () => [
      { pid: 20, ppid: 1, command: "/data/reach-screen-sound-abc123def456" },
      { pid: 21, ppid: 1, command: "/data/reach-screen-stream-abc123def456 primary h264" },
      { pid: 22, ppid: 10, command: "/data/reach-screen-sound-abc123def456" },
      { pid: 23, ppid: 1, command: "/other/reach-screen-sound-abc123def456" },
    ],
    kill: (pid) => ended.push(pid),
  });
  assert.deepEqual(ended, [20, 21]);
});

test("only you and people with full access can hear it, on a Mac or a PC with its screen on", () => {
  const scopes = ["device", "screen", "screen:control"];
  const sound = (platform, owner, screen = true) => deviceCapabilities({ platform, scopes, screen, codexInstalled: false, owner }).sound;
  assert.equal(sound("darwin", true), true);
  assert.equal(sound("win32", true), true);
  assert.equal(sound("darwin", false), false, "a person with less access");
  assert.equal(sound("darwin", true, false), false, "screen viewing off");
  assert.equal(sound("linux", true), false);
  assert.equal(deviceCapabilities({ platform: "darwin", scopes: ["device", "files:read"], screen: true, owner: true }).sound, false);
});
