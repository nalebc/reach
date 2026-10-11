import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { request, type Peer } from "./api";
import { usePageVisible } from "./page-visible";
import type { NeedItem } from "./NeedsYou";

// An agent's ask for a Mac permission it lacks (server/permission-requests.mjs):
// a card in Needs you with Not now and Allow. Allow does what Reach can on the
// Mac; the card then says what's left for the owner (macOS's own prompt, or
// the switch in System Settings).
type PermissionRequest = {
  id: string;
  agentName: string;
  title: string;
  allowDoes: string;
  reason: string;
  status: "pending" | "allowed" | "denied" | "expired";
  expiresAt: number;
  answeredAt?: number;
  next?: string;
};
// After Allow, what's left on the Mac stays on the card a few minutes.
const NEXT_MS = 3 * 60_000;

export function usePermissionRequests(peer: Peer, enabled = true) {
  const visible = usePageVisible();
  const [entries, setEntries] = useState<PermissionRequest[]>([]);
  const [revision, setRevision] = useState(0);
  const deciding = useRef(false);
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => setEntries([]), [peer.id, peer.url, peer.token, enabled]);
  useEffect(() => {
    if (!enabled || !visible) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const result = await request<{ permissions: PermissionRequest[] }>(peer, "/api/agents/permissions", { signal: controller.signal });
        if (!controller.signal.aborted && !deciding.current) setEntries(result.permissions || []);
      } catch {
        // An older Reach without these requests: nothing to show.
        if (!controller.signal.aborted) setEntries([]);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.id, peer.url, peer.token, enabled, visible, revision]);
  const decide = async (entry: PermissionRequest, decision: "allow" | "deny") => {
    deciding.current = true;
    try {
      const result = await request<PermissionRequest>(peer, `/api/agents/permissions/${encodeURIComponent(entry.id)}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setEntries((old) => old.map((item) => (item.id === result.id ? result : item)));
      return result.next;
    } finally {
      deciding.current = false;
      setRevision((r) => r + 1);
    }
  };
  const now = Date.now();
  const items: NeedItem[] = enabled
    ? entries.flatMap((entry): NeedItem[] => {
        const key = `permission:${entry.id}`;
        if (entry.status === "pending" && entry.expiresAt > now)
          return [{
            key,
            icon: <ShieldCheck size={22} />,
            title: entry.title,
            detail: entry.allowDoes,
            body: <p>{entry.reason}</p>,
            actions: [
              { label: "Not now", completes: true, run: () => decide(entry, "deny") },
              { label: "Allow", primary: true, run: () => decide(entry, "allow") },
            ],
          }];
        if (entry.status === "allowed" && entry.next && now - (entry.answeredAt || 0) < NEXT_MS && !done.includes(entry.id))
          return [{
            key,
            icon: <ShieldCheck size={22} />,
            title: entry.title,
            detail: entry.next,
            actions: [{ label: "Done", primary: true, completes: true, run: () => setDone((list) => [...list, entry.id]) }],
          }];
        return [];
      })
    : [];
  return { items };
}
