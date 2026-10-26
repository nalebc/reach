import crypto from "node:crypto";
import { fail } from "./core.mjs";
import { ownerIdentity, sameIdentity, identityBinding } from "./tailscale-auth.mjs";

// Only private, verified Tailscale identities reach these handlers. Approval
// is proven by the browser's registered key, never by an account/name match.
export function createOwnerConnections({ auth, owner, now = Date.now }) {
  const challenges = new Map();
  const prune = () => { for (const [id, entry] of challenges) if (entry.until <= now()) challenges.delete(id); };
  return {
    challenge(identity, { connection, role } = {}) {
      if (!ownerIdentity(identity, owner) || !["native", "browser"].includes(role) || typeof connection !== "string")
        throw fail(403, "Connect this device to the owner's private network.");
      const registered = auth.ownerConnection(connection);
      if (registered.role === role) throw fail(403, "This connection already has that path.");
      prune();
      if (challenges.size >= 256 || [...challenges.values()].filter(entry => sameIdentity(entry.identity, identity)).length >= 8)
        throw fail(429, "Connection setup is already in progress. Try again shortly.");
      const id = crypto.randomBytes(32).toString("base64url"), until = now() + 120000;
      const payload = JSON.stringify({ v: 1, purpose: "reach-owner-connection", connection, role, identity: identityBinding(identity), challenge: id, until });
      challenges.set(id, { connection, role, identity: identityBinding(identity), payload, until });
      return { id, payload };
    },
    join(identity, { id, token, signature } = {}) {
      prune();
      const entry = typeof id === "string" ? challenges.get(id) : null;
      if (!entry || !ownerIdentity(identity, owner) || !sameIdentity(entry.identity, identity) ||
          !/^[A-Za-z0-9_-]{43}$/.test(token || "") || !/^[A-Za-z0-9_-]{86}$/.test(signature || ""))
        throw fail(403, "This owner connection proof expired or belongs to another device.");
      const registered = auth.ownerConnection(entry.connection);
      const key = crypto.createPublicKey({ key: registered.key, format: "jwk" });
      if (!crypto.verify("sha256", Buffer.from(`${entry.payload}\n${token}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")))
        throw fail(403, "This owner connection proof is invalid.");
      challenges.delete(id);
      return auth.joinOwnerConnection(entry.connection, entry.role, identity, token);
    },
  };
}
