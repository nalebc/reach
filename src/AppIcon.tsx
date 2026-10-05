import type { ReactNode } from "react";
import { Monitor, Terminal } from "lucide-react";

// An app-style icon: a rounded square with a soft top light (app-style.css).
// `real` crops a computer's own app icon (or an agent's logo) to fill it.
export function AppIcon({
  tone,
  size,
  real = false,
  className = "",
  children,
}: {
  tone?: string;
  size?: "small" | "large";
  real?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`app-icon ${tone ? `tone-${tone}` : ""} ${size || ""} ${real ? "real" : ""} ${className}`}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

// Platform marks, drawn small and clean.
function AppleMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.37 12.65c-.02-2.16 1.77-3.2 1.85-3.25-1.01-1.47-2.58-1.67-3.13-1.7-1.33-.13-2.6.79-3.28.79-.68 0-1.72-.77-2.83-.75-1.45.02-2.8.85-3.55 2.15-1.52 2.63-.39 6.52 1.09 8.66.72 1.04 1.58 2.21 2.71 2.17 1.09-.04 1.5-.7 2.82-.7 1.31 0 1.69.7 2.84.68 1.17-.02 1.91-1.06 2.63-2.11.83-1.21 1.17-2.38 1.19-2.44-.03-.01-2.28-.87-2.3-3.47ZM14.21 6.31c.6-.73 1-1.74.89-2.75-.86.04-1.91.57-2.53 1.3-.55.64-1.04 1.67-.91 2.66.96.07 1.94-.49 2.55-1.21Z" />
    </svg>
  );
}
function WindowsMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z" />
    </svg>
  );
}

// A computer, as its platform: the Apple mark for a Mac, the Windows mark
// for a PC, a terminal for Linux, a screen otherwise. `online` adds a dot.
export function ComputerIcon({
  platform,
  size,
  online,
}: {
  platform?: string;
  size?: "small" | "large";
  online?: boolean;
}) {
  const glyph = size === "small" ? 17 : size === "large" ? 28 : 24;
  const tone =
    platform === "darwin" ? "mac" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : "computer";
  return (
    <AppIcon tone={tone} size={size}>
      {platform === "darwin" ? (
        <AppleMark size={glyph} />
      ) : platform === "win32" ? (
        <WindowsMark size={glyph - 3} />
      ) : platform === "linux" ? (
        <Terminal size={glyph - 2} strokeWidth={2} />
      ) : (
        <Monitor size={glyph - 2} strokeWidth={2} />
      )}
      {online !== undefined && <i className={`app-icon-dot ${online ? "on" : ""}`} />}
    </AppIcon>
  );
}
