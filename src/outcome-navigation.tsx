import { ChevronRight, ListChecks } from "lucide-react";
import type { Workflow } from "./Workflows";
import type { NeedItem } from "./NeedsYou";
import "./outcome-navigation.css";

export const outcomeNeedsOwner = (w: Workflow) => !!w.outcome &&
  ["ready", "needs_owner", "uncertain", "cancelling", "unavailable"].includes(w.outcome.phase);
export const workflowActive = (w: Workflow) => w.state === "running" || w.state === "paused" || outcomeNeedsOwner(w);
export function outcomeState(w: Workflow) {
  const phase = w.outcome?.phase;
  if (phase === "ready") return "Ready for your review";
  if (phase === "accepted") return "Result accepted";
  if (phase === "cancelling") return "Stopping · needs you";
  if (outcomeNeedsOwner(w)) return "Blocked · needs you";
  if (phase === "cancelled") return "Cancelled · result unaccepted";
  if (phase === "changes_requested") return "Changes requested · new draft";
  if (phase === "draft") return "Draft · review before Run";
  if (w.outcome?.waitingForVerification) return "Waiting for checks";
  return "Running · result unaccepted";
}
// Only persisted task/chat identities establish this link; matching titles do not.
export const outcomeForChat = (list: Workflow[], chat: { agent: string; id: string }) =>
  list.find(w => w.outcome && w.tasks.some(t => [t.chat, ...(t.tries || [])].some(c => c?.agent === chat.agent && c.id === chat.id)));
export const outcomeNeeds = (list: Workflow[], open: (id: string) => void): NeedItem[] =>
  list.filter(outcomeNeedsOwner).map(w => ({
    key: `outcome:${w.id}`, icon: <ListChecks size={22} />,
    title: w.title || "Outcome", detail: outcomeState(w),
    actions: [{ label: "Review outcome", opens: true, primary: true, run: () => open(w.id) }],
  }));

// A compact view into existing workflows; decisions live only in their result sheet.
export function OutcomeEntry({ list, onOpen, onAll, runningOnly = false }: {
  list: Workflow[]; onOpen: (id: string) => void; onAll: () => void; runningOnly?: boolean;
}) {
  const active = list.filter(w => w.outcome && workflowActive(w));
  const shown = [...active].sort((a, b) => Number(outcomeNeedsOwner(b)) - Number(outcomeNeedsOwner(a)) || b.updatedAt - a.updatedAt)
    .filter(w => !runningOnly || !outcomeNeedsOwner(w)).slice(0, 3);
  return <section className="outcome-entry" aria-label="Outcomes">
    <button className="outcome-entry-head" onClick={onAll}><ListChecks size={18} /><strong>Outcomes</strong>
      <span>{active.length ? `${active.length} active` : "Goal, checks and owner review"}</span><ChevronRight size={17} /></button>
    {shown.map(w => <button key={w.id} className="outcome-entry-row" onClick={() => onOpen(w.id)}>
      <span><strong>{w.title || "Outcome"}</strong><small>{outcomeState(w)}</small></span><ChevronRight size={16} /></button>)}
  </section>;
}
