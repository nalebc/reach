import crypto from "node:crypto";
import { fail, hash } from "./core.mjs";

// Face ID sign-in for a new browser of yours, with no Tailscale app and no
// Tailscale login (docs/SECURITY.md, "Face ID sign-in"):
// 1. The start page (the internet) asks for a challenge, and your phone
//    answers with a passkey this computer knows (Face ID or the device
//    passcode, required).
// 2. This computer makes a one-time key for that browser to join your
//    tailnet as a limited device (the guest tag: Reach's private port and
//    nothing else, named rf-<this computer>-<id>), and a one-time ticket.
// 3. The browser joins with the key and shows the ticket from that device
//    (server/index.mjs, /api/auth/face-join): it becomes one of your devices
//    here, bound to that device. Only that route marks a credential this way.
export function createFaceJoin({
  passkeys,
  guestKeys,
  now = Date.now,
  // New browsers per hour: each one is a key made in your tailnet.
  perHour = 12,
  log = () => {},
}) {
  const tickets = new Map(); // hash(ticket) -> { hostname, until }
  let made = [];
  const available = () => passkeys.has() && guestKeys.configured();
  const unavailable = () =>
    fail(404, "Face ID sign-in isn't set up on this computer.");
  return {
    available,
    options() {
      if (!available()) throw unavailable();
      return passkeys.publicOptions();
    },
    async join({ id, credential } = {}) {
      if (!available()) throw unavailable();
      const passkey = passkeys.verifyPublic(id, credential);
      made = made.filter((at) => at > now() - 3600000);
      if (made.length >= perHour)
        throw fail(
          429,
          "Too many new browsers this hour. Try again later, or sign in with Tailscale.",
        );
      made.push(now());
      const { key, hostname } = await guestKeys.createFaceKey();
      // Revocation can happen while Tailscale is minting the key.
      if (!passkeys.list().some((p) => p.id === passkey.id))
        throw fail(401, "That passkey was removed. Sign in again.");
      for (const [k, t] of tickets) if (t.until <= now()) tickets.delete(k);
      const ticket = crypto.randomBytes(32).toString("base64url");
      tickets.set(hash(ticket), { hostname, passkeyId: passkey.id, until: now() + 600000 });
      log(
        `A new browser signed in with Face ID (${passkey.label}). It joins your tailnet as ${hostname}.`,
      );
      return { key, hostname, ticket };
    },
    // The ticket, from the device its key made (Tailscale adds -1, -2… to a
    // repeated name). The ticket is the secret; the name is a second check.
    redeem(identity, ticket) {
      const entry =
        typeof ticket === "string" && ticket.length < 100
          ? tickets.get(hash(ticket))
          : undefined;
      if (!entry || entry.until <= now() || !passkeys.list().some((p) => p.id === entry.passkeyId))
        throw fail(401, "This Face ID sign-in expired. Try again.");
      const name = String(identity?.nodeName || "")
        .toLowerCase()
        .split(".")[0];
      if (
        !identity?.tagged ||
        !new RegExp(`^${entry.hostname}(?:-\\d+)?$`).test(name)
      )
        throw fail(403, "This Face ID sign-in belongs to another device.");
      tickets.delete(hash(ticket));
      return { hostname: entry.hostname, passkeyId: entry.passkeyId };
    },
    // A device of this computer's Face ID sign-ins (its access may be over).
    ownDevice: (identity) =>
      !!identity?.tagged && guestKeys.isFaceDevice(identity.nodeName),
  };
}
