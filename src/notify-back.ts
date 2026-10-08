import { useEffect, useRef, useState } from "react";
import { post, type Peer } from "./api";
import { enablePush, pushEnabled, pushSupport } from "./push";

// "Notify me when it's back", on an agent out of usage: the Mac watches its
// limit and sends one notification when it resets (server/agent-sessions/
// usage-watch.mjs). Notifications come first: a tap without them on this
// device turns them on (the browser asks), or says what they need.
export function useNotifyBack(peer: Peer, agent: string, session: string | undefined, asked = false) {
  const [on, setOn] = useState(asked);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const context = useRef<{ pending: boolean } | null>(null);
  useEffect(() => {
    const active = { pending: false };
    context.current = active;
    setOn(asked);
    setBusy(false);
    setProblem("");
    return () => { context.current = null; };
  }, [peer?.id, peer?.url, peer?.token, agent, session]);
  useEffect(() => setOn(asked), [asked, agent]);
  const toggle = async () => {
    const active = context.current;
    if (!peer || !active || active.pending) return;
    active.pending = true;
    setBusy(true);
    setProblem("");
    try {
      if (!on) {
        const support = pushSupport();
        if (support === "home-screen") throw Error("Add Reach to your Home Screen to get notified.");
        if (support === "denied") throw Error("Notifications are off for Reach in this device's settings.");
        if (support === "unsupported") throw Error("This browser can't get notifications.");
        const enabled = await pushEnabled(peer).catch(() => false);
        if (context.current !== active) return;
        if (!enabled) await enablePush(peer);
      }
      if (context.current !== active) return;
      await post(peer, "/api/sessions/usage-watch", { agent, session, on: !on });
      if (context.current === active) setOn(!on);
    } catch (e) {
      if (context.current === active) setProblem((e as Error).message);
    } finally {
      active.pending = false;
      if (context.current === active) setBusy(false);
    }
  };
  return { on, busy, problem, toggle };
}
