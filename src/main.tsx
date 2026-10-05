import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import ScreenBoundary from "./ScreenBoundary";
import App from "./App";
import TransferTray from "./TransferTray";
// Only invited guests open /guest; everyone else never downloads it.
const GuestAccess = lazy(() => import("./GuestAccess"));
import "./styles.css";
import "./atmosphere.css";
import "./workspace.css";
import "./identity.css";
import "./workspace-pages.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ScreenBoundary>
      {location.pathname === "/guest" ? (
        <Suspense fallback={null}>
          <GuestAccess />
        </Suspense>
      ) : (
        <App />
      )}
    </ScreenBoundary>
    <TransferTray />
  </React.StrictMode>,
);
