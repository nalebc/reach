import { fail } from "./core.mjs";

// Paused (the person at the computer has it back): its screen and input
// aren't lent to any phone until Resume.
export const pausedMessage = (platform = process.platform) =>
  `Reach is paused on this ${platform === "darwin" ? "Mac" : "computer"}.`;

// Control is a short-lived grant for one paired browser, never a saved setting.
// The Mac has one pointer and one keyboard: one person controls, everyone
// else watches. Control never moves silently (two phones used to take it
// from each other on every tap); it moves when the holder lets go or lapses,
// or when someone taps Take over: you, from anyone; a guest, from another
// guest, never from you.
export class ScreenControl {
  constructor(now = Date.now) {
    this.now = now;
  }
  lease = null;
  // While paused nobody gets control, renewals included.
  paused = false;
  // Who holds control now, as the other phones show it.
  holder() {
    if (!this.lease || this.lease.expiresAt <= this.now()) return null;
    return {
      clientId: this.lease.clientId,
      name: this.lease.name,
      guest: !!this.lease.guest,
    };
  }
  acquire(client, enabled, { takeover = false } = {}) {
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
    const held = this.holder();
    let taken = null;
    if (held && held.clientId !== client.id) {
      const guest = client.kind === "guest";
      if (!takeover || (guest && !held.guest))
        throw Object.assign(
          fail(
            409,
            `${held.name || "Someone"} is controlling the screen. You can watch.`,
          ),
          { holder: { name: held.name, guest: held.guest }, canTakeOver: !guest || held.guest },
        );
      taken = held.clientId;
    }
    this.lease = {
      clientId: client.id,
      name: client.name || "",
      expiresAt: this.now() + 30000,
      ...(client.kind === "guest" ? { guest: true } : {}),
    };
    return {
      enabled: true,
      expiresAt: this.lease.expiresAt,
      ...(taken ? { taken } : {}),
    };
  }
  check(client) {
    if (this.paused) throw fail(423, pausedMessage());
    const held = this.holder();
    if (held && held.clientId !== client.id)
      throw fail(409, `${held.name || "Someone"} is controlling the screen.`);
    if (!held)
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
