import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowUpRight, Check, FolderOpen, Loader2, Search, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { request, type Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, cancelRelay, projectName, type AgentSession, type Relay, type Team } from "./agent-sessions";
import { ChatLibraryHeader, ago, needsYou, plainLine, type ChatAppChoice } from "./ChatList";
import { relayLine } from "./Relays";
import "./chat-hub.css";

// The All page (docs/ACROSS_AGENTS.md): every agent's chats at once, which
// neither app can show. What happened while you were away, one search across
// them all, relays under way, and projects: chats grouped by folder whatever
// their agent, with the files each changed lately and a warning when two
// changed the same file. The Mac reads it all (server/agent-sessions:
// journal.mjs, search.mjs, overlaps.mjs).

type Ref = { agent: string; id: string; title?: string };
type JournalEvent = { id: string; kind: string; agent: string; chat: string; title: string; cwd?: string; files?: number; text?: string; at: number };
type Activity = {
  chats: { agent: string; id: string; title: string; cwd: string; files: { file: string; at: number }[] }[];
  overlaps: { file: string; chats: { agent: string; id: string; title: string; at: number }[] }[];
};
type Hit = { agent: string; id: string; role: string; at: number; snippet: string; title: string; cwd: string; listed: boolean };

// A chat's project: a Claude app worktree belongs to its project's folder.
export const projectOf = (cwd: string) => (cwd || "").replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/, "");
const base = (file: string) => file.split(/[\\/]/).pop() || file;
// Where the phone last looked, per computer (what came after is news).
const SEEN = "reach.lastSeen:";
const readSeen = (peer: string) => {
  try {
    return Number(localStorage.getItem(SEEN + peer)) || 0;
  } catch {
    return 0;
  }
};
const saveSeen = (peer: string, at: number) => {
  try {
    localStorage.setItem(SEEN + peer, String(at));
  } catch {
    /* this visit only */
  }
};

// Loaded while the page shows, and every `everyMs` (a page that's hidden waits).
function usePolled<T>(peer: Peer, path: string | null, everyMs: number) {
  const [value, setValue] = useState<T | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () =>
      !document.hidden &&
      request<T>(peer, path).then(
        (r) => live && (setValue(r), setFailure("")),
        (e) => live && setFailure((e as Error).message),
      );
    void load();
    const timer = everyMs ? setInterval(load, everyMs) : undefined;
    const shown = () => !document.hidden && void load();
    document.addEventListener("visibilitychange", shown);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [peer.url, peer.token, path, everyMs]);
  return { value, failure, setValue };
}

// "While you were away": what came since the phone last looked.
function AwayReport({ peer, logos, onOpen }: { peer: Peer; logos: AgentLogos; onOpen: (chat: Ref) => void }) {
  const [since, setSince] = useState(() => readSeen(peer.id) || Date.now() - 12 * 60 * 60 * 1000);
  const { value } = usePolled<{ events: JournalEvent[]; waiting: Ref[]; now: number }>(peer, `/api/sessions/journal?since=${since}`, 60000);
  const events = Array.isArray(value?.events) ? value.events : [];
  const finished = events.filter((e) => e.kind === "finished");
  // Each chat once (its latest), the ones that need a look first.
  const lines = useMemo(() => {
    const seen = new Set<string>();
    const order = ["usage", "failed", "relay-stopped", "relayed", "finished"];
    return [...events]
      .filter((e) => order.includes(e.kind))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.at - a.at)
      .filter((e) => {
        const key = `${e.agent}:${e.chat}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);
  }, [events]);
  const waiting = Array.isArray(value?.waiting) ? value.waiting : [];
  if (!value || (!lines.length && !waiting.length)) return null;
  const files = new Map<string, number>();
  for (const e of finished) files.set(e.agent, (files.get(e.agent) || 0) + (e.files || 0));
  const changed = [...files].filter(([, n]) => n > 0).map(([agent, n]) => `${agentLabel(agent)} changed ${n} file${n === 1 ? "" : "s"}`);
  const chats = new Set(finished.map((e) => `${e.agent}:${e.chat}`)).size;
  const say = (e: JournalEvent) => {
    const name = `“${plainLine(e.title) || "a chat"}”`;
    if (e.kind === "usage") return `${agentLabel(e.agent)} ran out of usage in ${name}`;
    if (e.kind === "failed") return `${name} ended on an error`;
    if (e.kind === "relay-stopped") return `A relay stopped: ${e.text || name}`;
    if (e.kind === "relayed") return `Relayed to ${agentLabel(e.agent)}: ${name}`;
    return `${name} finished${e.files ? ` · ${e.files} file${e.files === 1 ? "" : "s"} changed` : ""}`;
  };
  const seenNow = () => {
    saveSeen(peer.id, value.now);
    setSince(value.now);
  };
  return (
    <section className="hub-card hub-away" aria-label="While you were away">
      <header>
        <h2>While you were away</h2>
        <small>since {new Date(since).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>
      </header>
      <p className="hub-away-sum">
        {[
          chats && `${chats} chat${chats === 1 ? "" : "s"} finished`,
          waiting.length && `${waiting.length} waiting on you`,
          ...changed,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <ul>
        {waiting.slice(0, 3).map((w) => (
          <li key={`w:${w.agent}:${w.id}`}>
            <button onClick={() => onOpen(w)}>
              <AgentLogo agent={w.agent} logos={logos} size={16} />
              <span>Waiting on you: “{plainLine(w.title || "") || "a chat"}”</span>
            </button>
          </li>
        ))}
        {lines.map((e) => (
          <li key={e.id} className={e.kind}>
            <button onClick={() => (seenNow(), onOpen({ agent: e.agent, id: e.chat, title: e.title }))}>
              <AgentLogo agent={e.agent} logos={logos} size={16} />
              <span>{say(e)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="hub-got-it" onClick={seenNow}>
        <Check size={14} /> Got it
      </button>
    </section>
  );
}

// One search across every agent's conversations: the chats' names at once,
// what was said in them from the Mac.
function SearchAll({
  peer,
  sessions,
  logos,
  field,
  onOpen,
}: {
  peer: Peer;
  sessions: AgentSession[];
  logos: AgentLogos;
  field: RefObject<HTMLInputElement | null>;
  onOpen: (chat: Ref) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ q: string; results: Hit[]; partial: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setBusy(true);
      request<{ results: Hit[]; partial: boolean }>(peer, `/api/sessions/search?q=${encodeURIComponent(q)}`)
        .then(
          (r) => live && (setHits({ q, results: Array.isArray(r?.results) ? r.results : [], partial: !!r?.partial }), setFailure("")),
          (e) => live && setFailure((e as Error).message),
        )
        .finally(() => live && setBusy(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, peer.url, peer.token]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const named = q
    ? sessions
        .filter((s) => !s.archived && words.every((w) => [s.title, projectName(s.cwd), agentLabel(s.agent)].join(" ").toLowerCase().includes(w)))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
    : [];
  const said = (hits?.q === q ? hits.results : []).filter((h) => h.listed);
  return (
    <section className="hub-search" aria-label="Search all chats">
      <label className="chat-list-search">
        <Search size={16} aria-hidden="true" />
        <input
          ref={field}
          type="search"
          placeholder="Search all chats"
          aria-label="Search all chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {busy ? (
          <Loader2 size={15} className="spin" />
        ) : (
          query && (
            <button aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={15} />
            </button>
          )
        )}
      </label>
      {q.length >= 2 && (
        <div className="hub-results">
          {named.map((s) => (
            <button key={`n:${s.agent}:${s.id}`} className="hub-hit" onClick={() => onOpen(s)}>
              <AgentLogo agent={s.agent} logos={logos} size={16} />
              <span className="hub-hit-copy">
                <strong>{plainLine(s.title || "") || "New chat"}</strong>
                <small>
                  {agentLabel(s.agent)} · {projectName(s.cwd)}
                </small>
              </span>
              <time>{ago(s.updatedAt)}</time>
            </button>
          ))}
          {said.map((h, i) => (
            <button key={`s:${h.agent}:${h.id}:${i}`} className="hub-hit" onClick={() => onOpen(h)}>
              <AgentLogo agent={h.agent} logos={logos} size={16} />
              <span className="hub-hit-copy">
                <strong>{plainLine(h.title) || "A chat"}</strong>
                <small>
                  {h.role === "user" ? "You: " : `${agentLabel(h.agent)}: `}
                  {h.snippet}
                </small>
              </span>
              {!!h.at && <time>{ago(h.at)}</time>}
            </button>
          ))}
          {!busy && hits?.q === q && !named.length && !said.length && <p className="hub-note">Nothing found in any chat.</p>}
          {hits?.q === q && hits.partial && <p className="hub-note">Still reading older chats; search again in a moment for those.</p>}
          {failure && <p className="hub-note bad">{failure}</p>}
        </div>
      )}
    </section>
  );
}

export default function ChatHub({
  peer,
  sessions,
  relays,
  teams = [],
  logos,
  apps,
  appPending,
  pending,
  onAgentChange,
  onOpen,
  onNew,
  onRefresh,
  onReview,
  onRelaysChanged,
}: {
  peer: Peer;
  sessions: AgentSession[] | null;
  relays: Relay[];
  teams?: Team[];
  logos: AgentLogos;
  apps: ChatAppChoice[];
  appPending: Record<string, number>;
  pending: number;
  onAgentChange: (agent: string) => void;
  onOpen: (chat: Ref) => void;
  onNew?: (cwd?: string) => void;
  onRefresh?: () => void;
  onReview?: () => void;
  onRelaysChanged?: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const { value: activity } = usePolled<Activity>(peer, "/api/sessions/activity", 20000);
  const [opened, setOpened] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [cancelling, setCancelling] = useState("");
  const all = useMemo(() => (sessions || []).filter((s) => !s.archived), [sessions]);
  // Projects across agents, the one with the newest chat first.
  const projects = useMemo(() => {
    const map = new Map<string, AgentSession[]>();
    for (const s of all) {
      const key = projectOf(s.cwd);
      map.set(key, [...(map.get(key) || []), s]);
    }
    const rank = (s: AgentSession) => (needsYou(s) ? 2 : s.status === "running" ? 1 : 0);
    return [...map.entries()]
      .map(([root, list]) => ({ root, list: list.sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt) }))
      .sort((a, b) => Math.max(...b.list.map((s) => s.updatedAt)) - Math.max(...a.list.map((s) => s.updatedAt)));
  }, [all]);
  const changedBy = new Map((Array.isArray(activity?.chats) ? activity.chats : []).map((c) => [`${c.agent}:${c.id}`, c]));
  const live = relays.filter(
    (r) => !r.steps.some((s) => (s.kind as string) === "report") && (["waiting", "sending"].includes(r.state) || Date.now() - r.updatedAt < 60 * 60 * 1000),
  );
  const crews = teams.filter((t) => t.state === "active");
  const cancel = async (r: Relay) => {
    setCancelling(r.id);
    try {
      await cancelRelay(peer, r.id);
      onRelaysChanged?.();
    } catch {
      /* the list says how it stands */
    } finally {
      setCancelling("");
    }
  };
  return (
    <div className="chat-library chat-hub">
      <ChatLibraryHeader
        peer={peer}
        apps={apps}
        value="all"
        logos={logos}
        pending={appPending}
        onChange={onAgentChange}
        onNew={onNew ? () => onNew() : undefined}
        onRefresh={onRefresh}
        searchOpen={false}
        onSearch={() => field.current?.focus()}
      />
      <p className="hub-lead">Every agent’s chats on {peer.name}, together.</p>
      <SearchAll peer={peer} sessions={all} logos={logos} field={field} onOpen={onOpen} />
      {!!pending && onReview && (
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
      <AwayReport peer={peer} logos={logos} onOpen={onOpen} />
      {crews.length > 0 && (
        <section className="hub-card hub-teams" aria-label="Teams">
          <header>
            <h2>Teams</h2>
          </header>
          {crews.map((t) => {
            const working = t.tasks.filter((x) => x.state === "working");
            return (
              <button key={t.id} className="hub-team" onClick={() => onOpen(t.lead)}>
                <span className="hub-team-crew" aria-hidden="true">
                  <AgentLogo agent={t.lead.agent} logos={logos} size={18} />
                  <i />
                  {t.helpers.map((h, n) => (
                    <AgentLogo key={`${h}${n}`} agent={h} logos={logos} size={16} />
                  ))}
                </span>
                <span className="hub-team-copy">
                  <strong>{plainLine(t.title) || "A team"}</strong>
                  <small>
                    {agentLabel(t.lead.agent)} leads ·{" "}
                    {working.length ? `${working.length} helper${working.length === 1 ? "" : "s"} working` : `${t.tasks.length} task${t.tasks.length === 1 ? "" : "s"} so far`}
                  </small>
                </span>
              </button>
            );
          })}
        </section>
      )}
      {live.length > 0 && (
        <section className="hub-card hub-relays" aria-label="Relays">
          <header>
            <h2>Relays</h2>
          </header>
          {live.map((r) => {
            const at = r.chain.at(-1)!;
            return (
              <div key={r.id} className={`relay-row ${r.state}`}>
                <AgentLogo agent={at.agent} logos={logos} size={18} />
                <button className="hub-relay-text" onClick={() => onOpen(at)}>
                  <strong>{plainLine(r.chain[0].title) || "A chat"}</strong>
                  <span>{relayLine(r, r.chain[0])}</span>
                </button>
                {r.state === "waiting" && (
                  <button className="relay-row-action" disabled={cancelling === r.id} aria-label="Cancel relay" onClick={() => void cancel(r)}>
                    {cancelling === r.id ? <Loader2 size={14} className="spin" /> : "Cancel"}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}
      {!sessions ? (
        <p className="chat-list-note" role="status">
          <Loader2 size={15} className="spin" /> Finding your conversations…
        </p>
      ) : (
        <section className="chat-projects" aria-label="Projects">
          <h2 className="chat-projects-title">Projects</h2>
          {(more ? projects : projects.slice(0, 8)).map(({ root, list }) => {
            const open = opened.includes(root);
            const warn = (Array.isArray(activity?.overlaps) ? activity.overlaps : []).filter((o) => root && o.file.startsWith(root.replace(/[\\/]$/, "") + "/"));
            const agents = [...new Set(list.map((s) => s.agent))];
            return (
              <section className="chat-group chat-project-group hub-project" key={root} aria-label={`${projectName(root) || "Workspace"} conversations`}>
                <div className="chat-group-heading">
                  <h2 title={root || undefined}>
                    <FolderOpen size={14} />
                    <span className="chat-project-name">{projectName(root) || "Workspace"}</span>
                    <span className="hub-project-agents" aria-label={agents.map(agentLabel).join(", ")}>
                      {agents.map((a) => (
                        <AgentLogo key={a} agent={a} logos={logos} size={13} />
                      ))}
                    </span>
                  </h2>
                </div>
                {warn.map((o) => (
                  <p key={o.file} className="hub-overlap" role="note">
                    <TriangleAlert size={14} />
                    <span>
                      <strong>{o.file.slice(root.replace(/[\\/]$/, "").length + 1) || base(o.file)}</strong> changed by{" "}
                      {o.chats.map((c) => `${agentLabel(c.agent)} (“${plainLine(c.title) || "a chat"}”)`).join(" and ")} in the last half hour.
                    </span>
                  </p>
                ))}
                <div className="chat-entries">
                  {(open ? list : list.slice(0, 4)).map((s) => {
                    const files = changedBy.get(`${s.agent}:${s.id}`)?.files || [];
                    return (
                      <button
                        key={`${s.agent}:${s.id}`}
                        className={`chat-card ${needsYou(s) ? "waiting" : s.status}`}
                        aria-label={`${s.title || "New chat"}, ${agentLabel(s.agent)}`}
                        onClick={() => onOpen(s)}
                      >
                        <span className="chat-entry-logo" title={agentLabel(s.agent)}>
                          <AgentLogo agent={s.agent} logos={logos} size={18} />
                        </span>
                        <span className="chat-entry-copy">
                          <strong>{plainLine(s.title || "") || "New chat"}</strong>
                          <span className={`chat-card-preview ${files.length ? "hub-changed" : ""}`}>
                            {files.length
                              ? `Changed ${files
                                  .slice(0, 3)
                                  .map((f) => base(f.file))
                                  .join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`
                              : s.prompts?.[0]?.title || plainLine(s.preview || "") || agentLabel(s.agent)}
                          </span>
                        </span>
                        <span className="chat-entry-tail">
                          {needsYou(s) ? (
                            <span className="chat-row-status waiting" aria-label="Needs you" title="Needs you">
                              <span className="chat-state-dot" />
                            </span>
                          ) : s.status === "running" ? (
                            <Loader2 className="chat-row-status spin" size={17} aria-label="Working" />
                          ) : null}
                          <time className="chat-card-time" dateTime={new Date(s.updatedAt).toISOString()}>
                            {ago(s.updatedAt)}
                          </time>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {list.length > 4 && (
                  <button className="chat-list-more" onClick={() => setOpened((o) => (open ? o.filter((r) => r !== root) : [...o, root]))}>
                    {open ? "Show fewer" : `Show all ${list.length}`}
                  </button>
                )}
              </section>
            );
          })}
          {projects.length > 8 && !more && (
            <button className="chat-list-more" onClick={() => setMore(true)}>
              Show {projects.length - 8} more projects
            </button>
          )}
          {!projects.length && <p className="chat-list-note">No conversations yet on {peer.name}.</p>}
        </section>
      )}
    </div>
  );
}
