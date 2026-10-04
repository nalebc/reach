import { useState } from "react";
import { Plus, ArrowUpRight, Loader2 } from "lucide-react";
import { post, type Peer } from "./api";
import { useShortcuts } from "./shortcuts";
import ShortcutIcon from "./ShortcutIcon";
import { ErrorLine } from "./ui";
export default function ShortcutShelf({
  peer,
  onManage,
}: {
  peer: Peer;
  onManage: () => void;
}) {
  const { items, loading, error } = useShortcuts(peer),
    [busy, setBusy] = useState(""),
    [feedback, setFeedback] = useState(""),
    [failure, setFailure] = useState("");
  const visible = items.filter((a) => a.custom || a.suggested).slice(0, 6);
  return (
    <section className="shortcut-shelf" aria-label="Quick shortcuts">
      <header>
        <div>
          <h2>Shortcuts</h2>
        </div>
        <button className="button secondary small" onClick={onManage}>
          <Plus size={15} /> Edit
        </button>
      </header>
      <ErrorLine error={failure || error} />
      <div className="shortcut-shelf-items">
        {visible.map((a) => {
          return (
            <button
              key={a.id}
              className="shortcut-tile"
              disabled={!!busy}
              onClick={async () => {
                setBusy(a.id);
                setFailure("");
                try {
                  await post(peer, "/api/apps/shortcuts", { id: a.id });
                  setFeedback(`${a.name} opened on ${peer.name}`);
                } catch (e) {
                  setFailure((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              <span>
                {busy === a.id ? (
                  <Loader2 className="spin" size={19} />
                ) : (
                  <ShortcutIcon peer={peer} shortcut={a} size={32} />
                )}
                <ArrowUpRight size={13} />
              </span>
              <strong>{a.name}</strong>
            </button>
          );
        })}
      </div>
      {loading ? (
        <p role="status">Finding your apps…</p>
      ) : !visible.length ? (
        <p>Add a favorite app or website to get started.</p>
      ) : null}
      <footer>
        <span role="status">{feedback}</span>
        <button className="button ghost small" onClick={onManage}>
          All shortcuts <ArrowUpRight size={14} />
        </button>
      </footer>
    </section>
  );
}
