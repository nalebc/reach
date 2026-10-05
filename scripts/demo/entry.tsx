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
const now = "2026-10-04T12:00:00.000Z";
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
  let data: unknown = [];
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
          name: "Designs",
          path: "Designs",
          type: "directory",
          size: 0,
          modified: now,
        },
      ],
    };
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
  constructor(url: string | URL) {
    // Vite HMR is the only actual socket, and only to this local demo server.
    if (String(url).includes("vite-hmr"))
      return new RealSocket(url) as unknown as DemoSocket;
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
