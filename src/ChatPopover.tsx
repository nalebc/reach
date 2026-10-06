import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./chat-popover.css";

// A small menu floating by what opened it (a folder's ⋯, a chat held down),
// over the list instead of pushing it down. On the page itself: the Chats
// list contains its layout (container queries), which would pin a fixed
// menu to the list. Below what opened it, above when there's no room; a tap
// outside or Escape closes it.
export type Anchor = { top: number; bottom: number; left: number; right: number };

export const anchorOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
};

export function ChatPopover({
  anchor,
  label,
  onClose,
  align = "end",
  children,
}: {
  anchor: Anchor;
  label: string;
  onClose: () => void;
  // "end": its right edge on the anchor's (a ⋯); "start": its left edge.
  align?: "start" | "end";
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Placed straight on the element (no state): its size changes as its
  // steps change, and it follows without a render loop.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const gap = 6;
    const edge = 12;
    const vw = window.innerWidth;
    const vh = window.visualViewport?.height || window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = align === "end" ? anchor.right - w : anchor.left;
    const left = Math.max(edge, Math.min(x, vw - w - edge));
    const below = anchor.bottom + gap;
    const top = below + h <= vh - edge ? below : Math.max(edge, Math.min(anchor.top - h - gap, vh - h - edge));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <>
      <div className="chat-popover-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={box} className="chat-popover" role="menu" aria-label={label}>
        {children}
      </div>
    </>,
    document.body,
  );
}
