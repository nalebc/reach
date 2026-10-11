import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useViewportBox } from "./useViewportBox";

// One focused overlay, shared by composing, switching chats, and reviews.
export default function ChatSheet({
  title,
  onClose,
  children,
  className = "",
  leading,
  heading,
}: {
  title: string;
  // In the title's place (New chat: its app, to change); the title still
  // names the sheet.
  heading?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  leading?: ReactNode;
}) {
  const surface = useRef<HTMLElement>(null);
  // The sheet sits in the part of the screen the keyboard leaves visible (it
  // opened under the keyboard on an iPhone, New chat's composer hidden), and
  // the page under it stays put.
  const overlay = useRef<HTMLDivElement>(null);
  useViewportBox(overlay, true, "sheet");
  // Capture the trigger before a child's autofocus effect can move focus.
  const restoreFocus = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const controls = () =>
      [
        ...(surface.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled), select:not(:disabled), a[href]",
        ) || []),
      ].filter((el) => !el.closest("[hidden]"));
    (
      surface.current?.querySelector<HTMLElement>("textarea") || controls()[0]
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
      if (e.key !== "Tab") return;
      const list = controls();
      const first = list[0],
        last = list[list.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          !surface.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !surface.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      restoreFocus.current?.focus();
    };
  }, []);
  return createPortal(
    <div
      ref={overlay}
      className="reach-chat-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={surface}
        className={`reach-chat-sheet chat-home ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="chat-sheet-heading">
          {leading && <span className="chat-sheet-leading" aria-hidden="true">{leading}</span>}
          <h2>{heading ?? title}</h2>
          <button
            className="chat-sheet-close"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
