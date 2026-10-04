import {
  workspaceCapabilities,
  type WorkspaceCapabilities,
} from "./capabilities";
import { useEffect, useState, useRef } from "react";
import { isNative, saveBlob } from "./native";
import ScreenPopup from "./ScreenPopup";
import FileShare from "./FileShare";
import {
  Download,
  Plus,
  Share2,
  Upload,
  FolderPlus,
  FileText,
  Image,
  File,
  Search,
  Home,
  MoreHorizontal,
  Send,
  ArrowLeft,
  RefreshCw,
  Eye,
  FolderOpen,
  Check,
  ChevronDown,
} from "lucide-react";
import { Peer, Device, FileEntry, request, post, fileBlob, bytes } from "./api";
import {
  PageTitle,
  Folder,
  Terminal,
  MessageSquare,
  Modal,
  Spinner,
  Empty,
  ErrorLine,
  ChevronRight,
} from "./ui";
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
    [entries, setEntries] = useState<FileEntry[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [hidden, setHidden] = useState(false),
    [preview, setPreview] = useState<FileEntry | null>(null),
    [sharing, setSharing] = useState<FileEntry | null>(null),
    [addMenu, setAddMenu] = useState(false),
    [folder, setFolder] = useState(false),
    [folderName, setFolderName] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    onLocationChange?.({ root, dir });
  }, [root, dir]);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [folderActions, setFolderActions] = useState(false);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  useEffect(() => {
    setFilter("all");
    setQuery("");
  }, [root, dir]);
  const features = suppliedFeatures || workspaceCapabilities(device);
  const canWrite = features.writeFiles;
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    request(
      peer,
      `/api/files?${new URLSearchParams({ root: String(root), path: dir, hidden: hidden ? "1" : "0" })}`,
    )
      .then((r) => {
        if (active) {
          if (!Array.isArray(r?.items))
            throw new Error("This folder couldn’t load. Try refreshing.");
          setEntries(r.items);
          if (r.truncated)
            toast(
              "Showing the first 2,000 entries. Open a folder to narrow the list.",
            );
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [peer.id, root, dir, hidden, revision]);
  const refresh = () => setRevision((n) => n + 1);
  const download = async (file: FileEntry) => {
    setBusy(true);
    try {
      const blob = await fileBlob(peer, file.path, root);
      await saveBlob(blob, file.name);
      if (!isNative) toast(`Downloaded ${file.name}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        await request(
          peer,
          `/api/files/upload?${new URLSearchParams({ root: String(root), path: dir })}`,
          { method: "POST", body: form },
        );
      }
      toast("Upload complete");
      refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  };
  const shown = entries
    .filter(
      (f) =>
        f.name.toLowerCase().includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "folders"
            ? f.type === "directory"
            : f.type !== "directory")),
    )
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return sort === "recent"
        ? Date.parse(b.modified) - Date.parse(a.modified)
        : a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          });
    });
  const rootName =
    device.roots.find((r) => r.id === root)?.name || "Shared folder";
  return (
    <div className="files-workspace">
      <PageTitle
        eyebrow={device.name}
        title={
          device.access?.kind === "guest" ? "Shared with you" : "Your files"
        }
        description={
          device.access?.kind === "guest"
            ? `Files shared from ${device.name}.`
            : "Right where you left them."
        }
      >
        {canWrite && (
          <>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => setAddMenu(true)}
              aria-haspopup="dialog"
            >
              <Plus size={18} />
              {busy ? "Transferring…" : "Add files"}
            </button>
            <input
              ref={upload}
              type="file"
              multiple
              hidden
              onChange={(e) => uploadFiles(e.target.files)}
            />
          </>
        )}
      </PageTitle>
      <div className="files-browser-head">
        <button
          className="folder-location-button"
          onClick={() => setLocationsOpen(true)}
          aria-haspopup="dialog"
        >
          <FolderOpen size={18} />
          <span>{rootName}</span>
          <ChevronDown size={15} />
        </button>
        <div className="files-head-actions">
          <button
            className="icon-button"
            aria-label="Refresh files"
            onClick={refresh}
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Folder options"
            aria-haspopup="dialog"
            onClick={() => setFolderActions(true)}
          >
            <MoreHorizontal size={22} />
          </button>
        </div>
      </div>
      <label className="files-search-field">
        <Search size={19} />
        <input
          aria-label="Search this folder"
          placeholder="Search this folder"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </label>
      <div className="files-filter-bar" aria-label="Filter files">
        {[
          ["all", "All"],
          ["folders", "Folders"],
          ["files", "Files"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
        <span>
          {shown.length} {shown.length === 1 ? "item" : "items"}
        </span>
      </div>
      <section className="panel file-panel">
        {dir && (
          <nav
            className="breadcrumbs file-breadcrumbs"
            aria-label="Folder path"
          >
            <button onClick={() => setDir("")}>{rootName}</button>
            {dir
              .split("/")
              .filter(Boolean)
              .map((part, i, parts) => (
                <span key={i}>
                  <ChevronRight size={13} />
                  <button
                    onClick={() => setDir(parts.slice(0, i + 1).join("/"))}
                  >
                    {part}
                  </button>
                </span>
              ))}
          </nav>
        )}
        <ErrorLine error={error} />
        {loading ? (
          <Spinner />
        ) : (
          !error && (
            <>
              <div className="file-heading">
                <span>Name</span>
                <span>Modified</span>
                <span>Size</span>
                <span />
              </div>
              {dir && (
                <button
                  className="file-row parent"
                  onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))}
                >
                  <span>
                    <ArrowLeft size={19} />
                    Parent folder
                  </span>
                </button>
              )}
              {shown.map((file) => (
                <div className="file-row" key={file.path}>
                  <button
                    className="file-name"
                    onClick={() =>
                      file.type === "directory"
                        ? (setDir(file.path), setQuery(""))
                        : setPreview(file)
                    }
                  >
                    <span
                      className={`file-icon ${file.type === "directory" ? "folder-icon" : ""}`}
                    >
                      {file.type === "directory" ? (
                        <Folder size={21} />
                      ) : /\.(png|jpg|jpeg|gif|webp)$/i.test(file.name) ? (
                        <Image size={21} />
                      ) : (
                        <FileText size={21} />
                      )}
                    </span>
                    <span className="file-label">
                      <strong>{file.name}</strong>
                      <small>
                        {file.type === "directory"
                          ? "Folder"
                          : bytes(file.size)}{" "}
                        ·{" "}
                        {new Date(file.modified).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </small>
                    </span>
                  </button>
                  <span className="muted file-date">
                    {new Date(file.modified).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span className="muted file-size">
                    {file.type === "directory" ? "—" : bytes(file.size)}
                  </span>
                  <button
                    className="icon-button"
                    aria-label={
                      file.type === "directory"
                        ? `Open ${file.name}`
                        : `Share ${file.name}`
                    }
                    disabled={busy}
                    onClick={() =>
                      file.type === "directory"
                        ? setDir(file.path)
                        : setSharing(file)
                    }
                  >
                    {file.type === "directory" ? (
                      <ChevronRight size={16} />
                    ) : (
                      <Share2 size={18} />
                    )}
                  </button>
                </div>
              ))}
              {!shown.length && (
                <Empty
                  title={
                    query
                      ? "No matching files"
                      : filter === "folders"
                        ? "No folders here"
                        : filter === "files"
                          ? "No files here"
                          : "This folder is empty"
                  }
                >
                  {query
                    ? "Try a different name or clear your search."
                    : filter !== "all"
                      ? "Choose All to see everything in this folder."
                      : canWrite
                        ? "Add files from this device to get started."
                        : "There are no files in this folder yet."}
                </Empty>
              )}
            </>
          )
        )}
      </section>
      {locationsOpen && (
        <ScreenPopup
          title="Browse locations"
          onClose={() => setLocationsOpen(false)}
        >
          <p className="sheet-description">
            Folders available on {device.name}.
          </p>
          <div className="action-rows">
            {device.roots.map((r) => (
              <button
                key={r.id}
                aria-pressed={root === r.id}
                onClick={() => {
                  setRoot(r.id);
                  setDir("");
                  setQuery("");
                  setFilter("all");
                  setLocationsOpen(false);
                }}
              >
                <Folder size={21} />
                <span>
                  <strong>{r.name}</strong>
                  <small>
                    {device.access?.kind === "guest"
                      ? "Shared with you"
                      : "On your computer"}
                  </small>
                </span>
                {root === r.id && <Check size={18} />}
              </button>
            ))}
          </div>
        </ScreenPopup>
      )}
      {folderActions && (
        <ScreenPopup
          title="Folder options"
          onClose={() => setFolderActions(false)}
        >
          <p className="sheet-description">{dir || rootName}</p>
          <div className="settings-inline-row">
            <label htmlFor="files-sort">Sort files</label>
            <select
              id="files-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="name">Name</option>
              <option value="recent">Recently modified</option>
            </select>
          </div>
          <label className="settings-inline-row">
            <span>Show hidden files</span>
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => setHidden(e.target.checked)}
            />
          </label>
          <div className="action-rows">
            {features.terminal && (
              <button
                onClick={() => {
                  setFolderActions(false);
                  onSession("terminal", dir, root);
                }}
              >
                <Terminal size={21} />
                <span>
                  <strong>Open terminal here</strong>
                  <small>Work in this folder</small>
                </span>
                <ChevronRight size={16} />
              </button>
            )}
            {features.codex && (
              <button
                onClick={() => {
                  setFolderActions(false);
                  onSession("chat", dir, root);
                }}
              >
                <MessageSquare size={21} />
                <span>
                  <strong>Ask Codex about this folder</strong>
                  <small>Start a conversation on your computer</small>
                </span>
                <ChevronRight size={16} />
              </button>
            )}
          </div>
        </ScreenPopup>
      )}
      {addMenu && (
        <ScreenPopup
          title="Add to this folder"
          onClose={() => setAddMenu(false)}
        >
          <div className="mobile-workspace-options">
            <button
              onClick={() => {
                upload.current?.click();
                setAddMenu(false);
              }}
            >
              <Upload size={21} />
              <span>Upload from this device</span>
            </button>
            <button
              onClick={() => {
                setAddMenu(false);
                setFolder(true);
              }}
            >
              <FolderPlus size={21} />
              <span>New folder</span>
            </button>
          </div>
        </ScreenPopup>
      )}
      {folder && (
        <Modal title="New folder" onClose={() => setFolder(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post(peer, "/api/files/folder", {
                  root,
                  path: dir,
                  name: folderName,
                });
                setFolder(false);
                setFolderName("");
                refresh();
              } catch (e) {
                toast((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Folder name
              <input
                autoFocus
                required
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
              />
            </label>
            <button className="button primary full" disabled={busy}>
              Create folder
            </button>
          </form>
        </Modal>
      )}
      {sharing && (
        <FileShare
          peer={peer}
          entry={sharing}
          root={root}
          close={() => setSharing(null)}
          download={() => download(sharing)}
        />
      )}
      {preview && (
        <Preview
          peer={peer}
          peers={peers}
          file={preview}
          root={root}
          download={() => download(preview)}
          share={() => {
            setSharing(preview);
            setPreview(null);
          }}
          toast={toast}
          close={() => setPreview(null)}
        />
      )}
    </div>
  );
}
function Preview({
  peer,
  peers,
  file,
  root,
  download,
  share,
  toast,
  close,
}: {
  peer: Peer;
  peers: Peer[];
  file: FileEntry;
  root: number;
  download: () => void;
  share: () => void;
  toast: (s: string) => void;
  close: () => void;
}) {
  const [text, setText] = useState(""),
    [image, setImage] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [target, setTarget] = useState(""),
    [sending, setSending] = useState(false);
  useEffect(() => {
    let active = true,
      url = "";
    (async () => {
      try {
        if (/\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
          const blob = await fileBlob(peer, file.path, root);
          url = URL.createObjectURL(
            new Blob([blob], {
              type: /\.png$/i.test(file.name)
                ? "image/png"
                : /\.gif$/i.test(file.name)
                  ? "image/gif"
                  : /\.webp$/i.test(file.name)
                    ? "image/webp"
                    : "image/jpeg",
            }),
          );
          if (active) setImage(url);
        } else {
          const r = await request(
            peer,
            `/api/files/text?${new URLSearchParams({ root: String(root), path: file.path })}`,
          );
          if (active) setText(r.text);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.path]);
  return (
    <Modal title={file.name} wide onClose={close}>
      <div className="preview-meta">
        <span>
          {bytes(file.size)} · {new Date(file.modified).toLocaleDateString()}
        </span>
        <div className="preview-actions">
          <button className="button primary small" onClick={share}>
            <Share2 size={16} />
            Share
          </button>
          <button className="button secondary small" onClick={download}>
            <Download size={16} />
            Download
          </button>
        </div>
      </div>
      {loading ? (
        <Spinner />
      ) : error ? (
        <Empty icon={File} title="Download to open">
          {error}
        </Empty>
      ) : image ? (
        <img className="image-preview" src={image} alt={file.name} />
      ) : (
        <pre className="text-preview">{text || "(Empty file)"}</pre>
      )}
      {peers.length > 1 && (
        <div className="transfer-bar">
          <select
            aria-label="Destination computer"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Send to another computer…</option>
            {peers
              .filter((p) => p.id !== peer.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <button
            className="button secondary"
            disabled={!target || sending}
            onClick={async () => {
              setSending(true);
              try {
                const dest = peers.find((p) => p.id === target)!;
                const blob = await fileBlob(peer, file.path, root);
                const form = new FormData();
                form.append("file", blob, file.name);
                await request(dest, "/api/files/upload?root=0&path=", {
                  method: "POST",
                  body: form,
                });
                toast(`Sent to ${dest.name}’s shared folder`);
              } catch (e) {
                toast((e as Error).message);
              } finally {
                setSending(false);
              }
            }}
          >
            <Send size={16} />
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      )}
    </Modal>
  );
}
