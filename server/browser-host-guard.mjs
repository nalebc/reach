import { tailscaleJson } from "../scripts/tailscale.mjs";
import { fail } from "./core.mjs";
import { trustedRequest } from "./tailscale-auth.mjs";
import { browserRouteAllowed } from "./browser-access.mjs";
import { hostGuardedPreset } from "./agent-presets.mjs";

export const browserHostGuardMessage =
  "An agent has app access on this Mac. Manage Reach from the trusted device that created its invitation.";
// What a person kept out by the guard reads (opening their invitation, or
// with access already): someone else has the Mac, and when they can come in.
export const personGuardMessage =
  "Someone else is controlling this Mac right now: an agent with full control. You can come in once the owner ends or pauses it.";

const nativeSystems = new Set(["ios", "android", "darwin", "macos", "windows", "linux", "freebsd", "openbsd"]);
const expires = (client) => client?.expiresAt || Date.parse(client?.createdAt) + 30 * 86400000;
const binding = (value) => value && ["nodeId", "userId", "clientId"].every((key) =>
  typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 200);

// Include invitations before they are redeemed. Opening the browser later must
// not leave a gap in which the agent can obtain a normal owner credential.
// Not one the owner declined, nor one never claimed in time or left
// unanswered (auth.list's status): those can't act, and would otherwise keep
// every other device of the owner locked out for as long as the invitation
// lasts, up to Always (security audit L2).
export function browserAppSessionActive(client, now = Date.now()) {
  return client?.kind === "agent" && client.policy?.browser === true &&
    (client.policy.screen === "apps" || hostGuardedPreset(client.policy)) &&
    !["denied", "expired"].includes(client.status) &&
    (!Number.isFinite(client.expiresAt) || client.expiresAt > now);
}

// status is read from the local Tailscale daemon, never request headers or the
// origin's DNS name. Self.ID is the same stable node ID as whois Node.StableID.
// Self.Online is not checked: Tailscale 1.102 reports the local node offline
// while it runs and serves, which locked app access on a working Mac (Oct 8).
// BackendState and the node key's expiry are the local daemon's real answer.
export function browserHostNode(status, now = Date.now()) {
  const keyExpiry = Date.parse(status?.Self?.KeyExpiry);
  if (status?.BackendState !== "Running" || status.Self?.Expired === true ||
      (keyExpiry > 0 && keyExpiry <= now) || typeof status.Self?.ID !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(status.Self.ID))
    throw fail(503, "Reach cannot verify this Mac's Tailscale identity. App access stays locked.");
  return status.Self.ID;
}

function apiPath(req) {
  // originalUrl survives Express's /api mount stripping. Do not normalize
  // encoded slashes, dot segments or backslashes into an allowed agent route.
  const value = req.originalUrl ?? req.url;
  if (typeof value !== "string") return null;
  const pathname = value.split("?", 1)[0];
  if (!pathname.startsWith("/api/") || /[%\\\u0000-\u0020]/u.test(pathname)) return null;
  return pathname.slice(4);
}

/**
 * Guard the host's ordinary Reach access while an agent can drive its apps.
 * A browser on that host may contain an owner bearer, or acquire one through
 * same-node admission. It must not reach owner APIs, including read-only APIs.
 *
 * Integration: refresh before API admission/upgrade, then allows(req, client)
 * after real credential verification (also every HTTP/WS reauthorization).
 * The client parameter MUST be verified by auth, never copied from a request.
 * beginInvitation returns a release callback with server-created .approver;
 * persist that binding as client.browserAppApprover through an internal auth
 * argument. Hold the callback through grant persistence and release in finally.
 * The pending guard is raised before the first await.
 *
 * A different node ID alone does not mean a different physical device: a host
 * browser can run its own Tailscale/WASM node. Only the specifically pinned
 * native Tailscale issuer(s) can reach ordinary APIs during the session. OS is
 * enrollment metadata, not hardware attestation; this assumes an agent cannot
 * enroll/configure a native Tailscale node or proxy through the approved phone.
 */
export function createBrowserHostGuard({
  clients = () => [],
  lookup = () => tailscaleJson(["status", "--json"]),
  trusted = trustedRequest,
  now = Date.now,
  maxAgeMs = 5000,
} = {}) {
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 10000)
    throw Error("Choose a host identity cache lifetime from 1 to 10,000 ms.");
  const pending = new Map();
  let self = null, peers = [], until = 0, flight = null, generation = 0;
  const state = (excluding) => {
    try {
      const all = clients();
      if (!Array.isArray(all)) throw Error("Unreadable clients");
      const grants = all.filter((client) => browserAppSessionActive(client, now()));
      const reservations = [...pending].filter(([key]) => key !== excluding);
      const approvers = [...grants.map((client) => client.browserAppApprover), ...reservations.map(([, value]) => value)]
        .filter((value) => binding(value) && all.some((owner) => owner.id === value.clientId &&
          owner.kind === "device" && owner.scopes?.includes("admin") && expires(owner) > now() &&
          owner.tailscale?.nodeId === value.nodeId && owner.tailscale?.userId === value.userId));
      return { active: grants.length > 0 || reservations.length > 0, approvers, grants };
    } catch { return { active: true, approvers: [], grants: [] }; }
  };
  const isActive = () => state().active;
  const fresh = () => !!self && until > now();
  const invalidate = () => { generation++; self = null; peers = []; until = 0; flight = null; };
  // Open connections (a live screen, a terminal) are checked against this
  // cache every second and refresh it every 2 s (trackIdentity, index.mjs).
  // Refreshing with that much lead keeps the cache from lapsing between two
  // refreshes, which read on the phone as its access being revoked (Oct 7).
  const leadMs = Math.min(2500, Math.floor(maxAgeMs / 2));
  const refresh = async ({ force = false } = {}) => {
    if (!force && fresh() && until > now() + leadMs) return self;
    if (flight) return flight;
    // Stale identity cannot be used while the replacement lookup is pending;
    // one still within its lifetime serves until the answer arrives.
    if (!fresh()) {
      self = null;
      peers = [];
      until = 0;
    }
    const revision = generation, started = now();
    const operation = Promise.resolve().then(lookup).then((status) => {
      const node = browserHostNode(status, now());
      if (revision !== generation || started + maxAgeMs <= now())
        throw fail(503, "Reach's host identity changed or could not be verified in time.");
      self = node;
      peers = status.Peer && typeof status.Peer === "object" && !Array.isArray(status.Peer)
        ? Object.values(status.Peer) : [];
      until = started + maxAgeMs;
      return node;
    }).catch(() => {
      if (revision === generation) { self = null; peers = []; until = 0; }
      throw fail(503, "Reach cannot verify this Mac's Tailscale identity. App access stays locked.");
    }).finally(() => { if (flight === operation) flight = null; });
    flight = operation;
    return operation;
  };
  const nativeRemote = (req) => {
    const identity = req?.reachIdentity;
    if (!(!!self && until > now() && trusted(req) === true &&
      typeof identity?.nodeId === "string" && identity.nodeId.length > 0 &&
      identity.nodeId !== self && Number.isFinite(identity.validUntil) &&
      identity.validUntil > now() && identity.tagged === false &&
      typeof identity.userId === "string" && identity.userId.length > 0)) return false;
    const matches = peers.filter((peer) => peer?.ID === identity.nodeId);
    if (matches.length !== 1) return false;
    const peer = matches[0], keyExpiry = Date.parse(peer.KeyExpiry);
    return typeof peer.OS === "string" && nativeSystems.has(peer.OS.toLowerCase()) &&
      String(peer.UserID) === identity.userId && peer.Online !== false && peer.Expired !== true &&
      !(Array.isArray(peer.Tags) && peer.Tags.length) && !(keyExpiry > 0 && keyExpiry <= now());
  };
  const pinnedRemote = (req, current) => nativeRemote(req) && current.approvers.some((approver) =>
    approver.nodeId === req.reachIdentity.nodeId && approver.userId === req.reachIdentity.userId);
  const signedAgentRoute = (req, client, current) => {
    if (client?.kind !== "agent" || client.policy?.browser !== true ||
        !Number.isFinite(client.expiresAt) || client.expiresAt <= now() ||
        !Array.isArray(client.scopes) || req.headers?.upgrade !== undefined) return false;
    if (client.policy.screen === "apps" || hostGuardedPreset(client.policy)) {
      // Losing the device that can supervise this invitation must stop the
      // agent too. Otherwise revoking an owner leaves app control running
      // while the guard prevents every remaining owner from stopping it.
      const grant = current.grants.find((entry) => entry.id === client.id);
      const creator = grant?.browserAppApprover;
      if (!binding(creator) || !binding(client.browserAppApprover) ||
          !["nodeId", "userId", "clientId"].every((key) => creator[key] === client.browserAppApprover[key]) ||
          !current.approvers.some((owner) => ["nodeId", "userId", "clientId"].every((key) => owner[key] === creator[key])))
        return false;
    }
    const route = apiPath(req);
    return route !== null && browserRouteAllowed(client, req.method, route);
  };
  const allows = (req, verifiedClient = null) => {
    const current = state();
    return !current.active || signedAgentRoute(req, verifiedClient, current) || pinnedRemote(req, current);
  };
  const assertRequest = (req, verifiedClient = null) => {
    if (!allows(req, verifiedClient)) throw fail(403, browserHostGuardMessage);
  };
  const beginInvitation = async (req, verifiedOwner) => {
    const reservation = Symbol("pending app invitation");
    pending.set(reservation, null);
    let released = false;
    const release = () => { if (!released) { released = true; pending.delete(reservation); } };
    try {
      await refresh({ force: true });
      const identity = req?.reachIdentity;
      const current = state(reservation);
      if (!nativeRemote(req) || (current.active && !pinnedRemote(req, current)) || verifiedOwner?.kind !== "device" ||
          typeof verifiedOwner.id !== "string" || !verifiedOwner.id ||
          !verifiedOwner.scopes?.includes("admin") || !(expires(verifiedOwner) > now()) ||
          verifiedOwner.tailscale?.nodeId !== identity.nodeId ||
          verifiedOwner.tailscale?.userId !== identity.userId ||
          identity.tagged !== false || typeof identity.userId !== "string" || !identity.userId)
        throw fail(403, "Create app access from your trusted phone or computer using its native Tailscale connection. Browser Tailscale sessions cannot approve app access.");
      const approver = Object.freeze({ nodeId: identity.nodeId, userId: identity.userId, clientId: verifiedOwner.id });
      pending.set(reservation, approver);
      Object.defineProperty(release, "approver", { value: approver, enumerable: true });
      // Require that the verified credential still appears in the authoritative
      // list before returning a binding to persist.
      if (!pinnedRemote(req, state())) throw fail(403, browserHostGuardMessage);
      return release;
    } catch (error) { release(); throw error; }
  };
  return { isActive, fresh, refresh, invalidate, allows, assertRequest, beginInvitation };
}
