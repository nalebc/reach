// Before anything reads storage: a browser that refuses it still opens Reach.
import "./storage-fallback";
import { viewScope, useViewScroll } from "./view-memory";
import { useFleetConnections } from "./useFleetConnections";
import { watchInterfaceUpdates } from "./build-reload";
import InterfaceUpdates from "./InterfaceUpdates";
import ConnectionReport from "./ConnectionReport";
import FallbackSetup, { FallbackNotice } from "./FallbackSetup";
import KeepInSync from "./KeepInSync";
import OwnerConnection from "./OwnerConnection";
import FleetMesh, { ComputerSwitcher } from "./FleetMesh";
import {
  workspaceCapabilities,
  pageAccessible,
  type WorkspaceCapabilities,
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
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  House,
  LayoutGrid,
  ChevronDown,
  ChevronLeft,
  UsersRound,
  Command,
  Settings,
  RefreshCw,
  Link2,
  LogOut,
  Check,
  Info,
  ScanLine,
  Bot,
  MessageCircle,
  SquareTerminal,
  ScreenShare,
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
  readPeers,
  guestPeers,
  savePeers,
  peersKey,
  activeKey,
  compactPeers,
  upsertPeer,
  reconcilePeers,
  sameComputer,
  normalizeUrl,
  request,
  post,
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
  AppWindow,
  ShieldCheck,
  Wifi,
  Plus,
  ChevronRight,
} from "./ui";
import Files from "./Files";
import EverythingChat from "./EverythingChat";
import { openMacSetting, sendMacPassword, useAgentSessions, useChatAgent, type AgentName, type MacPrompt } from "./agent-sessions";
import { AgentLogo, useAgentLogos } from "./agent-logos";
import Apps from "./Apps";
import PeopleHub from "./PeopleHub";
import HomeLive from "./HomeLive";
import { WorkspaceAtmosphere, MotionToggle } from "./WorkspaceAtmosphere";
import { BrandCourier, ReachScene } from "./ReachIdentity";
import MascotIntro from "./MascotIntro";
import ComputerMenu from "./ComputerMenu";
import ToolsPage, { PinnedTools, usePinnedTools } from "./ToolsPage";
import "./workspace-navigation.css";
import WaitingComputerSheet, { type WaitingComputer } from "./WaitingComputer";
import MobileNav from "./MobileNav";
import NewSessionSheet from "./NewSessionSheet";
import { MonitorPlay } from "lucide-react";
import { homeOrigin } from "./home-origin";
import { tailnetBrowser } from "./tailnet-transport";
import { watchPrivateRecovery } from "./app-watch";
import { keepDoorKey } from "./door-key";
import { connectionName, connectionWay, tailscaleAppLink } from "./connection";
import PhonePrompts from "./PhonePrompts";
import { accessChanged } from "./live-access";
import { useFleetJoin } from "./fleet-join";
import { FaceIdSettings } from "./FaceIdSettings";
import "./settings-list.css";
import { NotificationBell, NotificationCenter } from "./Notifications";
import { wantPrompt } from "./notification-focus";
import { lastPlace, openTarget, rememberPlace, wantNeed, withoutTarget, type OpenTarget } from "./deep-link";
import { backOne, currentEntry, currentView, leavingForReload, pageDepth, pushPage, replacePage, seedBase, stackDepth } from "./nav-history";
import { requestOpenThread } from "./handoffs";
import { scopeLabel } from "./scope-words";
// Screens with heavy code (remote screen, terminal engine, Codex chat) load
// when first opened, then quietly in the background once the app is idle.
const loadScreen = () => import("./Screen");
const loadSessions = () => import("./Sessions");
const Screen = lazy(loadScreen);
const TerminalView = lazy(() =>
  loadSessions().then((m) => ({ default: m.TerminalView })),
);
const pages = [
  { id: "overview", name: "Home", icon: House },
  { id: "tools", name: "Tools", icon: LayoutGrid },
  // Every Codex and Claude Code session on the computer.
  { id: "sessions", name: "Chat", icon: MessageCircle },
  { id: "files", name: "Files", icon: Folder },
  { id: "apps", name: "Apps", icon: AppWindow },
  { id: "terminal", name: "Terminals", icon: SquareTerminal },
  { id: "screen", name: "Screen", icon: ScreenShare },
  { id: "invite", name: "Agents & people", icon: UsersRound },
];
// Stable destinations on phones and tablets; the tool pages sit under Tools.
const mobileOrder = ["overview", "screen", "tools"];
// Off the menus for now (Oct 11): Apps opens only for an app an agent handed
// you (Home, notifications).
const offMenus = new Set(["apps"]);
const menuPages = pages.filter((p) => !offMenus.has(p.id));
const connectionLabel = (url: string) => {
  const host = new URL(url).hostname;
  // Signed in from the browser: works anywhere, but the app connects device
  // to device and is faster.
  if (tailnetBrowser()) return "Tailscale in browser · faster with the app";
  return host.endsWith(".ts.net") ? "Tailscale" : "Direct connection";
};
export default function App() {
  useEffect(() => watchInterfaceUpdates(), []);
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
      () => localStorage.getItem(activeKey()) || readPeers()[0]?.id || "",
    ),
    [page, setPage] = useState("overview"),
    [chatHomeRevision, setChatHomeRevision] = useState(0),
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
    [terminalId, setTerminalId] = useState(""),
    [terminalSource, setTerminalSource] = useState("mac"),
    [chatId, setChatId] = useState(""),
    [newSession, setNewSession] = useState<{
      kind: string;
      path: string;
      root: number;
    } | null>(null),
    [computerMenu, setComputerMenu] = useState(false),
    [waitingSheet, setWaitingSheet] = useState<WaitingComputer | null>(null),
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
  const privateHandoff = useRef("");
  const recoveryCurrent = useRef<{ peer: Peer; device: Device } | null>(null);
  recoveryCurrent.current = peer && device ? { peer, device } : null;
  const recoverySelected = useRef(peer);
  recoverySelected.current = peer;
  useEffect(() => {
    if (guestPeers() || peer?.transport === "funnel" || (device && (device.access?.kind !== "device" || !device.access.scopes.includes("admin")))) return;
    return watchPrivateRecovery({
      current: () => recoveryCurrent.current,
      selected: () => recoverySelected.current,
      handoff: ({ peer: next, peers: saved, device: checked }) => {
        // Invalidate the source refresh synchronously. Its response could be
        // queued before React runs the old connection effect's cleanup.
        connectionGeneration.current++;
        deviceRequest.current?.abort();
        const key = `${next.id}:${next.url}:${next.token}`;
        privateHandoff.current = key;
        // The destination was authenticated before the route changed. Keep
        // this same computer's composer, attachments and pending sends mounted.
        setDeviceState({ key, value: checked });
        setPeers(saved);
        setActive(next.id);
        try { localStorage.setItem(activeKey(), next.id); } catch { /* Keep the current handoff when storage is full. */ }
      },
    });
  }, [peerKey, device?.access?.kind, device?.access?.scopes.join(" ")]);
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
  // The chat list's revision, as the Mac's live connection tells it: the list
  // is read when it changes, not every few seconds.
  const liveChanges = chatPeer ? connections[chatPeer.id]?.changes : undefined;
  const sessionsRevision = useMemo(() => {
    try {
      const value = liveChanges ? JSON.parse(liveChanges).sessions : undefined;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }, [liveChanges]);
  const agentFeed = useAgentSessions(chatPeer, undefined, sessionsRevision);
  // The Chat tab wears the logo of the agent it shows (real app icons).
  const agentLogos = useAgentLogos(chatPeer);
  const [chatAgent, setChatAgent] = useChatAgent();
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
    agent: AgentName | "openclaw";
    id: string;
  } | null>(null);
  const { pinned, toggle: togglePin, move: movePin } = usePinnedTools();
  const visiblePages = menuPages.filter((p) => pageAccessible(p.id, features));
  const mobilePages = visiblePages
    .filter((p) => mobileOrder.includes(p.id))
    .sort((a, b) => mobileOrder.indexOf(a.id) - mobileOrder.indexOf(b.id));
  const connectionGeneration = useRef(0);
  useEffect(() => {
    if (device && !pageAccessible(page, features))
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
  const mainScroll = useViewScroll<HTMLElement>(viewScope(peer, page), page !== "sessions" && page !== "files", !!device);
  useEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => { history.scrollRestoration = previous; };
  }, []);
  useEffect(() => setQuickLaunch(false), [peer?.id]);
  useEffect(() => {
    const original = localStorage.getItem(peersKey());
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
        if (!current || localStorage.getItem(peersKey()) !== original)
          return;
        const previous =
          saved.find((p) => p.id === localStorage.getItem(activeKey())) ||
          saved[0];
        savePeers(next);
        setPeers(next);
        const selected = next.find((p) => sameComputer(p, previous)) || next[0];
        if (selected) {
          setActive(selected.id);
          localStorage.setItem(activeKey(),selected.id);
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
      readList(allowed.agents, "/api/agents/requests"),
    ]).then(([t, c, r]) => {
      if (generation !== connectionGeneration.current) return;
      // A permission/tool update can finish while a list request is in flight.
      const current = featuresRef.current;
      setTerminals(current.terminal ? t : []);
      setChats(current.codex ? c : []);
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
          keepDoorKey(peer);
        })
        .catch((e) => {
          if (
            controller.signal.aborted ||
            generation !== connectionGeneration.current
          )
            return;
          // A status refresh can fail while the independent screen/input
          // sockets are healthy. Keep the current workspace mounted during
          // that retry; only revoked access discards its device immediately.
          if ([401, 403].includes(e.status)) setDevice(null);
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
    // What this device may use changed: its pages follow, no new link.
    if (accessChanged(previous, live)) refreshDeviceRef.current(true);
  }, [live, refreshSessions]);
  useEffect(() => {
    seenChanges.current = undefined;
    connectionGeneration.current++;
    deviceRetry.current.reset();
    const handoff = privateHandoff.current === peerKey;
    privateHandoff.current = "";
    if (!handoff) {
      setDevice(null);
      setTerminals([]);
      setChats([]);
      setRequests([]);
    }
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
  // Agents & people, opened with its invitation ("invite:new", from Home).
  const [inviteStart, setInviteStart] = useState<{ kind: "person" | "browser" | "choose"; at: number } | null>(null);
  // The back stack (src/nav-history.ts). Home is this document's first
  // entry; a tab sits one above it (switching tabs replaces it, so back from
  // any tab is Home, then out of Reach); a page opened from Tools, Settings or
  // a card pushes one more; a chat or a sub-page pushes its own on top.
  // `pageAt` is the entry of the page shown.
  const pageAt = useRef(0);
  const pageNow = useRef(page);
  pageNow.current = page;
  const afterStep = useRef<(() => void) | null>(null);
  // A root-tab switch discards that section's deeper entries before moving
  // on. Ordinary page navigation keeps them, so Back restores the exact
  // view underneath. The nested view must finish its own pop before a tab
  // replaces that entry.
  const leaveTo = (i: number, then: () => void) => {
    // Already on the way (a double tap): the entry isn't reached yet, and a
    // second step from it would run past Home, out of this page.
    if (afterStep.current) return;
    const n = stackDepth() - i;
    if (n <= 0) return then();
    afterStep.current = then;
    window.history.go(-n);
    // A browser that never says it got there still goes on.
    setTimeout(() => {
      if (afterStep.current !== then) return;
      afterStep.current = null;
      then();
    }, 800);
  };
  useEffect(() => {
    const onPop = () => {
      const then = afterStep.current;
      if (then) {
        afterStep.current = null;
        then();
        return;
      }
      if (leavingForReload()) return;
      // Back (or forward): the page that entry belongs to, as it was.
      const view = currentView();
      const next = view?.page || "overview";
      const saved = currentEntry();
      const chat = saved.reachChatTarget as { agent: AgentName | "openclaw"; id: string } | undefined;
      const claw = saved.reachClawTarget;
      if (next === "sessions") {
        if (saved.reachChat && chat) setChatTarget(chat);
        else if (saved.reachClaw === "reachClawChat" && typeof claw === "string")
          setChatTarget({ agent: "openclaw", id: claw });
      }
      if (next === pageNow.current) return;
      pageAt.current = pageDepth();
      setPage(next);
      setComputerMenu(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (
    to: string,
    { opening = false, detail = false, chat, then }: {
      opening?: boolean;
      detail?: boolean;
      chat?: { agent: AgentName | "openclaw"; id: string };
      then?: () => void;
    } = {},
  ) => {
    const id = to.startsWith("invite") ? "invite" : to;
    if (id === "invite")
      setInviteStart(to === "invite:new" ? { kind: "choose", at: Date.now() } : null);
    if (!pageAccessible(id, features)) return;
    // Re-selecting Chat is a shortcut to its root, from any nested view.
    // Keep the chosen provider and shared feed; discard only local navigation.
    // Not when going there to open a chat (a notification's): that would
    // drop the chat it was just given.
    const chatRoot = id === "sessions" && page === "sessions" && !opening;
    const show = () => {
      if (chatRoot) {
        setChatTarget(null);
        setLinkTarget(null);
        setChatHomeRevision((n) => n + 1);
      }
      setPage(id);
      setComputerMenu(false);
      then?.();
    };
    // Already there (a notification's chat on Chat): the chat pushes its own.
    if (id === page && !chatRoot) return show();
    if (id === "overview" || (mobileOrder.includes(id) && !detail)) return toTab(id, show);
    if (chatRoot) return leaveTo(pageAt.current, show);
    // Keep the exact view underneath: Settings opened from a conversation
    // returns to that conversation, not its list or the Tools page.
    const at = stackDepth();
    const marks = chat
      ? chat.agent === "openclaw"
        ? { reachClaw: "reachClawChat", reachClawTarget: chat.id }
        : { reachChat: true, reachChatTarget: chat }
      : {};
    pushPage(id, at, marks);
    pageAt.current = at + 1;
    show();
  };
  const goBack = () => {
    if (!backOne()) navigate("overview");
  };
  const openChat = (chat: { agent: AgentName | "openclaw"; id: string }) => {
    setChatTarget(chat);
    navigate("sessions", { opening: true, chat });
  };
  // Home is the first entry; any other tab the one above it.
  const toTab = (id: string, then: () => void) => {
    const at = pageAt.current;
    if (id === "overview")
      return leaveTo(0, () => {
        replacePage("overview", 0);
        pageAt.current = 0;
        then();
      });
    leaveTo(Math.min(at, 1), () => {
      if (at === 0) pushPage(id, 0);
      else replacePage(id, 1);
      pageAt.current = 1;
      then();
    });
  };
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // A page that started a Reach terminal (OpenClaw's setup) opens it here.
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string" || !id || !pageAccessible("terminal", featuresRef.current)) return;
      setTerminalId(id);
      navigateRef.current("terminal", { then: () => setTerminalSource("reach") });
    };
    window.addEventListener("reach:open-terminal", open);
    return () => window.removeEventListener("reach:open-terminal", open);
  }, []);
  // A notification's link (?page=…): opened once Reach knows what this phone
  // may see, then dropped from the address so a reload doesn't open it again.
  // With Reach already open, the service worker passes the link instead.
  const [linkTarget, setLinkTarget] = useState<OpenTarget | null>(() => {
    const target = openTarget(location.href);
    // This document's first entry is Home, under whatever opens next (the
    // link's chat, or where a reload was): back from it lands here, never
    // on an entry of the page before the reload (src/nav-history.ts).
    seedBase(target ? withoutTarget(location.href) : undefined);
    // Without one, a reload comes back to where you were.
    return target || lastPlace(active);
  });
  useEffect(() => {
    if (peer) rememberPlace(peer.id, { page });
  }, [page, peer?.id]);
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.data?.type === "reach-open" && typeof event.data.url === "string") {
        const target = openTarget(event.data.url);
        if (target) setLinkTarget(target);
      }
    };
    navigator.serviceWorker?.addEventListener("message", message);
    return () => navigator.serviceWorker?.removeEventListener("message", message);
  }, []);
  useEffect(() => {
    if (!linkTarget || !peer || !device) return;
    if (linkTarget.computer && ![peer.id, peer.computerId].includes(linkTarget.computer)) {
      const computer = peers.find((p) => [p.id, p.computerId].includes(linkTarget.computer));
      if (computer) { setActive(computer.id); localStorage.setItem(activeKey(), computer.id); }
      return;
    }
    if (!pageAccessible(linkTarget.page, features)) return;
    openTargetNow(linkTarget);
    setLinkTarget(null);
  }, [linkTarget, peer?.id, device, features]);
  // A Mac dialog to answer on the live screen (from a "Show on screen" card),
  // and the page to go back to after.
  const [screenAsk, setScreenAsk] = useState<{ prompt: MacPrompt; from: string } | null>(null);
  const showOnScreen = features.screen
    ? (prompt: MacPrompt) => {
        setScreenAsk({ prompt, from: page });
        navigate("screen", { detail: true });
      }
    : undefined;
  const paired = (p: Peer) => {
    const next = upsertPeer(peers, { ...p, pairedAt: Date.now() });
    savePeers(next);
    setPeers(next);
    setActive(p.id);
    localStorage.setItem(activeKey(),p.id);
    setPairing(false);
    setPage("overview");
    toast(`${p.name} is within reach`);
  };
  // Your linked computers join by themselves (src/fleet-join.ts).
  const waitingComputers = useFleetJoin(peer, peers, deviceLabel(), (p) => {
    setPeers((old) => {
      const next = upsertPeer(old, { ...p, pairedAt: Date.now() });
      savePeers(next);
      return next;
    });
    toast(`${p.name} is within reach`);
  });
  const choose = (id: string, then?: () => void) => {
    if (id === peer?.id) return;
    if (peer)
      workspaces.current[peer.id] = {
        ...workspaces.current[peer.id],
        page,
        terminalId,
        terminalSource,
        chatId,
      };
    // The other computer's page, as a tab: the chat or sub-page open on this
    // one closes first (see leaveTo).
    toTab(workspaces.current[id]?.page || "overview", () => {
      switchTo(id);
      then?.();
    });
  };
  const switchTo = (id: string) => {
    // Invalidate old host responses before rendering the new input target.
    connectionGeneration.current++;
    const saved = workspaces.current[id];
    setActive(id);
    localStorage.setItem(activeKey(),id);
    setPage(saved?.page || "overview");
    setTerminalId(saved?.terminalId || "");
    setTerminalSource(saved?.terminalSource || "reach");
    setChatId(saved?.chatId || "");
    setNewSession(null);
    setComputerMenu(false);
    setQuickLaunch(false);
    // The computer you pick wins over a link still waiting for another one
    // (a chat opened on a computer that never answered): it doesn't pull you
    // back there once this one loads.
    setLinkTarget(null);
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
  // Opens what a notification (or the bell's list) points at, in one go:
  // the chat itself, the app handed to you, or the request opened for review.
  function openTargetNow(target: OpenTarget) {
    if (target.page === "sessions" && target.agent && target.id && target.prompt)
      wantPrompt({ agent: target.agent, session: target.id, id: target.prompt });
    if (target.page === "sessions" && ["codex", "claude", "gemini", "openclaw"].includes(target.agent || "") && target.id)
      setChatTarget({ agent: target.agent as AgentName | "openclaw", id: target.id });
    if (target.page === "sessions" && target.agent === "openclaw") setChatAgent("openclaw");
    if (target.page === "apps" && target.threadId) requestOpenThread(peer.id, target.threadId);
    if (target.needs) wantNeed(target.needs);
    const chat = target.page === "sessions" && target.id && ["codex", "claude", "gemini", "openclaw"].includes(target.agent || "")
      ? { agent: target.agent as AgentName | "openclaw", id: target.id } : undefined;
    navigate(target.page, { opening: true, chat });
  }
  return (
    <NotificationCenter peer={peer} enabled={!!device && !!features.settings} changes={live} onOpen={({ target }) => openTargetNow(target)}>
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
              title="Add computer" aria-label="Add computer"
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
          <button
            className="workspace-computer"
            aria-label={`${device?.name || peer.name}, switch computer`}
            aria-haspopup="dialog"
            aria-expanded={computerMenu}
            onClick={() => setComputerMenu(true)}
          >
            <i
              className={`status-dot ${device && !error ? "" : "off"}`}
              aria-hidden="true"
            />
            <span>{device?.name || peer.name}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
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
            <NotificationBell compact />
            {features.settings && (
              <button
                className="icon-button workspace-settings"
                aria-label="Settings"
                title="Settings"
                onClick={() => navigate("settings")}
              >
                <Settings size={20} />
              </button>
            )}
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
              <i className={`status-dot ${device && !error ? "" : "off"}`} />
              {device ? (error ? "Reconnecting…" : "Computer connected") : "Disconnected"}
            </span>
            <button
              className="icon-button"
              title="Refresh connection" aria-label="Refresh connection"
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
          waiting={waitingComputers}
          onWaiting={setWaitingSheet}
        />
        <main ref={mainScroll} key={peer?.id} className={`main-content page-${page}`}>
        {device && <OwnerConnection peer={peer} device={device} />}
          <ScreenBoundary
            key={`${peer?.id}:${page}`}
            onHome={() => navigate("overview")}
          >
            {loading && !device ? (
              <>
                <Spinner />
                <div className="gs-group"><ConnectionReport peer={peer} toast={toast} /></div>
              </>
            ) : error && !device ? (
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
                    your computer awake with Reach and Tailscale running. The phone app is optional after owner setup.
                  </Empty>
                  <div className="gs-group"><ConnectionReport peer={peer} toast={toast} /></div>
                </section>
              </>
            ) : device && peer && pageAccessible(page, features) ? (
              <>
                {error && <FallbackNotice peer={peer} device={device} />}
                {(!mobileOrder.includes(page) || (page === "screen" && pageAt.current > 1)) && (
                  <button className="workspace-back" aria-label="Back to previous view" onClick={goBack}>
                    <ChevronLeft size={18} />Back
                  </button>
                )}
                {page === "tools" && (
                  <ToolsPage
                    features={features}
                    pinned={pinned}
                    onTogglePin={togglePin}
                    onNavigate={navigate}
                    waiting={agentsWaiting}
                  />
                )}
                {page === "overview" && (
                  <PhonePrompts owner={features.owner} url={peer.url} peer={peer} device={device} />
                )}
                {page === "overview" && (
                  <HomeLive
                    pinnedTools={
                      <PinnedTools features={features} pinned={pinned} onNavigate={navigate} onTogglePin={togglePin} onMove={movePin} />
                    }
                    features={features}
                    device={device}
                    peer={peer}
                    active={peer.id}
                    connections={connections}
                    connection={connectionName(peer.url)}
                    appLink={
                      connectionWay(peer.url) === "browser"
                        ? tailscaleAppLink()
                        : undefined
                    }
                    chats={chats}
                    pending={requests.filter((r) => deferred.includes(r.id))}
                    decide={(r, decision) => void decide(r, decision)}
                    navigate={navigate}
                    openChat={(id) => openChat({ agent: "codex", id })}
                    agentSessions={agentFeed.sessions || []}
                    macPrompts={agentFeed.macPrompts}
                    showOnScreen={showOnScreen}
                    openAgentSession={
                      pageAccessible("sessions", features)
                        ? (s) => openChat({ agent: s.agent, id: s.id })
                        : undefined
                    }
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
                    agentSessions={
                      chatPeer?.id === peer.id
                        ? agentFeed.sessions || []
                        : undefined
                    }
                    agentLogos={agentLogos}
                    openAgentSession={
                      pageAccessible("sessions", features)
                        ? (s) => openChat({ agent: s.agent, id: s.id })
                        : undefined
                    }
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
                    onExit={goBack}
                    onOpenScreen={
                      features.screen ? () => navigate("screen", { detail: true }) : undefined
                    }
                    changes={live}
                    owner={pageAccessible("sessions", features)}
                  />
                )}
                {page === "sessions" && (
                  <EverythingChat
                    key={`${peer.id}:${chatHomeRevision}`}
                    peer={peer}
                    feed={agentFeed}
                    target={chatTarget}
                    onTargetOpened={() => setChatTarget(null)}
                    showOnScreen={showOnScreen}
                    onScreen={features.screen ? () => navigate("screen", { detail: true }) : undefined}
                    // The All page covers every paired computer; a chat on
                    // another opens the way a notification from it does:
                    // that computer first, then the chat once it's connected.
                    computers={peers}
                    connections={connections}
                    onOpenOn={(computer, chat) => {
                      choose(computer.id, () =>
                        setLinkTarget({ page: "sessions", agent: chat.agent, id: chat.id, computer: computer.id }));
                    }}
                    // A shell block's play button: a Reach terminal in the
                    // chat's folder runs it, and opens so you see it run.
                    runCommand={
                      pageAccessible("terminal", features)
                        ? (cwd, command) =>
                            void post<{ id: string }>(peer, "/api/terminals", { ...(cwd ? { cwd } : {}), input: command })
                              .then((created) => {
                                setTerminalId(created.id);
                                setTerminalSource("reach");
                                navigate("terminal");
                              })
                              .catch((e) => toast((e as Error).message))
                        : undefined
                    }
                  />
                )}
                {page === "apps" && (
                  <Apps
                    peer={peer}
                    device={device}
                    toast={toast}
                    screen={
                      features.screen ? () => navigate("screen", { detail: true }) : undefined
                    }
                    changes={live}
                  />
                )}
                {page === "screen" && (
                  <Screen
                    onClose={goBack}
                    peer={peer}
                    device={device}
                    toast={toast}
                    onChanged={refreshDevice}
                    changes={live}
                    ask={
                      screenAsk
                        ? {
                            id: screenAsk.prompt.id,
                            kind: screenAsk.prompt.kind,
                            title: screenAsk.prompt.lines?.[0] || screenAsk.prompt.title,
                            bounds: screenAsk.prompt.bounds,
                            setting: screenAsk.prompt.setting,
                            open: (agentFeed.macPrompts || []).some((p) => p.id === screenAsk.prompt.id),
                          }
                        : null
                    }
                    onAskDone={() => {
                      const from = screenAsk?.from;
                      setScreenAsk(null);
                      if (from && from !== "screen") goBack();
                    }}
                    onAskPassword={(password) => sendMacPassword(peer, screenAsk!.prompt.id, password)}
                    onAskSetting={async () => {
                      const r = await openMacSetting(peer, screenAsk!.prompt.id);
                      return `Opened on your Mac: switch on ${r.app ? `“${r.app}”` : "it"} in ${r.opened}.`;
                    }}
                  />
                )}
                {page === "invite" &&
                  (!device.access ||
                    (device.access.scopes.includes("admin") &&
                      device.access.kind !== "guest")) && (
                    <PeopleHub key={`${peer.id}:${peer.url}:${peer.token}`} peer={peer} device={device} peers={peers} start={inviteStart} here={(connections[peer.id]?.devices || []).filter((d) => !d.self)} toast={toast} />
                  )}
                {page === "settings" && (
                  <SettingsPage
                    key={`${peer.id}:${peer.url}:${peer.token}`}
                    features={features}
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
        <MobileNav
          items={mobilePages.map((p) => ({
            id: p.id,
            label: p.name,
            icon: pageIcon(p, 20),
            badge: p.id === "tools" ? agentsWaiting : 0,
          }))}
          current={page}
          onNavigate={navigate}
        />
      </div>
      {computerMenu && peer && (
        <ComputerMenu
          peers={peers}
          active={active}
          connections={connections}
          onChoose={choose}
          onAdd={() => {
            setComputerMenu(false);
            setPairing(true);
          }}
          waiting={waitingComputers}
          onWaiting={(computer) => {
            setComputerMenu(false);
            setWaitingSheet(computer);
          }}
          onClose={() => setComputerMenu(false)}
        />
      )}
      {waitingSheet && peer && (
        <WaitingComputerSheet
          computer={waitingSheet}
          here={peer}
          onClose={() => setWaitingSheet(null)}
        />
      )}
      {pairing && (
        <Modal
          title="Add a computer"
          className="pair-sheet"
          onClose={() => setPairing(false)}
        >
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
          <p className="sheet-line sheet-hint">
            {isNative
              ? "Or enter the address and code Reach shows on the computer."
              : "Run Reach on the other computer, then enter the link and code it shows."}
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
          <NewSessionSheet
            kind={newSession.kind}
            initialPath={newSession.path}
            initialRoot={newSession.root}
            peer={peer}
            device={device}
            recent={[...terminals, ...chats]
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
              .map((s) => s.cwd)}
            close={() => setNewSession(null)}
            created={(s) => {
              if (currentPeerKey.current !== peerKey) return;
              if (newSession.kind === "terminal") {
                setTerminalId(s.id);
                setTerminalSource("reach");
                navigate("terminal");
              } else navigate("sessions");
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
    </NotificationCenter>
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
      "Can’t reach this computer. Keep Reach running and your computer awake. Then open Reach's link again.",
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
      <MascotIntro />
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
      <Modal
        title={`Connect to ${link.name}`}
        className="pair-sheet"
        onClose={onClose}
      >
        <PairForm initialUrl={link.url} onPaired={onPaired} />
      </Modal>
    );
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      onPaired(await pairWith(link.url, link.code, deviceLabel()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // What connecting gives this phone: three rows, then one Connect.
  return (
    <Modal
      title={`Connect to ${link.name}?`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <button
          className="button primary full"
          disabled={busy}
          onClick={() => void connect()}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      }
    >
      <p className="sheet-line">
        <Link2 size={14} />
        <span>{new URL(link.url).hostname}</span>
      </p>
      <div className="gs-group grant-rows">
        <div className="gs-row">
          <Folder size={21} />
          <span className="gs-label">Files</span>
          <span className="gs-value">Browse, upload, download</span>
        </div>
        <div className="gs-row">
          <Terminal size={21} />
          <span className="gs-label">Terminals and Codex</span>
        </div>
        <div className="gs-row">
          <Monitor size={21} />
          <span className="gs-label">Apps</span>
          <span className="gs-value">Screen off unless enabled</span>
        </div>
      </div>
      <p className="sheet-note">
        Only connect to a computer you own or may use. Commands run with its
        account’s permissions.
      </p>
      <ErrorLine error={error} />
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
              className={`badge ${["exec", "terminal", "screen", "apps:drive"].includes(s) ? "warn" : "green"}`}
            >
              {scopeLabel(s)}
            </span>
          ))}
        </div>
        <p className="sheet-sub">
          {r.scopes.includes("apps:drive")
            ? "It will be able to use any app as you, Terminal included."
            : r.scopes.some((s) => ["exec", "terminal"].includes(s))
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
      legacy={(url, command) => <LegacyPairForm {...props} initialUrl={url} command={command} />}
    />
  );
}
function LegacyPairForm({
  onPaired,
  initialUrl,
  compact = false,
  command,
}: {
  onPaired: (p: Peer) => void;
  initialUrl?: string;
  compact?: boolean;
  command?: string;
}) {
  const [url, setUrl] = useState(
      initialUrl || (isNative ? "" : homeOrigin()),
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
        {/* A fresh code the way every Reach gives one (local mode, a
            Windows PC that can't hold its keyed route, the approval page's
            fallback), said as that computer runs Reach. */}
        Codes work once and expire after 10 minutes. For a fresh one, run{" "}
        {command || "reach"} pair on your computer.
      </p>
    </form>
  );
}
export function SettingsPage({
  features,
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
  onChanged: () => void;
}) {
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
  const [details, setDetails] = useState(false);
  const online = true;
  const host = connectionName(peer.url);
  return (
    // As ChatGPT lays out its settings: who it is on top, then short
    // grouped lists (a line icon, a name, a value, a chevron). Reach's own
    // dark green and its mascot.
    <div className="settings-workspace gs">
      <header className="gs-head">
        <span className="gs-mascot" aria-hidden="true">
          <BrandCourier active />
        </span>
        <h1>{device.name}</h1>
        <p>
          <span className={`status-text ${online ? "on" : ""}`}>Connected</span>
          <span>{platform(device.platform)}</span>
          {host && <span>{host}</span>}
        </p>
      </header>

      <h2 className="gs-title">This computer</h2>
      <div className="gs-group">
        {features.screenSetup && (
          <div className="gs-row">
            <MonitorPlay size={21} />
            <span className="gs-label">Screen viewing</span>
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
        )}
        <button className="gs-row" onClick={() => setDetails(true)}>
          <Folder size={21} />
          <span className="gs-label">Shared folders</span>
          <span className="gs-value">{device.roots.length}</span>
          <ChevronRight className="gs-chevron" size={18} />
        </button>
        <InterfaceUpdates peer={peer} owner={!device.access || (device.access.scopes.includes("admin") && device.access.kind !== "guest")} />
        <ConnectionReport peer={peer} toast={toast} />
        <FallbackSetup peer={peer} device={device} />
      </div>

      {/* What Reach drives here, behind or too old: Update (KeepInSync.tsx). */}
      <KeepInSync peer={peer} owner={!device.access || (device.access.scopes.includes("admin") && device.access.kind !== "guest")} />

      {/* Who can use this computer: one place (PeopleHub.tsx), the owner's. */}
      {(!device.access || (device.access.scopes.includes("admin") && device.access.kind !== "guest")) && (
        <>
          <h2 className="gs-title">Access</h2>
          <div className="gs-group">
            <button className="gs-row" onClick={invite}>
              <UsersRound size={21} />
              <span className="gs-label">Agents &amp; people</span>
              <ChevronRight className="gs-chevron" size={18} />
            </button>
          </div>
        </>
      )}

      <FaceIdSettings peer={peer} />
      {/* Notifications live in the bell's panel only: nothing about them here. */}

      <div className="gs-group gs-end">
        <button className="gs-row gs-danger" onClick={forget}>
          <LogOut size={21} />
          <span className="gs-label">Forget this computer</span>
        </button>
      </div>

      {details && (
        <ScreenPopup title="This computer" className="gs-sheet" onClose={() => setDetails(false)}>
          <div className="gs-group">
            <div className="gs-row">
              <span className="gs-label">Name</span>
              <span className="gs-value">{device.name}</span>
            </div>
            <div className="gs-row">
              <span className="gs-label">System</span>
              <span className="gs-value">
                {platform(device.platform)} · {device.arch}
              </span>
            </div>
            <div className="gs-row">
              <span className="gs-label">Address</span>
              <span className="gs-value">{new URL(peer.url).host}</span>
            </div>
          </div>
          <h2 className="gs-title">Shared folders</h2>
          <div className="gs-group">
            {device.roots.map((r) => (
              <div className="gs-row" key={r.id}>
                <Folder size={21} />
                <span className="gs-label gs-path">{r.path}</span>
              </div>
            ))}
          </div>
          <p className="gs-foot">
            Files are limited to these folders. Terminals run as your computer
            account.
          </p>
        </ScreenPopup>
      )}
    </div>
  );
}
