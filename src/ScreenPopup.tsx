import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
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
  useEffect(() => {
    const element = dialog.current;
    const focus = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      focus?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      className={`screen-popup ${className}`}
      ref={dialog}
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
        <header>
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
