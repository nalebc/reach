import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Lock,
  ShieldCheck,
  Download,
  FileText,
  Folder,
  Monitor,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import { fileBlob, peerFetch, request, type FileEntry, type Peer } from "./api";
import { saveBlob } from "./native";
import { BrowserActionRequests } from "./browser-approvals";
import { installBrowserTools } from "./browser-tools";
import BrowserScreenControls from "./BrowserScreenControls";
import BrowserTerminal from "./BrowserTerminal";
import BrowserAppScreen from "./BrowserAppScreen";
import AgentPage, { type PresetAccess } from "./AgentPage";
import AgentWorkspaceFrame, {
  type AgentSection,
  type AgentDestination,
} from "./AgentWorkspaceFrame";
import { OptionButtons } from "./agent-ui";
import "./browser-workspace.css";
import "./agent-workspace.css";

type Access = {
  name: string;
  expiresAt: number;
  roots: { name: string; path: string; index: number }[];
  terminals: { id: string; name: string }[];
  screen: "off" | "view" | "scroll" | "ask" | "apps" | boolean;
  // Preset sessions (server/agent-presets.mjs): what this one may do.
  preset?: "full" | "apps" | "files" | "readonly";
  presetName?: string;
  control?: boolean;
  open?: boolean;
  shell?: boolean;
  write?: boolean;
  apps?: { id: string; name?: string; bundleId?: string }[];
  hidden?: { id: string; name?: string }[];
  screenNotice?: string;
  appAccess?: { id: string; mode: "view" | "control" }[];
  commandRequests?: boolean;
  restrictedTerminal?: boolean;
  terminalApproval?: boolean;
  scriptApproval?: boolean;
};
type Listing = { items: FileEntry[]; truncated?: boolean };
type WorkspaceTab = "screen" | "files" | "terminal";
const WORKSPACE_TABS = [
  { id: "screen", label: "Screen", icon: Monitor },
  { id: "files", label: "Files", icon: Folder },
  { id: "terminal", label: "Terminal", icon: Terminal },
] as const;
const SCREEN_REFRESH_MS = 2000;

// Ordinary controls keep the shared resources usable by an assistant's browser.
// Tabs only organize the UI; the host still authorizes every resource and action.
type BrowserWorkspaceProps = { peer: Peer; onEnd: () => void };
export default function BrowserWorkspace(props: BrowserWorkspaceProps) {
  const { peer } = props;
  // Credentials and transport define one workspace. Remount before rendering a
  // different identity so its scope and screenshot never inherit the old grant.
  const identity = JSON.stringify([
    peer.id,
    peer.url,
    peer.token,
    peer.transport,
    peer.sessionId,
  ]);
  return <BrowserWorkspaceSession key={identity} {...props} />;
}

function BrowserWorkspaceSession({ peer, onEnd }: BrowserWorkspaceProps) {
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState("");
  const [selectedSection, setSection] = useState<AgentSection | null>(null);
  const [selectedTab, setSelectedTab] = useState<WorkspaceTab | null>(null);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [root, setRoot] = useState(0);
  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing>({ items: [] });
  const [filesBusy, setFilesBusy] = useState(false);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [downloading, setDownloading] = useState("");
  const downloadOperation = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      downloadOperation.current?.abort();
    },
    [peer.url, peer.token],
  );
  const [terminal, setTerminal] = useState("");
  const [output, setOutput] = useState("");
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [screenUrl, setScreenUrl] = useState("");
  const [screenAt, setScreenAt] = useState<Date | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenDraft, setScreenDraft] = useState(false);
  const screenDraftRef = useRef(false);
  const [filesRevision, setFilesRevision] = useState(0);
  const [terminalRevision, setTerminalRevision] = useState(0);
  const screenObject = useRef("");
  const screenOperation = useRef<AbortController | null>(null);
  const fileSequence = useRef(0);
  const fileOperation = useRef<AbortController | null>(null);
  const filesLocation = useRef("");
  const terminalLocation = useRef("");
  const mounted = useRef(true);
  const ended = useRef(onEnd);
  ended.current = onEnd;
  const fail = useCallback((e: unknown) => {
    if (!mounted.current) return;
    if ((e as { status?: number })?.status === 401) ended.current();
    else if ((e as Error).name !== "AbortError") setError((e as Error).message);
  }, []);
  useLayoutEffect(() => {
    const session = installBrowserTools(peer, fail);
    return () => session.dispose();
  }, [peer.id, peer.url, peer.token, peer.transport, peer.sessionId, fail]);
  const holdScreenDraft = useCallback((held: boolean) => {
    screenDraftRef.current = held;
    if (held) screenOperation.current?.abort();
    setScreenDraft(held);
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    const visibilityChanged = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      fileOperation.current?.abort();
      screenOperation.current?.abort();
      if (screenObject.current) URL.revokeObjectURL(screenObject.current);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await request<Access>(peer, "/api/browser", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setAccess(value);
      } catch (e) {
        if (!controller.signal.aborted) fail(e);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [peer.url, peer.token, fail]);

  const hasFiles = !!access?.roots.length;
  const hasScreen =
    !!access && access.screen !== "off" && access.screen !== false;
  const hasTerminal =
    !!access?.terminals.length ||
    !!access?.commandRequests ||
    !!access?.restrictedTerminal ||
    !!access?.shell;
  const availableTabs = {
    screen: hasScreen,
    files: hasFiles,
    terminal: hasTerminal,
  };
  const activeTab =
    selectedTab && availableTabs[selectedTab]
      ? selectedTab
      : hasScreen
        ? "screen"
        : hasFiles
          ? "files"
          : "terminal";
  const section: AgentSection =
    selectedSection &&
    (selectedSection === "access" ||
      (selectedSection === "screen" && hasScreen) ||
      (selectedSection === "files" && hasFiles) ||
      (selectedSection === "commands" && hasTerminal))
      ? selectedSection
      : hasScreen
        ? "screen"
        : hasFiles
          ? "files"
          : hasTerminal
            ? "commands"
            : "access";
  const screenActive =
    hasScreen &&
    access?.preset === undefined &&
    access?.screen !== "apps" &&
    activeTab === "screen" &&
    section === "screen" &&
    visible &&
    !screenDraft;
  const screenActiveRef = useRef(screenActive);
  screenActiveRef.current = screenActive;
  const currentRoot = access?.roots.some((item) => item.index === root)
    ? root
    : (access?.roots[0]?.index ?? 0);
  const currentTerminal = access?.terminals.some((item) => item.id === terminal)
    ? terminal
    : (access?.terminals[0]?.id ?? "");

  useEffect(() => {
    if (
      access?.preset !== undefined ||
      !hasFiles ||
      activeTab !== "files" ||
      section !== "files"
    )
      return;
    const controller = new AbortController();
    const location = JSON.stringify([peer.url, currentRoot, dir, search]);
    if (filesLocation.current !== location) {
      filesLocation.current = location;
      setListing({ items: [] });
      setFile(null);
    }
    setFilesBusy(true);
    setError("");
    const params = new URLSearchParams({
      root: String(currentRoot),
      ...(search ? { q: search } : { path: dir }),
    });
    request<Listing>(
      peer,
      `${search ? "/api/browser/files/search" : "/api/files"}?${params}`,
      { signal: controller.signal },
    )
      .then((value) => !controller.signal.aborted && setListing(value))
      .catch((e) => !controller.signal.aborted && fail(e))
      .finally(() => !controller.signal.aborted && setFilesBusy(false));
    return () => {
      controller.abort();
      fileOperation.current?.abort();
      fileSequence.current++;
      if (mounted.current) setFileBusy(false);
    };
  }, [
    peer.url,
    peer.token,
    access?.preset,
    hasFiles,
    activeTab,
    section,
    currentRoot,
    dir,
    search,
    filesRevision,
    fail,
  ]);

  useEffect(() => {
    if (
      access?.preset !== undefined ||
      activeTab !== "terminal" ||
      section !== "commands" ||
      !currentTerminal
    )
      return;
    const controller = new AbortController();
    if (terminalLocation.current !== currentTerminal) {
      terminalLocation.current = currentTerminal;
      setOutput("");
    }
    setTerminalBusy(true);
    setError("");
    request<{ output: string }>(
      peer,
      `/api/browser/terminals/${encodeURIComponent(currentTerminal)}`,
      { signal: controller.signal },
    )
      .then((value) => !controller.signal.aborted && setOutput(value.output))
      .catch((e) => !controller.signal.aborted && fail(e))
      .finally(() => !controller.signal.aborted && setTerminalBusy(false));
    return () => controller.abort();
  }, [
    peer.url,
    peer.token,
    access?.preset,
    activeTab,
    section,
    currentTerminal,
    terminalRevision,
    fail,
  ]);

  const read = async (entry: FileEntry) => {
    if (entry.type === "directory") {
      setDir(entry.path);
      setQuery("");
      setSearch("");
      return;
    }
    fileOperation.current?.abort();
    const controller = new AbortController();
    fileOperation.current = controller;
    const sequence = ++fileSequence.current;
    setError("");
    setFile(null);
    setFileBusy(true);
    try {
      const value = await request<{ text: string }>(
        peer,
        `/api/files/text?${new URLSearchParams({ root: String(currentRoot), path: entry.path })}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && sequence === fileSequence.current)
        setFile({ path: entry.path, text: value.text });
    } catch (e) {
      if (!controller.signal.aborted && sequence === fileSequence.current)
        fail(e);
    } finally {
      if (!controller.signal.aborted && sequence === fileSequence.current)
        setFileBusy(false);
      if (fileOperation.current === controller) fileOperation.current = null;
    }
  };

  const download = async (entry: FileEntry) => {
    if (downloadOperation.current) return;
    const controller = new AbortController();
    downloadOperation.current = controller;
    setDownloading(entry.path);
    setError("");
    try {
      const blob = await fileBlob(peer, entry.path, currentRoot, {
        signal: controller.signal,
        maxBytes: 256 * 1024 * 1024,
      });
      if (!controller.signal.aborted) await saveBlob(blob, entry.name);
    } catch (e) {
      if (!controller.signal.aborted) fail(e);
    } finally {
      if (downloadOperation.current === controller) {
        downloadOperation.current = null;
        if (mounted.current) setDownloading("");
      }
    }
  };

  const updateScreen = useCallback(
    async (direction?: "up" | "down") => {
      // A ref, rather than render state, closes the gap between a manual refresh
      // and the automatic timer. There is at most one capture in flight.
      if (
        screenOperation.current ||
        !screenActiveRef.current ||
        screenDraftRef.current
      )
        return;
      const controller = new AbortController();
      screenOperation.current = controller;
      const timeout = setTimeout(() => controller.abort(), 35000);
      setScreenBusy(true);
      try {
        if (direction) {
          await request(peer, "/api/browser/scroll", {
            method: "POST",
            body: JSON.stringify({ direction, amount: 3 }),
            signal: controller.signal,
          });
        }
        if (
          controller.signal.aborted ||
          !screenActiveRef.current ||
          screenDraftRef.current
        )
          return;
        const response = await peerFetch(peer, "/api/browser/screen", {
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw Object.assign(
            Error(body.error || "The screen could not be read."),
            {
              status: response.status,
            },
          );
        }
        const blob = await response.blob();
        if (
          controller.signal.aborted ||
          !screenActiveRef.current ||
          screenDraftRef.current ||
          !mounted.current
        )
          return;
        const image = URL.createObjectURL(blob);
        if (screenObject.current) URL.revokeObjectURL(screenObject.current);
        screenObject.current = image;
        setScreenUrl(image);
        setScreenAt(new Date());
        setError("");
      } catch (e) {
        if (!controller.signal.aborted && mounted.current) fail(e);
      } finally {
        clearTimeout(timeout);
        if (screenOperation.current === controller)
          screenOperation.current = null;
        if (mounted.current) setScreenBusy(false);
      }
    },
    [peer.url, peer.token, fail],
  );

  useEffect(() => {
    if (!screenActive) {
      screenOperation.current?.abort();
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      await updateScreen();
      if (live) timer = setTimeout(() => void refresh(), SCREEN_REFRESH_MS);
    };
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
      screenOperation.current?.abort();
    };
  }, [screenActive, updateScreen]);

  const selectTab = (tab: WorkspaceTab) => {
    setSelectedTab(tab);
    setSection(tab === "terminal" ? "commands" : tab);
    setError("");
  };
  if (!access)
    return (
      <main className="browser-workspace ag-ws browser-workspace-loading">
        <p role="status" className="ag-ws-loading">
          Opening your shared workspace…
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
    );

  // Preset and older invitations share navigation. Their controls continue
  // to use the exact permission and approval paths of their original grants.
  if (access.preset !== undefined)
    return (
      <AgentPage peer={peer} access={access as PresetAccess} onEnd={onEnd} />
    );
  const endsAt = new Date(access.expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const crumbs = dir ? dir.split("/").filter(Boolean) : [];
  const rootName =
    access.roots.find((item) => item.index === currentRoot)?.name ||
    "Shared folder";
  // Plain sentences an agent can read before acting: what it may do, and where.
  const abilities = [
    hasScreen && {
      tab: "screen" as const,
      icon: <AppWindow size={18} />,
      title: access.preset ? "Screen" : "Apps",
      text: access.preset
        ? access.control
          ? access.preset === "apps"
            ? "See and use only the apps the owner chose. Click the picture to click there; type and press keys below. Password fields and Reach stay closed."
            : "The Mac as the owner uses it. Click the picture to click there; type, press keys and open apps below. Passwords, security prompts and Reach stay closed."
          : "Look at the screen. Nothing here clicks or types."
        : access.screen === "apps"
          ? "View the app windows the owner shared. To see another app, choose it in Screen and ask."
          : access.screen === "scroll"
            ? "View and scroll the shared screen."
            : access.screen === "ask"
              ? "View the screen; every click or key needs the owner’s approval."
              : "View the shared screen.",
    },
    hasFiles && {
      tab: "files" as const,
      icon: <Folder size={18} />,
      title: "Files",
      text: `${access.write ? "Read, search, download and change files" : "Read, search and download"} in ${access.roots.map((item) => item.name).join(", ")}.${access.write ? " Changes land in the owner's real folders at once." : ""}`,
    },
    !!access.shell && {
      tab: "terminal" as const,
      icon: <Terminal size={18} />,
      title: "Commands",
      text: "Run shell commands as the owner, from inside the shared folders. Commands that need the owner's password, erase the Mac, read secrets or touch Reach are refused. Everything is logged.",
    },
    !!access.terminals.length && {
      tab: "terminal" as const,
      icon: <Terminal size={18} />,
      title: "Terminal output",
      text: `Read ${access.terminals.map((item) => item.name).join(", ")}. Output only.`,
    },
    (access.restrictedTerminal || access.commandRequests) && {
      tab: "terminal" as const,
      icon: <ShieldCheck size={18} />,
      title: "Commands",
      text: access.restrictedTerminal
        ? access.scriptApproval || access.terminalApproval
          ? "Read commands run at once inside the shared folders. File changes and scripts wait for the owner’s approval."
          : "Read-only commands (pwd, ls, cat, grep…) run inside the shared folders."
        : "Ask the owner to run a command for you. Nothing runs from this page.",
    },
  ].filter(Boolean) as {
    tab: WorkspaceTab;
    icon: ReactNode;
    title: string;
    text: string;
  }[];

  const destinations: AgentDestination[] = [
    {
      id: "tools",
      label: "Tools",
      detail: "Named tasks need a laptop-control invitation.",
      available: false,
    },
    {
      id: "screen",
      label: "Screen",
      detail:
        abilities.find((item) => item.tab === "screen")?.text || "Not shared.",
      available: hasScreen,
    },
    {
      id: "apps",
      label: "Apps",
      detail: "App windows are available through Screen.",
      available: false,
    },
    {
      id: "files",
      label: "Files",
      detail:
        abilities.find((item) => item.tab === "files")?.text || "Not shared.",
      available: hasFiles,
      count: access.roots.length,
    },
    {
      id: "commands",
      label: "Commands",
      detail:
        abilities.find((item) => item.tab === "terminal")?.text ||
        "Not shared.",
      available: hasTerminal,
    },
    {
      id: "access",
      label: "Access",
      detail: "Inspect what is shared and what needs approval.",
      available: true,
    },
  ];
  const activeSection = destinations.some(
    (item) => item.id === section && item.available,
  )
    ? section
    : destinations.find((item) => item.available)?.id || "access";
  const navigate = (next: AgentSection) => {
    if (!destinations.some((item) => item.id === next && item.available))
      return;
    if (next === "screen" || next === "files" || next === "commands")
      selectTab(next === "commands" ? "terminal" : next);
    else setSection(next);
  };
  return (
    <AgentWorkspaceFrame
      name={peer.name}
      accessName="Shared resources"
      expiry={access.expiresAt}
      now={Date.now()}
      destinations={destinations}
      section={activeSection}
      navigate={navigate}
      reload={() => window.location.reload()}
    >
      <section id="agent-section-access" hidden={activeSection !== "access"}>
        <div className="aw-page-heading">
          <p className="aw-eyebrow">YOUR INVITATION</p>
          <h1>Access to {peer.name}</h1>
          <p>Only the resources below are available to this session.</p>
        </div>
        <details className="ag-ws-access" open>
          <summary>
            <strong>What you can do here</strong>
            <ChevronDown size={16} />
          </summary>
          <ul>
            {abilities.map((item) => (
              <li key={item.title}>
                <span className="ag-ws-access-icon">{item.icon}</span>
                <span className="ag-ws-access-text">
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </span>
                {activeTab === item.tab ? (
                  <span className="ag-ws-here">Open below</span>
                ) : (
                  <button
                    type="button"
                    className="ag-secondary ag-small"
                    onClick={() => selectTab(item.tab)}
                  >
                    Go to{" "}
                    {WORKSPACE_TABS.find((tab) => tab.id === item.tab)!.label}
                  </button>
                )}
              </li>
            ))}
            {!abilities.length && (
              <li>
                <span className="ag-ws-access-text">
                  <span>Nothing is shared with this session yet.</span>
                </span>
              </li>
            )}
          </ul>
          <p className="ag-ws-rules">
            <Lock size={13} /> Only what is listed here is available. You can’t
            invite anyone, share this link, or reach other folders or apps.
            Access ends at {endsAt}.
          </p>
        </details>
      </section>
      <div
        className="browser-workspace ag-ws aw-legacy"
        hidden={activeSection === "access"}
      >
        {error && (
          <p className="browser-workspace-error error" role="alert">
            {error}
          </p>
        )}
        {access.screenNotice && (
          <p className="browser-workspace-error" role="status">
            {access.screenNotice}
          </p>
        )}
        <div
          className={`browser-tab-panel ag-ws-panel browser-tab-panel-${activeTab}`}
          role="region"
          id={`agent-section-${activeSection}`}
          aria-label={`${activeSection} workspace`}
          tabIndex={0}
        >
          {access.screen === "apps" &&
            activeTab === "screen" &&
            activeSection === "screen" &&
            visible && (
              <BrowserAppScreen
                peer={peer}
                expiresAt={access.expiresAt}
                onError={fail}
              />
            )}
          {hasScreen && access.screen !== "apps" && (
            <section
              className="browser-screen"
              aria-labelledby="browser-screen-title"
              hidden={activeTab !== "screen"}
            >
              <div className="browser-section-heading ag-ws-section-head">
                <div>
                  <h2 id="browser-screen-title">Screen</h2>
                  <p className="browser-policy">
                    {access.screen === "scroll"
                      ? "View and scroll"
                      : access.screen === "ask"
                        ? "Input with owner approval"
                        : "View only"}
                  </p>
                </div>
                <div className="browser-screen-toolbar">
                  <span className="browser-screen-status" aria-live="off">
                    {screenAt
                      ? `Updated ${screenAt.toLocaleTimeString()}`
                      : screenBusy
                        ? "Connecting to screen…"
                        : "Waiting for screen"}
                  </span>
                  <button
                    className="ag-secondary ag-small"
                    disabled={screenBusy || !visible || screenDraft}
                    aria-label="Refresh screen"
                    onClick={() => void updateScreen()}
                  >
                    <RefreshCw size={15} /> Refresh
                  </button>
                </div>
              </div>
              <BrowserScreenControls
                peer={peer}
                src={screenUrl}
                alt={`Shared screen of ${peer.name}`}
                enabled={access.screen === "ask"}
                onError={fail}
                onDraftChange={holdScreenDraft}
              />
              {!screenUrl && (
                <div className="browser-screen-placeholder" role="status">
                  <Monitor size={32} />
                  <span>
                    {screenBusy
                      ? "Opening the shared screen…"
                      : "Waiting for a screen image…"}
                  </span>
                </div>
              )}
              <div className="browser-screen-footer">
                <p className="browser-policy">
                  {screenDraft
                    ? "Screen held while your actions await approval."
                    : "Updates automatically while this tab is open."}
                </p>
                {access.screen === "scroll" && (
                  <div className="browser-screen-actions">
                    <button
                      className="ag-secondary ag-small"
                      disabled={screenBusy || !screenUrl || !visible}
                      onClick={() => void updateScreen("up")}
                    >
                      <ArrowUp size={16} /> Scroll up
                    </button>
                    <button
                      className="ag-secondary ag-small"
                      disabled={screenBusy || !screenUrl || !visible}
                      onClick={() => void updateScreen("down")}
                    >
                      <ArrowDown size={16} /> Scroll down
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}
          {activeTab === "files" && hasFiles && (
            <section
              className="browser-files ag-ws-files"
              aria-labelledby="browser-files-title"
            >
              <div className="browser-section-heading ag-ws-section-head">
                <div>
                  <h2 id="browser-files-title">Files</h2>
                  <p className="browser-policy">
                    {access.write
                      ? "Read, download and change files in the shared folders. Changes are immediate."
                      : "Read or download files from shared folders. Nothing can be changed from here."}
                  </p>
                </div>
                <button
                  className="ag-secondary ag-small"
                  aria-label="Refresh files"
                  disabled={filesBusy}
                  onClick={() => setFilesRevision((r) => r + 1)}
                >
                  <RefreshCw size={15} /> Refresh
                </button>
              </div>
              {access.roots.length > 1 && (
                <OptionButtons
                  label="Shared folder"
                  value={currentRoot}
                  onChange={(index) => {
                    setRoot(index);
                    setDir("");
                    setQuery("");
                    setSearch("");
                  }}
                  options={access.roots.map((folder) => ({
                    value: folder.index,
                    label: folder.name,
                    icon: <Folder size={17} />,
                    title: folder.path,
                  }))}
                />
              )}
              <form
                className="browser-search ag-ws-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSearch(query.trim());
                  setFilesRevision((r) => r + 1);
                }}
              >
                <label className="ag-search">
                  <Search size={16} aria-hidden="true" />
                  <input
                    aria-label="Find a file"
                    placeholder={`Find a file in ${rootName}…`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <button className="ag-primary ag-small" type="submit">
                  Find
                </button>
              </form>
              <nav className="ag-ws-crumbs" aria-label="Folder path">
                {search ? (
                  <span>
                    Results for “{search}” in {rootName}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setDir("")}
                      aria-current={!dir ? "location" : undefined}
                    >
                      {rootName}
                    </button>
                    {crumbs.map((part, index) => (
                      <span key={index} className="ag-ws-crumb">
                        <ChevronRight size={14} aria-hidden="true" />
                        <button
                          type="button"
                          aria-current={
                            index === crumbs.length - 1 ? "location" : undefined
                          }
                          onClick={() =>
                            setDir(crumbs.slice(0, index + 1).join("/"))
                          }
                        >
                          {part}
                        </button>
                      </span>
                    ))}
                  </>
                )}
                {(dir || search) && (
                  <button
                    className="ag-secondary ag-small ag-ws-up"
                    onClick={() => {
                      setSearch("");
                      setQuery("");
                      setDir(
                        search ? "" : dir.split("/").slice(0, -1).join("/"),
                      );
                    }}
                  >
                    <ChevronLeft size={15} />{" "}
                    {search ? "Browse folder" : "Up one folder"}
                  </button>
                )}
              </nav>
              <div
                className={`browser-file-layout ag-ws-file-layout${file || fileBusy ? " has-preview" : ""}`}
              >
                <div className="browser-file-directory">
                  {filesBusy ? (
                    <p className="browser-empty" role="status">
                      Loading files…
                    </p>
                  ) : listing.items.length ? (
                    <ul className="browser-file-list ag-ws-file-list">
                      {listing.items.map((entry) => (
                        <li key={entry.path}>
                          <button
                            onClick={() => void read(entry)}
                            aria-label={`${entry.type === "directory" ? "Open folder" : "Read file"} ${entry.path}`}
                            aria-current={
                              file?.path === entry.path ? true : undefined
                            }
                          >
                            {entry.type === "directory" ? (
                              <Folder size={18} />
                            ) : (
                              <FileText size={18} />
                            )}
                            <span>
                              <strong>{entry.name}</strong>
                              {search && <small>{entry.path}</small>}
                            </span>
                            <em className="ag-ws-verb" aria-hidden="true">
                              {entry.type === "directory" ? "Open" : "Read"}
                            </em>
                          </button>
                          {entry.type === "file" && (
                            <button
                              className="browser-file-download"
                              aria-label={`Download file ${entry.path}`}
                              disabled={!!downloading}
                              onClick={() => void download(entry)}
                            >
                              <Download size={16} />{" "}
                              {downloading === entry.path
                                ? "Downloading…"
                                : "Download"}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="browser-empty">
                      {search
                        ? "No files match that name."
                        : "This folder is empty."}
                    </p>
                  )}
                  {listing.truncated && (
                    <p className="browser-policy">
                      More files are available. Narrow your search or open a
                      folder.
                    </p>
                  )}
                </div>
                {fileBusy && (
                  <p className="browser-empty" role="status">
                    Reading file…
                  </p>
                )}
                {file && (
                  <article
                    className="browser-file-content"
                    aria-label={`Contents of ${file.path}`}
                  >
                    <h3>
                      <FileText size={15} /> {file.path}
                    </h3>
                    <pre>{file.text}</pre>
                  </article>
                )}
              </div>
            </section>
          )}
          {activeTab === "terminal" && hasTerminal && (
            <section
              className="browser-terminal"
              aria-labelledby="browser-terminals-title"
            >
              <div className="browser-section-heading ag-ws-section-head">
                <div>
                  <h2 id="browser-terminals-title">Terminal</h2>
                  <p className="browser-policy">
                    {access.restrictedTerminal
                      ? "Run commands inside the shared folders. Every command is logged."
                      : access.terminals.length
                        ? "Read shared terminal output"
                        : "Request a command from the owner"}
                  </p>
                </div>
                {!!access.terminals.length && (
                  <button
                    className="ag-secondary ag-small"
                    aria-label="Refresh terminal output"
                    disabled={!currentTerminal || terminalBusy}
                    onClick={() => setTerminalRevision((r) => r + 1)}
                  >
                    <RefreshCw size={15} /> Refresh
                  </button>
                )}
              </div>
              {!!access.terminals.length && (
                <div className="ag-ws-output">
                  <p className="ag-label">Shared terminal output</p>
                  <OptionButtons
                    label="Shared terminal"
                    value={currentTerminal}
                    onChange={setTerminal}
                    options={access.terminals.map((item) => ({
                      value: item.id,
                      label: item.name,
                      icon: <Terminal size={16} />,
                    }))}
                  />
                  <pre
                    className="browser-output"
                    aria-label="Terminal transcript"
                  >
                    {terminalBusy && !output
                      ? "Reading terminal…"
                      : output || "No output yet."}
                  </pre>
                  <p className="browser-policy">
                    These existing sessions are output only.
                  </p>
                </div>
              )}
            </section>
          )}
          {!hasScreen && !hasFiles && !hasTerminal && (
            <p className="browser-empty">
              No resources are shared with this session.
            </p>
          )}
          {access.restrictedTerminal && (
            <div
              className="browser-tab-requests"
              hidden={activeTab !== "terminal"}
            >
              <p className="ag-label">Run a command</p>
              <BrowserTerminal
                peer={peer}
                roots={access.roots}
                terminalApproval={access.terminalApproval}
                scriptApproval={access.scriptApproval}
                onError={fail}
              />
            </div>
          )}
          {access.commandRequests && !access.restrictedTerminal && (
            <div
              className="browser-tab-requests"
              hidden={activeTab !== "terminal"}
            >
              <BrowserActionRequests
                peer={peer}
                screen={false}
                commands={
                  !!access.commandRequests || !!access.restrictedTerminal
                }
                restrictedTerminal={!!access.restrictedTerminal}
                roots={access.roots}
                activeKind="command"
                onError={fail}
              />
            </div>
          )}
        </div>
      </div>
    </AgentWorkspaceFrame>
  );
}
