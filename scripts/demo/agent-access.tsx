// Agent invite, access and approval screens with sample data only. No host,
// credentials, approvals or real agents. Open /scripts/demo/agent-access.html
// at phone width; ?view=invite|agents|connect|app|command|manage picks a screen.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { InviteSheet } from "../../src/InviteSheet";
import BrowserAgents from "../../src/BrowserAgents";
import { AgentAdmissionReview, type AgentAdmission } from "../../src/agent-admissions";
import { BrowserApprovalReview, type BrowserRequest } from "../../src/browser-approvals";
import AccessEditor from "../../src/AccessEditor";
import BrowserWorkspace from "../../src/BrowserWorkspace";
import FunnelAgent from "../../src/FunnelAgent";
import "../../src/styles.css";
import "../../src/atmosphere.css";
import "../../src/workspace.css";
import "../../src/identity.css";
import "../../src/workspace-pages.css";
import "../../src/app-style.css";

const peer = { id: "sample", name: "Home Mac", platform: "darwin", url: location.origin, token: "sample-only" };
const device = {
  ...peer,
  roots: [
    { id: 0, name: "Home", path: "/Users/sample" },
    { id: 1, name: "Projects", path: "/Users/sample/Projects" },
  ],
  capabilities: { files: true, apps: true, screen: true, terminal: true, codex: true },
} as any;
const now = Date.now();
const min = 60000;
// Real logos are read from this Mac into an ignored folder, never committed.
let icons: Record<string, string> = {};
const appPaths = [
  "/Applications/Safari.app", "/Applications/Xcode.app", "/Applications/Spotify.app", "/Applications/Discord.app",
  "/Applications/Keynote.app", "/Applications/Pages.app", "/Applications/Numbers.app", "/Applications/Blender.app",
  "/Applications/Docker.app", "/Applications/Claude.app", "/Applications/ChatGPT.app", "/System/Applications/Notes.app",
  "/System/Applications/TextEdit.app", "/System/Applications/Calendar.app", "/System/Applications/Preview.app",
  "/System/Applications/Music.app", "/System/Applications/Mail.app", "/System/Applications/Messages.app",
  "/System/Applications/Reminders.app", "/System/Applications/Photos.app", "/Applications/Steam.app",
  "/Applications/GarageBand.app", "/Applications/Figma.app",
];
const apps = [
  ...appPaths.map((id) => ({ id, name: id.split("/").at(-1)!.replace(/\.app$/, ""), protected: false })),
  { id: "/Applications/Google Chrome.app", name: "Google Chrome", protected: true, reason: "Browsers stay private." },
  { id: "/Applications/Tailscale.app", name: "Tailscale", protected: true, reason: "Reach and Tailscale always stay private." },
  { id: "/System/Applications/Utilities/Terminal.app", name: "Terminal", protected: true, reason: "Command apps stay private." },
].sort((a, b) => a.name.localeCompare(b.name));
const policy = (extra: object) => ({ browser: true, invite: true, roots: ["/Users/sample/Projects/reach"], terminalIds: [], screen: "off", ...extra });
const agents = [
  {
    id: "c1a2b3c4d5e6f7a8", name: "Muse", kind: "agent", status: "accepted", createdAt: now - 6 * min, expiresAt: now + 24 * min,
    folders: ["/Users/sample/Projects/reach"], pendingApprovals: 1, activity: { state: "running", folder: "/Users/sample/Projects/reach" },
    policy: policy({ screen: "apps", appAccess: [{ id: "/Applications/Safari.app", name: "Safari", mode: "view" }, { id: "/System/Applications/Notes.app", name: "Notes", mode: "view" }], restrictedTerminal: true, terminalApproval: true }),
  },
  {
    id: "d9e8f7a6b5c4d3e2", name: "Research helper", kind: "agent", status: "pending", createdAt: now - 2 * min, expiresAt: now + 58 * min,
    folders: [], pendingApprovals: 0, activity: { state: "idle" }, policy: policy({ roots: [], terminalIds: ["reach:1"] }),
  },
  {
    id: "a1b2c3d4e5f60718", name: "Assistant", kind: "agent", status: "revoked", createdAt: now - 180 * min, expiresAt: now - 120 * min,
    folders: ["/Users/sample/Documents"], pendingApprovals: 0, activity: { state: "idle" }, policy: policy({ roots: ["/Users/sample/Documents"] }),
  },
];
const command: BrowserRequest = {
  id: "r1", clientId: agents[0].id, name: "Muse", reason: "Fix the failing test in the invite form.",
  action: { type: "terminal-change", command: "sed -i '' 's/15/30/' src/limits.ts", root: 0, cwd: "src" },
  status: "pending", createdAt: now - 20000, expiresAt: now + 4 * min, folder: "/Users/sample/Projects/reach",
};
const appRequest: BrowserRequest = {
  id: "r2", clientId: agents[0].id, name: "Muse", reason: "I need to read the release notes open in Pages.",
  action: { type: "app-access", appId: "/Applications/Pages.app", appName: "Pages", mode: "view" },
  status: "pending", createdAt: now - 5000, expiresAt: now + 2 * min, sessionExpiresAt: now + 24 * min,
};
const records: BrowserRequest[] = [
  command,
  { ...command, id: "r0", status: "executed", action: { type: "terminal", command: "ls src", root: 0 }, output: "App.tsx\nInviteSheet.tsx", createdAt: now - 4 * min },
];
const admission: AgentAdmission = {
  requestId: "q1", clientId: agents[1].id, name: "Research helper", scopes: ["device", "browser:read"], roots: ["/Users/sample/Projects/reach"],
  browser: true, screen: "apps", appAccess: [{ id: "/Applications/Safari.app", name: "Safari", mode: "view" }, { id: "/System/Applications/Notes.app", name: "Notes", mode: "view" }],
  terminalIds: ["reach:1"], restrictedTerminal: true, terminalApproval: true, scriptApproval: true,
  requestedAt: now - 10000, expiresAt: now + 4 * min, accessExpiresAt: now + 58 * min, verificationCode: "482913", browserTransport: "funnel",
};
const files: Record<string, string[]> = {
  "0:": ["Desktop", "Documents", "Downloads", "Projects"],
  "1:": ["reach", "website", "notes"],
};
const json = (data: unknown) => Response.json(data);
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!u.pathname.startsWith("/api/")) return nativeFetch(input, init);
  const p = u.pathname;
  // The agent's own side (/agent-browser), with sample data.
  if (p === "/api/browser")
    return json({ name: "Home Mac", expiresAt: now + 23 * min, roots: [{ index: 0, name: "reach", path: "/Users/sample/Projects/reach" }, { index: 1, name: "notes", path: "/Users/sample/notes" }], terminals: [{ id: "reach:1", name: "npm run dev" }], screen: "apps", commandRequests: false, restrictedTerminal: true, terminalApproval: true });
  if (p === "/api/files" && new URLSearchParams(location.search).get("view") === "workspace")
    return json({ items: u.searchParams.get("path") ? [{ name: "App.tsx", path: "src/App.tsx", type: "file" }, { name: "InviteSheet.tsx", path: "src/InviteSheet.tsx", type: "file" }] : [{ name: "src", path: "src", type: "directory" }, { name: "test", path: "test", type: "directory" }, { name: "README.md", path: "README.md", type: "file" }, { name: "package.json", path: "package.json", type: "file" }] });
  if (p === "/api/browser/files/search") return json({ items: [{ name: "InviteSheet.tsx", path: "src/InviteSheet.tsx", type: "file" }, { name: "invite-sheet.css", path: "src/invite-sheet.css", type: "file" }] });
  if (p === "/api/files/text") return json({ text: "# Reach\n\nYour devices, within reach.\n\nnpm install\nnpm run go\n" });
  if (p.startsWith("/api/browser/terminals/")) return json({ output: "> reach@0.1.0 dev\n> vite\n\n  VITE v5.4  ready in 312 ms\n  ➜  Local:   http://127.0.0.1:5178/\n" });
  if (p === "/api/browser/terminal/history")
    return json([{ id: "t1", clientId: "me", name: "Muse", reason: "", status: "executed", createdAt: now - 60000, expiresAt: now, action: { type: "terminal", command: "ls", root: 0 }, folder: "/Users/sample/Projects/reach", output: "README.md\npackage.json\nsrc\ntest", directory: "" }]);
  if (p === "/api/browser/apps")
    return json({ apps: [
      { id: "/Applications/Safari.app", name: "Safari", mode: "view", protected: false },
      { id: "/System/Applications/Notes.app", name: "Notes", mode: "view", protected: false },
      { id: "/Applications/Pages.app", name: "Pages", mode: "hidden", protected: false },
      { id: "/System/Applications/Utilities/Terminal.app", name: "Terminal", mode: "hidden", protected: true, reason: "Command apps stay private." },
    ], requests: [] });
  if (p === "/api/browser/apps/windows") return json({ windows: [{ id: "w1", title: "Reach — README", width: 1200, height: 800 }, { id: "w2", title: "Release notes", width: 1200, height: 800 }] });
  if (p === "/api/browser/apps/screen")
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="#f6f6f4"/><rect width="1200" height="52" fill="#e4e4e0"/><circle cx="26" cy="26" r="7" fill="#ff5f57"/><circle cx="48" cy="26" r="7" fill="#febc2e"/><circle cx="70" cy="26" r="7" fill="#28c840"/><rect x="300" y="14" width="600" height="24" rx="12" fill="#fff"/><text x="80" y="140" font-family="-apple-system,Helvetica" font-size="44" font-weight="700" fill="#1d1d1f">Reach</text><text x="80" y="190" font-family="-apple-system,Helvetica" font-size="22" fill="#555">Your devices, within reach.</text><rect x="80" y="240" width="1040" height="14" rx="7" fill="#ddd"/><rect x="80" y="270" width="900" height="14" rx="7" fill="#ddd"/><rect x="80" y="300" width="980" height="14" rx="7" fill="#ddd"/></svg>`, { headers: { "Content-Type": "image/svg+xml" } });
  if (p === "/api/apps/icons") {
    const ids: string[] = JSON.parse(String(init.body)).ids;
    return json({ icons: Object.fromEntries(ids.filter((id) => icons[id]).map((id) => [id, icons[id]])) });
  }
  if (p === "/api/guests/keys") return json({ configured: true, policy: null });
  if (p === "/api/clients") return json({ clients: [], current: "" });
  if (p === "/api/device") return json(device);
  if (p === "/api/files") return json({ items: (files[`${u.searchParams.get("root")}:${u.searchParams.get("path")}`] || []).map((name) => ({ name, path: name, type: "directory" })) });
  if (p === "/api/agents/browser-options")
    return json({ terminals: [{ id: "reach:1", name: "npm run dev" }, { id: "desktop:2", name: "Build logs" }], screenAvailable: true, appAccessAvailable: true, apps });
  if (p === "/api/agents/browser-invitations") {
    const secret = "s".repeat(43);
    return json({ invitation: secret, clientId: "new", expiresAt: now + 15 * min, joinBy: now + 10 * min, url: `https://home-mac.example.ts.net/agent-browser#invite=${secret}` });
  }
  if (p === "/api/browser/agents") return json({ agents, at: now });
  if (p === "/api/agents/browser-requests") return json(records);
  if (p === "/api/agents/browser-terminal-history") return json([]);
  if (p === "/api/agents/admissions") return json([admission]);
  if (p.startsWith("/api/agents/browser-app-access/"))
    return json({ apps: apps.map((a) => ({ ...a, mode: ["Safari", "Notes"].includes(a.name) ? "view" : "hidden" })) });
  return json({});
};

const views = ["invite", "agents", "connect", "app", "command", "manage", "edit", "workspace", "waiting"] as const;
function Preview() {
  const [ready, setReady] = useState(false);
  const view = new URLSearchParams(location.search).get("view") || "invite";
  useEffect(() => {
    nativeFetch("/.reach/preview/app-icons.json").then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((value) => { icons = value; setReady(true); });
  }, []);
  if (!ready) return null;
  if (view === "workspace") return <BrowserWorkspace peer={{ ...(peer as any), name: "Home Mac" }} onEnd={() => {}} />;
  if (view === "waiting") {
    const receipt = { verificationCode: "482913", expiresAt: now + 4 * min, device: { name: "Home Mac" } };
    const client = { prepare: async () => ({ receipt }), claim: async (v: any) => v, status: async (v: any) => v, forget: async () => {} };
    return <FunnelAgent client={client as any} />;
  }
  const close = () => {};
  return (
    <div style={{ minHeight: "100vh", padding: "16px 16px 40px", background: "var(--bg)", color: "var(--text, #e9eee9)" }}>
      <nav style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16, fontSize: 12 }}>
        {views.map((v) => <a key={v} href={`?view=${v}`} style={{ color: v === view ? "#b9efd4" : "#8a978d" }}>{v}</a>)}
      </nav>
      {view === "invite" && <InviteSheet peer={peer as any} device={device} initialKind="browser" />}
      {view === "agents" && <BrowserAgents peer={peer as any} device={device} invite={close} toast={close} />}
      {view === "connect" && <AgentAdmissionReview peer={peer as any} admission={admission} onClose={close} onResolved={close} />}
      {view === "app" && <BrowserApprovalReview peer={peer as any} item={appRequest} onClose={close} onResolved={close} />}
      {view === "command" && <BrowserApprovalReview peer={peer as any} item={command} onClose={close} onResolved={close} />}
      {view === "edit" && <AccessEditor peer={peer as any} device={device} client={{ ...agents[1], status: "accepted", policy: policy({ roots: ["/Users/sample/Projects"], terminalIds: ["reach:1"], restrictedTerminal: true, screen: "off" }) } as any} onClose={close} onSaved={close} />}
      {view === "manage" && <AccessEditor peer={peer as any} device={device} client={agents[0] as any} onClose={close} onSaved={close} />}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
