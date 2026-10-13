import type { ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import "./key-tiles.css";

// Keys and app commands as ChatGPT's tools sheet lays them out: rounded
// tiles in a wrapping grid, an icon over a word or two. The exact shortcut
// is the tile's name and tooltip, never printed on it.
export function KeyTile({
  Icon,
  glyph,
  label,
  name,
  shortcut,
  disabled,
  flip = false,
  onClick,
}: {
  Icon?: LucideIcon;
  /** Shown in the icon's place when a key has no icon (F1, A, 7). */
  glyph?: string;
  /** The word or two under the icon; none on a keypad key. */
  label?: string;
  /** What a screen reader says: the label and the shortcut it sends. */
  name: string;
  /** The tooltip: the shortcut as the computer's keyboard writes it. */
  shortcut?: string;
  disabled: boolean;
  /** Mirror the icon (forward delete is backspace's arrow turned around). */
  flip?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`key-tile${flip ? " key-flip" : ""}`}
      aria-label={name}
      title={shortcut}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {Icon ? (
        <Icon aria-hidden="true" />
      ) : (
        <span className="key-glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {label && <span className="key-tile-label">{label}</span>}
    </button>
  );
}

// A section's name, small and quiet, with its one "More" on the right.
export function TileHead({
  id,
  title,
  open,
  controls,
  onToggle,
  children,
}: {
  id: string;
  title: ReactNode;
  open?: boolean;
  controls?: string;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="key-head">
      <h3 id={id}>{title}</h3>
      {children}
      {onToggle && (
        <button
          type="button"
          className="key-more"
          aria-expanded={!!open}
          aria-controls={open ? controls : undefined}
          onClick={onToggle}
        >
          {open ? "Less" : "More"}
          <ChevronDown aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
