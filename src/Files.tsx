import {
  workspaceCapabilities,
  type WorkspaceCapabilities,
} from "./capabilities";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isNative, saveBlob } from "./native";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  Code2,
  Copy,
  Download,
  File,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  FolderPlus,
  Image,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  MoreHorizontal,
  Package,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Send,
  Share2,
  Upload,
  X,
} from "lucide-react";
import { Peer, Device, FileEntry, request, post, fileBlob, bytes } from "./api";
import { Folder, Terminal, MessageSquare, Empty, ErrorLine } from "./ui";
import {
  fileKind,
  friendlyDate,
  imageType,
  kindLabel,
  baseName,
  iconType,
  parentPath,
  previewMode,
  whenMissing,
  type FileKind,
} from "./file-kinds";
import { preparedFile, useFileShare } from "./useFileShare";
import {
  backgroundDownloads,
  downloadInBackground,
  downloadThroughBrowser,
  downloadWithProgress,
  sendToComputer,
  uploadFiles as startUploads,
} from "./transfers";
import { useFileTypeIcons } from "./app-icons";
import "./files.css";

const kindIcons: Record<FileKind, typeof File> = {
  folder: Folder,
  image: Image,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  archive: Archive,
  code: Code2,
  sheet: FileSpreadsheet,
  slides: Presentation,
  doc: FileText,
  text: FileText,
  package: Package,
  file: File,
};
// The icon the computer's own file manager uses (Finder, Explorer, the Linux
// icon theme); Reach's colour-coded icon until then, or where there is none.
export function KindIcon({
  entry,
  native,
  size = 20,
}: {
  entry: FileEntry;
  native?: string | null;
  size?: number;
}) {
  const kind = fileKind(entry);
  if (native)
    return (
      <span className="file-kind is-native" aria-hidden="true">
        <img src={native} alt="" draggable={false} />
      </span>
    );
  const Icon = kindIcons[kind];
  return (
    <span className={`file-kind kind-${kind}`} aria-hidden="true">
      <Icon size={size} />
    </span>
  );
}

// Folder listings stay in memory, so going back (or returning to Files) is
// instant while a fresh copy loads; pressing a folder starts its fetch early.
type Listing = { items: FileEntry[]; truncated: boolean };
const listings = new Map<string, Listing>();
const loading = new Map<string, Promise<Listing>>();
function loadListing(peer: Peer, root: number, dir: string, hidden: boolean) {
  const key = JSON.stringify([peer.url, peer.token, root, dir, hidden]);
  let pending = loading.get(key);
  if (!pending) {
    pending = request(
      peer,
      `/api/files?${new URLSearchParams({ root: String(root), path: dir, hidden: hidden ? "1" : "0" })}`,
    )
      .then((r) => {
        if (!Array.isArray(r?.items))
          throw new Error("This folder couldn’t load. Try refreshing.");
        const listing = {
          items: r.items as FileEntry[],
          truncated: !!r.truncated,
        };
        listings.delete(key);
        listings.set(key, listing);
        if (listings.size > 60) listings.delete(listings.keys().next().value!);
        return listing;
      })
      .finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return { key, pending };
}

type Sort = "name" | "recent" | "size";
const sorts: [Sort, string][] = [
  ["name", "Name"],
  ["recent", "Recent"],
  ["size", "Size"],
];
const savedSort = (): Sort => {
  try {
    const value = localStorage.getItem("reach.files.sort");
    return value === "recent" || value === "size" ? value : "name";
  } catch {
    return "name";
  }
};
type View = "list" | "grid";
const savedView = (): View => {
  try {
    return localStorage.getItem("reach.files.view") === "grid"
      ? "grid"
      : "list";
  } catch {
    return "list";
  }
};
// One collator for every comparison: building one per call made sorting a
// large folder slow.
const names = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const byName = (a: FileEntry, b: FileEntry) => names.compare(a.name, b.name);
// Big folders draw this many items first, then more as you scroll.
const PAGE = 150;

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

export default function Files({
  features: suppliedFeatures,
  initialLocation,
  onLocationChange,
  peer,
  device,
  peers,
  onSession,
  toast,
}: {
  features?: WorkspaceCapabilities;
  initialLocation?: { root: number; dir: string };
  onLocationChange?: (location: { root: number; dir: string }) => void;
  peer: Peer;
  device: Device;
  peers: Peer[];
  onSession: (kind: string, path: string, root: number) => void;
  toast: (s: string) => void;
}) {
  const [root, setRoot] = useState(initialLocation?.root || 0),
    [dir, setDir] = useState(initialLocation?.dir || ""),
    [hidden, setHidden] = useState(false),
    [revision, setRevision] = useState(0),
    [entries, setEntries] = useState<FileEntry[]>([]),
    [busyLoading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [searching, setSearching] = useState(false),
    [sort, setSort] = useState<Sort>(savedSort),
    [view, setView] = useState<View>(savedView),
    [panel, setPanel] = useState<"" | "options" | "add" | "locations">(""),
    [expanded, setExpanded] = useState(""),
    [creating, setCreating] = useState(false),
    [folderName, setFolderName] = useState(""),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false),
    [preview, setPreview] = useState<FileEntry | null>(null),
    // A folder that disappeared while open, shown once where Files landed.
    [missing, setMissing] = useState<{ name: string; shared?: boolean } | null>(
      null,
    );
  const features = suppliedFeatures || workspaceCapabilities(device);
  const sharer = useFileShare(peer, root, toast, (file) => gone(file));
  const canWrite = features.writeFiles;
  const guest = device.access?.kind === "guest";
  const upload = useRef<HTMLInputElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onLocationChange?.({ root, dir });
  }, [root, dir]);
  // A new folder starts clean: no search, no open menus.
  useEffect(() => {
    setQuery("");
    setSearching(false);
    setExpanded("");
    setCreating(false);
    setPanel((p) => (p === "add" || p === "locations" ? "" : p));
  }, [root, dir]);
  useEffect(() => {
    let active = true;
    const { key, pending } = loadListing(peer, root, dir, hidden);
    const cached = listings.get(key);
    setEntries(cached?.items || []);
    setLoading(!cached);
    setError("");
    pending
      .then((listing) => {
        if (!active) return;
        setEntries(listing.items);
        if (listing.truncated && !cached)
          toast(
            "Showing the first 2,000 entries. Open a folder to narrow the list.",
          );
      })
      .catch((e) => {
        if (!active) return;
        // The folder was moved or deleted on the computer (or is no longer
        // shared): climb to the nearest place that still exists.
        const next = whenMissing(e, dir);
        const first = device.roots[0]?.id ?? 0;
        if (next !== "stay") listings.delete(key);
        if (next === "parent") {
          // While climbing, name the highest folder that turned out missing.
          setMissing({ name: baseName(dir) });
          setDir(parentPath(dir));
        } else if (next === "first-root" && root !== first) {
          setMissing((m) => m || { name: rootName, shared: true });
          setRoot(first);
          setDir("");
        } else setError(e.message);
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [peer.url, peer.token, root, dir, hidden, revision]);
  // Coming back to the app refreshes what's on screen.
  useEffect(() => {
    const visible = () =>
      document.visibilityState === "visible" && setRevision((n) => n + 1);
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  const refresh = () => setRevision((n) => n + 1);
  const go = (path: string) => {
    setMissing(null);
    setDir(path);
  };
  useEffect(() => {
    if (!missing) return;
    const timer = setTimeout(() => setMissing(null), 8000);
    return () => clearTimeout(timer);
  }, [missing]);
  // A file deleted or moved on the computer since this list loaded.
  const gone = (file: FileEntry) => {
    setPreview((p) => (p?.path === file.path ? null : p));
    setExpanded("");
    sharer.forget(file);
    toast(`“${file.name}” was moved or deleted.`);
    refresh();
  };
  const prefetch = (entry: FileEntry) =>
    entry.type === "directory" &&
    void loadListing(peer, root, entry.path, hidden).pending.catch(() => {});

  // Progress for both directions shows in the app-wide transfer tray.
  const download = async (file: FileEntry) => {
    try {
      // Already on this device (prepared for sharing): save it straight away.
      const ready = preparedFile(peer, root, file);
      if (ready) return void (await saveBlob(ready, file.name));
      // A browser downloads through its own manager: progress, background,
      // and nothing held in memory here.
      if (!isNative && (await downloadThroughBrowser(peer, root, file)))
        return toast(`Downloading ${file.name}`);
      // The iPhone app: iOS keeps downloading in the background.
      if (backgroundDownloads())
        return void (await downloadInBackground(peer, root, file, () =>
          gone(file),
        ));
      await saveBlob(await downloadWithProgress(peer, root, file), file.name);
    } catch (e) {
      if (isGone(e)) gone(file);
      else if ((e as Error)?.name !== "AbortError") toast((e as Error).message);
    }
  };
  const uploadFiles = (files: FileList | File[] | null) => {
    const list = Array.from(files || []);
    if (upload.current) upload.current.value = "";
    if (!list.length || !canWrite) return;
    startUploads(peer, root, dir, list, refresh);
  };
  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await post(peer, "/api/files/folder", { root, path: dir, name });
      setCreating(false);
      setFolderName("");
      refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chooseSort = (value: Sort) => {
    setSort(value);
    try {
      localStorage.setItem("reach.files.sort", value);
    } catch {}
  };
  const chooseView = (value: View) => {
    setView(value);
    setExpanded("");
    try {
      localStorage.setItem("reach.files.view", value);
    } catch {}
  };

  // Typing stays instant; the list catches up a moment later.
  const needle = useDeferredValue(query.trim().toLowerCase());
  const shown = useMemo(
    () =>
      entries
        .filter((f) => !needle || f.name.toLowerCase().includes(needle))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          if (sort === "recent")
            return (
              Date.parse(b.modified) - Date.parse(a.modified) || byName(a, b)
            );
          if (sort === "size" && a.type !== "directory")
            return b.size - a.size || byName(a, b);
          return byName(a, b);
        }),
    [entries, needle, sort],
  );
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [root, dir, needle, sort, view]);
  const drawn = shown.length > limit ? shown.slice(0, limit) : shown;
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const sentinel = more.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (seen) => seen[0]?.isIntersecting && setLimit((l) => l + PAGE * 2),
      { rootMargin: "800px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [drawn.length, shown.length]);
  // One lookup for the icons of every file type in this folder.
  const types = useMemo(() => entries.map(iconType), [entries]);
  const iconFor = useFileTypeIcons(peer, types);
  const nativeIcon = (file: FileEntry) => iconFor(iconType(file));
  const rootName =
    device.roots.find((r) => r.id === root)?.name || "Shared folder";
  const parts = dir.split("/").filter(Boolean);
  const title = parts.at(-1) || rootName;
  const parent = parts.slice(0, -1).join("/");
  const parentName = parts.length > 1 ? parts.at(-2)! : rootName;
  const multipleRoots = device.roots.length > 1;
  const folderActions = !guest && (features.terminal || features.codex);
  const toggle = (next: typeof panel) =>
    setPanel((p) => (p === next ? "" : next));

  const hasActions = (file: FileEntry) =>
    file.type === "directory" ? folderActions : true;
  const showActions = (file: FileEntry) => {
    if (!hasActions(file)) return;
    if (file.type !== "directory") sharer.warm(file);
    setExpanded(file.path);
  };
  const open = (file: FileEntry) => {
    setExpanded("");
    if (file.type === "directory") go(file.path);
    else setPreview(file);
  };
  // Grid tiles, like the iPhone Files app: tap to open, press and hold (or
  // right-click) for actions.
  const press = useRef<{ timer: number; x: number; y: number; held: boolean }>(
    null,
  );
  const release = () => press.current && clearTimeout(press.current.timer);
  const tileHandlers = (file: FileEntry) => ({
    onPointerDown: (e: React.PointerEvent) => {
      prefetch(file);
      release();
      press.current = {
        x: e.clientX,
        y: e.clientY,
        held: false,
        timer: window.setTimeout(() => {
          if (press.current) press.current.held = true;
          navigator.vibrate?.(8);
          showActions(file);
        }, 450),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) release();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      release();
      showActions(file);
    },
    onClick: () => {
      const held = press.current?.held;
      press.current = null;
      if (!held) open(file);
    },
  });
  const selected =
    view === "grid" ? shown.find((f) => f.path === expanded) : undefined;

  const rowActions = (file: FileEntry): ReactNode[] =>
    file.type === "directory"
      ? [
          features.terminal && (
            <button
              key="t"
              onClick={() => onSession("terminal", file.path, root)}
            >
              <Terminal size={16} /> Terminal here
            </button>
          ),
          features.codex && (
            <button key="c" onClick={() => onSession("chat", file.path, root)}>
              <MessageSquare size={16} /> Ask Codex
            </button>
          ),
        ].filter(Boolean)
      : [
          sharer.available(file) && (
            <ShareChip
              key="s"
              state={sharer.state(file)}
              onShare={() => sharer.share(file)}
            />
          ),
          <button key="d" onClick={() => void download(file)} disabled={busy}>
            <Download size={16} /> Download
          </button>,
        ].filter(Boolean);

  return (
    <div
      className={`files-view ${dragging ? "is-dropping" : ""}`}
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        uploadFiles(e.dataTransfer.files);
      }}
    >
      <header className="files-header">
        <nav className="files-crumbs" aria-label="Folder path">
          <span>{guest ? `Shared by ${device.name}` : device.name}</span>
          {parts.length > 0 && (
            <button onClick={() => go("")}>{rootName}</button>
          )}
          {parts.slice(0, -1).map((part, i) => (
            <button key={i} onClick={() => go(parts.slice(0, i + 1).join("/"))}>
              {part}
            </button>
          ))}
        </nav>
        <div className="files-titlebar">
          {parts.length > 0 && (
            <button
              className="files-back"
              aria-label={`Back to ${parentName}`}
              onClick={() => go(parent)}
            >
              <ChevronLeft size={24} />
            </button>
          )}
          {parts.length === 0 && multipleRoots ? (
            <button
              className="files-title is-switch"
              aria-expanded={panel === "locations"}
              onClick={() => toggle("locations")}
            >
              <h1>{title}</h1>
              <ChevronDown size={20} />
            </button>
          ) : (
            <h1 className="files-title">{title}</h1>
          )}
          <div className="files-tools">
            <button
              className="files-tool"
              aria-label="Search this folder"
              aria-pressed={searching}
              onClick={() => {
                setSearching((s) => !s);
                setQuery("");
              }}
            >
              <Search size={19} />
            </button>
            <button
              className="files-tool"
              aria-label="Folder options"
              aria-expanded={panel === "options"}
              onClick={() => toggle("options")}
            >
              <MoreHorizontal size={20} />
            </button>
            {canWrite && (
              <button
                className="files-tool is-primary"
                aria-label="Add to this folder"
                aria-expanded={panel === "add"}
                disabled={busy}
                onClick={() => toggle("add")}
              >
                <Plus size={20} />
              </button>
            )}
          </div>
        </div>
        {searching && (
          <label className="files-search">
            <Search size={17} />
            <input
              ref={searchField}
              autoFocus
              type="search"
              aria-label={`Search ${title}`}
              placeholder={`Search ${title}`}
              value={query}
              enterKeyHint="search"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                setQuery("");
                setSearching(false);
              }}
            />
            <button
              type="button"
              aria-label="Close search"
              onClick={() => {
                setQuery("");
                setSearching(false);
              }}
            >
              <X size={16} />
            </button>
          </label>
        )}
        {panel === "locations" && (
          <div
            className="files-panel files-locations"
            role="group"
            aria-label="Locations"
          >
            {device.roots.map((r) => (
              <button
                key={r.id}
                aria-pressed={root === r.id}
                onClick={() => {
                  setMissing(null);
                  setRoot(r.id);
                  setDir("");
                  setPanel("");
                }}
              >
                <FolderOpen size={16} />
                {r.name}
                {root === r.id && <Check size={15} />}
              </button>
            ))}
          </div>
        )}
        {panel === "options" && (
          <div className="files-panel files-card">
            <div className="files-row">
              <span>View</span>
              <div className="files-segment" role="group" aria-label="View as">
                <button
                  aria-pressed={view === "list"}
                  onClick={() => chooseView("list")}
                >
                  <ListIcon size={15} /> List
                </button>
                <button
                  aria-pressed={view === "grid"}
                  onClick={() => chooseView("grid")}
                >
                  <LayoutGrid size={15} /> Grid
                </button>
              </div>
            </div>
            <div className="files-row">
              <span>Sort by</span>
              <div className="files-segment" role="group" aria-label="Sort by">
                {sorts.map(([id, label]) => (
                  <button
                    key={id}
                    aria-pressed={sort === id}
                    onClick={() => chooseSort(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="files-row">
              <span>Show hidden files</span>
              <input
                type="checkbox"
                role="switch"
                className="files-switch"
                checked={hidden}
                onChange={(e) => setHidden(e.target.checked)}
              />
            </label>
            <div className="files-tiles">
              <button onClick={refresh}>
                <RefreshCw size={18} className={busyLoading ? "spin" : ""} />
                Refresh
              </button>
              {!guest && features.terminal && (
                <button onClick={() => onSession("terminal", dir, root)}>
                  <Terminal size={18} /> Terminal here
                </button>
              )}
              {!guest && features.codex && (
                <button onClick={() => onSession("chat", dir, root)}>
                  <MessageSquare size={18} /> Ask Codex
                </button>
              )}
            </div>
          </div>
        )}
        {panel === "add" && (
          <div className="files-panel files-card">
            <div className="files-tiles">
              <button
                onClick={() => {
                  setPanel("");
                  upload.current?.click();
                }}
              >
                <Upload size={18} /> Upload files
              </button>
              <button
                onClick={() => {
                  setPanel("");
                  setCreating(true);
                }}
              >
                <FolderPlus size={18} /> New folder
              </button>
            </div>
          </div>
        )}
        {canWrite && (
          <input
            ref={upload}
            type="file"
            multiple
            hidden
            onChange={(e) => uploadFiles(e.target.files)}
          />
        )}
      </header>

      {missing && (
        <div className="files-note" role="status">
          <span>
            {missing.shared
              ? `“${missing.name}” is no longer shared.`
              : `“${missing.name}” was moved or deleted.`}{" "}
            Showing {title}.
          </span>
          <button aria-label="Dismiss" onClick={() => setMissing(null)}>
            <X size={15} />
          </button>
        </div>
      )}

      {error ? (
        <div className="files-error">
          <ErrorLine error={error} />
          <button className="button secondary small" onClick={refresh}>
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      ) : (
        <div
          className={`files-list ${view === "grid" ? "is-grid" : ""}`}
          aria-busy={busyLoading}
        >
          {view === "list" && (
            <div className="files-columns" aria-hidden="true">
              <span>Name</span>
              <span>Kind</span>
              <span>Modified</span>
              <span>Size</span>
              <span />
            </div>
          )}
          {creating && (
            <form
              className="file-item is-new"
              onSubmit={(e) => {
                e.preventDefault();
                void createFolder();
              }}
            >
              <span className="file-kind kind-folder" aria-hidden="true">
                <FolderPlus size={20} />
              </span>
              <input
                autoFocus
                required
                aria-label="Folder name"
                placeholder="Folder name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
              />
              <button
                className="button primary small"
                disabled={busy || !folderName.trim()}
              >
                Create
              </button>
              <button
                type="button"
                className="files-tool"
                aria-label="Cancel new folder"
                onClick={() => {
                  setCreating(false);
                  setFolderName("");
                }}
              >
                <X size={17} />
              </button>
            </form>
          )}
          {busyLoading && !shown.length && view === "grid"
            ? Array.from({ length: 9 }, (_, i) => (
                <div className="file-tile is-skeleton" key={i}>
                  <span className="file-tile-icon">
                    <span className="file-kind" />
                  </span>
                  <i />
                  <i />
                </div>
              ))
            : view === "grid"
              ? drawn.map((file) => {
                  const folder = file.type === "directory";
                  const date = friendlyDate(file.modified);
                  return (
                    <button
                      key={file.path}
                      className={`file-tile ${expanded === file.path ? "is-selected" : ""}`}
                      aria-haspopup={hasActions(file) ? "true" : undefined}
                      title={file.name}
                      {...tileHandlers(file)}
                    >
                      <span className="file-tile-icon">
                        <KindIcon
                          entry={file}
                          native={nativeIcon(file)}
                          size={28}
                        />
                      </span>
                      <span className="file-tile-name">
                        <span>
                          <Highlight text={file.name} query={needle} />
                        </span>
                      </span>
                      <span className="file-tile-meta">
                        {date}
                        {!folder && <span>{bytes(file.size)}</span>}
                      </span>
                    </button>
                  );
                })
              : busyLoading && !shown.length
                ? Array.from({ length: 7 }, (_, i) => (
                    <div className="file-item is-skeleton" key={i}>
                      <span className="file-kind" />
                      <span className="file-text">
                        <i style={{ width: `${48 + ((i * 37) % 40)}%` }} />
                        <i />
                      </span>
                    </div>
                  ))
                : drawn.map((file) => {
                    const kind = fileKind(file);
                    const folder = file.type === "directory";
                    const date = friendlyDate(file.modified);
                    const actions =
                      expanded === file.path ? rowActions(file) : [];
                    return (
                      <div
                        className={`file-item ${expanded === file.path ? "is-open" : ""}`}
                        key={file.path}
                      >
                        <button
                          className="file-main"
                          onPointerDown={() => prefetch(file)}
                          onClick={() => open(file)}
                        >
                          <KindIcon entry={file} native={nativeIcon(file)} />
                          <span className="file-text">
                            <span className="file-name">
                              {/* One child, so the line clamp keeps the highlight inline. */}
                              <span>
                                <Highlight text={file.name} query={needle} />
                              </span>
                            </span>
                            <span className="file-meta">
                              {folder ? "Folder" : bytes(file.size)}
                              {date && ` · ${date}`}
                            </span>
                          </span>
                          <span className="file-col">{kindLabel(kind)}</span>
                          <span className="file-col">{date}</span>
                          <span className="file-col">
                            {folder ? "—" : bytes(file.size)}
                          </span>
                        </button>
                        {hasActions(file) ? (
                          <button
                            className="files-tool file-more"
                            aria-label={`Actions for ${file.name}`}
                            aria-expanded={expanded === file.path}
                            onClick={() => {
                              if (expanded !== file.path && !folder)
                                sharer.warm(file);
                              setExpanded((p) =>
                                p === file.path ? "" : file.path,
                              );
                            }}
                          >
                            <MoreHorizontal size={18} />
                          </button>
                        ) : (
                          <span className="file-more" />
                        )}
                        {actions.length > 0 && (
                          <div
                            className="file-actions"
                            role="group"
                            aria-label={`${file.name} actions`}
                          >
                            {actions}
                          </div>
                        )}
                      </div>
                    );
                  })}
          {drawn.length < shown.length && (
            // Loads by itself as it scrolls into view; a tap works too.
            <button
              ref={more}
              className="files-more"
              onClick={() => setLimit((l) => l + PAGE * 2)}
            >
              Show {Math.min(PAGE * 2, shown.length - drawn.length)} more
            </button>
          )}
          {!busyLoading && !shown.length && !creating && (
            <Empty
              icon={needle ? Search : Folder}
              title={needle ? "No matches" : "This folder is empty"}
              action={
                !needle && canWrite ? (
                  <button
                    className="button secondary small"
                    onClick={() => upload.current?.click()}
                  >
                    <Upload size={15} /> Upload files
                  </button>
                ) : undefined
              }
            >
              {needle
                ? `Nothing in ${title} matches “${query.trim()}”.`
                : canWrite
                  ? matchMedia("(pointer: fine)").matches
                    ? "Add files from this computer, or drop them here."
                    : "Add files from this device to get started."
                  : "There are no files in this folder yet."}
            </Empty>
          )}
        </div>
      )}
      {selected && (
        <div
          className="files-actionbar"
          role="toolbar"
          aria-label={`${selected.name} actions`}
          onKeyDown={(e) => e.key === "Escape" && setExpanded("")}
        >
          <KindIcon entry={selected} native={nativeIcon(selected)} size={16} />
          <strong>{selected.name}</strong>
          <button
            className="files-tool"
            aria-label="Close actions"
            onClick={() => setExpanded("")}
          >
            <X size={17} />
          </button>
          <div className="file-actions">{rowActions(selected)}</div>
        </div>
      )}
      {dragging && (
        <div className="files-drop" aria-hidden="true">
          <Upload size={22} /> Drop to add to {title}
        </div>
      )}
      {preview && (
        <Viewer
          peer={peer}
          peers={peers}
          file={preview}
          root={root}
          download={() => download(preview)}
          gone={() => gone(preview)}
          icon={nativeIcon(preview)}
          sharer={sharer}
          toast={toast}
          close={() => setPreview(null)}
        />
      )}
    </div>
  );
}

// Share goes straight to the phone's share sheet; while the file is still being
// fetched it spins, and if the browser needs a fresh tap it says so.
function ShareChip({
  state,
  onShare,
}: {
  state: ReturnType<ReturnType<typeof useFileShare>["state"]>;
  onShare: () => void;
}) {
  return (
    <button className={state === "armed" ? "is-ready" : ""} onClick={onShare}>
      {state === "preparing" ? (
        <Loader2 size={16} className="spin" />
      ) : (
        <Share2 size={16} />
      )}
      {state === "armed" ? "Tap to share" : "Share"}
    </button>
  );
}

const isGone = (e: unknown) => (e as { status?: number })?.status === 404;
const MAX_IMAGE_PREVIEW = 25 * 1024 * 1024;
const nouns: Partial<Record<FileKind, string>> = {
  image: "image",
  video: "video",
  audio: "audio file",
  pdf: "PDF",
  archive: "archive",
  sheet: "spreadsheet",
  slides: "presentation",
  doc: "document",
  package: "installer",
};
// Recently viewed images, so reopening one doesn't download it again.
const viewed = new Map<string, Blob>();
const remember = (key: string, blob: Blob) => {
  viewed.delete(key);
  viewed.set(key, blob);
  let total = [...viewed.values()].reduce((n, b) => n + b.size, 0);
  for (const [k, b] of viewed) {
    if (total <= 40 * 1024 * 1024 || viewed.size <= 1) break;
    viewed.delete(k);
    total -= b.size;
  }
};

function Viewer({
  peer,
  peers,
  file,
  root,
  download,
  gone,
  icon,
  sharer,
  toast,
  close,
}: {
  peer: Peer;
  peers: Peer[];
  file: FileEntry;
  root: number;
  download: () => void;
  gone: () => void;
  icon: string | null;
  sharer: ReturnType<typeof useFileShare>;
  toast: (s: string) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const kind = fileKind(file);
  const mode = previewMode(file);
  const [text, setText] = useState(""),
    [image, setImage] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [copied, setCopied] = useState(false),
    [target, setTarget] = useState(""),
    [sending, setSending] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  // Images are shared from the copy fetched for the preview, not a second one.
  useEffect(() => {
    if (mode !== "image") sharer.warm(file);
  }, [file.path]);
  // The write happens inside the tap: phones refuse clipboard writes after it.
  const copy = () => {
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      // Outside the open dialog the page is inert, so select inside it.
      dialog.current?.append(area);
      area.select();
      const done = document.execCommand("copy");
      area.remove();
      if (done) setCopied(true);
      else toast("Couldn’t copy. Select the text to copy it instead.");
    };
    if (!navigator.clipboard?.writeText) return fallback();
    navigator.clipboard.writeText(text).then(() => setCopied(true), fallback);
  };
  const shareState = sharer.state(file);
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    (async () => {
      try {
        const type = imageType(file.name);
        if (mode === "image") {
          if (file.size > MAX_IMAGE_PREVIEW)
            throw new Error(
              "This image is too large to preview. Download it instead.",
            );
          const key = JSON.stringify([
            peer.url,
            root,
            file.path,
            file.modified,
          ]);
          let blob = viewed.get(key);
          if (!blob) {
            blob = await fileBlob(peer, file.path, root, {
              signal: controller.signal,
            });
            remember(key, blob);
          }
          sharer.warm(file, blob);
          url = URL.createObjectURL(new Blob([blob], { type }));
          setImage(url);
        } else if (mode === "text" || mode === "document") {
          const r = await request(
            peer,
            `/api/files/${mode === "text" ? "text" : "document-text"}?${new URLSearchParams({ root: String(root), path: file.path })}`,
            { signal: controller.signal },
          );
          setText(r.text);
        } else
          throw new Error(`Download to open this ${nouns[kind] || "file"}.`);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (isGone(e)) return gone();
        setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.path]);
  const others = peers.filter((p) => p.id !== peer.id);
  return (
    <dialog
      ref={dialog}
      className="file-viewer"
      aria-label={file.name}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="file-viewer-inner">
        <header>
          <button
            className="files-tool"
            aria-label="Close preview"
            onClick={close}
          >
            <ChevronLeft size={24} />
          </button>
          <div className="file-viewer-title">
            <strong>{file.name}</strong>
            <small>
              {bytes(file.size)} · {friendlyDate(file.modified)}
            </small>
          </div>
          {!loading && !error && !image && text && (
            <button
              className={`files-tool ${copied ? "is-done" : ""}`}
              aria-label={copied ? "Copied" : "Copy text"}
              onClick={copy}
            >
              {copied ? <Check size={19} /> : <Copy size={18} />}
            </button>
          )}
          {sharer.available(file) && (
            <button
              className={`files-tool ${shareState === "armed" ? "is-ready" : ""}`}
              aria-label={
                shareState === "armed"
                  ? `Tap to share ${file.name}`
                  : `Share ${file.name}`
              }
              onClick={() => sharer.share(file)}
            >
              {shareState === "preparing" ? (
                <Loader2 size={18} className="spin" />
              ) : (
                <Share2 size={19} />
              )}
            </button>
          )}
          <button
            className="files-tool"
            aria-label={`Download ${file.name}`}
            onClick={download}
          >
            <Download size={19} />
          </button>
        </header>
        <div
          className={`file-viewer-body ${image ? "is-image" : ""} ${mode === "document" ? "is-document" : ""}`}
        >
          {loading ? (
            <Loader2 className="spin" size={24} aria-label="Loading preview" />
          ) : error ? (
            <div className="file-viewer-empty">
              <KindIcon entry={file} native={icon} size={30} />
              <p>{error}</p>
              <button className="button primary small" onClick={download}>
                <Download size={15} /> Download
              </button>
            </div>
          ) : image ? (
            <img src={image} alt={file.name} />
          ) : (
            <pre>{text || "(Empty file)"}</pre>
          )}
        </div>
        {others.length > 0 && (
          <footer className="file-viewer-send">
            <select
              aria-label="Destination computer"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Send to another computer…</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="button secondary small"
              disabled={!target || sending}
              onClick={async () => {
                setSending(true);
                try {
                  const dest = peers.find((p) => p.id === target)!;
                  // Progress, resume and errors show in the transfer tray.
                  await sendToComputer(peer, root, file, dest);
                  toast(`Sent to ${dest.name}’s shared folder`);
                } catch (e) {
                  if (isGone(e)) gone();
                } finally {
                  setSending(false);
                }
              }}
            >
              <Send size={15} />
              {sending ? "Sending…" : "Send"}
            </button>
          </footer>
        )}
      </div>
    </dialog>
  );
}
