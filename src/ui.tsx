import { ReactNode, useRef } from "react";
import {
  X,
  LoaderCircle,
  Monitor,
  Command,
  Terminal,
  Folder,
  MessageSquare,
  AppWindow,
  ShieldCheck,
  Wifi,
  Plus,
  ChevronRight,
} from "lucide-react";
export {
  X,
  LoaderCircle,
  Monitor,
  Command,
  Terminal,
  Folder,
  MessageSquare,
  AppWindow,
  ShieldCheck,
  Wifi,
  Plus,
  ChevronRight,
};
import LivingLogo from "./LivingLogo";
import ScreenPopup from "./ScreenPopup";
import "./settings-list.css";
import "./sheet.css";
// The wordmark plays a short random act now and then (LivingLogo).
export function Logo({ companion = false }: { companion?: boolean }) {
  return <LivingLogo companion={companion} />;
}
export function Spinner({
  label = "Connecting to your computer…",
}: {
  label?: string;
}) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
export function Empty({
  icon: Icon = Folder,
  title,
  children,
  action,
}: {
  icon?: any;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={30} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
// A sheet to create or confirm one thing, as ChatGPT's: a bottom sheet on
// phones (pull it down to close), a centred card on wider screens, a compact
// title with a small round close, and the sheet's one action kept in reach
// at the bottom (footer). Escape, a tap outside and the close button close
// it. ScreenPopup underneath, as Reach's other sheets: the sheet holds focus
// as it opens (no ring on its close button), the page stays still behind it.
export function Modal({
  title,
  heading,
  children,
  footer,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  /** Shown in the title's place (a back chevron and a page's name, say). */
  heading?: ReactNode;
  children: ReactNode;
  /** The sheet's action, pinned to its bottom edge. */
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  // A drag down that doesn't close it (a page going back to its sheet, a
  // sheet busy connecting) springs it back instead of leaving it off-screen.
  const close = () => {
    onClose();
    setTimeout(() => {
      const dialog = marker.current?.closest("dialog");
      if (!dialog?.open || !dialog.style.translate) return;
      dialog.style.transition = "translate 0.24s cubic-bezier(0.2, 0.8, 0.2, 1)";
      dialog.style.translate = "";
    });
  };
  return (
    <ScreenPopup
      title={title}
      heading={heading}
      onClose={close}
      className={["reach-sheet", wide && "wide", footer && "has-foot", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
      {footer && <div className="reach-sheet-foot">{footer}</div>}
      <span ref={marker} hidden />
    </ScreenPopup>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="title-actions">{children}</div>
    </div>
  );
}
export function ErrorLine({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
