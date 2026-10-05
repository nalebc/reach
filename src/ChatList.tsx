import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  FolderOpen,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, projectName, type AgentSession } from "./agent-sessions";
import "./chat-list.css";

const DAY = 86400000;
export const ago = (ms: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
};
export function dayGroup(ms: number, now = new Date()) {
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  if (ms >= today) return "Today";
  if (ms >= today - DAY) return "Yesterday";
  if (ms >= today - 7 * DAY) return "Previous 7 days";
  return "Older";
}
export const needsYou = (s: AgentSession) =>
  s.status === "waiting" || !!s.prompts?.length || !!s.asking || !!s.consent;

export default function ChatList({
  peer,
  sessions,
  logos,
  errors = {},
  failure = "",
  onOpen,
  onNew,
  onReview,
  pending = 0,
  compact = false,
}: {
  peer: Peer;
  sessions: AgentSession[] | null;
  logos: AgentLogos;
  errors?: Record<string, string>;
  failure?: string;
  agent?: string;
  onOpen: (s: AgentSession) => void;
  onNew: () => void;
  onReview?: () => void;
  answered?: () => void;
  pending?: number;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const all = useMemo(
    () =>
      (sessions || [])
        .filter((s) => !s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const q = query.trim().toLowerCase();
  const found = all.filter(
    (s) =>
      (filter === "all" || s.agent === filter) &&
      (!q ||
        [s.title, s.preview, s.cwd, agentLabel(s.agent)].some((t) =>
          t?.toLowerCase().includes(q),
        )),
  );
  found.sort(
    (a, b) =>
      Number(needsYou(b) || b.status === "running") -
      Number(needsYou(a) || a.status === "running"),
  );
  const shown = found.slice(0, limit);
  const active = shown.filter((s) => needsYou(s) || s.status === "running");
  const recent = shown.filter((s) => !needsYou(s) && s.status !== "running");
  const cards = (list: AgentSession[]) => (
    <div className="chat-card-grid">
      {list.map((s) => (
        <button
          key={`${s.agent}:${s.id}`}
          className={`chat-card ${needsYou(s) ? "waiting" : s.status}`}
          aria-label={`${s.title || "New chat"}, ${agentLabel(s.agent)}`}
          onClick={() => onOpen(s)}
        >
          <span className="chat-card-top">
            <span className="chat-card-app">
              <AgentLogo agent={s.agent} logos={logos} size={22} />
              {agentLabel(s.agent)}
            </span>
            <span className="chat-card-time">{ago(s.updatedAt)}</span>
          </span>
          <strong>{s.title || "New chat"}</strong>
          <span className="chat-card-preview">
            {s.prompts?.[0]?.title ||
              s.preview ||
              "Pick up where you left off."}
          </span>
          <span className="chat-card-bottom">
            <span className="chat-card-project">
              <FolderOpen size={13} />
              <span>{projectName(s.cwd) || "Workspace"}</span>
            </span>
            <span
              className={`chat-card-state ${needsYou(s) ? "waiting" : s.status}`}
            >
              {needsYou(s) ? (
                <>
                  <Circle size={7} fill="currentColor" /> Needs you
                </>
              ) : s.status === "running" ? (
                <>
                  <Loader2 size={12} className="spin" /> Working
                </>
              ) : s.status === "error" ? (
                "Stopped"
              ) : (
                <ArrowUpRight size={16} />
              )}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
  return (
    <div className={`chat-list ${compact ? "compact" : ""}`}>
      {!compact && (
        <header className="chat-list-top">
          <div>
            <span className="chat-eyebrow">YOUR WORKSPACE</span>
            <h1>Conversations</h1>
            <p>Pick up a thought. Keep it moving.</p>
          </div>
          <button className="chat-create" onClick={onNew}>
            <Plus size={17} />
            <span>New chat</span>
          </button>
        </header>
      )}
      {!!pending && onReview && !compact && (
        <button className="chat-review-link" onClick={onReview}>
          <span>
            <ShieldCheck size={17} />
            <strong>
              {pending} {pending === 1 ? "thing needs" : "things need"} you
            </strong>
          </span>
          <span>
            Review <ArrowUpRight size={15} />
          </span>
        </button>
      )}
      <div className="chat-library-tools">
        <div
          className="chat-filters"
          role="group"
          aria-label="Filter conversations"
        >
          {[
            { id: "all", name: "All apps" },
            { id: "codex", name: "Codex" },
            { id: "claude", name: "Claude" },
          ].map((a) => (
            <button
              key={a.id}
              aria-pressed={filter === a.id}
              onClick={() => {
                setFilter(a.id);
                setLimit(12);
              }}
            >
              {a.id !== "all" && (
                <AgentLogo agent={a.id} logos={logos} size={17} />
              )}
              {a.name}
            </button>
          ))}
        </div>
        <label className="chat-list-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            placeholder="Find a conversation"
            aria-label="Search chats"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(12);
            }}
          />
          {query && (
            <button aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={15} />
            </button>
          )}
        </label>
      </div>
      {failure && (
        <p className="chat-list-note" role="alert">
          {failure}
        </p>
      )}
      {Object.entries(errors).map(([who, error]) => (
        <p key={who} className="chat-list-note" role="alert">
          {agentLabel(who)}: {error}
        </p>
      ))}
      {!sessions ? (
        <p className="chat-list-note" role="status">
          <Loader2 size={15} className="spin" /> Finding your conversations…
        </p>
      ) : !found.length ? (
        <div className="chat-list-empty">
          <MessageSquare size={28} />
          <strong>
            {q ? "No conversations found" : "Room for your next idea"}
          </strong>
          <p>
            {q
              ? "Try another title, project, or app."
              : `Start a chat with Codex or Claude on ${peer.name}.`}
          </p>
          {!q && (
            <button className="chat-create" onClick={onNew}>
              <Plus size={16} /> Start a conversation
            </button>
          )}
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <section className="chat-group" aria-label="In progress">
              <h2>
                In progress <span>{active.length}</span>
              </h2>
              {cards(active)}
            </section>
          )}
          {recent.length > 0 && (
            <section className="chat-group" aria-label="Recent conversations">
              <h2>
                {active.length ? "Recent conversations" : "Your conversations"}
                <span>{found.length}</span>
              </h2>
              {cards(recent)}
            </section>
          )}
          {found.length > limit && (
            <button
              className="chat-list-more"
              onClick={() => setLimit((n) => n + 12)}
            >
              Show more conversations
            </button>
          )}
        </>
      )}
      {!compact && (
        <p className="chat-library-caption">
          Your conversations stay with their app. Everything is within reach.
        </p>
      )}
    </div>
  );
}
