import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { leavingForReload, pushInPage, stackDepth } from "./nav-history";

// OpenClaw's pieces, laid out as the ChatGPT app lays out its own: a row in a
// rounded group (a tinted icon, a name, a word on the right, a chevron) and a
// page top (a round back button, the title in the middle).

export function ClawRow({
  icon,
  tint = "",
  label,
  sub,
  value,
  tone = "",
  onClick,
  ariaLabel,
}: {
  icon: ReactNode;
  tint?: string;
  label: string;
  sub?: ReactNode;
  value?: ReactNode;
  // "action": a blue word to tap (Connect); "alert": something is wrong.
  tone?: "" | "action" | "alert";
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button type="button" className="claw-row" aria-label={ariaLabel} onClick={onClick}>
      <span className={`claw-row-icon ${tint}`} aria-hidden="true">
        {icon}
      </span>
      <span className="claw-row-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
      {value !== undefined && value !== "" && <span className={`claw-row-value ${tone}`}>{value}</span>}
      <ChevronRight size={18} className="claw-row-chevron" aria-hidden="true" />
    </button>
  );
}

export function ClawPageTop({
  title,
  onBack,
  backLabel = "Back",
  action,
}: {
  title: string;
  onBack: () => void;
  backLabel?: string;
  action?: ReactNode;
}) {
  return (
    <header className="claw-page-top">
      <button type="button" className="claw-round" aria-label={backLabel} onClick={onBack}>
        <ChevronLeft size={22} />
      </button>
      <h1>{title}</h1>
      {action || <span className="claw-round-spacer" />}
    </header>
  );
}

// What used to open in a sheet (a task, an app, New task) opens as a page
// in place of the one it came from, with the same top; back returns to it.
// It starts at its own top, wherever the page under it was scrolled.
export function ClawSubPage({
  title,
  backLabel,
  onBack,
  action,
  children,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const page = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    page.current?.scrollIntoView?.({ block: "start" });
  }, []);
  return (
    <section className="claw-page claw-subpage" aria-label={title} ref={page}>
      <ClawPageTop title={title} onBack={onBack} backLabel={backLabel} action={action} />
      {children}
    </section>
  );
}

// The phone's back (the iPhone's edge swipe, Android's back) closes what's
// open in OpenClaw, as its chevron does: one entry of Reach's own stack
// (src/nav-history.ts) per level while that level is open, as EverythingChat
// gives an open chat. Each level knows how deep its entry sits, so stepping
// back from a task to Scheduled closes the task and leaves Scheduled open.
//
// A level closed in Reach (its chevron, a deleted task) takes its entry away
// a moment later, once everything that render opened has pushed its own:
// only while it's still on top. Under another's (a Codex chat opened as
// OpenClaw closed) it stays, costing one back press, rather than popping
// that one and closing the chat it belongs to.
export type ClawLevel = "reachClawPage" | "reachClawSub" | "reachClawChat";
const LEVELS: ClawLevel[] = ["reachClawPage", "reachClawSub", "reachClawChat"];
const shownLevels = new Set<ClawLevel>();
const entryAt = new Map<ClawLevel, number>();
// The stack still reaches the level's entry.
const standing = (level: ClawLevel) => (entryAt.get(level) ?? Infinity) <= stackDepth();
const enter = (level: ClawLevel) => {
  // Its entry, still on top (opened again before it was taken away), is
  // still its own; anything else gets a new one.
  if (entryAt.get(level) === stackDepth()) return;
  pushInPage({ reachClaw: level });
  entryAt.set(level, stackDepth());
};
let settling = false;
// Ours, not a gesture: a level open again by then keeps an entry.
let ownStep = false;
function settle() {
  if (settling) return;
  settling = true;
  setTimeout(() => {
    settling = false;
    const closed = LEVELS.filter((level) => !shownLevels.has(level) && entryAt.has(level))
      .map((level) => entryAt.get(level)!)
      .sort((a, b) => b - a);
    const depth = stackDepth();
    let n = 0;
    while (n < closed.length && closed[n] === depth - n) n++;
    for (const level of LEVELS) if (!shownLevels.has(level)) entryAt.delete(level);
    if (!n) return;
    ownStep = true;
    window.history.go(-n);
  }, 0);
}
if (typeof window !== "undefined")
  // Added when this file loads, so it hears a pop before any view does.
  window.addEventListener("popstate", () => {
    if (!ownStep) return;
    ownStep = false;
    for (const level of LEVELS) if (shownLevels.has(level) && !standing(level)) enter(level);
  });
export function useClawBack(shown: boolean, close: () => void, level: ClawLevel) {
  const closeNow = useRef(close);
  closeNow.current = close;
  useEffect(() => {
    if (!shown) return;
    shownLevels.add(level);
    enter(level);
    const onPop = () => {
      // Stepping back for an interface reload: what's open stays open.
      if (leavingForReload()) return;
      if (!standing(level)) closeNow.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      shownLevels.delete(level);
      window.removeEventListener("popstate", onPop);
      settle();
    };
  }, [shown]);
}
