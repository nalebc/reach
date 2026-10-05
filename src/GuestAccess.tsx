import { useEffect, useState } from "react";
import { type Peer } from "./api";
import { ErrorLine } from "./ui";
import { homeOrigin } from "./home-origin";
import { parseGuestLink } from "./start-flow";
import { storageKey, type GuestSession } from "./guest-session";
import MascotIntro from "./MascotIntro";

// The page an invited guest opens (inviting someone is src/InviteSheet.tsx).

// Read once before React mounts; take the invitations out of the address.
const link =
  typeof window === "undefined"
    ? { key: "", hostname: "", invites: [] }
    : parseGuestLink(window.location.hash, homeOrigin());
if (link.invites.length && window.location.pathname === "/guest")
  window.history.replaceState(null, "", "/guest");
async function redeem(
  origin: string,
  secret: string,
): Promise<{ peer: Peer; expiresAt: number }> {
  const response = await fetch(`${origin}/api/guest/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitation: secret }),
    redirect: "error",
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return {
    peer: { ...result.device, url: origin, token: result.token },
    expiresAt: result.expiresAt,
  };
}

// Opening the link accepts the invitation: no extra tap. Then Reach opens
// with what the owner chose, for each computer they invited you to.
export default function GuestAccess({
  onReady,
  ended = false,
}: {
  onReady: (session: GuestSession) => void;
  ended?: boolean;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      const results = await Promise.allSettled(
        link.invites.map((x) => redeem(x.origin, x.secret)),
      );
      const ok = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      if (!ok.length) {
        const first = results.find((r) => r.status === "rejected");
        throw (
          (first as PromiseRejectedResult | undefined)?.reason ||
          Error("This invitation isn't available.")
        );
      }
      const session = {
        peers: ok.map((r) => r.peer),
        expiresAt: Math.min(...ok.map((r) => r.expiresAt)),
      };
      sessionStorage.setItem(storageKey, JSON.stringify(session));
      onReady(session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (link.invites.length && !ended) void accept();
  }, []);
  return (
    <main className="guest-workspace">
      <MascotIntro />
      <header className="guest-header">
        <strong>REACH · Guest access</strong>
      </header>
      <ErrorLine error={error} />
      <section className="panel settings-panel">
        <h1>
          {ended
            ? "Access ended"
            : busy
              ? "Opening your invitation…"
              : "A temporary window into their computer"}
        </h1>
        <p>
          {ended
            ? "You’re disconnected. Ask the owner for a new invitation to reconnect."
            : link.invites.length
              ? "You can use what the owner chose to share, until their deadline."
              : "Open the link the computer’s owner sent you."}
        </p>
        {!ended && link.invites.length > 0 && error && (
          <button className="button primary" disabled={busy} onClick={accept}>
            Try again
          </button>
        )}
      </section>
    </main>
  );
}
