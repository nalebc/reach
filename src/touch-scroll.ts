type Point = { x: number; y: number };
type Sample = Point & { at: number };
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n));

// Rendered CSS pixels keep slow finger motion one-to-one. Faster swipes
// gain up to 3× travel, then coast with a bounded, decaying velocity. Use
// the recent path rather than one event's interval: two fingers and
// coalesced pointer samples can arrive together.
export class TouchScroll {
  private samples: Sample[] = [];
  private velocity: Point = { x: 0, y: 0 };
  private coast: { at: number; started: number } | null = null;
  private gain = 1;

  get coasting() {
    return this.coast !== null;
  }

  reset() {
    this.samples = [];
    this.velocity = { x: 0, y: 0 };
    this.coast = null;
    this.gain = 1;
  }

  begin(point: Point, at: number) {
    this.reset();
    this.samples = [{ ...point, at }];
  }

  move(point: Point, at: number) {
    const last = this.samples.at(-1);
    if (!last) {
      this.begin(point, at);
      return { dx: 0, dy: 0, gain: 1 };
    }
    const dx = point.x - last.x,
      dy = point.y - last.y;
    if (!dx && !dy) return { dx: 0, dy: 0, gain: this.gain };
    if (
      Math.hypot(dx, dy) >= 2 &&
      dx * this.velocity.x + dy * this.velocity.y < 0
    )
      this.samples = [last]; // Reversing never inherits the old direction.
    this.samples.push({ ...point, at });
    while (
      this.samples.length > 32 ||
      (this.samples.length > 2 && at - this.samples[0].at > 90)
    )
      this.samples.shift();
    const first = this.samples[0],
      dt = Math.max(16, at - first.at);
    const vx = (point.x - first.x) / dt,
      vy = (point.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    this.gain = 1 + 2 * clamp((speed - 0.35) / 1.65, 0, 1) ** 1.2;
    const limit = Math.min(1, 6 / Math.max(0.001, speed * this.gain));
    this.velocity = { x: vx * this.gain * limit, y: vy * this.gain * limit };
    return { dx: dx * this.gain, dy: dy * this.gain, gain: this.gain };
  }

  lift(at: number) {
    const last = this.samples.at(-1),
      first = this.samples[0];
    if (
      !last ||
      at - last.at > 80 ||
      Math.hypot(last.x - first.x, last.y - first.y) < 8 ||
      Math.hypot(this.velocity.x, this.velocity.y) < 0.15
    ) {
      this.reset();
      return false;
    }
    this.coast = { at, started: at };
    return true;
  }

  step(at: number) {
    const coast = this.coast;
    if (!coast) return null;
    const elapsed = at - coast.at;
    // A suspended frame must never resume with a burst of old scrolling.
    if (
      elapsed > 80 ||
      at - coast.started > 1400 ||
      Math.hypot(this.velocity.x, this.velocity.y) < 0.02
    ) {
      this.reset();
      return null;
    }
    const dt = clamp(elapsed, 0, 48),
      keep = Math.exp(-dt / 220);
    const distance = 220 * (1 - keep);
    const dx = clamp(this.velocity.x * distance, -120, 120),
      dy = clamp(this.velocity.y * distance, -120, 120);
    this.velocity = { x: this.velocity.x * keep, y: this.velocity.y * keep };
    coast.at = at;
    return { dx, dy, gain: this.gain };
  }
}
