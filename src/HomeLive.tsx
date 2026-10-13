import { useOpenWantedNeed } from "./deep-link";
import { useEffect, useRef, useState } from "react";
import { macTerminalsFingerprint } from "./mac-terminal-live";
import {
  Asterisk,
  Bell,
  Bot,
  Check,
  ChevronRight,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Pencil,
  Plus,
  Smartphone,
  Sparkles,
  Tablet,
  Terminal,
  Upload,
} from "lucide-react";
import {
  post,
  request,
  type AgentRequest,
  type Device,
  type Peer,
  type Session,
} from "./api";
import type { WorkspaceCapabilities } from "./capabilities";
import type { ConnectedDevice, FleetConnections } from "./useFleetConnections";
import type { MacTerminal } from "./DesktopTerminals";
import { ReachScene } from "./ReachIdentity";
import type { AgentSession, MacPrompt } from "./agent-sessions";
import { NeedsYouStrip, agentNeeds, type NeedItem } from "./NeedsYou";
import { handoffNeeds, requestOpenThread, useHandoffs } from "./handoffs";
import { useBrowserApprovals } from "./browser-approvals";
import { useAgentAdmissions } from "./agent-admissions";
import { useServiceAccess } from "./service-access";
import { usePermissionRequests } from "./permission-requests";
import { useWaitingPeople } from "./waiting-people";
import { useBellNeeds } from "./Notifications";
import { requestWords } from "./scope-words";
import { AgentLogo, useAgentLogos, type AgentLogos } from "./agent-logos";
import ScreenPopup from "./ScreenPopup";
import { useRemoteScreen } from "./useRemoteScreen";
import { useTerminalPeeks } from "./useTerminalPeeks";
import { useShortcuts } from "./shortcuts";
import ShortcutIcon from "./ShortcutIcon";
import { PauseButton } from "./PauseControl";
import { hasAccessNow, listedAccess, statusIn, type AccessSession } from "./access-list";
import { computerWord, pausedIn } from "./pause";
import "./home-live.css";

const agentName: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  openclaw: "OpenClaw",
};
// Output within this window makes a story ring spin.
const ACTIVE_MS = 4000;
// A chat that ended its turn this recently keeps its circle, marked done.
const DONE_MS = 10 * 60 * 1000;

// Why the live preview shows no fresh picture, as one short pill ("" while
// it's live or simply starting): tapped, it tries again.
export function heroStatus(
  stream: { error: string; cause: string; connecting: boolean; idle?: string },
  word = "Mac",
) {
  const why = stream.error || (stream.connecting ? stream.cause : "");
  if (stream.idle === "locked" || /\blocked\b/i.test(why)) return `${word} locked`;
  if (stream.idle === "asleep" || /\basleep\b/i.test(why)) return `${word} asleep`;
  if (!why) return "";
  if (/Screen Recording/i.test(why)) return "Screen Recording off";
  return stream.error ? "Can't show screen" : "Reconnecting";
}

const isAgent = (d: ConnectedDevice) => !!d.access?.some((a) => a.kind === "agent");
const DeviceGlyph = ({ device, size = 15 }: { device: ConnectedDevice; size?: number }) =>
  isAgent(device) ? (
    <Bot size={size} />
  ) : device.kind === "phone" ? (
    <Smartphone size={size} />
  ) : device.kind === "tablet" ? (
    <Tablet size={size} />
  ) : (
    <Monitor size={size} />
  );

// One circle in "Live on your Mac", like a story.
type Story = {
  key: string;
  name: string;
  kind: "codex" | "claude" | "gemini" | "shell" | "chat";
  mac?: boolean;
  state: "attention" | "failed" | "active" | "done" | "running" | "idle";
  line?: string;
  at: number;
  open: () => void;
};
const kindOf = (name: string): Story["kind"] =>
  /claude/i.test(name) ? "claude" : /codex/i.test(name) ? "codex" : /gemini/i.test(name) ? "gemini" : "shell";
// Codex, Claude Code and terminals wear their real app icons (from the Mac),
// filling the round frame.
const Glyph = ({
  kind,
  logos = {},
}: {
  kind: Story["kind"];
  logos?: AgentLogos;
}) => {
  const icon = kind === "shell" ? "terminal" : kind;
  // Gemini's mark ships with Reach (no app to read it from).
  if (kind === "gemini") return <AgentLogo agent="gemini" logos={logos} size={30} />;
  return logos[icon] && icon !== "chat" ? (
    <AgentLogo
      agent={icon}
      logos={logos}
      name={icon === "terminal" ? "Terminal" : undefined}
      fill
    />
  ) : kind === "codex" ? (
    <Sparkles size={22} />
  ) : kind === "claude" ? (
    <Asterisk size={24} />
  ) : kind === "chat" ? (
    <MessageSquare size={21} />
  ) : (
    <Terminal size={22} />
  );
};
const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 5
    ? "now"
    : s < 60
      ? `${s}s ago`
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : `${Math.floor(s / 3600)}h ago`;
};

function usePageVisible() {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

// Whether an element is in view. Off screen for graceMs (scrolled past), it
// counts as gone; back in view, at once. A quick scroll keeps it.
export function useOnScreen(ref: { current: Element | null }, graceMs = 5000) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (entry?.isIntersecting) setOn(true);
      else timer = setTimeout(() => setOn(false), graceMs);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref, graceMs]);
  return on;
}

// Tabs already open in Terminal on the Mac, with their last line. Terminal.app
// can only be read, not streamed, so tabs are read one after another.
function useMacTabs(
  peer: Peer,
  enabled: boolean,
  visible: boolean,
  changes?: string,
) {
  const [tabs, setTabs] = useState<MacTerminal[]>([]);
  const [peeks, setPeeks] = useState<
    Record<string, { line: string; at: number }>
  >({});
  const list = useRef<MacTerminal[]>([]);
  useEffect(() => {
    list.current = [];
    setTabs([]);
    setPeeks({});
  }, [peer.url, peer.token]);
  // A Mac that tells when its Terminal windows change is asked only then
  // (server/mac-terminal-watch.mjs); others every few seconds, as before.
  const pushed = macTerminalsFingerprint(changes);
  const told = pushed !== undefined;
  // A changed last line counts as new output.
  const note = (id: string, line: string) =>
    setPeeks((current) =>
      current[id]?.line === line
        ? current
        : { ...current, [id]: { line, at: Date.now() } },
    );
  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const r = await request<{ sessions: MacTerminal[] }>(
          peer,
          "/api/terminals/desktop",
        );
        if (stopped) return;
        list.current = r.sessions;
        setTabs(r.sessions);
      } catch {
        /* Permission or app missing: no Mac tabs on Home. */
      }
    };
    void refresh();
    const lister = told ? undefined : setInterval(() => void refresh(), 5000);
    return () => {
      stopped = true;
      clearInterval(lister);
    };
  }, [enabled, visible, peer.url, peer.token, told, pushed]);
  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false;
    if (told) {
      // Every tab's last line, answered by the Mac when one changes.
      const waits = new Set<AbortController>();
      void (async () => {
        let version = -1;
        while (!stopped) {
          const wait = new AbortController();
          waits.add(wait);
          const limit = setTimeout(() => wait.abort(), 30000);
          try {
            const r = await request<{
              version: number;
              peeks: Record<string, string>;
            }>(peer, `/api/terminals/desktop/activity?after=${version}`, {
              signal: wait.signal,
            });
            if (stopped) return;
            // Nothing new right away: never spin.
            if (r.version === version)
              await new Promise((r) => setTimeout(r, 1000));
            version = r.version;
            for (const [id, line] of Object.entries(r.peeks || {}))
              note(id, String(line));
          } catch (e) {
            if (stopped) return;
            if ((e as Error).name !== "AbortError")
              await new Promise((r) => setTimeout(r, 3000));
          } finally {
            clearTimeout(limit);
            waits.delete(wait);
          }
        }
      })();
      return () => {
        stopped = true;
        for (const wait of waits) wait.abort();
      };
    }
    let turn = 0;
    const read = async () => {
      const tab = list.current[turn++ % Math.max(1, list.current.length)];
      if (!tab || stopped) return;
      try {
        const { text } = await request<{ text: string }>(
          peer,
          `/api/terminals/desktop/${tab.id}`,
        );
        if (stopped) return;
        note(
          tab.id,
          String(text)
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => /[\p{L}\p{N}]/u.test(l))
            .pop() || "",
        );
      } catch {}
    };
    const reader = setInterval(() => void read(), 900);
    return () => {
      stopped = true;
      clearInterval(reader);
    };
  }, [enabled, visible, peer.url, peer.token, told]);
  return { tabs: enabled ? tabs : [], peeks };
}

export default function HomeLive({
  features,
  device,
  peer,
  active,
  connections,
  connection,
  appLink,
  terminals,
  chats,
  pending,
  decide,
  navigate,
  openChat,
  openTerminal,
  openMacTab,
  agentSessions = [],
  macPrompts = [],
  openAgentSession,
  showOnScreen,
  onShortcuts,
  refreshSessions,
  toast,
}: {
  features: WorkspaceCapabilities;
  device: Device;
  peer: Peer;
  active: string;
  connections: FleetConnections;
  connection: string;
  // Signed in from the browser: the Tailscale app, one tap away.
  appLink?: string;
  terminals: Session[];
  chats: Session[];
  pending: AgentRequest[];
  decide: (request: AgentRequest, decision: "approve" | "deny") => void;
  navigate: (page: string) => void;
  openChat: (id: string) => void;
  openTerminal: (id: string) => void;
  openMacTab: (id: string) => void;
  // Codex and Claude Code sessions anywhere on the Mac (the Chat feed).
  agentSessions?: AgentSession[];
  // What macOS itself is asking right now (answered at the Mac).
  macPrompts?: MacPrompt[];
  openAgentSession?: (session: AgentSession) => void;
  // Opens the live screen on a Mac dialog, to answer it there.
  showOnScreen?: (prompt: MacPrompt) => void;
  onShortcuts: () => void;
  refreshSessions: () => void;
  toast: (message: string) => void;
}) {
  const visible = usePageVisible();
  const logos = useAgentLogos(openAgentSession ? peer : null);
  const online = connections[active]?.state === "connected";
  // Paused on the computer: its screen isn't watched, not even here.
  const paused = pausedIn(connections[active]?.changes, device);
  // Live screen inside the laptop: the same stream as Screen, at preview size,
  // while the laptop is in view (scrolled past for a few seconds, the Mac
  // stops capturing and encoding it).
  const hero = useRef<HTMLElement>(null);
  const heroOnScreen = useOnScreen(hero);
  // Tapping the preview's status pill connects again.
  const [heroRetry, setHeroRetry] = useState(0);
  // On the computer itself the preview would only show itself (Screen says
  // so and streams if asked).
  const watching =
    features.screen && visible && !paused && heroOnScreen && !device.sameComputer;
  const stream = useRemoteScreen(
    peer,
    features.screen,
    watching,
    "primary",
    "preview",
    heroRetry,
    false,
  );
  const heroPill = watching
    ? heroStatus(stream, computerWord(device.platform))
    : "";
  const peeks = useTerminalPeeks(peer, features.terminal ? terminals : []);
  const mac = useMacTabs(
    peer,
    features.desktopTerminals,
    visible,
    connections[active]?.changes,
  );
  // Ages and spinning rings follow the clock.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  const waitingChats = features.codex
    ? chats.filter((c) => c.status === "waiting")
    : [];
  const agentItems = openAgentSession
    ? agentNeeds({
        peer,
        sessions: agentSessions.filter((s) => !s.archived),
        macPrompts,
        logos,
        open: openAgentSession,
        answered: refreshSessions,
        showOnScreen,
      })
    : agentNeeds({ peer, sessions: [], macPrompts, logos, open: () => {}, showOnScreen });
  // Apps agents handed you (Tag in): first, an agent waits on each.
  const [handoffs, setHandoffs] = useHandoffs(
    peer,
    true,
    connections[active]?.changes,
  );
  const handed = handoffNeeds({
    peer,
    handoffs,
    logos,
    open: (h) => {
      requestOpenThread(peer.computerId || peer.id, h.threadId);
      navigate("apps");
    },
    ended: (h) => setHandoffs((list) => list.filter((x) => x.id !== h.id)),
  });
  const browserApprovals = useBrowserApprovals(
    peer,
    features.owner && visible,
    connections[active]?.changes,
  );
  const agentAdmissions = useAgentAdmissions(
    peer,
    features.owner && visible,
    connections[active]?.changes,
  );
  const serviceAccess = useServiceAccess(peer, features.owner && visible, connections[active]?.changes);
  const permissionRequests = usePermissionRequests(peer, features.owner && visible);
  const waitingPeople = useWaitingPeople(peer, features.owner && visible, connections[active]?.changes);
  const bellNeeds = useBellNeeds(peer);
  const needItems: NeedItem[] = [
    ...bellNeeds,
    ...waitingPeople.items,
    ...agentAdmissions.items,
    ...browserApprovals.items,
    ...serviceAccess.items,
    ...permissionRequests.items,
    ...handed,
    ...pending.map(
      (r): NeedItem => ({
        key: `device:${r.id}`,
        icon: <Bell size={22} />,
        title: `${r.name} wants access to ${device.name}`,
        // What it would get, before you tap Allow.
        detail: requestWords(r.scopes),
        actions: [
          { label: "Deny", run: () => decide(r, "deny") },
          { label: "Allow", primary: true, run: () => decide(r, "approve") },
        ],
      }),
    ),
    ...agentItems.filter((i) => !i.key.startsWith("mac:")),
    ...waitingChats.map(
      (c): NeedItem => ({
        key: `chat:${c.id}`,
        icon: <Bell size={22} />,
        title: `${c.name} needs your approval`,
        actions: [{ label: "Review", primary: true, run: () => openChat(c.id) }],
      }),
    ),
    ...agentItems.filter((i) => i.key.startsWith("mac:")),
  ];
  const needsYou = needItems.length > 0;
  // A notification's request: opened for review the moment it's here.
  useOpenWantedNeed(needItems);
  const recent = (at: number) => at > 0 && now - at < ACTIVE_MS;
  const stories: Story[] = [
    ...(features.terminal ? terminals : [])
      .filter((t) => t.status === "running")
      .map((t): Story => {
        const peek = peeks[t.id];
        const lines = peek ? peek.lines : t.preview;
        return {
          key: `terminal:${t.id}`,
          name: t.name,
          kind: kindOf(t.name),
          state: recent(peek?.at || 0) ? "active" : "running",
          line: lines?.[lines.length - 1],
          at: peek?.at || 0,
          open: () => openTerminal(t.id),
        };
      }),
    ...mac.tabs.map((t): Story => {
      const peek = mac.peeks[t.id];
      return {
        key: `mac:${t.id}`,
        name: t.name || "Terminal",
        kind: kindOf(t.name || ""),
        mac: true,
        state: recent(peek?.at || 0) ? "active" : "running",
        line: peek?.line,
        at: peek?.at || 0,
        open: () => openMacTab(t.id),
      };
    }),
    // Agent sessions working anywhere on the Mac: apps, terminals, Reach.
    // Just finished (or failed): kept a few minutes, so you see it's done.
    ...(openAgentSession ? agentSessions : [])
      .filter(
        (s) =>
          !s.archived &&
          (s.live || s.status !== "idle" || now - s.updatedAt < DONE_MS),
      )
      .map((s): Story => ({
        key: `agent:${s.agent}:${s.id}`,
        name: s.title,
        kind: s.agent,
        state:
          s.status === "waiting"
            ? "attention"
            : s.status === "running"
              ? "active"
              : now - s.updatedAt < DONE_MS
                ? s.status === "error"
                  ? "failed"
                  : "done"
                : "running",
        line: s.preview,
        at: s.updatedAt,
        open: () => openAgentSession!(s),
      })),
  ];
  // What needs you first, then what is printing right now, newest first.
  const rank = { attention: 0, failed: 1, active: 2, done: 3, running: 4, idle: 5 };
  stories.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
  // At most six agent sessions, chosen after ranking so attention is never cut.
  let agentShown = 0;
  const ranked = stories.filter((s) => !s.key.startsWith("agent:") || ++agentShown <= 6);
  stories.splice(0, stories.length, ...ranked);
  const latest = stories
    .filter((s) => s.line && s.at)
    .sort((a, b) => b.at - a.at)[0];

  // ＋: start something, send a file, or open an app on the Mac.
  const [sheet, setSheet] = useState(false),
    [agents, setAgents] = useState<string[] | null>(null),
    [busy, setBusy] = useState("");
  useEffect(() => setAgents(null), [peer.url, peer.token]);
  useEffect(() => {
    if (!sheet || !features.terminal || agents) return;
    void request<{ agents: string[] }>(peer, "/api/terminals/agents")
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]));
  }, [sheet, features.terminal, peer.url]);
  const start = async (run?: string) => {
    setSheet(false);
    setBusy("start");
    try {
      const created = await post<Session>(peer, "/api/terminals", {
        root: 0,
        ...(run ? { run } : {}),
      });
      refreshSessions();
      openTerminal(created.id);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const { items: shortcuts } = useShortcuts(peer);
  // Codex and Claude Code already start above, in a Reach terminal.
  const apps = features.shortcuts
    ? shortcuts
        .filter((a) => (a.custom || a.suggested) && !a.id.startsWith("recipe:"))
        .slice(0, 8)
    : [];
  const fileInput = useRef<HTMLInputElement>(null);
  const send = async (files: FileList | null) => {
    const list = [...(files || [])];
    if (!list.length) return;
    setBusy("send");
    try {
      for (const file of list) {
        const form = new FormData();
        form.append("file", file);
        await request(peer, "/api/files/upload?root=0&path=", {
          method: "POST",
          body: form,
        });
      }
      const folder =
        device.roots[0]?.path.split(/[\\/]/).filter(Boolean).pop() || "Mac";
      toast(
        list.length === 1
          ? `Sent ${list[0].name} to ${folder}`
          : `Sent ${list.length} files to ${folder}`,
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const canStart = features.terminal || features.codex;
  const canPlus = canStart || features.writeFiles || apps.length > 0;
  const live = features.screen && stream.ready;
  // Everyone else on this computer now: other phones, guests, agents.
  const here = (connections[active]?.devices || []).filter((d) => !d.self);
  const controlling = here.find((d) => d.activity === "controlling");
  // Who may use it (people and agents you invited), for the Access card:
  // read when Home opens, when someone connects or leaves, and when a new
  // request comes in. Never on a timer.
  const [access, setAccess] = useState<
    { id: string; name: string; kind?: string; status?: string; expiresAt?: number }[]
  >([]);
  const hereKey = here.map((d) => d.id).join(",");
  const requestsKey = (() => {
    try {
      return JSON.parse(connections[active]?.changes || "{}")?.requests ?? "";
    } catch {
      return "";
    }
  })();
  // Browser agents as the Mac lists them: one that idle-ended or was
  // stopped keeps its end date, and only this list says it ended.
  const [sessions, setSessions] = useState<AccessSession[]>([]);
  useEffect(() => {
    if (!features.owner || !visible) return;
    let live = true;
    void Promise.allSettled([
      request<{ clients?: { id: string; name: string; kind?: string; status?: string; expiresAt?: number }[] }>(peer, "/api/clients"),
      request<{ agents?: AccessSession[] }>(peer, "/api/browser/agents"),
    ]).then(([clients, agents]) => {
      if (!live) return;
      if (clients.status === "fulfilled") setAccess(Array.isArray(clients.value?.clients) ? clients.value.clients : []);
      if (agents.status === "fulfilled" && Array.isArray(agents.value?.agents)) setSessions(agents.value.agents);
    });
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, features.owner, visible, hereKey, requestsKey]);
  // The same people and agents Agents & people lists (src/access-list.ts),
  // in the computer's order; of them, only who joined has access now.
  const listed = listedAccess(access, sessions, Date.now());
  const invited = access.filter((c) => listed.agents.includes(c) || listed.people.includes(c));
  const withAccess = invited.filter((c) => hasAccessNow(c, sessions)).length;
  const waiting = listed.agents.filter((c) => statusIn(c, sessions) === "pending").length;
  // Not opened (or joined) yet: listed, no access until they do.
  const unopened = invited.filter((c) => {
    const status = statusIn(c, sessions);
    return status === "invited" || (c.kind === "guest" && status === "expired");
  }).length;
  // Faces: who's here first, then who else may come in.
  const faces = [
    ...here.map((d) => ({ id: d.id, here: true, agent: isAgent(d), glyph: <DeviceGlyph device={d} size={13} /> })),
    ...invited
      .filter((c) => !here.some((d) => d.id === c.id || d.name === c.name))
      .map((c) => ({
        id: c.id,
        here: false,
        agent: c.kind === "agent",
        glyph: c.kind === "agent" ? <Sparkles size={13} /> : <b>{c.name.trim().slice(0, 1).toUpperCase()}</b>,
      })),
  ].slice(0, 4);
  const accessTitle = controlling
    ? `${controlling.name} is controlling`
    : here.length
      ? `${here.length} here now`
      : withAccess
        ? `${withAccess} with access`
        : invited.length
          ? `${invited.length} invited`
          : "Only you";
  const accessNote = waiting
    ? `${waiting} waiting for you`
    : unopened && (controlling || here.length || withAccess)
      ? `${unopened} not opened yet`
      : "Agents & people";
  return (
    <div className="home-live">
      <section className="home-hero" ref={hero}>
        <button
          className="home-hero-scene"
          aria-label={
            features.screen ? `Open ${device.name}'s screen` : "Set up screen"
          }
          onClick={() => navigate(features.screen ? "screen" : "settings")}
        >
          {features.screen && (
            <canvas
              ref={stream.canvas}
              className={`home-peek ${live ? "is-live" : ""} ${live && heroPill ? "is-held" : ""}`}
              aria-hidden="true"
            />
          )}
          <ReachScene
            mode="computer"
            companion
            liveScreen={live}
            className="home-scene"
          />
        </button>
        {heroPill && (
          // The last picture stays, dimmed; this says why. Tap: try again.
          <button
            className="home-hero-status"
            title={stream.error || stream.cause || heroPill}
            aria-label={`${heroPill}. Try again`}
            onClick={() => setHeroRetry((n) => n + 1)}
          >
            {heroPill}
          </button>
        )}
        <div className="home-hero-text">
          <h1>{device.name}</h1>
          <p>
            <i className={`status-dot ${online ? "" : "off"}`} />
            {online ? "Online" : "Connecting…"} · {connection}
            {appLink && (
              <>
                {" · "}
                <a className="home-app-link" href={appLink} target="_blank" rel="noopener noreferrer">
                  faster with the app
                </a>
              </>
            )}
            {live && !heroPill ? " · live" : paused ? " · paused" : ""}
          </p>
        </div>
        {features.owner && (
          <PauseButton
            peer={peer}
            paused={paused}
            platform={device.platform}
            className="home-pause"
            toast={toast}
          />
        )}
      </section>

      {features.owner && (
        // Who can use this computer, one tap from Home: the card opens
        // Agents & people (what each may do, Remove); Invite opens the
        // invitation at once.
        <section className={`home-access${controlling ? " controlling" : ""}`} aria-label="Access">
          <button className="home-access-who" onClick={() => navigate("invite")}>
            <span className="home-access-faces" aria-hidden="true">
              {faces.length ? (
                faces.map((f) => (
                  <i key={f.id} className={`${f.here ? "here" : ""}${f.agent ? " agent" : ""}`}>
                    {f.glyph}
                  </i>
                ))
              ) : (
                <i className="you">You</i>
              )}
            </span>
            <span className="home-access-text">
              <strong>{accessTitle}</strong>
              <small className={waiting ? "waiting" : undefined}>{accessNote}</small>
            </span>
            <ChevronRight className="home-access-go" size={17} />
          </button>
          <button
            className="home-access-add"
            aria-label="Invite an agent or someone"
            onClick={() => navigate("invite:new")}
          >
            <Plus size={17} /> Invite
          </button>
        </section>
      )}

      {needsYou && (
        // Everything that needs you, one card at a time (swipe for the next):
        // devices asking in, what the agents ask (answered right here when
        // the phone can), chats to review, then what the Mac itself asks.
        <div className="home-needs">
          <NeedsYouStrip items={needItems} />
        </div>
      )}

      {browserApprovals.review}
      {agentAdmissions.review}

      {(canPlus || stories.length > 0) && (
        <section
          className="home-section"
          aria-label={`Live on your ${computerWord(device.platform)}`}
        >
          <header>
            <h2>Live on your {computerWord(device.platform)}</h2>
          </header>
          <div className="home-stories">
            {canPlus && (
              <button
                className="story"
                aria-haspopup="dialog"
                onClick={() => setSheet(true)}
              >
                <span className="story-ring new">
                  <span>
                    {busy ? (
                      <LoaderCircle size={22} className="spin" />
                    ) : (
                      <Plus size={24} />
                    )}
                  </span>
                </span>
                <small>{stories.length ? "New" : "Start"}</small>
              </button>
            )}
            {stories.map((story) => (
              <button
                key={story.key}
                className="story"
                aria-label={`${story.name}${story.mac ? ", on your Mac" : ""}${story.state === "attention" ? ", needs you" : story.state === "active" ? ", working" : story.state === "done" ? ", done" : story.state === "failed" ? ", stopped with an error" : ""}`}
                onClick={story.open}
              >
                <span className={`story-ring ${story.state}`}>
                  <span>
                    <Glyph kind={story.kind} logos={logos} />
                  </span>
                  {story.mac && <i className="story-badge">Mac</i>}
                  {story.state === "done" && (
                    <i className="story-mark">
                      <Check size={11} strokeWidth={3} />
                    </i>
                  )}
                  {story.state === "failed" && <i className="story-mark">!</i>}
                </span>
                <small>{story.name}</small>
              </button>
            ))}
            {!stories.length && canStart && (
              <p className="home-stories-hint">
                Start an agent or a terminal on {device.name}. It shows up
                here while it runs.
              </p>
            )}
          </div>
          {latest && (
            <button className="home-now" onClick={latest.open}>
              <ChevronRight size={15} />
              <strong>{latest.name}</strong>
              <code>{latest.line}</code>
              <small>{ago(latest.at, now)}</small>
            </button>
          )}
        </section>
      )}

      {sheet && (
        <ScreenPopup
          title="Start or send"
          className="home-plus"
          onClose={() => setSheet(false)}
        >
          {canStart && (
            <div className="home-plus-list">
              {features.terminal &&
                (agents ?? []).map((agent) => (
                  <button key={agent} onClick={() => void start(agent)}>
                    <span className="home-plus-icon">
                      <Glyph
                        kind={kindOf(agent)}
                        logos={logos}
                      />
                    </span>
                    <span>
                      {agentName[agent] ?? agent}
                      <small>In a new terminal on {device.name}</small>
                    </span>
                  </button>
                ))}
              {features.terminal && (
                <button onClick={() => void start()}>
                  <span className="home-plus-icon">
                    <Terminal size={20} />
                  </span>
                  <span>
                    Terminal
                    <small>A new shell in your shared folder</small>
                  </span>
                </button>
              )}
            </div>
          )}
          {features.writeFiles && (
            <div className="home-plus-list">
              <button
                onClick={() => {
                  setSheet(false);
                  fileInput.current?.click();
                }}
              >
                <span className="home-plus-icon send">
                  <Upload size={20} />
                </span>
                <span>
                  Send a file
                  <small>
                    From this phone to{" "}
                    {device.roots[0]?.path
                      .split(/[\\/]/)
                      .filter(Boolean)
                      .pop() || device.name}
                  </small>
                </span>
              </button>
            </div>
          )}
          {apps.length > 0 && (
            <>
              <header className="home-plus-heading">
                <span>Open on {device.name}</span>
                <button
                  className="home-edit"
                  onClick={() => {
                    setSheet(false);
                    onShortcuts();
                  }}
                >
                  <Pencil size={13} /> Edit
                </button>
              </header>
              <div className="home-plus-apps">
                {apps.map((shortcut) => (
                  <button
                    key={shortcut.id}
                    onClick={async () => {
                      setSheet(false);
                      try {
                        await post(peer, "/api/apps/shortcuts", {
                          id: shortcut.id,
                        });
                        toast(`${shortcut.name} opened on ${device.name}`);
                      } catch (e) {
                        toast((e as Error).message);
                      }
                    }}
                  >
                    <span>
                      <ShortcutIcon peer={peer} shortcut={shortcut} size={30} />
                    </span>
                    <small>{shortcut.name.replace(/^Open /, "")}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </ScreenPopup>
      )}
      {features.writeFiles && (
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => void send(e.target.files)}
        />
      )}
    </div>
  );
}
