import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  HardDrive,
  MessageCircle,
  Monitor,
  SquareTerminal,
} from "lucide-react";
import { post, request, type Device, type Peer, type Root, type Session } from "./api";
import { placeFolder } from "./FolderBrowser";
import { computerWord } from "./pause";
import { ErrorLine, Modal } from "./ui";

// New terminal (or New Codex chat): a small sheet. An optional name, the
// folder as one row (its short name, the full path quiet under it) and up to
// three recent folders one tap away, then Open. Tapping the folder row turns
// the sheet into a page of folders, as Files lists them: go into one, back
// up with the chevron, Use the one you're in; the choice comes back to the
// sheet with the name still typed. If a folder can't be listed, its path can
// be typed instead. The same request as ever: /api/terminals or /api/chats
// with { name, root, path }. Same on a Mac and a Windows PC.

type Place = { root: number; path: string };
type Entry = { name: string; path: string; type: string };

const parts = (path: string) => path.split(/[\\/]/).filter(Boolean);
const samePlace = (a: Place, b: Place) =>
  a.root === b.root && parts(a.path).join("/") === parts(b.path).join("/");

// A folder as the sheet shows it: its short name, and its full path the way
// the computer writes it (C:\Users\me\Projects on Windows).
export function folderView(roots: Root[], place: Place) {
  const root = roots.find((r) => r.id === place.root);
  const base = root?.path || "";
  const sep = base.includes("\\") ? "\\" : "/";
  const inside = parts(place.path);
  const full = inside.length
    ? base.replace(/[\\/]+$/, "") + sep + inside.join(sep)
    : base;
  return {
    name: inside.at(-1) || parts(base).at(-1) || root?.name || "Folder",
    full,
  };
}

// Folders terminals and chats were opened in from here, newest first.
const recentKey = (peer: Peer) => `reach.recent-folders:${peer.id}`;
export function recentFolders(peer: Peer): Place[] {
  try {
    const saved = JSON.parse(localStorage.getItem(recentKey(peer)) || "[]");
    return Array.isArray(saved)
      ? saved.filter(
          (p) => Number.isInteger(p?.root) && typeof p?.path === "string",
        )
      : [];
  } catch {
    return [];
  }
}
function keepRecent(peer: Peer, place: Place) {
  try {
    localStorage.setItem(
      recentKey(peer),
      JSON.stringify(
        [place, ...recentFolders(peer).filter((p) => !samePlace(p, place))].slice(0, 6),
      ),
    );
  } catch {}
}

// The folders inside one, hidden ones left out (as Files shows them).
function useFolders(peer: Peer, at: Place | null) {
  const key = at ? JSON.stringify([at.root, at.path]) : "";
  const [result, setResult] = useState<{
    key: string;
    items: Entry[];
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!at) return;
    let live = true;
    request<{ items: Entry[] }>(
      peer,
      `/api/files?${new URLSearchParams({ root: String(at.root), path: at.path })}`,
    )
      .then((r) => {
        if (live)
          setResult({
            key,
            items: (r.items || []).filter(
              (i) => i.type === "directory" && !i.name.startsWith("."),
            ),
            error: "",
          });
      })
      .catch((e) => {
        if (live)
          setResult({
            key,
            items: [],
            error: (e as Error).message || "This folder couldn’t load.",
          });
      });
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, key]);
  const shown = result?.key === key ? result : null;
  return {
    loading: !!at && !shown,
    items: shown?.items || [],
    error: shown?.error || "",
  };
}

export default function NewSessionSheet({
  kind,
  initialPath,
  initialRoot,
  peer,
  device,
  recent = [],
  close,
  created,
}: {
  kind: string;
  initialPath: string;
  initialRoot: number;
  peer: Peer;
  device: Device;
  /** Folders open terminals and chats work in, newest first (full paths). */
  recent?: string[];
  close: () => void;
  created: (s: Session) => void;
}) {
  const terminal = kind === "terminal";
  const title = terminal ? "New terminal" : "New Codex chat";
  const word = computerWord(peer.platform);
  const roots = device.roots;
  const [name, setName] = useState(""),
    [place, setPlace] = useState<Place>({ root: initialRoot, path: initialPath }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Where the folder page is: undefined while the sheet shows, null on the
  // list of shared folders, else inside one.
  const [browse, setBrowse] = useState<Place | null | undefined>(undefined);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [typed, setTyped] = useState("");
  const listing = useFolders(peer, browse ?? null);
  const formId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const folderRow = useRef<HTMLButtonElement>(null);

  // A few folders one tap away: where you opened terminals and chats
  // lately, where open ones work, where this sheet started, and Home.
  const initial = useMemo(() => ({ root: initialRoot, path: initialPath }), []);
  const quick = useMemo(() => {
    const home = roots.find((r) => r.name === "Home");
    const candidates: Place[] = [
      ...recentFolders(peer),
      ...recent.flatMap((cwd) => placeFolder(cwd, roots) || []),
      initial,
      ...(home ? [{ root: home.id, path: "" }] : []),
    ];
    const seen: Place[] = [];
    for (const p of candidates)
      if (roots.some((r) => r.id === p.root) && !seen.some((s) => samePlace(s, p)))
        seen.push(p);
    return seen;
  }, [peer.id, roots, recent.join("\n")]);
  const chips = quick.filter((p) => !samePlace(p, place)).slice(0, 3);
  const shown = folderView(roots, place);

  const go = (next: Place | null, way: "forward" | "back") => {
    setDirection(way);
    setBrowse(next);
    // A folder that can't be listed: its path, typed, relative to its
    // shared folder. Set with the page, so the field starts there when it
    // shows. Set once it showed (an effect), it replaced what a quick thumb
    // had already typed (Oct 14).
    setTyped(next ? parts(next.path).join("/") : "");
  };
  const leave = () => setBrowse(undefined);
  const parent = browse ? { root: browse.root, path: parts(browse.path).slice(0, -1).join("/") } : null;
  const back = () => {
    if (browse === null) return leave();
    if (browse && parts(browse.path).length) return go(parent, "back");
    if (browse && roots.length > 1) return go(null, "back");
    leave();
  };
  const backTo =
    browse && parts(browse.path).length
      ? folderView(roots, parent!).name
      : browse && roots.length > 1
        ? "Shared folders"
        : title;
  const chosen: Place | null = browse
    ? listing.error
      ? { root: browse.root, path: parts(typed).join("/") }
      : browse
    : null;
  const choose = () => {
    if (!chosen) return;
    setPlace(chosen);
    leave();
  };

  // Each page opens at its top; the sheet holds focus while rows change
  // under it, and the folder row has it again on the way back.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const dialog = anchor.current?.closest("dialog");
    if (!dialog) return;
    dialog.scrollTop = 0;
    if (browse === undefined) folderRow.current?.focus({ preventScroll: true });
    else if (!dialog.contains(document.activeElement))
      dialog.focus({ preventScroll: true });
  }, [browse === undefined ? "" : JSON.stringify(browse)]);

  const open = async () => {
    setBusy(true);
    setError("");
    try {
      const s = await post(peer, terminal ? "/api/terminals" : "/api/chats", {
        name: name.trim() || undefined,
        root: place.root,
        path: place.path,
      });
      keepRecent(peer, place);
      created(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (browse !== undefined) {
    const here = browse ? folderView(roots, browse) : null;
    const pick = chosen ? folderView(roots, chosen) : null;
    return (
      <Modal
        title={title}
        className="is-page"
        onClose={leave}
        heading={
          <span className="sheet-page-head">
            <button
              type="button"
              className="sheet-back"
              aria-label={`Back to ${backTo}`}
              onClick={back}
            >
              <ChevronLeft size={24} />
            </button>
            <span>{here ? here.name : "Shared folders"}</span>
          </span>
        }
        footer={
          <button
            type="button"
            className="button primary full"
            disabled={!pick}
            onClick={choose}
          >
            {pick ? `Use “${pick.name}”` : "Choose a folder"}
          </button>
        }
      >
        <div
          ref={anchor}
          key={JSON.stringify(browse)}
          className={`sheet-page is-${direction}`}
        >
          {!browse ? (
            <div className="gs-group" aria-label="Shared folders">
              {roots.map((r) => (
                <button
                  type="button"
                  className="gs-row"
                  key={r.id}
                  onClick={() => go({ root: r.id, path: "" }, "forward")}
                >
                  <HardDrive size={21} />
                  <span className="gs-label">
                    <span>{r.name}</span>
                    <small>{r.path}</small>
                  </span>
                  <ChevronRight className="gs-chevron" size={18} />
                </button>
              ))}
            </div>
          ) : listing.error ? (
            <>
              <ErrorLine error={listing.error} />
              <p className="sheet-note">
                Can’t list this folder on this {word}. Type its path instead.
              </p>
              <div className="gs-group sheet-typed">
                <label className="gs-row">
                  <Folder size={21} />
                  <input
                    aria-label="Folder path"
                    placeholder="Documents/my-project"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && choose()}
                  />
                </label>
              </div>
              <p className="sheet-line sheet-in">
                <HardDrive size={13} />
                <span>In {folderView(roots, { root: browse.root, path: "" }).full}</span>
              </p>
            </>
          ) : (
            <>
              <p className="sheet-line sheet-where" title={here!.full}>
                <span>{here!.full}</span>
              </p>
              <div className="gs-group" aria-label="Folders" aria-busy={listing.loading}>
                {listing.loading ? (
                  <div className="gs-row gs-note">Loading…</div>
                ) : !listing.items.length ? (
                  <div className="gs-row gs-note">No folders inside</div>
                ) : (
                  listing.items.map((i) => (
                    <button
                      type="button"
                      className="gs-row"
                      key={i.path}
                      onClick={() => go({ root: browse.root, path: i.path }, "forward")}
                    >
                      <Folder size={21} />
                      <span className="gs-label">{i.name}</span>
                      <ChevronRight className="gs-chevron" size={18} />
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      onClose={close}
      footer={
        <button
          type="submit"
          form={formId}
          className="button primary full"
          disabled={busy}
        >
          {busy ? "Opening…" : "Open"}
        </button>
      }
    >
      <div ref={anchor} className="new-session">
      <p className="sheet-line sheet-computer">
        <Monitor size={14} />
        <span>{device.name}</span>
      </p>
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void open();
        }}
      >
        <div className="gs-group">
          <label className="gs-row">
            {terminal ? <SquareTerminal size={21} /> : <MessageCircle size={21} />}
            <input
              aria-label="Name"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button
            type="button"
            ref={folderRow}
            className="gs-row sheet-folder"
            aria-label={`Folder: ${shown.name}, ${shown.full}`}
            disabled={busy}
            onClick={() => go(place, "forward")}
          >
            <Folder size={21} />
            <span className="gs-label">
              <span>{shown.name}</span>
              <small>{shown.full}</small>
            </span>
            <ChevronRight className="gs-chevron" size={18} />
          </button>
        </div>
        {chips.length > 0 && (
          <div className="sheet-chips" role="group" aria-label="Recent folders">
            {chips.map((p) => {
              const v = folderView(roots, p);
              return (
                <button
                  type="button"
                  className="sheet-chip"
                  key={`${p.root}:${p.path}`}
                  title={v.full}
                  disabled={busy}
                  onClick={() => setPlace(p)}
                >
                  <Folder size={15} />
                  <span>{v.name}</span>
                </button>
              );
            })}
          </div>
        )}
        {!terminal && (
          <p className="sheet-note">Needs Codex signed in on this {word}.</p>
        )}
        <ErrorLine error={error} />
      </form>
      </div>
    </Modal>
  );
}
