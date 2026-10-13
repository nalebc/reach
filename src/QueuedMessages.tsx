import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  GripVertical,
  Image as ImageIcon,
  SquarePen,
  X,
} from "lucide-react";
import { visibleUserText } from "../server/agent-sessions/message-text.mjs";
import type { AgentName, OutboxMessage } from "./agent-sessions";
import "./queued-messages.css";

// Messages waiting their turn, above the composer: the same list in every
// chat that queues (Claude Code's in the Claude app or a terminal, Codex's
// in its app or CLI). One line each, its start only, pictures as a small
// icon; each row has a handle to drag it to a new place, Send now, Edit and
// remove. A row opens on a tap to show all of it; Edit changes it where it
// waits, pictures kept.
// - A new order is the order they go in: Codex's own queue
//   (thread/queue/reorder), so the Codex app and CLI show it too; Claude's,
//   the Mac's outbox Reach delivers from.
// - Rows nothing can move have no handle: one already in Claude Code's own
//   queue (held), the phone's copy of one (local), one being handed over.
// - Send now: Codex steers it into the turn it's running; Claude takes it
//   at once only in its app (in a terminal it goes when Claude finishes).
// Only the phone's copy of a held one (local) can be removed: the copy goes,
// nothing is sent.
//
// Dragging, as iOS and ChatGPT lists do: a press (or a move) on the handle
// lifts the row; a copy follows the finger, the others slide out of the way
// and a gap shows where it lands; near the list's edges it scrolls; let go
// and it settles there; Escape puts it back. A tap does nothing. From the
// keyboard: arrows move it a place; Space or Enter picks it up, arrows move
// it, Space or Enter drops it, Escape puts it back. Each move is announced.
// Transforms only, written outside React (a poll re-rendering mid-drag must
// not reset them).

const LIFT_MS = 220;
const SLOP = 5;
const SETTLE_MS = 180;
const EDGE = 36;

const reducedMotion = () => {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
const buzz = (ms: number) => {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(ms);
  } catch {}
};

type Slot = { id: string; top: number; height: number };
type Drag = {
  id: string;
  mode: "pointer" | "keyboard";
  pointerId: number;
  lifted: boolean;
  startY: number;
  lastY: number;
  timer?: ReturnType<typeof setTimeout>;
  raf: number;
  ids: string[];
  slots: Slot[];
  gap: number;
  from: number;
  to: number;
  lo: number;
  hi: number;
  startScroll: number;
  listTop: number;
  listBottom: number;
  minDy: number;
  maxDy: number;
};
type Lift = {
  id: string;
  mode: "pointer" | "keyboard";
  top: number;
  left: number;
  width: number;
  height: number;
};

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
  // The one shown whole, and the one being edited (its words so far).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  // A new order shown until the Mac's queue carries it.
  const [order, setOrder] = useState<string[] | null>(null);
  const orderRef = useRef<string[] | null>(null);
  const orderBase = useRef<string | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // The row lifted (drawn as a floating copy when dragged by a finger).
  const [lift, setLift] = useState<Lift | null>(null);
  const [said, setSaid] = useState("");
  // Transforms to clear once React has put the rows in their new order.
  const snap = useRef(false);
  const refocus = useRef<string | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dropping = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const byId = new Map(messages.map((m) => [m.id, m]));
  const shown = (order || messages.map((m) => m.id))
    .map((id) => byId.get(id))
    .filter(Boolean) as OutboxMessage[];
  // Only what's still waiting where Reach can change it moves.
  const movable = (m: OutboxMessage) => !m.held && !m.local && !m.sending;
  const sortable = !!onReorder && messages.filter(movable).length > 1;
  const label = (m: OutboxMessage) =>
    visibleUserText(m.text) ||
    (m.images ? `${m.images} image${m.images === 1 ? "" : "s"}` : "Message");
  const idsKey = messages.map((m) => m.id).join();

  // The Mac's queue moved on: a different order from it wins over one shown
  // here, and a drag over rows that changed under it is put down.
  useEffect(() => {
    const actual = idsKey.split(",").filter(Boolean);
    const d = drag.current;
    if (d?.lifted && d.ids.join() !== idsKey) putDown(false);
    if (!orderRef.current) return;
    if (actual.join() === orderRef.current.join() ||
        (orderBase.current !== null && actual.join() !== orderBase.current) ||
        actual.length !== orderRef.current.length ||
        actual.some((id) => !orderRef.current?.includes(id))) {
      orderRef.current = null;
      setOrder(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => () => {
    clearTimeout(settle.current);
    clearTimeout(dropping.current);
    const d = drag.current;
    if (d) {
      clearTimeout(d.timer);
      cancelAnimationFrame(d.raf);
    }
  }, []);

  // After a drop: the rows are in their new order, so the slide offsets go,
  // with no animation back.
  useLayoutEffect(() => {
    if (snap.current) {
      snap.current = false;
      const el = list.current;
      el?.classList.add("qm-snap");
      for (const row of rows.current.values()) row.style.transform = "";
      void el?.offsetHeight;
      el?.classList.remove("qm-snap");
    }
    // Moved from the keyboard: the focus stays on its handle.
    if (refocus.current) {
      const grip = grips.current.get(refocus.current);
      if (grip && document.activeElement !== grip) grip.focus();
      refocus.current = null;
    }
  });

  const current = () => orderRef.current || messages.map((m) => m.id);
  const move = (id: string, to: number, from = current()) => {
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
      // Everything in the Mac's queue (one being handed over too: its
      // place there doesn't change), not what only shows here.
      await onReorder?.(ids.filter((id) => byId.has(id) && !byId.get(id)?.held));
      // Accepted, but if the Mac's queue never takes the new order, show the
      // Mac's order again rather than one it doesn't have.
      clearTimeout(settle.current);
      settle.current = setTimeout(() => {
        if (orderRef.current === ids) {
          orderRef.current = null;
          setOrder(null);
        }
      }, 6000);
    } catch {
      orderRef.current = null;
      setOrder(null);
    }
  };

  // Where each row is now, and how far the others may go: rows that can't
  // move (held, being sent) keep their places.
  const measure = (id: string, mode: Drag["mode"], pointerId: number, y: number): Drag | null => {
    const ids = shown.map((m) => m.id);
    const from = ids.indexOf(id);
    const el = list.current;
    if (from < 0 || !el) return null;
    const scroll = el.scrollTop;
    const box = el.getBoundingClientRect();
    const slots = ids.map((x) => {
      const r = rows.current.get(x)?.getBoundingClientRect();
      return { id: x, top: (r?.top ?? 0) - box.top + scroll, height: r?.height || 40 };
    });
    const gap = slots.length > 1 ? Math.max(0, slots[1].top - slots[0].top - slots[0].height) : 0;
    const free = shown.map((m, i) => (movable(m) ? i : -1)).filter((i) => i >= 0);
    const row = rows.current.get(id)?.getBoundingClientRect();
    const sized = box.height > 0 && !!row;
    return {
      id, mode, pointerId, lifted: false, startY: y, lastY: y, raf: 0, ids, slots, gap, from, to: from,
      lo: Math.min(...free), hi: Math.max(...free), startScroll: scroll,
      listTop: box.top, listBottom: box.bottom,
      minDy: sized ? box.top - row!.top - 4 : -Infinity,
      maxDy: sized ? box.bottom - row!.bottom + 4 : Infinity,
    };
  };
  // The others slide out of the way; the lifted one's slot (the gap, or the
  // row itself from the keyboard) goes where it would land.
  const shift = (d: Drag) => {
    const h = d.slots[d.from].height + d.gap;
    let own = 0;
    d.slots.forEach((s, i) => {
      if (i === d.from) return;
      let y = 0;
      if (d.from < d.to && i > d.from && i <= d.to) { y = -h; own += s.height + d.gap; }
      if (d.to < d.from && i >= d.to && i < d.from) { y = h; own -= s.height + d.gap; }
      const el = rows.current.get(s.id);
      if (el) el.style.transform = y ? `translate3d(0, ${y}px, 0)` : "";
    });
    const self = rows.current.get(d.id);
    if (self) self.style.transform = d.mode === "keyboard"
      ? `translate3d(0, ${own}px, 0) scale(1.02)`
      : own ? `translate3d(0, ${own}px, 0)` : "";
    return own;
  };
  const place = (d: Drag) => `Position ${d.to + 1} of ${d.ids.length}`;
  // Which place the lifted row's middle is over: past another row's middle,
  // it takes that row's place.
  const aim = (d: Drag) => {
    const scrolled = (list.current?.scrollTop ?? d.startScroll) - d.startScroll;
    const mid = d.slots[d.from].top + d.slots[d.from].height / 2 + (d.lastY - d.startY) + scrolled;
    let to = d.from;
    d.slots.forEach((s, i) => {
      const half = s.top + s.height / 2;
      if (i > d.from && mid > half) to = Math.max(to, i);
      if (i < d.from && mid < half) to = Math.min(to, i);
    });
    return Math.max(d.lo, Math.min(d.hi, to));
  };
  const frame = () => {
    const d = drag.current;
    if (!d?.lifted || d.mode !== "pointer") return;
    d.raf = 0;
    const el = list.current;
    let rolling = false;
    // Near the list's top or bottom: it scrolls, faster the closer.
    if (el && d.listBottom > d.listTop) {
      const speed = d.lastY < d.listTop + EDGE
        ? -(d.listTop + EDGE - d.lastY) / 3
        : d.lastY > d.listBottom - EDGE
          ? (d.lastY - (d.listBottom - EDGE)) / 3
          : 0;
      if (speed) {
        const before = el.scrollTop;
        el.scrollTop = before + Math.max(-14, Math.min(14, speed));
        rolling = el.scrollTop !== before;
      }
    }
    const dy = Math.max(d.minDy, Math.min(d.maxDy, d.lastY - d.startY));
    if (ghost.current) ghost.current.style.transform = `translate3d(0, ${dy}px, 0) scale(1.03)`;
    const to = aim(d);
    if (to !== d.to) {
      d.to = to;
      shift(d);
      buzz(4);
    }
    if (rolling) d.raf = requestAnimationFrame(frame);
  };
  const lifted = (d: Drag) => {
    d.lifted = true;
    clearTimeout(d.timer);
    const row = rows.current.get(d.id)?.getBoundingClientRect();
    const box = section.current?.getBoundingClientRect();
    setLift({
      id: d.id,
      mode: d.mode,
      top: (row?.top ?? 0) - (box?.top ?? 0),
      left: (row?.left ?? 0) - (box?.left ?? 0),
      width: row?.width || 0,
      height: row?.height || 40,
    });
    buzz(10);
    if (d.mode === "keyboard") {
      shift(d);
      setSaid(`Picked up. ${place(d)}. Arrows move it, Space drops it, Escape cancels.`);
    }
  };
  // Let go: it settles into its new place (drop) or back where it was.
  function putDown(drop: boolean) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    clearTimeout(d.timer);
    cancelAnimationFrame(d.raf);
    if (!d.lifted) return;
    if (!drop) d.to = d.from;
    const own = shift(d);
    const ids = drop ? move(d.id, d.to, d.ids) : d.ids;
    const done = () => {
      snap.current = true;
      if (d.mode === "keyboard") refocus.current = d.id;
      setLift(null);
      if (drop) void finish(ids);
    };
    setSaid(drop
      ? d.to === d.from ? `Dropped. ${place(d)}.` : `Moved to position ${d.to + 1} of ${d.ids.length}`
      : `Cancelled. Back at position ${d.from + 1} of ${d.ids.length}`);
    if (d.mode === "pointer" && ghost.current && !reducedMotion()) {
      // The copy glides into the gap, then the row takes its place.
      const scrolled = (list.current?.scrollTop ?? d.startScroll) - d.startScroll;
      ghost.current.classList.add("qm-dropping");
      ghost.current.style.transform = `translate3d(0, ${own - scrolled}px, 0)`;
      clearTimeout(dropping.current);
      dropping.current = setTimeout(done, SETTLE_MS);
    } else done();
  }
  useEffect(() => {
    if (!lift) return;
    // Escape puts a dragged row back, wherever the focus is.
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current?.lifted) {
        e.preventDefault();
        putDown(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lift]);

  const grip = (m: OutboxMessage, index: number) => (
    <button
      className="qm-grip"
      ref={(el) => {
        if (el) grips.current.set(m.id, el);
        else grips.current.delete(m.id);
      }}
      disabled={(!!busy || saving) && drag.current?.id !== m.id}
      aria-label={`Reorder queued message ${index + 1} of ${shown.length}`}
      aria-pressed={lift?.id === m.id && lift.mode === "keyboard" ? true : undefined}
      title="Drag to reorder"
      onPointerDown={(e) => {
        if (busy || savingNow.current || drag.current || e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const d = measure(m.id, "pointer", e.pointerId, e.clientY);
        if (!d) return;
        drag.current = d;
        // Held still a moment: it lifts without moving.
        d.timer = setTimeout(() => {
          if (drag.current === d && !d.lifted) lifted(d);
        }, LIFT_MS);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.mode !== "pointer" || d.pointerId !== e.pointerId) return;
        d.lastY = e.clientY;
        if (!d.lifted) {
          if (Math.abs(e.clientY - d.startY) < SLOP) return;
          lifted(d);
        }
        if (!d.raf) d.raf = requestAnimationFrame(frame);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (!d || d.mode !== "pointer" || d.pointerId !== e.pointerId) return;
        if (!d.lifted) {
          // A tap: nothing moves.
          clearTimeout(d.timer);
          drag.current = null;
          return;
        }
        d.lastY = e.clientY;
        cancelAnimationFrame(d.raf);
        d.raf = 0;
        frame();
        putDown(true);
      }}
      onPointerCancel={(e) => {
        if (drag.current?.mode === "pointer" && drag.current.pointerId === e.pointerId) putDown(false);
      }}
      onBlur={() => {
        if (drag.current?.mode === "keyboard" && drag.current.id === m.id) putDown(false);
      }}
      onKeyDown={(e) => {
        const d = drag.current;
        const up = e.key === "ArrowUp";
        const down = e.key === "ArrowDown";
        const pick = e.key === " " || e.key === "Enter";
        if (d?.mode === "keyboard" && d.id === m.id && d.lifted) {
          if (up || down) {
            e.preventDefault();
            const to = Math.max(d.lo, Math.min(d.hi, d.to + (up ? -1 : 1)));
            if (to === d.to) return;
            d.to = to;
            shift(d);
            const el = list.current;
            const s = d.slots[to];
            if (el && el.clientHeight) {
              if (s.top < el.scrollTop) el.scrollTop = s.top;
              else if (s.top + s.height > el.scrollTop + el.clientHeight) el.scrollTop = s.top + s.height - el.clientHeight;
            }
            setSaid(place(d));
          } else if (pick) {
            e.preventDefault();
            putDown(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            putDown(false);
          }
          return;
        }
        if (d || busy || savingNow.current || !(up || down || pick)) return;
        e.preventDefault();
        if (pick) {
          const k = measure(m.id, "keyboard", -1, 0);
          if (!k) return;
          drag.current = k;
          lifted(k);
          return;
        }
        // An arrow alone moves it a place at once.
        const ids = current();
        const from = ids.indexOf(m.id);
        const free = shown.map((x, i) => (movable(x) ? i : -1)).filter((i) => i >= 0);
        const to = Math.max(Math.min(...free), Math.min(Math.max(...free), from + (up ? -1 : 1)));
        if (to === from) return;
        refocus.current = m.id;
        setSaid(`Moved to position ${to + 1} of ${ids.length}`);
        void finish(move(m.id, to, ids));
      }}
    >
      <GripVertical size={14} />
    </button>
  );

  const row = (m: OutboxMessage, index: number) => (
    <div
      key={m.id}
      ref={(el) => {
        if (el) rows.current.set(m.id, el);
        else rows.current.delete(m.id);
      }}
      className={`qm-row${lift?.id === m.id ? (lift.mode === "pointer" ? " qm-gap" : " lifted") : ""}`}
    >
      {sortable && movable(m) && grip(m, index)}
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
              if (savingNow.current || busy || !canEdit || m.sending || (!editing.text.trim() && !m.images)) return;
              savingNow.current = true;
              setSaving(true);
              try {
                await onEdit(m, editing.text);
                setEditing(null);
              } catch {
                // Keep the draft open; the parent shows the server's error.
              } finally {
                savingNow.current = false;
                setSaving(false);
              }
            }}
          >
            <textarea
              autoFocus
              aria-label="Edit queued message"
              value={editing.text}
              disabled={saving || !!busy || !canEdit || !!m.sending}
              rows={Math.min(8, Math.max(2, editing.text.split("\n").length))}
              onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
            />
            <span className="qm-edit-actions">
              <button type="button" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={saving || !!busy || !canEdit || !!m.sending || (!editing.text.trim() && !m.images)}>
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
      {onSendNow && (!claude || m.via === "app") && !m.sending && !m.held && editing?.id !== m.id && (
        <button
          className="qm-now"
          aria-label="Send now"
          title="Send now"
          disabled={!!busy || saving}
          onClick={() => { if (!savingNow.current && !busy) onSendNow(m); }}
        >
          <ArrowUp size={15} />
        </button>
      )}
      {editing?.id !== m.id && !m.held && (
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
      {(!m.held || m.local) && (
        <button
          aria-label="Remove queued message"
          title="Remove"
          disabled={!!busy || saving}
          onClick={() => { if (!savingNow.current && !busy) onRemove(m); }}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );

  const lifting = lift?.mode === "pointer" ? byId.get(lift.id) : undefined;
  return (
    <section
      ref={section}
      className={`qm ${agent}${sortable ? " sortable" : ""}${lift ? " sorting" : ""}`}
      aria-label="Queued messages"
    >
      <div className="qm-list" ref={list}>
        {shown.map(row)}
      </div>
      {/* The row being dragged, following the finger. */}
      {lift && lifting && (
        <div
          ref={ghost}
          className="qm-ghost"
          aria-hidden="true"
          style={{ top: lift.top, left: lift.left, width: lift.width || undefined, height: lift.height }}
        >
          <span className="qm-ghost-grip"><GripVertical size={14} /></span>
          {lifting.images > 0 && <span className="qm-images"><ImageIcon size={14} /></span>}
          <span className="qm-ghost-text">{label(lifting)}</span>
        </div>
      )}
      <div className="qm-live" role="status" aria-live="assertive" aria-atomic="true">
        {said}
      </div>
    </section>
  );
}
