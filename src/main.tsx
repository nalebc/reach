import React from "react";
import { createRoot } from "react-dom/client";
import ScreenBoundary from "./ScreenBoundary";
import App from "./App";
import GuestAccess from "./GuestAccess";
import "./styles.css";
import "./atmosphere.css";
import "./workspace.css";
import "./identity.css";
import "./workspace-pages.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ScreenBoundary>
      {location.pathname === "/guest" ? <GuestAccess /> : <App />}
    </ScreenBoundary>
  </React.StrictMode>,
);
