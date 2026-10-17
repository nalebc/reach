import { browserHostname, type StartConfig } from "./start-flow";
import { tailnetNode, type TailnetNode } from "./tailnet-transport";

declare global {
  function reachTailnet(config: {
    hostname: string;
    authKey?: string;
    stateStorage: { getState(key: string): string; setState(key: string, value: string): void };
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
}: {
  wasm?: Promise<Response>;
  guest?: boolean;
  hostname?: string;
  authKey?: string;
  stopped?: () => void;
} = {}) {
  await loadScript(`/tailnet/${config.tailnet!.exec}`);
  const go = new Go();
  const { instance } = await WebAssembly.instantiateStreaming(wasm, go.importObject);
  void go.run(instance).then(stopped, stopped);
  return reachTailnet({
    hostname,
    ...(authKey ? { authKey } : {}),
    stateStorage: browserState(guest ? "reach.guest:" : "reach.tailnet:"),
  });
}

// Tailscale 1.104's StateStore values are hex-encoded UTF-8 (main.go). A
// profile pointer alone is not a saved device: restoring it would generate
// fresh key material. Require the complete existing persisted identity.
export function savedBrowserProfile(): string {
  try {
    const state = browserState();
    const decode = (key: string) => {
      const value = state.getState(key);
      if (value.length > 4 * 1024 * 1024 || !/^(?:[a-f0-9]{2})+$/i.test(value)) throw Error("Incomplete browser identity");
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16)));
    };
    const current = decode("_current-profile");
    const profiles = JSON.parse(decode("_profiles"));
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return "";
    const profile = Object.values(profiles).find((value: any) => value?.Key === current && typeof value.NodeID === "string" && value.NodeID);
    const persisted = JSON.parse(decode(current)).Config;
    const key = (value: unknown) => typeof value === "string" && /^privkey:[a-f0-9]{64}$/i.test(value) && !/^privkey:0{64}$/i.test(value);
    return key(decode("_machinekey")) && profile && persisted?.NodeID === (profile as { NodeID: string }).NodeID && key(persisted?.PrivateNodeKey) ? current : "";
  } catch { return ""; }
}

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
  const profile = savedBrowserProfile();
  if (!profile || !config.tailnet) return Promise.resolve(null);
  if (standby?.profile === profile) {
    if (running(standby.node)) return Promise.resolve(standby.node!);
    return standby.ready.then(running);
  }
  const restoring: NonNullable<typeof standby> = { profile, ready: Promise.resolve(null) };
  restoring.ready = createBrowserNode(config).then(node => {
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
