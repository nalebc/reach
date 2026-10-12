import { useEffect, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Circle, ListTodo, Loader2, Square } from "lucide-react";
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

// A sub-agent the chat started, where it started it: one quiet line, as a
// run of commands shows ("Ran 3 commands ›"). A tap opens what it is, what
// it's doing, Stop while it runs, and what it found once it ends (Oct 12:
// "the big bar we have now is too much").
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
    <div className={`sa-card ${status} ${open ? "open" : ""}`} id={`subagent-${item.id}`}>
      <button className="sa-card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {status === "running" ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}
        <span className="sa-card-name">{item.text || "Agent"}</span>
        {status !== "running" && status !== "done" && <em className={`sa-word ${status}`}>{WORDS[status] || status}</em>}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="sa-card-body">
          <small className="sa-meta">
            {typeName(agent?.type || item.agentType || "general-purpose")}
            {(agent?.background ?? item.background) ? " · background" : ""}
            {` · ${WORDS[status] || status}`}
            {status === "running" && activity ? ` · ${activity}` : ""}
          </small>
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
          {result && (
            <div className="sa-result">
              <AgentMarkdown text={result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The chat's running sub-agents: a small sign with how many in the chat's
// header, as "Your Mac needs you" shows; a tap opens the list, and a row
// goes to its line in the chat.
export function SubagentBadge({ agents }: { agents: Subagent[] }) {
  const [open, setOpen] = useState(false);
  const running = agents.filter((a) => a.status === "running");
  useEffect(() => {
    if (!running.length) setOpen(false);
  }, [running.length]);
  if (!running.length) return null;
  const label = `${running.length} agent${running.length === 1 ? "" : "s"} running`;
  return (
    <>
      <button className="as-icon sa-badge" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bot size={18} />
        <small>{running.length}</small>
      </button>
      {open && (
        <>
          <div className="as-details-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="as-details sa-menu" role="menu" aria-label={label}>
            <ul className="sa-strip-list">
              {running.map((a) => (
                <li key={a.id}>
                  <button
                    role="menuitem"
                    onClick={() => {
                      const card = a.toolUseId && document.getElementById(`subagent-${a.toolUseId}`);
                      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
                      setOpen(false);
                    }}
                  >
                    <Loader2 size={13} className="spin" aria-hidden="true" />
                    <span className="sa-text">
                      <strong>{a.name}</strong>
                      <small>
                        {typeName(a.type)}
                        {a.activity ? ` · ${a.activity}` : ""}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
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
