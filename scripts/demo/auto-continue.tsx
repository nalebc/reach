// A UI fixture with sample data only: "If usage runs out" (AutoContinueSheet)
// for a Codex chat out of usage. ?view=switch: the order; on-here, on-switch:
// already on. Nothing reaches a computer.
import React from "react";
import { createRoot } from "react-dom/client";
import { AutoContinueSheet } from "../../src/Relays";
import "../../src/styles.css";
import "../../src/chat-workspace.css";
import "../../src/agent-session.css";

const view = new URLSearchParams(location.search).get("view") || "";
const peer = { id: "preview", name: "Home Mac", url: location.origin, token: "sample-only", platform: "darwin" };
const now = Date.now();
const session = { agent: "codex", id: "sample", title: "Fix login", cwd: "/work/app", status: "idle", updatedAt: now };
const health = [
  { agent: "codex", installed: true, signedIn: true, usable: false, resetsAt: now + 2.5 * 3600 * 1000 },
  { agent: "claude", installed: true, signedIn: true, usable: true },
  { agent: "gemini", installed: true, signedIn: true, usable: true },
  { agent: "openclaw", installed: true, connected: true, canTakeMoves: true },
];
localStorage.setItem("reach-continue-mode:preview", view === "switch" ? "switch" : "here");
const relay = (priority: string[]) => ({
  id: "r1", trigger: "usage", state: "waiting", problem: "", createdAt: now, updatedAt: now, next: 0,
  steps: [], chain: [{ agent: "codex", id: "sample", title: "Fix login" }], sent: [], priority,
});
const on = view === "on-here" ? relay(["codex"]) : view === "on-switch" ? relay(["claude", "codex"]) : null;
window.fetch = async () => Response.json({ error: "Sample data only." }, { status: 403 });
const noop = () => {};
createRoot(document.getElementById("root")!).render(
  <main className="page-sessions">
    <AutoContinueSheet peer={peer as never} session={session as never} health={health as never} logos={{}}
      on={on as never} onClose={noop} onStarted={noop} />
  </main>,
);
