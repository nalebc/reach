// A UI fixture with sample data only. No real terminal, host, or approvals.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { House, MessageSquare, Terminal, FolderOpen } from "lucide-react";
import EverythingChat from "../../src/EverythingChat";
import Screen from "../../src/Screen";
import MobileNav from "../../src/MobileNav";
import LivingLogo from "../../src/LivingLogo";
import type { AgentSession, AgentFeed, MacPrompt } from "../../src/agent-sessions";
import "../../src/styles.css";
import "../../src/atmosphere.css";
import "../../src/workspace.css";
import "../../src/identity.css";
import "../../src/workspace-pages.css";
import "../../src/app-style.css";

const peer = {
  id: "preview",
  name: "Home Mac",
  url: location.origin,
  token: "sample-only",
  platform: "darwin",
};
let macPrompts: MacPrompt[] = new URLSearchParams(location.search).get("permissions") === "mac"
  ? [{
      id: "sample-mac-request",
      kind: "privacy",
      title: "“Reach” wants access to control “Finder”.",
      detail: "Allowing control lets Reach perform actions in Finder on your Mac.",
      app: "Reach",
      lines: [
        "“Reach” wants access to control “Finder”.",
        "Allowing control lets Reach perform actions in Finder on your Mac.",
      ],
      buttons: ["Don’t Allow", "Allow"],
      default: "Allow",
    }]
  : [];
const health = [
  ...["codex", "claude"].map((agent) => ({
    agent,
    supported: true,
    installed: true,
    signedIn: true,
  })),
  ...[
    { agent: "gemini", name: "Gemini CLI" },
    { agent: "cursor", name: "Cursor" },
    { agent: "antigravity", name: "Antigravity" },
  ].map((app) => ({
    ...app,
    supported: false,
    installed: true,
    signedIn: false,
  })),
];
let sessions: AgentSession[] = [
  [
    "codex",
    "A calmer mobile workspace",
    "Reach",
    "running",
    "Simplifying the chat tab and making room for your work.",
  ],
  [
    "claude",
    "Review the sign-in flow",
    "Reach",
    "waiting",
    "I have a small change ready. Can I run the checks?",
  ],
  [
    "codex",
    "Ship the new landing page",
    "Website",
    "idle",
    "The layout is ready. Typography, spacing, and mobile views are looking good.",
  ],
  [
    "claude",
    "Plan this week's meals",
    "Everyday",
    "idle",
    "A simple five-day plan, with a shopping list you can take along.",
  ],
  [
    "codex",
    "Explore the API",
    "Spendra",
    "idle",
    "Mapped the routes and found a cleaner way to handle authentication.",
  ],
  [
    "claude",
    "A few ideas worth keeping",
    "Notes",
    "idle",
    "Thinking through the little details that make a product feel effortless.",
  ],
].map(
  ([agent, title, project, status, preview], i) =>
    ({
      agent,
      title,
      cwd: "/Projects/" + project,
      status,
      preview,
      id: "sample-" + i,
      branch: "main",
      origin: "reach",
      inApp: false,
      archived: false,
      createdAt: Date.now() - i * 3600000,
      updatedAt: Date.now() - i * 3600000,
      model: "sample",
      effort: "medium",
      mode: "auto",
      held: "reach",
    }) as AgentSession,
);
const prompt = {
  id: "sample-request",
  kind: "command" as const,
  title: "Run the sign-in checks",
  command: "npm test -- sign-in",
  cwd: "/Projects/Reach",
  reason: "Check that the updated flow handles reconnecting safely.",
  decisions: ["accept", "decline"],
};
sessions[1].prompts = [prompt];
const transcript: Record<string, any[]> = {};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.href,
  );
  if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
  const path = url.pathname;
  let data: unknown = {};
  if (path === "/api/sessions/mac-prompts/sample-mac-request/press") {
    if (new URLSearchParams(location.search).get("answer") === "blocked")
      return Response.json({ error: "macOS could not press this button. Open the live screen to review the dialog." }, { status: 409 });
    const body = JSON.parse(String(init.body));
    if (!["Don’t Allow", "Allow"].includes(body.button))
      return Response.json({ error: "Unknown sample action" }, { status: 400 });
    macPrompts = [];
    window.dispatchEvent(new Event("reach-preview-refresh"));
    data = { pressed: body.button };
  }
  else if (path.endsWith("/logos")) data = { logos: {} };
  else if (path.endsWith("/models"))
    data = {
      models: [
        {
          id: "sample",
          name: "Default model",
          efforts: ["medium", "high"],
          defaultEffort: "medium",
          isDefault: true,
        },
      ],
      modes: [
        { id: "auto", label: "Ask for approval" },
        { id: "read-only", label: "Read only" },
      ],
      mode: "auto",
    };
  else if (path.endsWith("/health"))
    data = { agents: health };
  else if (path.endsWith("/commands")) data = { commands: [] };
  else if (path === "/api/sessions") {
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const s = {
        ...sessions[0],
        id: "sample-" + Date.now(),
        agent: body.agent,
        title: body.text,
        cwd: body.cwd,
        status: "idle",
        prompts: undefined,
        updatedAt: Date.now(),
      } as AgentSession;
      sessions = [s, ...sessions];
      data = { threadId: s.id };
      transcript[s.id] = [
        {
          id: "first",
          role: "user",
          kind: "text",
          text: body.text,
          at: Date.now(),
        },
      ];
    } else data = { sessions, macPrompts, errors: {} };
  } else {
    const match = path.match(/\/api\/sessions\/(codex|claude)\/([^/]+)/);
    const s = sessions.find((s) => s.id === match?.[2]);
    if (s) {
      if (path.endsWith("/live")) {
        await new Promise((r) => setTimeout(r, 800));
        data = {
          version: 1,
          status: s.status,
          prompts: s.prompts || [],
          streaming: "",
          activity: "Reviewing the workspace",
          items: 0,
        };
      } else if (path.endsWith("/messages")) {
        const body = JSON.parse(String(init.body));
        (transcript[s.id] ||= []).push({
          id: String(Date.now()),
          role: "user",
          kind: "text",
          text: body.text,
          at: Date.now(),
        });
        data = { turnId: "sample-turn" };
      } else if (path.includes("/prompts/")) {
        s.prompts = [];
        s.status = "idle";
        data = { ok: true };
      } else if (path.endsWith("/stop")) {
        s.status = "idle";
        data = { ok: true };
      } else {
        transcript[s.id] ||= [
          {
            id: "u1",
            role: "user",
            kind: "text",
            text: "Can you help make this feel simpler?",
            at: Date.now(),
          },
          {
            id: "a1",
            role: "assistant",
            kind: "text",
            text: "Yes. Let’s give the conversation some breathing room.\n\nThe workspace now brings your chats together, with a clear preview of each one. You can move between Codex and Claude without changing the whole interface.\n\nSettings are one tap away, and anything that needs a decision has its own place.",
            at: Date.now(),
          },
        ];
        data = { session: s, items: transcript[s.id], before: null };
      }
    }
  }
  return Response.json(data);
};
function Preview() {
  const [, redraw] = useState(0);
  const [screenPrompt, setScreenPrompt] = useState<MacPrompt | null>(null);
  useEffect(() => {
    const refresh = () => redraw((n) => n + 1);
    window.addEventListener("reach-preview-refresh", refresh);
    return () => window.removeEventListener("reach-preview-refresh", refresh);
  }, []);
  const feed = {
    sessions: [...sessions],
    health,
    errors: {},
    failure: "",
    projects: [],
    macPrompts,
    reload: async () => redraw((n) => n + 1),
    recheck: () => {},
  } as AgentFeed;
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Workspace navigation">
        <LivingLogo />
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          <button><House size={19} />Home</button>
          <button className="active" aria-current="page"><MessageSquare size={19} />Chat</button>
          <button><Terminal size={19} />Terminal</button>
          <button><FolderOpen size={19} />Files</button>
        </nav>
      </aside>
      <div className="main-shell">
        <main className="main-content page-sessions">
          {screenPrompt ? <>
            <p className="muted">Preview only · No Mac connected</p>
            <button onClick={() => setScreenPrompt(null)}>Back to chats</button>
            <Screen peer={peer} device={{ ...peer, capabilities: { screen: false }, roots: [] } as any}
              toast={() => {}} onChanged={() => {}}
              ask={{ ...screenPrompt, open: macPrompts.some((p) => p.id === screenPrompt.id) }}
              onAskDone={() => setScreenPrompt(null)} />
          </> : <EverythingChat peer={peer} feed={feed} showOnScreen={setScreenPrompt} />}
        </main>
      </div>
      <MobileNav
        current="chat"
        moreOpen={false}
        onNavigate={() => {}}
        onMore={() => {}}
        items={[
          { id: "home", label: "Home", icon: <House size={20} /> },
          { id: "chat", label: "Chat", icon: <MessageSquare size={20} /> },
          { id: "terminal", label: "Terminal", icon: <Terminal size={20} /> },
          { id: "files", label: "Files", icon: <FolderOpen size={20} /> },
        ]}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
