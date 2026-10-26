import { browserHostname, tailnetSuffix, type StartConfig } from "./start-flow";
import { tailnetNode, installTailnet, privateWay, type TailnetNode } from "./tailnet-transport";
import { storageBlocked } from "./storage-fallback";

type NodeEvents = Parameters<TailnetNode["start"]>[0];
const nodeEvents = new WeakMap<TailnetNode, { listeners: Set<NodeEvents>; state: string; url: string; owner: boolean; identity(): boolean }>();
// A retained owner node has one Go startup and any number of removable UI
// observers. Opening setup must not replace the recovery callback or start a
// second node using the same persisted private identity.
function observedNode(node: TailnetNode, owner: boolean, identity: () => boolean) {
  const start = node.start.bind(node);
  const events = { listeners: new Set<NodeEvents>(), state: "", url: "", owner, identity };
  nodeEvents.set(node, events);
  let started = false;
  node.start = listener => {
    events.listeners.add(listener);
    if (started) {
      if (events.state) listener.state(events.state);
      if (events.url) listener.authURL(events.url);
      return;
    }
    started = true;
    start({
      state(state) { events.state = state; if (state === "Running") events.url = ""; for (const item of [...events.listeners]) item.state(state); },
      authURL(url) { events.url = url; for (const item of [...events.listeners]) item.authURL(url); },
      error(kind) { for (const item of [...events.listeners]) item.error?.(kind); },
    });
  };
  return node;
}
export function observeBrowserNode(node: TailnetNode, listener: NodeEvents) {
  const events = nodeEvents.get(node);
  if (!events) throw Error("This browser connection cannot be resumed here. Reopen Reach to continue.");
  events.listeners.add(listener);
  if (events.state) listener.state(events.state);
  if (events.url) listener.authURL(events.url);
  return () => events.listeners.delete(listener);
}
export function browserNodeIdentityCurrent(node: TailnetNode) {
  const events = nodeEvents.get(node);
  return !!events?.owner && events.identity() && !!savedBrowserProfile();
}

type StateStorage = { getState(key: string): string; setState(key: string, value: string): void };
declare global {
  function reachTailnet(config: {
    hostname: string;
    authKey?: string;
    stateStorage: StateStorage;
  }): TailnetNode;
  var Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
}

// Owner and invitation nodes never share a Tailscale identity.
export const browserState = (prefix = "reach.tailnet:") => ({
  getState: (key: string) => {
    try { return localStorage.getItem(`${prefix}${key}`) || ""; } catch { return ""; }
  },
  setState: (key: string, value: string) => {
    try { localStorage.setItem(`${prefix}${key}`, value); } catch { /* Storage may be refused. */ }
  },
});

const scripts = new Map<string, Promise<void>>();
const abortReason = (signal?: AbortSignal) => signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(abortReason(signal)); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function loadScript(src: string, signal?: AbortSignal) {
  let pending = scripts.get(src);
  if (pending) return abortable(pending, signal);
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        script.onload = script.onerror = null;
      };
      const abort = () => { cleanup(); script.remove(); reject(abortReason(signal)); };
      script.onload = () => {
        cleanup();
        if (signal) scripts.set(src, Promise.resolve());
        resolve();
      };
      script.onerror = () => {
        cleanup();
        if (scripts.get(src) === pending) scripts.delete(src);
        reject(Error("The secure connection could not load."));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      document.head.append(script);
    });
    // A cancelled recovery owns only its loader. Cache it after success,
    // so a stalled attempt can retry without cancelling an intentional start.
    if (!signal) scripts.set(src, pending);
  }
  return pending;
}

export async function createBrowserNode(config: StartConfig, {
  signal,
  wasm = fetch(`/tailnet/${config.tailnet!.wasm}`, { signal }),
  guest = false,
  hostname = browserHostname(navigator.userAgent),
  authKey,
  stopped = () => {},
  stateStorage,
  beforeStart = () => true,
}: {
  wasm?: Promise<Response>;
  signal?: AbortSignal;
  guest?: boolean;
  hostname?: string;
  authKey?: string;
  stopped?: () => void;
  stateStorage?: StateStorage;
  beforeStart?: () => boolean;
} = {}) {
  const captured = !guest && !stateStorage ? capturedBrowserState() : null;
  const storage = stateStorage || captured?.state || browserState(guest ? "reach.guest:" : "reach.tailnet:");
  const unchanged = () => beforeStart() && (!captured || captured.unchanged());
  // A loader failure or changed profile can cancel before instantiation.
  // Observe prefetch rejection even then; awaiting it still reports failure.
  void wasm.catch(() => {});
  await loadScript(`/tailnet/${config.tailnet!.exec}`, signal);
  if (signal?.aborted) throw abortReason(signal);
  if (!unchanged()) throw Error("The saved browser connection changed.");
  const go = new Go();
  const { instance } = await abortable(WebAssembly.instantiateStreaming(wasm, go.importObject), signal);
  if (signal?.aborted) throw abortReason(signal);
  if (!unchanged()) throw Error("The saved browser connection changed.");
  void go.run(instance).then(stopped, stopped);
  return observedNode(reachTailnet({
    hostname,
    ...(authKey ? { authKey } : {}),
    stateStorage: storage,
  }), !guest, captured?.unchanged || beforeStart);
}

// Tailscale 1.104's StateStore values are hex-encoded UTF-8 (main.go). A
// profile pointer alone is not a saved device: restoring it would generate
// fresh key material. Require the complete existing persisted identity.
function capturedBrowserState() {
  try {
    const prefix = "reach.tailnet:";
    const read = () => {
      const values = new Map<string, string>();
      let size = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const value = localStorage.getItem(key);
        if (value === null || value.length > 4 * 1024 * 1024 ||
          (size += key.length + value.length) > 16 * 1024 * 1024 || values.size >= 1024)
          throw Error("Incomplete browser identity");
        values.set(key.slice(prefix.length), value);
      }
      return values;
    };
    // Validate exactly the data the runtime will read, including auxiliary
    // preferences. Loading WASM must not reopen a mutable identity provider.
    const values = read();
    const persisted = new Map(values);
    let writable = true;
    const unchanged = () => {
      if (!writable) return false;
      try {
        const current = read();
        if (current.size === persisted.size && [...persisted].every(([key, value]) => current.get(key) === value)) return true;
      } catch { /* Refused storage cannot authorize restoring an identity. */ }
      writable = false;
      return false;
    };
    const state: StateStorage = {
      getState: key => values.get(key) || "",
      setState: (key, value) => {
        const save = unchanged();
        values.set(key, value);
        if (save) {
          try {
            localStorage.setItem(prefix + key, value);
            persisted.set(key, value);
          } catch {
            // A running node may keep its state in memory, but old complete
            // disk state cannot prove its new identity will survive reopening.
            writable = false;
          }
        }
        // Another tab's clear/replacement wins on disk. Retain this node's
        // in-memory state without restoring or overwriting that other choice.
      },
    };
    return { state, unchanged };
  } catch { return null; }
}
function savedBrowserState() {
  try {
    const captured = capturedBrowserState();
    if (!captured) return null;
    const { state, unchanged } = captured;
    const decode = (key: string) => {
      const value = state.getState(key);
      if (value.length > 4 * 1024 * 1024 || !/^(?:[a-f0-9]{2})+$/i.test(value)) throw Error("Incomplete browser identity");
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16)));
    };
    const current = decode("_current-profile");
    const profiles = JSON.parse(decode("_profiles"));
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return null;
    const entry = Object.entries(profiles).find(([, value]: [string, any]) => value?.Key === current && typeof value.NodeID === "string" && value.NodeID);
    const profile = entry?.[1] as Record<string, unknown> | undefined;
    const preferences = JSON.parse(decode(current)).Config;
    const key = (value: unknown) => typeof value === "string" && /^privkey:[a-f0-9]{64}$/i.test(value) && !/^privkey:0{64}$/i.test(value);
    const machine = decode("_machinekey");
    return key(machine) && profile && preferences?.NodeID === profile.NodeID && key(preferences?.PrivateNodeKey)
      ? { profile: current, state, unchanged,
          identity: JSON.stringify([current, entry![0], profile.ID ?? null, profile.Key, profile.NodeID,
            profile.ControlURL ?? null, machine, preferences.PrivateNodeKey, preferences.NodeID]) } : null;
  } catch { return null; }
}
export const savedBrowserProfile = () => savedBrowserState()?.profile || "";

// This is local continuity metadata, never authorization. Legacy approvals
// without a binding need their own explicit approval in setup. Hash only the
// validated identity, so preference writes do not bind an old token to a new
// node; private key material never leaves this closure or enters the record.
export function browserApprovalIdentity() {
  const identity = savedBrowserState()?.identity;
  if (!identity) return null;
  const current = () => savedBrowserState()?.identity === identity;
  let digest: Promise<string> | undefined;
  const binding = async () => {
    if (!current()) throw Error("The saved browser connection changed. Close setup and try again.");
    digest ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode("reach.browser-approval.v1\n" + identity))
      .then(value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join(""));
    const value = await digest;
    if (!current()) throw Error("The saved browser connection changed. Close setup and try again.");
    return value;
  };
  return { current, binding,
    async accepts(peer: { browserIdentity?: unknown }) {
      return typeof peer.browserIdentity === "string" && /^[a-f0-9]{64}$/.test(peer.browserIdentity) &&
        current() && peer.browserIdentity === await binding() && current();
    },
  };
}
const browserLineageKey = "reach.browser.identity-lineage";
// A new setup lineage can inherit old peer records after a reload, but never
// their device binding. The marker is continuity metadata, not authorization.
export async function browserPeerEligible(peer: { browserIdentity?: unknown }): Promise<boolean> {
  try {
    const identity = browserApprovalIdentity();
    if (!identity) return false;
    if (peer.browserIdentity !== undefined) return await identity.accepts(peer);
    return localStorage.getItem(browserLineageKey) === null && identity.current();
  } catch { return false; }
}

type Standby = { profile: string; identity(): boolean; node?: TailnetNode; nodeReady: Promise<TailnetNode>; ready: Promise<TailnetNode | null> };
let standby: Standby | undefined;
type RestorationPhase = "idle" | "identity-unavailable" | "client-unavailable" | "loading-assets" | "starting" | "running" | "needs-login" | "unavailable" | "failed";
type RecoveryNodeState = "none" | "NoState" | "NeedsLogin" | "NeedsMachineAuth" | "Stopped" | "Starting" | "Running" | "InUseOtherUser" | "Unknown" | "Unavailable";
let restorationPhase: RestorationPhase = "idle";
const recoveryNodeState = (node?: TailnetNode | null): RecoveryNodeState => {
  if (!node) return "none";
  try {
    const state = node.status().self.state;
    return ["NoState", "NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", "Running", "InUseOtherUser"].includes(state)
      ? state as RecoveryNodeState : "Unknown";
  } catch { return "Unavailable"; }
};
// Connection diagnostics never expose the profile, node identity, key, URL or
// free-form native errors. This getter cannot start or approve a connection.
export function browserRecoveryStatus(): { phase: RestorationPhase; retained: boolean; nodeState: RecoveryNodeState } {
  const node = tailnetNode() || standby?.node;
  return { phase: restorationPhase, retained: !!node, nodeState: recoveryNodeState(node) };
}
// Only restore an existing approved browser's node. Recovery never calls
// login, redeems an invitation, or registers a new device on the user's behalf.
export function existingBrowserNode(config: StartConfig, { wake = false } = {}): Promise<TailnetNode | null> {
  const running = (node?: TailnetNode | null) => {
    const state = recoveryNodeState(node);
    if (state === "Running") { restorationPhase = "running"; return node!; }
    return null;
  };
  const active = tailnetNode();
  if (active) {
    // A suspended retained node may need its network restored before it can
    // report Running. Waking never signs in or substitutes another identity.
    if (wake) active.wake();
    return Promise.resolve(running(active));
  }
  const saved = savedBrowserState();
  if (!saved) { restorationPhase = "identity-unavailable"; return Promise.resolve(null); }
  if (!config.tailnet) { restorationPhase = "client-unavailable"; return Promise.resolve(null); }
  if (standby) {
    // A changed/cleared identity belongs to the user's newer storage choice.
    // Never construct a competing node or overwrite it from this retained one.
    if (!standby.identity()) return Promise.resolve(null);
    if (wake && standby.node) standby.node.wake();
    if (running(standby.node)) return Promise.resolve(standby.node!);
    return standby.ready.then(running);
  }
  return retainOwnerNode(config, saved).ready;
}

function retainOwnerNode(config: StartConfig,
  saved: NonNullable<ReturnType<typeof capturedBrowserState>> & { profile?: string }, signal?: AbortSignal) {
  const restoring: Standby = {
    profile: saved.profile || "", identity: saved.unchanged,
    nodeReady: Promise.resolve(null as unknown as TailnetNode), ready: Promise.resolve(null),
  };
  restorationPhase = "loading-assets";
  const preload = new AbortController();
  const deadline = setTimeout(() => preload.abort(new DOMException("The browser connection assets did not answer in time.", "TimeoutError")), 8000);
  restoring.nodeReady = createBrowserNode(config, { stateStorage: saved.state, beforeStart: saved.unchanged,
    signal: signal ? AbortSignal.any([preload.signal, signal]) : preload.signal }).finally(() => clearTimeout(deadline));
  restoring.ready = restoring.nodeReady.then(node => {
    restoring.node = node;
    if (standby === restoring) restorationPhase = "starting";
    return new Promise<TailnetNode | null>(resolve => {
      const timer = setTimeout(() => { if (standby === restoring) restorationPhase = "unavailable"; resolve(null); }, 8000);
      const unavailable = (phase: RestorationPhase = "unavailable") => {
        clearTimeout(timer);
        if (standby === restoring) restorationPhase = phase;
        resolve(null);
      };
      node.start({
        state: state => {
          if (state === "Running") { clearTimeout(timer); if (standby === restoring) restorationPhase = "running"; resolve(node); }
          else if (state === "NeedsLogin") unavailable("needs-login");
        },
        authURL: () => unavailable("needs-login"),
        error: () => unavailable(),
      });
    });
  }).catch(() => {
    if (standby === restoring) restorationPhase = preload.signal.aborted ? "unavailable" : "failed";
    // Loading assets can fail before a node exists. A later recovery check
    // may retry those reads, but must retain any identity already constructed.
    if (!restoring.node && standby === restoring) standby = undefined;
    return null;
  });
  standby = restoring;
  return restoring;
}

// Only an explicit setup action may construct a missing owner identity or ask
// it to sign in. It shares the recovery slot, without installing app routing.
export async function setupBrowserNode(config: StartConfig, signal: AbortSignal): Promise<TailnetNode> {
  if (signal.aborted) throw abortReason(signal);
  if (storageBlocked()) throw Error("Allow this site to save data before setting up fallback.");
  if (!config.tailnet) throw Error("Fallback is not ready on this computer. Try again after Reach finishes updating.");
  const saved = savedBrowserState();
  if (!saved) {
    // This must persist before Go can create keys. Keep it after approval so
    // unrelated old records stay ineligible in this new lineage on reload.
    try {
      localStorage.setItem(browserLineageKey, "setup-v1");
      if (localStorage.getItem(browserLineageKey) !== "setup-v1") throw Error();
    } catch { throw Error("Allow this site to save data before setting up fallback."); }
  }
  const active = tailnetNode();
  if (active) {
    const events = nodeEvents.get(active);
    if (!events?.owner) throw Error("Open your own Reach connection before setting up fallback.");
    if (!events.identity()) throw Error("The saved browser connection changed. Reopen Reach to continue.");
    return active;
  }
  if (standby && !standby.identity()) throw Error("The saved browser connection changed. Reopen Reach to continue.");
  if (!standby) {
    const state = saved || capturedBrowserState();
    if (!state) throw Error("Allow this site to save data before setting up fallback.");
    retainOwnerNode(config, state, signal);
  }
  return abortable(standby!.nodeReady, signal);
}


const ownerAuthURLs = new WeakMap<TailnetNode, string>();
const ownerLoginRequested = new WeakSet<TailnetNode>();
const ownerObserved = new WeakSet<TailnetNode>();
export function rememberOwnerBrowserSignIn(node: TailnetNode, url: string) {
  ownerAuthURLs.set(node, url);
  window.dispatchEvent(new Event("reach-owner-browser-state"));
}
// Owner setup shares recovery's retained node and storage lineage. It keeps
// the working native route selected while this browser signs in once.
export async function ownerBrowserNode(config: StartConfig) {
  const node = await setupBrowserNode(config, AbortSignal.timeout(12000));
  if (!tailnetNode()) installTailnet(node, tailnetSuffix(config.origin), privateWay());
  const signIn = () => {
    const url = ownerAuthURLs.get(node) || nodeEvents.get(node)?.url;
    if (node.status().self.state === "NeedsLogin" && !url && !ownerLoginRequested.has(node)) {
      ownerLoginRequested.add(node);
      node.login();
    }
  };
  if (!ownerObserved.has(node)) {
    ownerObserved.add(node);
    observeBrowserNode(node, {
      state(state) {
        if (state === "Running") ownerAuthURLs.delete(node);
        window.dispatchEvent(new Event("reach-owner-browser-state"));
      },
      authURL(url) { rememberOwnerBrowserSignIn(node, url); },
    });
  }
  signIn();
  return { node, authURL: ownerAuthURLs.get(node) || nodeEvents.get(node)?.url || "" };
}
