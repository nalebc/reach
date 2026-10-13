import { useCallback, useEffect, useState } from "react";
import { CircleArrowUp, LoaderCircle } from "lucide-react";
import { post, request, type Peer } from "./api";
import "./settings-list.css";

// What Reach drives on the computer, behind or too old (server/keep-in-sync.mjs):
// Codex's service, Claude Code, Codex, OpenClaw. A row each with Update;
// the computer runs that piece's own fixed command. What a tap would stop
// is said first, in one line, with Update anyway.
export type SyncItem = {
  id: string;
  name: string;
  state: "too-old" | "behind" | "current";
  from?: string | null;
  to?: string | null;
  unlocks?: string | null;
  canUpdate?: boolean;
  how?: string;
  title: string;
  detail: string;
  working?: number;
  run?: { state: "updating" | "started" | "done" | "failed"; message?: string };
};
const pairOf = (item: SyncItem) => `${item.from || "?"}>${item.to || "?"}`;
export const syncItems = (peer: Peer, fresh = false) =>
  request<{ items: SyncItem[] }>(peer, `/api/sessions/keep-in-sync${fresh ? "?fresh=1" : ""}`).then((r) => (Array.isArray(r?.items) ? r.items : []));
export const syncUpdate = (peer: Peer, item: SyncItem, anyway = false) =>
  post<{ items: SyncItem[] }>(peer, `/api/sessions/keep-in-sync/${encodeURIComponent(item.id)}`, { action: "update", pair: pairOf(item), anyway });

export function useSync(peer: Peer | undefined, enabled = true) {
  const [items, setItems] = useState<SyncItem[]>([]);
  const load = useCallback(async (fresh = false) => {
    if (!peer || !enabled) return;
    try { setItems(await syncItems(peer, fresh)); } catch { /* an older computer, or offline */ }
  }, [peer?.id, peer?.url, peer?.token, enabled]);
  useEffect(() => { void load(); }, [load]);
  // While one updates, look every few seconds.
  const updating = items.some((i) => i.run?.state === "updating" || i.run?.state === "started");
  useEffect(() => {
    if (!updating) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [updating, load]);
  return { items, setItems, load };
}

// One piece: its line, then Update (or what to do, when Reach can't).
export function SyncRow({ peer, item, onChanged, compact = false }: { peer: Peer; item: SyncItem; onChanged: (items?: SyncItem[]) => void; compact?: boolean }) {
  const [asking, setAsking] = useState("");
  const [problem, setProblem] = useState("");
  const [sending, setSending] = useState(false);
  const run = item.run;
  const go = async (anyway = false) => {
    setSending(true);
    setProblem("");
    try {
      const r = await syncUpdate(peer, item, anyway);
      setAsking("");
      onChanged(r.items);
    } catch (e) {
      const err = e as Error & { status?: number; body?: { working?: number } };
      if (err.status === 409 && err.body?.working) setAsking(err.message);
      else setProblem(err.message);
    } finally {
      setSending(false);
    }
  };
  const behind = item.state !== "current";
  const line =
    run?.state === "updating" ? "Updating…"
      : run?.state === "started" ? "Updating in a Reach terminal"
      : run?.state === "done" || run?.state === "failed" ? run.message || ""
      : item.detail;
  const failed = run?.state === "failed" || !!problem;
  return (
    <div className={`gs-row gs-wrap sync-row${compact ? " compact" : ""}`} role={run ? "status" : undefined}>
      {!compact && <CircleArrowUp size={21} />}
      <span className="gs-label">
        <span>{behind ? item.title : item.name}</span>
        <small className={failed ? "sync-problem" : undefined}>{problem || asking || line}</small>
      </span>
      {run?.state === "updating" ? (
        <LoaderCircle size={18} className="spin" />
      ) : asking ? (
        <span className="sync-actions">
          <button className="as-banner-btn" disabled={sending} onClick={() => setAsking("")}>Cancel</button>
          <button className="as-banner-btn primary" disabled={sending} onClick={() => void go(true)}>Update anyway</button>
        </span>
      ) : behind && item.canUpdate && run?.state !== "started" ? (
        <button className="as-banner-btn primary" disabled={sending} onClick={() => void go()}>
          {failed ? "Try again" : "Update"}
        </button>
      ) : behind && !item.canUpdate && item.how ? (
        <span className="gs-value">{item.how}</span>
      ) : null}
    </div>
  );
}

// Settings: the owner's group, only when something is behind (or just updated).
export default function KeepInSync({ peer, owner }: { peer: Peer; owner: boolean }) {
  const { items, setItems, load } = useSync(peer, owner);
  const shown = items.filter((i) => i.state !== "current" || i.run);
  if (!owner || !shown.length) return null;
  return (
    <>
      <h2 className="gs-title">Updates</h2>
      <div className="gs-group">
        {shown.map((item) => (
          <SyncRow key={item.id} peer={peer} item={item} onChanged={(next) => (next ? setItems(next) : void load())} />
        ))}
      </div>
    </>
  );
}

// Over Codex's greyed-out models: "Update Codex's service to use … and newer
// models" with Update; once it's done, onDone reads the models again.
export function SyncLine({ peer, id, onDone }: { peer: Peer; id: string; onDone?: () => void }) {
  const { items, setItems, load } = useSync(peer);
  const item = items.find((i) => i.id === id);
  const done = item?.run?.state === "done";
  useEffect(() => { if (done) onDone?.(); }, [done]);
  if (!item || (item.state === "current" && !item.run)) return null;
  return <SyncRow peer={peer} item={item} compact onChanged={(next) => (next ? setItems(next) : void load())} />;
}
