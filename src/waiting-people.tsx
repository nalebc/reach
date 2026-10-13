import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { request, type Peer } from "./api";
import { computerWord } from "./pause";
import { usePageVisible } from "./page-visible";
import type { NeedItem } from "./NeedsYou";

// A person who opened their invitation while an agent was using the Mac
// (server: macEntry, POST /api/guests/:id/allow): a card in Needs you with
// Deny and Let in. Deny ends their access, as removing them does.
type Person = {
  id: string;
  name?: string;
  kind?: string;
  status?: string;
  macEntry?: { nodeName?: string };
};

export function useWaitingPeople(peer: Peer, enabled = true, changes?: string) {
  const visible = usePageVisible();
  const [people, setPeople] = useState<Person[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => setPeople([]), [peer.id, peer.url, peer.token, enabled]);
  useEffect(() => {
    if (!enabled || !visible) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const result = await request<{ clients?: Person[] }>(peer, "/api/clients", { signal: controller.signal });
        if (!controller.signal.aborted)
          setPeople((result.clients || []).filter((c) => c.kind === "guest" && c.status === "waiting"));
      } catch {
        if (!controller.signal.aborted) setPeople([]);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.id, peer.url, peer.token, enabled, visible, revision, changes]);
  const answer = async (person: Person, allow: boolean) => {
    try {
      await request(peer, allow ? `/api/guests/${encodeURIComponent(person.id)}/allow` : `/api/clients/${encodeURIComponent(person.id)}`, {
        method: allow ? "POST" : "DELETE",
      });
    } finally {
      setRevision((r) => r + 1);
    }
  };
  const items: NeedItem[] = enabled
    ? people.map((person) => ({
        key: `person:${person.id}`,
        icon: <UserRound size={22} />,
        title: `${person.name || "Someone"} wants to come in`,
        detail: person.macEntry?.nodeName
          ? `On ${person.macEntry.nodeName} · an agent is using the ${computerWord(peer.platform)}`
          : `An agent is using the ${computerWord(peer.platform)}`,
        actions: [
          { label: "Deny", completes: true, run: () => answer(person, false) },
          { label: "Let in", primary: true, completes: true, run: () => answer(person, true) },
        ],
      }))
    : [];
  return { items };
}
