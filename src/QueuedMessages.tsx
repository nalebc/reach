import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  GripVertical,
  Image as ImageIcon,
  SquarePen,
  X,
} from "lucide-react";
import { visibleUserText } from "../server/agent-sessions/message-text.mjs";
import type { AgentName, OutboxMessage } from "./agent-sessions";
import "./queued-messages.css";

// Messages waiting their turn, above the composer, as the agents' own apps
// show them (read from the Claude and Codex apps on the Mac):
// - one line each, its start only, pictures as a small count;
// - Claude's: a stack that opens on a tap; each row has Send now (into the
//   chat at once), Edit, remove, and a handle to drag it up or down;
// - Codex's: a plain list; Send now (its Steer: into the turn it's running),
//   Edit, remove, and a new order (Codex's own thread/queue/reorder).
// A row opens on a tap to show all of it; Edit changes it where it waits,
// pictures kept.
export default function QueuedMessages({
  agent,
  messages,
  busy,
  canEdit,
  onEdit,
  onRemove,
  onSendNow,
  onReorder,
}: {
  agent: AgentName;
  messages: OutboxMessage[];
  // The message an action is running for.
  busy: string | null;
  canEdit: boolean;
  onEdit: (m: OutboxMessage, text: string) => Promise<void>;
  onRemove: (m: OutboxMessage) => void;
  // Where Reach can do it (a Claude app chat, any Codex chat).
  onSendNow?: (m: OutboxMessage) => void;
  onReorder?: (ids: string[]) => Promise<void> | void;
}) {
  const claude = agent === "claude";
  const [open, setOpen] = useState(false);
  // The one shown whole, and the one being edited (its words so far).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // While a row is dragged: the order shown, sent once the finger lifts.
  const [order, setOrder] = useState<string[] | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{ id: string; pointerId: number; startY: number; active: boolean } | null>(null);
  const orderRef = useRef<string[] | null>(null);
  const orderBase = useRef<string | null>(null);
  useEffect(() => {
    if (messages.length < 2) setOpen(false);
  }, [messages.length]);
  const byId = new Map(messages.map((m) => [m.id, m]));
  const shown = (order || messages.map((m) => m.id))
    .map((id) => byId.get(id))
    .filter(Boolean) as OutboxMessage[];
  const stacked = claude && messages.length > 1 && !open;
  const sortable = !!onReorder && messages.length > 1 && !stacked;
  const label = (m: OutboxMessage) =>
    visibleUserText(m.text) ||
    (m.images ? `${m.images} image${m.images === 1 ? "" : "s"}` : "Message");

  useEffect(() => {
    if (!orderRef.current) return;
    const actual = messages.map((m) => m.id);
    if (actual.join() === orderRef.current.join() ||
        (orderBase.current !== null && actual.join() !== orderBase.current) ||
        actual.length !== orderRef.current.length ||
        actual.some((id) => !orderRef.current?.includes(id))) {
      orderRef.current = null;
      setOrder(null);
    }
  }, [messages]);

  const move = (id: string, to: number, from = orderRef.current || messages.map((m) => m.id)) => {
    const ids = from.filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    return ids;
  };
  const finish = async (ids: string[]) => {
    const before = messages.map((m) => m.id).join();
    if (ids.join() === before) {
      orderRef.current = null;
      setOrder(null);
      return;
    }
    orderBase.current = before;
    orderRef.current = ids;
    setOrder(ids);
    try {
      await onReorder?.(ids);
    } catch {
      orderRef.current = null;
      setOrder(null);
    }
  };

  const row = (m: OutboxMessage, index: number) => (
    <div
      key={m.id}
      ref={(el) => {
        if (el) rows.current.set(m.id, el);
        else rows.current.delete(m.id);
      }}
      className={`qm-row ${drag.current?.active && drag.current.id === m.id ? "dragging" : ""}`}
    >
      {sortable && !m.sending && (
        <button
          className="qm-grip"
          disabled={!!busy || saving}
          aria-label={`Reorder queued message ${index + 1} of ${shown.length}`}
          title="Drag or use the arrow keys to reorder"
          onPointerDown={(e) => {
            if (busy || saving || e.button !== 0) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            drag.current = { id: m.id, pointerId: e.pointerId, startY: e.clientY, active: false };
          }}
          onPointerMove={(e) => {
            const current = drag.current;
            if (!current || current.pointerId !== e.pointerId) return;
            if (!current.active) {
              if (Math.abs(e.clientY - current.startY) < 5) return;
              current.active = true;
              orderRef.current = messages.map((x) => x.id);
              setOrder(orderRef.current);
            }
            const ids = orderRef.current || messages.map((x) => x.id);
            const from = ids.indexOf(current.id);
            // Cross the other row's midpoint before changing places.
            for (const [id, el] of rows.current) {
              const r = el.getBoundingClientRect();
              const to = ids.indexOf(id);
              if (to < 0 || to === from) continue;
              if ((to > from && e.clientY >= r.top + r.height / 2 && e.clientY <= r.bottom) ||
                  (to < from && e.clientY <= r.top + r.height / 2 && e.clientY >= r.top)) {
                const next = move(current.id, to, ids);
                orderRef.current = next;
                setOrder(next);
                break;
              }
            }
          }}
          onPointerUp={(e) => {
            if (!drag.current || drag.current.pointerId !== e.pointerId) return;
            const active = drag.current.active;
            drag.current = null;
            if (active) void finish(orderRef.current || messages.map((x) => x.id));
          }}
          onPointerCancel={() => {
            drag.current = null;
            orderRef.current = null;
            setOrder(null);
          }}
          onKeyDown={(e) => {
            if (busy || saving || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            const ids = orderRef.current || messages.map((x) => x.id);
            void finish(move(m.id, ids.indexOf(m.id) + (e.key === "ArrowUp" ? -1 : 1), ids));
          }}
        >
          <GripVertical size={14} />
        </button>
      )}
      {m.images > 0 && (
        <span
          className="qm-images"
          aria-label={`${m.images} image${m.images === 1 ? "" : "s"}`}
        >
          <ImageIcon size={14} />
          {m.images > 1 && <small>{m.images}</small>}
        </span>
      )}
      <div className={`qm-text ${expanded === m.id ? "whole" : ""}`}>
        {editing?.id === m.id ? (
          <form
            className="qm-edit"
            onSubmit={async (e) => {
              e.preventDefault();
              if (saving) return;
              setSaving(true);
              try {
                await onEdit(m, editing.text);
                setEditing(null);
              } catch {
                // Keep the draft open; the parent shows the server's error.
              } finally {
                setSaving(false);
              }
            }}
          >
            <textarea
              autoFocus
              aria-label="Edit queued message"
              value={editing.text}
              rows={Math.min(8, Math.max(2, editing.text.split("\n").length))}
              onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
            />
            <span className="qm-edit-actions">
              <button type="button" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={saving || (!editing.text.trim() && !m.images)}>
                Save
              </button>
            </span>
          </form>
        ) : (
          <button
            className="qm-open"
            aria-expanded={expanded === m.id}
            title={expanded === m.id ? "Show less" : "Show all"}
            onClick={() => setExpanded(expanded === m.id ? null : m.id)}
          >
            {label(m)}
          </button>
        )}
        {m.sending ? (
          <small>Sending…</small>
        ) : m.error ? (
          <small className="qm-why" title={m.error}>
            {m.error}
          </small>
        ) : null}
      </div>
      {onSendNow && (!claude || m.via === "app") && !m.sending && editing?.id !== m.id && (
        <button
          className="qm-now"
          aria-label="Send now"
          title="Send now"
          disabled={!!busy}
          onClick={() => onSendNow(m)}
        >
          <ArrowUp size={15} />
        </button>
      )}
      {editing?.id !== m.id && (
        <button
          className="qm-action"
          aria-label="Edit queued message"
          title="Edit"
          disabled={!canEdit || !!m.sending || !!busy || saving}
          onClick={() => {
            setExpanded(null);
            setEditing({ id: m.id, text: visibleUserText(m.text) });
          }}
        >
          <SquarePen size={16} />
        </button>
      )}
      <button
        aria-label="Remove queued message"
        title="Remove"
        disabled={!!busy}
        onClick={() => onRemove(m)}
      >
        <X size={15} />
      </button>
    </div>
  );

  return (
    <section
      className={`qm ${agent} ${stacked ? "stacked" : ""} ${sortable ? "sortable" : ""}`}
      aria-label="Queued messages"
    >
      {claude && messages.length > 1 && (
        <button
          className="qm-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span>{messages.length} queued</span>
          <ChevronDown size={14} className={open ? "up" : ""} />
        </button>
      )}
      <div className="qm-list">
        {(stacked ? shown.slice(0, 1) : shown).map(row)}
      </div>
    </section>
  );
}
