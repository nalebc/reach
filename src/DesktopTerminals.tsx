import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, ArrowUpRight, Square, Send } from "lucide-react";
import { Peer, request, post } from "./api";
import { Terminal, ErrorLine, Spinner } from "./ui";

export type MacTerminal = {
  id: string;
  name: string;
  provider: string;
  tty: string;
};
type Inventory = {
  sessions: MacTerminal[];
  providers: { id: string; name: string; running?: boolean; error?: string }[];
};
// Embedded: the Terminals page shows every terminal in one list. This
// component then keeps discovering open tabs (reported via onInventory) and
// shows only the selected tab's view.
export default function DesktopTerminals({
  peer,
  embedded = false,
  selectedId,
  onInventory,
}: {
  peer: Peer;
  embedded?: boolean;
  selectedId?: string;
  onInventory?: (sessions: MacTerminal[]) => void;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selected, setSelected] = useState("");
  const reported = useRef(onInventory);
  reported.current = onInventory;
  useEffect(() => {
    if (embedded) setSelected(selectedId || "");
  }, [embedded, selectedId]);
  useEffect(() => {
    if (inventory) reported.current?.(inventory.sessions);
  }, [inventory]);
  const [provider, setProvider] = useState("terminal");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewError, setViewError] = useState("");
  const [updated, setUpdated] = useState(false);
  const locked = useRef(false);
  const reading = useRef<Promise<unknown> | null>(null);
  const mounted = useRef(true);
  const screen = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const current = inventory?.sessions.find((s) => s.id === selected);
  const reload = async (preferNew = false) => {
    const next = await request<Inventory>(peer, "/api/terminals/desktop");
    if (!mounted.current) return;
    setInventory(next);
    // In the shared list, the Terminals page owns the selection.
    if (embedded) return;
    const added =
      preferNew &&
      next.sessions.find(
        (s) => !inventory?.sessions.some((old) => old.id === s.id),
      );
    setSelected((id) =>
      added
        ? added.id
        : next.sessions.some((s) => s.id === id)
          ? id
          : next.sessions[0]?.id || "",
    );
  };
  const operate = async (fn: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      // Finish the read before a mutation; a tap must never be silently lost to polling.
      await reading.current?.catch(() => {});
      if (!mounted.current) return;
      await fn();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const discover = async () => {
      if (disposed) return;
      if (!document.hidden && !locked.current && !reading.current) {
        const pending = reload();
        reading.current = pending;
        try {
          await pending;
        } catch (e) {
          if (!disposed) setError((e as Error).message);
        } finally {
          if (reading.current === pending) reading.current = null;
        }
      }
      if (!disposed) timer = setTimeout(discover, 5000);
    };
    void discover();
    return () => {
      disposed = true;
      clearTimeout(timer);
      mounted.current = false;
    };
  }, [peer.url, peer.token]);
  useEffect(() => {
    setText("");
    setDraft("");
    setViewError("");
    setUpdated(false);
    follow.current = true;
    if (!selected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (disposed) return;
      if (!document.hidden && !locked.current && !reading.current) {
        const pending = request<{ text: string }>(
          peer,
          `/api/terminals/desktop/${selected}`,
        );
        reading.current = pending;
        try {
          const result = await pending;
          if (!disposed) {
            setText(result.text);
            setViewError("");
            setUpdated(true);
          }
        } catch (e) {
          if (!disposed) {
            setViewError((e as Error).message);
            setUpdated(false);
          }
        } finally {
          if (reading.current === pending) reading.current = null;
        }
      }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selected, peer.id, peer.url, peer.token]);
  useEffect(() => {
    if (screen.current && follow.current)
      screen.current.scrollTop = screen.current.scrollHeight;
  }, [text]);
  const view = current && (
    <div className="desktop-terminal-view">
      <div className="terminal-info">
        <span>{current.name}</span>
        <span className="connection-label">
          {updated ? "Updating" : "Waiting for output"}
        </span>
        <button
          className="button secondary small"
          disabled={busy}
          onClick={() =>
            void operate(() =>
              post(peer, `/api/terminals/desktop/${selected}/focus`),
            )
          }
        >
          <ArrowUpRight size={15} />
          Show on Mac
        </button>
        <button
          className="button secondary small"
          disabled={busy}
          onClick={() => {
            if (
              confirm(
                `Close “${current.name}” on your Mac? Commands running in it will stop. If this terminal runs Reach, you will disconnect.`,
              )
            )
              void operate(async () => {
                await post(peer, `/api/terminals/desktop/${selected}/close`, {
                  confirm: true,
                });
                await reload();
              });
          }}
        >
          <Square size={14} />
          Close
        </button>
      </div>
      <ErrorLine error={viewError} />
      <pre
        ref={screen}
        className="desktop-terminal-output"
        tabIndex={0}
        aria-label="Mac terminal output"
        onScroll={() => {
          const el = screen.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {text || (updated ? "No visible output." : "Reading terminal output…")}
      </pre>
      <form
        className="desktop-terminal-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void operate(async () => {
            await post(peer, `/api/terminals/desktop/${selected}/send`, {
              text: draft,
            });
            if (mounted.current) setDraft("");
          });
        }}
      >
        <label htmlFor="desktop-terminal-input">
          Send to this terminal + Enter
        </label>
        <textarea
          id="desktop-terminal-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={16000}
          rows={2}
          placeholder="A shell command, or a reply to the program running here…"
        />
        <button className="button primary" disabled={busy || !draft.trim()}>
          <Send size={16} />
          Send
        </button>
      </form>
      <p className="desktop-terminal-hint">
        This is the existing Mac session. Text goes to whichever program is
        running in it. Output is a text view; use Screen for full-screen apps
        and keyboard shortcuts.
      </p>
    </div>
  );
  if (embedded)
    return current ? (
      <section className="desktop-terminals panel embedded">
        <ErrorLine error={error} />
        {view}
      </section>
    ) : null;
  return (
    <section className="desktop-terminals panel">
      <div className="desktop-terminal-heading">
        <div>
          <h2>Open on your Mac</h2>
          <p>
            Apple Terminal tabs and iTerm2 panes, including ones opened outside
            Reach.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void operate(reload)}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
      <p className="desktop-terminal-hint">
        Open tabs appear automatically. Allow Automation access on your Mac when
        prompted. Other apps, including VS Code and Cursor, aren’t connected
        here yet.
      </p>
      <ErrorLine error={error} />
      {!inventory && !error && (
        <Spinner label="Checking terminal apps on your Mac…" />
      )}
      {inventory && (
        <>
          {inventory.providers.map(
            (p) =>
              p.error && (
                <ErrorLine key={p.id} error={`${p.name}: ${p.error}`} />
              ),
          )}
          <div className="desktop-terminal-create">
            <label>
              Open in{" "}
              <select
                aria-label="Mac terminal app"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="terminal">Apple Terminal</option>
                <option value="iterm2">iTerm2</option>
              </select>
            </label>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void operate(async () => {
                  await post(peer, "/api/terminals/desktop", { provider });
                  await reload(true);
                })
              }
            >
              <Plus size={16} />
              New Mac terminal
            </button>
          </div>
          {!inventory.sessions.length ? (
            <p>
              No open terminals found. Open a new one above, or check the app
              permissions.
            </p>
          ) : (
            <>
              <div
                className="desktop-terminal-list"
                aria-label="Open Mac terminals"
              >
                {inventory.sessions.map((s) => (
                  <button
                    key={s.id}
                    disabled={busy}
                    className={`desktop-terminal-card ${s.id === selected ? "selected" : ""}`}
                    onClick={() => setSelected(s.id)}
                  >
                    <Terminal size={18} />
                    <span>
                      <strong>{s.name || "Untitled terminal"}</strong>
                      <small>
                        {s.provider === "terminal"
                          ? "Apple Terminal"
                          : "iTerm2"}{" "}
                        · {s.tty}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {current && view}
            </>
          )}
        </>
      )}
    </section>
  );
}
