import { useMemo, useRef, useState, type RefObject } from "react";
import { ArrowUpRight, FolderOpen, Loader2, Search, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, cancelRelay, projectName, type AgentSession, type Relay, type Team } from "./agent-sessions";
import { ChatLibraryHeader, ago, needsYou, plainLine, type ChatAppChoice } from "./ChatList";
import { relayLine } from "./Relays";
import type { FleetConnections } from "./useFleetConnections";
import {
  chatComputers,
  computerNames,
  listRevision,
  presence,
  sayAbsent,
  useAskEveryComputer,
  useEveryComputer,
  type Absence,
} from "./fleet-chats";
import "./chat-hub.css";

// The All page (docs/ACROSS_AGENTS.md): every agent's chats at once, which
// neither app can show, on every computer this phone is paired with. One
// search across them all, relays under way, and projects: chats grouped by
// folder whatever their agent, with the files each changed lately and a
// warning when two changed the same file. Each computer reads its own
// (server/agent-sessions: search.mjs, overlaps.mjs) and answers on its own
// (fleet-chats.ts); a row from another computer opens there.

type Ref = { agent: string; id: string; title?: string };
// A computer's chats (not archived), as it listed them.
type ComputerChats = { computer: Peer; sessions: AgentSession[] };
type Activity = {
  chats: { agent: string; id: string; title: string; cwd: string; files: { file: string; at: number }[] }[];
  overlaps: { file: string; chats: { agent: string; id: string; title: string; at: number }[] }[];
};
type Hit = { agent: string; id: string; role: string; at: number; snippet: string; title: string; cwd: string; listed: boolean };

// A chat's project: a Claude app worktree belongs to its project's folder.
export const projectOf = (cwd: string) => (cwd || "").replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/, "");
const base = (file: string) => file.split(/[\\/]/).pop() || file;
// The chats that changed one file, each name once: two chats with the same
// name (a chat and the one split off from it, say) are "two Claude Code chats
// named …", never one name twice.
const COUNTS = ["", "one", "two", "three", "four"];
const whoChanged = (chats: { agent: string; title: string }[]) => {
  const named = new Map<string, { agent: string; title: string; n: number }>();
  for (const c of chats) {
    const title = plainLine(c.title) || "a chat";
    const one = named.get(`${c.agent}\n${title}`) || { agent: c.agent, title, n: 0 };
    one.n++;
    named.set(`${c.agent}\n${title}`, one);
  }
  const said = [...named.values()].map(({ agent, title, n }) =>
    n > 1 ? `${COUNTS[n] || n} ${agentLabel(agent)} chats named “${title}”` : `${agentLabel(agent)} (“${title}”)`,
  );
  return said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0] || "";
};
// Which computer a row is on, when the page covers more than one.
const Where = ({ computer }: { computer: Peer }) => <span className="hub-computer">{computer.name}</span>;

// One search across every agent's conversations on every computer: the
// chats' names at once, what was said in them from each computer as it
// answers, newest first.
function SearchAll({
  computers,
  lists,
  labelled,
  logos,
  field,
  onOpen,
}: {
  computers: Peer[];
  lists: ComputerChats[];
  labelled: boolean;
  logos: AgentLogos;
  field: RefObject<HTMLInputElement | null>;
  onOpen: (computer: Peer, chat: Ref) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const found = useAskEveryComputer<{ results: Hit[]; partial: boolean }>(
    computers,
    q.length >= 2 ? `/api/sessions/search?q=${encodeURIComponent(q)}` : null,
    300,
  );
  const busy = !!found?.waiting.length;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const named = q
    ? lists
        .flatMap(({ computer, sessions }) =>
          sessions
            .filter((s) => !s.archived && words.every((w) => [s.title, projectName(s.cwd), agentLabel(s.agent)].join(" ").toLowerCase().includes(w)))
            .map((s) => ({ computer, s })),
        )
        .sort((a, b) => b.s.updatedAt - a.s.updatedAt)
        .slice(0, 5)
    : [];
  const answered = computers.flatMap((computer) => {
    const value = found?.answers[computer.id]?.value;
    return value ? [{ computer, value }] : [];
  });
  const said = answered
    .flatMap(({ computer, value }) => (Array.isArray(value.results) ? value.results : []).filter((h) => h.listed).map((h) => ({ computer, h })))
    .sort((a, b) => (b.h.at || 0) - (a.h.at || 0));
  const partial = answered.filter(({ value }) => value.partial).map(({ computer }) => computer.name);
  const failed = computers.flatMap((computer) => {
    const answer = found?.answers[computer.id];
    return answer?.absence ? [{ name: computer.name, absence: answer.absence, message: answer.message || "" }] : [];
  });
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
          {named.map(({ computer, s }) => (
            <button
              key={`n:${computer.id}:${s.agent}:${s.id}`}
              className="hub-hit"
              onClick={() => onOpen(computer, { agent: s.agent, id: s.id, title: s.title })}
            >
              <AgentLogo agent={s.agent} logos={logos} size={16} />
              <span className="hub-hit-copy">
                <strong>{plainLine(s.title || "") || "New chat"}</strong>
                <small>
                  {labelled && <Where computer={computer} />}
                  {agentLabel(s.agent)} · {projectName(s.cwd)}
                </small>
              </span>
              <time>{ago(s.updatedAt)}</time>
            </button>
          ))}
          {said.map(({ computer, h }, i) => (
            <button
              key={`s:${computer.id}:${h.agent}:${h.id}:${i}`}
              className="hub-hit"
              onClick={() => onOpen(computer, { agent: h.agent, id: h.id, title: h.title })}
            >
              <AgentLogo agent={h.agent} logos={logos} size={16} />
              <span className="hub-hit-copy">
                <strong>{plainLine(h.title) || "A chat"}</strong>
                <small>
                  {labelled && <Where computer={computer} />}
                  {h.role === "user" ? "You: " : `${agentLabel(h.agent)}: `}
                  {h.snippet}
                </small>
              </span>
              {!!h.at && <time>{ago(h.at)}</time>}
            </button>
          ))}
          {!busy && answered.length > 0 && !named.length && !said.length && <p className="hub-note">Nothing found in any chat.</p>}
          {partial.length > 0 && (
            <p className="hub-note">
              Still reading older chats{labelled ? ` on ${computerNames(partial)}` : ""}; search again in a moment for those.
            </p>
          )}
          {failed.length > 0 && (
            <p className="hub-note bad">{computers.length > 1 ? sayAbsent(failed) : failed[0].message}</p>
          )}
        </div>
      )}
    </section>
  );
}

export default function ChatHub({
  peer,
  computers,
  connections,
  sessions,
  relays,
  teams = [],
  logos,
  apps,
  appPending,
  pending,
  onAgentChange,
  onOpen,
  onOpenOn,
  onNew,
  onRefresh,
  onReview,
  onRelaysChanged,
}: {
  peer: Peer;
  // Every computer this phone is paired with, and their live connections
  // (useFleetConnections): the page covers them all.
  computers?: Peer[];
  connections?: FleetConnections;
  sessions: AgentSession[] | null;
  relays: Relay[];
  teams?: Team[];
  logos: AgentLogos;
  apps: ChatAppChoice[];
  appPending: Record<string, number>;
  pending: number;
  onAgentChange: (agent: string) => void;
  onOpen: (chat: Ref) => void;
  // A chat on another computer: switches to that computer and opens it there.
  onOpenOn?: (computer: Peer, chat: Ref) => void;
  onNew?: (cwd?: string) => void;
  onRefresh?: () => void;
  onReview?: () => void;
  onRelaysChanged?: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  // This computer first, then the others (when a chat there can be opened).
  const fleet = useMemo(() => (onOpenOn ? chatComputers(peer, computers) : [peer]), [peer, computers, !!onOpenOn]);
  const others = fleet.slice(1);
  // The others' chat lists (this one's is the live feed), read again when a
  // computer says its list changed.
  const lists = useEveryComputer<{ sessions?: AgentSession[] }>(others, () => "/api/sessions", 20000, {
    connections,
    versioned: true,
    nudge: (p) => `${presence(connections?.[p.id])} ${listRevision(connections?.[p.id])}`,
  });
  const activities = useEveryComputer<Activity>(fleet, () => "/api/sessions/activity", 20000, {
    connections,
    nudge: (p) => presence(connections?.[p.id]),
  });
  const activityOf = (computer: Peer) => activities[computer.id]?.value;
  // The computers whose chats aren't here, and why (one still being asked
  // isn't said: its chats usually follow in a moment).
  const absent = others.flatMap((computer) => {
    const absence = lists[computer.id]?.absence;
    return absence && absence !== "asking" ? [{ computer, absence }] : [];
  });
  const missing = (computer: Peer, ...why: Absence[]) => absent.some((a) => a.computer.id === computer.id && why.includes(a.absence));
  // The ones that can show chats here (not one that keeps them from this
  // phone), and the ones to ask (not one that wants this phone paired again).
  const covered = fleet.filter((computer) => !missing(computer, "owner"));
  const asked = covered.filter((computer) => !missing(computer, "access"));
  const labelled = covered.length > 1;
  const names = computerNames(covered.map((computer) => computer.name));
  const openOn = (computer: Peer, chat: Ref) => (computer.id === peer.id ? onOpen(chat) : onOpenOn?.(computer, chat));
  const [opened, setOpened] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [cancelling, setCancelling] = useState("");
  const all = useMemo(() => (sessions || []).filter((s) => !s.archived), [sessions]);
  const chatLists = useMemo<ComputerChats[]>(
    () => [
      { computer: peer, sessions: all },
      ...others.flatMap((computer) => {
        const list = lists[computer.id]?.value?.sessions;
        return Array.isArray(list) ? [{ computer, sessions: list.filter((s) => !s.archived) }] : [];
      }),
    ],
    [peer, all, lists],
  );
  // Projects across agents, the one with the newest chat first. The same
  // folder on two computers is two projects.
  const projects = useMemo(() => {
    const map = new Map<string, { computer: Peer; root: string; list: AgentSession[] }>();
    for (const { computer, sessions } of chatLists)
      for (const s of sessions) {
        const root = projectOf(s.cwd);
        const key = `${computer.id}\n${root}`;
        const group = map.get(key) || { computer, root, list: [] };
        group.list.push(s);
        map.set(key, group);
      }
    const rank = (s: AgentSession) => (needsYou(s) ? 2 : s.status === "running" ? 1 : 0);
    return [...map.entries()]
      .map(([key, group]) => ({ ...group, key, list: group.list.sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt) }))
      .sort((a, b) => Math.max(...b.list.map((s) => s.updatedAt)) - Math.max(...a.list.map((s) => s.updatedAt)));
  }, [chatLists]);
  const changedBy = new Map(
    fleet.flatMap((computer) => {
      const chats = activityOf(computer)?.chats;
      return (Array.isArray(chats) ? chats : []).map((c) => [`${computer.id}\n${c.agent}:${c.id}`, c] as const);
    }),
  );
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
      <p className="hub-lead">Every agent’s chats on {names}, together.</p>
      {absent.length > 0 && (
        <p className="hub-fleet-note" role="status">
          {sayAbsent(absent.map(({ computer, absence }) => ({ name: computer.name, absence })))}
        </p>
      )}
      <SearchAll computers={asked} lists={chatLists} labelled={labelled} logos={logos} field={field} onOpen={openOn} />
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
          {(more ? projects : projects.slice(0, 8)).map(({ key, computer, root, list }) => {
            const open = opened.includes(key);
            // Two chats changing one file: on the same computer only.
            const overlaps = activityOf(computer)?.overlaps;
            const warn = (Array.isArray(overlaps) ? overlaps : []).filter((o) => root && o.file.startsWith(root.replace(/[\\/]$/, "") + "/"));
            const agents = [...new Set(list.map((s) => s.agent))];
            return (
              <section
                className="chat-group chat-project-group hub-project"
                key={key}
                aria-label={`${projectName(root) || "Workspace"} conversations${labelled ? ` on ${computer.name}` : ""}`}
              >
                <div className="chat-group-heading">
                  <h2 title={root || undefined}>
                    <FolderOpen size={14} />
                    <span className="chat-project-name">{projectName(root) || "Workspace"}</span>
                    <span className="hub-project-agents" aria-label={agents.map(agentLabel).join(", ")}>
                      {agents.map((a) => (
                        <AgentLogo key={a} agent={a} logos={logos} size={13} />
                      ))}
                    </span>
                    {labelled && <Where computer={computer} />}
                  </h2>
                </div>
                {warn.map((o) => (
                  <p key={o.file} className="hub-overlap" role="note">
                    <TriangleAlert size={14} />
                    <span>
                      <strong>{o.file.slice(root.replace(/[\\/]$/, "").length + 1) || base(o.file)}</strong> changed by{" "}
                      {whoChanged(o.chats)} in the last half hour.
                    </span>
                  </p>
                ))}
                <div className="chat-entries">
                  {(open ? list : list.slice(0, 4)).map((s) => {
                    const files = changedBy.get(`${computer.id}\n${s.agent}:${s.id}`)?.files || [];
                    return (
                      <button
                        key={`${s.agent}:${s.id}`}
                        className={`chat-card ${needsYou(s) ? "waiting" : s.status}`}
                        aria-label={`${s.title || "New chat"}, ${agentLabel(s.agent)}${labelled ? `, on ${computer.name}` : ""}`}
                        onClick={() => openOn(computer, s)}
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
                  <button className="chat-list-more" onClick={() => setOpened((o) => (open ? o.filter((r) => r !== key) : [...o, key]))}>
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
          {!projects.length && <p className="chat-list-note">No conversations yet on {names}.</p>}
        </section>
      )}
    </div>
  );
}
