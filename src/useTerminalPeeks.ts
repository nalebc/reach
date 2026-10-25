import { useEffect, useState } from "react";
import type { Peer, Session } from "./api";
import { terminalPreview } from "./terminal-preview";

// Last lines (null while a full-screen program runs) and when output last arrived.
export type Peek = { lines: string[] | null; at: number };
type Peeks = Record<string, Peek>;

// Live last lines of each running Reach terminal, streamed over the same
// connection the terminal page uses. No polling; updates as output arrives.
export function useTerminalPeeks(peer: Peer, sessions: Session[], limit = 6) {
  const scope = JSON.stringify([peer.id, peer.url, peer.token]);
  const [held, setPeeks] = useState<{ scope: string; peeks: Peeks }>({ scope, peeks: {} });
  const ids = sessions
    .filter((s) => s.status === "running")
    .slice(0, limit)
    .map((s) => s.id);
  const key = ids.join(",");
  useEffect(() => {
    if (!ids.length) return;
    const buffers: Record<string, string> = {};
    const arrived: Record<string, number> = {};
    const sockets: WebSocket[] = [];
    // Batch bursts of output into at most ~8 updates a second.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      pending = undefined;
      if (stopped) return;
      setPeeks(() => {
        const next: Peeks = {};
        for (const id of ids)
          next[id] = {
            lines: terminalPreview(buffers[id] || ""),
            at: arrived[id] || 0,
          };
        return { scope, peeks: next };
      });
    };
    const schedule = () => {
      pending ??= setTimeout(publish, 120);
    };
    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const misses: Record<string, number> = {};
    const watch = (id: string) => {
      const url = new URL("/ws/terminal", peer.url);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      sockets.push(ws);
      ws.onopen = () => {
        misses[id] = 0;
        ws.send(JSON.stringify({ type: "auth", token: peer.token, sessionId: id }));
      };
      ws.onmessage = (event) => {
        if (stopped) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "snapshot") buffers[id] = String(message.data);
        else if (message.type === "data") {
          buffers[id] = ((buffers[id] || "") + message.data).slice(-16000);
          arrived[id] = Date.now();
        } else return;
        schedule();
      };
      // Reconnect after a dropped connection (Wi-Fi change, phone sleep).
      ws.onclose = (event) => {
        if (stopped || event.code === 4001) return;
        // Back off up to 30 s, and wait for the page to be visible again.
        const n = misses[id] || 0;
        misses[id] = n + 1;
        const delay = Math.min(30000, 2000 * 2 ** n);
        const retry = () => {
          if (stopped) return;
          if (document.hidden) timers.push(setTimeout(retry, 5000));
          else watch(id);
        };
        timers.push(setTimeout(retry, delay));
      };
    };
    ids.forEach(watch);
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
      clearTimeout(pending);
      for (const ws of sockets) ws.close();
    };
  }, [scope, key]);
  return held.scope === scope ? held.peeks : {};
}
