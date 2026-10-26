import { useCallback, useEffect, useRef } from "react";
import { sameComputer, type Peer } from "./api";
import type { FleetConnection } from "./useFleetConnections";

// "Back within reach": said only when it's news. Opening Reach, reloading it
// or moving between pages says nothing; the computer simply being there is
// what the page already shows. It's said when the phone showed the computer
// lost and then it came back: the "Let's reconnect" page, or its live
// connection dropping while Reach was in front (Home says "Connecting…" and
// Settings "Offline" then).
//
// What counts as seen: that state on screen for a moment while Reach is in
// front. A blip shorter than that, or a drop while the phone was locked or
// Reach was in the background, was never in front of anyone, so coming back
// from it is a normal open. This only listens: which route connects, and
// when it retries, stays with the connection code.
export const SEEN_LOST_MS = 1500;
// Opening Reach, or bringing it back in front, settles its connections: a
// phone often reports the live connection it suspended in the background as
// closed only after the page is visible again, and reconnecting then can
// take a moment while the network wakes. A drop in that window is part of
// opening, not a loss.
export const OPENING_MS = 4000;

export function useBackWithinReach({
  peer,
  pageLost,
  presence,
  workspace,
  announce,
}: {
  peer: Peer | undefined;
  // The out-of-reach page is what's on screen.
  pageLost: boolean;
  // The computer's live connection (src/useFleetConnections.ts).
  presence: FleetConnection["state"] | undefined;
  // The computer answers and its workspace is open.
  workspace: boolean;
  announce: (message: string) => void;
}) {
  const key = peer ? `${peer.id}:${peer.url}:${peer.token}` : "";
  // A drop seen in front, until the live connection is back. Its retries go
  // through "connecting", which is still the same drop.
  const dropped = useRef({ key: "", seen: false });
  const inFrontSince = useRef(Date.now());
  useEffect(() => {
    const shown = () => {
      if (!document.hidden) inFrontSince.current = Date.now();
    };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, []);
  if (dropped.current.key !== key) dropped.current = { key, seen: false };
  if (presence === "connected") dropped.current.seen = false;
  else if (
    (presence === "disconnected" || presence === "denied") &&
    !document.hidden &&
    Date.now() - inFrontSince.current >= OPENING_MS
  )
    dropped.current.seen = true;
  const lost = pageLost || dropped.current.seen;
  const connected = workspace && presence === "connected";

  const seenLost = useRef<Peer | null>(null);
  const latest = useRef({ peer, announce });
  latest.current = { peer, announce };
  useEffect(() => {
    if (!lost || !key) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => {
        seenLost.current = latest.current.peer || null;
      }, SEEN_LOST_MS);
    };
    watch();
    document.addEventListener("visibilitychange", watch);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", watch);
    };
  }, [lost, key]);
  useEffect(() => {
    if (!connected || !peer) return;
    const was = seenLost.current;
    seenLost.current = null;
    // The same computer, even when it came back on another of its routes
    // (its id can differ between the app's and the browser's approval).
    // Connecting to a different computer instead isn't a comeback.
    if (was && sameComputer(was, peer))
      latest.current.announce(`${peer.name} is back within reach`);
  }, [connected, key]);
  // Paired again by hand: that says so itself, once.
  return useCallback(() => {
    seenLost.current = null;
  }, []);
}
