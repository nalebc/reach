import { useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentNeeds } from "./NeedsYou";
import { agentLabel, projectName, type AgentSession } from "./agent-sessions";
import "./chat-list.css";

// The Chat tab: every agent's chats in one list, the way the agents' apps list
// theirs in their sidebars. What waits for you on top, then what's working,
// then the rest by day. Each row wears its agent's real logo; a tap opens the
// chat in that agent's own look. The Mac's own dialogs aren't chats: they're
// on Home.

const DAY = 86400000;
export const ago = (ms: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
};
// The sidebars' own day groups.
export function dayGroup(ms: number, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= today) return "Today";
  if (ms >= today - DAY) return "Yesterday";
  if (ms >= today - 7 * DAY) return "Previous 7 days";
  return "Older";
}
// Asks that are the agent's own (a command, an edit, a question); the Mac's
// dialogs are listed on Home.
export const needsYou = (s: AgentSession) =>
  s.status === "waiting" || !!s.prompts?.length || !!s.asking || !!s.consent;

type Answer = { label: string; primary?: boolean; run: () => unknown };

function Row({
  session: s,
  logos,
  line,
  answers = [],
  onOpen,
}: {
  session: AgentSession;
  logos: AgentLogos;
  line: string;
  answers?: Answer[];
  onOpen: (s: AgentSession) => void;
}) {
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  const working = s.status === "running";
  return (
    <div className={`chat-row ${s.status}`} data-agent={s.agent}>
      <button className="chat-row-open" onClick={() => onOpen(s)} aria-label={`${s.title}, ${agentLabel(s.agent)}`}>
        <span className={`chat-row-logo ${working ? "working" : ""}`}>
          <AgentLogo agent={s.agent} logos={logos} size={30} />
        </span>
        <span className="chat-row-text">
          <span className="chat-row-title">{s.title || "New chat"}</span>
          <span className="chat-row-line">{problem || line}</span>
        </span>
        {!answers.length && <span className="chat-row-when">{working ? "" : ago(s.updatedAt)}</span>}
      </button>
      {answers.length > 0 && (
        <span className="chat-row-answers">
          {answers.map((a) => (
            <button
              key={a.label}
              className={a.primary ? "primary" : ""}
              disabled={!!busy}
              onClick={async () => {
                setBusy(a.label);
                setProblem("");
                try {
                  await a.run();
                } catch (e) {
                  setProblem((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === a.label ? <Loader2 size={13} className="spin" /> : a.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

export default function ChatList({
  peer,
  sessions,
  logos,
  errors = {},
  failure = "",
  agent,
  onOpen,
  onNew,
  answered,
}: {
  peer: Peer;
  // null while the first list is on its way.
  sessions: AgentSession[] | null;
  logos: AgentLogos;
  errors?: Record<string, string>;
  failure?: string;
  // The agent a new chat starts with (the last one used).
  agent: string;
  onOpen: (s: AgentSession) => void;
  onNew: () => void;
  // After an answer from the list goes through.
  answered?: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [more, setMore] = useState(false);
  const q = query.trim().toLowerCase();
  const all = useMemo(() => {
    const list = (sessions || []).filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return list;
    return list.filter((s) =>
      [s.title, s.preview, projectName(s.cwd), agentLabel(s.agent)].some((t) => t?.toLowerCase().includes(q)),
    );
  }, [sessions, q]);
  const waiting = all.filter(needsYou);
  const working = all.filter((s) => !needsYou(s) && s.status === "running");
  const rest = all.filter((s) => !needsYou(s) && s.status !== "running");
  // The words and one-tap answers Home uses for the same asks.
  const needs = agentNeeds({ peer, sessions: waiting, logos, open: onOpen, answered });
  const groups: { name: string; list: AgentSession[] }[] = [];
  for (const s of more || q ? rest : rest.slice(0, 40)) {
    const name = dayGroup(s.updatedAt);
    const group = groups.find((g) => g.name === name);
    if (group) group.list.push(s);
    else groups.push({ name, list: [s] });
  }
  const restLine = (s: AgentSession) =>
    s.status === "error"
      ? "Stopped with an error"
      : [projectName(s.cwd), s.preview].filter(Boolean).join(" · ");
  const askOf = (s: AgentSession) => {
    const mine = needs.filter((n) => n.key.startsWith(`${s.agent}:${s.id}`));
    const first = mine[0];
    return {
      line: first ? first.title : `${agentLabel(s.agent)} is waiting for you`,
      // One-tap answers only for a single yes/no ask; anything more opens the chat.
      answers: mine.length === 1 && first.actions?.length === 2 ? first.actions : [],
    };
  };
  return (
    <div className="chat-list">
      <header className="chat-list-top">
        <h1>Chats</h1>
        <button
          className="glass-button"
          aria-label={searching ? "Close search" : "Search chats"}
          aria-expanded={searching}
          onClick={() => {
            setSearching(!searching);
            setQuery("");
          }}
        >
          {searching ? <X size={18} /> : <Search size={18} />}
        </button>
      </header>
      {searching && (
        <label className="chat-list-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search chats"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      {failure && <p className="chat-list-note">{failure}</p>}
      {Object.entries(errors).map(([who, error]) => (
        <p key={who} className="chat-list-note">
          {agentLabel(who)}: {error}
        </p>
      ))}
      {!sessions ? (
        <p className="chat-list-note">
          <Loader2 size={15} className="spin" /> Looking for your chats…
        </p>
      ) : !all.length ? (
        q ? (
          <p className="chat-list-note">No chats match.</p>
        ) : (
          <div className="chat-list-empty">
            <strong>Start your first chat</strong>
            <p>Your Codex and Claude Code chats on this computer show up here, newest first.</p>
          </div>
        )
      ) : (
        <>
          {waiting.length > 0 && (
            <section aria-label="Needs you" className="chat-group needs">
              <h2>Needs you</h2>
              {waiting.map((s) => {
                const ask = askOf(s);
                return (
                  <Row key={`${s.agent}:${s.id}`} session={s} logos={logos} line={ask.line} answers={ask.answers} onOpen={onOpen} />
                );
              })}
            </section>
          )}
          {working.length > 0 && (
            <section aria-label="Working" className="chat-group">
              <h2>Working</h2>
              {working.map((s) => (
                <Row key={`${s.agent}:${s.id}`} session={s} logos={logos} line={s.preview || "Working…"} onOpen={onOpen} />
              ))}
            </section>
          )}
          {groups.map((g) => (
            <section key={g.name} aria-label={g.name} className="chat-group">
              <h2>{g.name}</h2>
              {g.list.map((s) => (
                <Row key={`${s.agent}:${s.id}`} session={s} logos={logos} line={restLine(s)} onOpen={onOpen} />
              ))}
            </section>
          ))}
          {!more && !q && rest.length > 40 && (
            <button className="chat-list-more" onClick={() => setMore(true)}>
              Show older chats
            </button>
          )}
        </>
      )}
      {/* A new chat, one thumb away, with the agent you used last. */}
      <button className="chat-list-new" onClick={onNew}>
        <AgentLogo agent={agent} logos={logos} size={24} />
        <span>New chat with {agentLabel(agent)}</span>
      </button>
    </div>
  );
}
