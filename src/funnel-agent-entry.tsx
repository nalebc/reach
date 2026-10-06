import React from "react";
import { createRoot } from "react-dom/client";
import FunnelAgent from "./FunnelAgent";
import "./styles.css";
import "./workspace.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FunnelAgent />
  </React.StrictMode>,
);
