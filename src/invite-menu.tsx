import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import "./invite-sheet.css";

// The invitation's pickers, as ChatGPT's: a row shows the choice, a tap opens
// a small menu of options (an icon, a name, one line, a check). Shared by the
// person and agent invitations so both read the same way.
export function Menu({
  label,
  children,
  wide = false,
  className = "",
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className={`ivt-menu ${className}`} ref={box}>
      <button
        type="button"
        className="ivt-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className={`ivt-menu-list ${wide ? "wide" : ""}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
export function Item({
  on,
  label,
  description,
  icon,
  disabled = false,
  onClick,
}: {
  on: boolean;
  label: ReactNode;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      className={`ivt-item${icon ? " with-icon" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && (
        <span className="ivt-item-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      {on && <Check size={16} />}
    </button>
  );
}
// One line of the invitation: an icon and a name, then its choice.
export function Row({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ivt-row">
      <span className="ivt-setting-label">
        {icon} {label}
      </span>
      {children}
    </div>
  );
}

// How an agent connects. Tools and Web page take a preset (BrowserInvite);
// Command line takes folders (InviteSheet).
export type Via = "tools" | "page" | "hosted" | "cli";
export const VIA_WORDS: Record<Via, { label: string; description: string }> = {
  tools: {
    label: "Tools",
    description: "Fastest. One command in its terminal; works as an MCP server.",
  },
  page: {
    label: "Web page",
    description: "For an agent with only a browser: your live screen. Slower.",
  },
  hosted: {
    label: "Hosted",
    description: "For claude.ai, ChatGPT, Muse or Grok: a URL you add as a custom MCP connector.",
  },
  cli: {
    label: "Command line",
    description: "Read, edit or run commands in folders you pick.",
  },
};
