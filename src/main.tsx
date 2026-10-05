import React, { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import ScreenBoundary from "./ScreenBoundary";
import App from "./App";
import TransferTray from "./TransferTray";
import { setGuestPeers } from "./api";
import {
  forgetGuestSession,
  savedGuestSession,
  GuestBar,
  type GuestSession,
} from "./guest-session";
// Only invited guests open /guest; everyone else never downloads it.
const GuestAccess = lazy(() => import("./GuestAccess"));
// A guest gets Reach itself, limited by what they were given on each computer.
function GuestRoot() {
  const [session, setSession] = useState<GuestSession | null>(() => {
    const saved = savedGuestSession();
    setGuestPeers(saved?.peers);
    return saved;
  });
  const [ended, setEnded] = useState(false);
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
      <GuestBar
        session={session}
        onEnd={() => {
          forgetGuestSession();
          setGuestPeers(undefined);
          setSession(null);
          setEnded(true);
        }}
      />
      <App />
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
      {location.pathname === "/guest" ? (
        <GuestRoot />
      ) : (
        <App />
      )}
    </ScreenBoundary>
    <TransferTray />
  </React.StrictMode>,
);
