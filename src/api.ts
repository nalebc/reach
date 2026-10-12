import { agentRequestTimeout } from "../server/agent-transport.mjs";
export type Peer = {
  id: string;
  computerId?: string;
  tailnetHost?: string;
  pairedAt?: number;
  name: string;
  url: string;
  token: string;
  platform: string;
  transport?: "funnel";
  sessionId?: string;
};
export type Root = { id: number; name: string; path: string };
export type Device = {
  access?: {
    kind: string;
    scopes: string[];
    expiresAt: number;
    profile?: string;
    fullControlVersion?: number;
  };
  id: string;
  computerId?: string;
  name: string;
  platform: string;
  arch: string;
  release: string;
  roots: Root[];
  memory: { total: number; free: number };
  uptime: number;
  network: {
    connected: boolean;
    hostname?: string;
    ips?: string[];
    peers: { name: string; hostname: string; os: string; online: boolean }[];
  };
  capabilities: {
    files: boolean;
    terminal: boolean;
    apps: boolean;
    screen: boolean;
    screenSupported?: boolean;
    codex: boolean;
  };
  tools?: { codex?: { installed: boolean } };
  // Reach is paused on the computer (src/pause.ts).
  paused?: boolean;
  host?: {
    screenRecording: boolean;
    accessibility: boolean;
    updatedAt: string;
  } | null;
};
export type AgentRequest = {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
};
export type FileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modified: string;
};
export type Session = {
  id: string;
  name: string;
  cwd: string;
  status: string;
  createdAt: string;
  /** Terminals: last lines printed, or null while a full-screen program runs. */
  preview?: string[] | null;
};
export type Activity = { id: string; kind: string; title: string; at: string };
export type ChatItem = {
  id: string;
  type: string;
  text?: string;
  content?: { type: string; text?: string }[];
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  changes?: { path: string; diff?: string }[];
  tool?: string;
  summary?: string[];
};
export type Approval = {
  id: number | string;
  method: string;
  params: {
    command?: string;
    reason?: string;
    questions?: {
      id: string;
      header: string;
      question: string;
      options?: { label: string; description: string }[];
    }[];
  };
};
export type Chat = Session & {
  items: ChatItem[];
  approvals: Approval[];
  error?: string | null;
  updatedAt: string;
};
// An invited guest's computers live in this tab only, never in the saved list.
type GuestHolder = { __reachGuestPeers?: Peer[] };
export const guestPeers = () => (globalThis as GuestHolder).__reachGuestPeers;
export const setGuestPeers = (peers: Peer[] | undefined) => {
  (globalThis as GuestHolder).__reachGuestPeers = peers;
};
// One address, two ways in: with the Tailscale app on, or signed in from this
// browser (src/start.ts). Each is its own Tailscale device, approved on its
// own (credentials are bound to the device), so each keeps its own saved
// computers: turning the app on or off never asks for approval again.
const way = () =>
  typeof document !== "undefined" &&
  document.documentElement.dataset.connection === "browser"
    ? "reach.browser."
    : "reach.";
export const peersKey = () => `${way()}devices`;
export const activeKey = () => `${way()}active`;
// Before, this address (no port) only ever ran the browser way, so what it
// saved belongs to that way: moved once, it keeps working, and the app way
// starts at Connect instead of on a credential its device can't use.
export function separateWays(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  where: { port: string; hostname: string },
) {
  if (
    where.port ||
    !where.hostname.endsWith(".ts.net") ||
    storage.getItem("reach.ways")
  )
    return;
  for (const name of ["devices", "active"]) {
    const value = storage.getItem(`reach.${name}`);
    if (value !== null && storage.getItem(`reach.browser.${name}`) === null)
      storage.setItem(`reach.browser.${name}`, value);
    storage.removeItem(`reach.${name}`);
  }
  storage.setItem("reach.ways", "1");
}
try {
  separateWays(localStorage, location);
} catch {
  /* no storage here (private mode): nothing to move */
}
export const readPeers = (): Peer[] => {
  if (guestPeers()) return guestPeers()!;
  try {
    const value = JSON.parse(localStorage.getItem(peersKey()) || "[]");
    return Array.isArray(value)
      ? value.filter(
          (p): p is Peer =>
            !!p &&
            ["id", "name", "url", "token", "platform"].every(
              (key) => typeof p[key] === "string",
            ) &&
            !!p.id &&
            !!p.token,
        )
      : [];
  } catch {
    return [];
  }
};
export function savePeers(peers: Peer[]) {
  if (guestPeers()) return setGuestPeers(peers);
  localStorage.setItem(peersKey(), JSON.stringify(peers));
}
const endpoint = (peer: Peer) => {
  try {
    return normalizeUrl(peer.url);
  } catch {
    return "";
  }
};
const tailnetHost = (host?: string) => {
  const normalized = host?.toLowerCase().replace(/\.$/, "");
  return normalized && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(normalized)
    ? normalized
    : "";
};
export function sameComputer(a: Peer, b: Peer) {
  if (a.computerId && b.computerId) return a.computerId === b.computerId;
  if (a.id === b.id) return true;
  if (endpoint(a) && endpoint(a) === endpoint(b)) return true;
  // Only authenticated device responses can supply this alias; never a display name.
  const knownHost = (peer: Peer) => {
    if (tailnetHost(peer.tailnetHost)) return tailnetHost(peer.tailnetHost);
    try {
      return tailnetHost(new URL(endpoint(peer)).hostname);
    } catch {
      return "";
    }
  };
  const aHost = knownHost(a),
    bHost = knownHost(b);
  return !!aHost && aHost === bHost;
}
export function upsertPeer(peers: Peer[], incoming: Peer): Peer[] {
  const first = peers.findIndex((p) => sameComputer(p, incoming));
  if (first < 0) return [...peers, incoming];
  const result = peers.filter((p) => !sameComputer(p, incoming));
  result.splice(first, 0, incoming);
  return result;
}
export function compactPeers(peers: Peer[]): Peer[] {
  // Legacy pairings were appended, so the last matching entry is the latest.
  return peers.reduce((result, peer) => upsertPeer(result, peer), [] as Peer[]);
}
export function peerFromDevice(peer: Peer, device: Device): Peer {
  if (
    !device ||
    !device.id ||
    [device.id, device.name, device.platform].some((v) => typeof v !== "string")
  )
    throw Error("Invalid device response.");
  return {
    ...peer,
    id: device.id,
    computerId: device.computerId || peer.computerId,
    name: device.name,
    platform: device.platform,
    tailnetHost: tailnetHost(device.network?.hostname) || peer.tailnetHost,
  };
}
export async function reconcilePeers(
  peers: Peer[],
  inspect: (peer: Peer) => Promise<Device>,
): Promise<Peer[]> {
  const checked = await Promise.all(
    peers.map(async (peer) => {
      try {
        return {
          peer: peerFromDevice(peer, await inspect(peer)),
          reachable: true,
        };
      } catch {
        return { peer, reachable: false };
      }
    }),
  );
  // A successfully authenticated connection wins over stale/expired credentials.
  // Inspect every legacy entry before compacting, so a working token is not lost.
  return compactPeers(
    [
      ...checked.filter((p) => !p.reachable),
      ...checked.filter((p) => p.reachable),
    ].map((p) => p.peer),
  );
}
export function normalizeUrl(input: string) {
  const u = new URL(input);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["/", ""].includes(u.pathname)
  )
    throw Error("Enter the computer’s address without a path.");
  if (
    u.protocol !== "https:" &&
    !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))
  )
    throw Error("Use the HTTPS link shown by Reach on your computer.");
  // Your computers are on your tailnet: a credential never goes to an address
  // outside it, as QR codes and invitations already require (connections
  // audit, Oct 10).
  if (u.protocol === "https:" && !/\.ts\.net$/i.test(u.hostname))
    throw Error("Use your computer's Tailscale address, ending in .ts.net.");
  return u.origin;
}
// Funnel sessions sign only their own requests. Owner and tailnet peers retain
// their existing transport and never inherit a browser agent's credentials.
export async function peerFetch(
  peer: Peer,
  route: string,
  options: RequestInit = {},
) {
  if (peer.transport === "funnel") {
    const { funnelFetch } = await import("./funnel-agent");
    return funnelFetch(peer, route, options);
  }
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${peer.token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  return fetch(peer.url + route, {
    ...options,
    headers,
    redirect: "error",
    signal: options.signal || AbortSignal.timeout(agentRequestTimeout(route, (options.method || "GET").toUpperCase())),
  });
}
export async function request<T = any>(
  peer: Peer,
  route: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await peerFetch(peer, route, options).catch((e: Error) => {
    // The browser's own words ("Failed to fetch", "Load failed") said
    // nothing; a cancel stays a cancel.
    const where = peer.platform === "darwin" ? "Mac" : "computer";
    if (e?.name === "TimeoutError") throw Object.assign(Error(`Your ${where} didn't answer in time. Try again.`), { cause: e });
    if (e?.name === "TypeError") throw Object.assign(Error(`Couldn't reach your ${where}. Check the connection and try again.`), { cause: e });
    throw e;
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: "This computer could not complete the request.",
    }));
    throw Object.assign(
      Error(
        response.status === 401
          ? "Pair this device again. Its access has expired or was revoked."
          : body?.error || "This computer could not complete the request.",
      ),
      // `body`: the rest of the answer (who controls the screen, for one).
      { status: response.status, body },
    );
  }
  return response.json();
}
export const post = <T = any>(peer: Peer, route: string, data: unknown = {}) =>
  request<T>(peer, route, { method: "POST", body: JSON.stringify(data) });
// Gives up only when nothing arrives for this long, not after a fixed total:
// a large file over a slow link can take many minutes.
const IDLE_MS = 45000;
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort);
  });
// Wait for a network before retrying. (A phone pauses the whole app while
// it's in the background, so retries resume by themselves when it's back; a
// computer keeps transferring in a background tab.)
export const whenReachable = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (typeof window === "undefined") return resolve();
    const cleanup = () => {
      window.removeEventListener("online", check);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const check = () => {
      if (navigator.onLine === false) return;
      cleanup();
      resolve();
    };
    signal?.addEventListener("abort", abort);
    window.addEventListener("online", check);
    check();
  });
export const retryable = (e: unknown) => {
  const status = (e as { status?: number })?.status;
  return !status || status >= 500 || status === 408 || status === 429;
};

// A file's bytes, resuming where a dropped connection stopped (only if the
// file is unchanged: If-Range), with progress as it arrives.
export async function fileBlob(
  peer: Peer,
  path: string,
  root: number,
  options: {
    signal?: AbortSignal;
    maxBytes?: number;
    onProgress?: (received: number, total: number) => void;
  } = {},
) {
  const route = `/api/files/content?${new URLSearchParams({ path, root: String(root) })}`;
  const url = peer.url + route;
  const limit = options.maxBytes ?? Infinity;
  const tooLarge = () =>
    Object.assign(
      Error(
        "This file is too large to share directly. Download it first, then share from Files or Downloads.",
      ),
      { status: 413 },
    );
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let received = 0,
    total = 0,
    etag = "",
    type = "",
    failures = 0;
  while (true) {
    // The caller's signal cancels the request. Nothing arriving for a while
    // aborts it too, both before headers and while reading the stream.
    const idle = new AbortController();
    let reader:
      ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    const cancel = () => {
      idle.abort(options.signal?.aborted ? options.signal.reason : undefined);
      void reader?.cancel().catch(() => {});
    };
    let timer = setTimeout(cancel, IDLE_MS);
    options.signal?.addEventListener("abort", cancel);
    const signal = idle.signal;
    try {
      if (options.signal?.aborted) cancel();
      if (signal.aborted) throw signal.reason;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${peer.token}`,
      };
      if (received && etag) {
        headers.Range = `bytes=${received}-`;
        headers["If-Range"] = etag;
      }
      const response = peer.transport === "funnel"
        ? await peerFetch(peer, route, { headers, signal })
        : await fetch(url, { headers, redirect: "error", signal });
      if (!response.ok) {
        const e = await response.json().catch(() => ({}));
        throw Object.assign(
          Error(e.error || "This computer could not complete the request."),
          { status: response.status },
        );
      }
      // Changed since the first part (or no resume support): start over.
      if (received && response.status !== 206) {
        parts.length = 0;
        received = 0;
      }
      etag = response.headers.get("etag") || etag;
      type = type || response.headers.get("content-type") || "";
      const length = Number(response.headers.get("content-length")) || 0;
      total = response.status === 206 ? received + length : length;
      if (total > limit) {
        await response.body?.cancel();
        throw tooLarge();
      }
      if (!response.body) throw Error("The file could not be read. Try again.");
      reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(timer);
          timer = setTimeout(cancel, IDLE_MS);
          received += value.byteLength;
          if (received > limit) {
            await reader.cancel();
            throw tooLarge();
          }
          parts.push(value);
          failures = 0;
          options.onProgress?.(received, total);
        }
      } finally {
        reader.releaseLock();
      }
      clearTimeout(timer);
      if (signal.aborted) throw signal.reason;
      // The connection closed early (or stalled): carry on from here.
      if (total && received < total) throw Error("The download was cut short.");
      return new Blob(parts, { type });
    } catch (e) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (options.signal?.aborted || !retryable(e) || ++failures > 6) {
        if (failures > 6)
          throw Error(
            "The download stopped. Check that both devices are online, then try again.",
          );
        throw e;
      }
      await whenReachable(options.signal);
      await pause(Math.min(15000, 1000 * 2 ** (failures - 1)), options.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
}
export const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1073741824
        ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(1)} GB`;
export const platform = (p: string) =>
  ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[p] || p;
