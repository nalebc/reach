import { useEffect, useRef, ReactNode } from "react";
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
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
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
