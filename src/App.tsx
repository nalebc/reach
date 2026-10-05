import { MotionContext } from "./motion";
import DeviceAccessBadge from "./DeviceAccessBadge";
import { useFleetConnections } from "./useFleetConnections";
import FleetMesh, { ComputerSwitcher } from "./FleetMesh";
import {
  workspaceCapabilities,
  pageAccessible,
  type WorkspaceCapabilities,
  type CodexStatus,
} from "./capabilities";
import { useCodexAvailability } from "./useCodexAvailability";
import ScreenBoundary from "./ScreenBoundary";
import ConnectForm from "./ConnectForm";
import QuickLauncher from "./QuickLauncher";
import { ReconnectTimer } from "./reconnect";
import ScreenPopup from "./ScreenPopup";
import {
  lazy,
  useEffect,
  useState,
  useCallback,
  useRef,
  useContext,
} from "react";
import {
  LayoutGrid,
  UserRoundPlus,
  Command,
  Settings,
  HardDrive,
  Clock,
  RefreshCw,
  Link2,
  LogOut,
  Check,
  Copy,
  ExternalLink,
  Shield,
  KeyRound,
  Cpu,
  MoreHorizontal,
  Activity as ActivityIcon,
  Smartphone,
  Server,
  Download,
  Info,
  Trash2,
  Code2,
  ScanLine,
  Bot,
  X as Close,
  MessagesSquare,
} from "lucide-react";
import {
  isNative,
  onPairLink,
  scanPairCode,
  ScanCancelled,
  PairLink,
} from "./native";
import {
  Peer,
  Device,
  Session,
  Activity,
  readPeers,
  savePeers,
  compactPeers,
  upsertPeer,
  reconcilePeers,
  sameComputer,
  normalizeUrl,
  request,
  post,
  bytes,
  platform,
  AgentRequest,
} from "./api";
import {
  Logo,
  PageTitle,
  Modal,
  Empty,
  Spinner,
  ErrorLine,
  Monitor,
  Folder,
  Terminal,
  MessageSquare,
  AppWindow,
  ShieldCheck,
  Wifi,
  Plus,
  ChevronRight,
} from "./ui";
import Files from "./Files";
import EverythingChat from "./EverythingChat";
import { useAgentSessions, useChatAgent, type AgentName } from "./agent-sessions";
import { AgentLogo, useAgentLogos } from "./agent-logos";
import Apps from "./Apps";
import { GuestInvite } from "./GuestAccess";
import HomeLive from "./HomeLive";
import { WorkspaceAtmosphere, MotionToggle } from "./WorkspaceAtmosphere";
import { ReachScene } from "./ReachIdentity";
// Screens with heavy code (remote screen, terminal engine, Codex chat) load
// when first opened, then quietly in the background once the app is idle.
const loadScreen = () => import("./Screen");
const loadSessions = () => import("./Sessions");
const Screen = lazy(loadScreen);
const TerminalView = lazy(() =>
  loadSessions().then((m) => ({ default: m.TerminalView })),
);
const ChatView = lazy(() =>
  loadSessions().then((m) => ({ default: m.ChatView })),
);
const pages = [
  { id: "overview", name: "Home", icon: LayoutGrid },
  // Every Codex and Claude Code session on the computer.
  { id: "sessions", name: "Chat", icon: MessagesSquare },
  { id: "files", name: "Files", icon: Folder },
  { id: "apps", name: "Apps", icon: AppWindow },
  { id: "terminal", name: "Terminals", icon: Terminal },
  { id: "chat", name: "Codex", icon: MessageSquare },
  { id: "screen", name: "Screen", icon: Monitor },
  { id: "agents", name: "Agent access", icon: Bot },
  { id: "invite", name: "Invite someone", icon: UserRoundPlus },
];
// Bottom bar on phones; everything else is under More.
const mobileOrder = ["overview", "sessions", "screen", "terminal"];
const connectionLabel = (url: string) => {
  const host = new URL(url).hostname;
  return host.endsWith(".ts.net") ? "Tailscale" : "Direct connection";
};
export default function App() {
  return (
    <WorkspaceAtmosphere>
      <ReachWorkspace />
    </WorkspaceAtmosphere>
  );
}
function ReachWorkspace() {
  // Once the app has settled, fetch the screens that load on demand, so
  // opening them later is instant (and cached for good after that).
  useEffect(() => {
    const warm = () =>
      void Promise.all([loadScreen(), loadSessions()]).catch(() => {});
    const timer = setTimeout(
      () =>
        "requestIdleCallback" in window ? requestIdleCallback(warm) : warm(),
      3000,
    );
    return () => clearTimeout(timer);
  }, []);
  const [peers, setPeers] = useState(() => compactPeers(readPeers())),
    [active, setActive] = useState(
      () => localStorage.getItem("reach.active") || readPeers()[0]?.id || "",
    ),
    [page, setPage] = useState("overview"),
    [pairing, setPairing] = useState(false),
    [quickLaunch, setQuickLaunch] = useState(false),
    [deviceState, setDeviceState] = useState<{
      key: string;
      value: Device;
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [notice, setNotice] = useState(""),
    [terminals, setTerminals] = useState<Session[]>([]),
    [chats, setChats] = useState<Session[]>([]),
    [activities, setActivities] = useState<Activity[]>([]),
    [terminalId, setTerminalId] = useState(""),
    [terminalSource, setTerminalSource] = useState("mac"),
    [chatId, setChatId] = useState(""),
    [chatFocused, setChatFocused] = useState(false),
    [newSession, setNewSession] = useState<{
      kind: string;
      path: string;
      root: number;
    } | null>(null),
    [mobileMenu, setMobileMenu] = useState(false),
    [pairLink, setPairLink] = useState<PairLink | null>(null),
    [requests, setRequests] = useState<AgentRequest[]>([]),
    [deferred, setDeferred] = useState<string[]>([]);
  const workspaces = useRef<
    Record<
      string,
      {
        page: string;
        terminalId: string;
        terminalSource: string;
        chatId: string;
        files?: { root: number; dir: string };
      }
    >
  >({});
  const connections = useFleetConnections(peers);
  const peer = peers.find((p) => p.id === active) || peers[0];
  const peerKey = peer ? `${peer.id}:${peer.url}:${peer.token}` : "";
  const currentPeerKey = useRef(peerKey);
  currentPeerKey.current = peerKey;
  const device = deviceState?.key === peerKey ? deviceState.value : null;
  const setDevice = (value: Device | null) =>
    setDeviceState(value ? { key: peerKey, value } : null);
  const [codexRevision, setCodexRevision] = useState(0);
  const codexStatus = useCodexAvailability(peer, device, codexRevision);
  const features = workspaceCapabilities(device, codexStatus);
  const featuresRef = useRef(features);
  featuresRef.current = features;
  // Every Codex and Claude Code session, found as soon as Reach connects (owner only).
  const chatPeer =
    device && peer && pageAccessible("sessions", features) ? peer : null;
  const agentFeed = useAgentSessions(chatPeer);
  // The Chat tab wears the logo of the agent it shows (real app icons).
  const agentLogos = useAgentLogos(chatPeer);
  const [chatAgent] = useChatAgent();
  const pageIcon = (p: (typeof pages)[number], size: number) =>
    p.id === "sessions" && agentLogos[chatAgent] ? (
      <AgentLogo
        agent={chatAgent}
        logos={agentLogos}
        size={size + 2}
        className="nav-agent-logo"
      />
    ) : (
      <p.icon size={size} />
    );
  const agentsWaiting = (agentFeed.sessions || []).filter(
    (s) => s.status === "waiting",
  ).length;
  const [chatTarget, setChatTarget] = useState<{
    agent: AgentName;
    id: string;
  } | null>(null);
  const visiblePages = pages.filter((p) => pageAccessible(p.id, features));
  const mobilePages = visiblePages
    .filter((p) => mobileOrder.includes(p.id))
    .sort((a, b) => mobileOrder.indexOf(a.id) - mobileOrder.indexOf(b.id));
  const connectionGeneration = useRef(0);
  useEffect(() => {
    if (
      device &&
      !pageAccessible(page, features) &&
      !(page === "chat" && codexStatus.state === "checking")
    )
      setPage("overview");
    if (!features.shortcuts) setQuickLaunch(false);
    if (
      newSession &&
      !(newSession.kind === "terminal" ? features.terminal : features.codex)
    )
      setNewSession(null);
  }, [
    device,
    codexStatus.state,
    page,
    features.shortcuts,
    features.codex,
    features.terminal,
    newSession,
  ]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [page, peer?.id]);
  useEffect(() => setQuickLaunch(false), [peer?.id]);
  useEffect(() => {
    const original = localStorage.getItem("reach.devices");
    const saved = readPeers();
    if (!saved.length) return;
    const controller = new AbortController();
    let current = true;
    const timeout = setTimeout(() => controller.abort(), 8000);
    void reconcilePeers(saved, (candidate) =>
      request<Device>(candidate, "/api/device", { signal: controller.signal }),
    )
      .then((next) => {
        // A pairing/removal made while checks ran always wins over this migration.
        if (!current || localStorage.getItem("reach.devices") !== original)
          return;
        const previous =
          saved.find((p) => p.id === localStorage.getItem("reach.active")) ||
          saved[0];
        savePeers(next);
        setPeers(next);
        const selected = next.find((p) => sameComputer(p, previous)) || next[0];
        if (selected) {
          setActive(selected.id);
          localStorage.setItem("reach.active", selected.id);
        }
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      current = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  useEffect(() => onPairLink(setPairLink), []);
  const toast = useCallback((s: string) => setNotice(s), []);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const refreshSessions = useCallback(() => {
    if (!peer) return;
    const generation = connectionGeneration.current;
    const allowed = featuresRef.current;
    const readList = async (enabled: boolean, endpoint: string) => {
      if (!enabled) return [];
      try {
        const result = await request(peer, endpoint);
        return Array.isArray(result) ? result : [];
      } catch {
        return [];
      }
    };
    Promise.all([
      readList(allowed.terminal, "/api/terminals"),
      readList(allowed.codex, "/api/chats"),
      readList(allowed.activity, "/api/activity"),
      readList(allowed.agents, "/api/agents/requests"),
    ]).then(([t, c, a, r]) => {
      if (generation !== connectionGeneration.current) return;
      // A permission/tool update can finish while a list request is in flight.
      const current = featuresRef.current;
      setTerminals(current.terminal ? t : []);
      setChats(current.codex ? c : []);
      setActivities(current.activity ? a : []);
      setRequests(current.agents ? r : []);
      setTerminalId((old) =>
        current.terminal
          ? t.some((s) => s.id === old)
            ? old
            : t[0]?.id || ""
          : old,
      );
      setChatId((old) =>
        current.codex
          ? c.some((s) => s.id === old)
            ? old
            : c[0]?.id || ""
          : old,
      );
    });
  }, [peer?.id, peer?.url, peer?.token]);
  useEffect(() => {
    refreshSessions();
  }, [
    refreshSessions,
    features.terminal,
    features.codex,
    features.activity,
    features.agents,
  ]);
  const decide = async (r: AgentRequest, decision: "approve" | "deny") => {
    if (!peer) return;
    try {
      await post(peer, `/api/agents/requests/${r.id}`, { decision });
      toast(
        decision === "approve"
          ? `${r.name} can now reach ${peer.name}`
          : `Denied ${r.name}`,
      );
    } catch (e) {
      toast((e as Error).message);
    }
    setRequests((list) => list.filter((x) => x.id !== r.id));
    refreshSessions();
  };
  const scan = async () => {
    try {
      setPairLink(await scanPairCode());
    } catch (e) {
      if (!(e instanceof ScanCancelled)) toast((e as Error).message);
    }
  };
  const authorizeSheet = pairLink && (
    <AuthorizeSheet
      link={pairLink}
      onClose={() => setPairLink(null)}
      onPaired={(p) => {
        setPairLink(null);
        paired(p);
      }}
    />
  );
  const deviceRetry = useRef(new ReconnectTimer());
  const refreshDeviceRef = useRef<(quiet?: boolean) => void>(() => {});
  const deviceRequest = useRef<AbortController | null>(null);
  const loadDevice = useCallback(
    (quiet = false) => {
      if (!peer) return;
      deviceRequest.current?.abort();
      const controller = new AbortController();
      deviceRequest.current = controller;
      const generation = connectionGeneration.current;
      if (!quiet) {
        setLoading(true);
        setError("");
      }
      request<Device>(peer, "/api/device", {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(12000),
        ]),
      })
        .then((value) => {
          if (
            controller.signal.aborted ||
            generation !== connectionGeneration.current
          )
            return;
          deviceRetry.current.reset();
          setDevice(value);
          setError("");
        })
        .catch((e) => {
          if (
            controller.signal.aborted ||
            generation !== connectionGeneration.current
          )
            return;
          setDevice(null);
          setError(e.message);
          if (![401, 403].includes(e.status))
            deviceRetry.current.schedule(() => refreshDeviceRef.current(true));
          else deviceRetry.current.cancel();
        })
        .finally(() => {
          if (
            !controller.signal.aborted &&
            generation === connectionGeneration.current
          )
            setLoading(false);
        });
    },
    [peer?.id, peer?.url, peer?.token],
  );
  refreshDeviceRef.current = loadDevice;
  const refreshDevice = useCallback(() => {
    deviceRetry.current.cancel();
    setCodexRevision((n) => n + 1);
    loadDevice();
  }, [loadDevice]);
  // The computer's live connection says when its lists change, so they're
  // refetched then, plus a slow safety refresh. Computers that don't send
  // that (older Reach) are polled as before.
  const live = peer ? connections[peer.id]?.changes : undefined;
  const liveRef = useRef(live);
  liveRef.current = live;
  const seenChanges = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!live) return;
    const previous = seenChanges.current;
    seenChanges.current = live;
    if (previous !== undefined && previous !== live) refreshSessions();
  }, [live, refreshSessions]);
  useEffect(() => {
    seenChanges.current = undefined;
    connectionGeneration.current++;
    deviceRetry.current.reset();
    setDevice(null);
    setTerminals([]);
    setChats([]);
    setActivities([]);
    setRequests([]);
    refreshDevice();
    refreshSessions();
    let ticks = 0;
    const t = setInterval(() => {
      ticks++;
      if (document.hidden) return;
      if (!liveRef.current || ticks % 12 === 0) refreshSessions();
    }, 5000);
    const shown = () => !document.hidden && refreshSessions();
    document.addEventListener("visibilitychange", shown);
    const wake = () => {
      if (!document.hidden) loadDevice(true);
    };
    const capabilitiesTimer = setInterval(wake, 30000);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      deviceRetry.current.cancel();
      deviceRequest.current?.abort();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      document.removeEventListener("visibilitychange", shown);
      connectionGeneration.current++;
      clearInterval(t);
      clearInterval(capabilitiesTimer);
    };
  }, [peer?.id, peer?.url, peer?.token]);
  const navigate = (id: string) => {
    if (!pageAccessible(id, features)) return;
    if (id === "terminal")
      setTerminalSource(features.desktopTerminals ? "mac" : "reach");
    if (id === "chat") setChatFocused(false);
    setPage(id);
    setMobileMenu(false);
  };
  const paired = (p: Peer) => {
    const next = upsertPeer(peers, { ...p, pairedAt: Date.now() });
    savePeers(next);
    setPeers(next);
    setActive(p.id);
    localStorage.setItem("reach.active", p.id);
    setPairing(false);
    setPage("overview");
    toast(`${p.name} is within reach`);
  };
  const choose = (id: string) => {
    if (id === peer?.id) return;
    if (peer)
      workspaces.current[peer.id] = {
        ...workspaces.current[peer.id],
        page,
        terminalId,
        terminalSource,
        chatId,
      };
    // Invalidate old host responses before rendering the new input target.
    connectionGeneration.current++;
    const saved = workspaces.current[id];
    setActive(id);
    localStorage.setItem("reach.active", id);
    setPage(saved?.page || "overview");
    setTerminalId(saved?.terminalId || "");
    setTerminalSource(saved?.terminalSource || "reach");
    setChatId(saved?.chatId || "");
    setNewSession(null);
    setMobileMenu(false);
    setQuickLaunch(false);
  };
  const session = (kind: string, path = "", root = 0) => {
    if (kind === "terminal" ? features.terminal : features.codex)
      setNewSession({ kind, path, root });
  };
  if (!peers.length)
    return (
      <>
        <Welcome onPaired={paired} onScan={scan} />
        {authorizeSheet}
        {notice && (
          <div className="toast" role="status">
            <Info size={17} />
            {notice}
          </div>
        )}
      </>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo companion={page !== "overview" && page !== "screen"} />
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {visiblePages.map((p) => (
            <button
              key={p.id}
              className={page === p.id ? "active" : ""}
              aria-current={page === p.id ? "page" : undefined}
              onClick={() => navigate(p.id)}
            >
              {pageIcon(p, 19)}
              {p.name}
              {p.id === "terminal" &&
                terminals.filter((s) => s.status === "running").length > 0 && (
                  <span className="nav-count">
                    {terminals.filter((s) => s.status === "running").length}
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-devices">
          <div className="workspace-label">
            YOUR COMPUTERS
            <button
              className="icon-button"
              title="Add computer"
              onClick={() => setPairing(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          {peers.map((p) => (
            <button
              className={`sidebar-device ${p.id === peer?.id ? "selected" : ""}`}
              key={p.id}
              onClick={() => choose(p.id)}
            >
              <Monitor size={17} />
              <span>{p.name}</span>
              {p.id === peer?.id && device && <i className="status-dot" />}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="private-card">
            <ShieldCheck size={20} />
            <div>
              Paired with you.
              <small>{connectionLabel(peer.url)}</small>
            </div>
          </div>
          {features.settings && (
            <button
              className={`settings-nav ${page === "settings" ? "active" : ""}`}
              onClick={() => navigate("settings")}
            >
              <Settings size={18} />
              Settings
            </button>
          )}
          <div className="profile">
            <span className="avatar">
              {peer?.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              My workspace<small>Personal devices</small>
            </div>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="mobile-brand">
            <Logo companion={page !== "overview" && page !== "screen"} />
          </div>
          <div className="topbar-crumb">
            <span className="topbar-root">Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {pages.find((p) => p.id === page)?.name || "Settings"}
            </strong>
          </div>
          <div className="topbar-right">
            {page !== "screen" && features.shortcuts && (
              <button
                className="icon-button"
                aria-label="Shortcuts"
                title="Shortcuts"
                onClick={() => setQuickLaunch(true)}
              >
                <Command size={18} />
              </button>
            )}
            {/* Animation is on/off in Settings and follows Reduce Motion. */}
            <span className="topbar-status">
              <i className={`status-dot ${device ? "" : "off"}`} />
              {device ? "Computer connected" : "Disconnected"}
            </span>
            <button
              className="icon-button"
              title="Refresh connection"
              onClick={refreshDevice}
            >
              <RefreshCw size={17} />
            </button>
            <span className="avatar small">
              {peer?.name.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <ComputerSwitcher
          peers={peers}
          active={peer.id}
          connections={connections}
          choose={choose}
          pair={() => setPairing(true)}
        />
        <main key={peer?.id} className={`main-content page-${page}`}>
          <ScreenBoundary
            key={`${peer?.id}:${page}`}
            onHome={() => navigate("overview")}
          >
            {loading && !device ? (
              <Spinner />
            ) : error ? (
              <>
                {page === "overview" && (
                  <FleetMesh
                    peers={peers}
                    active={peer.id}
                    connections={connections}
                    choose={choose}
                  />
                )}
                <PageTitle title="Let’s reconnect" description={peer?.name} />
                <section className="panel">
                  <Empty
                    icon={Wifi}
                    title="Your computer is out of reach"
                    action={
                      <div className="button-row">
                        <button
                          className="button primary"
                          onClick={refreshDevice}
                        >
                          Try again
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => setPairing(true)}
                        >
                          Pair again
                        </button>
                      </div>
                    }
                  >
                    {error}
                    <br />
                    Reach retries connection interruptions automatically. Keep
                    your computer awake and Tailscale connected on both devices.
                  </Empty>
                </section>
              </>
            ) : device && peer && pageAccessible(page, features) ? (
              <>
                {page === "overview" && (
                  <HomeLive
                    features={features}
                    device={device}
                    peer={peer}
                    active={peer.id}
                    connections={connections}
                    connection={connectionLabel(peer.url)}
                    terminals={terminals}
                    chats={chats}
                    pending={requests.filter((r) => deferred.includes(r.id))}
                    decide={(r, decision) => void decide(r, decision)}
                    navigate={navigate}
                    openChat={(id) => {
                      setChatId(id);
                      navigate("chat");
                      setChatFocused(true);
                    }}
                    openTerminal={(id) => {
                      setTerminalId(id);
                      navigate("terminal");
                      setTerminalSource("reach");
                    }}
                    openMacTab={(id) => {
                      navigate("terminal");
                      setTerminalSource(`mac:${id}`);
                    }}
                    agentSessions={agentFeed.sessions || []}
                    openAgentSession={
                      pageAccessible("sessions", features)
                        ? (s) => {
                            setChatTarget({ agent: s.agent, id: s.id });
                            navigate("sessions");
                          }
                        : undefined
                    }
                    onShortcuts={() => setQuickLaunch(true)}
                    refreshSessions={refreshSessions}
                    toast={toast}
                  />
                )}
                {page === "files" && (
                  <Files
                    features={features}
                    peer={peer}
                    peers={peers}
                    device={device}
                    initialLocation={workspaces.current[peer.id]?.files}
                    onLocationChange={(files) => {
                      const previous = workspaces.current[peer.id];
                      workspaces.current[peer.id] = {
                        ...(previous || {
                          page,
                          terminalId,
                          terminalSource,
                          chatId,
                        }),
                        files,
                      };
                    }}
                    onSession={session}
                    toast={toast}
                  />
                )}
                {page === "terminal" && (
                  <TerminalView
                    desktopTerminals={features.desktopTerminals}
                    source={terminalSource}
                    setSource={setTerminalSource}
                    peer={{ ...peer, platform: device.platform }}
                    sessions={terminals}
                    selected={terminalId}
                    onSelect={setTerminalId}
                    onNew={() => session("terminal")}
                    onRefresh={refreshSessions}
                    toast={toast}
                    onExit={() => navigate("overview")}
                    onOpenScreen={
                      features.screen ? () => navigate("screen") : undefined
                    }
                  />
                )}
                {page === "sessions" && (
                  <EverythingChat
                    peer={peer}
                    feed={agentFeed}
                    target={chatTarget}
                    onTargetOpened={() => setChatTarget(null)}
                  />
                )}
                {page === "chat" && (
                  <ChatView
                    peer={peer}
                    chats={chats}
                    selected={chatId}
                    focused={chatFocused}
                    onFocus={setChatFocused}
                    onSelect={setChatId}
                    onNew={() => session("chat")}
                    onRefresh={refreshSessions}
                    toast={toast}
                  />
                )}
                {page === "apps" && (
                  <Apps
                    peer={peer}
                    device={device}
                    toast={toast}
                    screen={
                      features.screen ? () => navigate("screen") : undefined
                    }
                    changes={live}
                  />
                )}
                {page === "screen" && (
                  <Screen
                    peer={peer}
                    device={device}
                    toast={toast}
                    onChanged={refreshDevice}
                  />
                )}
                {page === "agents" && (
                  <Agents
                    peer={peer}
                    requests={requests}
                    decide={decide}
                    canJobs={features.jobs}
                  />
                )}
                {page === "invite" &&
                  (!device.access ||
                    device.access.scopes.includes("admin")) && (
                    <>
                      <PageTitle
                        title="Invite someone"
                        description="A little access. Only for a little while."
                      />
                      <GuestInvite
                        peer={peer}
                        device={device}
                        onCreated={() => {}}
                      />
                      <button
                        className="button secondary"
                        onClick={() => navigate("settings")}
                      >
                        <Shield size={17} />
                        Manage existing access
                      </button>
                    </>
                  )}
                {page === "settings" && (
                  <SettingsPage
                    features={features}
                    codexStatus={codexStatus}
                    peer={peer}
                    device={device}
                    toast={toast}
                    onChanged={refreshDevice}
                    invite={() => navigate("invite")}
                    forget={() => {
                      const next = peers.filter((p) => p.id !== peer.id);
                      savePeers(next);
                      setPeers(next);
                      setActive(next[0]?.id || "");
                    }}
                  />
                )}
              </>
            ) : null}
          </ScreenBoundary>
        </main>
        <nav className="mobile-nav" aria-label="Main navigation">
          {mobilePages.map((p) => (
            <button
              className={page === p.id ? "active" : ""}
              aria-label={p.name}
              aria-current={page === p.id ? "page" : undefined}
              key={p.id}
              onClick={() => navigate(p.id)}
            >
              {pageIcon(p, 20)}
              {p.id === "sessions" && agentsWaiting > 0 && (
                <i className="nav-badge" aria-label={`${agentsWaiting} waiting`}>
                  {agentsWaiting}
                </i>
              )}
              <span>
                {p.id === "overview"
                  ? "Home"
                  : p.id === "terminal"
                    ? "Terminal"
                    : p.name}
              </span>
            </button>
          ))}
          <button
            aria-label="More workspace options"
            aria-haspopup="dialog"
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(true)}
          >
            <MoreHorizontal size={20} />
            <span>More</span>
          </button>
        </nav>
      </div>
      {mobileMenu && (
        <ScreenPopup
          title="Explore"
          className="workspace-launcher"
          onClose={() => setMobileMenu(false)}
        >
          <div className="explore-computer">
            <span>
              <Monitor size={23} />
            </span>
            <div>
              <strong>{device?.name || peer.name}</strong>
              <small>
                {platform(device?.platform || peer.platform || "")} · your
                current workspace
              </small>
            </div>
            <i className="status-dot" />
          </div>
          <p className="section-kicker">DO MORE ON YOUR COMPUTER</p>
          <div className="explore-grid">
            {visiblePages
              .filter((p) => !mobilePages.some((m) => m.id === p.id))
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => navigate(p.id)}
                  aria-current={page === p.id ? "page" : undefined}
                >
                  <span className={`explore-icon explore-${p.id}`}>
                    {pageIcon(p, 23)}
                  </span>
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {
                        {
                          apps: "Launch your favorites",
                          terminal: "Keep commands running",
                          agents: "Manage agent access",
                          invite: "Let someone in, temporarily",
                          screen: "See your desktop",
                          files: "Browse and share files",
                          chat: "Continue with Codex",
                          overview: "Your connected world",
                        }[p.id]
                      }
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            {features.settings && (
              <button
                className="explore-settings"
                onClick={() => navigate("settings")}
              >
                <Settings size={21} />
                <span>
                  <strong>Settings</strong>
                  <small>Preferences, people & permissions</small>
                </span>
                <ChevronRight size={16} />
              </button>
            )}
          </div>
          <h3 className="section-kicker">SWITCH COMPUTER</h3>
          <div className="mobile-workspace-options">
            {peers.map((p) => (
              <button
                key={p.id}
                onClick={() => choose(p.id)}
                aria-pressed={p.id === active}
              >
                <Monitor size={21} />
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {connections[p.id]?.state === "connected"
                      ? "Connected"
                      : "Not connected"}
                  </small>
                </span>
                {p.id === active && <Check size={16} />}
              </button>
            ))}
            <button
              onClick={() => {
                setMobileMenu(false);
                setPairing(true);
              }}
            >
              <Plus size={21} />
              <span>Add a computer</span>
            </button>
          </div>
        </ScreenPopup>
      )}
      {pairing && (
        <Modal title="Add a computer" onClose={() => setPairing(false)}>
          {isNative && (
            <button
              className="button primary full big scan-button"
              onClick={() => {
                setPairing(false);
                scan();
              }}
            >
              <ScanLine size={20} />
              Scan to connect
            </button>
          )}
          <p className="modal-description">
            {isNative
              ? "Or enter the address and code shown by Reach on the computer."
              : "Run Reach on the other computer, then enter the link and pairing code it shows."}
          </p>
          <PairForm onPaired={paired} initialUrl={error ? peer?.url : ""} />
        </Modal>
      )}
      {quickLaunch && peer && features.shortcuts && (
        <ScreenPopup title="Shortcuts" onClose={() => setQuickLaunch(false)}>
          <QuickLauncher
            peer={peer}
            onDone={(name) => {
              setQuickLaunch(false);
              toast(`${name} opened`);
            }}
          />
        </ScreenPopup>
      )}
      {authorizeSheet}
      {!pairLink &&
        features.agents &&
        requests
          .filter((r) => !deferred.includes(r.id))
          .slice(0, 1)
          .map((r) => (
            <AgentRequestSheet
              key={r.id}
              request={r}
              computer={peer?.name || "your computer"}
              decide={decide}
              later={() => setDeferred((d) => [...d, r.id])}
            />
          ))}
      {newSession &&
        peer &&
        device &&
        (newSession.kind === "terminal"
          ? features.terminal
          : features.codex) && (
          <SessionModal
            kind={newSession.kind}
            initialPath={newSession.path}
            initialRoot={newSession.root}
            peer={peer}
            device={device}
            close={() => setNewSession(null)}
            created={(s) => {
              if (currentPeerKey.current !== peerKey) return;
              if (newSession.kind === "terminal") {
                setTerminalId(s.id);
                setTerminalSource("reach");
                setPage("terminal");
              } else {
                setChatId(s.id);
                setChatFocused(true);
                setPage("chat");
              }
              setNewSession(null);
              refreshSessions();
            }}
          />
        )}
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}
const deviceLabel = () =>
  /Android/i.test(navigator.userAgent)
    ? "My Android"
    : /iPhone/i.test(navigator.userAgent)
      ? "My iPhone"
      : /iPad/i.test(navigator.userAgent)
        ? "My iPad"
        : "My browser";
async function pairWith(
  url: string,
  code: string,
  name: string,
): Promise<Peer> {
  const origin = normalizeUrl(url);
  let response: Response;
  try {
    response = await fetch(origin + "/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.replace(/\s/g, ""), name }),
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw Error(
      "Can’t reach this computer. Keep Reach running and your computer awake. Connect Tailscale on your phone and open the private link.",
    );
  }
  const r = await response.json();
  if (!response.ok) throw Error(r.error);
  return { ...r.device, url: origin, token: r.token };
}
function Welcome({
  onPaired,
  onScan,
}: {
  onPaired: (p: Peer) => void;
  onScan: () => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome-brand">
        <Logo />
        <div className="welcome-controls">
          <span className="private-label">
            <ShieldCheck size={15} />
            Private by connection
          </span>
          <MotionToggle />
        </div>
      </div>
      <div className="welcome-stage">
        <div className="welcome-hero">
          <ReachScene className="welcome-device" />
          <div className="eyebrow">A LITTLE CONNECTION. A LOT CLOSER.</div>
          <h1>
            Leave your desk,
            <br />
            <span>keep your world.</span>
          </h1>
          <p>
            {isNative
              ? "Run Reach on your computer and scan the code it shows."
              : "Files, terminals, apps and AI sessions on your computer, from any device."}
          </p>
          {isNative && (
            <button className="button primary big scan-button" onClick={onScan}>
              <ScanLine size={21} />
              Scan to connect
            </button>
          )}
        </div>
        <div className="pair-card">
          <h2>Connect to your computer</h2>
          <p>A private connection, approved by you.</p>
          <PairForm onPaired={onPaired} compact={!isNative} />
        </div>
      </div>
      <footer>
        REACH <span>Your computer. Your files. Your work.</span>
      </footer>
    </div>
  );
}
function AuthorizeSheet({
  link,
  onPaired,
  onClose,
}: {
  link: PairLink;
  onPaired: (p: Peer) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!link.code)
    return (
      <Modal title={`Connect to ${link.name}`} onClose={onClose}>
        <PairForm initialUrl={link.url} onPaired={onPaired} />
      </Modal>
    );
  return (
    <Modal
      title={`Connect to ${link.name}?`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="sheet-sub">{new URL(link.url).hostname}</p>
      <ul className="grant-list">
        <li>
          <Folder size={18} /> Browse, upload and download files
        </li>
        <li>
          <Terminal size={18} /> Run terminals and Codex conversations
        </li>
        <li>
          <Monitor size={18} /> Open apps; screen access stays off unless
          enabled
        </li>
      </ul>
      <p className="form-note">
        Only connect to a computer you own or are allowed to use. Commands run
        with its user account’s permissions.
      </p>
      <ErrorLine error={error} />
      <button
        className="button primary full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            onPaired(await pairWith(link.url, link.code, deviceLabel()));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
    </Modal>
  );
}
function AgentRequestSheet({
  request: r,
  computer,
  decide,
  later,
}: {
  request: AgentRequest;
  computer: string;
  decide: (r: AgentRequest, d: "approve" | "deny") => Promise<void>;
  later: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (d: "approve" | "deny") => {
    setBusy(true);
    await decide(r, d);
  };
  return (
    <div className="sheet-scrim">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Agent access request"
      >
        <div className="agent-badge">
          <Bot size={30} />
        </div>
        <div className="eyebrow">ACCESS REQUEST</div>
        <h2>
          {r.name} wants to use {computer}
        </h2>
        <div className="scope-chips">
          {r.scopes.map((s) => (
            <span
              key={s}
              className={`badge ${["exec", "terminal", "screen"].includes(s) ? "warn" : "green"}`}
            >
              {scopeLabel(s)}
            </span>
          ))}
        </div>
        <p className="sheet-sub">
          {r.scopes.some((s) => ["exec", "terminal"].includes(s))
            ? "It will be able to run commands with your account’s permissions."
            : "It gets only the access listed above."}{" "}
          You can revoke it anytime in Settings.
        </p>
        <button
          className="button primary full big"
          disabled={busy}
          onClick={() => act("approve")}
        >
          <ShieldCheck size={19} />
          Authorize
        </button>
        <div className="button-row sheet-row">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => act("deny")}
          >
            Deny
          </button>
          <button className="button ghost" disabled={busy} onClick={later}>
            Decide later
          </button>
        </div>
      </div>
    </div>
  );
}
const scopeLabel = (s: string) =>
  ({
    admin: "Full access",
    "files:read": "Read files",
    "files:write": "Write files",
    files: "Files",
    exec: "Run commands",
    terminal: "Terminals",
    apps: "Open apps",
    codex: "Codex",
    screen: "Screen",
  })[s] || s;
function PairForm(props: {
  onPaired: (p: Peer) => void;
  initialUrl?: string;
  compact?: boolean;
}) {
  return (
    <ConnectForm
      initialUrl={props.initialUrl}
      onPaired={props.onPaired}
      name={deviceLabel()}
      legacy={(url) => <LegacyPairForm {...props} initialUrl={url} />}
    />
  );
}
function LegacyPairForm({
  onPaired,
  initialUrl,
  compact = false,
}: {
  onPaired: (p: Peer) => void;
  initialUrl?: string;
  compact?: boolean;
}) {
  const [url, setUrl] = useState(
      initialUrl || (isNative ? "" : location.origin),
    ),
    [code, setCode] = useState(""),
    [name, setName] = useState(deviceLabel),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          onPaired(await pairWith(url, code, name));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {!compact && (
        <label>
          Computer address
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-computer.tailnet.ts.net:8443"
          />
        </label>
      )}
      <label>
        Pairing code
        <input
          className="pair-code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="0000 0000"
          value={code}
          onChange={(e) =>
            setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 9))
          }
        />
      </label>
      {!compact && (
        <label>
          Name this connection
          <input
            required
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      <ErrorLine error={error} />
      <button className="button primary full" disabled={busy}>
        {busy ? (
          "Connecting…"
        ) : (
          <>
            <Link2 size={17} />
            Connect computer
          </>
        )}
      </button>
      <p className="form-note">
        <ShieldCheck size={14} />
        Codes work once and expire after 10 minutes. Press Enter in your
        computer’s Reach terminal in local mode, or run ./reach pair for a fresh
        code.
      </p>
    </form>
  );
}
function SessionModal({
  kind,
  initialPath,
  initialRoot,
  peer,
  device,
  close,
  created,
}: {
  kind: string;
  initialPath: string;
  initialRoot: number;
  peer: Peer;
  device: Device;
  close: () => void;
  created: (s: Session) => void;
}) {
  const [name, setName] = useState(""),
    [root, setRoot] = useState(initialRoot),
    [path, setPath] = useState(initialPath),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={
        kind === "terminal" ? "Start a terminal" : "Start a Codex conversation"
      }
      onClose={close}
    >
      <p className="modal-description">
        Runs on {device.name}. You can reconnect from any paired device.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            created(
              await post(
                peer,
                kind === "terminal" ? "/api/terminals" : "/api/chats",
                { name: name || undefined, root, path },
              ),
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Name
          <input
            autoFocus
            placeholder={
              kind === "terminal"
                ? "e.g. Website development"
                : "e.g. Build my next idea"
            }
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Shared folder
          <select
            value={root}
            onChange={(e) => setRoot(Number(e.target.value))}
          >
            {device.roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          Subfolder <span className="muted">(optional)</span>
          <input
            placeholder="Documents/my-project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        {kind === "chat" && (
          <p className="form-note">
            Codex must be installed and signed in on this computer. It will ask
            for approval when needed.
          </p>
        )}
        <ErrorLine error={error} />
        <button className="button primary full" disabled={busy}>
          {busy
            ? "Starting…"
            : kind === "terminal"
              ? "Open terminal"
              : "Start conversation"}
        </button>
      </form>
    </Modal>
  );
}
function SettingsPage({
  features,
  codexStatus,
  invite,
  peer,
  device,
  toast,
  forget,
  onChanged,
}: {
  peer: Peer;
  device: Device;
  toast: (s: string) => void;
  forget: () => void;
  invite: () => void;
  features: WorkspaceCapabilities;
  codexStatus: CodexStatus;
  onChanged: () => void;
}) {
  const [settingsView, setSettingsView] = useState("general");
  const motion = useContext(MotionContext);
  const toggleScreen = async () => {
    try {
      await post(peer, "/api/settings", {
        screen: !device.capabilities.screen,
      });
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const [clientsError, setClientsError] = useState("");
  const [clientsLoading, setClientsLoading] = useState(true);
  const clientsGeneration = useRef(0);
  const [clients, setClients] = useState<
      {
        id: string;
        name: string;
        createdAt: string;
        scopes?: string[];
        expiresAt?: number;
        kind?: string;
        status?: string;
      }[]
    >([]),
    [current, setCurrent] = useState("");
  const load = () => {
    const generation = clientsGeneration.current;
    return request(peer, "/api/clients")
      .then((r) => {
        if (generation !== clientsGeneration.current) return;
        if (!Array.isArray(r?.clients))
          throw new Error("Device access list couldn’t load. Retrying…");
        setClients(r.clients);
        setCurrent(r.current);
        setClientsError("");
      })
      .catch((e) => {
        if (generation === clientsGeneration.current)
          setClientsError(e.message);
      })
      .finally(() => {
        if (generation === clientsGeneration.current) setClientsLoading(false);
      });
  };
  useEffect(() => {
    clientsGeneration.current++;
    load();
    const timer = setInterval(load, 5000);
    return () => {
      clientsGeneration.current++;
      clearInterval(timer);
    };
  }, [peer.id, peer.url, peer.token]);
  return (
    <div className="settings-workspace">
      <PageTitle
        title="Settings"
        eyebrow={device.name}
        description="Make yourself at home."
      />
      <div
        className="settings-segments"
        role="group"
        aria-label="Settings sections"
      >
        <button
          aria-pressed={settingsView === "general"}
          onClick={() => setSettingsView("general")}
        >
          General
        </button>
        <button
          aria-pressed={settingsView === "access"}
          onClick={() => setSettingsView("access")}
        >
          Access <span>{clients.length}</span>
        </button>
      </div>
      <div className="settings-general" hidden={settingsView !== "general"}>
        <section className="panel settings-panel computer-settings-card">
          <div className="settings-device">
            <span className="settings-device-icon">
              <Monitor size={24} />
            </span>
            <div>
              <h2>{device.name}</h2>
              <span className="muted">
                {platform(device.platform)} · Connected
              </span>
            </div>
          </div>
          <details className="settings-details">
            <summary>Connection & shared folders</summary>
            <dl>
              <dt>Name</dt>
              <dd>{device.name}</dd>
              <dt>Address</dt>
              <dd>{peer.url}</dd>
              <dt>System</dt>
              <dd>
                {platform(device.platform)} · {device.arch}
              </dd>
              <dt>Shared folders</dt>
              <dd>
                {device.roots.map((r) => (
                  <div key={r.id}>{r.path}</div>
                ))}
              </dd>
            </dl>
            <p className="muted">
              Shared folders limit the file browser. Terminal and command access
              run with your computer account’s permissions.
            </p>
          </details>
        </section>
        {features.screenSetup && (
          <section className="panel settings-panel">
            <h2>Screen & control</h2>
            <div className="switch-row">
              <div>
                <strong>Screen viewing</strong>
                <small>
                  View your computer’s display. Mouse and keyboard control must
                  be enabled separately on the Screen page.
                </small>
              </div>
              <button
                role="switch"
                aria-checked={device.capabilities.screen}
                aria-label="Screen viewing"
                className={`switch ${device.capabilities.screen ? "on" : ""}`}
                onClick={toggleScreen}
              >
                <span />
              </button>
            </div>
          </section>
        )}
        {features.codexSetup && (
          <section className="panel settings-panel optional-tool">
            <h2>Optional tools</h2>
            <div className="switch-row">
              <div>
                <strong>Codex</strong>
                <small>
                  {
                    {
                      checking: "Checking Codex on this computer…",
                      ready: "Connected. Conversations are available in Reach.",
                      missing:
                        "Not installed. Other Reach features don’t require Codex.",
                      signin:
                        "Installed, but not signed in. Run codex login on this computer.",
                      unavailable:
                        "Codex couldn’t connect. Check its installation and sign-in on this computer.",
                    }[codexStatus.state]
                  }
                </small>
              </div>
              <button className="button secondary small" onClick={onChanged}>
                Check again
              </button>
            </div>
            {codexStatus.state === "missing" && (
              <p className="muted">
                Install and sign in to Codex CLI on this computer to enable
                conversations.
              </p>
            )}
          </section>
        )}
        <section className="panel settings-panel appearance-settings">
          <h2>Make it yours</h2>
          <div className="switch-row">
            <div>
              <strong>Living companion</strong>
              <small>
                {motion.reduced
                  ? "Reduced motion is enabled on this device."
                  : "Little moments of motion around your workspace."}
              </small>
            </div>
            <button
              className={`switch ${motion.enabled && !motion.reduced ? "on" : ""}`}
              role="switch"
              aria-label="Living companion animation"
              aria-checked={motion.enabled && !motion.reduced}
              disabled={motion.reduced}
              onClick={motion.toggle}
            >
              <span />
            </button>
          </div>
        </section>
      </div>
      <div className="settings-access" hidden={settingsView !== "access"}>
        <button className="invite-banner" onClick={invite}>
          <UserRoundPlus size={23} />
          <span>
            <strong>Invite someone</strong>
            <small>Share selected folders or your screen, temporarily.</small>
          </span>
          <ChevronRight size={18} />
        </button>
        <section className="panel settings-panel">
          <h2>Connected people & devices</h2>
          <ErrorLine error={clientsError} />
          {clientsLoading ? (
            <Spinner />
          ) : (
            !clientsError &&
            !clients.length && <p>No devices or guests to show.</p>
          )}
          <p className="muted">
            Revoking access disconnects that client. Already-running work stays
            on the computer.
          </p>
          {[...clients]
            .sort((a, b) => {
              const rank = (kind?: string) =>
                kind === "guest" ? 1 : kind === "agent" ? 2 : 0;
              return rank(a.kind) - rank(b.kind);
            })
            .map((c, i, all) => (
              <div className="access-entry" key={c.id}>
                {(i === 0 || c.kind !== all[i - 1].kind) && (
                  <h3 className="access-group-title">
                    {c.kind === "guest"
                      ? "Invited people"
                      : c.kind === "agent"
                        ? "Agents"
                        : "Paired devices"}
                  </h3>
                )}
                <div className="client-row">
                  <KeyRound size={18} />
                  <div>
                    <strong>
                      {c.name}
                      {c.id === current ? " · this device" : ""}
                    </strong>
                    <DeviceAccessBadge
                      access={[
                        {
                          kind:
                            c.kind === "guest"
                              ? "invited"
                              : c.kind === "agent"
                                ? "agent"
                                : "paired",
                          expiresAt: c.expiresAt || 0,
                        },
                      ]}
                    />
                    <small>
                      {c.scopes?.map(scopeLabel).join(" · ") || "Full access"}
                    </small>
                    <details className="access-metadata">
                      <summary>Access details</summary>
                      <small>
                        {c.kind === "guest" ? "invited" : "added"}{" "}
                        {new Date(c.createdAt).toLocaleDateString()}
                        {c.expiresAt &&
                          ` · ${c.expiresAt <= Date.now() ? "Expired" : c.kind === "guest" || c.kind === "agent" ? "Access ends" : "Sign-in expires"} ${new Date(c.expiresAt).toLocaleString()}`}
                        {c.kind === "guest" && ` · ${c.status}`}
                      </small>
                    </details>
                  </div>
                  <button
                    className="button ghost small danger revoke-access"
                    aria-label={`Revoke ${c.name}`}
                    onClick={async () => {
                      if (!confirm(`Revoke access for ${c.name}?`)) return;
                      try {
                        await request(peer, `/api/clients/${c.id}`, {
                          method: "DELETE",
                        });
                        if (c.id === current) forget();
                        else load();
                      } catch (e) {
                        toast((e as Error).message);
                      }
                    }}
                  >
                    <span>Revoke</span>
                  </button>
                </div>
              </div>
            ))}
        </section>
      </div>
      <button className="forget-computer" onClick={forget}>
        <LogOut size={17} />
        Forget this computer
      </button>
    </div>
  );
}
function Agents({
  canJobs,
  peer,
  requests,
  decide,
}: {
  peer: Peer;
  requests: AgentRequest[];
  canJobs: boolean;
  decide: (r: AgentRequest, d: "approve" | "deny") => Promise<void>;
}) {
  const [jobs, setJobs] = useState<any[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    if (!canJobs) {
      setJobs([]);
      return;
    }
    let active = true;
    const load = () =>
      request(peer, "/api/jobs")
        .then((r) => {
          if (!Array.isArray(r))
            throw new Error("Agent jobs couldn’t load. Retrying…");
          if (active) {
            setJobs(r);
            setError("");
          }
        })
        .catch((e) => active && setError(e.message));
    load();
    const t = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [peer.id, peer.url, peer.token, canJobs]);
  return (
    <>
      <PageTitle
        title="Agent access"
        description="Approve connections. Follow their work. Stay in control."
      />
      {requests.length > 0 && (
        <section className="panel settings-panel request-panel">
          <h2>Waiting for you</h2>
          {requests.map((r) => (
            <div className="client-row" key={r.id}>
              <Bot size={20} />
              <div>
                <strong>{r.name}</strong>
                <small>{r.scopes.map(scopeLabel).join(" · ")}</small>
              </div>
              <button
                className="button secondary small"
                onClick={() => decide(r, "deny")}
              >
                Deny
              </button>
              <button
                className="button primary small"
                onClick={() => decide(r, "approve")}
              >
                Authorize
              </button>
            </div>
          ))}
        </section>
      )}
      <div className="agents-grid">
        <details className="panel settings-panel agent-setup">
          <summary>
            <span>
              <strong>Connect an agent</strong>
              <small>Private access through the Reach CLI</small>
            </span>
            <Plus size={20} />
          </summary>
          <div className="quick-icon green">
            <Code2 size={24} />
          </div>
          <h2>One backend. Your tools.</h2>
          <p>
            Agents can run commands, exchange files, and manage sessions through
            the same authenticated API.
          </p>
          <ol className="steps">
            <li>
              <strong>Ask for access from the agent’s machine</strong>
              <code>
                {`REACH_URL="${peer.url}" node scripts/agent.mjs connect --name MyAgent --scopes files,exec`}
              </code>
            </li>
            <li>
              <strong>Tap Authorize on your phone</strong>
              <code>
                The request pops up in Reach. The agent receives its own
                revocable key.
              </code>
            </li>
            <li>
              <strong>Run a command</strong>
              <pre>
                {'REACH_URL="' +
                  peer.url +
                  '" \\\nREACH_TOKEN="your-agent-key" \\\nnode scripts/agent.mjs exec "pwd"'}
              </pre>
            </li>
          </ol>
          <p className="muted">
            Every agent gets its own key with only the access you approve.
            Revoke it anytime in Settings. Command access runs with your
            computer account’s permissions.
          </p>
        </details>
        {canJobs && (
          <section className="panel settings-panel agent-jobs">
            <h2>Recent work</h2>
            <ErrorLine error={error} />
            {error && !jobs.length ? (
              <p>Reach will retry loading your jobs automatically.</p>
            ) : !jobs.length ? (
              <Empty icon={Cpu} title="Ready for your first job">
                Commands started through the API will appear here.
              </Empty>
            ) : (
              jobs.slice(0, 12).map((j) => (
                <details className="job-row" key={j.id}>
                  <summary>
                    <code>{j.command}</code>
                    <span
                      className={`badge ${j.status === "completed" ? "green" : ""}`}
                    >
                      {j.status}
                    </span>
                  </summary>
                  <pre>{j.output || "No output yet."}</pre>
                </details>
              ))
            )}
          </section>
        )}
      </div>
    </>
  );
}
