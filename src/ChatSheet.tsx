import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// One focused overlay, shared by composing, switching chats, and reviews.
export default function ChatSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const surface = useRef<HTMLElement>(null);
  // Capture the trigger before a child's autofocus effect can move focus.
  const restoreFocus = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
      document.body.style.overflow = overflow;
      restoreFocus.current?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="reach-chat-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={surface}
        className="reach-chat-sheet chat-home"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="chat-sheet-heading">
          <h2>{title}</h2>
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
