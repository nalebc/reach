import { useEffect, useState } from "react";
import { request, type Peer } from "./api";

// What OpenClaw's pages share: a channel's name, and reading a route again
// when the Mac says it changed.

export const channelName = (channel: string) =>
  ({
    whatsapp: "WhatsApp",
    discord: "Discord",
    telegram: "Telegram",
    webchat: "Direct",
    slack: "Slack",
    signal: "Signal",
    imessage: "iMessage",
  })[channel] || channel;

// One request at a time; stop both requests and polling when this view closes.
// With `watch`, the Mac says when what it answered changed (a request that
// waits): read again then. A Mac that doesn't is asked every `interval`.
export function usePolling<T extends { version?: string }>(
  peer: Peer,
  route: string,
  interval: number,
  refresh: number,
  watch?: string,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    let watching = !!watch;
    const poll = async () => {
      let next = interval;
      try {
        if (!document.hidden) {
          const result = await request<T>(peer, route, {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
          });
          if (active) {
            setData(result);
            setError("");
          }
          if (watch && watching && typeof result?.version === "string") {
            const asked = Date.now();
            try {
              await request(peer, `${watch}${watch.includes("?") ? "&" : "?"}after=${encodeURIComponent(result.version)}`, {
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
              });
            } catch (e) {
              // An older Mac without it: asked every `interval`.
              if ((e as { status?: number }).status !== 404) throw e;
              watching = false;
            }
            // Read again at once, never in a tight loop.
            if (watching) next = Math.max(0, 250 - (Date.now() - asked));
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) timer = setTimeout(poll, next);
      }
    };
    void poll();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [peer.id, peer.url, peer.token, route, interval, refresh]);
  return { data, error };
}
