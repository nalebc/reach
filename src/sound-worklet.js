// Plays the computer's sound on the phone, fed by src/useScreenSound.ts with
// stereo samples at the phone's own rate. A short queue, a tenth of a second
// to start: playing begins once that much is here. Running dry fades out and
// waits for that much again, a little longer each time the link was late
// (never for a computer that went silent). A burst after a stall drops the
// oldest back to the queue's length. Late sound is worse than a skip.
// Plain JavaScript with no imports: an audio worklet loads on its own.
const SECONDS = 2;
class ReachSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * SECONDS);
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.read = 0;
    this.count = 0;
    this.min = Math.round(sampleRate * 0.06);
    this.max = Math.round(sampleRate * 0.4);
    this.target = Math.round(sampleRate * 0.1);
    this.playing = false;
    // Fades in over 5 ms after a start or a skip, so neither clicks.
    this.gain = 0;
    this.ramp = 1 / Math.round(sampleRate * 0.005);
    // The computer went silent: running dry then is no fault of the link.
    this.quiet = false;
    this.calmSince = currentTime;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "samples") this.push(data.samples);
      else if (data?.type === "quiet") this.quiet = true;
      else if (data?.type === "clear") {
        this.count = 0;
        this.playing = false;
      }
    };
  }
  push(samples) {
    this.quiet = false;
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      const at = (this.read + this.count) % this.size;
      this.left[at] = samples[2 * i];
      this.right[at] = samples[2 * i + 1];
      if (this.count < this.size) this.count++;
      else this.read = (this.read + 1) % this.size;
    }
    if (this.playing && this.count > this.target + Math.round(sampleRate * 0.25)) {
      const drop = this.count - this.target;
      this.read = (this.read + drop) % this.size;
      this.count -= drop;
      this.gain = 0;
    }
  }
  // Twenty calm seconds take 20 ms off the queue, down to 60 ms.
  relax() {
    if (currentTime - this.calmSince < 20) return;
    this.calmSince = currentTime;
    this.target = Math.max(this.min, this.target - Math.round(sampleRate * 0.02));
  }
  process(_inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    const n = left.length;
    if (!this.playing) {
      if (this.count < this.target) {
        left.fill(0);
        right.fill(0);
        this.relax();
        return true;
      }
      this.playing = true;
      this.gain = 0;
    }
    const have = Math.min(n, this.count);
    for (let i = 0; i < have; i++) {
      if (this.gain < 1) this.gain = Math.min(1, this.gain + this.ramp);
      // Not enough for this block: what is here fades out to silence.
      const g = have < n ? (this.gain * (have - i)) / have : this.gain;
      left[i] = this.left[this.read] * g;
      right[i] = this.right[this.read] * g;
      this.read = (this.read + 1) % this.size;
    }
    this.count -= have;
    if (have < n) {
      left.fill(0, have);
      right.fill(0, have);
      this.playing = false;
      if (!this.quiet) {
        this.target = Math.min(this.max, this.target + Math.round(sampleRate * 0.04));
        this.port.postMessage({ type: "late", target: this.target / sampleRate });
      }
      this.calmSince = currentTime;
    } else this.relax();
    return true;
  }
}
registerProcessor("reach-sound", ReachSound);
