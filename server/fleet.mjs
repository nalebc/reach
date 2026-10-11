import crypto from "node:crypto";
import path from "node:path";
import { atomicJson, loadJson, fail } from "./core.mjs";
import { tailscaleJson } from "../scripts/tailscale.mjs";

// Your other Reach computers. Each computer finds the Reach computers signed
// in to the same Tailscale account; you link them in each computer's own
// terminal (never over the network). Linked computers trust each other's
// device approvals: approve a phone once, and every linked computer lets it
// in, on a ticket the phone gets with its own credential. Requests between
// computers are identified by Tailscale (whois), and anything that changes
// access is confirmed by asking the other computer back at its own address.

const LABEL = /^[a-z0-9-]{1,63}$/;
const MOBILE = new Set(["iOS", "android", "tvOS"]);

async function fetchJson(url, { method = "GET", body, timeoutMs = 2500 } = {}) {
  const response = await fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return response.json();
}

export const startLinkOf = (origin) => `https://${new URL(origin).hostname}`;
// "mac-b.tail1.ts.net" -> "mac-b": what you type to link it.
export const shortName = (origin) => new URL(origin).hostname.split(".")[0];

export function createFleet({
  dataDir,
  owner,
  selfOrigin = "",
  status = () => tailscaleJson(["status", "--json"]),
  request = fetchJson,
  now = Date.now,
}) {
  const file = path.join(dataDir, "links.json");
  const read = () => {
    const value = loadJson(file, null);
    return Array.isArray(value?.computers)
      ? value.computers.filter(
          (c) =>
            c &&
            typeof c.nodeId === "string" &&
            typeof c.origin === "string" &&
            typeof c.name === "string",
        )
      : [];
  };
  const listeners = new Set();
  const changed = () => listeners.forEach((f) => f());
  let cache = { at: 0, value: null };

  // Reach computers on this tailnet under the owner's account, other than
  // this one. Each answers its public start page with its private address.
  async function discover({ fresh = false } = {}) {
    if (!fresh && cache.value && now() - cache.at < 15000) return cache.value;
    const st = await status();
    const selfHost = selfOrigin ? new URL(selfOrigin).hostname : "";
    const peers = Object.values(st?.Peer || {}).filter(
      (p) =>
        p &&
        String(p.UserID) === owner.userId &&
        !p.Tags?.length &&
        p.Online &&
        !MOBILE.has(p.OS) &&
        typeof p.DNSName === "string" &&
        typeof p.ID === "string",
    );
    const linked = read();
    const found = await Promise.all(
      peers.map(async (p) => {
        const host = p.DNSName.replace(/\.$/, "").toLowerCase();
        if (host === selfHost) return null;
        try {
          const start = await request(`https://${host}/reach-start.json`);
          const origin = new URL(start?.origin);
          if (
            start?.product !== "Reach" ||
            origin.protocol !== "https:" ||
            origin.hostname !== host ||
            origin.origin !== start.origin
          )
            return null;
          return {
            nodeId: p.ID,
            name: String(start.name || host).slice(0, 80),
            origin: origin.origin,
            short: shortName(origin.origin),
            since: Number.isFinite(start.since) ? start.since : 0,
            linked: linked.some((l) => l.nodeId === p.ID),
          };
        } catch {
          return null;
        }
      }),
    );
    cache = { at: now(), value: found.filter(Boolean) };
    return cache.value;
  }

  function isLinked(identity) {
    return (
      !!identity &&
      !identity.tagged &&
      identity.userId === owner.userId &&
      identity.validUntil > now() &&
      read().some((l) => l.nodeId === identity.nodeId)
    );
  }

  // Terminal command only: `link <name>`.
  async function link(short) {
    if (typeof short !== "string" || !LABEL.test(short.toLowerCase()))
      throw Error(
        "Type link followed by the computer's name, like: link mac-mini",
      );
    const target = (await discover({ fresh: true })).find(
      (c) => c.short === short.toLowerCase(),
    );
    if (!target)
      throw Error(
        `No Reach computer named "${short}" is online on your tailnet. Start Reach on it first.`,
      );
    const computers = read().filter((l) => l.nodeId !== target.nodeId);
    computers.push({
      nodeId: target.nodeId,
      name: target.name,
      origin: target.origin,
      since: target.since,
      linkedAt: new Date(now()).toISOString(),
    });
    atomicJson(file, { version: 1, computers });
    cache = { at: 0, value: null };
    changed();
    return target;
  }

  function unlink(short) {
    const before = read();
    const computers = before.filter((l) => shortName(l.origin) !== short);
    if (computers.length === before.length)
      throw Error(`"${short}" isn't linked.`);
    atomicJson(file, { version: 1, computers });
    cache = { at: 0, value: null };
    changed();
  }

  // Any process on a Mac can claim one of your devices' Tailscale identities
  // on Reach's private socket, so no computer takes who a request says it's
  // from as proof (connections audit, Oct 10). A device approved here proves
  // it with its own credential instead: it asks this computer for a one-use
  // ticket (two minutes), hands it to a linked computer, and that computer
  // redeems it here, over a verified TLS connection it opened itself.
  const tickets = new Map();
  const ticketKey = (ticket) =>
    crypto.createHash("sha256").update(ticket).digest("base64url");
  function issueTicket(binding) {
    for (const [key, t] of tickets) if (t.until <= now()) tickets.delete(key);
    if (tickets.size >= 64)
      throw fail(429, "Too many computers joining at once. Try again in a minute.");
    const ticket = crypto.randomBytes(24).toString("base64url");
    tickets.set(ticketKey(ticket), {
      userId: binding.userId,
      nodeId: binding.nodeId,
      until: now() + 120000,
    });
    return ticket;
  }
  // Answered for linked computers only; each ticket works once.
  function redeemTicket(caller, ticket) {
    if (!isLinked(caller))
      throw fail(403, "Only your linked Reach computers can ask this.");
    if (typeof ticket !== "string" || ticket.length > 64) return { valid: false };
    const key = ticketKey(ticket);
    const t = tickets.get(key);
    tickets.delete(key);
    if (!t || t.until <= now()) return { valid: false };
    return { valid: true, userId: t.userId, nodeId: t.nodeId };
  }
  // Asked by this computer when a device brings a ticket: the linked
  // computer that issued it, if it was issued to this very device.
  async function ticketApproval(identity, ticket) {
    const links = read();
    if (
      !links.length ||
      !identity ||
      identity.tagged ||
      identity.userId !== owner.userId ||
      typeof ticket !== "string"
    )
      return null;
    const answers = await Promise.all(
      links.map(async (l) => {
        try {
          const r = await request(`${l.origin}/api/fleet/tickets/redeem`, {
            method: "POST",
            body: { ticket },
            timeoutMs: 3000,
          });
          return r?.valid === true &&
            r.userId === identity.userId &&
            r.nodeId === identity.nodeId
            ? l.name
            : null;
        } catch {
          return null;
        }
      }),
    );
    return answers.find(Boolean) || null;
  }

  // Tell linked computers a device was revoked here ("revoke once"). Each
  // asks back before ending anything, so only a real revoke here counts.
  const revoked = new Map();
  async function revokeElsewhere(binding) {
    for (const [key, at] of revoked) if (now() - at > 120000) revoked.delete(key);
    revoked.set(`${binding.userId} ${binding.nodeId}`, now());
    await Promise.all(
      read().map((l) =>
        request(`${l.origin}/api/fleet/revoked`, {
          method: "POST",
          body: { userId: binding.userId, nodeId: binding.nodeId },
          timeoutMs: 3000,
        }).catch(() => null),
      ),
    );
  }
  function revokedQuery(caller, body) {
    if (!isLinked(caller))
      throw fail(403, "Only your linked Reach computers can ask this.");
    const { userId, nodeId } = body || {};
    if (
      typeof nodeId !== "string" ||
      !nodeId ||
      nodeId.length > 64 ||
      userId !== owner.userId
    )
      throw fail(400, "Name one of your devices.");
    return { userId, nodeId };
  }
  // A linked computer says it revoked a device: ask it back, at its own
  // address, before ending anything here.
  async function confirmRevoked(caller, body) {
    const binding = revokedQuery(caller, body);
    const from = read().find((l) => l.nodeId === caller.nodeId);
    const r = from
      ? await request(`${from.origin}/api/fleet/revoked/check`, {
          method: "POST",
          body: binding,
          timeoutMs: 3000,
        }).catch(() => null)
      : null;
    if (r?.revoked !== true)
      throw fail(403, "That computer didn't revoke this device.");
    return binding;
  }
  function revokedCheck(caller, body) {
    const { userId, nodeId } = revokedQuery(caller, body);
    const at = revoked.get(`${userId} ${nodeId}`);
    return { revoked: !!at && now() - at <= 120000 };
  }

  // Your tailnet's one link: the start page of the computer where Reach was
  // set up first, among this one and the linked ones.
  function homeLink(self) {
    const candidates = [
      self,
      ...read().map((l) => ({
        start: startLinkOf(l.origin),
        since: Number.isFinite(l.since) && l.since > 0 ? l.since : Infinity,
      })),
    ];
    return candidates.reduce((best, c) =>
      c.since < best.since || (c.since === best.since && c.start < best.start)
        ? c
        : best,
    ).start;
  }

  // Browser pages from linked computers (private and start addresses) may
  // call this computer: that's how one phone page reaches all of them.
  const origins = () =>
    read().flatMap((l) => [l.origin, startLinkOf(l.origin)]);

  return {
    discover,
    isLinked,
    link,
    unlink,
    links: read,
    issueTicket,
    redeemTicket,
    ticketApproval,
    revokeElsewhere,
    confirmRevoked,
    revokedCheck,
    origins,
    homeLink,
    onChange: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  };
}
