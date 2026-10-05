import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Peer } from "./api";
import { useAppIcon } from "./app-icons";
import "./app-logo.css";

// One observer for every logo on the page, instead of one per logo.
const seen = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;
function watch(element: Element, onVisible: () => void) {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          seen.get(entry.target)?.();
          observer?.unobserve(entry.target);
          seen.delete(entry.target);
        }
    },
    { rootMargin: "160px" },
  );
  seen.set(element, onVisible);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    seen.delete(element);
  };
}

const tones = [
  "#7fb7a0",
  "#8fa8d8",
  "#d0a36c",
  "#c08bb8",
  "#9cc070",
  "#d88a7a",
];
const monogram = (name: string) =>
  (name.match(/[A-Za-z0-9]/g) || ["?"]).slice(0, 1).join("").toUpperCase();

// An installed app's real logo. Until it is known (or on computers that have
// none, like Windows), a fallback icon or an app-shaped monogram stands in.
export default function AppLogo({
  peer,
  appId,
  name,
  size,
  fallback,
}: {
  peer: Peer;
  appId?: string;
  name: string;
  // Pixels; without it the logo fills whatever box CSS gives it.
  size?: number;
  fallback?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!appId || !ref.current) return;
    return watch(ref.current, () => setVisible(true));
  }, [appId]);
  const icon = useAppIcon(peer, appId, visible);
  const tone =
    tones[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % tones.length];
  return (
    <span
      ref={ref}
      className={`app-logo ${icon && !broken ? "has-icon" : ""}`}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      {icon && !broken ? (
        <img
          src={icon}
          alt=""
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : (
        fallback || (
          <span
            className="app-logo-monogram"
            style={{ ["--tone" as string]: tone }}
          >
            {monogram(name)}
          </span>
        )
      )}
    </span>
  );
}
