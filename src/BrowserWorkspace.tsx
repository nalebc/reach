import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
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
import "./browser-workspace.css";

type Access = {
  name: string;
  expiresAt: number;
  roots: { name: string; path: string; index: number }[];
  terminals: { id: string; name: string }[];
  screen: "off" | "view" | "scroll" | "ask";
  commandRequests?: boolean;
  restrictedTerminal?: boolean;
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
export default function BrowserWorkspace({
  peer,
  onEnd,
}: {
  peer: Peer;
  onEnd: () => void;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState("");
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
  useEffect(() => () => { downloadOperation.current?.abort(); }, [peer.url, peer.token]);
  const [terminal, setTerminal] = useState("");
  const [output, setOutput] = useState("");
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [screenUrl, setScreenUrl] = useState("");
  const [screenAt, setScreenAt] = useState<Date | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
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
  const tabButtons = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement | null>>>({});
  ended.current = onEnd;
  const fail = useCallback((e: unknown) => {
    if ((e as { status?: number })?.status === 401) ended.current();
    else if ((e as Error).name !== "AbortError") setError((e as Error).message);
  }, []);

  useEffect(() => {
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
  const hasScreen = !!access && access.screen !== "off";
  const hasTerminal = !!access?.terminals.length || !!access?.commandRequests || !!access?.restrictedTerminal;
  const availableTabs = { screen: hasScreen, files: hasFiles, terminal: hasTerminal };
  const activeTab = selectedTab && availableTabs[selectedTab]
    ? selectedTab
    : hasScreen ? "screen" : hasFiles ? "files" : "terminal";
  const screenActive = hasScreen && activeTab === "screen" && visible;
  const screenActiveRef = useRef(screenActive);
  screenActiveRef.current = screenActive;
  const currentRoot = access?.roots.some((item) => item.index === root)
    ? root : access?.roots[0]?.index ?? 0;
  const currentTerminal = access?.terminals.some((item) => item.id === terminal)
    ? terminal : access?.terminals[0]?.id ?? "";

  useEffect(() => {
    if (!hasFiles || activeTab !== "files") return;
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
  }, [peer.url, peer.token, hasFiles, activeTab, currentRoot, dir, search, filesRevision, fail]);

  useEffect(() => {
    if (activeTab !== "terminal" || !currentTerminal) return;
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
  }, [peer.url, peer.token, activeTab, currentTerminal, terminalRevision, fail]);

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
      if (!controller.signal.aborted && sequence === fileSequence.current) fail(e);
    } finally {
      if (!controller.signal.aborted && sequence === fileSequence.current) setFileBusy(false);
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
        signal: controller.signal, maxBytes: 256 * 1024 * 1024,
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

  const updateScreen = useCallback(async (direction?: "up" | "down") => {
    // A ref, rather than render state, closes the gap between a manual refresh
    // and the automatic timer. There is at most one capture in flight.
    if (screenOperation.current || !screenActiveRef.current) return;
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
      if (controller.signal.aborted || !screenActiveRef.current) return;
      const response = await peerFetch(peer, "/api/browser/screen", {
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Object.assign(Error(body.error || "The screen could not be read."), {
          status: response.status,
        });
      }
      const blob = await response.blob();
      if (controller.signal.aborted || !screenActiveRef.current || !mounted.current) return;
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
      if (screenOperation.current === controller) screenOperation.current = null;
      if (mounted.current) setScreenBusy(false);
    }
  }, [peer.url, peer.token, fail]);

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
    setError("");
  };
  const moveTab = (key: string) => {
    const enabled = WORKSPACE_TABS.filter((tab) => availableTabs[tab.id]);
    const current = enabled.findIndex((tab) => tab.id === activeTab);
    const index = key === "Home" ? 0
      : key === "End" ? enabled.length - 1
        : (current + (key === "ArrowLeft" ? -1 : 1) + enabled.length) % enabled.length;
    const next = enabled[index];
    if (next) {
      selectTab(next.id);
      tabButtons.current[next.id]?.focus();
    }
  };

  if (!access)
    return (
      <main className="browser-workspace browser-workspace-loading">
        <p role="status">Opening your shared workspace…</p>
        {error && <p className="error" role="alert">{error}</p>}
      </main>
    );

  return (
    <main className="browser-workspace">
      <header className="browser-header">
        <div className="browser-computer-icon"><Monitor size={21} /></div>
        <div className="browser-computer-name">
          <span className="browser-wordmark">REACH <span>Shared workspace</span></span>
          <h1>{peer.name}</h1>
        </div>
        <div className="browser-session-status">
          <span className="browser-connected">Connected</span>
          <span>Until {new Date(access.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </div>
      </header>
      <div className="browser-tabs" role="tablist" aria-label="Shared workspace">
        {WORKSPACE_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            ref={(element) => { tabButtons.current[id] = element; }}
            type="button"
            role="tab"
            id={`browser-tab-${id}`}
            aria-controls="browser-workspace-panel"
            aria-selected={activeTab === id && availableTabs[id]}
            disabled={!availableTabs[id]}
            title={availableTabs[id] ? undefined : "Not shared by the owner"}
            tabIndex={activeTab === id && availableTabs[id] ? 0 : -1}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                moveTab(event.key);
              }
            }}
          >
            <Icon size={18} /> {label}
          </button>
        ))}
      </div>
      {error && <p className="browser-workspace-error error" role="alert">{error}</p>}
      <div
        className={`browser-tab-panel browser-tab-panel-${activeTab}`}
        role="tabpanel"
        id="browser-workspace-panel"
        aria-labelledby={`browser-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === "screen" && hasScreen && (
          <section className="browser-screen" aria-labelledby="browser-screen-title">
            <div className="browser-section-heading">
              <div>
                <h2 id="browser-screen-title">Screen</h2>
                <p className="browser-policy">
                  {access.screen === "scroll" ? "View and scroll"
                    : access.screen === "ask" ? "Input with owner approval" : "View only"}
                </p>
              </div>
              <div className="browser-screen-toolbar">
                <span className="browser-screen-status" aria-live="off">
                  {screenAt ? `Updated ${screenAt.toLocaleTimeString()}` : screenBusy ? "Connecting to screen…" : "Waiting for screen"}
                </span>
                <button
                  className="button secondary small"
                  disabled={screenBusy || !visible}
                  aria-label="Refresh screen"
                  onClick={() => void updateScreen()}
                >
                  <RefreshCw size={15} /> Refresh
                </button>
              </div>
            </div>
            <div className="browser-screen-stage" aria-busy={screenBusy && !screenUrl}>
              {screenUrl ? (
                <img className="browser-screen-image" src={screenUrl} alt={`Shared screen of ${peer.name}`} />
              ) : (
                <div className="browser-screen-placeholder" role="status">
                  <Monitor size={32} />
                  <span>{screenBusy ? "Opening the shared screen…" : "Waiting for a screen image…"}</span>
                </div>
              )}
            </div>
            <div className="browser-screen-footer">
              <p className="browser-policy">Updates automatically while this tab is open.</p>
              {access.screen === "scroll" && (
                <div className="browser-screen-actions">
                  <button className="button secondary small" disabled={screenBusy || !screenUrl || !visible} onClick={() => void updateScreen("up")}>
                    <ArrowUp size={16} /> Scroll up
                  </button>
                  <button className="button secondary small" disabled={screenBusy || !screenUrl || !visible} onClick={() => void updateScreen("down")}>
                    <ArrowDown size={16} /> Scroll down
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
        {activeTab === "files" && hasFiles && (
          <section className="browser-files" aria-labelledby="browser-files-title">
            <div className="browser-section-heading">
              <div>
                <h2 id="browser-files-title">Files</h2>
                <p className="browser-policy">Read or download files from shared folders</p>
              </div>
              <button className="button secondary small" aria-label="Refresh files" disabled={filesBusy} onClick={() => setFilesRevision((r) => r + 1)}>
                <RefreshCw size={15} /> Refresh
              </button>
            </div>
            <form className="browser-search" onSubmit={(event) => {
              event.preventDefault();
              setSearch(query.trim());
              setFilesRevision((r) => r + 1);
            }}>
              <select aria-label="Shared folder" value={currentRoot} onChange={(event) => {
                setRoot(Number(event.target.value));
                setDir("");
                setQuery("");
                setSearch("");
              }}>
                {access.roots.map((folder) => <option key={folder.index} value={folder.index}>{folder.name}</option>)}
              </select>
              <input aria-label="Find a file" placeholder="Find a file by name…" value={query} onChange={(event) => setQuery(event.target.value)} />
              <button className="button primary" type="submit"><Search size={16} /> Find</button>
            </form>
            <div className="browser-file-location">
              <span>{search ? `Results for “${search}” in the shared folder` : dir || "Shared folder"}</span>
              {(dir || search) && (
                <button className="button secondary small" onClick={() => {
                  setSearch("");
                  setQuery("");
                  setDir(search ? "" : dir.split("/").slice(0, -1).join("/"));
                }}>
                  <ChevronLeft size={15} /> {search ? "Browse folder" : "Up one folder"}
                </button>
              )}
            </div>
            <div className={`browser-file-layout${file || fileBusy ? " has-preview" : ""}`}>
              <div className="browser-file-directory">
                {filesBusy ? <p className="browser-empty" role="status">Loading files…</p> : listing.items.length ? (
                  <ul className="browser-file-list">
                    {listing.items.map((entry) => (
                      <li key={entry.path}>
                        <button onClick={() => void read(entry)} aria-label={`${entry.type === "directory" ? "Open folder" : "Read file"} ${entry.path}`} aria-current={file?.path === entry.path ? true : undefined}>
                          {entry.type === "directory" ? <Folder size={17} /> : <FileText size={17} />}
                          <span><strong>{entry.name}</strong>{search && <small>{entry.path}</small>}</span>
                        </button>
                        {entry.type === "file" && (
                          <button className="browser-file-download" aria-label={`Download file ${entry.path}`} disabled={!!downloading} onClick={() => void download(entry)}>
                            <Download size={16} /> {downloading === entry.path ? "Downloading…" : "Download"}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : <p className="browser-empty">No files found.</p>}
                {listing.truncated && <p className="browser-policy">More files are available. Narrow your search or open a folder.</p>}
              </div>
              {fileBusy && <p className="browser-empty" role="status">Reading file…</p>}
              {file && (
                <article className="browser-file-content" aria-label={`Contents of ${file.path}`}>
                  <h3><FileText size={15} /> {file.path}</h3>
                  <pre>{file.text}</pre>
                </article>
              )}
            </div>
          </section>
        )}
        {activeTab === "terminal" && hasTerminal && (
          <section className="browser-terminal" aria-labelledby="browser-terminals-title">
            <div className="browser-section-heading">
              <div>
                <h2 id="browser-terminals-title">Terminal</h2>
                <p className="browser-policy">{access.restrictedTerminal ? "Run approved read-only commands in shared folders" : access.terminals.length ? "Read shared terminal output" : "Request a command from the owner"}</p>
              </div>
              {!!access.terminals.length && (
                <button className="button secondary small" aria-label="Refresh terminal output" disabled={!currentTerminal || terminalBusy} onClick={() => setTerminalRevision((r) => r + 1)}>
                  <RefreshCw size={15} /> Refresh
                </button>
              )}
            </div>
            {!!access.terminals.length && (
              <>
                <label className="browser-terminal-select">Terminal
                  <select aria-label="Shared terminal" value={currentTerminal} onChange={(event) => setTerminal(event.target.value)}>
                    {access.terminals.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <pre className="browser-output" aria-label="Terminal transcript">{terminalBusy && !output ? "Reading terminal…" : output || "No output yet."}</pre>
                <p className="browser-policy">These existing sessions are output only. Command requests are separate below.</p>
              </>
            )}
          </section>
        )}
        {!hasScreen && !hasFiles && !hasTerminal && (
          <p className="browser-empty">No resources are shared with this session.</p>
        )}
        {(access.screen === "ask" || access.commandRequests || access.restrictedTerminal) && (
          <div className="browser-tab-requests" hidden={activeTab === "files" || (activeTab === "screen" ? access.screen !== "ask" : !(access.commandRequests || access.restrictedTerminal))}>
            <BrowserActionRequests
              peer={peer}
              screen={access.screen === "ask"}
              commands={!!access.commandRequests || !!access.restrictedTerminal}
              restrictedTerminal={!!access.restrictedTerminal}
              roots={access.roots}
              activeKind={activeTab === "terminal" ? "command" : "screen"}
              onError={fail}
            />
          </div>
        )}
      </div>
    </main>
  );
}
