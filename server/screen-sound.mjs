import { spawn } from "node:child_process";
import { fail } from "./core.mjs";
import { permissionHint } from "./screen-stream.mjs";
import { screenTrouble } from "./remote-screen.mjs";

// The computer's sound on the phones that listen beside its live screen
// (Screen's speaker). What the computer plays, never its microphone: its
// helper (scripts/native/screen-sound.swift on a Mac, screen-sound.cs on
// Windows) sends 16-bit samples over a pipe; everything after that is the
// same on both, here: one capture for every phone, each phone's own
// connection (/ws/screen-sound, never behind a video frame), compressed to
// IMA ADPCM (a quarter of the samples' size, decoded by any phone browser),
// and lighter on a slow link instead of late.

// Each packet is 20 ms (a Mac's own buffers are; Windows' are cut to it).
export const PACKET_MS = 20;
const MAX_PACKET = 1024 * 1024;
const KILL_AFTER_MS = 5000;
const PERMISSION = /Screen Recording/i;

// The helper's packets: a 4-byte big-endian length, then "i" and JSON
// {rate, channels} whenever the format is new, or "p" and 16-bit
// little-endian samples, interleaved.
export class SoundSource {
  constructor(executable, args = [], { onInfo, onSamples, onEnd } = {}) {
    Object.assign(this, { onInfo, onSamples, onEnd });
    this.failure = null;
    this.info = null;
    this.buffer = Buffer.alloc(0);
    this.child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let said = "";
    this.child.stderr.on("data", (b) => {
      said = (said + b.toString()).slice(-4096);
    });
    this.child.stdin.on("error", () => this.stop(Error("Sound capture disconnected.")));
    this.child.on("error", () => this.stop(Error("Could not start sound capture.")));
    // Once its pipes are read to the end, so its last packets and last
    // words aren't lost to an exit noticed first.
    this.child.on("close", () => {
      const text = said.trim().split(/\r?\n/).pop() || "";
      const denied = PERMISSION.test(text) && process.platform === "darwin";
      const error = Error((denied ? permissionHint() : text) || "Sound capture stopped.");
      if (denied) error.permanent = true;
      this.stop(error);
    });
    this.child.stdout.on("data", (chunk) => {
      if (this.failure) return;
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (!length || length > MAX_PACKET) return this.stop(Error("Invalid sound packet."));
        if (this.buffer.length < length + 4) return;
        const kind = this.buffer[4];
        const body = this.buffer.subarray(5, length + 4);
        this.buffer = this.buffer.subarray(length + 4);
        if (kind === 0x69) {
          let info;
          try {
            info = JSON.parse(body.toString());
          } catch {}
          const { rate, channels } = info || {};
          if (!Number.isInteger(rate) || rate < 8000 || rate > 384000 || ![1, 2].includes(channels))
            return this.stop(Error("The computer's sound came in a format Reach can't read."));
          this.info = { rate, channels };
          this.onInfo?.(this.info);
        } else if (kind === 0x70) {
          if (!this.info || body.length % (2 * this.info.channels))
            return this.stop(Error("Invalid sound packet."));
          // A copy: the pipe's buffer is reused for what comes next.
          const samples = new Int16Array(body.length / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = body.readInt16LE(i * 2);
          this.onSamples?.(samples, this.info);
        } else return this.stop(Error("Invalid sound packet."));
      }
    });
  }
  stop(error = Error("Sound capture stopped.")) {
    if (this.failure) return;
    this.failure = error;
    this.buffer = Buffer.alloc(0);
    this.child.stdin.destroy();
    this.child.kill();
    // A helper that doesn't stop its capture in time is ended outright, as
    // the screen helper is: no capture outlives the phones it was for.
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const force = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      }, KILL_AFTER_MS);
      force.unref?.();
      this.child.once("exit", () => clearTimeout(force));
    }
    this.onEnd?.(error);
  }
}

// IMA ADPCM, 4 bits a sample. Every packet carries each channel's state at
// its start, so a phone can begin with any packet, and one lost on the way
// costs only its own 20 ms (src/sound-codec.ts decodes it).
export const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
export const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
export const HEADER = 16;
export const CODEC_ADPCM = 1;
export const adpcmEncoder = (channels) => ({
  channels,
  predictor: new Int32Array(channels),
  index: new Int32Array(channels),
});
// One packet: 16 bytes (version 1, codec, channels, flags, rate, sequence,
// frames), each channel's predictor and step index, then the samples'
// nibbles in order (frame by frame, channel by channel), low nibble first.
// Flag 1: the computer is silent (a packet that only says it's there).
export const QUIET = 1;
export function encodeAdpcm(encoder, samples, rate, sequence) {
  const { channels } = encoder;
  const frames = samples.length / channels;
  if (!Number.isInteger(frames) || frames < 1 || frames > 65535) throw Error("Bad sound frame count.");
  const packet = Buffer.alloc(HEADER + 4 * channels + Math.ceil((frames * channels) / 2));
  packet[0] = 1;
  packet[1] = CODEC_ADPCM;
  packet[2] = channels;
  packet.writeUInt32LE(rate, 4);
  packet.writeUInt32LE(sequence >>> 0, 8);
  packet.writeUInt16LE(frames, 12);
  for (let c = 0; c < channels; c++) {
    packet.writeInt16LE(encoder.predictor[c], HEADER + 4 * c);
    packet[HEADER + 4 * c + 2] = encoder.index[c];
  }
  let at = HEADER + 4 * channels;
  for (let i = 0; i < samples.length; i++) {
    const c = i % channels;
    let predictor = encoder.predictor[c];
    let index = encoder.index[c];
    let step = STEPS[index];
    let diff = samples[i] - predictor;
    let nibble = 0;
    if (diff < 0) {
      nibble = 8;
      diff = -diff;
    }
    let delta = step >> 3;
    if (diff >= step) {
      nibble |= 4;
      diff -= step;
      delta += step;
    }
    step >>= 1;
    if (diff >= step) {
      nibble |= 2;
      diff -= step;
      delta += step;
    }
    step >>= 1;
    if (diff >= step) {
      nibble |= 1;
      delta += step;
    }
    predictor += nibble & 8 ? -delta : delta;
    encoder.predictor[c] = predictor > 32767 ? 32767 : predictor < -32768 ? -32768 : predictor;
    index += INDEX[nibble & 7];
    encoder.index[c] = index < 0 ? 0 : index > 88 ? 88 : index;
    if (i & 1) packet[at++] |= nibble << 4;
    else packet[at] = nibble;
  }
  return packet;
}

// Half the rate: a 15-tap half-band low-pass (Hann-windowed), then every
// other sample. Its history carries over from one packet to the next, so
// the joins can't click.
const TAPS = (() => {
  const taps = [];
  for (let n = -7; n <= 7; n++) {
    const ideal = n === 0 ? 0.5 : Math.sin((Math.PI * n) / 2) / (Math.PI * n);
    taps.push(ideal * 0.5 * (1 + Math.cos((Math.PI * n) / 8)));
  }
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map((t) => t / sum);
})();
export class Halver {
  constructor(channels) {
    this.channels = channels;
    // The last 14 samples of each channel, and whether the next one is kept.
    this.history = Array.from({ length: channels }, () => new Float64Array(14));
    this.odd = false;
  }
  push(samples) {
    const { channels } = this;
    const frames = samples.length / channels;
    const kept = [];
    let odd = this.odd;
    for (let i = 0; i < frames; i++) {
      if (!odd) kept.push(i);
      odd = !odd;
    }
    const out = new Int16Array(kept.length * channels);
    for (let c = 0; c < channels; c++) {
      const line = new Float64Array(14 + frames);
      line.set(this.history[c]);
      for (let i = 0; i < frames; i++) line[14 + i] = samples[i * channels + c];
      // Output k is centered 7 samples back: a fixed delay of 7 input samples.
      kept.forEach((i, k) => {
        let sum = 0;
        for (let t = 0; t < 15; t++) sum += TAPS[t] * line[i + t];
        out[k * channels + c] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : Math.round(sum);
      });
      this.history[c] = line.slice(frames, frames + 14);
    }
    this.odd = odd;
    return out;
  }
}
export function toMono(samples) {
  const out = new Int16Array(samples.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (samples[2 * i] + samples[2 * i + 1]) >> 1;
  return out;
}

// What a phone gets, lightest last: the computer's own rate (at most
// 48 kHz) in stereo, about 384 kbps; half the rate, 192; half in mono, 96.
// A struggling link steps down after a second, a healthy one back up after
// eight: sound stays prompt rather than complete.
export const TIERS = 3;
const UP_AFTER_S = 8;
// The oldest packet a phone hasn't acknowledged: past this age the link is
// backed up and that phone's packets are skipped. A far link's round trip
// alone (a relay, 300–500 ms) stays under it.
const BACKED_UP_MS = 1000;
// A round trip this far above the link's own best of the last 10 s means a
// queue is growing: a lighter tier, before anything has to be skipped.
const QUEUE_MS = 250;
const BUFFERED_BYTES = 32 * 1024;
// A quiet computer sends one packet a second, so both sides know it's there,
// and one at once when it falls silent: the phone then knows a queue that
// runs dry is silence, not a late link.
const KEEPALIVE_MS = 1000;
const STALLED_MS = 10000;
export class SoundHub {
  constructor(prepare, { now = Date.now, log = screenTrouble } = {}) {
    this.prepare = prepare;
    this.now = now;
    this.log = log;
    this.listeners = new Map();
    this.generation = 0;
    this.source = null;
    this.sequence = 0;
    // Per tier: its rate stage, encoder and the format it last saw.
    this.tiers = [];
    this.adjustedAt = 0;
    // When the helper last sent samples: Windows sends none while the PC
    // is silent, so a quiet second is filled here, the same for both.
    this.heardAt = 0;
    this.filler = null;
  }
  get size() {
    return this.listeners.size;
  }
  add(ws, authorize) {
    if (this.listeners.has(ws)) return;
    if (this.listeners.size >= 4) throw fail(429, "Four phones are already listening.");
    this.listeners.set(ws, {
      authorize,
      tier: 0,
      // Sequence → when it went, oldest first.
      inFlight: new Map(),
      rtt: 0,
      base: 0,
      baseAt: 0,
      dropped: false,
      healthy: 0,
      sentAt: 0,
      // Whether the last packet it got said the computer is silent.
      quiet: false,
      ready: false,
    });
    if (this.listeners.size === 1) void this.start();
    else if (this.source?.info) this.ready(ws);
  }
  ready(ws) {
    const listener = this.listeners.get(ws);
    if (!listener || listener.ready || ws.readyState !== 1) return;
    listener.ready = true;
    ws.send(JSON.stringify({ type: "ready", codec: "adpcm" }));
  }
  ack(ws, sequence) {
    const l = this.listeners.get(ws);
    if (!l || !Number.isInteger(sequence)) throw fail(400, "Invalid sound acknowledgment.");
    const sent = l.inFlight.get(sequence);
    if (sent !== undefined) {
      const now = this.now();
      const sample = now - sent;
      l.rtt = l.rtt ? l.rtt * 0.8 + sample * 0.2 : sample;
      if (!l.baseAt || sample < l.base || now - l.baseAt > 10000) {
        l.base = sample;
        l.baseAt = now;
      }
    }
    for (const seq of l.inFlight.keys()) if (seq <= sequence) l.inFlight.delete(seq);
  }
  remove(ws) {
    if (!this.listeners.delete(ws)) return;
    if (!this.listeners.size) this.halt();
  }
  halt() {
    this.generation++;
    clearInterval(this.filler);
    const source = this.source;
    this.source = null;
    this.tiers = [];
    source?.stop(Error("Nobody is listening."));
  }
  fail(ws, message, retryable = true, status = retryable ? 503 : 403) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", error: message, retryable, status }));
      ws.close(retryable ? 1012 : 4003, "Sound ended");
    }
    this.remove(ws);
  }
  stop(message = "Sound is off.", retryable = false) {
    for (const ws of [...this.listeners.keys()]) this.fail(ws, message, retryable);
    this.halt();
  }
  async start() {
    const generation = ++this.generation;
    try {
      const factory = await this.prepare();
      if (generation !== this.generation || !this.listeners.size) return;
      for (const [ws, l] of this.listeners) if (!l.authorize()) this.remove(ws);
      if (!this.listeners.size || generation !== this.generation) return;
      this.source = factory({
        onInfo: () => {
          if (generation !== this.generation) return;
          this.tiers = [];
          for (const ws of this.listeners.keys()) this.ready(ws);
        },
        onSamples: (samples, info) => {
          if (generation !== this.generation) return;
          this.heardAt = this.now();
          // Never thrown into the pipe's handler: that would end Reach.
          try {
            this.deliver(samples, info);
          } catch (e) {
            this.source?.stop(Error(`Sound couldn't be sent: ${e.message}`));
          }
        },
        onEnd: (error) => {
          if (generation !== this.generation) return;
          this.generation++;
          clearInterval(this.filler);
          this.source = null;
          if (!this.listeners.size || error.message === "Nobody is listening.") return;
          this.log(error.message);
          for (const ws of [...this.listeners.keys()]) this.fail(ws, error.message, !error.permanent);
        },
      });
      this.heardAt = this.now();
      clearInterval(this.filler);
      this.filler = setInterval(() => {
        const info = this.source?.info;
        if (generation !== this.generation || !info || this.now() - this.heardAt < KEEPALIVE_MS) return;
        try {
          this.deliver(new Int16Array(Math.round(info.rate / 50) * info.channels), info);
        } catch {}
      }, KEEPALIVE_MS);
      this.filler.unref?.();
    } catch (e) {
      if (generation !== this.generation) return;
      if (!e.status || e.status >= 500) this.log(e.message);
      // A helper that couldn't be prepared (no developer tools, a policy
      // refusing the compiler) won't be by trying again: the phone says why
      // and the owner taps again once it's fixed.
      for (const ws of [...this.listeners.keys()]) this.fail(ws, e.message, false, e.status || 503);
    }
  }
  // One stage per tier, made when a tier is first wanted after the format
  // changed: the computer's rate brought to at most 48 kHz, then halved for
  // tiers 1 and 2, mono for 2.
  tier(n, info) {
    if (this.tiers[n]) return this.tiers[n];
    const halvers = [];
    let rate = info.rate;
    while (rate > 48000) {
      halvers.push(new Halver(info.channels));
      rate /= 2;
    }
    if (n > 0) {
      halvers.push(new Halver(info.channels));
      rate /= 2;
    }
    const mono = n === 2 || info.channels === 1;
    const stage = {
      rate: Math.round(rate),
      halvers,
      mono,
      encoder: adpcmEncoder(mono ? 1 : 2),
      fromStereo: info.channels === 2,
    };
    this.tiers[n] = stage;
    return stage;
  }
  // Each tier's stage takes every packet, wanted or not, so its filters
  // and encoder never jump; packets go only to phones that can take them.
  deliver(samples, info) {
    const now = this.now();
    if (now - this.adjustedAt >= 1000) this.adjust(now);
    const quiet = !samples.some((v) => v !== 0);
    const sequence = ++this.sequence;
    const packets = [];
    for (let n = 0; n < TIERS; n++) {
      if (!this.tiers[n] && ![...this.listeners.values()].some((l) => l.tier === n)) continue;
      const stage = this.tier(n, info);
      let out = samples;
      for (const halver of stage.halvers) out = halver.push(out);
      if (stage.mono && stage.fromStereo) out = toMono(out);
      packets[n] = out.length ? encodeAdpcm(stage.encoder, out, stage.rate, sequence) : null;
      if (quiet && packets[n]) packets[n][3] = QUIET;
    }
    for (const [ws, l] of this.listeners) {
      if (!l.authorize() || ws.readyState !== 1) {
        this.remove(ws);
        continue;
      }
      if (!l.ready) continue;
      const oldest = l.inFlight.values().next().value;
      if (oldest !== undefined && now - oldest > STALLED_MS) {
        this.fail(ws, "Sound stopped reaching this phone. Reconnecting…");
        continue;
      }
      const packet = packets[l.tier];
      if (!packet || (quiet && l.quiet && now - l.sentAt < KEEPALIVE_MS)) continue;
      if ((oldest !== undefined && now - oldest > BACKED_UP_MS) || ws.bufferedAmount > BUFFERED_BYTES) {
        l.dropped = true;
        continue;
      }
      l.inFlight.set(sequence, now);
      l.sentAt = now;
      l.quiet = quiet;
      ws.send(packet);
    }
  }
  // Once a second: a phone that had to skip, or whose link is queueing,
  // steps down a tier now; one that took everything for eight seconds steps
  // back up.
  adjust(now) {
    this.adjustedAt = now;
    for (const l of this.listeners.values()) {
      if (l.dropped || (l.base && l.rtt - l.base > QUEUE_MS)) {
        l.tier = Math.min(TIERS - 1, l.tier + 1);
        l.healthy = 0;
      } else if (l.tier > 0 && ++l.healthy >= UP_AFTER_S) {
        l.tier--;
        l.healthy = 0;
      }
      l.dropped = false;
    }
  }
}

// What prepares the helper on this computer: a Mac's ScreenCaptureKit one,
// or Windows' loopback one, each built on first use like the other helpers.
export function soundPreparer(config, { platform = process.platform, desktopBinary, windowsBinary }) {
  return async () => {
    let executable;
    if (platform === "darwin") executable = await desktopBinary(config, "screen-sound");
    else if (platform === "win32") executable = await windowsBinary(config, "screen-sound");
    else throw fail(501, "Sound comes from a Mac or a Windows PC.");
    return (handlers) => new SoundSource(executable, [], handlers);
  };
}
