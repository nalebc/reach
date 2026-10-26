import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import {
  ArrowUpRight,
  RefreshCw,
  FolderOpen,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  Check,
  ChevronDown,
  Laptop,
  Menu,
  X,
  SquarePen,
  Archive,
  Workflow,
} from "lucide-react";
import { createPortal } from "react-dom";
import { viewScope, useViewState, useViewScroll, useSearchFocus } from "./view-memory";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, archiveSession, projectName, projectOfChat, type AgentHealth, type AgentProject, type AgentSession } from "./agent-sessions";
import { moveChoices, MoveItems, MoveSection } from "./MoveChat";
import { anchorOf, ChatPopover, type Anchor } from "./ChatPopover";
import { computerWord } from "./pause";
import { BrandCourier } from "./ReachIdentity";
import { NotificationBell } from "./Notifications";
import { UsageButton, UsagePill, UsageRing } from "./UsageRing";
import { usageOf, usageSentence } from "./usage";
import type { Workflow as Flow } from "./Workflows";
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
// The Workflows icon at the top of Chat (Workflows.tsx): how many run or
// wait on you, and its page.
// With the workflows themselves, a folder's chats keep each one's together.
export type WorkflowsEntry = { active: number; paused: number; onOpen: () => void; list?: Flow[]; onOpenFlow?: (w: Flow) => void };

// The chats each workflow started (its tasks' and its planner's), by
// "agent:id", its tries' earlier chats too; then, for one from before the
// Mac kept those, by name: "Workflow · <task>" in its folder, since it
// began. Only Codex's chats carry that name.
export const flowFinder = (flows: Flow[] = []) => {
  const map = new Map<string, Flow>();
  for (const w of flows) {
    if (w.planner) map.set(`${w.planner.agent}:${w.planner.id}`, w);
    for (const t of w.tasks) for (const c of [...(t.tries || []), ...(t.chat ? [t.chat] : [])]) map.set(`${c.agent}:${c.id}`, w);
  }
  return (s: { agent: string; id: string; title?: string; cwd?: string; createdAt?: number }) => {
    const known = map.get(`${s.agent}:${s.id}`);
    if (known || s.agent !== "codex" || !s.title?.startsWith("Workflow · ")) return known;
    const task = s.title.slice("Workflow · ".length);
    const matches = flows.filter((w) =>
      w.cwd === s.cwd && (s.createdAt || 0) >= w.createdAt && w.tasks.some((t) => t.agent === s.agent && t.title === task),
    );
    // A title cannot identify the owner when multiple workflows used it.
    return matches.length === 1 ? matches[0] : undefined;
  };
};
// A chat that needs you, then one at work, then the rest.
export const chatRank = (s: AgentSession) => (needsYou(s) ? 2 : s.status === "running" ? 1 : 0);
// Each workflow's chats together, where its first one stands: with one at
// work, the whole workflow sits with the working chats.
export function inFlows<T>(list: T[], flowOf: (s: T) => Flow | undefined) {
  const out: T[] = [];
  const placed = new Set<Flow>();
  for (const s of list) {
    const w = flowOf(s);
    if (!w) out.push(s);
    else if (!placed.has(w)) {
      placed.add(w);
      out.push(...list.filter((x) => flowOf(x) === w));
    }
  }
  return out;
}
// A workflow's chats that show while it's folded: those that need you, then
// up to three at work (or, with none, its latest); the rest behind one
// "N more" line. Folding away a single chat saves nothing.
export const flowShown = <T,>(rows: T[], rank: (s: T) => number) => {
  const urgent = rows.filter((s) => rank(s) >= 2);
  const working = rows.filter((s) => rank(s) === 1).slice(0, Math.max(0, 3 - urgent.length));
  const shown = new Set(urgent.length + working.length ? [...urgent, ...working] : rows.slice(0, 1));
  return rows.length - shown.size < 2 ? rows : rows.filter((s) => shown.has(s));
};
const runsOf = <T,>(list: T[], flowOf: (s: T) => Flow | undefined) => {
  const runs: { flow?: Flow; rows: T[] }[] = [];
  for (const s of list) {
    const w = flowOf(s);
    const last = runs.at(-1);
    if (w && last?.flow === w) last.rows.push(s);
    else runs.push({ flow: w, rows: [s] });
  }
  return runs;
};
// How many of a folder's chats show before "Show all": about four lines, a
// workflow never cut (it's folded instead), and past that working chats
// up to twice as many lines. Approval requests always remain visible, even
// beyond that budget, as they do inside each workflow. Callers sort these
// ahead of working and idle chats before grouping.
export const firstFew = <T,>(list: T[], flowOf: (s: T) => Flow | undefined, rank: (s: T) => number, few = 4) => {
  let n = 0;
  let lines = 0;
  for (const { flow, rows } of runsOf(list, flowOf)) {
    const shown = flow ? flowShown(rows, rank).length : 1;
    const urgent = rows.some((s) => rank(s) >= 2);
    if (lines >= few && !urgent && !(lines < few * 2 && rows.some((s) => rank(s) > 0))) break;
    n += flow ? rows.length : 1;
    lines += shown + (flow && shown < rows.length ? 1 : 0);
  }
  return n;
};
// How many of a folder's chats stay folded in their workflows: its Show all
// counts only the chats it brings.
export const foldedAway = <T,>(list: T[], flowOf: (s: T) => Flow | undefined, rank: (s: T) => number) =>
  runsOf(list, flowOf).reduce((n, { flow, rows }) => n + (flow ? rows.length - flowShown(rows, rank).length : 0), 0);
const flowWord = (w: Flow) => {
  if (w.state === "paused") return "Paused";
  if (w.state === "done") return "Done";
  if (w.state === "stopped") return "Stopped";
  if (w.state === "draft") return "Draft";
  return `${w.tasks.filter((t) => t.state === "done" || t.state === "skipped").length} of ${w.tasks.length}`;
};
// Rows in runs: a workflow's under one quiet line (its name and how far it
// is, a tap to it), its idle chats folded under "N more"; the others as they
// are. Each workflow unfolds on its own, never with the folder's Show all.
export function FlowRuns<T>({ list, flowOf, rank, onOpenFlow, row }: { list: T[]; flowOf: (s: T) => Flow | undefined; rank: (s: T) => number; onOpenFlow?: (w: Flow) => void; row: (s: T) => ReactNode }) {
  const [unfolded, setUnfolded] = useState<string[]>([]);
  return (
    <>
      {runsOf(list, flowOf).map(({ flow, rows }, i) => {
        if (!flow) return <Fragment key={i}>{rows.map(row)}</Fragment>;
        const head = (
          <>
            <Workflow size={13} aria-hidden="true" />
            <span className="chat-flow-name">{plainLine(flow.title) || "Workflow"}</span>
            <small className={flow.state === "paused" ? "paused" : ""}>{flowWord(flow)}</small>
          </>
        );
        const folded = flowShown(rows, rank);
        const open = unfolded.includes(flow.id);
        const hidden = rows.length - folded.length;
        return (
          <div className="chat-flow" key={`flow:${flow.id}:${i}`} role="group" aria-label={`Workflow ${flow.title || ""}, ${flowWord(flow)}`}>
            {onOpenFlow ? (
              <button className="chat-flow-head" onClick={() => onOpenFlow(flow)}>
                {head}
              </button>
            ) : (
              <span className="chat-flow-head">{head}</span>
            )}
            <div className="chat-flow-rows">
              {(open ? rows : folded).map(row)}
              {hidden > 0 && (
                <button
                  className="chat-flow-more"
                  aria-expanded={open}
                  onClick={() => setUnfolded((u) => (open ? u.filter((id) => id !== flow.id) : [...u, flow.id]))}
                >
                  {open ? "Show fewer" : `${hidden} more ${hidden === 1 ? "chat" : "chats"}`}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
// A workflow's chat under its line: its name without the "Workflow · " the
// line already says.
export const inFlowTitle = (title: string) => title.replace(/^Workflow · /, "");
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
  workflows,
  health = [],
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
  workflows?: WorkflowsEntry;
  // Each agent's account usage: its ring at the top (UsageRing.tsx); on
  // All, the agent closest to its limit.
  health?: AgentHealth[];
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
  const usageHere = value === "all" ? health.filter((h) => apps.some((app) => app.agent === h.agent)) : health.filter((h) => h.agent === value);
  return (
    <header className="chat-list-top">
      <div className="chat-mobile-header">
        <button
          className="chat-mobile-round"
          aria-label="Chat list menu"
          title="Chat list menu"
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
          <UsageButton health={usageHere} logos={logos} />
          {workflows && (
            <button
              className="chat-mobile-round chat-workflows"
              aria-label={`Workflows${workflows.active ? `, ${workflows.active} active` : ""}${workflows.paused ? `, ${workflows.paused} paused` : ""}`}
              title="Workflows"
              onClick={() => {
                workflows.onOpen();
                setAppMenuOpen(false);
                setActionsOpen(false);
              }}
            >
              <Workflow size={21} />
              {!!workflows.active && (
                <span className={`chat-workflows-count ${workflows.paused ? "paused" : ""}`} aria-hidden="true">
                  {workflows.active}
                </span>
              )}
            </button>
          )}
          <button
            className="chat-mobile-round"
            aria-label="Search chats"
            title="Search chats"
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
          {apps.map((app) => {
            const usage = usageOf(health.find((h) => h.agent === app.agent));
            return (
            <button
              key={app.agent}
              role="menuitemradio"
              aria-label={app.name}
              aria-description={[pending[app.agent] && pendingLabel(pending[app.agent]), usage && usageSentence(app.name, usage)].filter(Boolean).join(". ") || undefined}
              aria-checked={app.agent === value}
              className={pending[app.agent] ? "has-pending" : undefined}
              onClick={() => {
                onChange(app.agent);
                setAppMenuOpen(false);
              }}
            >
              <span className="usage-logo">
                <AgentLogo
                  agent={app.agent}
                  name={app.name}
                  logos={logos}
                  size={19}
                />
                <UsageRing usage={usage} />
              </span>
              {app.name}
              {usage && <small className={`chat-menu-usage ${usage.level}`}>{usage.level === "out" ? "Out" : `${usage.percent}%`}{usage.stale ? " · Last read" : ""}</small>}
              {!!pending[app.agent] && <span className="chat-attention-count" aria-hidden="true">{pendingCount(pending[app.agent])}</span>}
              {!app.supported && <small>Coming soon</small>}
            </button>
          ); })}
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
        <button className="chat-refresh" aria-label="Search chats" title="Search chats" aria-expanded={searchOpen} onClick={onSearch}>
          <Search size={16} />
        </button>
        <UsageButton health={usageHere} logos={logos} />
        {workflows && (
          <button
            className="chat-refresh chat-workflows"
            aria-label={`Workflows${workflows.active ? `, ${workflows.active} active` : ""}${workflows.paused ? `, ${workflows.paused} paused` : ""}`}
            title="Workflows"
            onClick={workflows.onOpen}
          >
            <Workflow size={16} />
            {!!workflows.active && (
              <span className={`chat-workflows-count ${workflows.paused ? "paused" : ""}`} aria-hidden="true">
                {workflows.active}
              </span>
            )}
          </button>
        )}
        {onRefresh && (
          <button
            className="chat-refresh"
            aria-label="Refresh apps and chats"
            title="Refresh"
            onClick={onRefresh}
          >
            <RefreshCw size={16} />
          </button>
        )}
        {/* The bell is the last round button, as in every top bar. */}
        <NotificationBell compact />
        {onNew && (
          <button className="chat-create" aria-label="New chat" onClick={onNew}>
            <span className="chat-compose-mascot" aria-hidden="true"><BrandCourier active /></span>
            <span>New chat</span>
          </button>
        )}
      </div>
      {apps.some((app) => app.agent !== "all" && app.agent !== value && pending[app.agent]) && (
        <div className="chat-app-attention" role="group" aria-label="Apps needing you">
          <span>Needs you</span>
          {apps.filter((app) => app.agent !== "all" && app.agent !== value && pending[app.agent]).map((app) => (
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

// New chat's app: one pill in the sheet's heading; tapped, a short list with
// each app's state (its ring, Out, Coming soon) to change it.
export function ChatAppSwitch({
  apps,
  value,
  onChange,
  logos,
  pending = {},
  health = [],
  notes = {},
}: {
  apps: ChatAppChoice[];
  value: string;
  onChange: (value: string) => void;
  logos: AgentLogos;
  pending?: Record<string, number>;
  health?: AgentHealth[];
  // A word under an app's name (Gemini: "Read only").
  notes?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const current = apps.find((app) => app.agent === value) || apps[0];
  if (!current) return null;
  const usageOfApp = (agent: string) => usageOf(health.find((h) => h.agent === agent));
  const described = (app: ChatAppChoice) =>
    app.supported
      ? [pending[app.agent] && pendingLabel(pending[app.agent]), (() => { const u = usageOfApp(app.agent); return u && usageSentence(app.name, u); })()].filter(Boolean).join(". ")
      : "Coming soon";
  const note = (app: ChatAppChoice) => {
    if (!app.supported) return "Coming soon";
    if (notes[app.agent]) return notes[app.agent];
    const u = usageOfApp(app.agent);
    if (!u) return "";
    return u.level === "out" ? "Out of usage" : `${u.percent}% used`;
  };
  const usage = usageOfApp(current.agent);
  return (
    <span className="chat-app-switch">
      <button
        className={`chat-app-switch-current ${pending[current.agent] ? "has-pending" : ""}`}
        aria-label={`Change app, ${current.name} selected`}
        aria-description={described(current) || undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        <span className="chat-app-symbol">
          <AgentLogo agent={current.agent} name={current.name} logos={logos} size={20} />
          <UsageRing usage={usage} />
          <UsagePill usage={usage} />
        </span>
        <span className="chat-app-switch-name">{current.name}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <>
          <span className="chat-app-switch-scrim" onClick={() => setOpen(false)} />
          <span className="chat-app-switch-menu" role="menu" aria-label="Choose an app">
            {apps.map((app) => {
              const u = usageOfApp(app.agent);
              const said = note(app);
              return (
                <button
                  key={app.agent}
                  role="menuitemradio"
                  aria-label={app.name}
                  aria-description={described(app) || undefined}
                  aria-checked={app.agent === current.agent}
                  className={`${app.supported ? "" : "upcoming"} ${u?.level === "out" ? "out" : ""}`}
                  onClick={() => {
                    onChange(app.agent);
                    setOpen(false);
                  }}
                >
                  <span className="usage-logo">
                    <AgentLogo agent={app.agent} name={app.name} logos={logos} size={20} />
                    <UsageRing usage={u} />
                  </span>
                  <span className="chat-app-switch-text">
                    <span>{app.name}</span>
                    {said && <small>{said}</small>}
                  </span>
                  {!!pending[app.agent] && <span className="chat-attention-count" aria-hidden="true">{pendingCount(pending[app.agent])}</span>}
                  {app.agent === current.agent && <Check size={16} />}
                </button>
              );
            })}
          </span>
        </>
      )}
    </span>
  );
}

export function ChatAppPicker({
  apps = supportedApps,
  value,
  onChange,
  logos,
  pending = {},
  health = [],
}: {
  apps?: ChatAppChoice[];
  value: string;
  onChange: (value: string) => void;
  logos: AgentLogos;
  pending?: Record<string, number>;
  // Each agent's ring around its logo (UsageRing.tsx).
  health?: AgentHealth[];
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
      {apps.map((app) => {
        const usage = usageOf(health.find((h) => h.agent === app.agent));
        const described = app.supported
          ? [pending[app.agent] && pendingLabel(pending[app.agent]), usage && usageSentence(app.name, usage)].filter(Boolean).join(". ")
          : "Coming soon";
        return (
        <button
          key={app.agent}
          className={`chat-app-token ${app.supported ? "" : "upcoming"} ${pending[app.agent] ? "has-pending" : ""}`}
          aria-label={app.name}
          aria-description={described || undefined}
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
            <UsageRing usage={usage} />
            <UsagePill usage={usage} />
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
        );
      })}
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
  active = true,
  apps = supportedApps,
  agent,
  onAgentChange,
  appPending,
  setup,
  notice,
  canStart = true,
  onRefresh,
  health = [],
  onSectionMoved,
  onArchived,
  workflows,
  projects: codexProjects = [],
  computers = 1,
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
  active?: boolean;
  apps?: ChatAppChoice[];
  onAgentChange?: (agent: string) => void;
  appPending?: Record<string, number>;
  setup?: ReactNode;
  // A quiet line over the chats (an update for the agent, AgentUpdate.tsx).
  notice?: ReactNode;
  canStart?: boolean;
  onRefresh?: () => void;
  // The apps found on the Mac: a folder's chats can move to another one.
  health?: AgentHealth[];
  onSectionMoved?: (to: string) => void;
  // A chat archived or brought back from here: the list to read again.
  onArchived?: () => void;
  // The Workflows icon at the top (Workflows.tsx).
  workflows?: WorkflowsEntry;
  // The Codex app's projects (its sidebar), this computer's.
  projects?: AgentProject[];
  // How many computers you have: the strip naming this one shows only when
  // there's another to tell it from.
  computers?: number;
}) {
  const [localAgent, setLocalAgent] = useState(
    agent || apps[0]?.agent || "codex",
  );
  const filter = agent || localAgent;
  const scope = viewScope(peer, `chats:${filter}`);
  const [query, setQuery] = useViewState(scope, "query", "");
  const [searchOpen, setSearchOpen] = useViewState(scope, "search", false);
  const { field: searchField, requestFocus } = useSearchFocus<HTMLInputElement>(searchOpen);
  const [expandedFolders, setExpandedFolders] = useViewState<string[]>(scope, "folders", []);
  const scroll = useViewScroll<HTMLDivElement>(scope, active && !compact, sessions !== null);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  // Forget an optimistic archive once the Mac's list agrees: the chat is
  // no longer listed, or is listed as archived.
  useEffect(() => {
    if (!sessions) return;
    setGone((g) => {
      if (!g.size) return g;
      const live = new Map(sessions.map((s) => [`${s.agent}:${s.id}`, s]));
      const next = new Set([...g].filter((k) => live.has(k) && !live.get(k)!.archived));
      return next.size === g.size ? g : next;
    });
  }, [sessions]);
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
  found.sort((a, b) => chatRank(b) - chatRank(a));
  // Codex chats in one of its app's projects group under it, by its name,
  // as in its sidebar (the deepest root holding the chat's folder); others
  // by their folder.
  const projectNames = new Map<string, string>();
  const groupOf = (s: AgentSession) => {
    const cwd = s.cwd || "";
    // A worktree chat under its repo, as the Claude app (and Chat home) group it.
    if (filter !== "codex" || !cwd) return projectOfChat(s);
    let best = "";
    for (const p of codexProjects)
      for (const root of p.roots) {
        const r = root.replace(/[\\/]+$/, "");
        // Either separator: a Windows PC's folders too.
        if (r && (cwd === r || cwd.startsWith(r + "/") || cwd.startsWith(r + "\\")) && r.length > best.length) {
          best = r;
          if (p.name) projectNames.set(r, p.name);
        }
      }
    return best || cwd;
  };
  // Each workflow's chats together (FlowRuns).
  const flowOf = useMemo(() => flowFinder(workflows?.list), [workflows?.list]);
  const projects = new Map<string, AgentSession[]>();
  for (const s of found) {
    const key = groupOf(s);
    projects.set(key, [...(projects.get(key) || []), s]);
  }
  for (const [key, list] of projects) projects.set(key, inFlows(list, flowOf));
  const groupName = (cwd: string) => projectNames.get(cwd) || projectName(cwd) || "Workspace";
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
      <FlowRuns list={list} flowOf={flowOf} rank={chatRank} onOpenFlow={workflows?.onOpenFlow} row={(s) => (
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
            <strong>{(flowOf(s) ? inFlowTitle(plainLine(s.title || "")) : plainLine(s.title || "")) || "New chat"}</strong>
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
              <LoaderCircle className="chat-row-status spin" size={17} aria-label="Working" />
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
      )} />
    </div>
  );
  return (
    <div ref={scroll} className={`chat-library ${compact ? "compact" : ""} ${searchOpen ? "search-open" : ""}`}>
      {!compact && (
        <ChatLibraryHeader
          peer={peer}
          apps={apps}
          value={filter}
          logos={logos}
          pending={appPending}
          onChange={(value) => {
            (onAgentChange || setLocalAgent)(value);
          }}
          onNew={!upcoming && canStart ? () => onNew() : undefined}
          onRefresh={onRefresh}
          workflows={workflows}
          health={health}
          searchOpen={searchOpen}
          onSearch={() => {
            if (searchOpen) setQuery("");
            if (!searchOpen) requestFocus();
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
          health={health}
          onChange={(value) => {
            (onAgentChange || setLocalAgent)(value);
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
                setExpandedFolders([]);
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
      {!compact && computers > 1 && <div className="chat-source-strip" aria-label="Chat source">
        <span>All</span>
        <span className="chat-source-device"><span className="chat-source-dot" /><Laptop size={16} />{peer.name}</span>
      </div>}
      {setup}
      {notice}
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
          <LoaderCircle size={15} className="spin" /> Finding your conversations…
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
          {projects.size > 0 && (
            <section
              className="chat-projects"
              aria-label="Projects"
            >
              <h2 className="chat-projects-title">Projects</h2>
              {[...projects.entries()].map(([cwd, list]) => (
                <section
                  className="chat-group chat-project-group"
                  key={cwd}
                  aria-label={`${groupName(cwd)} conversations`}
                >
                  <div className="chat-group-heading">
                    <h2 title={cwd || undefined}>
                      <FolderOpen size={14} />
                      <span className="chat-project-name">
                        {groupName(cwd)}
                      </span>
                      {!!cwd && <span className="chat-project-parent">{cwd.split(/[\\/]/).filter(Boolean).at(-2) || ""}</span>}
                    </h2>
                    {!compact && canStart && <button className="chat-folder-new" aria-label={`New chat in ${groupName(cwd)}`} onClick={() => onNew(cwd || undefined)}><SquarePen size={19} /></button>}
                    {/* The whole folder, not only the chats shown (no search,
                        no "Show more"); chats at work stay out of it. */}
                    {!compact && (
                      <MoveSection
                        peer={peer}
                        name={groupName(cwd)}
                        chats={all.filter(
                          (s) =>
                            s.agent === filter &&
                            groupOf(s) === cwd &&
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
                          setExpandedFolders([]);
                          onSectionMoved?.(to);
                        }}
                      />
                    )}
                  </div>
                  {cards(expandedFolders.includes(cwd) ? list : list.slice(0, firstFew(list, flowOf, chatRank)))}
                  {list.length > firstFew(list, flowOf, chatRank) && (
                    <button
                      className="chat-list-more"
                      aria-expanded={expandedFolders.includes(cwd)}
                      onClick={() => setExpandedFolders((folders) => folders.includes(cwd)
                        ? folders.filter((folder) => folder !== cwd)
                        : [...folders, cwd])}
                    >
                      {expandedFolders.includes(cwd) ? "Show fewer" : `Show all ${list.length - foldedAway(list, flowOf, chatRank)}`}
                    </button>
                  )}
                </section>
              ))}
            </section>
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
  // The menu turned into the apps to continue the chat in (MoveItems).
  const [continuing, setContinuing] = useState(false);
  // Archived in its own app, or why it can't be. The Claude app, while it
  // runs, shows it archived once it reopens (agent-sessions/claude.mjs).
  const claudeOpen = session.agent === "claude" && health.find((h) => h.agent === "claude")?.app?.open;
  const noArchive =
    session.agent === "codex" ? "" : session.agent === "claude" ? (session.inApp ? "" : "Open it in the Claude app to archive it.") : `${agentLabel(session.agent)} has no archive.`;
  return (
    <ChatPopover anchor={at} align="start" label={`${session.title || "New chat"} options`} onClose={onClose}>
      {!continuing && (
        <>
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
        </>
      )}
      {!continuing && moveChoices(session.agent, health).length > 0 && <div className="chat-popover-line" />}
      <MoveItems
        peer={peer}
        session={session}
        health={health}
        logos={logos}
        word={computerWord(peer.platform)}
        open={continuing}
        onOpen={() => setContinuing(true)}
        onBack={() => setContinuing(false)}
        onMoved={onOpen}
      />
      {!continuing && (
        <>
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
              <small>{noArchive || (claudeOpen ? "In the Claude app once it reopens" : `In ${agentLabel(session.agent)} too`)}</small>
            </span>
          </button>
        </>
      )}
    </ChatPopover>
  );
}
