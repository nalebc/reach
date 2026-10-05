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
        if (stopped || denied) return;
        update("connecting");
        try {
          const url = new URL("/ws/presence", peer.url);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          ws = new WebSocket(url);
        } catch {
          update("disconnected");
          return;
        }
        const socket = ws;
        timeout = setTimeout(() => socket.close(), 8000);
        socket.onopen = () => {
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
          try {
            const value = JSON.parse(event.data);
            if (value.type !== "presence" || !Array.isArray(value.devices))
              return;
            clearTimeout(timeout);
            attempts = 0;
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
          clearTimeout(timeout);
          denied = [4001, 4003].includes(event.code);
          update(denied ? "denied" : "disconnected");
          if (!stopped && !denied)
            timer = setTimeout(
              connect,
              Math.min(10000, 1000 * 2 ** attempts++),
            );
        };
        socket.onerror = () => socket.close();
      };
      const wake = () => {
        if (!document.hidden && (!ws || ws.readyState === WebSocket.CLOSED)) {
          attempts = 0;
          connect();
        }
      };
      connect();
      window.addEventListener("online", wake);
      document.addEventListener("visibilitychange", wake);
      return () => {
        clearTimeout(timer);
        clearTimeout(timeout);
        window.removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
        ws?.close();
      };
    });
    return () => {
      stopped = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [key]);
  return connections;
}
