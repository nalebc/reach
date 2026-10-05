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

  const roots = device?.roots || [];
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
          roots.map((r) =>
            row(`r${r.id}`, r.name, r.path, r.id, "", <HardDrive size={17} />),
          )
        ) : error ? (
          <p className="fb-empty">{error}</p>
        ) : loading && !items.length ? (
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
