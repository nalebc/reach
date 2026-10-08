import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import {
  ArrowUpRight,
  RefreshCw,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  ChevronDown,
  Laptop,
  Menu,
  X,
  SquarePen,
  Archive,
} from "lucide-react";
import { createPortal } from "react-dom";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, archiveSession, projectName, type AgentHealth, type AgentSession } from "./agent-sessions";
import { moveChoices, MoveItems, MoveSection } from "./MoveChat";
import { anchorOf, ChatPopover, type Anchor } from "./ChatPopover";
import { computerWord } from "./pause";
import { BrandCourier } from "./ReachIdentity";
import { NotificationBell } from "./Notifications";
import "./chat-list.css";

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
export const needsYou = (s: AgentSession) =>
  s.status === "waiting" || !!s.prompts?.length || !!s.asking || !!s.consent;

export type ChatAppChoice = { agent: string; name: string; supported: boolean };
const supportedApps: ChatAppChoice[] = [
  { agent: "codex", name: "Codex", supported: true },
  { agent: "claude", name: "Claude Code", supported: true },
];
const pendingLabel = (count: number) => `${count} ${count === 1 ? "request needs" : "requests need"} you`;
const pendingCount = (count: number) => count > 9 ? "9+" : count;

// Every app uses this header, including OpenClaw. The desktop app rail is
// hidden on phones, so its replacement must always travel with the header.
export function ChatLibraryHeader({
  peer,
  apps,
  value,
  logos,
  pending = {},
  onChange,
  onNew,
  onRefresh,
  searchOpen,
  onSearch,
}: {
  peer: Peer;
  apps: ChatAppChoice[];
  value: string;
  logos: AgentLogos;
  pending?: Record<string, number>;
  onChange: (app: string) => void;
  onNew?: () => void;
  onRefresh?: () => void;
  searchOpen: boolean;
  onSearch: () => void;
}) {
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    if (!appMenuOpen && !actionsOpen) return;
    const close = (event: Event) => {
      if (event.type === "keydown") {
        if ((event as KeyboardEvent).key !== "Escape") return;
      } else if ((event.target as HTMLElement)?.closest(".chat-list-top"))
        return;
      setAppMenuOpen(false);
      setActionsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [appMenuOpen, actionsOpen]);
  const name =
    apps.find((app) => app.agent === value)?.name || agentLabel(value);
  return (
    <header className="chat-list-top">
      <div className="chat-mobile-header">
        <button
          className="chat-mobile-round"
          aria-label="Chat list menu"
          aria-expanded={actionsOpen}
          onClick={() => {
            setActionsOpen(!actionsOpen);
            setAppMenuOpen(false);
          }}
        >
          <Menu size={22} />
        </button>
        <button
          className={`chat-app-current ${pending[value] ? "has-pending" : ""}`}
          aria-label={`Choose an app, ${name} selected`}
          aria-description={pending[value] ? pendingLabel(pending[value]) : undefined}
          aria-expanded={appMenuOpen}
          onClick={() => {
            setAppMenuOpen(!appMenuOpen);
            setActionsOpen(false);
          }}
        >
          <span className="chat-current-name">{value === "claude" ? "Claude" : name}</span>
          {!!pending[value] && <span className="chat-attention-count" aria-hidden="true">{pendingCount(pending[value])}</span>}
          <ChevronDown size={17} />
        </button>
        <div className="chat-mobile-tools">
          <button
            className="chat-mobile-round"
            aria-label="Search chats"
            aria-expanded={searchOpen}
            onClick={() => {
              onSearch();
              setAppMenuOpen(false);
              setActionsOpen(false);
            }}
          >
            <Search size={22} />
          </button>
          <NotificationBell compact />
        </div>
      </div>
      {appMenuOpen && (
        <div
          className="chat-mobile-menu chat-mobile-app-menu"
          role="menu"
          aria-label="Choose an app"
        >
          {apps.map((app) => (
            <button
              key={app.agent}
              role="menuitemradio"
              aria-label={app.name}
              aria-description={pending[app.agent] ? pendingLabel(pending[app.agent]) : undefined}
              aria-checked={app.agent === value}
              className={pending[app.agent] ? "has-pending" : undefined}
              onClick={() => {
                onChange(app.agent);
                setAppMenuOpen(false);
              }}
            >
              <AgentLogo
                agent={app.agent}
                name={app.name}
                logos={logos}
                size={19}
              />
              {app.name}
              {!!pending[app.agent] && <span className="chat-attention-count" aria-hidden="true">{pendingCount(pending[app.agent])}</span>}
              {!app.supported && <small>Coming soon</small>}
            </button>
          ))}
        </div>
      )}
      {actionsOpen && (
        <div
          className="chat-mobile-menu chat-mobile-actions"
          role="menu"
          aria-label="Chat actions"
        >
          {onNew && (
            <button
              role="menuitem"
              onClick={() => {
                setActionsOpen(false);
                onNew();
              }}
            >
              <Plus size={18} /> New chat
            </button>
          )}
          {onRefresh && (
            <button
              role="menuitem"
              onClick={() => {
                setActionsOpen(false);
                onRefresh();
              }}
            >
              <RefreshCw size={18} /> Refresh chats
            </button>
          )}
        </div>
      )}
      <div className="chat-list-heading">
        <h1>{name}</h1>
        <span className="chat-list-device">{peer.name}</span>
      </div>
      <div className="chat-heading-actions">
        <NotificationBell compact />
        {onRefresh && (
          <button
            className="chat-refresh"
            aria-label="Refresh apps and chats"
            onClick={onRefresh}
          >
            <RefreshCw size={16} />
          </button>
        )}
        {onNew && (
          <button className="chat-create" aria-label="New chat" onClick={onNew}>
            <span className="chat-compose-mascot" aria-hidden="true"><BrandCourier active /></span>
            <span>New chat</span>
          </button>
        )}
      </div>
      {apps.some((app) => app.agent !== value && pending[app.agent]) && (
        <div className="chat-app-attention" role="group" aria-label="Apps needing you">
          <span>Needs you</span>
          {apps.filter((app) => app.agent !== value && pending[app.agent]).map((app) => (
            <button key={app.agent} aria-label={`${app.name}, ${pendingLabel(pending[app.agent])}`}
              onClick={() => { onChange(app.agent); setAppMenuOpen(false); setActionsOpen(false); }}>
              <AgentLogo agent={app.agent} name={app.name} logos={logos} size={17} />
              <span>{app.name}</span>
              <span className="chat-attention-count" aria-hidden="true">{pendingCount(pending[app.agent])}</span>
            </button>
          ))}
        </div>
      )}
    </header>
  );
}

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
          className={`chat-app-token ${app.supported ? "" : "upcoming"} ${pending[app.agent] ? "has-pending" : ""}`}
          aria-label={app.name}
          aria-description={
            app.supported
              ? pending[app.agent]
                ? pendingLabel(pending[app.agent])
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
                {pendingCount(pending[app.agent])}
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

// A line of a chat as plain words for the list: the markdown an agent
// writes (**bold**, `code`, # headings, - lists, [links](…)) without its
// marks, and no prompt sign ahead of it (Gemini CLI's "›").
export function plainLine(text: string) {
  return text
    .replace(/^\s*(?:[›❯>$]\s+)+/, "")
    .replace(/^\s*(?:#{1,6}|[-*•]|\d+[.)])\s+/, "")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .trim();
}

export function ChatComingSoon({
  app,
  logos,
  label = "Coming soon",
  text = `Your ${app.name} conversations will be available here when the integration is ready.`,
}: {
  app: ChatAppChoice;
  logos: AgentLogos;
  label?: string;
  text?: string;
}) {
  return (
    <div className="chat-coming-soon" role="status">
      <AgentLogo agent={app.agent} name={app.name} logos={logos} size={32} />
      <strong>{app.name}</strong>
      <span>{label}</span>
      <p>{text}</p>
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
  health = [],
  onSectionMoved,
  onArchived,
}: {
  peer: Peer;
  sessions: AgentSession[] | null;
  logos: AgentLogos;
  errors?: Record<string, string>;
  failure?: string;
  agent?: string;
  onOpen: (s: AgentSession) => void;
  // A folder: a new chat there (from a chat's menu).
  onNew: (cwd?: string) => void;
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
  // The apps found on the Mac: a folder's chats can move to another one.
  health?: AgentHealth[];
  onSectionMoved?: (to: string) => void;
  // A chat archived or brought back from here: the list to read again.
  onArchived?: () => void;
}) {
  const [localAgent, setLocalAgent] = useState(
    agent || apps[0]?.agent || "codex",
  );
  const filter = agent || localAgent;
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchField.current?.focus(); }, [searchOpen]);
  const [limit, setLimit] = useState(12);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const all = useMemo(
    () =>
      (sessions || [])
        .filter((s) => !s.archived && !gone.has(`${s.agent}:${s.id}`))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, gone],
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
  const projects = new Map<string, AgentSession[]>();
  for (const s of shown) {
    const key = s.cwd || "";
    projects.set(key, [...(projects.get(key) || []), s]);
  }
  // Archived from here: gone at once (the Mac's list follows), with a
  // moment to undo it.
  const [undo, setUndo] = useState<{ s: AgentSession; problem?: string } | null>(null);
  useEffect(() => {
    if (!undo || undo.problem) return;
    const timer = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(timer);
  }, [undo]);
  const keyOf = (s: AgentSession) => `${s.agent}:${s.id}`;
  const archive = async (s: AgentSession, archived: boolean) => {
    setGone((g) => {
      const next = new Set(g);
      if (archived) next.add(keyOf(s));
      else next.delete(keyOf(s));
      return next;
    });
    setUndo(archived ? { s } : null);
    try {
      await archiveSession(peer, s, archived);
      onArchived?.();
    } catch (e) {
      setGone((g) => {
        const next = new Set(g);
        if (archived) next.delete(keyOf(s));
        else next.add(keyOf(s));
        return next;
      });
      setUndo({ s, problem: (e as Error).message });
    }
  };
  // Touch and hold a chat (or right-click it): its menu, by it.
  const [menu, setMenu] = useState<{ s: AgentSession; at: Anchor } | null>(null);
  const held = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean }>({ x: 0, y: 0, fired: false });
  const hold = (s: AgentSession) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      const card = e.currentTarget;
      held.current.fired = false;
      held.current.x = e.clientX;
      held.current.y = e.clientY;
      clearTimeout(held.current.timer);
      held.current.timer = setTimeout(() => {
        held.current.fired = true;
        navigator.vibrate?.(10);
        setMenu({ s, at: anchorOf(card) });
      }, 500);
    },
    // A scroll isn't a hold.
    onPointerMove: (e: PointerEvent) => {
      if (Math.hypot(e.clientX - held.current.x, e.clientY - held.current.y) > 10) clearTimeout(held.current.timer);
    },
    onPointerUp: () => clearTimeout(held.current.timer),
    onPointerLeave: () => clearTimeout(held.current.timer),
    onPointerCancel: () => clearTimeout(held.current.timer),
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      clearTimeout(held.current.timer);
      held.current.fired = true;
      setMenu({ s, at: anchorOf(e.currentTarget) });
    },
    onClick: () => {
      // The tap that ends a hold opens nothing.
      if (held.current.fired) {
        held.current.fired = false;
        return;
      }
      onOpen(s);
    },
  });
  useEffect(() => () => clearTimeout(held.current.timer), []);
  const cards = (list: AgentSession[]) => (
    <div className="chat-entries">
      {list.map((s) => (
        <button
          key={`${s.agent}:${s.id}`}
          className={`chat-card ${needsYou(s) ? "waiting" : s.status}`}
          aria-label={`${s.title || "New chat"}, ${agentLabel(s.agent)}`}
          aria-haspopup="menu"
          {...hold(s)}
        >
          <span className="chat-entry-logo" title={agentLabel(s.agent)}>
            <AgentLogo agent={s.agent} logos={logos} size={18} />
          </span>
          <span className="chat-entry-copy">
            <strong>{plainLine(s.title || "") || "New chat"}</strong>
            <span className="chat-card-preview">
              {/* Continued from a chat with the other agent, as if forked. */}
              {s.movedFrom && (
                <span className="chat-card-moved">
                  <AgentLogo agent={s.movedFrom.agent} logos={logos} size={12} />
                  From {agentLabel(s.movedFrom.agent)} ·{" "}
                </span>
              )}
              {s.prompts?.[0]?.title ||
                plainLine(s.preview || "") ||
                (s.movedFrom ? `Continues “${s.movedFrom.title || "a chat"}”` : "No messages yet")}
            </span>
          </span>
          <span className="chat-entry-tail">
            {needsYou(s) ? (
              <span className="chat-row-status waiting" aria-label="Needs you" title="Needs you"><span className="chat-state-dot" /></span>
            ) : s.status === "running" ? (
              <Loader2 className="chat-row-status spin" size={17} aria-label="Working" />
            ) : null}
            <time
              className="chat-card-time"
              dateTime={new Date(s.updatedAt).toISOString()}
              title={`Updated ${new Date(s.updatedAt).toLocaleString()}`}
            >
              {ago(s.updatedAt)}
            </time>
            {s.status === "error" && !needsYou(s) && <span className="chat-card-state error">Stopped</span>}
          </span>
        </button>
      ))}
    </div>
  );
  return (
    <div className={`chat-library ${compact ? "compact" : ""} ${searchOpen ? "search-open" : ""}`}>
      {!compact && (
        <ChatLibraryHeader
          peer={peer}
          apps={apps}
          value={filter}
          logos={logos}
          pending={appPending}
          onChange={(value) => {
            (onAgentChange || setLocalAgent)(value);
            setLimit(12);
          }}
          onNew={!upcoming && canStart ? () => onNew() : undefined}
          onRefresh={onRefresh}
          searchOpen={searchOpen}
          onSearch={() => {
            if (searchOpen) setQuery("");
            setSearchOpen(!searchOpen);
          }}
        />
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
              ref={searchField}
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
      {!compact && <div className="chat-source-strip" aria-label="Chat source">
        <span>All</span>
        <span className="chat-source-device"><span className="chat-source-dot" /><Laptop size={16} />{peer.name}</span>
      </div>}
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
          {q ? <Search size={28} /> : <span className="chat-welcome-mascot" aria-hidden="true"><BrandCourier active /></span>}
          <strong>
            {q ? "No conversations found" : "Room for your next idea"}
          </strong>
          <p>
            {q
              ? "Try another title, project, or app."
              : `Start a ${picked?.name || agentLabel(filter)} chat on ${peer.name}.`}
          </p>
          {!q && canStart && (
            <button className="chat-create" onClick={() => onNew()}>
              <Plus size={16} /> Start a conversation
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Nothing at work, but something waits: one row to review it,
              not a heading over an empty space. */}
          {!!pending && onReview && !compact && (
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
          {shown.length > 0 && (
            <section
              className="chat-projects"
              aria-label="Projects"
            >
              <h2 className="chat-projects-title">Projects</h2>
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
                      {!!cwd && <span className="chat-project-parent">{cwd.split(/[\\/]/).filter(Boolean).at(-2) || ""}</span>}
                    </h2>
                    {!compact && canStart && <button className="chat-folder-new" aria-label={`New chat in ${projectName(cwd) || "Workspace"}`} onClick={() => onNew(cwd || undefined)}><SquarePen size={19} /></button>}
                    {/* The whole folder, not only the chats shown (no search,
                        no "Show more"); chats at work stay out of it. */}
                    {!compact && (
                      <MoveSection
                        peer={peer}
                        name={projectName(cwd) || "Workspace"}
                        chats={all.filter(
                          (s) =>
                            s.agent === filter &&
                            (s.cwd || "") === cwd &&
                            !needsYou(s) &&
                            s.status !== "running",
                        )}
                        health={health}
                        logos={logos}
                        word={computerWord(peer.platform)}
                        onOpen={onOpen}
                        onMoved={(to) => {
                          (onAgentChange || setLocalAgent)(to);
                          setQuery("");
                          setLimit(12);
                          onSectionMoved?.(to);
                        }}
                      />
                    )}
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
      {menu && (
        <ChatMenu
          peer={peer}
          session={menu.s}
          at={menu.at}
          health={health}
          logos={logos}
          canStart={canStart}
          onClose={() => setMenu(null)}
          onOpen={(s) => {
            setMenu(null);
            onOpen(s);
          }}
          onNew={(cwd) => {
            setMenu(null);
            onNew(cwd);
          }}
          onArchive={(s) => {
            setMenu(null);
            void archive(s, true);
          }}
        />
      )}
      {!compact && !upcoming && canStart && <button className="chat-quick-new" aria-label={`New ${picked?.name || agentLabel(filter)} chat`} onClick={() => onNew()}>
        <span className="chat-compose-mascot" aria-hidden="true"><BrandCourier active /></span>
        <span className="chat-quick-label">Ask {picked?.name || agentLabel(filter)}</span>
        <span className="chat-quick-arrow"><ArrowUpRight size={22} /></span>
      </button>}
      {/* On the page: the list contains its layout, which would pin it. */}
      {undo && createPortal(
        <div className="chat-undo" role="status">
          <span>{undo.problem || `Archived “${plainLine(undo.s.title || "") || "New chat"}” in ${agentLabel(undo.s.agent)}`}</span>
          {undo.problem ? (
            <button onClick={() => setUndo(null)}>OK</button>
          ) : (
            <button onClick={() => void archive(undo.s, false)}>Undo</button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// A chat's menu on the list (touch and hold, or right-click): open it, start
// another in its folder, continue it in another app (MoveItems, as in the
// chat's own ⋯).
function ChatMenu({
  peer,
  session,
  at,
  health,
  logos,
  canStart,
  onClose,
  onOpen,
  onNew,
  onArchive,
}: {
  peer: Peer;
  session: AgentSession;
  at: Anchor;
  health: AgentHealth[];
  logos: AgentLogos;
  canStart: boolean;
  onClose: () => void;
  onOpen: (s: AgentSession) => void;
  onNew: (cwd: string) => void;
  onArchive: (s: AgentSession) => void;
}) {
  const where = projectName(session.cwd) || "Workspace";
  // Archived in its own app, or why it can't be.
  const noArchive =
    session.agent === "codex" ? "" : session.agent === "claude" ? (session.inApp ? "" : "Open it in the Claude app to archive it.") : `${agentLabel(session.agent)} has no archive.`;
  return (
    <ChatPopover anchor={at} align="start" label={`${session.title || "New chat"} options`} onClose={onClose}>
      <div className="chat-popover-head">
        <strong>{plainLine(session.title || "") || "New chat"}</strong>
        <small>
          {where} · {agentLabel(session.agent)}
        </small>
      </div>
      <button role="menuitem" className="move-item" onClick={() => onOpen(session)}>
        <ArrowUpRight size={18} />
        <span className="move-item-text">
          <span>Open</span>
        </span>
      </button>
      {canStart && session.cwd && (
        <button role="menuitem" className="move-item" onClick={() => onNew(session.cwd)}>
          <SquarePen size={18} />
          <span className="move-item-text">
            <span>New chat in {where}</span>
          </span>
        </button>
      )}
      {moveChoices(session.agent, health).length > 0 && <div className="chat-popover-line" />}
      <MoveItems
        peer={peer}
        session={session}
        health={health}
        logos={logos}
        word={computerWord(peer.platform)}
        onMoved={onOpen}
      />
      <div className="chat-popover-line" />
      <button
        role="menuitem"
        className={`move-item ${noArchive ? "blocked" : ""}`}
        disabled={!!noArchive}
        onClick={() => onArchive(session)}
      >
        <Archive size={18} />
        <span className="move-item-text">
          <span>Archive</span>
          <small>{noArchive || `In ${agentLabel(session.agent)} too`}</small>
        </span>
      </button>
    </ChatPopover>
  );
}
