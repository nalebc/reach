import { useEffect, useState } from "react";
import { Check, ChevronRight, Folder, HardDrive, X } from "lucide-react";
import { request, type Device, type Peer } from "./api";

// Choose folders to share by browsing the computer: go into any folder, share
// it, or share a folder straight from the list. The computer checks every
// chosen folder again when the invitation is made.

export type PickedFolder = {
  root: number;
  path: string;
  label: string;
  full: string;
};
type Entry = { name: string; path: string; type: string };
const join = (base: string, rel: string) =>
  rel ? `${base.replace(/\/$/, "")}/${rel}` : base;
const homeFolder = (folder: string) =>
  /^\/(Users|home)\/[^/]+\/?$|^[A-Za-z]:\\Users\\[^\\]+\\?$/.test(folder);

// One folder for a new chat: start in Home, go into any folder, use the one
// you're in. onNavigate selects each opened folder immediately for new chats;
// other callers can keep the explicit Use action. New chats start only inside
// Home (server/index.mjs sessionFolder).
export function FolderPicker(props: Parameters<typeof FolderPickerSession>[0]) {
  const { peer } = props;
  return <FolderPickerSession key={JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId])} {...props} />;
}

function FolderPickerSession({
  peer,
  onPick,
  onNavigate,
}: {
  peer: Peer;
  onPick: (full: string) => void;
  onNavigate?: (full: string) => void;
}) {
  const [home, setHome] = useState<{ id: number; path: string } | null>(null);
  const [path, setPath] = useState("");
  const [items, setItems] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    request<Device>(peer, "/api/device")
      .then((d) => {
        const roots = d.roots || [];
        const root = roots.find((r) => r.name === "Home") || roots[0];
        if (!live) return;
        if (root) setHome({ id: root.id, path: root.path });
        else {
          setError("No folders to show.");
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!live) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [peer.url, peer.token]);
  useEffect(() => {
    if (!home) return;
    let live = true;
    setLoading(true);
    setError("");
    request<{ items: Entry[] }>(
      peer,
      `/api/files?${new URLSearchParams({ root: String(home.id), path })}`,
    )
      .then((r) => {
        if (live)
          setItems(
            (r.items || []).filter(
              (i) => i.type === "directory" && !i.name.startsWith("."),
            ),
          );
      })
      .catch((e) => {
        if (live) {
          setItems([]);
          setError((e as Error).message);
        }
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, home?.id, path]);
  const parts = path.split("/").filter(Boolean);
  const here = parts.at(-1) || "Home";
  const navigate = (next: string) => {
    setPath(next);
    if (home) onNavigate?.(join(home.path, next));
  };
  return (
    <div className="folder-pick">
      <nav className="folder-pick-crumbs" aria-label="Path">
        <button
          type="button"
          aria-current={!parts.length ? "location" : undefined}
          onClick={() => navigate("")}
        >
          Home
        </button>
        {parts.map((part, i) => (
          <span key={i}>
            <ChevronRight size={12} />
            <button
              type="button"
              aria-current={i === parts.length - 1 ? "location" : undefined}
              onClick={() => navigate(parts.slice(0, i + 1).join("/"))}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      <div className="folder-pick-list" role="list" aria-busy={loading}>
        {error ? (
          <p className="folder-pick-empty">{error}</p>
        ) : loading ? (
          <p className="folder-pick-empty">Loading…</p>
        ) : !items.length ? (
          <p className="folder-pick-empty">No folders inside.</p>
        ) : (
          items.map((i) => (
            <button
              type="button"
              role="listitem"
              key={i.path}
              aria-label={`Open ${i.name}`}
              onClick={() => navigate(i.path)}
            >
              <Folder size={15} />
              <span>{i.name}</span>
              <ChevronRight size={14} />
            </button>
          ))
        )}
      </div>
      {!onNavigate && <button
        type="button"
        className="folder-pick-use"
        disabled={!home || loading || !!error}
        onClick={() => home && onPick(join(home.path, path))}
      >
        <Check size={14} /> Use “{here}”
      </button>}
    </div>
  );
}

export function FolderBrowser({
  peer,
  device,
  picked,
  onChange,
}: {
  peer: Peer;
  device?: Device;
  picked: PickedFolder[];
  onChange: (next: PickedFolder[]) => void;
}) {
  // Where you are: null lists the computer's shared locations.
  const [at, setAt] = useState<{ root: number; path: string } | null>(null);
  const [items, setItems] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!at) return;
    let live = true;
    setLoading(true);
    setError("");
    request<{ items: Entry[] }>(
      peer,
      `/api/files?${new URLSearchParams({ root: String(at.root), path: at.path })}`,
    )
      .then((r) => {
        if (live)
          setItems((r.items || []).filter((i) => i.type === "directory"));
      })
      .catch((e) => {
        if (live) {
          setItems([]);
          setError((e as Error).message);
        }
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, at?.root, at?.path]);

  const roots = (device?.roots || []).map((root) => ({
    ...root,
    name: root.path === "/" || /^[A-Za-z]:[\\/]$/.test(root.path) ? "Root" : root.name,
  }));
  // Hide shortcuts already reachable inside another root. Keep the original
  // IDs: existing selections and server permission checks use those IDs.
  const normalized = (value: string) => {
    const windows = /^[A-Za-z]:[\\/]/.test(value);
    const full = (windows ? value.replaceAll("\\", "/").toLowerCase() : value).replace(/\/$/, "");
    return full + "/";
  };
  const visibleRoots = roots.filter((root, index) => !roots.some((other, otherIndex) =>
    otherIndex !== index && normalized(root.path).startsWith(normalized(other.path)) &&
    (normalized(root.path) !== normalized(other.path) || otherIndex < index),
  ));
  const rootOf = (id: number) => roots.find((r) => r.id === id);
  const folder = (root: number, path: string): PickedFolder => {
    const r = rootOf(root);
    return {
      root,
      path,
      label: path ? path.split("/").at(-1)! : r?.name || "Folder",
      full: join(r?.path || "", path),
    };
  };
  const isPicked = (root: number, path: string) =>
    picked.some((f) => f.root === root && f.path === path);
  const toggle = (root: number, path: string) =>
    onChange(
      isPicked(root, path)
        ? picked.filter((f) => !(f.root === root && f.path === path))
        : [...picked, folder(root, path)],
    );
  const crumbs = at
    ? [
        { label: rootOf(at.root)?.name || "Folder", path: "" },
        ...at.path
          .split("/")
          .filter(Boolean)
          .map((part, i, all) => ({
            label: part,
            path: all.slice(0, i + 1).join("/"),
          })),
      ]
    : [];
  const here = at ? crumbs.at(-1)!.label : "";
  const row = (
    key: string,
    label: string,
    detail: string,
    root: number,
    path: string,
    icon = <Folder size={17} />,
  ) => (
    <div className="fb-row" key={key} role="listitem">
      <button
        type="button"
        className={`fb-pick ${isPicked(root, path) ? "on" : ""}`}
        role="checkbox"
        aria-checked={isPicked(root, path)}
        aria-label={`Share ${label}`}
        onClick={() => toggle(root, path)}
      >
        {isPicked(root, path) && <Check size={13} />}
      </button>
      <button
        type="button"
        className="fb-open"
        aria-label={`Open ${label}`}
        onClick={() => setAt({ root, path })}
      >
        {icon}
        <span>
          <strong>{label}</strong>
          {detail && <small>{detail}</small>}
        </span>
        <ChevronRight size={16} />
      </button>
    </div>
  );

  return (
    <div className="fb">
      {picked.length > 0 && (
        <div className="fb-chips" aria-label="Shared folders">
          {picked.map((f) => (
            <span
              className="fb-chip"
              key={`${f.root}:${f.path}`}
              title={f.full}
            >
              <Folder size={13} />
              {f.label}
              <button
                type="button"
                aria-label={`Stop sharing ${f.label}`}
                onClick={() => toggle(f.root, f.path)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {picked.some((f) => !f.path && homeFolder(f.full)) && (
        <small className="ivt-warn">
          That’s a whole home folder. A folder inside it is safer.
        </small>
      )}
      <nav className="fb-crumbs" aria-label="Path">
        <button type="button" onClick={() => setAt(null)}>
          <HardDrive size={14} /> {device?.name || "Computer"}
        </button>
        {crumbs.map((c, i) => (
          <span key={c.path || "root"}>
            <ChevronRight size={13} />
            <button
              type="button"
              aria-current={i === crumbs.length - 1 ? "location" : undefined}
              onClick={() => at && setAt({ root: at.root, path: c.path })}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>
      {at && (
        <button
          type="button"
          className={`fb-share ${isPicked(at.root, at.path) ? "on" : ""}`}
          onClick={() => toggle(at.root, at.path)}
        >
          {isPicked(at.root, at.path) ? (
            <>
              <Check size={15} /> Sharing {here}
            </>
          ) : (
            `Share “${here}”`
          )}
        </button>
      )}
      <div className="fb-list" role="list" aria-busy={loading}>
        {!at ? (
          visibleRoots.map((r) =>
            row(`r${r.id}`, r.name, r.path, r.id, "", <HardDrive size={17} />),
          )
        ) : error ? (
          <p className="fb-empty">{error}</p>
        ) : loading ? (
          <p className="fb-empty">Loading…</p>
        ) : !items.length ? (
          <p className="fb-empty">No folders inside.</p>
        ) : (
          items.map((i) => row(i.path, i.name, "", at.root, i.path))
        )}
      </div>
    </div>
  );
}
