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
  browser?(wake?: boolean): Promise<{ node: TailnetNode; fetch: typeof fetch } | null>;
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
  let generation = 0, wokenGeneration = -1, wakeRequested = false, nativeLost = false, again = false;
  const nativeRecovered = () => {
    if (nativeLost) generation++;
    nativeLost = false;
  };
  const wakeBrowser = async () => {
    if (lifetime.signal.aborted || wokenGeneration === generation) return null;
    wokenGeneration = generation;
    return await options.browser?.(true) || null;
  };
  const browserForRecovery = async () => {
    if (wakeRequested && wokenGeneration !== generation) {
      wakeRequested = false;
      return wakeBrowser();
    }
    wakeRequested = false;
    // Ordinary polls must let an existing relay finish connecting. Real Go
    // wake closes all DERP connections; repeating it before every probe can
    // keep a slow but eligible private route offline indefinitely.
    const browser = await options.browser?.(false) || null;
    // A bounded asset/startup attempt must release the check before another
    // attempt. The next check revalidates native availability first.
    if (!browser && wokenGeneration !== generation) wakeRequested = true;
    return browser;
  };
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
      nativeRecovered();
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
        nativeRecovered();
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && ![401, 403, 404, 503].includes(status)) return;
        // On a fresh page the public start/closed door answers device 404,
        // just as a running owner's health probe does after native loss.
        // Only the saved browser's own approval below can restore access.
      }
    }
    if (!unchanged()) return;
    nativeLost = true;
    const browser = await browserForRecovery();
    if (!browser || !unchanged()) return;
    let repair = false;
    for (const candidate of candidates) {
      try {
        if ((await read(browser.fetch, candidate.url + "/api/health")).product !== "Reach") continue;
        const device: Device = await read(browser.fetch, candidate.url + "/api/device", candidate.token);
        if (!owner(device) || device.id !== candidate.id ||
          (candidate.computerId && device.computerId !== candidate.computerId)) continue;
        if (!unchanged() || !stillSaved("browser", candidate)) return;
        activate("browser", candidate, device, browser);
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (!status || status === 503) repair = true;
        // Only this saved browser's approved owner identity is eligible.
      }
    }
    if (repair && unchanged() && candidates.some(candidate => stillSaved("browser", candidate))) await wakeBrowser();
  }
  async function check() {
    if (lifetime.signal.aborted) return;
    const current = options.current();
    if (!current) return restoreBrowserOwner();
    if (!current || !owner(current.device) || current.peer.transport === "funnel" || !privateOrigin(current.peer)) return;
    if (awaiting && current.peer.token !== awaiting) return;
    awaiting = "";
    const from = mode();
    const selected = options.selected?.();
    const unchanged = () => {
      const latest = options.current();
      return !lifetime.signal.aborted && latest && owner(latest.device) &&
        latest.device.id === current.device.id && latest.device.computerId === current.device.computerId &&
        scopes(latest.device) === scopes(current.device) && peerKey(latest.peer) === peerKey(current.peer) && mode() === from &&
        peerKey(options.selected?.()) === peerKey(selected);
    };
    for (const peer of [...peers(from), current.peer]) bindPrivatePeer(peer, from);
    if (from === "browser" && wakeRequested) await browserForRecovery();
    if (from === "native") {
      try {
        if ((await read(direct, current.peer.url + "/api/health")).product === "Reach") {
          nativeRecovered();
          return;
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status !== 404 && status !== 503) return;
        // Without the OS route, this same address reaches the public start
        // page (or its closed door), which deliberately returns health 404.
        // That is availability loss, never approval: the other private device
        // must still authenticate its own saved credential and matching scope.
      }
      nativeLost = true;
    }
    if (!unchanged()) return;
    const next: PrivateWay = from === "browser" ? "native" : "browser";
    const candidates = candidatesFor(next, privateOrigin(current.peer)!.hostname);
    if (!candidates.length) return;
    const browser = next === "browser" ? await browserForRecovery() : null;
    if (!unchanged() || (next === "browser" && !browser)) return;
    const fetcher = browser?.fetch || direct;
    let repair = false;
    for (const candidate of candidates) {
      try {
        const device: Device = await read(fetcher, candidate.url + "/api/device", candidate.token);
        if (!owner(device) || device.id !== current.device.id || scopes(device) !== scopes(current.device) ||
          (current.device.computerId && device.computerId !== current.device.computerId)) continue;
        if (!unchanged() || !stillSaved(next, candidate)) return;
        // Keep the old tokens bound before changing the default route. Late
        // callbacks continue on their own device; no token is translated.
        activate(next, candidate, device, browser, current.peer.workspaceKey || peerKey(current.peer));
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (!status || status === 503) repair = true;
        // An unapproved/expired/other device never replaces a working path.
      }
    }
    if (next === "browser" && repair && unchanged() && candidates.some(candidate => stillSaved(next, candidate))) await wakeBrowser();
  }
  const run = () => {
    if (lifetime.signal.aborted) return Promise.resolve();
    if (!running) running = check().finally(() => {
      running = null;
      if (again && !lifetime.signal.aborted) { again = false; void run().catch(() => {}); }
    });
    return running;
  };
  return {
    check: run,
    resume() {
      generation++;
      wakeRequested = true;
      if (running) again = true;
      return run();
    },
    stop() { again = false; lifetime.abort(); },
  };
}

export function watchForApp(config: StartConfig, every = 5000, options?: RecoveryOptions) {
  if (!options) return () => {};
  installPrivateRouting();
  const recovery = createPrivateRecovery(config, options);
  const check = () => { if (!document.hidden) void recovery.check().catch(() => {}); };
  let resumePending = document.hidden;
  const resume = () => {
    if (document.hidden) { resumePending = true; return; }
    if (resumePending) {
      resumePending = false;
      void recovery.resume().catch(() => {});
    } else check();
  };
  const online = () => {
    if (document.hidden) { resumePending = true; return; }
    resumePending = false;
    void recovery.resume().catch(() => {});
  };
  const hidden = () => { resumePending = true; };
  const timer = setInterval(check, every);
  window.addEventListener("online", online);
  window.addEventListener("pagehide", hidden);
  window.addEventListener("pageshow", resume);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  check();
  return () => {
    clearInterval(timer);
    recovery.stop();
    window.removeEventListener("online", online);
    window.removeEventListener("pagehide", hidden);
    window.removeEventListener("pageshow", resume);
    window.removeEventListener("focus", resume);
    document.removeEventListener("visibilitychange", resume);
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
  let configured = false, watching = false, retryAfter = false;
  let pending: Promise<void> | undefined;
  const clearBootstrap = () => {
    clearInterval(timer);
    window.removeEventListener("online", check);
    document.removeEventListener("visibilitychange", check);
  };
  const bootstrap = async () => {
    // This fixed same-origin metadata may need the browser's existing asset
    // door cookie after native loss. It never carries a device credential.
    const value = (knownConfig?.tailnet ? knownConfig : null) || await nativeTailnetFetch("/reach-start.json", {
      cache: "no-store", redirect: "error", credentials: "same-origin", signal: AbortSignal.timeout(5000),
    }).then(response => response.ok ? response.json() : null);
    const config = parseStartConfig(value);
    if (stopped || !config || new URL(config.origin).hostname !== location.hostname) return;
    if (config.tailnet) {
      configured = true;
      clearBootstrap();
      rememberPrivateConfig(config);
    } else if (watching) return;
    // Native selection can run without browser assets, but a null manifest
    // must not latch metadata discovery off permanently. Upgrade that watcher
    // once actual fixed client files become available.
    watching = true;
    stop();
    const prepare = async (wake = false) => {
      const node = await existingBrowserNode(config, { wake });
      if (!node) return null;
      // A standby relay can have been frozen while the phone was away.
      // Restore its network before probing, without starting another node.
      return { node, fetch: ((input, init) => tailnetFetch(node, input, init)) as typeof fetch };
    };
    const current = options.current();
    if (privateWay() === "native" && current && owner(current.device) && readPrivatePeers("browser").length) void prepare();
    stop = watchForApp(config, 5000, { ...options, browser: prepare });
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
