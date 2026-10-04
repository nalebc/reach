import { fail } from "./core.mjs";

// Control is a short-lived grant for one paired browser, never a saved setting.
export class ScreenControl {
  constructor(now = Date.now) {
    this.now = now;
  }
  lease = null;
  acquire(client, enabled) {
    if (!client.scopes.includes("admin"))
      throw fail(403, "Only a paired person can enable screen control.");
    if (typeof enabled !== "boolean")
      throw fail(400, "Send enabled as true or false.");
    if (!enabled) {
      if (this.lease?.clientId === client.id) this.lease = null;
      return { enabled: false };
    }
    if (
      this.lease &&
      this.lease.expiresAt > this.now() &&
      this.lease.clientId !== client.id
    )
      throw fail(
        409,
        "Another paired device is controlling the screen. Stop control there first.",
      );
    this.lease = { clientId: client.id, expiresAt: this.now() + 30000 };
    return { enabled: true, expiresAt: this.lease.expiresAt };
  }
  check(client) {
    if (
      !this.lease ||
      this.lease.clientId !== client.id ||
      this.lease.expiresAt <= this.now()
    )
      throw fail(
        403,
        "Screen control is off or expired. Tap Control screen to enable it.",
      );
  }
  revoke(clientId) {
    if (this.lease?.clientId === clientId) this.lease = null;
  }
  clear() {
    this.lease = null;
  }
}
