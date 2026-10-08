import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft } from "lucide-react";
import "./files.css";

// The same native, top-layer presentation as Files. The header never scrolls
// away; opening a preview keeps the parent view and its scroll position intact.
export function ClawDialog({
  title,
  subtitle,
  onClose,
  children,
  tools,
  className = "",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  tools?: ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className={`file-viewer claw-dialog ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="file-viewer-inner">
        <header>
          <button
            className="files-tool"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={onClose}
          >
            <ChevronLeft size={24} />
          </button>
          <div className="file-viewer-title">
            <strong>{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </div>
          {tools}
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
