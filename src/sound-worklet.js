// Plays the computer's sound on the phone, fed by src/useScreenSound.ts with
// stereo samples at the phone's own rate. Start with 100ms, then learn jitter
// from both media frames and arrival clocks. After a drain, that media clock
// can resume a partial refill without waiting for another whole packet batch.
// The target stays within 60–400ms; a saturated target needs a full refill.
// Intentional silence is not lateness. A burst trims old sound as before:
// late sound is worse than a skip. The target is not an end-to-end delay cap.
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
    this.recovering = false;
    this.resumeAt = undefined;
    this.calmSince = currentTime;
    this.base = this.target;
    this.floor = this.target;
    this.started = false;
    this.mediaFrames = 0;
    this.envelope = false;
    this.low = 0;
    this.high = 0;
    this.envelopeAt = currentTime;
    this.rawTarget = this.target;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "samples") this.push(data.samples);
      else if (data?.type === "quiet") {
        this.quiet = true;
        this.recovering = false;
        this.resumeAt = undefined;
        this.floor = this.target;
        this.mediaFrames = this.count;
        this.envelope = false;
        this.rawTarget = this.target;
      } else if (data?.type === "clear") {
        this.count = 0;
        this.playing = false;
        this.recovering = false;
        this.resumeAt = undefined;
        this.floor = this.target;
        this.mediaFrames = this.count;
        this.envelope = false;
        this.rawTarget = this.target;
      }
    };
  }
  // Fixed 20s blocks bound timing history with scalar state, no per-packet log.
  // Reanchor after a trim or intentional reset so discarded/idle media cannot
  // be learned as jitter. Keep the learned target until its normal decay.
  anchor() {
    this.mediaFrames = this.count;
    this.low = this.high = currentTime - this.mediaFrames / sampleRate;
    this.envelopeAt = currentTime;
    this.envelope = true;
    this.floor = Math.max(this.floor, this.target);
    this.rawTarget = this.target;
    this.deadline();
  }
  expire() {
    if (this.envelope && currentTime - this.envelopeAt >= 20) this.anchor();
  }
  // mediaFrames - count is the consumed media position, including old frames
  // discarded by the ring. low is its earliest observed transit in seconds.
  deadline() {
    this.resumeAt = this.envelope && this.recovering
      ? this.low + (this.mediaFrames - this.count + this.target) / sampleRate
      : undefined;
  }
  // Long stalls can exceed the finite delay budget. At the cap, an elapsed
  // clock cannot replace the full target of actual media.
  partialReady() {
    return this.recovering && this.envelope && this.target < this.max && this.rawTarget <= this.max &&
      this.count >= this.min && this.resumeAt !== undefined && currentTime >= this.resumeAt;
  }
  push(samples) {
    const frames = samples.length >> 1;
    if (!frames) return;
    const priorTarget = this.target;
    this.expire();
    if (this.envelope) this.mediaFrames += frames;
    this.quiet = false;
    let overflow = false;
    for (let i = 0; i < frames; i++) {
      const at = (this.read + this.count) % this.size;
      this.left[at] = samples[2 * i];
      this.right[at] = samples[2 * i + 1];
      if (this.count < this.size) this.count++;
      else { this.read = (this.read + 1) % this.size; overflow = true; }
    }
    // Preserve the original prior-target freshness trigger before learning.
    if (this.playing && this.count > priorTarget + Math.round(sampleRate * 0.25)) {
      const drop = this.count - priorTarget;
      this.read = (this.read + drop) % this.size;
      this.count -= drop;
      this.gain = 0;
      this.target = priorTarget;
      if (this.started) this.anchor();
      return;
    }
    if (overflow) {
      // Discarded ring lead is a new media epoch, not transit jitter.
      if (this.started && (this.playing || this.recovering)) this.anchor();
      else this.mediaFrames = this.count;
      this.deadline();
      return;
    }
    if (this.started && (this.playing || this.recovering)) {
      if (!this.envelope) this.anchor();
      else {
        const transit = currentTime - this.mediaFrames / sampleRate;
        this.low = Math.min(this.low, transit);
        this.high = Math.max(this.high, transit);
        this.rawTarget = Math.max(this.floor, this.base + Math.ceil(sampleRate * (this.high - this.low)));
        this.target = Math.min(this.max, Math.max(this.min, this.rawTarget));
      }
    } else if (!this.playing && !this.recovering) {
      // Intentional/cold full-refill wait is not transit jitter.
      this.mediaFrames = this.count;
    }
    this.deadline();
  }
  // Twenty calm seconds take 20ms off the queue and its learned floor,
  // down to 60ms. Reanchor instead of retaining stale timing history.
  relax() {
    if (currentTime - this.calmSince < 20) return;
    this.calmSince = currentTime;
    const step = Math.round(sampleRate * 0.02);
    this.base = Math.max(this.min, this.base - step);
    this.floor = Math.max(this.min, this.floor - step);
    this.target = Math.max(this.min, this.target - step);
    if (this.envelope) this.anchor();
    else this.rawTarget = this.target;
  }
  process(_inputs, outputs) {
    this.expire();
    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    const n = left.length;
    if (!this.playing) {
      if (this.count < this.target && !this.partialReady()) {
        left.fill(0);
        right.fill(0);
        this.relax();
        return true;
      }
      if (!this.started || !this.recovering) { this.started = true; this.anchor(); }
      this.playing = true;
      this.recovering = false;
      this.resumeAt = undefined;
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
      this.recovering = !this.quiet;
      if (!this.quiet) {
        this.target = Math.min(this.max, this.target + Math.round(sampleRate * 0.04));
        this.floor = this.target;
        this.rawTarget = Math.max(this.rawTarget, this.target);
        this.port.postMessage({ type: "late", target: this.target / sampleRate });
      }
      this.calmSince = currentTime;
      this.deadline();
    } else this.relax();
    return true;
  }
}
registerProcessor("reach-sound", ReachSound);
