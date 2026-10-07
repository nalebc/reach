import { ownsServeRoute, assertUnusedPort } from "./tailscale.mjs";

// Recover only our private route; never replace another service or enable Funnel.
export class PrivateLinkRecovery {
  constructor({
    origin,
    target,
    inspect,
    restart,
    available,
    report = () => {},
    now = Date.now,
    owns = ownsServeRoute,
  }) {
    Object.assign(this, {
      origin,
      target,
      inspect,
      restart,
      available,
      report,
      now,
      owns,
    });
    this.port = Number(new URL(origin).port || 443);
    this.busy = false;
    this.stopped = false;
    this.nextRestart = 0;
    this.attempt = 0;
    this.misses = 0;
    this.message = "";
  }
  unavailable(message) {
    if (this.stopped) return;
    this.available(false);
    if (message !== this.message) this.report(message);
    this.message = message;
  }
  // The route is daemon state, so one failed status read (a slow or
  // mismatched CLI) says nothing about it. Two in a row do.
  miss(message) {
    this.misses++;
    if (this.misses >= 2) this.unavailable(message);
  }
  async check() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const config = await this.inspect();
      if (this.stopped) return;
      if (this.owns(config, this.origin, this.target)) {
        this.misses = 0;
        this.available(true);
        if (this.message) this.report("Private Tailscale connection restored.");
        this.message = "";
        this.attempt = 0;
        return;
      }
      this.miss("Private link interrupted. Reconnecting; your local sessions are still running.");
      if (this.misses < 2) return;
      assertUnusedPort(config, this.port);
      if (this.now() < this.nextRestart) return;
      this.nextRestart =
        this.now() + Math.min(30000, 15000 * 2 ** Math.min(this.attempt++, 1));
      await this.restart();
    } catch (error) {
      this.miss(error.message);
    } finally {
      this.busy = false;
    }
  }
  stop() {
    this.stopped = true;
  }
}
