// Isolated presentation data. No host API, shell, AI provider, or real credentials.
const peer = {
  id: "readme-demo",
  name: "Home Mac",
  platform: "darwin",
  url: location.origin,
  token: "demo-only-not-a-credential",
};
localStorage.setItem("reach.devices", JSON.stringify([peer]));
localStorage.setItem("reach.active", peer.id);
const now = new Date().toISOString();
const sessions = [
  { agent: "codex", id: "demo-codex", title: "Build a better workspace", preview: "The mobile workspace is ready to review.", status: "idle" },
  { agent: "claude", id: "demo-claude", title: "Review the sign-in flow", preview: "Checking the connection and permissions flow.", status: "idle" },
].map((session) => ({ ...session, cwd: "/Projects/Reach", branch: "main", origin: "reach", inApp: false, held: "reach", archived: false, model: "sample", effort: "medium", mode: "auto", updatedAt: Date.now(), createdAt: Date.now() }));
const device = {
  ...peer,
  arch: "arm64",
  release: "26.0",
  uptime: 3600,
  memory: { total: 32000000000, free: 16000000000 },
  roots: [{ id: 0, name: "Documents", path: "/Users/demo/Documents" }],
  network: { connected: true, peers: [] },
  tools: { codex: { installed: true } },
  capabilities: {
    files: true,
    apps: true,
    screen: true,
    screenSupported: true,
    terminal: true,
    codex: true,
  },
};
const chats = [
  {
    id: "demo-chat",
    name: "Build a better workspace",
    cwd: "Documents",
    status: "idle",
    createdAt: now,
  },
  {
    id: "demo-review",
    name: "Review the mobile experience",
    cwd: "Projects/Reach",
    status: "waiting",
    createdAt: now,
  },
];
const realFetch = window.fetch.bind(window);
// A self-contained two-page PDF fixture for the real file viewer; offsets are byte
// positions because this entire sample uses ASCII.
const pdfSample = (() => {
  const drawing = "BT /F1 24 Tf 40 180 Td (Reach file preview) Tj ET\n";
  const second = "BT /F1 24 Tf 40 180 Td (Second page verified) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 260] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 260] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${drawing.length} >>\nstream\n${drawing}endstream`,
    `<< /Length ${second.length} >>\nstream\n${second}endstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => { offsets.push(data.length); data += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = data.length;
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  data += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return data + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
})();
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.href,
  );
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  if (url.pathname === "/api/files/content" && url.searchParams.get("path") === "Preview sample.pdf" && (!init?.method || init.method === "GET"))
    return new Response(pdfSample, { headers: { "Content-Type": "application/pdf", "Content-Length": String(pdfSample.length) } });
  let data: unknown = [];
  if (url.pathname === "/api/terminals/desktop") data = { sessions: [] };
  if (url.pathname === "/api/terminals/agents") data = { agents: ["codex", "claude"] };
  if (url.pathname === "/api/sessions") data = { sessions, macPrompts: [], errors: {}, version: "demo-v2" };
  if (url.pathname === "/api/sessions/health") data = { agents: ["codex", "claude"].map(agent => ({ agent, name: agent === "codex" ? "Codex" : "Claude Code", supported: true, installed: true, signedIn: true, usable: true })) };
  if (url.pathname === "/api/sessions/logos") data = { logos: {}, version: "demo-v2" };
  if (url.pathname === "/api/sessions/stranded") data = { messages: [] };
  if (url.pathname === "/api/sessions/commands") data = { commands: [] };
  if (url.pathname === "/api/sessions/models") data = { models: [{ id: "sample", name: "Sample model", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true }], modes: [{ id: "auto", label: "Ask for approval" }], mode: "auto" };
  if (url.pathname === "/api/notifications") data = { items: [], unavailable: [] };
  if (url.pathname === "/api/browser/agents") data = { agents: [], at: Date.now() };
  if (url.pathname === "/api/pause") data = { paused: false };
  if (url.pathname === "/api/guests/keys") data = { configured: true };
  if (url.pathname === "/api/agents/browser-options") data = { terminals: [], desktopAvailable: true, maxFunnelSeconds: 86400, standingAllowed: true, presetApps: [] };
  const session = sessions.find(s => url.pathname.startsWith(`/api/sessions/${s.agent}/${s.id}`));
  if (session) {
    data = url.pathname.endsWith("/live")
      ? { version: 1, status: "idle", prompts: [], streaming: "", activity: null, items: 2, queue: [] }
      : { session, items: [
          { id: "sample-user", role: "user", kind: "text", text: "Help me make this workspace simpler.", at: Date.now() - 120000 },
          { id: "sample-reply", role: "assistant", kind: "text", text: "Your chats, files, and computer are together in Reach.\n\nYou can continue a conversation, browse a shared folder, or open the live screen from the navigation below.", at: Date.now() - 60000 },
        ], before: null };
    if (url.pathname.endsWith("/live")) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (url.pathname === "/api/device") data = device;
  if (url.pathname === "/api/codex/status")
    data = { available: true, signedIn: true };
  if (url.pathname === "/api/clients")
    data = {
      current: "demo-phone",
      clients: [
        {
          id: "demo-phone",
          name: "My iPhone",
          kind: "owner",
          scopes: ["admin"],
          createdAt: now,
        },
        {
          id: "demo-guest",
          name: "Alex",
          kind: "guest",
          scopes: ["files:read"],
          createdAt: now,
          status: "active",
          expiresAt: Date.now() + 900000,
        },
      ],
    };
  if (url.pathname === "/api/chats") data = chats;
  if (url.pathname === "/api/chats/demo-chat")
    data = {
      ...chats[0],
      updatedAt: now,
      approvals: [],
      items: [
        {
          id: "m1",
          type: "userMessage",
          content: [{ type: "text", text: "Help me organize this project." }],
        },
        {
          id: "m2",
          type: "agentMessage",
          text: "Ready when you are. We can start by reviewing the files in this folder.",
        },
      ],
    };
  if (url.pathname === "/api/chats/demo-review")
    data = { ...chats[1], items: [], approvals: [] };
  if (url.pathname === "/api/terminals")
    data = [
      {
        id: "demo-terminal",
        name: "Project terminal",
        status: "running",
        cwd: "Documents",
        createdAt: now,
      },
    ];
  if (url.pathname === "/api/apps/shortcuts")
    data = [
      {
        id: "codex-new",
        name: "New Codex session",
        kind: "codex",
        suggested: true,
      },
      { id: "app:chrome", name: "Chrome", kind: "browser", suggested: true },
      {
        id: "app:terminal",
        name: "Terminal",
        kind: "terminal",
        suggested: true,
      },
      { id: "app:notes", name: "Notes", kind: "app", suggested: true },
    ];
  if (url.pathname === "/api/apps/shortcuts/icon") data = { icon: null };
  if (url.pathname === "/api/files")
    data = {
      items: [
        {
          name: "Project notes.md",
          path: "Project notes.md",
          type: "file",
          size: 4500,
          modified: now,
        },
        {
          name: "Preview sample.pdf",
          path: "Preview sample.pdf",
          type: "file",
          size: pdfSample.length,
          modified: now,
        },
        {
          name: "Designs",
          path: "Designs",
          type: "directory",
          size: 0,
          modified: now,
        },
      ],
    };
  if (url.pathname === "/api/files/text") data = { text: "# Project notes\n\nA private workspace for your computers.\n\n- Continue a chat\n- Browse your files\n- Open the live screen\n", size: 128, truncated: false };
  if (init?.method && init.method !== "GET")
    return new Response(
      JSON.stringify({ error: "This UI demo is read-only." }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
};

const RealSocket = window.WebSocket;
class DemoSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(url: string | URL, protocols?: string | string[]) {
    // Vite HMR is the only actual socket, and only to this local demo server.
    const hmr = protocols === "vite-hmr" || (Array.isArray(protocols) && protocols.includes("vite-hmr"));
    const target = new URL(String(url), location.href);
    if (hmr && target.hostname === location.hostname && target.port === location.port)
      return new RealSocket(url, protocols) as unknown as DemoSocket;
    setTimeout(() => {
      if (this.readyState !== 3) {
        this.readyState = 1;
        this.onopen?.({});
      }
    }, 30);
  }
  send() {
    this.onmessage?.({
      data: JSON.stringify({
        type: "presence",
        devices: [
          {
            id: "self",
            name: "My iPhone",
            kind: "phone",
            self: true,
            activity: "connected",
            access: [{ kind: "paired" }],
          },
          {
            id: "tablet",
            name: "My iPad",
            kind: "tablet",
            self: false,
            activity: "viewing",
            access: [{ kind: "paired" }],
          },
          {
            id: "guest",
            name: "Alex’s phone",
            kind: "phone",
            self: false,
            activity: "connected",
            access: [{ kind: "invited", expiresAt: Date.now() + 900000 }],
          },
        ],
      }),
    });
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
window.WebSocket = DemoSocket as unknown as typeof WebSocket;
await import("../../src/main.tsx");
export {};
