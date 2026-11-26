import { useMemo, useState, type RefObject } from "react";
import { ArrowUpRight, Check, Cpu, FolderOpen, KeyRound, LoaderCircle, Plus, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { viewScope, useViewState, useViewScroll, useSearchFocus } from "./view-memory";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, cancelRelay, projectName, projectOfChat, type AgentHealth, type AgentSession, type Relay, type Team } from "./agent-sessions";
import { quickConnectProvider, type ChatProvider } from "./chat-providers";
import { mergeHealth } from "./usage";
import { BrandCourier } from "./ReachIdentity";
import { ChatLibraryHeader, ago, flowFinder, inFlowTitle, needsYou, plainLine, type ChatAppChoice, type WorkflowsEntry } from "./ChatList";
import { continuedHere, quietRelay, relayLine } from "./Relays";
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
export { projectOf } from "./agent-sessions";
const base = (file: string) => file.split(/[\\/]/).pop() || file;
const priority = (s: AgentSession) => (needsYou(s) ? 2 : s.status === "running" ? 1 : 0);
// Which computer a row is on, when the page covers more than one.
const Where = ({ computer }: { computer: Peer }) => <span className="hub-computer">{computer.name}</span>;

// One search across every agent's conversations on every computer: the
// chats' names at once, what was said in them from each computer as it
// answers, newest first.
function SearchAll({
  scope,
  computers,
  lists,
  labelled,
  logos,
  field,
  onOpen,
}: {
  scope: string;
  computers: Peer[];
  lists: ComputerChats[];
  labelled: boolean;
  logos: AgentLogos;
  field: RefObject<HTMLInputElement | null>;
  onOpen: (computer: Peer, chat: Ref) => void;
}) {
  const [query, setQuery] = useViewState(scope, "query", "");
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
          <LoaderCircle size={15} className="spin" />
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
  active = true,
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
  workflows,
  health = [],
  onProviders,
  providerCount = 0,
  providers = [],
  onReloadProviders,
  onQuickStart,
  currentApp = "all",
}: {
  peer: Peer;
  active?: boolean;
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
  // The Workflows icon at the top (Workflows.tsx).
  workflows?: WorkflowsEntry;
  // This computer's agents (the live feed); the others' are asked here.
  health?: AgentHealth[];
  // Manage API key & local providers (Venice, Ollama, vLLM, OpenAI, Anthropic, custom).
  onProviders?: () => void;
  providerCount?: number;
  providers?: ChatProvider[];
  onReloadProviders?: (refresh?: boolean) => Promise<void> | void;
  onQuickStart?: (agent: string, providerId?: string) => void;
  currentApp?: string;
}) {
  const scope = viewScope(peer, "chats:all");
  const [searchOpen, setSearchOpen] = useViewState(scope, "search", false);
  const { field, requestFocus } = useSearchFocus<HTMLInputElement>(searchOpen);
  const scroll = useViewScroll<HTMLDivElement>(scope, active, sessions !== null);
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
  // Usage is the account's, not the computer's: each agent as the fullest
  // reading any computer has (usage.ts).
  const healths = useEveryComputer<{ agents?: AgentHealth[] }>(others, () => "/api/sessions/health", 60000, {
    connections,
    nudge: (p) => presence(connections?.[p.id]),
  });
  const usage = useMemo(
    () => mergeHealth([health, ...others.map((c) => (Array.isArray(healths[c.id]?.value?.agents) ? healths[c.id].value!.agents! : []))]),
    [health, healths, others],
  );
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
  const openOn = (computer: Peer, chat: Ref) => (computer.id === peer.id ? onOpen(chat) : onOpenOn?.(computer, chat));
  const [opened, setOpened] = useViewState<string[]>(scope, "folders", []);
  const [filter, setFilter] = useViewState<"all" | "subscriptions" | "antigravity" | "api" | "local">(scope, "filter", "all");
  const [cancelling, setCancelling] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [quickKey, setQuickKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyStatus, setKeyStatus] = useState("");
  const [keyError, setKeyError] = useState("");
  const readyProviders = useMemo(() => providers.filter((p) => p.configured || p.reachable), [providers]);
  const all = useMemo(() => (sessions || []).filter((s) => !s.archived), [sessions]);
  const hasAntigravity = useMemo(
    () => all.some((s) => s.agent === "antigravity") || health.some((h) => h.agent === "antigravity" && h.installed),
    [all, health],
  );
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
  const timeGroups = useMemo(() => {
    const flat: { computer: Peer; s: AgentSession }[] = [];
    for (const { computer, sessions } of chatLists) {
      for (const s of sessions) {
        if (filter === "subscriptions" && (s.agent === "api" || s.agent === "antigravity")) continue;
        if (filter === "antigravity" && s.agent !== "antigravity") continue;
        if (filter === "api" && !(s.agent === "api" && s.providerKind !== "local")) continue;
        if (filter === "local" && !(s.agent === "api" && s.providerKind === "local")) continue;
        flat.push({ computer, s });
      }
    }
    flat.sort(
      (a, b) =>
        priority(b.s) - priority(a.s) ||
        (b.s.updatedAt || 0) - (a.s.updatedAt || 0),
    );
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const yesterdayMs = todayMs - 86400_000;
    const buckets: { id: string; label: string; rows: { computer: Peer; s: AgentSession }[] }[] = [
      { id: "active", label: "Active now", rows: [] },
      { id: "today", label: "Today", rows: [] },
      { id: "yesterday", label: "Yesterday", rows: [] },
      { id: "earlier", label: "Earlier", rows: [] },
    ];
    for (const item of flat) {
      if (needsYou(item.s) || item.s.status === "running") buckets[0].rows.push(item);
      else if ((item.s.updatedAt || 0) >= todayMs || now - (item.s.updatedAt || 0) < 3600_000) buckets[1].rows.push(item);
      else if ((item.s.updatedAt || 0) >= yesterdayMs) buckets[2].rows.push(item);
      else buckets[3].rows.push(item);
    }
    return buckets.filter((b) => b.rows.length > 0);
  }, [chatLists, filter]);
  // This computer's workflows: each one's chats together (FlowRuns).
  const flowsOf = useMemo(() => flowFinder(workflows?.list), [workflows?.list]);
  const changedBy = new Map(
    fleet.flatMap((computer) => {
      const chats = activityOf(computer)?.chats;
      return (Array.isArray(chats) ? chats : []).map((c) => [`${computer.id}\n${c.agent}:${c.id}`, c] as const);
    }),
  );
  const live = relays.filter(
    (r) =>
      !r.steps.some((s) => (s.kind as string) === "report") &&
      // Auto-continue that only waits for a limit is a sign in its chat (Relays.tsx).
      !quietRelay(r) &&
      // Continued in the same chat: nothing moved (Relays.tsx).
      !continuedHere(r) &&
      (["waiting", "sending"].includes(r.state) || Date.now() - r.updatedAt < 60 * 60 * 1000),
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
    <div ref={scroll} className="chat-library chat-hub">
      <ChatLibraryHeader
        peer={peer}
        apps={apps}
        value={currentApp}
        logos={logos}
        pending={appPending}
        onChange={onAgentChange}
        onNew={onNew ? () => onNew() : undefined}
        onRefresh={onRefresh}
        workflows={workflows}
        health={usage}
        searchOpen={searchOpen}
        onSearch={() => { if (!searchOpen) requestFocus(); setSearchOpen(!searchOpen); }}
      />
      {absent.length > 0 && (
        <p className="hub-fleet-note" role="status">
          {sayAbsent(absent.map(({ computer, absence }) => ({ name: computer.name, absence })))}
        </p>
      )}
      <div hidden={!searchOpen}>
        <SearchAll scope={scope} computers={asked} lists={chatLists} labelled={labelled} logos={logos} field={field} onOpen={openOn} />
      </div>
      <section className="ac-hero" aria-label="Anything Chat">
        <div className="ac-hero-top">
          <div className="ac-hero-title">
            <span className="ac-hero-mark" aria-hidden="true">
              <Sparkles size={16} />
            </span>
            <div>
              <strong>{currentApp === "antigravity" ? "Antigravity Conversations" : currentApp === "api" ? "API & Local Models" : "Anything Chat"}</strong>
              <small>
                {currentApp === "antigravity"
                  ? "Read local Antigravity sessions & continue them in any model"
                  : "One studio for Codex, Claude, Antigravity, Venice, Ollama, vLLM & any API"}
              </small>
            </div>
          </div>
          <div className="ac-hero-actions">
            <button
              type="button"
              className={`ac-hero-btn ${keyOpen ? "active" : ""}`}
              onClick={() => (setKeyOpen((v) => !v), setKeyError(""), setKeyStatus(""))}
            >
              <KeyRound size={14} />
              <span>{providerCount > 0 ? `+ Key · ${providerCount}` : "+ Paste API Key"}</span>
            </button>
            {onProviders && (
              <button
                type="button"
                className="ac-hero-btn"
                onClick={onProviders}
              >
                <span>Providers</span>
              </button>
            )}
            {onNew && (
              <button
                type="button"
                className="ac-hero-btn primary"
                onClick={() => onNew()}
              >
                <Plus size={14} />
                <span>New chat</span>
              </button>
            )}
          </div>
        </div>

        {(keyOpen || (currentApp === "api" && providerCount === 0)) && (
          <form
            className="ac-inline-key"
            onSubmit={async (e) => {
              e.preventDefault();
              const raw = quickKey.trim();
              if (!raw || keyBusy) return;
              setKeyBusy(true);
              setKeyError("");
              setKeyStatus("");
              try {
                const res = await quickConnectProvider(peer, { key: raw });
                setQuickKey("");
                setKeyOpen(false);
                setKeyStatus(`${res.provider.name} ready · ${res.modelCount} models detected`);
                await onReloadProviders?.(true);
              } catch (err) {
                setKeyError((err as Error).message || "Could not connect key.");
              } finally {
                setKeyBusy(false);
              }
            }}
          >
            <input
              type="password"
              autoComplete="off"
              aria-label="Paste any API key or local URL"
              placeholder="Paste any API key (Venice, OpenAI, Claude, Groq…) or Ollama/vLLM URL"
              value={quickKey}
              onChange={(e) => setQuickKey(e.target.value)}
            />
            <button type="submit" className="cp-primary" disabled={keyBusy || !quickKey.trim()}>
              {keyBusy ? <LoaderCircle size={14} className="spin" /> : <><Check size={14} /> Connect</>}
            </button>
          </form>
        )}
        {keyStatus && <p className="cp-status" role="status">{keyStatus}</p>}
        {keyError && <p className="cp-error" role="alert">{keyError}</p>}

        {onQuickStart && currentApp !== "antigravity" && (
          <div className="ac-launchpad" aria-label="Start chat with any provider">
            <span className="ac-launchpad-label">Start with:</span>
            {health
              .filter((h) => h.installed && ["codex", "claude", "openclaw"].includes(h.agent))
              .map((h) => (
                <button
                  key={h.agent}
                  type="button"
                  className="ac-launch-chip"
                  onClick={() => onQuickStart(h.agent)}
                >
                  <AgentLogo agent={h.agent} logos={logos} size={14} />
                  <span>{h.name || agentLabel(h.agent)}</span>
                </button>
              ))}
            {readyProviders.map((p) => (
              <button
                key={`p:${p.id}`}
                type="button"
                className={`ac-launch-chip ${p.kind === "local" ? "local" : "api"}`}
                onClick={() => onQuickStart("api", p.id)}
              >
                {p.kind === "local" ? <Cpu size={13} /> : <Sparkles size={13} />}
                <span>{p.name}</span>
              </button>
            ))}
            {!readyProviders.length && (
              <button
                type="button"
                className="ac-launch-chip add"
                onClick={() => setKeyOpen(true)}
              >
                <KeyRound size={13} />
                <span>Connect Venice / Ollama / API</span>
              </button>
            )}
          </div>
        )}

        {currentApp === "all" && (
          <div className="hub-filters" role="toolbar" aria-label="Chat filters">
            {(
              [
                ["all", "All"],
                ["subscriptions", "Agents"],
                ...(hasAntigravity ? ([["antigravity", "Antigravity"]] as const) : []),
                ["api", "Cloud API"],
                ["local", "Local"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`hub-filter ${filter === id ? "active" : ""}`}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {apps.length > 1 && (
          <div className="ac-app-strip" role="tablist" aria-label="Switch chat view">
            {apps.map((app) => (
              <button
                key={app.agent}
                type="button"
                role="tab"
                aria-selected={app.agent === currentApp}
                className={`ac-app-pill ${app.agent === currentApp ? "active" : ""}`}
                onClick={() => onAgentChange(app.agent)}
              >
                <AgentLogo agent={app.agent} name={app.name} logos={logos} size={14} />
                <span>{app.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>
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
        <section className="hub-card hub-relays" aria-label="Handoffs">
          <header>
            <h2>Handoffs</h2>
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
                  <button className="relay-row-action" disabled={cancelling === r.id} aria-label="Cancel handoff" onClick={() => void cancel(r)}>
                    {cancelling === r.id ? <LoaderCircle size={14} className="spin" /> : "Cancel"}
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}
      {!sessions ? (
        <p className="chat-list-note" role="status">
          <LoaderCircle size={15} className="spin" /> Finding your conversations…
        </p>
      ) : (
        <section className="ac-feed" aria-label="Conversations">
          {timeGroups.map((bucket) => {
            const open = opened.includes(bucket.id);
            const shown = open ? bucket.rows : bucket.rows.slice(0, bucket.id === "earlier" ? 12 : 20);
            return (
              <section className="ac-bucket" key={bucket.id} aria-label={bucket.label}>
                <header className="ac-bucket-head">
                  <h2>{bucket.label}</h2>
                  <span className="ac-bucket-count">{bucket.rows.length}</span>
                </header>
                <div className="ac-cards">
                  {shown.map(({ computer, s }) => {
                    const files = changedBy.get(`${computer.id}\n${s.agent}:${s.id}`)?.files || [];
                    const folder = s.cwd ? projectName(projectOfChat(s)) : "";
                    const providerTag = s.providerName || agentLabel(s.agent);
                    const badgeClass =
                      s.agent === "api"
                        ? s.providerKind === "local"
                          ? "local"
                          : "api"
                        : s.agent === "antigravity"
                          ? "ag"
                          : "sub";
                    return (
                      <button
                        key={`${computer.id}:${s.agent}:${s.id}`}
                        className={`ac-chat-card ${needsYou(s) ? "waiting" : s.status}`}
                        aria-label={`${s.title || "New chat"}, ${providerTag}${labelled ? `, on ${computer.name}` : ""}`}
                        onClick={() => openOn(computer, s)}
                      >
                        <span className={`ac-card-avatar ${badgeClass}`} title={providerTag}>
                          <AgentLogo agent={s.agent} logos={logos} size={18} />
                        </span>
                        <span className="ac-card-body">
                          <span className="ac-row-head">
                            <strong>
                              {(flowsOf(s) ? inFlowTitle(plainLine(s.title || "")) : plainLine(s.title || "")) || "New chat"}
                            </strong>
                            <time className="ac-card-time" dateTime={new Date(s.updatedAt).toISOString()}>
                              {ago(s.updatedAt)}
                            </time>
                          </span>
                          <span className="ac-card-preview">
                            {files.length
                              ? `Changed ${files
                                  .slice(0, 3)
                                  .map((f) => base(f.file))
                                  .join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`
                              : s.prompts?.[0]?.title || plainLine(s.preview || "") || `${providerTag}${s.model ? ` · ${s.model}` : ""}`}
                          </span>
                          <span className="ac-card-meta">
                            <span className={`ac-badge ${badgeClass}`}>{providerTag}</span>
                            {s.model && <span className="ac-meta-pill">{s.model}</span>}
                            {folder && (
                              <span className="ac-meta-pill folder">
                                <FolderOpen size={11} />
                                {folder}
                              </span>
                            )}
                            {labelled && <Where computer={computer} />}
                            {needsYou(s) ? (
                              <span className="ac-live-pill waiting">Needs you</span>
                            ) : s.status === "running" ? (
                              <span className="ac-live-pill running">
                                <LoaderCircle size={11} className="spin" /> Working
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {bucket.rows.length > shown.length && (
                  <button
                    className="ac-show-more"
                    aria-expanded={open}
                    onClick={() =>
                      setOpened((o) =>
                        open ? o.filter((r) => r !== bucket.id) : [...o, bucket.id],
                      )
                    }
                  >
                    {open ? "Show fewer" : `Show all ${bucket.rows.length}`}
                  </button>
                )}
              </section>
            );
          })}
          {!timeGroups.length && (
            <div className="ac-empty-feed">
              <Sparkles size={22} />
              <strong>No conversations here yet</strong>
              <p>Start a chat with Codex, Claude, Venice, Ollama, vLLM, or any API key.</p>
            </div>
          )}
        </section>
      )}
      {onNew && <button className="chat-quick-new" aria-label="New chat" onClick={() => onNew()}>
        <span className="chat-compose-mascot" aria-hidden="true"><BrandCourier active /></span>
        <span className="chat-quick-label">New chat</span>
      </button>}
    </div>
  );
}
