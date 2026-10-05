import { useEffect, useState } from "react";
import { Hand } from "lucide-react";
import { post, request, type Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import type { NeedItem } from "./NeedsYou";

// Tag in, on the phone: an agent using an app on the Mac's hidden display
// hands it to you (server/agent-apps.mjs). Open it, do what it asks, then
// Done hands it back; Stop tells the agent to stop.
export type Handoff = {
  id: string;
  threadId: string;
  agent: string;
  app: string;
  appId: string;
  reason: string;
  createdAt: string;
};

// What agents hand you, fetched when the computer says it changed (its live
// connection's `handoffs` fingerprint), never on a timer.
export function useHandoffs(peer: Peer, enabled: boolean, changes?: string) {
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  let fingerprint: string | undefined;
  try {
    fingerprint = changes ? JSON.parse(changes).handoffs : undefined;
  } catch {}
  // An older computer without hand-offs sends no fingerprint: nothing to ask.
  const live = enabled && typeof fingerprint === "string";
  useEffect(() => {
    if (!live) return setHandoffs([]);
    const controller = new AbortController();
    request<Handoff[]>(peer, "/api/handoffs", { signal: controller.signal })
      .then((list) => setHandoffs(Array.isArray(list) ? list : []))
      .catch(() => {});
    return () => controller.abort();
  }, [peer.url, peer.token, live, fingerprint]);
  return [handoffs, setHandoffs] as const;
}

// Opening an app from elsewhere (Home's card): the Apps page takes it once.
const wanted = new Map<string, string>();
export function requestOpenThread(computer: string, threadId: string) {
  wanted.set(computer, threadId);
}
export function takeOpenRequest(computer: string) {
  const id = wanted.get(computer) ?? null;
  wanted.delete(computer);
  return id;
}

const agentKind = (name: string) =>
  /claude/i.test(name) ? "claude" : /codex/i.test(name) ? "codex" : null;

export function handoffNeeds({
  peer,
  handoffs,
  logos,
  open,
  ended,
}: {
  peer: Peer;
  handoffs: Handoff[];
  logos: AgentLogos;
  open: (h: Handoff) => void;
  // After Done or Stop went through.
  ended: (h: Handoff) => void;
}): NeedItem[] {
  const answer = (h: Handoff, stop: boolean) => async () => {
    await post(peer, `/api/handoffs/${encodeURIComponent(h.id)}`, { stop });
    ended(h);
    return stop ? `${h.agent} will stop.` : `Back to ${h.agent}.`;
  };
  return handoffs.map((h) => {
    const kind = agentKind(h.agent);
    return {
      key: `handoff:${h.id}`,
      icon: kind ? (
        <AgentLogo agent={kind} logos={logos} size={24} fill />
      ) : (
        <Hand size={22} />
      ),
      title: `${h.agent} needs you in ${h.app}`,
      detail: h.reason,
      actions: [
        { label: "Stop", run: answer(h, true) },
        { label: "Done", run: answer(h, false) },
        { label: "Open", primary: true, run: () => open(h) },
      ],
    };
  });
}
