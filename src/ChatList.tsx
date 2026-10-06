import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  RefreshCw,
  FolderOpen,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  ChevronRight,
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

export type ChatAppChoice = { agent: string; name: string; supported: boolean };
const supportedApps: ChatAppChoice[] = [
  { agent: "codex", name: "Codex", supported: true },
  { agent: "claude", name: "Claude", supported: true },
];

export function ChatAppPicker({
  apps = supportedApps,
  value,
  onChange,
  logos,
  pending = {},
}: {
  apps?: ChatAppChoice[];
  value: string;
  onChange: (value: string) => void;
  logos: AgentLogos;
  pending?: Record<string, number>;
}) {
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep an expanding name inside this rail without moving the page.
    const timer = window.setTimeout(() => {
      const track = rail.current;
      const selected = track?.querySelector<HTMLElement>(
        '[aria-pressed="true"]',
      );
      if (!track || !selected) return;
      const trackBox = track.getBoundingClientRect();
      const selectedBox = selected.getBoundingClientRect();
      if (selectedBox.right > trackBox.right)
        track.scrollLeft += selectedBox.right - trackBox.right;
      else if (selectedBox.left < trackBox.left)
        track.scrollLeft -= trackBox.left - selectedBox.left;
    }, 200);
    return () => window.clearTimeout(timer);
  }, [value]);
  return (
    <div
      ref={rail}
      className="chat-app-rail chat-filters"
      role="group"
      aria-label="Choose an app"
    >
      {apps.map((app) => (
        <button
          key={app.agent}
          className={`chat-app-token ${app.supported ? "" : "upcoming"}`}
          aria-label={app.name}
          aria-description={
            app.supported
              ? pending[app.agent]
                ? `${pending[app.agent]} requests need you`
                : undefined
              : "Coming soon"
          }
          aria-pressed={value === app.agent}
          title={`${app.name}${app.supported ? "" : " · Coming soon"}`}
          onClick={() => onChange(app.agent)}
        >
          <span className="chat-app-symbol">
            <AgentLogo
              agent={app.agent}
              name={app.name}
              logos={logos}
              size={22}
            />
            {!!pending[app.agent] && (
              <span className="chat-app-pending" aria-hidden="true">
                {pending[app.agent] > 9 ? "9+" : pending[app.agent]}
              </span>
            )}
          </span>
          <span className="chat-app-name" aria-hidden="true">
            <span>{app.name}</span>
          </span>
          {!app.supported && (
            <span className="chat-app-soon-dot" aria-hidden="true" />
          )}
        </button>
      ))}
    </div>
  );
}

export function ChatComingSoon({
  app,
  logos,
}: {
  app: ChatAppChoice;
  logos: AgentLogos;
}) {
  return (
    <div className="chat-coming-soon" role="status">
      <AgentLogo agent={app.agent} name={app.name} logos={logos} size={32} />
      <strong>{app.name}</strong>
      <span>Coming soon</span>
      <p>
        Your {app.name} conversations will be available here when the
        integration is ready.
      </p>
    </div>
  );
}

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
  apps = supportedApps,
  agent,
  onAgentChange,
  appPending,
  setup,
  canStart = true,
  onRefresh,
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
  apps?: ChatAppChoice[];
  onAgentChange?: (agent: string) => void;
  appPending?: Record<string, number>;
  setup?: ReactNode;
  canStart?: boolean;
  onRefresh?: () => void;
}) {
  const [localAgent, setLocalAgent] = useState(
    agent || apps[0]?.agent || "codex",
  );
  const filter = agent || localAgent;
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const all = useMemo(
    () =>
      (sessions || [])
        .filter((s) => !s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const picked = apps.find((a) => a.agent === filter);
  const upcoming = picked?.supported === false;
  const q = query.trim().toLowerCase();
  const found = all.filter(
    (s) =>
      s.agent === filter &&
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
  const projects = new Map<string, AgentSession[]>();
  for (const s of recent) {
    const key = s.cwd || "";
    projects.set(key, [...(projects.get(key) || []), s]);
  }
  const cards = (list: AgentSession[], showProject = false) => (
    <div className="chat-entries">
      {list.map((s) => (
        <button
          key={`${s.agent}:${s.id}`}
          className={`chat-card ${needsYou(s) ? "waiting" : s.status}`}
          aria-label={`${s.title || "New chat"}, ${agentLabel(s.agent)}`}
          onClick={() => onOpen(s)}
        >
          <span className="chat-entry-logo" title={agentLabel(s.agent)}>
            <AgentLogo agent={s.agent} logos={logos} size={20} />
          </span>
          <span className="chat-entry-copy">
            <strong>{s.title || "New chat"}</strong>
            <span className="chat-card-preview">
              {/* Continued from a chat with the other agent, as if forked. */}
              {s.movedFrom && (
                <span className="chat-card-moved">
                  <AgentLogo agent={s.movedFrom.agent} logos={logos} size={12} />
                  From {agentLabel(s.movedFrom.agent)} ·{" "}
                </span>
              )}
              {s.prompts?.[0]?.title ||
                s.preview ||
                (s.movedFrom ? `Continues “${s.movedFrom.title || "a chat"}”` : "No messages yet")}
            </span>
            {showProject && (
              <span className="chat-entry-context">
                <span>{projectName(s.cwd) || "Workspace"}</span>
                <span
                  className={`chat-card-state ${needsYou(s) ? "waiting" : s.status}`}
                >
                  {needsYou(s) ? (
                    <>
                      <span className="chat-state-dot" /> Needs you
                    </>
                  ) : (
                    <>
                      <Loader2 size={11} className="spin" /> Working
                    </>
                  )}
                </span>
              </span>
            )}
          </span>
          <span className="chat-entry-tail">
            <time
              className="chat-card-time"
              dateTime={new Date(s.updatedAt).toISOString()}
            >
              {ago(s.updatedAt)}
            </time>
            {s.status === "error" && !needsYou(s) ? (
              <span className="chat-card-state error">Stopped</span>
            ) : (
              <ChevronRight className="chat-entry-arrow" size={15} />
            )}
          </span>
        </button>
      ))}
    </div>
  );
  return (
    <div className={`chat-library ${compact ? "compact" : ""}`}>
      {!compact && (
        <header className="chat-list-top">
          <div className="chat-list-heading">
            <h1>Chats</h1>
            <span className="chat-list-device">{peer.name}</span>
          </div>
          <div className="chat-heading-actions">
          {onRefresh && <button className="chat-refresh" aria-label="Refresh apps and chats" onClick={onRefresh}><RefreshCw size={16} /></button>}
          {!upcoming && canStart && (
            <button
              className="chat-create"
              aria-label="New chat"
              onClick={onNew}
            >
              <Plus size={16} />
              <span>New chat</span>
            </button>
          )}
          </div>
        </header>
      )}
      <div className="chat-library-tools">
        <ChatAppPicker
          apps={apps}
          logos={logos}
          value={filter}
          pending={appPending}
          onChange={(value) => {
            (onAgentChange || setLocalAgent)(value);
            setLimit(12);
          }}
        />
        {!upcoming && (
          <label className="chat-list-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              placeholder="Search chats"
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
        )}
      </div>
      {setup}
      {!!pending && onReview && !compact && !found.length && (
        <button
          className="chat-review-link chat-review-empty"
          onClick={onReview}
        >
          <ShieldCheck size={13} /> Review {pending}{" "}
          {pending === 1 ? "request" : "requests"}
          <ArrowUpRight size={13} />
        </button>
      )}
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
      {upcoming && picked ? (
        <ChatComingSoon app={picked} logos={logos} />
      ) : !sessions ? (
        <p className="chat-list-note" role="status">
          <Loader2 size={15} className="spin" /> Finding your conversations…
        </p>
      ) : !found.length && setup && !q ? null : !found.length ? (
        <div className="chat-list-empty">
          <MessageSquare size={28} />
          <strong>
            {q ? "No conversations found" : "Room for your next idea"}
          </strong>
          <p>
            {q
              ? "Try another title, project, or app."
              : `Start a ${picked?.name || agentLabel(filter)} chat on ${peer.name}.`}
          </p>
          {!q && canStart && (
            <button className="chat-create" onClick={onNew}>
              <Plus size={16} /> Start a conversation
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Nothing at work, but something waits: one row to review it,
              not a heading over an empty space. */}
          {!active.length && !!pending && onReview && !compact && (
            <button className="chat-needs-row" onClick={onReview}>
              <ShieldCheck size={16} />
              <span>
                {pending} {pending === 1 ? "request needs" : "requests need"} you
              </span>
              <span className="chat-needs-row-go">
                Review <ArrowUpRight size={14} />
              </span>
            </button>
          )}
          {active.length > 0 && (
            <section
              className="chat-group chat-active-group"
              aria-label="In progress"
            >
              <div className="chat-group-heading">
                <h2>
                  In progress <span>{active.length}</span>
                </h2>
                {!!pending && onReview && !compact && (
                  <button className="chat-review-link" onClick={onReview}>
                    <ShieldCheck size={13} />
                    <span>
                      Review {pending} {pending === 1 ? "request" : "requests"}
                    </span>
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
              {cards(active, true)}
            </section>
          )}
          {recent.length > 0 && (
            <section
              className="chat-projects"
              aria-label="Recent conversations"
            >
              {[...projects.entries()].map(([cwd, list]) => (
                <section
                  className="chat-group chat-project-group"
                  key={cwd}
                  aria-label={`${projectName(cwd) || "Workspace"} conversations`}
                >
                  <div className="chat-group-heading">
                    <h2 title={cwd || undefined}>
                      <FolderOpen size={14} />
                      <span className="chat-project-name">
                        {projectName(cwd) || "Workspace"}
                      </span>
                      <span>{list.length}</span>
                    </h2>
                  </div>
                  {cards(list)}
                </section>
              ))}
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
    </div>
  );
}
