import { useEffect, useState } from "react";
import { computer } from "./computer.mjs";

// Stands in for src/useDesktopInput.ts: a connected input socket that
// records actions instead of sending them.
//
// With `computer.lease` set (true/false), it also behaves like the server's
// control grant: connecting without the grant ends input (`ended`), and
// closing the connection revokes the grant, as server/desktop-connection.mjs
// does. Without it, input is simply ready whenever enabled.
export function useDesktopInput(peer, enabled, display, ended) {
  const [connected, setConnected] = useState(false);
  if (enabled) computer.input = { display };
  useEffect(() => {
    if (!enabled || computer.lease === undefined) return;
    let open = true;
    const timer = setTimeout(() => {
      if (!open) return;
      if (!computer.lease) {
        computer.refused = (computer.refused || 0) + 1;
        ended?.("Screen control is off or expired.");
        return;
      }
      computer.connected = display;
      setConnected(true);
    }, 5);
    return () => {
      open = false;
      clearTimeout(timer);
      setConnected(false);
      if (computer.connected === display) computer.connected = null;
      computer.lease = false;
    };
  }, [enabled, display]);
  return {
    ready: computer.lease === undefined ? enabled : enabled && connected,
    typing: true,
    initialCursor: undefined,
    latency: 1,
    send: async (action) => {
      computer.actions.push(action);
      return computer.replies[action.type]?.(action) ?? {};
    },
  };
}
