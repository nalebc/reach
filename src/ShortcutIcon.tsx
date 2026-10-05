import { AppWindow, Command, Globe, Terminal } from "lucide-react";
import type { Peer } from "./api";
import type { Shortcut } from "./shortcuts";
import AppLogo from "./AppLogo";

export default function ShortcutIcon({
  peer,
  shortcut,
  size = 30,
}: {
  peer: Peer;
  shortcut: Shortcut;
  size?: number;
}) {
  const Fallback =
    shortcut.kind === "browser"
      ? Globe
      : shortcut.kind === "terminal"
        ? Terminal
        : shortcut.kind === "codex"
          ? Command
          : AppWindow;
  return (
    <AppLogo
      peer={peer}
      appId={shortcut.appId}
      name={shortcut.name}
      size={size}
      fallback={<Fallback size={Math.round(size * 0.7)} />}
    />
  );
}
