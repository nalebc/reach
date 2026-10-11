// A UI fixture with sample data only (docs/FIRST_RUN_MATRIX.md): what a new
// person sees first. Nothing reaches a computer.
//   ?view=chat        Chat on a computer with no agent yet (Add an agent)
//   ?view=browser     Home, signed in from the browser without the Tailscale app
//   ?view=homescreen  Home on an iPhone with the Tailscale app, in Safari
import React from "react";
import { createRoot } from "react-dom/client";
import EverythingChat from "../../src/EverythingChat";
import HomeLive from "../../src/HomeLive";
import PhonePrompts from "../../src/PhonePrompts";
import "../../src/styles.css";
import "../../src/atmosphere.css";
import "../../src/workspace.css";
import "../../src/identity.css";
import "../../src/workspace-pages.css";
import "../../src/app-style.css";
import "../../src/mobile-nav.css";

const view = new URLSearchParams(location.search).get("view") || "chat";
const peer = { id: "preview", name: "Home Mac", url: "https://home-mac.example.ts.net", token: "sample-only", platform: "darwin" };
// The suggestions are remembered per phone; the preview always starts fresh.
for (const key of Object.keys(localStorage)) if (key.startsWith("reach.nudge.")) localStorage.removeItem(key);
if (view === "browser") document.documentElement.dataset.connection = "browser";
if (view === "homescreen") {
  // An iPhone in Safari, for the iPhone steps (the preview runs elsewhere).
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1" });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
}
const nothing = [
  { agent: "codex", name: "Codex", installed: false, signedIn: false, supported: true },
  { agent: "claude", name: "Claude Code", installed: false, signedIn: false, supported: true, app: { installed: false, signedIn: false } },
  { agent: "openclaw", name: "OpenClaw", installed: false, signedIn: false, supported: true },
  { agent: "gemini", name: "Gemini CLI", installed: false, signedIn: false, supported: false },
];
window.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname.startsWith("/api/sessions/agent-install/"))
    return Response.json({ agent: "claude", name: "Claude Code", command: "curl -fsSL https://claude.ai/install.sh | bash" });
  if (url.pathname === "/api/clients") return Response.json({ current: "me", clients: [] });
  if (url.pathname === "/api/sessions/logos") return Response.json({ version: "v1", logos: {} });
  return Response.json({});
};
const noop = () => {};
function Home() {
  return (
    <div className="app-shell">
      <main className="workspace-main" style={{ flex: 1, minWidth: 0 }}>
        <HomeLive
          features={{ terminal: true, codex: false, screen: false, desktopTerminals: false, shortcuts: false, owner: true, writeFiles: false } as never}
          device={{ name: peer.name, roots: [] } as never}
          peer={peer}
          active={peer.id}
          connections={{ [peer.id]: { state: "connected" } } as never}
          connection={view === "browser" ? "Tailscale in browser" : "Tailscale"}
          appLink={view === "browser" ? "https://apps.apple.com/app/tailscale/id1470499037" : undefined}
          terminals={[]}
          chats={[]}
          agentSessions={[]}
          pending={[]}
          decide={noop}
          navigate={noop}
          openChat={noop}
          openTerminal={noop}
          openMacTab={noop}
          openAgentSession={noop}
          onShortcuts={noop}
          refreshSessions={noop}
          toast={noop}
        />
      </main>
      <PhonePrompts owner url={peer.url} />
      <nav className="mobile-nav" style={{ position: "fixed", display: "flex" }}>
        {["Home", "Chat", "Screen", "Terminals"].map((tab, i) => (
          <button key={tab} className={i === 0 ? "active" : undefined}>
            {tab}
          </button>
        ))}
      </nav>
    </div>
  );
}
function Preview() {
  if (view === "chat")
    return (
      <div className="app-shell">
        <main className="workspace-main" style={{ flex: 1, minWidth: 0, padding: "0 16px" }}>
          <EverythingChat
            peer={peer}
            feed={{ sessions: [], errors: {}, health: nothing, healthChecked: true, failure: "", reload: async () => {}, recheck: noop } as never}
          />
        </main>
      </div>
    );
  return <Home />;
}
createRoot(document.getElementById("root")!).render(<Preview />);
