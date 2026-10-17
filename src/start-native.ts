import { compactPeers, readPrivatePeers, type Device, type Peer } from "./api";
import { nativeTailnetFetch } from "./tailnet-transport";
import type { StartConfig } from "./start-flow";

const identity = (peer: Peer) => JSON.stringify([peer.id, peer.computerId, peer.url, peer.token, peer.transport]);

// A public owner start can become private while it is still showing sign-in.
// Keep the page's origin (and its saved approvals), authenticate only the
// native device's own credential, and leave workspace handoffs to app-watch.
export function watchNativeStart(
  config: StartConfig,
  ready: (peer: Peer, device: Device) => void,
  every = 5000,
) {
  const lifetime = new AbortController();
  let pending: Promise<void> | null = null;
  let again = false;
  const eligible = (peer: Peer) => {
    try {
      const url = new URL(peer.url);
      return peer.transport !== "funnel" && url.protocol === "https:" &&
        url.hostname === location.hostname && url.hostname === new URL(config.origin).hostname &&
        !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
    } catch { return false; }
  };
  // Match the workspace's latest saved approval for each computer. An older
  // duplicate must not revive a credential the user already replaced.
  const candidates = () => compactPeers(readPrivatePeers("native")).filter(eligible);
  const check = async () => {
    for (const peer of candidates()) {
      if (lifetime.signal.aborted) return;
      try {
        const response = await nativeTailnetFetch(peer.url + "/api/device", {
          cache: "no-store", redirect: "error", credentials: "omit",
          headers: { Authorization: `Bearer ${peer.token}` },
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1800)]),
        });
        // A refusal never becomes authorization by changing the route.
        if (!response.ok) continue;
        const device: Device = await response.json();
        if (device?.id !== peer.id || (peer.computerId && device.computerId !== peer.computerId) ||
          typeof device.access?.kind !== "string" || !device.access.kind ||
          !Array.isArray(device.access.scopes) || device.access.scopes.some(scope => typeof scope !== "string")) continue;
        // Restricted and guest approvals remain exactly that grant. Treating
        // a usable limited device as offline could substitute a browser owner.
        if (lifetime.signal.aborted || !candidates().some(saved => identity(saved) === identity(peer))) return;
        ready(peer, device);
        return;
      } catch { /* An unavailable, expired or unapproved device cannot open Reach. */ }
    }
  };
  const run = () => {
    if (lifetime.signal.aborted || document.hidden) return Promise.resolve();
    if (pending) { again = true; return pending; }
    pending = check().finally(() => {
      pending = null;
      if (again) { again = false; void run(); }
    });
    return pending;
  };
  const wake = () => { void run(); };
  const timer = setInterval(wake, every);
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);
  const stop = () => {
    lifetime.abort();
    clearInterval(timer);
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("pagehide", hide);
  };
  const hide = (event: PageTransitionEvent) => { if (!event.persisted) stop(); };
  window.addEventListener("pagehide", hide);
  return { check: run, stop };
}
