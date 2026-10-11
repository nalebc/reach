import { tailnetBrowser } from "./tailnet-transport";
import { appLink } from "./start-flow";

// How this page reaches the computer: with the Tailscale app (device to
// device, the fastest, at any time), Tailscale running in this browser (no
// app: relayed by Tailscale, slower, and only while the start page can be
// opened), or directly (this computer, --local).
export type ConnectionWay = "app" | "browser" | "direct";
export function connectionWay(url: string): ConnectionWay {
  // The start page marks the page when its own Tailscale node runs (start.ts).
  if (tailnetBrowser() || document.documentElement.dataset.connection === "browser") return "browser";
  try {
    return new URL(url).hostname.endsWith(".ts.net") ? "app" : "direct";
  } catch {
    return "direct";
  }
}
export const connectionName = (url: string) =>
  ({ app: "Tailscale", browser: "Tailscale in browser", direct: "Direct" })[connectionWay(url)];
// The Tailscale app for this phone or computer: App Store, Play, or download.
export const tailscaleAppLink = () => appLink(navigator.userAgent);
