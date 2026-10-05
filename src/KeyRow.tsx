import type { MouseEvent, PointerEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
} from "lucide-react";
import "./key-row.css";

export type RowKey =
  "escape" | "tab" | "left" | "up" | "down" | "right" | "enter";

// The keys a phone keyboard lacks, docked right above it: one row, the same
// in the terminal, on Screen and in apps on the phone. The modifier is
// sticky: tap it, then a letter or a key (ctrl in a terminal, ⌘ on a Mac).
// Pressing a key never takes focus, so the phone keyboard stays open.
export default function KeyRow({
  label,
  modifier,
  armed,
  onArm,
  onKey,
  className = "",
}: {
  label: string;
  modifier: string;
  armed: boolean;
  onArm: (armed: boolean) => void;
  onKey: (key: RowKey) => void;
  className?: string;
}) {
  const keep = (event: PointerEvent | MouseEvent) => event.preventDefault();
  const press = {
    type: "button" as const,
    onPointerDown: keep,
    onMouseDown: keep,
  };
  return (
    <div
      className={`key-row ${className}`}
      role="toolbar"
      aria-label={label}
      data-immersive-keep
    >
      <button {...press} onClick={() => onKey("escape")}>
        esc
      </button>
      <button {...press} onClick={() => onKey("tab")}>
        tab
      </button>
      <button {...press} aria-pressed={armed} onClick={() => onArm(!armed)}>
        {modifier}
      </button>
      <button {...press} aria-label="Left" onClick={() => onKey("left")}>
        <ArrowLeft size={16} />
      </button>
      <button {...press} aria-label="Up" onClick={() => onKey("up")}>
        <ArrowUp size={16} />
      </button>
      <button {...press} aria-label="Down" onClick={() => onKey("down")}>
        <ArrowDown size={16} />
      </button>
      <button {...press} aria-label="Right" onClick={() => onKey("right")}>
        <ArrowRight size={16} />
      </button>
      <button {...press} aria-label="Enter" onClick={() => onKey("enter")}>
        <CornerDownLeft size={16} />
      </button>
    </div>
  );
}
