import { useEffect, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Circle, CircleSlash, ListTodo, Loader2, Moon, Square, X } from "lucide-react";
import type { AgentSession, SessionItem, Subagent } from "./agent-sessions";
import AgentMarkdown from "./AgentMarkdown";
import "./subagents.css";

type Status = Subagent["status"];
const WORDS: Record<Status, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  quiet: "No news",
};
const typeName = (type: string) =>
  type === "general-purpose" ? "Agent" : type.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function StatusMark({ status }: { status: Status }) {
  const Icon = status === "running" ? Loader2 : status === "done" ? Check : status === "failed" ? X : status === "quiet" ? Moon : CircleSlash;
  return (
    <span className={`sa-status ${status}`}>
      <Icon size={12} className={status === "running" ? "spin" : undefined} aria-hidden="true" />
      {WORDS[status] || status}
    </span>
  );
}

// A sub-agent the chat started, where it started it: what it is, whether it
// still runs and what it's doing, and what it found once it ends.
export function SubagentCard({ item, agent, onStop }: { item: SessionItem; agent?: Subagent; onStop?: (task: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Ended only on a word that says so: an unknown one reads as still running.
  const status: Status = agent?.status || item.agentStatus ||
    (item.status === "failed" ? "failed" : ["completed", "done", "stopped", "cancelled"].includes(String(item.status)) ? "done" : "running");
  const activity = agent?.activity || item.activity || "";
  // A background agent's call returns at once ("launched"): its own last words say more.
  const result = agent?.result || (item.background ? "" : item.detail || "");
  return (
    <div className={`sa-card ${status}`} id={`subagent-${item.id}`}>
      <button className="sa-card-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!result}>
        <span className="sa-icon" aria-hidden="true">
          <Bot size={15} />
        </span>
        <span className="sa-text">
          <strong>{item.text || "Agent"}</strong>
          <small>
            {typeName(agent?.type || item.agentType || "general-purpose")}
            {(agent?.background ?? item.background) ? " · background" : ""}
            {status === "running" && activity ? ` · ${activity}` : ""}
          </small>
        </span>
        <StatusMark status={status} />
        {result && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </button>
      {onStop && agent?.stoppable && status === "running" && (
        <button
          className="sa-stop"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            try {
              await onStop(agent.id);
            } finally {
              setStopping(false);
            }
          }}
        >
          {stopping ? <Loader2 size={13} className="spin" /> : <Square size={11} fill="currentColor" />} Stop this agent
        </button>
      )}
      {open && result && (
        <div className="sa-result">
          <AgentMarkdown text={result} />
        </div>
      )}
    </div>
  );
}

// The chat's running sub-agents at a glance, while their cards are out of
// sight (on screen, the cards say it already); tapping one goes to its card.
export function SubagentStrip({ agents }: { agents: Subagent[] }) {
  const [open, setOpen] = useState(false);
  const [cardsInSight, setCardsInSight] = useState(false);
  const running = agents.filter((a) => a.status === "running").length;
  const cardIds = agents.filter((a) => a.status === "running" && a.toolUseId).map((a) => `subagent-${a.toolUseId}`).join(" ");
  useEffect(() => {
    const cards = cardIds.split(" ").map((id) => id && document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (!cards.length || typeof IntersectionObserver === "undefined") return setCardsInSight(false);
    const seen = new Set<Element>();
    const watch = new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? seen.add(e.target) : seen.delete(e.target);
      setCardsInSight(seen.size > 0);
    });
    cards.forEach((card) => watch.observe(card));
    return () => watch.disconnect();
  }, [cardIds, agents]);
  if (!running || (cardsInSight && !open)) return null;
  const label = `${running} agent${running === 1 ? "" : "s"} running`;
  return (
    <div className={`sa-strip ${running ? "busy" : ""} ${open ? "open" : ""}`}>
      <button className="sa-strip-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Bot size={13} aria-hidden="true" />}
        <span>{label}</span>
        {!open && running > 0 && (
          <small>{agents.find((a) => a.status === "running" && a.activity)?.activity || ""}</small>
        )}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <ul className="sa-strip-list">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => {
                  const card = a.toolUseId && document.getElementById(`subagent-${a.toolUseId}`);
                  if (card) {
                    card.scrollIntoView({ behavior: "smooth", block: "center" });
                    setOpen(false);
                  }
                }}
              >
                <span className="sa-text">
                  <strong>{a.name}</strong>
                  <small>
                    {typeName(a.type)}
                    {a.status === "running" && a.activity ? ` · ${a.activity}` : ""}
                  </small>
                </span>
                <StatusMark status={a.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Claude's todo list, pinned above the composer as the Claude app shows it:
// how far along, the step it's on; all of it on a tap.
export function TodoStrip({ todos }: { todos: NonNullable<AgentSession["todos"]> }) {
  const [open, setOpen] = useState(false);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const now = todos.find((t) => t.status === "in_progress");
  return (
    <div className={`sa-strip todo ${open ? "open" : ""}`}>
      <button className="sa-strip-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ListTodo size={13} aria-hidden="true" />
        <span>
          {done}/{todos.length} done
        </span>
        {!open && now && <small>{now.text}</small>}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <ul className="sa-todo-list">
          {todos.map((t) => (
            <li key={t.id} className={t.status}>
              {t.status === "completed" ? (
                <Check size={14} aria-label="Done" />
              ) : t.status === "in_progress" ? (
                <Loader2 size={14} className="spin" aria-label="Doing now" />
              ) : (
                <Circle size={14} aria-label="To do" />
              )}
              <span>{t.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
