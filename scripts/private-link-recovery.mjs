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
    this.message = "";
  }
  unavailable(message) {
    if (this.stopped) return;
    this.available(false);
    if (message !== this.message) this.report(message);
    this.message = message;
  }
  async check() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const config = await this.inspect();
      if (this.stopped) return;
      if (this.owns(config, this.origin, this.target)) {
        this.available(true);
        if (this.message) this.report("Private Tailscale connection restored.");
        this.message = "";
        this.attempt = 0;
        return;
      }
      this.unavailable(
        "Private link interrupted. Reconnecting; your local sessions are still running.",
      );
      assertUnusedPort(config, this.port);
      if (this.now() < this.nextRestart) return;
      this.nextRestart =
        this.now() + Math.min(30000, 15000 * 2 ** Math.min(this.attempt++, 1));
      await this.restart();
    } catch (error) {
      this.unavailable(error.message);
    } finally {
      this.busy = false;
    }
  }
  stop() {
    this.stopped = true;
  }
}
