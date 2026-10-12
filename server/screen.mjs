import { fail } from "./core.mjs";
import { computerWord } from "./computer-word.mjs";

// Paused (the person at the computer has it back): its screen and input
// aren't lent to any phone until Resume.
export const pausedMessage = (platform = process.platform) =>
  `Reach is paused on this ${computerWord(platform)}.`;
// The Mac's own dialogs (a privacy prompt, its password) are its owner's to
// answer: while one is up, only the owner's own devices click or type.
export const dialogMessage =
  "The Mac is showing one of its own dialogs, which only its owner can answer. You can watch until it's gone.";

// You, or a person you gave full access (Oct 11: "they should have the same
// control as me on the Mac"): they answer the Mac's dialogs, take control
// from anyone, and see the whole screen. Managing access stays yours (the
// routes that check kind === "device").
export const actsAsOwner = (client) =>
  client?.kind === "device" || (client?.kind === "guest" && !!client.scopes?.includes("admin"));
// A person whose control others may take over (any guest without full access).
const limitedGuest = (client) => client?.kind === "guest" && !actsAsOwner(client);

// Control is a short-lived grant for one paired browser, never a saved setting.
// The Mac has one pointer and one keyboard: one person controls, everyone
// else watches. Control never moves silently (two phones used to take it
// from each other on every tap); it moves when the holder lets go or lapses,
// or when someone taps Take over: you (or a full-access person), from
// anyone; another guest, from another guest, never from you.
export class ScreenControl {
  constructor(now = Date.now) {
    this.now = now;
  }
  lease = null;
  // Trusted server hook: reserve a barrier before a newly enabled controller
  // can dispatch native input over a background desktop transaction.
  onAcquire = () => {};
  // Leases kept a moment for a control connection on its way back.
  pending = new Map();
  // Native input ownership outlives a closed socket until its process exits.
  // Revoking a grant never means that an old helper has finished stopping.
  retiringInputs = new Map();
  retireInput(terminated) {
    if (this.retiringInputs.has(terminated)) return;
    const retirement = Promise.resolve(terminated).then(() => {
      this.retiringInputs.delete(terminated);
    });
    this.retiringInputs.set(terminated, retirement);
    // Unexpected failure to confirm termination stays fail-closed. Waiters
    // receive that error; it must not free native input ownership silently.
    retirement.catch(() => {});
  }
  inputStopping() {
    return this.retiringInputs.size > 0;
  }
  async waitForInputStop() {
    while (this.retiringInputs.size) await Promise.all([...this.retiringInputs.values()]);
  }
  // While paused nobody gets control, renewals included.
  paused = false;
  // Whether macOS shows one of its own dialogs now (set by the server).
  dialogUp = () => false;
  ownerOnly(client) {
    if (!actsAsOwner(client) && this.dialogUp()) throw fail(423, dialogMessage);
  }
  // Who holds control now, as the other phones show it.
  holder() {
    if (!this.lease || this.lease.expiresAt <= this.now()) return null;
    return {
      clientId: this.lease.clientId,
      name: this.lease.name,
      guest: !!this.lease.guest,
      // Someone you invited (full access or not), not one of your devices.
      ...(this.lease.person ? { person: true } : {}),
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
    if (enabled) this.ownerOnly(client);
    if (!enabled) {
      this.revoke(client.id);
      return { enabled: false };
    }
    const held = this.holder();
    let taken = null;
    if (held && held.clientId !== client.id) {
      const guest = limitedGuest(client);
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
    this.onAcquire();
    // Only a successful new grant supersedes the old grace period. Failed
    // takeovers leave the current holder's pending expiry unchanged.
    if (this.lease) this.keep(this.lease.clientId);
    this.keep(client.id);
    this.lease = {
      clientId: client.id,
      name: client.name || "",
      expiresAt: this.now() + 30000,
      ...(limitedGuest(client) ? { guest: true } : {}),
      ...(client.kind === "guest" ? { person: true } : {}),
    };
    return {
      enabled: true,
      expiresAt: this.lease.expiresAt,
      ...(taken ? { taken } : {}),
    };
  }
  check(client) {
    if (this.paused) throw fail(423, pausedMessage());
    this.ownerOnly(client);
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
    this.keep(clientId);
    if (this.lease?.clientId === clientId) this.lease = null;
  }
  // A control connection that dropped for a moment (the phone's link
  // blinked, Tailscale answered late) keeps its lease for `ms`: the
  // reconnect resumes control without the owner granting it again. Nobody
  // back in time, it's released as if the connection had ended.
  revokeLater(clientId, ms) {
    this.keep(clientId);
    if (this.lease?.clientId !== clientId) return;
    const pending = { lease: this.lease, timer: null };
    pending.timer = setTimeout(() => {
      // clearTimeout cannot retract a callback already queued. Both the
      // pending generation and lease must still be the ones it reserved.
      if (this.pending.get(clientId) !== pending) return;
      this.pending.delete(clientId);
      if (this.lease === pending.lease) this.revoke(clientId);
    }, ms);
    pending.timer.unref?.();
    this.pending.set(clientId, pending);
  }
  // Whether this phone's control connection is expected back.
  reconnecting(clientId) {
    return this.pending.has(clientId);
  }
  // Its connection is back (or ended for good): no release on the timer.
  keep(clientId) {
    const pending = this.pending.get(clientId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(clientId);
  }
  clear() {
    for (const clientId of [...this.pending.keys()]) this.keep(clientId);
    this.lease = null;
  }
}
