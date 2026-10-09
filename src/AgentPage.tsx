import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  Lock,
  Search,
  Terminal,
} from "lucide-react";
import { fileBlob, peerFetch, request, type FileEntry, type Peer } from "./api";
import { saveBlob } from "./native";
import { OptionButtons } from "./agent-ui";
import AgentScreen from "./AgentScreen";
import AgentShell from "./AgentShell";
import AgentFileChanges from "./AgentFileChanges";
import SavedAgentTools from "./SavedAgentTools";
import ServiceAgentTools from "./ServiceAgentTools";
import AgentWorkspaceFrame, {
  type AgentDestination,
  type AgentSection,
} from "./AgentWorkspaceFrame";
import type { BrowserAccess } from "./browser-tools";
import "./agent-page.css";

// The invitation workspace. Navigation changes visibility, not the lifetime
// of an operation: tool requests and input sequences retain their state.
export type PresetAccess = {
  name: string;
  expiresAt: number;
  roots: { name: string; path: string; index: number }[];
  terminals: { id: string; name: string }[];
  preset: "full" | "apps" | "files" | "readonly";
  presetName?: string;
  screen?: boolean;
  control?: boolean;
  open?: boolean;
  shell?: boolean;
  write?: boolean;
  apps?: { id: string; name?: string; bundleId?: string }[];
  hidden?: { id: string; name?: string }[];
  // Always access: no end time; the same link brings the agent back.
  standing?: boolean;
  browserTools?: BrowserAccess["browserTools"];
  savedTools?: BrowserAccess["savedTools"];
  services?: BrowserAccess["services"];
};
type DesktopApp = {
  id: string;
  name: string;
  bundleId: string;
  running: boolean;
  runsCommands?: boolean;
};
type Listing = { items: FileEntry[]; truncated?: boolean };

type Props = {
  peer: Peer;
  access: PresetAccess;
  onEnd: () => void;
  reload?: () => void;
  // Saved and service tools. Off: they needed Chrome automation settings,
  // failed without them, and agents do the same work on the Screen or in
  // Commands. Kept so they can come back.
  tools?: boolean;
};
export default function AgentPage({
  peer,
  access,
  onEnd,
  reload = () => window.location.reload(),
  tools = false,
}: Props) {
  const connection = useMemo(
    () => peer,
    [peer.id, peer.url, peer.token, peer.transport, peer.sessionId],
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // The screen comes first: the agent uses the Mac as a person would.
  const [section, setSection] = useState<AgentSection>(() =>
    access.screen
      ? "screen"
      : access.roots.length
          ? "files"
          : access.shell || access.terminals.length
            ? "commands"
            : "access",
  );
  const [toolQuery, setToolQuery] = useState("");
  const [activity, setActivity] = useState("");
  const [status, setStatus] = useState<{
    text: string;
    tone: "" | "is-wait" | "is-blocked" | "is-done";
  }>({ text: "", tone: "" });
  const tell = useCallback(
    (text: string, tone: "" | "is-wait" | "is-blocked" | "is-done" = "") =>
      setStatus({ text, tone }),
    [],
  );
  const ended = useCallback(
    (e: unknown) => {
      if ((e as { status?: number })?.status === 401) onEnd();
    },
    [onEnd],
  );
  const hasBrowserTools = !!access.screen && !!access.control && !!access.open;
  const hasTools = tools && (hasBrowserTools || !!access.services);
  const grant = JSON.stringify([
    access.preset,
    access.screen,
    access.control,
    access.open,
    access.shell,
    access.write,
    access.roots.map((root) => [root.index, root.path]),
    access.apps?.map((app) => app.id),
    access.hidden?.map((app) => app.id),
    access.terminals.map((terminal) => terminal.id),
  ]);
  useEffect(() => {
    setActivity("");
    setStatus({ text: "", tone: "" });
  }, [grant]);
  const destinations: AgentDestination[] = ([
    {
      id: "tools",
      label: "Tools",
      detail: "Find and run a named task, or create a reusable tool.",
      available: hasTools,
    },
    {
      id: "screen",
      label: "Screen",
      detail: access.control
        ? "See the live laptop screen. Click, type, and press keys."
        : "Look at the live screen. Input is closed.",
      available: !!access.screen,
    },
    {
      id: "apps",
      label: "Apps",
      detail:
        access.preset === "apps"
          ? "Open the apps selected by the owner."
          : "Find and open an installed app.",
      available: !!access.open,
      count: access.preset === "apps" ? access.apps?.length : undefined,
    },
    {
      id: "files",
      label: "Files",
      detail: access.write
        ? "Read and change files in the shared folders."
        : "Read and download files in the shared folders.",
      available: !!access.roots.length,
      count: access.roots.length,
    },
    {
      id: "commands",
      label: "Commands",
      detail: access.shell
        ? "Run commands as the owner. Changes are immediate."
        : "Read shared terminal output.",
      available: !!access.shell || !!access.terminals.length,
    },
    {
      id: "access",
      label: "Access",
      detail: "Inspect what is shared and when access ends.",
      available: true,
    },
  ] as AgentDestination[]).filter((item) => item.id !== "tools" || tools);
  const active = destinations.some(
    (item) => item.id === section && item.available,
  )
    ? section
    : destinations.find((item) => item.available)?.id || "access";
  const navigate = (next: AgentSection) => {
    if (destinations.some((item) => item.id === next && item.available))
      setSection(next);
  };
  const abilities = [
    access.screen &&
      access.control &&
      (access.preset === "apps"
        ? "see and use only the chosen apps"
        : "see and use the whole screen"),
    access.screen && !access.control && "look at the screen",
    access.open && "open apps",
    access.roots.length > 0 &&
      (access.write ? "read and change files" : "read files"),
    access.shell && "run commands as the owner",
    access.terminals.length > 0 && "read shared terminal output",
  ].filter(Boolean) as string[];
  return (
    <AgentWorkspaceFrame
      name={peer.name}
      accessName={access.presetName || access.preset}
      expiry={access.expiresAt}
      standing={access.standing}
      now={now}
      destinations={destinations}
      section={active}
      navigate={navigate}
      activity={activity}
      reload={reload}
    >
      <div className="agent-page ap-workspace-content">
        {status.text && active !== "screen" && (
          <p
            className={`ap-status ${status.tone}`}
            role="status"
            aria-live="polite"
          >
            {status.text}
          </p>
        )}
        {hasTools && (
          <div id="agent-section-tools" hidden={active !== "tools"}>
            <SavedAgentTools
              key={grant}
              peer={connection}
              ended={ended}
              browserEnabled={hasBrowserTools}
              servicesEnabled={!!access.services}
              query={toolQuery}
              setQuery={setToolQuery}
              onActivity={setActivity}
              onScreen={() => navigate("screen")}
            />
          </div>
        )}
        {access.screen && (
          <div id="agent-section-screen" hidden={active !== "screen"}>
            <AgentScreen
              key={grant}
              peer={connection}
              access={access}
              active={active === "screen"}
              now={now}
              status={status}
              tell={tell}
              ended={ended}
            />
          </div>
        )}
        {access.open && (
          <div id="agent-section-apps" hidden={active !== "apps"}>
            <div className="aw-page-heading">
              <h1>Apps</h1>
              <p>Open an app, then switch to Screen to use it.</p>
            </div>
            <AppsCard
              key={grant}
              peer={connection}
              access={access}
              tell={tell}
              ended={ended}
            />
            <button
              type="button"
              className="ag-secondary aw-open-screen"
              onClick={() => navigate("screen")}
            >
              Go to Screen <ArrowRight size={15} />
            </button>
          </div>
        )}
        {access.roots.length > 0 && (
          <div id="agent-section-files" hidden={active !== "files"}>
            <div className="aw-page-heading">
              <h1>Files</h1>
              <p>
                Browse, search, and read the folders available to this session.
              </p>
            </div>
            <FilesCard
              key={grant}
              peer={connection}
              access={access}
              tell={tell}
              ended={ended}
            />
          </div>
        )}
        {(access.shell || access.terminals.length > 0) && (
          <div id="agent-section-commands" hidden={active !== "commands"}>
            <div className="aw-page-heading">
              <h1>Commands</h1>
              <p>
                {access.shell
                  ? "Commands run on the owner's computer. Review the output after each action."
                  : "Read the terminal output shared with you."}
              </p>
            </div>
            {access.shell && (
              <section className="ap-card" aria-labelledby="ap-commands">
                <h2 id="ap-commands">
                  <Terminal size={16} /> Commands on the Mac
                </h2>
                <AgentShell
                  key={grant}
                  peer={connection}
                  roots={access.roots}
                  onError={(e) => {
                    ended(e);
                    tell((e as Error).message, "is-blocked");
                  }}
                />
              </section>
            )}
            {access.terminals.length > 0 && (
              <TerminalsCard
                key={grant}
                peer={connection}
                access={access}
                ended={ended}
              />
            )}
          </div>
        )}
        <section
          id="agent-section-access"
          hidden={active !== "access"}
          aria-labelledby="aw-access-title"
        >
          <div className="aw-page-heading">
            <h1 id="aw-access-title">Access to {peer.name}</h1>
            <p>
              {access.presetName || access.preset} ·{" "}
              {access.standing
                ? "Until the owner ends it"
                : `Ends ${new Date(access.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            </p>
          </div>
          <p className="ap-abilities">
            You may {abilities.join(", ") || "do nothing yet"}. Everything else
            is closed.
          </p>
          {access.services && active === "access" && <ServiceAgentTools key={grant} peer={connection} accessOnly ended={ended} />}
          <div className="aw-access-list">
            {destinations
              .filter((item) => item.id !== "access")
              .map((item) => (
                <div className="aw-access-row" key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <p>
                      {item.available
                        ? item.detail
                        : "Not shared with this session."}
                    </p>
                  </div>
                  <span
                    className={`aw-badge ${item.available ? "" : "is-closed"}`}
                  >
                    {item.available ? "Available" : "Closed"}
                  </span>
                </div>
              ))}
          </div>
          {!!access.apps?.length && (
            <p className="ap-quiet">
              Chosen apps:{" "}
              {access.apps
                .map((app) => app.name || app.bundleId || app.id)
                .join(", ")}
            </p>
          )}
          {!!access.roots.length && (
            <p className="ap-quiet">
              Shared folders: {access.roots.map((root) => root.name).join(", ")}
            </p>
          )}
          <footer className="ap-foot">
            <Lock size={13} /> You can't invite anyone or manage other agents.{" "}
            {access.shell
              ? "Commands run as the owner and are not confined to shared folders."
              : "Only the shared apps and folders are available."}
          </footer>
        </section>
      </div>
    </AgentWorkspaceFrame>
  );
}

function AppsCard({
  peer,
  access,
  tell,
  ended,
}: {
  peer: Peer;
  access: PresetAccess;
  tell: (
    text: string,
    tone?: "" | "is-wait" | "is-blocked" | "is-done",
  ) => void;
  ended: (e: unknown) => void;
}) {
  const [apps, setApps] = useState<DesktopApp[] | null>(null);
  const [pollError, setPollError] = useState("");
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();
  const matchingApps =
    apps?.filter((app) =>
      `${app.name} ${app.bundleId} ${app.id}`.toLowerCase().includes(search),
    ) || [];
  const shownApps = matchingApps.slice(0, 80);
  const busy = useRef(false);
  const load = useCallback(
    () =>
      request<{ apps: DesktopApp[] }>(peer, "/api/browser/desktop/apps")
        .then((value) => {
          setApps(value.apps);
          setPollError("");
        })
        .catch((e) => {
          ended(e);
          setPollError((e as Error).message);
        }),
    [peer, ended],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  const open = async (id: string) => {
    if (busy.current) return;
    const app = apps?.find((item) => item.id === id);
    busy.current = true;
    tell(`Opening ${app?.name || "the app"}…`);
    try {
      const response = await peerFetch(peer, "/api/browser/desktop/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: id }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok)
        throw Object.assign(
          Error(value.error || "The app couldn't be opened."),
          { status: response.status, body: value },
        );
      tell(
        `Open request completed for ${value.app || app?.name || "the app"}. Check the screen to verify it is in front.`,
        "is-done",
      );
      setTimeout(() => void load(), 1500);
    } catch (e) {
      ended(e);
      const kind = (e as { body?: { kind?: string; holder?: string } }).body
        ?.kind;
      tell(
        kind === "busy"
          ? `Not done: ${(e as { body?: { holder?: string } }).body?.holder || "another agent"} is using the Mac. Try again in a moment.`
          : `Not done: ${(e as Error).message}`,
        kind === "busy" || kind === "paused" ? "is-wait" : "is-blocked",
      );
    } finally {
      busy.current = false;
    }
  };
  return (
    <section className="ap-card" aria-labelledby="ap-apps-title">
      <div className="ap-card-head">
        <h2 id="ap-apps-title">
          <AppWindow size={16} /> Open an app on the Mac
        </h2>
        <p className="ap-live">
          {access.preset === "apps"
            ? "Only these apps."
            : "Password apps and Reach are never listed."}
        </p>
      </div>
      {pollError && (
        <p className="ap-status is-blocked" role="alert">
          {pollError}
        </p>
      )}
      {apps === null ? (
        <p className="ap-quiet">Loading apps…</p>
      ) : apps.length ? (
        <>
          <label className="ap-row ap-type">
            <span className="ap-row-label">
              <Search size={15} /> Find an app
            </span>
            <input
              aria-label="Search apps"
              type="search"
              placeholder="App name, bundle ID or path"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p className="ap-quiet" role="status" aria-live="polite">
            {matchingApps.length > shownApps.length
              ? `Showing ${shownApps.length} of ${matchingApps.length} ${search ? "matching " : ""}apps. Narrow your search to see the rest.`
              : search
                ? matchingApps.length
                  ? `${matchingApps.length} ${matchingApps.length === 1 ? "app matches" : "apps match"} your search (${apps.length} available).`
                  : `No apps match your search (${apps.length} available).`
                : `${apps.length} apps available.`}
          </p>
          {matchingApps.length > 0 && (
            <OptionButtons
              label="Apps you may use"
              value=""
              onChange={(id) => void open(String(id))}
              options={shownApps.map((app) => ({
                value: app.id,
                label: app.name,
                detail: app.running
                  ? "Running · click to bring it in front"
                  : "Not running · click to open",
                title: app.id,
              }))}
            />
          )}
        </>
      ) : (
        <p className="ap-quiet">No apps to open.</p>
      )}
    </section>
  );
}

function FilesCard({
  peer,
  access,
  tell,
  ended,
}: {
  peer: Peer;
  access: PresetAccess;
  tell: (
    text: string,
    tone?: "" | "is-wait" | "is-blocked" | "is-done",
  ) => void;
  ended: (e: unknown) => void;
}) {
  const [root, setRoot] = useState(access.roots[0]?.index ?? 0);
  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing>({ items: [] });
  const [listBusy, setListBusy] = useState(false);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [downloading, setDownloading] = useState("");
  const currentRoot = access.roots.some((item) => item.index === root)
    ? root
    : (access.roots[0]?.index ?? 0);
  const rootName =
    access.roots.find((item) => item.index === currentRoot)?.name ||
    "Shared folder";
  useEffect(() => {
    const controller = new AbortController();
    setListBusy(true);
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
      .catch((e) => {
        if (!controller.signal.aborted) {
          ended(e);
          tell(`Not done: ${(e as Error).message}`, "is-blocked");
        }
      })
      .finally(() => !controller.signal.aborted && setListBusy(false));
    return () => controller.abort();
  }, [peer, currentRoot, dir, search, revision, ended, tell]);
  const read = async (entry: FileEntry) => {
    if (entry.type === "directory") {
      setDir(entry.path);
      setQuery("");
      setSearch("");
      setFile(null);
      return;
    }
    try {
      const value = await request<{ text: string }>(
        peer,
        `/api/files/text?${new URLSearchParams({ root: String(currentRoot), path: entry.path })}`,
      );
      setFile({ path: entry.path, text: value.text });
      tell(`Done: read ${entry.path}.`, "is-done");
    } catch (e) {
      ended(e);
      tell(`Not done: ${(e as Error).message}`, "is-blocked");
    }
  };
  const download = async (entry: FileEntry) => {
    if (downloading) return;
    setDownloading(entry.path);
    try {
      const blob = await fileBlob(peer, entry.path, currentRoot, {
        maxBytes: 256 * 1024 * 1024,
      });
      await saveBlob(blob, entry.name);
    } catch (e) {
      ended(e);
      tell(`Not done: ${(e as Error).message}`, "is-blocked");
    } finally {
      setDownloading("");
    }
  };
  const crumbs = dir ? dir.split("/").filter(Boolean) : [];
  return (
    <section className="ap-card" aria-labelledby="ap-files-title">
      <div className="ap-card-head">
        <h2 id="ap-files-title">
          <Folder size={16} /> Files on the Mac
        </h2>
        <p className="ap-live">
          {access.write
            ? "Read, download and change files. Changes are immediate."
            : "Read and download only."}
        </p>
      </div>
      {access.roots.length > 1 && (
        <OptionButtons
          label="Shared folder"
          value={currentRoot}
          onChange={(index) => {
            setRoot(Number(index));
            setDir("");
            setQuery("");
            setSearch("");
            setFile(null);
          }}
          options={access.roots.map((folder) => ({
            value: folder.index,
            label: folder.name,
            icon: <Folder size={16} />,
            title: folder.path,
          }))}
        />
      )}
      <form
        className="ap-row"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
          setRevision((value) => value + 1);
        }}
      >
        <label className="ag-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Find a file"
            placeholder={`Find a file in ${rootName}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="ag-secondary ag-small" type="submit">
          Find
        </button>
      </form>
      <nav className="ap-crumbs" aria-label="Folder path">
        {search ? (
          <span>
            Results for “{search}” in {rootName}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setDir("");
                setFile(null);
              }}
              aria-current={!dir ? "location" : undefined}
            >
              {rootName}
            </button>
            {crumbs.map((part, index) => (
              <span key={index} className="ap-crumb">
                <ChevronRight size={13} aria-hidden="true" />
                <button
                  type="button"
                  aria-current={
                    index === crumbs.length - 1 ? "location" : undefined
                  }
                  onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}
                >
                  {part}
                </button>
              </span>
            ))}
          </>
        )}
        {(dir || search) && (
          <button
            className="ag-secondary ag-small"
            type="button"
            onClick={() => {
              setSearch("");
              setQuery("");
              setDir(search ? dir : dir.split("/").slice(0, -1).join("/"));
            }}
          >
            <ChevronLeft size={14} />{" "}
            {search ? "Back to the folder" : "Up one folder"}
          </button>
        )}
      </nav>
      {access.write && (
        <AgentFileChanges
          peer={peer}
          root={currentRoot}
          dir={dir}
          file={file}
          onChanged={(opened) => {
            setRevision((value) => value + 1);
            if (opened !== undefined) setFile(opened);
          }}
          onError={(e) => {
            ended(e);
            tell(`Not done: ${(e as Error).message}`, "is-blocked");
          }}
        />
      )}
      <div className="ap-files">
        {listBusy ? (
          <p className="ap-quiet" role="status">
            Loading files…
          </p>
        ) : listing.items.length ? (
          <ul className="ap-file-list">
            {listing.items.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => void read(entry)}
                  aria-label={`${entry.type === "directory" ? "Open folder" : "Read file"} ${entry.path}`}
                  aria-current={file?.path === entry.path ? true : undefined}
                >
                  {entry.type === "directory" ? (
                    <Folder size={16} />
                  ) : (
                    <FileText size={16} />
                  )}
                  <span>
                    <strong>{entry.name}</strong>
                    {search && <small>{entry.path}</small>}
                  </span>
                  <em aria-hidden="true">
                    {entry.type === "directory" ? "Open" : "Read"}
                  </em>
                </button>
                {entry.type === "file" && (
                  <button
                    type="button"
                    className="ap-download"
                    aria-label={`Download file ${entry.path}`}
                    disabled={!!downloading}
                    onClick={() => void download(entry)}
                  >
                    <Download size={14} />{" "}
                    {downloading === entry.path ? "Downloading…" : "Download"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ap-quiet">
            {search ? "No files match that name." : "This folder is empty."}
          </p>
        )}
        {listing.truncated && (
          <p className="ap-quiet">
            More files exist. Narrow the search or open a folder.
          </p>
        )}
        {file && (
          <article className="ap-file" aria-label={`Contents of ${file.path}`}>
            <h3>
              <FileText size={14} /> {file.path}
            </h3>
            <pre>{file.text}</pre>
          </article>
        )}
      </div>
    </section>
  );
}

function TerminalsCard({
  peer,
  access,
  ended,
}: {
  peer: Peer;
  access: PresetAccess;
  ended: (e: unknown) => void;
}) {
  const [terminal, setTerminal] = useState(access.terminals[0]?.id ?? "");
  const [output, setOutput] = useState("");
  const current = access.terminals.some((item) => item.id === terminal)
    ? terminal
    : (access.terminals[0]?.id ?? "");
  useEffect(() => {
    if (!current) return;
    let alive = true;
    const load = () =>
      request<{ output: string }>(
        peer,
        `/api/browser/terminals/${encodeURIComponent(current)}`,
      )
        .then((value) => alive && setOutput(value.output))
        .catch((e) => alive && ended(e));
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [peer, current, ended]);
  return (
    <section className="ap-card" aria-labelledby="ap-terminals-title">
      <div className="ap-card-head">
        <h2 id="ap-terminals-title">
          <Terminal size={16} /> Shared terminal output
        </h2>
        <p className="ap-live">Output only, updated every few seconds.</p>
      </div>
      {access.terminals.length > 1 && (
        <OptionButtons
          label="Shared terminal"
          value={current}
          onChange={setTerminal}
          options={access.terminals.map((item) => ({
            value: item.id,
            label: item.name,
            icon: <Terminal size={15} />,
          }))}
        />
      )}
      <pre className="browser-output" aria-label="Terminal transcript">
        {output || "No output yet."}
      </pre>
    </section>
  );
}
