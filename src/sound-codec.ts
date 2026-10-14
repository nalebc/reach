// The computer's sound as it arrives (server/screen-sound.mjs encodes it):
// IMA ADPCM packets, each with its channels' state at its start, so any
// packet decodes on its own and a lost one costs only its 20 ms.
const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const HEADER = 16;

export type SoundPacket = {
  rate: number;
  channels: number;
  sequence: number;
  // The computer is silent: this packet only says it's still there.
  quiet: boolean;
  // Interleaved, -1 to 1.
  samples: Float32Array;
};

// null for anything that isn't a packet this phone can play.
export function decodeSoundPacket(data: ArrayBuffer): SoundPacket | null {
  if (data.byteLength < HEADER) return null;
  const view = new DataView(data);
  const channels = view.getUint8(2);
  if (view.getUint8(0) !== 1 || view.getUint8(1) !== 1 || (channels !== 1 && channels !== 2)) return null;
  const rate = view.getUint32(4, true);
  const sequence = view.getUint32(8, true);
  const frames = view.getUint16(12, true);
  const start = HEADER + 4 * channels;
  const count = frames * channels;
  if (rate < 8000 || rate > 48000 || !frames || data.byteLength < start + Math.ceil(count / 2)) return null;
  const predictor = [0, 0];
  const index = [0, 0];
  for (let c = 0; c < channels; c++) {
    predictor[c] = view.getInt16(HEADER + 4 * c, true);
    index[c] = Math.min(88, view.getUint8(HEADER + 4 * c + 2));
  }
  const bytes = new Uint8Array(data, start);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const c = channels === 2 ? i & 1 : 0;
    const nibble = i & 1 ? bytes[i >> 1] >> 4 : bytes[i >> 1] & 15;
    const step = STEPS[index[c]];
    let delta = step >> 3;
    if (nibble & 4) delta += step;
    if (nibble & 2) delta += step >> 1;
    if (nibble & 1) delta += step >> 2;
    let value = predictor[c] + (nibble & 8 ? -delta : delta);
    value = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
    predictor[c] = value;
    const next = index[c] + INDEX[nibble & 7];
    index[c] = next < 0 ? 0 : next > 88 ? 88 : next;
    samples[i] = value / 32768;
  }
  return { rate, channels, sequence, quiet: (view.getUint8(3) & 1) === 1, samples };
}

// To the phone's own rate (48 kHz, 44.1, or whatever its headphones run
// at), always stereo. Linear, with its place carried from one packet to the
// next, so the joins never click.
export class Resampler {
  // Where the next output falls, in the coming packet's samples: -1 to 0 is
  // between the last packet's final sample and this one's first.
  private position = 0;
  private last = [0, 0];
  private from = 0;
  private to = 0;
  push(samples: Float32Array, channels: number, from: number, to: number): Float32Array {
    const frames = samples.length / channels;
    if (from !== this.from || to !== this.to) {
      this.from = from;
      this.to = to;
      this.position = 0;
    }
    const at = (i: number, c: number) =>
      i < 0 ? this.last[c] : samples[i * channels + (channels === 2 ? c : 0)];
    const ratio = from / to;
    const out = new Float32Array(2 * Math.ceil((frames - this.position) / ratio + 1));
    let n = 0;
    let position = this.position;
    if (from === to && position === 0) {
      for (let i = 0; i < frames; i++) {
        out[n++] = at(i, 0);
        out[n++] = at(i, 1);
      }
      position = frames;
    } else {
      for (; position < frames - 1; position += ratio) {
        const i = Math.floor(position);
        const f = position - i;
        for (let c = 0; c < 2; c++) {
          const a = at(i, c);
          out[n++] = a + (at(i + 1, c) - a) * f;
        }
      }
    }
    this.position = position - frames;
    this.last = [at(frames - 1, 0), at(frames - 1, 1)];
    return out.subarray(0, n);
  }
}
