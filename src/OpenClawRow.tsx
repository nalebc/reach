import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// OpenClaw's pieces, laid out as the ChatGPT app lays out its own: a row in a
// rounded group (a tinted icon, a name, a word on the right, a chevron) and a
// page top (a round back button, the title in the middle).

export function ClawRow({
  icon,
  tint = "",
  label,
  sub,
  value,
  tone = "",
  onClick,
  ariaLabel,
}: {
  icon: ReactNode;
  tint?: string;
  label: string;
  sub?: ReactNode;
  value?: ReactNode;
  // "action": a blue word to tap (Connect); "alert": something is wrong.
  tone?: "" | "action" | "alert";
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button type="button" className="claw-row" aria-label={ariaLabel} onClick={onClick}>
      <span className={`claw-row-icon ${tint}`} aria-hidden="true">
        {icon}
      </span>
      <span className="claw-row-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
      {value !== undefined && value !== "" && <span className={`claw-row-value ${tone}`}>{value}</span>}
      <ChevronRight size={18} className="claw-row-chevron" aria-hidden="true" />
    </button>
  );
}

export function ClawPageTop({
  title,
  onBack,
  backLabel = "Back",
  action,
}: {
  title: string;
  onBack: () => void;
  backLabel?: string;
  action?: ReactNode;
}) {
  return (
    <header className="claw-page-top">
      <button type="button" className="claw-round" aria-label={backLabel} onClick={onBack}>
        <ChevronLeft size={22} />
      </button>
      <h1>{title}</h1>
      {action || <span className="claw-round-spacer" />}
    </header>
  );
}
