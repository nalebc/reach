import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ScreenBoundary from "./ScreenBoundary";
import App from "./App";
import TransferTray from "./TransferTray";
import { request, setGuestPeers, type Device, type Peer } from "./api";
import {
  forgetGuestSession,
  savedGuestSession,
  GuestBar,
  type GuestSession,
} from "./guest-session";
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
        if (!controller.signal.aborted)
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
    <Suspense fallback={null}>
      <BrowserWorkspace peer={peer} onEnd={onEnd} />
    </Suspense>
  ) : (
    <App />
  );
}
// A guest gets Reach itself, limited by what they were given on each computer.
function GuestRoot() {
  const [session, setSession] = useState<GuestSession | null>(() => {
    const saved = savedGuestSession();
    setGuestPeers(saved?.peers);
    return saved;
  });
  const [ended, setEnded] = useState(false);
  const end = () => {
    forgetGuestSession();
    setGuestPeers(undefined);
    setSession(null);
    setEnded(true);
  };
  if (!session)
    return (
      <Suspense fallback={null}>
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
      <GuestWorkspace peer={session.peers[0]} onEnd={end} />
    </>
  );
}
import "./styles.css";
import "./atmosphere.css";
import "./workspace.css";
import "./identity.css";
import "./workspace-pages.css";
import "./app-style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ScreenBoundary>
      {location.pathname === "/guest" ? <GuestRoot /> : <App />}
    </ScreenBoundary>
    <TransferTray />
  </React.StrictMode>,
);
