import { ListChecks } from "lucide-react";
import type { Workflow } from "./Workflows";
import type { NeedItem } from "./NeedsYou";

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
