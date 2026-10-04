export type Peer = {
  id: string;
  computerId?: string;
  tailnetHost?: string;
  pairedAt?: number;
  name: string;
  url: string;
  token: string;
  platform: string;
};
export type Root = { id: number; name: string; path: string };
export type Device = {
  access?: {
    kind: string;
    scopes: string[];
    expiresAt: number;
    profile?: string;
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
export const readPeers = (): Peer[] => {
  try {
    const value = JSON.parse(localStorage.getItem("reach.devices") || "[]");
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
  localStorage.setItem("reach.devices", JSON.stringify(peers));
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
  return u.origin;
}
export async function request<T = any>(
  peer: Peer,
  route: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${peer.token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(peer.url + route, {
    ...options,
    headers,
    redirect: "error",
    signal: options.signal || AbortSignal.timeout(35000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: "This computer could not complete the request.",
    }));
    throw Object.assign(
      Error(
        response.status === 401
          ? "Pair this device again. Its access has expired or was revoked."
          : body.error,
      ),
      { status: response.status },
    );
  }
  return response.json();
}
export const post = <T = any>(peer: Peer, route: string, data: unknown = {}) =>
  request<T>(peer, route, { method: "POST", body: JSON.stringify(data) });
export async function fileBlob(
  peer: Peer,
  path: string,
  root: number,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
) {
  const response = await fetch(
    `${peer.url}/api/files/content?${new URLSearchParams({ path, root: String(root) })}`,
    {
      headers: { Authorization: `Bearer ${peer.token}` },
      redirect: "error",
      signal: options.signal || AbortSignal.timeout(120000),
    },
  );
  if (!response.ok) {
    const e = await response.json();
    throw Error(e.error);
  }
  if (options.maxBytes !== undefined) {
    const limit = options.maxBytes;
    const tooLarge = () =>
      Error(
        "This file is too large to share directly. Download it first, then share from Files or Downloads.",
      );
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (!response.body) throw Error("The file could not be read. Try again.");
    const reader = response.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw tooLarge();
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new Blob(parts, {
      type: response.headers.get("content-type") || "",
    });
  }
  return response.blob();
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
