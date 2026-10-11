import { post, type Peer } from "./api";
import { tailnetBrowser } from "./tailnet-transport";

// Reach's public link answers strangers with 404 (the door, server/index.mjs).
// A browser that came in without the Tailscale app talks to the computer
// through the tailnet, but its page and code (a screen opened later, a
// reload) come from that public link: its own door key, asked for over the
// private connection, goes with them as a cookie while its access lasts.
const asked = new Set<string>();
export function keepDoorKey(peer: Peer) {
  if (!tailnetBrowser()) return;
  // Only the computer whose public link this page came from.
  try {
    if (new URL(peer.url).hostname !== location.hostname) return;
  } catch {
    return;
  }
  // Once per page and credential; each load asks again (a fresh key, a fresh
  // expiry: a browser caps a page-set cookie at a week).
  const once = `${peer.id}:${peer.token}`;
  if (asked.has(once)) return;
  asked.add(once);
  void post<{ key: string; expiresAt: number }>(peer, "/api/device/door-key", {})
    .then(({ key, expiresAt }) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return;
      const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      document.cookie = `reach-door=${key}; Max-Age=${seconds}; Path=/; Secure; SameSite=Lax`;
    })
    .catch(() => asked.delete(once));
}
