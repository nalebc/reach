// A UI fixture with sample data only. No real terminal, host, or approvals.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { House, MessageSquare, Terminal, FolderOpen } from "lucide-react";
import EverythingChat from "../../src/EverythingChat";
import { NotificationCenter, type NotificationItem } from "../../src/Notifications";
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
const permissionPreview = new URLSearchParams(location.search).get("permissions");
// A large intrinsic image catches approval-card icon sizing regressions.
const sampleLogos = permissionPreview === "logo" ? { claude: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#d97856"/><path d="M32 12v40M12 32h40M18 18l28 28M18 46l28-28" stroke="#fff9ed" stroke-width="5"/></svg>')}` } : {};
const samplePassword: MacPrompt = { id: "sample-mac-password", kind: "password", title: "Your Mac needs authentication", detail: "", app: null };
let macPrompts: MacPrompt[] = permissionPreview === "password" ? [samplePassword] : permissionPreview === "mac"
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
const setupPreview = new URLSearchParams(location.search).get("setup");
const health = [
  ...["codex", "claude"].map((agent) => ({
    agent,
    supported: true,
    installed: agent !== "codex" || setupPreview !== "missing",
    signedIn: agent !== "codex" || !setupPreview,
  })),
  { agent: "openclaw", name: "OpenClaw", supported: true, installed: true, signedIn: true },
  ...[
    { agent: "gemini", name: "Gemini CLI" },
    { agent: "cursor", name: "Cursor" },
    { agent: "antigravity", name: "Antigravity" },
  ].map((app) => ({
    ...app,
    supported: false,
    installed: new URLSearchParams(location.search).get("apps") === "all",
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
// The desktop chat uses a model this connection's catalog does not list.
if (new URLSearchParams(location.search).get("model") === "unlisted")
  sessions[0] = { ...sessions[0], model: "gpt-6.1-sol", effort: "high", status: "idle" };
const prompt = {
  id: "sample-request",
  kind: "command" as const,
  title: "Run the sign-in checks",
  command: "npm test -- sign-in",
  cwd: "/Projects/Reach",
  reason: "Check that the updated flow handles reconnecting safely.",
  decisions: ["accept", "decline"],
};
sessions[1].prompts = permissionPreview === "question" ? [{
  id: "sample-question",
  kind: "question",
  title: "Claude has a question",
  questions: [{
    id: "Which checks should I run?",
    question: "Which checks should I run?",
    header: "Checks",
    multiSelect: true,
    other: true,
    options: [
      { label: "Unit tests", description: "Check the changed behavior" },
      { label: "Type check", description: "Check the app for type errors" },
    ],
  }],
}] : [prompt];
if (permissionPreview === "elsewhere") {
  sessions[1].prompts = [];
  sessions[1].held = null;
  sessions[1].live = { where: "claude-app", pid: 1, tty: null, waiting: "question" };
  sessions[1].asking = { kind: "question", questions: [{
    question: "Which checks should I run?",
    options: [{ label: "Unit tests", description: "" }, { label: "Type check", description: "" }],
  }] };
}
const transcript: Record<string, any[]> = {};
// OpenClaw fixture: all replies below are sample data, never sent to a channel.
const clawSessions = [
  { key: "agent:main:whatsapp:family", title: "Weekend plans", agentId: "main", channel: "whatsapp", canDeliver: true, updatedAt: Date.now() - 120000, model: "Claude Sonnet", status: "idle" },
  { key: "agent:work:discord:launch", title: "Website launch", agentId: "work", channel: "discord", canDeliver: true, updatedAt: Date.now() - 1800000, model: "Claude Sonnet", status: "idle" },
  { key: "agent:main:reach-preview", title: "Your personal assistant", agentId: "main", channel: "webchat", writable: true, canDeliver: false, updatedAt: Date.now() - 3600000, model: "Claude Sonnet", status: "idle" },
  { key: "agent:main:whatsapp:shopping", title: "A shopping list for the week", agentId: "main", channel: "whatsapp", canDeliver: true, updatedAt: Date.now() - 86400000, model: "Claude Sonnet", status: "idle" },
  { key: "agent:work:discord:notes", title: "Ideas for the next release", agentId: "work", channel: "discord", canDeliver: true, updatedAt: Date.now() - 172800000, model: "Claude Sonnet", status: "idle" },
];
const clawMessages: Record<string, any[]> = {};
let moveNumber = 0;
const queuePreview = new URLSearchParams(location.search).get("queue") === "1";
let queueVersion = 1;
let sampleQueue = [
  { id: "queue-one", text: "Review the whole queued message. ".repeat(9), images: 0, via: "app" },
  { id: "queue-two", text: "Then check the Files preview", images: 0, via: "app" },
  { id: "queue-three", text: "Finally summarize the test results", images: 0, via: "app" },
];
const clawJobs = [
  { id: "morning", name: "Morning briefing", agentId: "main", enabled: true, schedule: "Daily at 08:00 · America/Vancouver", nextRunAt: Date.now() + 3600000, lastRunAt: Date.now() - 86400000, status: "ok", error: "", delivery: "telegram" },
  { id: "weekly", name: "Weekly project review", agentId: "work", enabled: false, schedule: "Every Monday at 09:00 · America/Vancouver", nextRunAt: 0, lastRunAt: Date.now() - 172800000, status: "ok", error: "", delivery: "No external delivery" },
];
if (new URLSearchParams(location.search).get("chats") === "empty") {
  sessions = [];
  clawSessions.length = 0;
}
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
  if (path === "/api/notifications") {
    const items: NotificationItem[] = sessions.filter(s => !s.archived && s.status === "waiting").flatMap(s =>
      s.prompts?.length ? s.prompts.map(p => ({
        id: `chat:${s.agent}:${s.id}:prompt:${p.id}`, revision: "sample-revision",
        source: s.agent, icon: s.agent, title: p.title, detail: s.title,
        kind: p.kind, ...(p.command ? { prompt: { command: p.command, cwd: p.cwd } } : {}),
        actions: p.kind === "command" ? [
          { id: "deny", label: "Deny", tone: "deny" },
          { id: "approve", label: "Allow once", tone: "primary" },
        ] : [],
        target: { page: "sessions", agent: s.agent, id: s.id, prompt: p.id },
      })) : [{
        id: `chat:${s.agent}:${s.id}`, source: s.agent, icon: s.agent,
        title: "Your answer is needed", detail: s.title,
        target: { page: "sessions", agent: s.agent, id: s.id },
      }]);
    return Response.json({ items, unavailable: [] });
  }
  const notificationAction = path.match(/^\/api\/notifications\/([^/]+)\/actions$/);
  if (notificationAction && init.method === "POST") {
    const id = decodeURIComponent(notificationAction[1]);
    const s = sessions.find(s => id.startsWith(`chat:${s.agent}:${s.id}:`));
    if (s) { s.prompts = []; s.status = "idle"; }
    window.dispatchEvent(new Event("reach-preview-refresh"));
    return Response.json({ ok: true });
  }
  if (path === "/api/push") return Response.json({ key: "sample-only" });
  let data: unknown = {};
  const queue = path.match(/^\/api\/sessions\/(codex|claude)\/([^/]+)\/queue\/(.+)$/);
  if (queuePreview && queue && init.method === "POST") {
    const body = JSON.parse(String(init.body || "{}"));
    if (queue[3] === "order") {
      sampleQueue = body.order.map((id: string) => sampleQueue.find(row => row.id === id)).filter(Boolean);
    } else {
      const [id, action] = queue[3].split("/");
      if (action === "edit") sampleQueue = sampleQueue.map(row => row.id === id ? { ...row, text: body.text } : row);
      if (action === "cancel" || action === "now") sampleQueue = sampleQueue.filter(row => row.id !== id);
    }
    queueVersion++;
    return Response.json({ edited: true, reordered: true, deleted: true, hurried: true });
  }
  const move = path.match(/^\/api\/sessions\/(codex|claude|openclaw)\/([^/]+)\/move$/);
  if (move && init.method === "POST") {
    const from = move[1], sourceId = decodeURIComponent(move[2]);
    const { to } = JSON.parse(String(init.body || "{}"));
    const source = from === "openclaw"
      ? clawSessions.find(s => s.key === sourceId)
      : sessions.find(s => s.agent === from && s.id === sourceId);
    if (!source) return Response.json({ error: "Sample chat not found." }, { status: 404 });
    if (!["codex", "claude", "openclaw"].includes(to) || to === from)
      return Response.json({ error: "Choose another sample app." }, { status: 400 });
    const at = Date.now(), id = to === "openclaw"
      ? `agent:main:reach:sample-move-${++moveNumber}` : `sample-move-${++moveNumber}`;
    const history = from === "openclaw" ? clawMessages[sourceId] || [] : transcript[sourceId] || [];
    if (to === "openclaw") {
      clawSessions.unshift({ key: id, title: source.title, agentId: "main", channel: "webchat",
        canDeliver: false, updatedAt: at, model: "Claude Sonnet", status: "idle" });
      clawMessages[id] = history.map(item => ({ ...item, tool: false }));
    } else {
      const original = from === "openclaw" ? null : source as AgentSession;
      const destination: AgentSession = {
        ...sessions[0], ...original, agent: to, id, title: source.title,
        status: "idle", held: "reach", prompts: undefined, asking: undefined, live: undefined,
        model: to === "claude" ? "claude-opus-5-5" : "sample",
        createdAt: at, updatedAt: at, movedTo: undefined,
        movedFrom: { agent: from, id: sourceId, title: source.title },
      };
      sessions = [destination, ...sessions];
      transcript[id] = [...history.map(item => ({ ...item, kind: item.kind || "text" })),
        { id: `moved:${id}`, role: "system", kind: "notice", at,
          text: `Continued with ${to === "claude" ? "Claude Code" : "Codex"} · earlier messages are from ${from}` }];
    }
    if (from !== "openclaw") {
      const original = source as AgentSession;
      original.movedTo = [...original.movedTo || [], { agent: to, id, at }];
    }
    window.dispatchEvent(new Event("reach-preview-refresh"));
    return Response.json({ agent: to, id });
  }
  if (path.startsWith("/api/sessions/openclaw/")) {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const key = url.searchParams.get("key") || body.key;
    const session = clawSessions.find(s => s.key === key) || clawSessions[0];
    if (path.endsWith("/overview")) return Response.json({ connected: true, sessions: clawSessions, approvals: [] });
    if (path.endsWith("/new")) {
      const key = `agent:${body.agentId || "main"}:reach-${body.requestId}`;
      if (!clawSessions.some(s => s.key === key)) {
        clawSessions.unshift({ key, title: body.text.trim().split("\n")[0].slice(0, 60), agentId: body.agentId || "main", channel: "webchat", writable: true, canDeliver: false, updatedAt: Date.now(), model: body.model || "Claude Sonnet", status: "idle" });
        clawMessages[key] = [{ id: "first", role: "user", text: body.text, tool: false }, { id: "answer", role: "assistant", text: "This is a sample conversation. Your selected agent, model and thinking level were included when it started.", tool: false }];
      }
      return Response.json({ key });
    }
    if (path.endsWith("/catalog")) return Response.json({ defaultAgentId: "main", agents: [{ id: "main", name: "Personal assistant" }, { id: "work", name: "Work assistant" }], models: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet", reasoning: true }, { id: "openai/gpt-5.4", name: "GPT-5.4", reasoning: true }], canEdit: true, errors: [] });
    if (path.endsWith("/channels")) return Response.json({ channels: [{ channel: "whatsapp", accountId: "personal", name: "Personal account", status: "connected", error: "" }, { channel: "discord", accountId: "work", name: "Work server", status: "connected", error: "" }, { channel: "telegram", accountId: "bot", name: "Personal bot", status: "disconnected", error: "Reconnect this account in OpenClaw." }] });
    if (path.endsWith("/automations")) {
      if (init.method === "POST") { const job = clawJobs.find(j => j.id === body.id); if (job) job.enabled = body.enabled; return Response.json({ enabled: body.enabled }); }
      return Response.json({ jobs: clawJobs.filter(j => j.name.toLowerCase().includes((url.searchParams.get("query") || "").toLowerCase())), canEdit: true, hasMore: false });
    }
    if (path.endsWith("/settings")) {
      if (body.label !== undefined) session.title = body.label;
      if (body.model !== undefined) session.model = body.model || "Claude Sonnet";
      if (body.thinkingLevel !== undefined) Object.assign(session, { thinkingLevel: body.thinkingLevel || "" });
      return Response.json({ saved: true });
    }
    const items = clawMessages[session.key] ||= [
      { id: "claw-user", role: "user", text: "Can you help me organize this?", tool: false },
      { id: "claw-assistant", role: "assistant", text: "Of course. We can pick up right where we left off.\n\nThis conversation is connected to **" + (session.channel === "webchat" ? "OpenClaw" : session.channel) + "**. What would you like to work on next?", tool: false },
    ];
    if (path.endsWith("/history")) return Response.json({ session, items, streaming: "", error: "", approvals: [], mayHaveOlder: false });
    if (path.endsWith("/send")) {
      items.push({ id: body.requestId, role: "user", text: body.text, tool: false });
      items.push({ id: body.requestId + "-reply", role: "assistant", text: body.deliver ? "Sample reply via the original channel. Nothing was actually sent." : "Sample reply in Reach. Your conversation continues here.", tool: false });
      return Response.json({ runId: body.requestId, status: "completed" });
    }
    return Response.json({});
  }

  if (path === "/api/sessions/mac-prompts/sample-mac-password/password") {
    // Any non-empty sample value works; no real password is needed or used.
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (new URLSearchParams(location.search).get("answer") === "blocked")
      return Response.json({ error: "Sample: macOS couldn't complete authentication. Try the live screen." }, { status: 409 });
    macPrompts = [];
    window.dispatchEvent(new Event("reach-preview-refresh"));
    data = { done: true };
  }
  else if (path === "/api/sessions/mac-prompts/sample-mac-request/press") {
    if (new URLSearchParams(location.search).get("answer") === "blocked")
      return Response.json({ error: "macOS could not press this button. Open the live screen to review the dialog." }, { status: 409 });
    const body = JSON.parse(String(init.body));
    if (!["Don’t Allow", "Allow"].includes(body.button))
      return Response.json({ error: "Unknown sample action" }, { status: 400 });
    macPrompts = body.button === "Allow" && new URLSearchParams(location.search).get("answer") === "password" ? [samplePassword] : [];
    window.dispatchEvent(new Event("reach-preview-refresh"));
    data = { pressed: body.button };
  }
  else if (path.endsWith("/logos")) data = { version: permissionPreview || "sample", logos: sampleLogos };
  else if (path.endsWith("/models"))
    data = {
      // Each agent's own sample models, for the model pickers.
      models:
        url.searchParams.get("agent") === "claude"
          ? [
              ["claude-fable-5-1", "Fable 5.1", "For your toughest challenges"],
              ["claude-opus-5-5", "Opus 5.5", "For complex work and everyday tasks"],
              ["claude-sonnet-5-5", "Sonnet 5.5", "Most efficient for simpler tasks"],
              ["claude-haiku-4-5", "Haiku 4.5", "Fastest for quick answers"],
            ].map(([id, name, description], i) => ({
              id,
              name,
              description,
              efforts: i < 3 ? ["low", "medium", "high", "xhigh", "max"] : [],
              defaultEffort: null,
              isDefault: i === 1,
            }))
          : [
              { id: "sample", name: "GPT-5.5", description: "Frontier model for complex coding", efforts: ["minimal", "low", "medium", "high", "xhigh"], defaultEffort: "medium", isDefault: true },
              { id: "sample-mini", name: "GPT-5.5 Mini", description: "Faster and cheaper", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
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
          version: queueVersion,
          ...(queuePreview && s.id === "sample-0" ? { outbox: sampleQueue } : {}),
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
  const [version, redraw] = useState(0);
  const [screenPrompt, setScreenPrompt] = useState<MacPrompt | null>(null);
  const [target, setTarget] = useState<{ agent: AgentSession["agent"] | "openclaw"; id: string } | null>(null);
  useEffect(() => {
    const refresh = () => redraw((n) => n + 1);
    window.addEventListener("reach-preview-refresh", refresh);
    return () => window.removeEventListener("reach-preview-refresh", refresh);
  }, []);
  const feed = {
    sessions: setupPreview ? sessions.filter((s) => s.agent !== "codex") : [...sessions],
    health,
    errors: {},
    failure: "",
    projects: [],
    macPrompts,
    reload: async () => redraw((n) => n + 1),
    recheck: () => {},
  } as AgentFeed;
  return (
    <NotificationCenter peer={peer} enabled changes={String(version)} onOpen={({ target }) => {
      if (target.agent && target.id) setTarget({ agent: target.agent as AgentSession["agent"] | "openclaw", id: target.id });
    }}>
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
          {(permissionPreview === "password" || new URLSearchParams(location.search).get("answer") === "password") && <p className="muted" style={{ fontSize: 12 }}>Sample authentication · Use any made-up password</p>}
          {screenPrompt ? <>
            <p className="muted">Preview only · No Mac connected</p>
            <button onClick={() => setScreenPrompt(null)}>Back to chats</button>
            <Screen peer={peer} device={{ ...peer, capabilities: { screen: false }, roots: [] } as any}
              toast={() => {}} onChanged={() => {}}
              ask={{ ...screenPrompt, open: macPrompts.some((p) => p.id === screenPrompt.id) }}
              onAskDone={() => setScreenPrompt(null)} />
          </> : <EverythingChat peer={peer} feed={feed} target={target} onTargetOpened={() => setTarget(null)} showOnScreen={setScreenPrompt} onScreen={() => setScreenPrompt({ id: "sample-question-screen", kind: "privacy", title: "Answer in Claude", detail: "", app: "Claude" })} />}
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
    </NotificationCenter>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
