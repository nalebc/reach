import { noteBuild } from "./build-reload";
import { useEffect, useState } from "react";
import type { Peer } from "./api";
export type ConnectedDevice = {
  id: string;
  name: string;
  kind: "phone" | "tablet" | "computer";
  self: boolean;
  access?: { kind: "paired" | "invited" | "agent"; expiresAt: number }[];
  activity: "connected" | "viewing" | "controlling" | "terminal";
};
export type FleetConnection = {
  state: "connecting" | "connected" | "disconnected" | "denied";
  devices: ConnectedDevice[];
  // Fingerprints of the computer's lists (terminals, chats…), when it sends
  // them: a change means refetch that list. Older companions don't.
  changes?: string;
};
export type FleetConnections = Record<string, FleetConnection>;
export function useFleetConnections(peers: Peer[]) {
  const [connections, setConnections] = useState<FleetConnections>({});
  const key = JSON.stringify(peers.map((p) => [p.id, p.url, p.token]));
  useEffect(() => {
    let stopped = false;
    const cleanups = peers.map((peer) => {
      let ws: WebSocket | undefined,
        timer: ReturnType<typeof setTimeout>,
        timeout: ReturnType<typeof setTimeout>;
      let attempts = 0,
        denied = false;
      let hiddenAt = document.hidden ? Date.now() : undefined;
      let lastTick = Date.now();
      // A dead radio can leave WebSocket.OPEN (or CLOSING) indefinitely.
      // Retire the old callbacks before opening the read-only presence feed.
      const retire = () => {
        const old = ws;
        ws = undefined;
        if (!old) return;
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try { old.close(); } catch { /* The old transport is already gone. */ }
      };
      const update = (
        state: FleetConnection["state"],
        devices: ConnectedDevice[] = [],
        changes?: string,
      ) => {
        if (!stopped)
          setConnections((old) => ({
            ...old,
            [peer.id]: { state, devices, changes },
          }));
      };
      const connect = () => {
        clearTimeout(timer);
        clearTimeout(timeout);
        if (stopped || denied) return;
        retire();
        update("connecting");
        try {
          const url = new URL("/ws/presence", peer.url);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          ws = new WebSocket(url);
        } catch {
          update("disconnected");
          timer = setTimeout(connect, Math.min(10000, 1000 * 2 ** attempts++));
          return;
        }
        const socket = ws;
        const current = () => !stopped && ws === socket;
        const disconnected = () => {
          if (!current()) return;
          clearTimeout(timeout);
          retire();
          update("disconnected");
          timer = setTimeout(connect, Math.min(10000, 1000 * 2 ** attempts++));
        };
        // Closing a suspended socket may never deliver its close event.
        timeout = setTimeout(disconnected, 8000);
        socket.onopen = () => {
          if (!current()) return;
          const tablet =
            /iPad/.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
          socket.send(
            JSON.stringify({
              type: "auth",
              token: peer.token,
              kind: tablet
                ? "tablet"
                : /iPhone|Android.*Mobile/.test(navigator.userAgent)
                  ? "phone"
                  : "computer",
            }),
          );
        };
        socket.onmessage = (event) => {
          if (!current()) return;
          try {
            const value = JSON.parse(event.data);
            if (value.type !== "presence" || !Array.isArray(value.devices))
              return;
            clearTimeout(timeout);
            attempts = 0;
            // The Mac that served this page says which interface it serves now.
            if (new URL(peer.url).origin === location.origin) noteBuild(value.changes?.build);
            update(
              "connected",
              value.devices.filter(
                (d: ConnectedDevice) =>
                  d &&
                  typeof d.id === "string" &&
                  typeof d.name === "string" &&
                  ["phone", "tablet", "computer"].includes(d.kind),
              ),
              value.changes && typeof value.changes === "object"
                ? JSON.stringify(value.changes)
                : undefined,
            );
          } catch {
            /* Ignore malformed snapshots; never invent connections. */
          }
        };
        socket.onclose = (event) => {
          if (!current()) return;
          clearTimeout(timeout);
          ws = undefined;
          denied = [4001, 4003].includes(event.code);
          update(denied ? "denied" : "disconnected");
          if (!stopped && !denied)
            timer = setTimeout(
              connect,
              Math.min(10000, 1000 * 2 ** attempts++),
            );
        };
        socket.onerror = disconnected;
      };
      const hidden = () => { hiddenAt ??= Date.now(); };
      const wake = () => {
        if (document.hidden) { hidden(); return; }
        const now = Date.now();
        const suspended = (hiddenAt !== undefined && now - hiddenAt >= 3000) || now - lastTick >= 8000;
        hiddenAt = undefined;
        lastTick = now;
        if (stopped || denied) return;
        if (suspended || !ws || ws.readyState >= WebSocket.CLOSING) {
          attempts = 0;
          connect();
        }
      };
      // Some restored web views omit visibility events. A large timer gap
      // still signals suspension; an ordinarily quiet feed is left alone.
      const liveness = window.setInterval(() => {
        const gap = Date.now() - lastTick;
        lastTick = Date.now();
        if (document.hidden) { hidden(); return; }
        if (gap >= 8000 || hiddenAt !== undefined) {
          if (gap >= 8000) hiddenAt ??= Date.now() - gap;
          wake();
        }
      }, 2000);
      connect();
      window.addEventListener("online", wake);
      window.addEventListener("pagehide", hidden);
      window.addEventListener("pageshow", wake);
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", wake);
      document.addEventListener("freeze", hidden);
      document.addEventListener("resume", wake);
      return () => {
        clearTimeout(timer);
        clearTimeout(timeout);
        window.clearInterval(liveness);
        window.removeEventListener("online", wake);
        window.removeEventListener("pagehide", hidden);
        window.removeEventListener("pageshow", wake);
        window.removeEventListener("focus", wake);
        document.removeEventListener("visibilitychange", wake);
        document.removeEventListener("freeze", hidden);
        document.removeEventListener("resume", wake);
        retire();
      };
    });
    return () => {
      stopped = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [key]);
  return connections;
}
