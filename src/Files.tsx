import {
  workspaceCapabilities,
  type WorkspaceCapabilities,
} from "./capabilities";
import {
  lazy,
  Suspense,
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
  CircleCheck,
  Circle,
  ChevronDown,
  ChevronLeft,
  CodeXml,
  Eye,
  Copy,
  Download,
  File,
  FileHeadphone,
  FileSpreadsheet,
  FileText,
  FolderInput,
  FilePlay,
  FolderOpen,
  FolderPlus,
  Image,
  LayoutGrid,
  List as ListIcon,
  LoaderCircle,
  Ellipsis,
  Package,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Send,
  SendHorizontal,
  Share2,
  Upload,
  X,
} from "lucide-react";
import { Peer, Device, FileEntry, request, post, fileBlob, bytes } from "./api";
import { Folder, Terminal, Empty, ErrorLine } from "./ui";
import {
  fileKind,
  friendlyDate,
  imageType,
  isArchive,
  isMarkdown,
  kindLabel,
  baseName,
  iconType,
  parentPath,
  previewMode,
  whenMissing,
  type FileKind,
} from "./file-kinds";
import {
  byteLength,
  EDIT_LIMIT,
  editable,
  forEditing,
  forSaving,
  type Editable,
} from "./file-edit";
import { computerWord } from "./pause";
import { preparedFile, useFileShare } from "./useFileShare";
import {
  agentLabel,
  projectName,
  sendMessage,
  type AgentSession,
} from "./agent-sessions";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import {
  backgroundDownloads,
  downloadInBackground,
  downloadThroughBrowser,
  downloadWithProgress,
  sendToComputer,
  sourceFileGone,
  uploadFiles as startUploads,
} from "./transfers";
import { useFileTypeIcons } from "./app-icons";
import "./files.css";

const FilePdf = lazy(() => import("./FilePdf"));
const FileCode = lazy(() => import("./FileCode"));
const FileMarkdown = lazy(() => import("./FileMarkdown"));

const kindIcons: Record<FileKind, typeof File> = {
  folder: Folder,
  image: Image,
  video: FilePlay,
  audio: FileHeadphone,
  pdf: FileText,
  archive: Archive,
  code: CodeXml,
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
function loadListing(
  peer: Peer,
  root: number,
  dir: string,
  hidden: boolean,
  fresh = false,
) {
  const key = JSON.stringify([peer.url, peer.token, root, dir, hidden]);
  let pending = loading.get(key);
  // After a change (upload, unzip, new folder) a request already in flight
  // may predate it: start a new one and let only the newest write the cache.
  if (fresh && pending) pending = undefined;
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
        if (loading.get(key) === pending) {
          listings.delete(key);
          listings.set(key, listing);
          if (listings.size > 60)
            listings.delete(listings.keys().next().value!);
        }
        return listing;
      })
      .finally(() => {
        if (loading.get(key) === pending) loading.delete(key);
      });
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
  agentSessions,
  agentLogos = {},
  openAgentSession,
  toast,
}: {
  features?: WorkspaceCapabilities;
  initialLocation?: { root: number; dir: string };
  onLocationChange?: (location: { root: number; dir: string }) => void;
  peer: Peer;
  device: Device;
  peers: Peer[];
  onSession: (kind: string, path: string, root: number) => void;
  // Agent sessions on this same computer, to hand files to.
  agentSessions?: AgentSession[];
  agentLogos?: AgentLogos;
  openAgentSession?: (s: AgentSession) => void;
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
    // Select mode, as in the Files app: taps pick instead of opening.
    [selecting, setSelecting] = useState(false),
    [picked, setPicked] = useState<string[]>([]),
    [sendingTo, setSendingTo] = useState<FileEntry[] | null>(null),
    // A folder that disappeared while open, shown once where Files landed.
    [missing, setMissing] = useState<{ name: string; shared?: boolean } | null>(
      null,
    );
  const features = suppliedFeatures || workspaceCapabilities(device);
  const sharer = useFileShare(peer, root, toast, (file) => gone(file));
  const canWrite = features.writeFiles;
  const canExtract = features.mac && canWrite;
  // A person with full access gets the folder actions too.
  const guest = device.access?.kind === "guest" && !features.mac;
  const freshListing = useRef(false);
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
    setPicked([]);
    setPanel((p) => (p === "add" || p === "locations" ? "" : p));
  }, [root, dir]);
  useEffect(() => {
    let active = true;
    const fresh = freshListing.current;
    freshListing.current = false;
    const { key, pending } = loadListing(peer, root, dir, hidden, fresh);
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
  const refresh = () => {
    freshListing.current = true;
    setRevision((n) => n + 1);
  };
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
      if (backgroundDownloads(peer))
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
  // Agents run on this computer, so they get the file's own path.
  const rootPath = device.roots.find((r) => r.id === root)?.path || "";
  const separator = device.platform === "win32" ? "\\" : "/";
  const fullPath = (file: FileEntry) =>
    [rootPath.replace(/[\\/]+$/, ""), ...file.path.split("/")].join(separator);
  const agents = (agentSessions || []).filter((s) => !s.archived);
  const canSendToAgent =
    features.owner && !!rootPath && agents.some((s) => !cannotReply(s));
  const [unzipping, setUnzipping] = useState<string[]>([]);
  const extracting = useRef(new Set<string>());
  const unzip = async (files: FileEntry[]) => {
    const list = files.filter(
      (f) =>
        f.type !== "directory" &&
        isArchive(f.name) &&
        !extracting.current.has(f.path),
    );
    if (!canExtract || !list.length) return false;
    list.forEach((f) => extracting.current.add(f.path));
    setUnzipping((u) => [...u, ...list.map((f) => f.path)]);
    let complete = true;
    try {
      for (const file of list) {
        try {
          const r = await post<{ name: string }>(peer, "/api/files/extract", {
            root,
            path: file.path,
          });
          toast(`Unzipped into “${r.name}”`);
          setPicked((p) => p.filter((path) => path !== file.path));
        } catch (e) {
          complete = false;
          if (isGone(e)) gone(file);
          else toast(`“${file.name}”: ${(e as Error).message}`);
        }
      }
    } finally {
      list.forEach((f) => extracting.current.delete(f.path));
      setUnzipping((u) => u.filter((p) => !list.some((f) => f.path === p)));
      refresh();
    }
    return complete;
  };
  const pickedEntries = shownPicked(entries, picked);
  const pickedFiles = pickedEntries.filter((f) => f.type !== "directory");
  const pickedArchives = pickedFiles.filter((f) => isArchive(f.name));
  const allShownPicked =
    shown.length > 0 && shown.every((f) => picked.includes(f.path));
  useEffect(() => {
    if (!busyLoading)
      setPicked((p) =>
        p.filter((path) => entries.some((f) => f.path === path)),
      );
  }, [entries, busyLoading]);
  const parts = dir.split("/").filter(Boolean);
  const title = parts.at(-1) || rootName;
  const parent = parts.slice(0, -1).join("/");
  const parentName = parts.length > 1 ? parts.at(-2)! : rootName;
  const multipleRoots = device.roots.length > 1;
  const folderActions = !guest && features.terminal;
  const toggle = (next: typeof panel) =>
    setPanel((p) => (p === next ? "" : next));

  const hasActions = (file: FileEntry) =>
    file.type === "directory" ? folderActions || canSendToAgent : true;
  const showActions = (file: FileEntry) => {
    if (selecting || !hasActions(file)) return;
    if (file.type !== "directory") sharer.warm(file);
    setExpanded(file.path);
  };
  const pick = (file: FileEntry) => {
    if (file.type !== "directory" && !picked.includes(file.path))
      sharer.warm(file);
    setPicked((list) =>
      list.includes(file.path)
        ? list.filter((p) => p !== file.path)
        : [...list, file.path],
    );
  };
  const endSelecting = () => {
    setSelecting(false);
    setPicked([]);
  };
  const startSelecting = () => {
    setExpanded("");
    setPanel("");
    setSelecting(true);
  };
  const open = (file: FileEntry) => {
    setExpanded("");
    if (selecting) pick(file);
    else if (file.type === "directory") go(file.path);
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
          canSendToAgent && (
            <button key="a" onClick={() => setSendingTo([file])}>
              <SendHorizontal size={16} /> Send to agent
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
          <button key="d" onClick={() => void download(file)}>
            <Download size={16} /> Download
          </button>,
          canExtract && isArchive(file.name) && (
            <button
              key="z"
              onClick={() => void unzip([file])}
              disabled={unzipping.includes(file.path)}
            >
              {unzipping.includes(file.path) ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <FolderInput size={16} />
              )}
              Unzip
            </button>
          ),
          canSendToAgent && (
            <button key="a" onClick={() => setSendingTo([file])}>
              <SendHorizontal size={16} /> Send to agent
            </button>
          ),
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
            {selecting ? (
              <>
                <button
                  className="files-text-tool"
                  onClick={() =>
                    setPicked(
                      allShownPicked
                        ? picked.filter((p) => !shown.some((f) => f.path === p))
                        : [
                            ...new Set([
                              ...picked,
                              ...shown.map((f) => f.path),
                            ]),
                          ],
                    )
                  }
                >
                  {allShownPicked ? "Deselect All" : "Select All"}
                </button>
                <button
                  className="files-text-tool is-strong"
                  onClick={endSelecting}
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <button
                  className="files-tool files-select-tool"
                  aria-label="Select files"
                  onClick={startSelecting}
                >
                  <CircleCheck size={19} />
                  <span>Select</span>
                </button>
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
                  <Ellipsis size={20} />
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
              </>
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
              <button onClick={startSelecting}>
                <CircleCheck size={18} /> Select files
              </button>
              <button onClick={refresh}>
                <RefreshCw size={18} className={busyLoading ? "spin" : ""} />
                Refresh
              </button>
              {!guest && features.terminal && (
                <button onClick={() => onSession("terminal", dir, root)}>
                  <Terminal size={18} /> Terminal here
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
          className={`files-list ${view === "grid" ? "is-grid" : ""} ${selecting ? "is-selecting" : ""}`}
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
                      className={`file-tile ${expanded === file.path || picked.includes(file.path) ? "is-selected" : ""}`}
                      aria-haspopup={
                        !selecting && hasActions(file) ? "true" : undefined
                      }
                      aria-pressed={
                        selecting ? picked.includes(file.path) : undefined
                      }
                      title={file.name}
                      {...tileHandlers(file)}
                    >
                      {selecting && (
                        <PickMark on={picked.includes(file.path)} />
                      )}
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
                        className={`file-item ${expanded === file.path ? "is-open" : ""} ${picked.includes(file.path) ? "is-picked" : ""}`}
                        key={file.path}
                      >
                        <button
                          className="file-main"
                          aria-pressed={
                            selecting ? picked.includes(file.path) : undefined
                          }
                          onPointerDown={() => !selecting && prefetch(file)}
                          onClick={() => open(file)}
                        >
                          {selecting && (
                            <PickMark on={picked.includes(file.path)} />
                          )}
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
                        {!selecting && hasActions(file) ? (
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
                            <Ellipsis size={18} />
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
      {selecting && (
        <div
          className="files-actionbar is-selection"
          role="toolbar"
          aria-label="Selected items"
        >
          <strong>
            {picked.length ? `${picked.length} selected` : "Select items"}
          </strong>
          <div className="file-actions">
            {sharer.available(pickedFiles[0] || ({} as FileEntry)) && (
              <ShareChip
                state={
                  pickedFiles.length ? sharer.manyState(pickedFiles) : "idle"
                }
                disabled={pickedFiles.length !== pickedEntries.length}
                onShare={() => sharer.shareMany(pickedFiles)}
              />
            )}
            <button
              disabled={
                !pickedFiles.length ||
                pickedFiles.length !== pickedEntries.length
              }
              onClick={() => pickedFiles.forEach((f) => void download(f))}
            >
              <Download size={16} /> Download
            </button>
            {canSendToAgent && (
              <button
                disabled={!pickedEntries.length}
                onClick={() => setSendingTo(pickedEntries)}
              >
                <SendHorizontal size={16} /> Send to agent
              </button>
            )}
            {canExtract && pickedArchives.length > 0 && (
              <button
                disabled={pickedArchives.some((f) =>
                  unzipping.includes(f.path),
                )}
                onClick={async () => {
                  if (await unzip(pickedArchives)) {
                    if (pickedArchives.length === pickedEntries.length)
                      endSelecting();
                  }
                }}
              >
                {pickedArchives.some((f) => unzipping.includes(f.path)) ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <FolderInput size={16} />
                )}{" "}
                Unzip
                {pickedArchives.length > 1 ? ` (${pickedArchives.length})` : ""}
              </button>
            )}
          </div>
        </div>
      )}
      {sendingTo && (
        <SendToAgent
          peer={peer}
          items={sendingTo}
          sessions={agents}
          logos={agentLogos}
          fullPath={fullPath}
          close={() => setSendingTo(null)}
          sent={(session) => {
            setSendingTo(null);
            endSelecting();
            toast(`Sent to ${session.title || agentLabel(session.agent)}`);
            openAgentSession?.(session);
          }}
        />
      )}
      {selected && !selecting && (
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
          key={JSON.stringify([editWorkspace(peer), root, preview.path])}
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
          unzip={
            canExtract && isArchive(preview.name)
              ? async () => {
                  setPreview(null);
                  await unzip([preview]);
                }
              : undefined
          }
          sendToAgent={
            canSendToAgent ? () => setSendingTo([preview]) : undefined
          }
          canEdit={canWrite}
          saved={() => {
            // Share and Download would otherwise hand over the copy fetched
            // before the edit: a fresh one is fetched for the next tap.
            sharer.forget(preview);
            sharer.warm(preview);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// Why Reach can't hand files to a session, if it can't. Only Claude and Codex
// take replies through this endpoint; Gemini CLI's sessions are read-only.
const cannotReply = (s: AgentSession) =>
  s.agent === "claude" || s.agent === "codex"
    ? ""
    : s.agent === "gemini"
      ? "Gemini CLI no longer answers personal Google accounts"
      : `Reach can’t reply in ${agentLabel(s.agent)} chats yet`;

// What's picked, in the folder's order.
const shownPicked = (entries: FileEntry[], picked: string[]) =>
  entries.filter((f) => picked.includes(f.path));

function PickMark({ on }: { on: boolean }) {
  return (
    <span className={`file-pick ${on ? "is-on" : ""}`} aria-hidden="true">
      {on ? <CircleCheck size={22} /> : <Circle size={22} />}
    </span>
  );
}

// Hands files to a writable Claude or Codex session on the same computer: the
// agent gets their paths (it reads them itself), with an optional note.
function SendToAgent({
  peer,
  items,
  sessions,
  logos,
  fullPath,
  close,
  sent,
}: {
  peer: Peer;
  items: FileEntry[];
  sessions: AgentSession[];
  logos: AgentLogos;
  fullPath: (file: FileEntry) => string;
  close: () => void;
  sent: (session: AgentSession) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sendingNow = useRef(false);
  const [note, setNote] = useState(""),
    [target, setTarget] = useState(""),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const recent = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30),
    [sessions],
  );
  const send = async () => {
    if (sendingNow.current) return;
    const session = recent.find((s) => `${s.agent}/${s.id}` === target);
    if (!session || cannotReply(session)) return;
    sendingNow.current = true;
    setError("");
    setSending(true);
    try {
      const paths = items.map((f) => `- ${fullPath(f)}`).join("\n");
      const label = items.length === 1 ? "this file" : "these files";
      const text = note.trim()
        ? `${note.trim()}\n\n${paths}`
        : `Take a look at ${items.some((f) => f.type === "directory") ? (items.length === 1 ? "this folder" : "these") : label}:\n${paths}`;
      await sendMessage(peer, session, { text, images: [] });
      sent(session);
    } catch (e) {
      // The global toast sits behind a modal dialog's top layer. Keep the
      // failure in the dialog until another attempt so it can be read.
      setError((e as Error).message);
      sendingNow.current = false;
      setSending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="files-send"
      aria-label="Send to agent"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <header>
          <strong>Send to agent</strong>
          <small>
            {items.length === 1 ? items[0].name : `${items.length} items`}
          </small>
          <button
            type="button"
            className="files-tool"
            aria-label="Close"
            onClick={close}
          >
            <X size={17} />
          </button>
        </header>
        <div className="files-send-list" role="radiogroup" aria-label="Session">
          {recent.map((s) => {
            const key = `${s.agent}/${s.id}`;
            const blocked = cannotReply(s);
            return (
              <label
                key={key}
                className={`${target === key ? "is-on" : ""} ${blocked ? "is-blocked" : ""}`}
              >
                <input
                  type="radio"
                  name="session"
                  value={key}
                  disabled={!!blocked}
                  checked={target === key}
                  onChange={() => setTarget(key)}
                />
                <AgentLogo agent={s.agent} logos={logos} size={26} />
                <span>
                  <strong>{s.title || agentLabel(s.agent)}</strong>
                  <small>
                    {blocked || (
                      <>
                        {agentLabel(s.agent)}
                        {s.cwd && ` · ${projectName(s.cwd)}`}
                        {s.status === "running" && " · Working"}
                      </>
                    )}
                  </small>
                </span>
                {target === key && <Check size={17} />}
              </label>
            );
          })}
        </div>
        <textarea
          rows={2}
          placeholder="Add a message (optional)"
          aria-label="Message"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && (
          <p className="files-send-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" disabled={!target || sending}>
          {sending ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Send size={16} />
          )}
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </dialog>
  );
}

// Share goes straight to the phone's share sheet; while the file is still being
// fetched it spins, and if the browser needs a fresh tap it says so.
function ShareChip({
  state,
  onShare,
  disabled = false,
}: {
  state: ReturnType<ReturnType<typeof useFileShare>["state"]>;
  onShare: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={state === "armed" ? "is-ready" : ""}
      disabled={disabled}
      onClick={onShare}
    >
      {state === "preparing" ? (
        <LoaderCircle size={16} className="spin" />
      ) : (
        <Share2 size={16} />
      )}
      {state === "armed" ? "Tap to share" : "Share"}
    </button>
  );
}

const isGone = (e: unknown) => (e as { status?: number })?.status === 404;
const MAX_IMAGE_PREVIEW = 25 * 1024 * 1024;
const MAX_PDF_PREVIEW = 50 * 1024 * 1024;
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
// Recently viewed images and PDFs, so reopening one doesn't download it again.
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
// A text file being edited: the draft, the text it started from (with "\n"
// endings, as a text box has them), the hash the save is checked against,
// and the line ending the file gets back.
type Edit = {
  draft: string;
  base: string;
  sha256: string;
  ending: "\n" | "\r\n";
};
// Unsaved edits of a preview that closed without Cancel (a back swipe,
// another page): opening the file again brings them back.
const unsaved = new Map<string, Edit>();
// Only a verified, already approved private handoff carries workspaceKey.
// Keep drafts on that workspace; a replacement credential starts a new one.
// Optional computerId metadata can arrive later during reconciliation; peer.id
// is the authenticated computer identity and remains stable during enrichment.
const editWorkspace = (peer: Peer) =>
  JSON.stringify([
    peer.id,
    peer.workspaceKey ||
      JSON.stringify([
        peer.id,
        peer.url,
        peer.token,
        peer.transport,
        peer.sessionId,
      ]),
  ]);

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
  unzip,
  sendToAgent,
  canEdit,
  saved,
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
  unzip?: () => void;
  sendToAgent?: () => void;
  canEdit: boolean;
  saved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const kind = fileKind(file);
  const mode = previewMode(file, peer.platform);
  const word = computerWord(peer.platform);
  const [text, setText] = useState(""),
    [sha256, setSha256] = useState(""),
    [image, setImage] = useState(""),
    [pdf, setPdf] = useState<Blob | null>(null),
    [source, setSource] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [loads, setLoads] = useState(0),
    [copied, setCopied] = useState(false),
    [target, setTarget] = useState(""),
    [sendError, setSendError] = useState(""),
    [sending, setSending] = useState(false),
    [shown, setShown] = useState({ size: file.size, modified: file.modified }),
    [editableAs, setEditableAs] = useState<Editable | null>(null),
    [edit, setEdit] = useState<Edit | null>(null),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(""),
    [conflict, setConflict] = useState(false);
  const dirty = !!edit && edit.draft !== edit.base;
  const draftKey = JSON.stringify([editWorkspace(peer), root, file.path]);
  const editing = useRef(edit);
  editing.current = edit;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  // Closed with unsaved edits, by anything but Cancel or a confirmed close.
  useEffect(
    () => () => {
      const left = editing.current;
      if (left && left.draft !== left.base) unsaved.set(draftKey, left);
    },
    [draftKey],
  );
  // Closing the page asks first while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);
  // Whether the text read can go back exactly (file-edit.ts), worked out
  // before Edit is tapped so the editor opens within the tap.
  useEffect(() => {
    setEditableAs(null);
    if (!canEdit || mode !== "text" || loading || error || !sha256) return;
    let live = true;
    void editable(text, sha256).then((answer) => live && setEditableAs(answer));
    return () => {
      live = false;
    };
  }, [canEdit, mode, loading, error, text, sha256]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  // Images and PDFs are shared from the copy fetched for the preview, not a
  // second one.
  useEffect(() => {
    // Text the preview endpoint refuses (over 1 MB) isn't worth a 20 MB copy.
    if (mode === "image" || mode === "pdf") return;
    if ((mode === "text" || mode === "document") && file.size > 1024 * 1024)
      return;
    sharer.warm(file);
  }, [peer.url, peer.token, root, file.path, file.modified, file.size, mode]);
  // The write happens inside the tap: phones refuse clipboard writes after it.
  const copy = (value = text) => {
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = value;
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
    navigator.clipboard.writeText(value).then(() => setCopied(true), fallback);
  };
  const shareState = sharer.state(file);
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setText("");
    setSha256("");
    setImage("");
    setPdf(null);
    setSource(false);
    setError("");
    setLoading(true);
    setShown({ size: file.size, modified: file.modified });
    setSaveError("");
    setConflict(false);
    const maximum = mode === "pdf" ? MAX_PDF_PREVIEW : MAX_IMAGE_PREVIEW;
    const tooLarge = () =>
      new Error(
        `This ${nouns[kind] || "file"} is too large to preview. Download it instead.`,
      );
    (async () => {
      try {
        if (mode === "image" || mode === "pdf") {
          if (file.size > maximum) throw tooLarge();
          const key = JSON.stringify([
            peer.url,
            peer.token,
            root,
            file.path,
            file.modified,
            file.size,
          ]);
          let blob = viewed.get(key);
          if (!blob) {
            blob = await fileBlob(peer, file.path, root, {
              signal: controller.signal,
              maxBytes: maximum,
            });
          }
          // A response may settle after this preview closes, or the file can
          // grow since listing. Never create a leaked/stale object URL.
          if (controller.signal.aborted) return;
          if (blob.size > maximum) throw tooLarge();
          if (mode === "pdf" && (await blob.slice(0, 5).text()) !== "%PDF-")
            throw new Error("This file is not a PDF. Download it instead.");
          if (controller.signal.aborted) return;
          remember(key, blob);
          sharer.warm(file, blob);
          if (mode === "pdf") setPdf(blob);
          else {
            url = URL.createObjectURL(
              new Blob([blob], { type: imageType(file.name) }),
            );
            setImage(url);
          }
        } else if (mode === "text" || mode === "document") {
          const r = await request(
            peer,
            `/api/files/${mode === "text" ? "text" : "document-text"}?${new URLSearchParams({ root: String(root), path: file.path })}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          setText(r.text);
          // Only /api/files/text's answer can be written back.
          if (mode === "text") setSha256(r.sha256 || "");
          const kept = unsaved.get(draftKey);
          if (kept && canEdit && mode === "text") {
            unsaved.delete(draftKey);
            setEdit(kept);
            toast("Your unsaved changes are back.");
          }
        } else
          throw new Error(`Download to open this ${nouns[kind] || "file"}.`);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (isGone(e)) return gone();
        setError(
          (e as { status?: number }).status === 413
            ? tooLarge().message
            : (e as Error).message,
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [
    peer.url,
    peer.token,
    root,
    file.path,
    file.name,
    file.modified,
    file.size,
    mode,
    loads,
  ]);
  const startEdit = () => {
    if (!editableAs) return;
    if ("problem" in editableAs) return toast(editableAs.problem);
    const base = forEditing(text);
    setSaveError("");
    setConflict(false);
    setEdit({ draft: base, base, sha256, ending: editableAs.ending });
  };
  const discard = () =>
    !dirty || confirm(`Discard your changes to ${file.name}?`);
  const stopEditing = () => {
    if (!discard()) return;
    editing.current = null;
    setEdit(null);
    setSaveError("");
    setConflict(false);
  };
  // Every way out of the preview: the chevron, Escape, Android's back, a tap
  // outside it. A save still under way keeps its draft for next time.
  const leave = () => {
    if (!saving) {
      if (!discard()) return;
      editing.current = null;
    }
    close();
  };
  // The file as it is now, after a conflict: what was typed is set aside.
  const reload = () => {
    if (!discard()) return;
    editing.current = null;
    setEdit(null);
    setLoads((n) => n + 1);
  };
  const save = async () => {
    if (!edit || saving) return;
    const sent = forSaving(edit.draft, edit.ending);
    if (byteLength(sent) > EDIT_LIMIT)
      return setSaveError(
        "Reach saves text files up to 128 KB. Shorten the text, or download the file to edit it.",
      );
    const where = `/api/files/text?${new URLSearchParams({ root: String(root), path: file.path })}`;
    const done = (hash: string) => {
      // This preview may have closed while its save was in flight. A reopened
      // preview can already have kept a newer draft under the same key.
      if (unsaved.get(draftKey) === edit) unsaved.delete(draftKey);
      editing.current = null;
      setText(sent);
      setSha256(hash);
      setEdit(null);
      setShown({ size: byteLength(sent), modified: new Date().toISOString() });
      saved();
      toast(`Saved ${file.name}`);
    };
    setSaving(true);
    setSaveError("");
    setConflict(false);
    try {
      // Sent once per tap, never again by itself: a save whose answer is lost
      // may still have been written.
      const r = await request<{ sha256: string }>(peer, where, {
        method: "PUT",
        body: JSON.stringify({ text: sent, sha256: edit.sha256 }),
      });
      done(r.sha256);
    } catch (e) {
      let failure = e as Error & { status?: number };
      if (failure.status === 409) {
        // The file isn't the one the edit started from. It may hold this
        // very text (an earlier save whose answer was lost): then it's
        // saved. Otherwise someone else changed it: never written over.
        try {
          const now = await request<{ text: string; sha256: string }>(
            peer,
            where,
          );
          if (now.text === sent && now.sha256) return done(now.sha256);
          return setConflict(true);
        } catch (again) {
          failure = again as typeof failure;
          if (failure.status !== 404)
            return setSaveError(
              `Couldn’t check the file on your ${word}. Try saving again.`,
            );
        }
      }
      setSaveError(
        failure.status === 413
          ? "Reach saves text files up to 128 KB. Shorten the text, or download the file to edit it."
          : failure.status === 404
            ? `This file was moved or deleted on your ${word}. Copy your text to keep it.`
            : failure.message,
      );
    } finally {
      setSaving(false);
    }
  };
  const others = peers.filter((p) => p.id !== peer.id);
  return (
    <dialog
      ref={dialog}
      className="file-viewer"
      aria-label={file.name}
      onCancel={(e) => {
        e.preventDefault();
        leave();
      }}
      // Closed by the browser itself (Android's back pressed again, which
      // the page can't stop): the preview goes too, keeping any draft. Not
      // a close it has since reopened from (StrictMode's second mount).
      onClose={() => !dialog.current?.open && close()}
      onClick={(e) => e.target === e.currentTarget && leave()}
    >
      <div className="file-viewer-inner">
        <header>
          <button
            className="files-tool"
            aria-label="Close preview"
            onClick={leave}
          >
            <ChevronLeft size={24} />
          </button>
          <div className="file-viewer-title">
            <strong>{file.name}</strong>
            <small>
              {edit
                ? saving
                  ? "Saving…"
                  : dirty
                    ? "Unsaved changes"
                    : "Editing"
                : `${bytes(shown.size)} · ${friendlyDate(shown.modified)}`}
            </small>
          </div>
          {edit ? (
            <>
              <button
                className="files-tool files-select-tool"
                disabled={saving}
                onClick={stopEditing}
              >
                Cancel
              </button>
              <button
                className="files-tool files-select-tool is-primary"
                disabled={!dirty || saving}
                onClick={save}
              >
                {saving && <LoaderCircle size={15} className="spin" />}
                Save
              </button>
            </>
          ) : (
            <>
              {canEdit && mode === "text" && !loading && !error && sha256 && (
                <button
                  className="files-tool"
                  aria-label={`Edit ${file.name}`}
                  disabled={!editableAs}
                  onClick={startEdit}
                >
                  <Pencil size={18} />
                </button>
              )}
              {!loading && !error && !image && !pdf && text && (
                <button
                  className={`files-tool ${copied ? "is-done" : ""}`}
                  aria-label={copied ? "Copied" : "Copy text"}
                  onClick={() => copy()}
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
                    <LoaderCircle size={18} className="spin" />
                  ) : (
                    <Share2 size={19} />
                  )}
                </button>
              )}
              {sendToAgent && (
                <button
                  className="files-tool"
                  aria-label={`Send ${file.name} to an agent`}
                  onClick={sendToAgent}
                >
                  <SendHorizontal size={19} />
                </button>
              )}
              <button
                className="files-tool"
                aria-label={`Download ${file.name}`}
                onClick={download}
              >
                <Download size={19} />
              </button>
            </>
          )}
        </header>
        {edit && (conflict || saveError) && (
          <div className="file-editor-note" role="alert">
            <p>
              {conflict
                ? `This file changed on your ${word} since you started editing. Copy your text, then reload to edit the new version.`
                : saveError}
            </p>
            <button
              className="button secondary small"
              onClick={() => copy(edit.draft)}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy my text"}
            </button>
            {conflict && (
              <button className="button secondary small" onClick={reload}>
                <RefreshCw size={15} /> Reload
              </button>
            )}
          </div>
        )}
        {!edit && !loading && !error && text && isMarkdown(file.name) && (
          <div
            className="file-format-toolbar"
            role="group"
            aria-label="Markdown view"
          >
            <button
              aria-label="Show formatted"
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              <Eye size={16} /> Formatted
            </button>
            <button
              aria-label="Show source"
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              <CodeXml size={16} /> Source
            </button>
          </div>
        )}
        <div
          className={`file-viewer-body ${image ? "is-image" : ""} ${pdf ? "is-pdf" : ""} ${mode === "document" ? "is-document" : ""}`}
        >
          {loading ? (
            <LoaderCircle className="spin" size={24} aria-label="Loading preview" />
          ) : error ? (
            <div className="file-viewer-empty">
              <KindIcon entry={file} native={icon} size={30} />
              <p>{unzip ? "Unzip it here, or download it." : error}</p>
              {unzip && (
                <button className="button primary small" onClick={unzip}>
                  <FolderInput size={15} /> Unzip
                </button>
              )}
              <button
                className={`button ${unzip ? "secondary" : "primary"} small`}
                onClick={download}
              >
                <Download size={15} /> Download
              </button>
            </div>
          ) : edit ? (
            <textarea
              className="file-editor"
              aria-label={`${file.name} text`}
              value={edit.draft}
              readOnly={saving}
              onChange={(e) => {
                const draft = e.target.value;
                setEdit((now) => now && { ...now, draft });
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
            />
          ) : image ? (
            <img src={image} alt={file.name} />
          ) : pdf ? (
            <Suspense
              fallback={
                <LoaderCircle
                  className="spin"
                  size={24}
                  aria-label="Loading PDF preview"
                />
              }
            >
              <FilePdf blob={pdf} name={file.name} />
            </Suspense>
          ) : text && (isMarkdown(file.name) || kind === "code") ? (
            <Suspense
              fallback={
                <LoaderCircle
                  className="spin"
                  size={24}
                  aria-label="Loading text preview"
                />
              }
            >
              {isMarkdown(file.name) && !source ? (
                <FileMarkdown text={text} />
              ) : (
                <FileCode text={text} name={file.name} />
              )}
            </Suspense>
          ) : (
            <pre>{text || "(Empty file)"}</pre>
          )}
        </div>
        {others.length > 0 && !edit && (
          <footer className="file-viewer-send">
            <select
              aria-label="Destination computer"
              value={target}
              onChange={(e) => { setTarget(e.target.value); setSendError(""); }}
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
                setSendError("");
                try {
                  const dest = peers.find((p) => p.id === target)!;
                  // Progress, resume and errors show in the transfer tray.
                  await sendToComputer(peer, root, file, dest);
                  toast(`Sent to ${dest.name}’s shared folder`);
                } catch (e) {
                  if (sourceFileGone(e)) gone();
                  else if ((e as Error).name !== "AbortError")
                    setSendError(`Couldn’t send to ${peers.find((p) => p.id === target)?.name || "that computer"}. ${(e as Error).message}`);
                } finally {
                  setSending(false);
                }
              }}
            >
              <Send size={15} />
              {sending ? "Sending…" : "Send"}
            </button>
            {sendError && <p className="file-viewer-send-error" role="alert">{sendError}</p>}
          </footer>
        )}
      </div>
    </dialog>
  );
}
