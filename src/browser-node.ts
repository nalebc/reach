import { browserHostname, type StartConfig } from "./start-flow";
import { tailnetNode, type TailnetNode } from "./tailnet-transport";

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
function loadScript(src: string) {
  let pending = scripts.get(src);
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => { scripts.delete(src); reject(Error("The secure connection could not load.")); };
      document.head.append(script);
    });
    scripts.set(src, pending);
  }
  return pending;
}

export async function createBrowserNode(config: StartConfig, {
  wasm = fetch(`/tailnet/${config.tailnet!.wasm}`),
  guest = false,
  hostname = browserHostname(navigator.userAgent),
  authKey,
  stopped = () => {},
  stateStorage = browserState(guest ? "reach.guest:" : "reach.tailnet:"),
  beforeStart = () => true,
}: {
  wasm?: Promise<Response>;
  guest?: boolean;
  hostname?: string;
  authKey?: string;
  stopped?: () => void;
  stateStorage?: StateStorage;
  beforeStart?: () => boolean;
} = {}) {
  // A loader failure or changed profile can cancel before instantiation.
  // Observe prefetch rejection even then; awaiting it still reports failure.
  void wasm.catch(() => {});
  await loadScript(`/tailnet/${config.tailnet!.exec}`);
  if (!beforeStart()) throw Error("The saved browser connection changed.");
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(wasm, go.importObject);
  if (!beforeStart()) throw Error("The saved browser connection changed.");
  void go.run(instance).then(stopped, stopped);
  return reachTailnet({
    hostname,
    ...(authKey ? { authKey } : {}),
    stateStorage,
  });
}

// Tailscale 1.104's StateStore values are hex-encoded UTF-8 (main.go). A
// profile pointer alone is not a saved device: restoring it would generate
// fresh key material. Require the complete existing persisted identity.
function savedBrowserState() {
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
          } catch { /* The running node can keep its state in memory. */ }
        }
        // Another tab's clear/replacement wins on disk. Retain this node's
        // in-memory state without restoring or overwriting that other choice.
      },
    };
    const decode = (key: string) => {
      const value = state.getState(key);
      if (value.length > 4 * 1024 * 1024 || !/^(?:[a-f0-9]{2})+$/i.test(value)) throw Error("Incomplete browser identity");
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16)));
    };
    const current = decode("_current-profile");
    const profiles = JSON.parse(decode("_profiles"));
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return null;
    const profile = Object.values(profiles).find((value: any) => value?.Key === current && typeof value.NodeID === "string" && value.NodeID);
    const preferences = JSON.parse(decode(current)).Config;
    const key = (value: unknown) => typeof value === "string" && /^privkey:[a-f0-9]{64}$/i.test(value) && !/^privkey:0{64}$/i.test(value);
    return key(decode("_machinekey")) && profile && preferences?.NodeID === (profile as { NodeID: string }).NodeID && key(preferences?.PrivateNodeKey)
      ? { profile: current, state, unchanged } : null;
  } catch { return null; }
}
export const savedBrowserProfile = () => savedBrowserState()?.profile || "";

let standby: { profile: string; node?: TailnetNode; ready: Promise<TailnetNode | null> } | undefined;
// Only restore an existing approved browser's node. Recovery never calls
// login, redeems an invitation, or registers a new device on the user's behalf.
export function existingBrowserNode(config: StartConfig): Promise<TailnetNode | null> {
  const running = (node?: TailnetNode | null) => {
    try { return node?.status().self.state === "Running" ? node : null; }
    catch { return null; }
  };
  const active = tailnetNode();
  if (active) return Promise.resolve(running(active));
  const saved = savedBrowserState();
  if (!saved || !config.tailnet) return Promise.resolve(null);
  const { profile } = saved;
  if (standby?.profile === profile) {
    if (running(standby.node)) return Promise.resolve(standby.node!);
    return standby.ready.then(running);
  }
  const restoring: NonNullable<typeof standby> = { profile, ready: Promise.resolve(null) };
  restoring.ready = createBrowserNode(config, { stateStorage: saved.state, beforeStart: saved.unchanged }).then(node => {
    restoring.node = node;
    return new Promise<TailnetNode | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 8000);
      const unavailable = () => { clearTimeout(timer); resolve(null); };
      node.start({
        state: state => {
          if (state === "Running") { clearTimeout(timer); resolve(node); }
          else if (state === "NeedsLogin") unavailable();
        },
        authURL: unavailable,
        error: unavailable,
      });
    });
  }).catch(() => {
    // Loading assets can fail before a node exists. A later recovery check
    // may retry those reads, but must retain any identity already constructed.
    if (!restoring.node && standby === restoring) standby = undefined;
    return null;
  });
  standby = restoring;
  return restoring.ready;
}
