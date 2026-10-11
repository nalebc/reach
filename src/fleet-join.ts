import { useEffect, useRef, useState } from "react";
import { normalizeUrl, post, request, type Peer } from "./api";

// Your other Reach computers. The computer you're on lists the ones signed in
// to your Tailscale account; linked ones approve this device on a ticket from
// this one (it was approved here already), so they join without a step.

export type FleetComputer = {
  nodeId: string;
  name: string;
  origin: string;
  short: string;
  linked: boolean;
};

export async function listComputers(peer: Peer): Promise<FleetComputer[]> {
  try {
    const { computers } = await request<{ computers: FleetComputer[] }>(
      peer,
      "/api/fleet/computers",
    );
    return Array.isArray(computers)
      ? computers.filter(
          (c) =>
            c &&
            typeof c.origin === "string" &&
            typeof c.name === "string" &&
            typeof c.short === "string",
        )
      : [];
  } catch {
    return []; // An older Reach, or not the owner: nothing to add.
  }
}

type Fetcher = typeof fetch;
const call = async (
  fetcher: Fetcher,
  origin: string,
  route: string,
  body?: unknown,
) => {
  const response = await fetcher(origin + route, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return response.json();
};

// Ask a linked computer for access, with a one-use ticket from the computer
// this device is signed in to: it approves at once when that computer issued
// the ticket to this very device, and refuses otherwise (no request is left
// waiting). Its Tailscale identity alone proves nothing (server/fleet.mjs).
export async function joinComputer(
  origin: string,
  name: string,
  {
    ticket,
    fetcher = fetch,
    waitMs = 8000,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  }: {
    ticket: () => Promise<string>;
    fetcher?: Fetcher;
    waitMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
  },
): Promise<Peer | null> {
  let url: string;
  try {
    url = normalizeUrl(origin);
  } catch {
    return null;
  }
  try {
    const method = await call(fetcher, url, "/api/auth/method");
    if (method?.method !== "tailscale" || !method.eligible) return null;
    const pending = await call(fetcher, url, "/api/auth/requests", {
      name,
      ticket: await ticket(),
    });
    const deadline = now() + waitMs;
    while (now() < deadline) {
      await sleep(700);
      const result = await call(
        fetcher,
        url,
        `/api/auth/requests/${encodeURIComponent(pending.id)}`,
        { secret: pending.secret },
      );
      if (result?.status === "approved" && result.token && result.device?.id)
        return {
          id: result.device.id,
          computerId: result.device.computerId,
          name: String(result.device.name || "Computer"),
          platform: String(result.device.platform || ""),
          url,
          token: result.token,
        };
      if (result?.status !== "pending") return null;
    }
  } catch {}
  return null;
}

const originOf = (u: string) => {
  try {
    return normalizeUrl(u);
  } catch {
    return "";
  }
};

// While you're connected to one computer, bring in the linked others.
// Returns the computers found but not joined (not linked yet), so the
// switcher can show them and say how to link.
export function useFleetJoin(
  peer: Peer | undefined,
  peers: Peer[],
  name: string,
  onJoined: (peer: Peer) => void,
) {
  const [found, setFound] = useState<FleetComputer[]>([]);
  const latest = useRef({ peers, onJoined });
  latest.current = { peers, onJoined };
  const key = peer ? `${peer.url} ${peer.token}` : "";
  useEffect(() => {
    setFound([]);
    if (!peer) return;
    let stopped = false;
    const tried = new Set<string>();
    const run = async () => {
      const computers = await listComputers(peer);
      if (!stopped) setFound(computers);
      for (const c of computers) {
        const origin = originOf(c.origin);
        if (
          stopped ||
          !origin ||
          !c.linked ||
          tried.has(origin) ||
          latest.current.peers.some((p) => originOf(p.url) === origin)
        )
          continue;
        tried.add(origin);
        const joined = await joinComputer(origin, name, {
          ticket: () =>
            post<{ ticket: string }>(peer, "/api/fleet/tickets").then(
              (r) => r.ticket,
            ),
        });
        if (joined && !stopped) latest.current.onJoined(joined);
        // Asleep or unreachable this time: tried again on the next pass.
        else if (!joined) tried.delete(origin);
      }
    };
    void run();
    const timer = setInterval(run, 60000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, name]);
  return found.filter(
    (c) => !peers.some((p) => originOf(p.url) === originOf(c.origin)),
  );
}
