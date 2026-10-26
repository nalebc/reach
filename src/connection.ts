import { useSyncExternalStore } from "react";
import { tailnetBrowser } from "./tailnet-transport";
import { appLink } from "./start-flow";

// How this page reaches the computer: with the Tailscale app (device to
// device when possible), Tailscale running in this browser (no phone app,
// encrypted private relay), the public link (a guest or agent's invitation,
// through Funnel), or directly (this computer, --local).
export type ConnectionWay = "app" | "browser" | "public" | "direct";
type Route = { url: string; transport?: string };
export function connectionWay(route: Route | string): ConnectionWay {
  const { url, transport } = typeof route === "string" ? { url: route, transport: undefined } : route;
  // Funnel's names end in .ts.net too: the public link first.
  if (transport === "funnel") return "public";
  // The start page marks the page when its own Tailscale node runs (start.ts).
  if (tailnetBrowser() || document.documentElement.dataset.connection === "browser") return "browser";
  try {
    return new URL(url).hostname.endsWith(".ts.net") ? "app" : "direct";
  } catch {
    return "direct";
  }
}
const NAMES: Record<ConnectionWay, string> = {
  app: "Tailscale app",
  browser: "Tailscale in browser",
  public: "Public link",
  direct: "Direct",
};
export const connectionName = (route: Route | string) => NAMES[connectionWay(route)];

// What Settings and More say about it, in a word and a dot: green on the
// preferred private route, amber on a fallback (still encrypted, slower),
// grey when it isn't connected. The word always says it too, not only the
// colour. Reach picks the route itself; this only shows which one.
export type ConnectionTone = "best" | "fallback" | "waiting" | "off";
export type ConnectionState = "connecting" | "connected" | "disconnected" | "denied";
export function connectionStatus(route: Route, state?: ConnectionState): { tone: ConnectionTone; label: string } {
  if (state === "disconnected") return { tone: "off", label: "Offline" };
  if (state === "denied") return { tone: "off", label: "No access" };
  if (state === "connecting") return { tone: "waiting", label: "Connecting…" };
  const way = connectionWay(route);
  return { tone: way === "browser" || way === "public" ? "fallback" : "best", label: NAMES[way] };
}

// The route changes under an open page (app → browser → app) without a new
// peer: follow the page's own mark so the dot never lags a handoff.
const watch = (changed: () => void) => {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-connection"] });
  return () => observer.disconnect();
};
export function useConnectionStatus(route: Route, state?: ConnectionState) {
  useSyncExternalStore(watch, () => document.documentElement.dataset.connection || "");
  return connectionStatus(route, state);
}

// The Tailscale app for this phone or computer: App Store, Play, or download.
export const tailscaleAppLink = () => appLink(navigator.userAgent);
