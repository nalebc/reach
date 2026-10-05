import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { holdPage, holdTouches } from "./page-hold";
import { dragToClose } from "./sheet-drag";
export default function ScreenPopup({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    const focus = document.activeElement as HTMLElement | null;
    const letGo = holdPage();
    const letTouchesGo = element ? holdTouches(element) : () => {};
    const stopDrag = element
      ? dragToClose(element, () => closing.current())
      : () => {};
    element?.showModal();
    // The browser hands focus to the first button (on iPhone, the close
    // button then wears a focus ring as the sheet opens): the sheet itself
    // takes it instead, unless something inside asked for it.
    const first = document.activeElement;
    if (element && (!element.contains(first) || first?.tagName === "BUTTON"))
      element.focus({ preventScroll: true });
    return () => {
      element?.close();
      stopDrag();
      letTouchesGo();
      letGo();
      focus?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      className={`screen-popup ${className}`}
      ref={dialog}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="screen-popup-body">
        {/* Bottom sheets on phones: drag it down to close. */}
        <div className="sheet-handle" aria-hidden="true" />
        <header data-sheet-grab>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close panel"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
