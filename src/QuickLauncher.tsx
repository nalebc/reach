import { useEffect, useState } from "react";
import {
  Search,
  ArrowUpRight,
  LoaderCircle,
  Plus,
  Pencil,
  Trash,
  ArrowLeft,
} from "lucide-react";
import { request, post, type Peer } from "./api";
import { ErrorLine } from "./ui";
import ShortcutIcon from "./ShortcutIcon";
import {
  useShortcuts,
  shortcutsChanged,
  type Shortcut,
  type CustomShortcut,
} from "./shortcuts";
export default function QuickLauncher({
  peer,
  onDone,
}: {
  peer: Peer;
  onDone: (name: string) => void;
}) {
  const { items, loading, error: loadError } = useShortcuts(peer);
  const [custom, setCustom] = useState<CustomShortcut[]>([]),
    [query, setQuery] = useState(""),
    [browse, setBrowse] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [editor, setEditor] = useState<Partial<CustomShortcut> | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    request<CustomShortcut[]>(peer, "/api/apps/shortcuts/custom")
      .then((r) => {
        if (active) setCustom(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [peer.url, peer.token, revision]);
  const changed = () => {
    shortcutsChanged(peer);
    setRevision((n) => n + 1);
  };
  const run = async (a: Shortcut) => {
    setBusy(a.id);
    setError("");
    try {
      await post(peer, "/api/apps/shortcuts", { id: a.id });
      onDone(a.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const remove = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await request(
        peer,
        `/api/apps/shortcuts/custom/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const row = (a: Shortcut) => {
    return (
      <div className="quick-action-row" key={a.id}>
        <button
          className="quick-action"
          disabled={!!busy}
          onClick={() => void run(a)}
        >
          <span className={`quick-action-icon ${a.kind}`}>
            <ShortcutIcon peer={peer} shortcut={a} size={40} />
          </span>
          <span>
            <strong>{a.name}</strong>
            <small>{a.detail}</small>
          </span>
          {busy === a.id ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <ArrowUpRight size={17} />
          )}
        </button>
        {a.custom && (
          <div className="shortcut-edit-actions">
            <button
              className="icon-button"
              disabled={!!busy}
              aria-label={`Edit ${a.name}`}
              onClick={() => {
                setError("");
                setEditor(custom.find((c) => c.id === a.id) || null);
              }}
            >
              <Pencil size={15} />
            </button>
            <button
              className="icon-button"
              disabled={!!busy}
              aria-label={`Remove ${a.name}`}
              onClick={() => void remove(a.id)}
            >
              <Trash size={15} />
            </button>
          </div>
        )}
      </div>
    );
  };
  if (editor)
    return (
      <form
        className="shortcut-editor"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy("save");
          setError("");
          try {
            await post(peer, "/api/apps/shortcuts/custom", editor);
            changed();
            setEditor(null);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy("");
          }
        }}
      >
        <button
          type="button"
          className="button ghost small"
          disabled={!!busy}
          onClick={() => {
            setEditor(null);
            setError("");
          }}
        >
          <ArrowLeft size={15} /> All shortcuts
        </button>
        <h3>{editor.id ? "Edit shortcut" : "Create a shortcut"}</h3>
        <label>
          Name
          <input
            aria-label="Shortcut name"
            required
            maxLength={60}
            value={editor.name || ""}
            onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            placeholder="My workspace"
          />
        </label>
        <label>
          Opens
          <select
            aria-label="Shortcut type"
            value={editor.type}
            onChange={(e) =>
              setEditor({
                ...editor,
                type: e.target.value as "app" | "website" | "terminal",
              })
            }
          >
            <option value="app">An installed app</option>
            <option value="website">A website on this computer</option>
            <option value="terminal">A command in a new terminal</option>
          </select>
        </label>
        {editor.type === "terminal" ? (
          <>
            <label>
              Command
              <input
                aria-label="Command to run"
                required
                maxLength={2000}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="codex"
                value={editor.command || ""}
                onChange={(e) => setEditor({ ...editor, command: e.target.value })}
              />
            </label>
            <label>
              Folder
              <input
                aria-label="Folder to run the command in"
                maxLength={1024}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Projects/my-app (blank = your shared folder)"
                value={editor.path || ""}
                onChange={(e) =>
                  setEditor({ ...editor, root: 0, path: e.target.value })
                }
              />
            </label>
            <p className="screen-popup-hint">
              Opens a new terminal in that folder and runs the command, for
              example <code>codex</code>, <code>claude</code> or{" "}
              <code>npm run dev</code>.
            </p>
          </>
        ) : editor.type === "website" ? (
          <label>
            Website address
            <input
              aria-label="Shortcut website address"
              type="url"
              required
              maxLength={2048}
              placeholder="https://example.com"
              value={editor.url || ""}
              onChange={(e) => setEditor({ ...editor, url: e.target.value })}
            />
          </label>
        ) : (
          <label>
            App or action
            <select
              aria-label="Shortcut app"
              required
              value={editor.actionId || ""}
              onChange={(e) =>
                setEditor({ ...editor, actionId: e.target.value })
              }
            >
              <option value="">Choose an installed app…</option>
              {items
                .filter((a) => !a.custom)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <p className="screen-popup-hint">
          Saved on {peer.name}. Available on your paired devices.
        </p>
        <ErrorLine error={error} />
        <button className="button primary" disabled={!!busy}>
          {busy === "save" ? "Saving…" : "Save shortcut"}
        </button>
      </form>
    );
  const matches = (a: Shortcut) =>
    (a.name + " " + a.detail).toLowerCase().includes(query.toLowerCase());
  const suggested = items.filter((a) => a.suggested && !a.custom),
    saved = items.filter((a) => a.custom);
  return (
    <>
      <div className="shortcut-intro">
        <p className="screen-popup-hint">One tap. Opens on {peer.name}.</p>
        <button
          className="button secondary small"
          disabled={!!busy || loading}
          onClick={() => {
            setError("");
            setEditor({ name: "", type: "app" });
          }}
        >
          <Plus size={15} /> Add shortcut
        </button>
      </div>
      <label className="quick-search">
        <Search size={18} />
        <input
          placeholder="Find an app or shortcut…"
          aria-label="Find a shortcut"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <ErrorLine error={error || loadError} />
      {loading ? (
        <p role="status">Discovering installed apps…</p>
      ) : query ? (
        <div className="quick-actions">
          {items.filter(matches).map(row)}
          {!items.some(matches) && (
            <p>No matching shortcuts on this computer.</p>
          )}
        </div>
      ) : (
        <>
          {!!saved.length && (
            <section className="shortcut-group">
              <h3>Your shortcuts</h3>
              <div className="quick-actions">{saved.map(row)}</div>
            </section>
          )}
          {!!suggested.length && (
            <section className="shortcut-group">
              <h3>Ready to use</h3>
              <p>Only apps installed on this computer.</p>
              <div className="quick-actions">{suggested.map(row)}</div>
            </section>
          )}
          <button
            className="button secondary small shortcut-browse"
            aria-expanded={browse}
            onClick={() => setBrowse((v) => !v)}
          >
            {browse
              ? "Hide app list"
              : `Browse all ${items.filter((a) => !a.custom && a.id !== "codex-new").length} installed apps`}
          </button>
          {browse && (
            <div className="quick-actions">
              {items.filter((a) => !a.custom && a.id !== "codex-new").map(row)}
            </div>
          )}
          {!!custom.filter((c) => c.available === false).length && (
            <section className="shortcut-group">
              <h3>Unavailable shortcuts</h3>
              <p>
                These apps are no longer installed. Update or remove their saved
                shortcuts.
              </p>
              {custom
                .filter((c) => c.available === false)
                .map((c) => (
                  <div className="unavailable-shortcut" key={c.id}>
                    <span>{c.name}</span>
                    <button
                      className="icon-button"
                      aria-label={`Edit ${c.name}`}
                      disabled={!!busy}
                      onClick={() => setEditor(c)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${c.name}`}
                      disabled={!!busy}
                      onClick={() => void remove(c.id)}
                    >
                      <Trash size={15} />
                    </button>
                  </div>
                ))}
            </section>
          )}
        </>
      )}
    </>
  );
}
