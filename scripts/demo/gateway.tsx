// UI-only fixture. Every API response is simulated; no command reaches a host.
import React from "react";
import { createRoot } from "react-dom/client";
import { ClawHealthPill } from "../../src/OpenClawHealth";
import "../../src/styles.css";
const peer = {
  id: "preview",
  name: "Home Mac",
  url: location.origin,
  token: "sample-only",
};
let job: any = {
  action: "doctor",
  status: "failed",
  message: "OpenClaw couldn't finish. Try again.",
  lines: [],
  finishedAt: Date.now(),
};
if (new URLSearchParams(location.search).has("upgrade")) job = {
  id: "preview-upgrade", action: "update", status: "awaiting_approval", lines: [],
  recovery: { kind: "node", title: "Upgrade Node to continue", available: true,
    description: "OpenClaw needs a newer Node runtime. Reach can install Node 24 with Homebrew and use it for OpenClaw. Your current Node installation is kept.",
    steps: ["Install Node 24 and its Homebrew dependencies", "Retry the OpenClaw update", "Migrate existing settings, credentials and plugins if required", "Repair the Gateway service and verify its connection"],
  },
};
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.origin,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (url.pathname.endsWith("/maintenance")) return Response.json({ job });
  if (url.pathname.endsWith("/logs"))
    return Response.json({
      supported: true,
      lines: [
        {
          time: Date.now() - 5000,
          level: "info",
          source: "gateway",
          text: "Gateway connected. Listening on loopback.",
        },
        {
          time: Date.now(),
          level: "error",
          source: "discord",
          text: "Connection closed. Authentication failed; check the channel credentials in OpenClaw settings.",
        },
        {
          time: Date.now(),
          level: "info",
          source: "gateway",
          text: "Health check completed. 1 channel needs attention.",
        },
      ].filter((line) => !url.search || line.level === "error"),
    });
  if (init?.method === "POST") {
    const action = url.pathname.endsWith("/continue") ? "update" : url.pathname.split("/").pop();
    if (action === "restart") return Response.json({ back: true });
    job = { action, status: "running", lines: [], startedAt: Date.now() };
    setTimeout(() => {
      job = {
        ...job,
        status: "done",
        finishedAt: Date.now(),
        message: "Health check completed. Review its output for findings.",
        lines: [
          "OpenClaw doctor",
          "Gateway: connected",
          "Discord: authentication failed",
          "Check the Discord channel credentials.",
        ],
      };
    }, 2400);
    return Response.json({ job });
  }
  return Response.json({
    status: "attention",
    gateway: { supported: true, answered: true, ms: 4, version: "2026.3.13" },
    uptime: { supported: true, ms: 13920000 },
    storage: { supported: true, dbBytes: 6e6, walBytes: 0, warn: false },
    memory: { supported: false },
    channels: { supported: true, failing: ["Discord"] },
  });
};
createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 24 }}>
    <ClawHealthPill peer={peer} />
  </div>,
);
