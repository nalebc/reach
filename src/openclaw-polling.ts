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
  // Data belongs to the computer that answered; another computer starts clean.
  const peerKey = `${peer.id}|${peer.url}|${peer.token}`;
  const [kept, setKept] = useState<{ key: string; data: T | null; error: string; notice: string }>({
    key: peerKey,
    data: null,
    error: "",
    notice: "",
  });
  const fresh = kept.key === peerKey;
  const data = fresh ? kept.data : null;
  const error = fresh ? kept.error : "";
  const notice = fresh ? kept.notice : "";
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
          if (active)
            setKept((k) => ({ key: peerKey, data: result, error: "", notice: k.key === peerKey ? k.notice : "" }));
          if (watch && watching && typeof result?.version === "string") {
            const asked = Date.now();
            try {
              await request(peer, `${watch}${watch.includes("?") ? "&" : "?"}after=${encodeURIComponent(result.version)}`, {
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
              });
            } catch (e) {
              if (!active) throw e;
              // An older Mac without it: asked every `interval`.
              if ((e as { status?: number }).status === 404) watching = false;
              else {
                // Keep the last data; a slow watch never blocks the chat.
                setKept((k) => ({ ...k, key: peerKey, notice: "Live updates are paused. Retrying…" }));
                return;
              }
            }
            setKept((k) => (k.notice ? { ...k, notice: "" } : k));
            // Read again at once, never in a tight loop.
            if (watching) next = Math.max(0, 250 - (Date.now() - asked));
          }
        }
      } catch (e) {
        if (active) {
          const name = (e as Error).name;
          const message =
            name === "TimeoutError" || name === "AbortError"
              ? "OpenClaw is slow to answer. Retrying…"
              : (e as Error).message;
          setKept((k) => ({ key: peerKey, data: k.key === peerKey ? k.data : null, error: message, notice: "" }));
        }
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
  return { data, error, notice };
}
