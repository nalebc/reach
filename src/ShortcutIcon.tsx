import { useEffect, useRef, useState } from "react";
import { AppWindow, Command, Globe, Terminal } from "lucide-react";
import { request, type Peer } from "./api";
import type { Shortcut } from "./shortcuts";

// Credentials partition the cache so another pairing never reuses its icons.
const cache = new Map<
  string,
  { expires: number; value: Promise<string | null> }
>();
function load(peer: Peer, appId: string) {
  const key = JSON.stringify([peer.url, peer.token, appId]);
  const found = cache.get(key);
  if (found && found.expires > Date.now()) return found.value;
  const value = request<{ icon: string | null }>(
    peer,
    `/api/apps/shortcuts/icon?${new URLSearchParams({ appId })}`,
  ).then(
    ({ icon }) =>
      icon &&
      icon.length < 65536 &&
      /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(icon)
        ? icon
        : null,
    () => null,
  );
  cache.delete(key);
  cache.set(key, { expires: Date.now() + 5 * 60 * 1000, value });
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return value;
}

export default function ShortcutIcon({
  peer,
  shortcut,
  size = 30,
}: {
  peer: Peer;
  shortcut: Shortcut;
  size?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    setIcon(null);
    const appId = shortcut.appId;
    if (!appId || !ref.current) return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load(peer, appId).then((value) => {
          if (active) setIcon(value);
        });
      },
      { rootMargin: "80px" },
    );
    observer.observe(ref.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [peer.url, peer.token, shortcut.appId]);
  const Fallback =
    shortcut.kind === "browser"
      ? Globe
      : shortcut.kind === "terminal"
        ? Terminal
        : shortcut.kind === "codex"
          ? Command
          : AppWindow;
  return (
    <span
      ref={ref}
      className="shortcut-logo"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setIcon(null)}
        />
      ) : (
        <Fallback size={Math.round(size * 0.7)} />
      )}
    </span>
  );
}
