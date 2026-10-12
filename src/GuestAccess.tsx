import { useEffect, useRef, useState } from "react";
import { type Peer } from "./api";
import { ErrorLine } from "./ui";
import { homeOrigin } from "./home-origin";
import { parseGuestLink } from "./start-flow";
import { guestInvitationId, storageKey, type GuestSession } from "./guest-session";
import MascotIntro from "./MascotIntro";
import "./agent-admissions.css";

// Read the one-time link once, then take its secrets out of the address bar.
const link =
  typeof window === "undefined"
    ? { key: "", hostname: "", invites: [] }
    : parseGuestLink(window.location.hash, homeOrigin());
if (link.invites.length && window.location.pathname === "/guest")
  window.history.replaceState(null, "", "/guest");

type Accepted = { peer: Peer; expiresAt: number };
type ClaimReceipt = {
  origin: string;
  requestId: string;
  requestSecret: string;
  verificationCode: string;
  expiresAt: number;
  clientId: string;
  device: { id: string; name: string; platform: string; computerId?: string };
};
type Redemption = { accepted: Accepted } | { receipt: ClaimReceipt };
type ClaimStatus = {
  status: "pending" | "denied" | "expired" | "approved";
  verificationCode?: string;
  expiresAt?: number;
  token?: string;
  device?: ClaimReceipt["device"];
};
// A waiting agent's receipts, with the secret that collects the owner's
// answer, live in this page's memory only, never in storage; so does the
// invitation (CodeQL #138-#140). They outlive the waiting view being
// unmounted and mounted again, not a reload: the link was spent when it was
// opened, so an agent that reloads while waiting needs a new invitation from
// the owner, and the request it left expires on the owner's side within five
// minutes. Receipts an older Reach saved in this tab are deleted.
export const claimStorageKey = "reach.agent-admission-receipts";
try { sessionStorage.removeItem(claimStorageKey); } catch { /* no storage */ }
let receipts: ClaimReceipt[] = [];
const invitationSource = link.invites;
let identityPromise: Promise<string | undefined> | undefined;
const invitationIdentity = () => identityPromise ||= guestInvitationId(invitationSource);

const other = (receipt: ClaimReceipt) => (r: ClaimReceipt) =>
  r.origin !== receipt.origin || r.requestId !== receipt.requestId;
function saveReceipt(receipt: ClaimReceipt) {
  receipts = [...receipts.filter(other(receipt)), receipt];
}
function removeReceipt(receipt: ClaimReceipt) {
  receipts = receipts.filter(other(receipt));
}
const requestError = (response: Response, body: { error?: string }) =>
  Object.assign(Error(body.error || "This invitation could not be opened."), {
    status: response.status,
  });
// StrictMode can replay effects while a one-use redemption or token delivery is
// in flight. Share that request; only UI timers are cancelled on unmount.
const redemptions = new Map<string, Promise<Redemption>>();
// Only deliveries from this page's invitation belong together. Persist each
// before a component can unmount or another invited computer can stall.
const deliveredPeople = new Map<string, Accepted>();
const claims = new Map<string, Promise<ClaimStatus>>();
function redeem(origin: string, secret: string): Promise<Redemption> {
  const key = `${origin}:${secret}`;
  const existing = redemptions.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<Redemption> => {
    const invitationId = await invitationIdentity();
    const response = await fetch(`${origin}/api/guest/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitation: secret }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw requestError(response, result);
    if (response.status === 202 && result.status === "pending") {
      const receipt: ClaimReceipt = {
        origin,
        requestId: result.requestId,
        requestSecret: result.requestSecret,
        verificationCode: result.verificationCode,
        expiresAt: result.expiresAt,
        clientId: result.clientId,
        device: result.device,
      };
      if (
        !receipt.requestId ||
        !receipt.requestSecret ||
        !/^\d{6}$/.test(receipt.verificationCode) ||
        !Number.isFinite(receipt.expiresAt) ||
        !receipt.device?.name
      )
        throw Error(
          "The connection request could not be saved. Ask the owner for a new invitation.",
        );
      saveReceipt(receipt);
      return { receipt };
    }
    if (
      typeof result.token !== "string" ||
      !result.token ||
      !result.device ||
      !Number.isFinite(result.expiresAt)
    )
      throw Error("This invitation did not grant access.");
    const accepted: Accepted = {
      peer: { ...result.device, url: origin, token: result.token },
      expiresAt: result.expiresAt,
    };
    deliveredPeople.set(key, accepted);
    const delivered = [...deliveredPeople.values()];
    sessionStorage.setItem(storageKey, JSON.stringify({
      peers: delivered.map(item => item.peer),
      expiresAt: Math.min(...delivered.map(item => item.expiresAt)),
      ...(invitationId ? { invitationId } : {}),
    } satisfies GuestSession));
    return { accepted };
  })();
  redemptions.set(key, promise);
  void promise
    .finally(() => {
      if (redemptions.get(key) === promise) redemptions.delete(key);
    })
    .catch(() => {});
  return promise;
}
function pollClaim(receipt: ClaimReceipt): Promise<ClaimStatus> {
  const key = `${receipt.origin}:${receipt.requestId}:${receipt.requestSecret}`;
  const existing = claims.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<ClaimStatus> => {
    const invitationId = await invitationIdentity();
    const response = await fetch(
      `${receipt.origin}/api/invitations/claims/${encodeURIComponent(receipt.requestId)}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: receipt.requestSecret }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    const result: ClaimStatus = await response.json();
    if (!response.ok)
      throw requestError(response, result as { error?: string });
    if (result.status === "approved") {
      if (!result.token || !result.device || !Number.isFinite(result.expiresAt))
        throw Error(
          "The approved connection could not be received. Ask the owner for a new invitation.",
        );
      // Save a delivered token before any UI can unmount: delivery is one-time.
      const session: GuestSession = {
        peers: [{ ...result.device, url: receipt.origin, token: result.token }],
        expiresAt: result.expiresAt!,
        ...(invitationId ? { invitationId } : {}),
      };
      sessionStorage.setItem(storageKey, JSON.stringify(session));
      removeReceipt(receipt);
    } else if (result.status === "denied" || result.status === "expired")
      removeReceipt(receipt);
    else if (result.status !== "pending")
      throw Error("The connection request returned an unknown status.");
    return result;
  })();
  claims.set(key, promise);
  void promise
    .finally(() => {
      if (claims.get(key) === promise) claims.delete(key);
    })
    .catch(() => {});
  return promise;
}
function waitToPoll(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 2000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

// People join immediately. Invited agents receive no credential or workspace
// until the owner approves the pending connection in Reach.
export default function GuestAccess({
  onReady,
  ended = false,
}: {
  onReady: (session: GuestSession) => void;
  ended?: boolean;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<ClaimReceipt[]>([]);
  const [terminal, setTerminal] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (ended) return;
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    void (async () => {
      const saved = [...receipts];
      if (!saved.length && !link.invites.length) return;
      setBusy(true);
      setError("");
      setTerminal(false);
      try {
        const results = saved.length
          ? saved.map((receipt): PromiseSettledResult<Redemption> => ({
              status: "fulfilled",
              value: { receipt },
            }))
          : await Promise.allSettled(
              link.invites.map((x) => redeem(x.origin, x.secret)),
            );
        if (!live()) return;
        const accepted: Accepted[] = [];
        const pending: ClaimReceipt[] = [];
        const failures: string[] = [];
        for (const r of results) {
          if (r.status === "rejected") failures.push(r.reason.message);
          else if ("accepted" in r.value) accepted.push(r.value.accepted);
          else pending.push(r.value.receipt);
        }
        setWaiting(pending);
        setBusy(false);
        await Promise.all(
          pending.map(async (receipt) => {
            while (live()) {
              if (receipt.expiresAt <= Date.now()) {
                removeReceipt(receipt);
                failures.push(
                  `The connection request for ${receipt.device.name} expired. Ask the owner for a new invitation.`,
                );
                break;
              }
              try {
                const result = await pollClaim(receipt);
                if (!live()) return;
                if (result.status === "approved") {
                  accepted.push({
                    peer: {
                      ...result.device!,
                      url: receipt.origin,
                      token: result.token!,
                    },
                    expiresAt: result.expiresAt!,
                  });
                  break;
                }
                if (result.status === "denied" || result.status === "expired") {
                  failures.push(
                    result.status === "denied"
                      ? `The owner denied this connection to ${receipt.device.name}. Ask for a new invitation.`
                      : `The connection request for ${receipt.device.name} expired. Ask the owner for a new invitation.`,
                  );
                  break;
                }
                setError("");
              } catch (e) {
                if (!live()) return;
                if (
                  [401, 403, 404, 409, 410].includes(
                    (e as { status?: number }).status || 0,
                  )
                ) {
                  removeReceipt(receipt);
                  failures.push(
                    "This connection request is no longer available. Ask the owner for a new invitation.",
                  );
                  break;
                }
                setError(
                  "Connection interrupted. Retrying while the approval request is still valid…",
                );
              }
              await waitToPoll(controller.signal);
            }
            if (live())
              setWaiting((list) =>
                list.filter(
                  (r) =>
                    r.requestId !== receipt.requestId ||
                    r.origin !== receipt.origin,
                ),
              );
          }),
        );
        if (!live()) return;
        if (accepted.length) {
          const invitationId = await invitationIdentity();
          if (!live()) return;
          const session: GuestSession = {
            peers: accepted.map((r) => r.peer),
            expiresAt: Math.min(...accepted.map((r) => r.expiresAt)),
            ...(invitationId ? { invitationId } : {}),
          };
          sessionStorage.setItem(storageKey, JSON.stringify(session));
          ready.current(session);
        } else {
          setTerminal(pending.length > 0);
          setError(failures[0] || "This invitation isn't available.");
        }
      } catch (e) {
        if (live()) setError((e as Error).message);
      } finally {
        if (live()) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [ended, attempt]);
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
            : waiting.length
              ? "Waiting for the owner’s approval"
              : terminal
                ? "Connection not approved"
                : busy
                  ? "Opening your invitation…"
                  : "A temporary window into their computer"}
        </h1>
        <p>
          {ended
            ? "You’re disconnected. Ask the owner for a new invitation to reconnect."
            : waiting.length
              ? "The owner must approve this first connection in Reach. No files, terminal output, or screen access is available yet."
              : terminal
                ? "No access was granted. Ask the owner for a new invitation."
                : link.invites.length
                  ? "You can use what the owner chose to share, until their deadline."
                  : "Open the link the computer’s owner sent you."}
        </p>
        {waiting.map((receipt) => (
          <article
            key={`${receipt.origin}:${receipt.requestId}`}
            className="agent-admission-waiting"
            aria-label={`Waiting for approval on ${receipt.device.name}`}
          >
            <strong>{receipt.device.name}</strong>
            <p>
              Tell the owner to compare this verification code in Reach before
              approving your connection.
            </p>
            <output
              className="agent-verification-code"
              aria-label="Verification code"
            >
              {receipt.verificationCode}
            </output>
            <small>
              Request expires {new Date(receipt.expiresAt).toLocaleTimeString()}
              . Keep this tab open and don’t reload it; approval appears here
              automatically.
            </small>
          </article>
        ))}
        {!ended &&
          !terminal &&
          !waiting.length &&
          link.invites.length > 0 &&
          error && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          )}
      </section>
    </main>
  );
}
