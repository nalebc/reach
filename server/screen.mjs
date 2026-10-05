import { fail } from "./core.mjs";

// Paused (the person at the computer has it back): its screen and input
// aren't lent to any phone until Resume.
export const pausedMessage = (platform = process.platform) =>
  `Reach is paused on this ${platform === "darwin" ? "Mac" : "computer"}.`;

// Control is a short-lived grant for one paired browser, never a saved setting.
export class ScreenControl {
  constructor(now = Date.now) {
    this.now = now;
  }
  lease = null;
  // While paused nobody gets control, renewals included.
  paused = false;
  acquire(client, enabled) {
    if (
      !client.scopes.includes("admin") &&
      !client.scopes.includes("screen:control")
    )
      throw fail(403, "Only a paired person can enable screen control.");
    if (typeof enabled !== "boolean")
      throw fail(400, "Send enabled as true or false.");
    if (enabled && this.paused) throw fail(423, pausedMessage());
    if (!enabled) {
      if (this.lease?.clientId === client.id) this.lease = null;
      return { enabled: false };
    }
    // You can always take control back from someone you invited.
    const owner = client.kind !== "guest" && client.scopes.includes("admin");
    if (
      this.lease &&
      this.lease.expiresAt > this.now() &&
      this.lease.clientId !== client.id &&
      !(this.lease.guest && owner)
    )
      throw fail(
        409,
        "Another paired device is controlling the screen. Stop control there first.",
      );
    this.lease = {
      clientId: client.id,
      expiresAt: this.now() + 30000,
      ...(client.kind === "guest" ? { guest: true } : {}),
    };
    return { enabled: true, expiresAt: this.lease.expiresAt };
  }
  check(client) {
    if (this.paused) throw fail(423, pausedMessage());
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
