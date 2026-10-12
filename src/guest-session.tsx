import { useEffect, useRef, useState, type ReactNode } from "react";
import { Clock, LogOut } from "lucide-react";
import { request, type Peer } from "./api";
import "./guest-bar.css";

// An invited guest's access in this tab: which computers, until when.
export type GuestSession = { peers: Peer[]; expiresAt: number; invitationId?: string };
// Provenance is only a comparison key, never a credential. Enrollment keys
// and device names are deliberately excluded; link order does not matter.
export async function guestInvitationId(invites: { origin: string; secret: string }[]): Promise<string | undefined> {
  if (!invites.length) return undefined;
  const canonical = invites.map(({ origin, secret }) => [origin, secret])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const storageKey = "reach.guest-session";
// This tab's guest access: the computers it was invited to, and the deadline.
export function savedGuestSession(): GuestSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    const peers: Peer[] = Array.isArray(value?.peers)
      ? value.peers
      : value?.peer
        ? [value.peer]
        : [];
    // The owner may have extended this grant while the tab was closed.
    // Restore only to verify it with the server; local time isn't authority.
    return Number.isFinite(value?.expiresAt) && value.expiresAt + 86400000 > Date.now() &&
      peers.length > 0 &&
      peers.every(
        (p) => typeof p?.token === "string" && typeof p?.url === "string",
      )
      ? { peers, expiresAt: value.expiresAt,
          ...(typeof value.invitationId === "string" && /^[a-f0-9]{64}$/.test(value.invitationId)
            ? { invitationId: value.invitationId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
export const forgetGuestSession = () => sessionStorage.removeItem(storageKey);

// While a guest uses Reach: the time left, and a way to leave now.
export function GuestBar({
  session,
  onEnd,
  onLost,
  always = false,
}: {
  session: GuestSession;
  onEnd: () => void;
  // Its access check was refused: what that means is the page's to find out
  // (an agent's page reconnects). Without it, the same as leaving.
  onLost?: () => void;
  // An agent with Always access: no countdown, and no Leave, which would end
  // its access for good (closing the tab is enough).
  always?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const [expiresAt, setExpiresAt] = useState(session.expiresAt);
  const ended = useRef(onLost || onEnd);
  ended.current = onLost || onEnd;
  const peersKey = session.peers.map((peer) => `${peer.url}:${peer.token}`).join("|");
  useEffect(() => {
    document.documentElement.dataset.guest = "1";
    return () => {
      delete document.documentElement.dataset.guest;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    let nextCheck = 0;
    let deadline = session.expiresAt;
    const refresh = async () => {
      if (checking) return;
      checking = true;
      try {
        const results = await Promise.allSettled(session.peers.map((peer) =>
          request<{ access?: { expiresAt: number } }>(peer, "/api/device", { signal: controller.signal }),
        ));
        if (controller.signal.aborted) return;
        const ends = results.flatMap((result) => result.status === "fulfilled" && Number.isFinite(result.value.access?.expiresAt) ? [result.value.access!.expiresAt] : []);
        if (ends.length) {
          deadline = Math.max(...ends);
          setExpiresAt(deadline);
          if (session.peers.every((peer) => peer.transport !== "funnel"))
            sessionStorage.setItem(storageKey, JSON.stringify({ ...session, expiresAt: deadline }));
        } else if (results.every((result) => result.status === "rejected" && result.reason?.status === 401))
          ended.current();
      } finally {
        checking = false;
        nextCheck = Date.now() + 10000;
      }
    };
    void refresh();
    const clock = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= nextCheck || (time >= deadline && deadline > time - 1000)) void refresh();
    }, 1000);
    return () => { controller.abort(); clearInterval(clock); };
  }, [peersKey]);
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return (
    <div className="guest-bar" role="status">
      <span>
        <Clock size={13} /> Guest ·{" "}
        {always ? "Until the owner ends it" : remaining >= 2 * 86400
          ? `${Math.floor(remaining / 86400)} days left`
          : remaining >= 3600
          ? `${Math.floor(remaining / 3600)} h ${Math.floor((remaining % 3600) / 60)} min left`
          : remaining >= 60
            ? `${Math.ceil(remaining / 60)} min left`
            : remaining > 0 ? `${remaining} s left` : "Checking access…"}
      </span>
      {!always && (
        <button
          onClick={async () => {
            await Promise.allSettled(
              session.peers.map((peer) =>
                request(peer, "/api/device/access", { method: "DELETE" }),
              ),
            );
            onEnd();
          }}
        >
          <LogOut size={13} /> Leave
        </button>
      )}
    </div>
  );
}

// A person who opened their invitation while an agent was using the Mac
// waits for the owner's Allow (server: macEntry). This page waits with them
// and comes in on its own once allowed.
export function WaitForOwner({ peer, children }: { peer: Peer; children: ReactNode }) {
  const key = `${peer.url}:${peer.token}`;
  const [result, setResult] = useState<{ key: string; state: "checking" | "waiting" | "retrying" | "in" }>({ key, state: "checking" });
  const state = result.key === key ? result.state : "checking";
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const setState = (state: typeof result.state) => setResult({ key, state });
    setState("checking");
    const check = async () => {
      try {
        await request(peer, "/api/device", { signal: controller.signal });
        if (!controller.signal.aborted) setState("in");
      } catch (error) {
        if (controller.signal.aborted) return;
        const failed = error as { status?: number; body?: { waiting?: boolean } };
        const waiting = failed?.body?.waiting === true;
        const retry = waiting || !failed?.status || failed.status === 408 || failed.status === 429 || failed.status >= 500;
        // A dropped response is not approval. Keep polling; permanent
        // refusals go to the workspace's existing ended-access message.
        setState(waiting ? "waiting" : retry ? "retrying" : "in");
        if (retry) timer = setTimeout(() => void check(), 3000);
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);
  if (state === "in") return <>{children}</>;
  return (
    <main className="guest-workspace">
      <p role="status">
        {state === "waiting" ? "Waiting for the owner to let you in…" : state === "retrying" ? "Connection interrupted. Checking access again…" : "Opening…"}
      </p>
    </main>
  );
}
