import { guestPeers, readPrivatePeers, peerFromDevice, type Device, type Peer } from "./api";
import { existingBrowserNode } from "./browser-node";
import { setHomeOrigin } from "./home-origin";
import { parseStartConfig, tailnetSuffix, type StartConfig } from "./start-flow";
import {
  bindPrivatePeer, installPrivateRouting, installTailnet, nativeTailnetFetch,
  privatePeerWay, privateWay, tailnetFetch, usePrivateWay,
  type PrivateWay, type TailnetNode,
} from "./tailnet-transport";

export type PrivateHandoff = { mode: PrivateWay; peer: Peer; peers: Peer[]; device: Device };
type Current = { peer: Peer; device: Device };
export type RecoveryOptions = {
  current(): Current | null;
  selected?(): Peer | undefined;
  handoff(change: PrivateHandoff): void;
  mode?(): PrivateWay;
  peers?(mode: PrivateWay): Peer[];
  nativeFetch?: typeof fetch;
  browser?(): Promise<{ node: TailnetNode; fetch: typeof fetch } | null>;
};
let knownConfig: StartConfig | null = null;
export function rememberPrivateConfig(config: StartConfig) { knownConfig = config; }

const owner = (device: Device) => device.access?.kind === "device" && device.access.scopes.includes("admin");
const scopes = (device: Device) => [...(device.access?.scopes || [])].sort().join("\n");
const peerKey = (peer?: Peer) => peer ? JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId]) : "";
const privateOrigin = (peer: Peer) => {
  try {
    const url = new URL(peer.url);
    return url.protocol === "https:" && url.hostname.endsWith(".ts.net") &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" ? url : null;
  } catch { return null; }
};

// Decisions are separate from timers so tests can move both private transports
// deterministically. Probes are reads; an action is never replayed here.
export function createPrivateRecovery(config: StartConfig, options: RecoveryOptions) {
  const direct = options.nativeFetch || nativeTailnetFetch;
  const peers = options.peers || readPrivatePeers;
  const mode = options.mode || privateWay;
  const lifetime = new AbortController();
  let running: Promise<void> | null = null;
  let awaiting = "";
  const read = async (fetcher: typeof fetch, url: string, token?: string) => {
    const response = await fetcher(url, {
      cache: "no-store", redirect: "error", credentials: "omit",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1800)]),
    });
    if (!response.ok) throw Object.assign(Error("Private connection is unavailable."), { status: response.status });
    return response.json();
  };
  const candidatesFor = (next: PrivateWay, hostname: string) => peers(next).filter(peer => peer.transport !== "funnel" &&
    privateOrigin(peer)?.hostname === hostname && (!privatePeerWay(peer) || privatePeerWay(peer) === next));
  const stillSaved = (next: PrivateWay, candidate: Peer) => peers(next).some(saved => peerKey(saved) === peerKey(candidate));
  function activate(next: PrivateWay, candidate: Peer, device: Device,
    browser: { node: TailnetNode; fetch: typeof fetch } | null, workspaceKey?: string) {
    const peer = { ...peerFromDevice(candidate, device), ...(workspaceKey ? { workspaceKey } : {}) };
    for (const saved of peers(next)) bindPrivatePeer(saved, next);
    bindPrivatePeer(peer, next);
    if (browser) installTailnet(browser.node, tailnetSuffix(config.origin), next);
    usePrivateWay(next);
    if (next === "browser") document.documentElement.dataset.connection = "browser";
    else {
      delete document.documentElement.dataset.connection;
      window.dispatchEvent(new Event("reach-tailscale-app-on"));
    }
    setHomeOrigin(peer.url);
    awaiting = peer.token;
    options.handoff({ mode: next, peer, device, peers: peers(next).map(saved => saved.token === candidate.token ? peer : saved) });
  }
  async function restoreBrowserOwner() {
    // A fresh private page can have only a browser approval. Test that
    // identity itself before mounting; a native credential is never reused.
    if (awaiting || mode() !== "native" || guestPeers()) return;
    const selected = options.selected?.();
    if (selected && (selected.transport === "funnel" || privateOrigin(selected)?.hostname !== location.hostname)) return;
    const candidates = candidatesFor("browser", location.hostname);
    if (!candidates.length) return;
    const unchanged = () => !lifetime.signal.aborted && !guestPeers() && !options.current() && mode() === "native" &&
      peerKey(options.selected?.()) === peerKey(selected);
    const native = candidatesFor("native", location.hostname);
    for (const saved of peers("native")) bindPrivatePeer(saved, "native");
    for (const candidate of native) {
      try {
        // Any usable native grant wins, including a deliberately restricted
        // or guest grant. A saved owner alternate must not replace it.
        await read(direct, candidate.url + "/api/device", candidate.token);
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && ![401, 403].includes(status)) return;
      }
    }
    if (!unchanged()) return;
    const browser = await options.browser?.();
    if (!browser || !unchanged()) return;
    for (const candidate of candidates) {
      try {
        if ((await read(browser.fetch, candidate.url + "/api/health")).product !== "Reach") continue;
        const device: Device = await read(browser.fetch, candidate.url + "/api/device", candidate.token);
        if (!owner(device) || device.id !== candidate.id ||
          (candidate.computerId && device.computerId !== candidate.computerId)) continue;
        if (!unchanged() || !stillSaved("browser", candidate)) return;
        activate("browser", candidate, device, browser);
        return;
      } catch { /* Only this saved browser's approved owner identity is eligible. */ }
    }
  }
  async function check() {
    if (lifetime.signal.aborted) return;
    const current = options.current();
    if (!current) return restoreBrowserOwner();
    if (!current || !owner(current.device) || current.peer.transport === "funnel" || !privateOrigin(current.peer)) return;
    if (awaiting && current.peer.token !== awaiting) return;
    awaiting = "";
    const from = mode();
    for (const peer of [...peers(from), current.peer]) bindPrivatePeer(peer, from);
    if (from === "native") {
      try {
        if ((await read(direct, current.peer.url + "/api/health")).product === "Reach") return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status !== 503) return;
        // Only network loss or the explicit availability pause permits trying
        // the other already-approved private device.
      }
    }
    const next: PrivateWay = from === "browser" ? "native" : "browser";
    const candidates = candidatesFor(next, privateOrigin(current.peer)!.hostname);
    if (!candidates.length) return;
    const browser = next === "browser" ? await options.browser?.() || null : null;
    if (next === "browser" && !browser) return;
    const fetcher = browser?.fetch || direct;
    for (const candidate of candidates) {
      try {
        const device: Device = await read(fetcher, candidate.url + "/api/device", candidate.token);
        if (!owner(device) || device.id !== current.device.id || scopes(device) !== scopes(current.device) ||
          (current.device.computerId && device.computerId !== current.device.computerId)) continue;
        const latest = options.current();
        if (lifetime.signal.aborted || !latest || !owner(latest.device) ||
          scopes(latest.device) !== scopes(current.device) || peerKey(latest.peer) !== peerKey(current.peer) || mode() !== from || !stillSaved(next, candidate)) return;
        // Keep the old tokens bound before changing the default route. Late
        // callbacks continue on their own device; no token is translated.
        activate(next, candidate, device, browser, current.peer.workspaceKey || peerKey(current.peer));
        return;
      } catch { /* An unapproved/expired/other device never replaces a working path. */ }
    }
  }
  return {
    check() {
      if (!running) running = check().finally(() => { running = null; });
      return running;
    },
    stop() { lifetime.abort(); },
  };
}

export function watchForApp(config: StartConfig, every = 5000, options?: RecoveryOptions) {
  if (!options) return () => {};
  installPrivateRouting();
  const recovery = createPrivateRecovery(config, options);
  const check = () => { if (!document.hidden) void recovery.check().catch(() => {}); };
  const timer = setInterval(check, every);
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", check);
  check();
  return () => {
    clearInterval(timer);
    recovery.stop();
    window.removeEventListener("online", check);
    document.removeEventListener("visibilitychange", check);
  };
}

// The private page fetches its fixed bootstrap metadata while its OS route is
// healthy. Restore a standby node only when this origin has a saved browser
// profile AND its own separately approved credential. Never start a login.
export function watchPrivateRecovery(options: Pick<RecoveryOptions, "current" | "selected" | "handoff">) {
  let stopped = false;
  let stop = () => {};
  // The owner SPA is also served at deep links; navigation keeps that path.
  // Invitation and agent pages retain their own transport/identity handling.
  if (!location.hostname.endsWith(".ts.net") || /^\/(?:guest|agent|agent-browser)(?:\/|$)/.test(location.pathname)) return stop;
  let configured = false, retryAfter = false;
  let pending: Promise<void> | undefined;
  const clearBootstrap = () => {
    clearInterval(timer);
    window.removeEventListener("online", check);
    document.removeEventListener("visibilitychange", check);
  };
  const bootstrap = async () => {
    const value = knownConfig || await nativeTailnetFetch("/reach-start.json", {
      cache: "no-store", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(5000),
    }).then(response => response.ok ? response.json() : null);
    const config = parseStartConfig(value);
    if (stopped || !config || new URL(config.origin).hostname !== location.hostname) return;
    configured = true;
    clearBootstrap();
    rememberPrivateConfig(config);
    const prepare = async (wake = false) => {
      const node = await existingBrowserNode(config);
      if (!node) return null;
      // A standby relay can have been frozen while the phone was away.
      // Restore its network before probing, without starting another node.
      if (wake) node.wake();
      return { node, fetch: ((input, init) => tailnetFetch(node, input, init)) as typeof fetch };
    };
    const current = options.current();
    if (privateWay() === "native" && current && owner(current.device) && readPrivatePeers("browser").length) void prepare();
    stop = watchForApp(config, 5000, { ...options, browser: () => prepare(true) });
  };
  function check() {
    if (stopped || configured || document.hidden) return;
    if (pending) { retryAfter = true; return; }
    pending = bootstrap().catch(() => {}).finally(() => {
      pending = undefined;
      if (retryAfter) { retryAfter = false; check(); }
    });
  }
  const timer = setInterval(check, 5000);
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", check);
  check();
  return () => { stopped = true; clearBootstrap(); stop(); };
}
