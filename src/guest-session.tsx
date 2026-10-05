import { useEffect, useState } from "react";
import { Clock, LogOut } from "lucide-react";
import { request, type Peer } from "./api";
import "./guest-bar.css";

// An invited guest's access in this tab: which computers, until when.
export type GuestSession = { peers: Peer[]; expiresAt: number };
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
    return value?.expiresAt > Date.now() &&
      peers.length > 0 &&
      peers.every(
        (p) => typeof p?.token === "string" && typeof p?.url === "string",
      )
      ? { peers, expiresAt: value.expiresAt }
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
}: {
  session: GuestSession;
  onEnd: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    document.documentElement.dataset.guest = "1";
    return () => {
      delete document.documentElement.dataset.guest;
    };
  }, []);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const deadline = setTimeout(
      onEnd,
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => {
      clearInterval(clock);
      clearTimeout(deadline);
    };
  }, [session]);
  const remaining = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
  return (
    <div className="guest-bar" role="status">
      <span>
        <Clock size={13} /> Guest ·{" "}
        {remaining >= 3600
          ? `${Math.floor(remaining / 3600)} h ${Math.floor((remaining % 3600) / 60)} min left`
          : remaining >= 60
            ? `${Math.ceil(remaining / 60)} min left`
            : `${remaining} s left`}
      </span>
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
    </div>
  );
}
