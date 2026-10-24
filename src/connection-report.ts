import { readPrivatePeers, type Peer } from "./api";
import { savedBrowserProfile } from "./browser-node";
import { getUpdateState } from "./build-reload";
import { privateWay, tailnetNode } from "./tailnet-transport";

// An explicit allowlist: never serialize a Peer, node status, saved state,
// URL query, invitation or exception into a report copied from the phone.
export function connectionReport(peer: Pick<Peer, "url">) {
  let host = location.hostname;
  try { host = new URL(peer.url).hostname; } catch { /* Use this page's host. */ }
  const count = (way: "native" | "browser") => readPrivatePeers(way).filter(saved => {
    try { return new URL(saved.url).hostname === host; } catch { return false; }
  }).length;
  const asset = document.querySelector('script[type="module"][src]')?.getAttribute("src") || "";
  let state = "not-installed", storedKeys = 0;
  try {
    const value = tailnetNode()?.status().self.state;
    if (value) state = ["Running", "Starting", "Stopped", "NeedsLogin", "NeedsMachineAuth", "NoState"].includes(value) ? value : "unknown";
  } catch { state = "unavailable"; }
  try {
    for (let i = 0; i < localStorage.length; i++)
      if (localStorage.key(i)?.startsWith("reach.tailnet:")) storedKeys++;
  } catch { /* Refused storage contains no usable saved identity. */ }
  return JSON.stringify({
    report: "reach-connection-v1",
    capturedAt: new Date().toISOString(),
    page: { hostname: location.hostname, port: location.port || (location.protocol === "https:" ? "443" : location.protocol === "http:" ? "80" : "none"), standalone: window.matchMedia?.("(display-mode: standalone)").matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true },
    interface: { state: getUpdateState(), module: /^\/assets\/[\w.-]+\.js$/.test(asset) ? asset.slice("/assets/".length) : "unavailable" },
    connection: { mode: privateWay(), nativeSavedPeers: count("native"), browserSavedPeers: count("browser"), browserIdentityComplete: !!savedBrowserProfile(), browserStateKeys: storedKeys, installedBrowserNode: state },
  }, null, 2);
}
