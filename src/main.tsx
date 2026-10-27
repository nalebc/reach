import "./abort-polyfill";
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ScreenBoundary from "./ScreenBoundary";
import App from "./App";
import TransferTray from "./TransferTray";
import { Spinner } from "./ui";
import { request, setGuestPeers, type Device, type Peer } from "./api";
import {
  forgetGuestSession,
  guestInvitationId,
  savedGuestSession,
  GuestBar,
  WaitForOwner,
  type GuestSession,
} from "./guest-session";
import { keepDoorKey } from "./door-key";
import { keepReconnectPage } from "./offline-shell";
import { parseGuestLink } from "./start-flow";
import { homeOrigin } from "./home-origin";
// Capture the new link before the lazy redemption component removes its hash.
const incomingGuestInvites = location.pathname === "/guest"
  ? parseGuestLink(location.hash, homeOrigin()).invites : [];
// Only invited guests open /guest; everyone else never downloads it.
const GuestAccess = lazy(() => import("./GuestAccess"));
const BrowserWorkspace = lazy(() => import("./BrowserWorkspace"));
function GuestWorkspace({ peer, onEnd }: { peer: Peer; onEnd: () => void }) {
  const [browser, setBrowser] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const ended = useRef(onEnd);
  ended.current = onEnd;
  useEffect(() => {
    const controller = new AbortController();
    setBrowser(null);
    setError("");
    request<Device>(peer, "/api/device", { signal: controller.signal })
      .then((device) => {
        if (controller.signal.aborted) return;
        // Joined: the public link lets this browser's page through from now on.
        keepDoorKey(peer);
        setBrowser(!!device.access?.scopes.includes("browser:read"));
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e.status === 401) ended.current();
        else setError(e.message);
      });
    return () => controller.abort();
  }, [peer.url, peer.token, revision]);
  if (browser === null)
    return (
      <main className="guest-workspace">
        <p role="status">Opening your shared workspace…</p>
        {error && (
          <>
            <p role="alert">{error}</p>
            <button
              className="button"
              onClick={() => setRevision((n) => n + 1)}
            >
              Try again
            </button>
          </>
        )}
      </main>
    );
  return browser ? (
    <Suspense fallback={<Spinner label="Opening your shared workspace…" />}>
      <BrowserWorkspace peer={peer} onEnd={onEnd} />
    </Suspense>
  ) : (
    <App />
  );
}
// A guest gets Reach itself, limited by what they were given on each computer.
function GuestRoot() {
  const [session, setSession] = useState<GuestSession | null>(() => {
    const saved = incomingGuestInvites.length ? null : savedGuestSession();
    setGuestPeers(saved?.peers);
    return saved;
  });
  const [checking, setChecking] = useState(incomingGuestInvites.length > 0);
  const [bootError, setBootError] = useState("");
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    let reloading = false;
    const changed = () => {
      if (reloading || !parseGuestLink(location.hash, homeOrigin()).invites.length) return;
      // A same-document link does not rerun the entry module. Reload only for
      // a valid invitation so the provenance check owns the new transition.
      reloading = true;
      location.reload();
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (!incomingGuestInvites.length) return;
    let live = true;
    void guestInvitationId(incomingGuestInvites).then(invitationId => {
      if (!live) return;
      const saved = savedGuestSession();
      if (saved && saved.invitationId === invitationId) {
        // The one-use link was already redeemed in this tab; resume its exact
        // saved grant, then remove the consumed link from browser history.
        history.replaceState(null, "", "/guest");
        setGuestPeers(saved.peers);
        setSession(saved);
      } else {
        // Keep the older saved session as recovery if this replacement fails,
        // but never send its credentials while opening the new invitation.
        setGuestPeers(undefined);
        setSession(null);
      }
      setChecking(false);
    }).catch(() => {
      if (live) setBootError("This invitation could not be checked. Reload the page to try again.");
    });
    return () => { live = false; };
  }, []);
  const end = () => {
    forgetGuestSession();
    setGuestPeers(undefined);
    setSession(null);
    setEnded(true);
  };
  if (checking)
    return <main className="guest-workspace"><p role={bootError ? "alert" : "status"}>
      {bootError || "Opening your invitation…"}
    </p></main>;
  if (!session)
    return (
      <Suspense fallback={<Spinner label="Opening your invitation…" />}>
        <GuestAccess
          ended={ended}
          onReady={(value) => {
            setGuestPeers(value.peers);
            setSession(value);
          }}
        />
      </Suspense>
    );
  return (
    <>
      <GuestBar session={session} onEnd={end} />
      <WaitForOwner peer={session.peers[0]}>
        <GuestWorkspace peer={session.peers[0]} onEnd={end} />
      </WaitForOwner>
    </>
  );
}
import "./styles.css";
import "./atmosphere.css";
import "./workspace.css";
import "./identity.css";
import "./workspace-pages.css";
import "./app-style.css";
// After the shared look: one top bar on every page (top-bar.css).
import "./top-bar.css";
if (location.pathname !== "/guest") void keepReconnectPage();
export const appRoot = createRoot(document.getElementById("root")!);
appRoot.render(
  <React.StrictMode>
    <ScreenBoundary>
      {location.pathname === "/guest" ? <GuestRoot /> : <App />}
    </ScreenBoundary>
    <TransferTray />
  </React.StrictMode>,
);
