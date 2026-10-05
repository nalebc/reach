import { useCallback, useEffect, useRef, useState } from "react";
import { post, request, type Peer } from "./api";

// Every Codex and Claude Code session on the computer (server/agent-sessions).
export type AgentName = "codex" | "claude";
export type AgentSession = {
  agent: AgentName;
  id: string;
  title: string;
  cwd: string;
  branch: string;
  origin: "app" | "cli" | "reach";
  inApp: boolean;
  appSessionId?: string | null;
  updatedAt: number;
  createdAt: number;
  status: "running" | "waiting" | "idle" | "error";
  preview: string;
  archived: boolean;
  live?: { where: "claude-app" | "terminal" | "background"; pid: number; tty: string | null };
  // Filled when one session is read.
  model?: string | null;
  effort?: string | null;
  // Which engine holds a Codex thread right now.
  held?: "reach" | "codex-app" | "daemon" | "terminal" | "other" | null;
  // Permission mode as the agent's app names it (Codex: auto, guardian-approvals…; Claude: auto, plan…).
  mode?: string | null;
};
export type SessionItem = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  kind: "text" | "command" | "file-change" | "tool" | "web" | "compaction" | "error" | "notice";
  text: string;
  detail?: string;
  status?: string;
  queued?: boolean;
  images?: number;
  at?: number;
  turnId?: string;
};
// One agent on the Mac: the ones Reach drives (supported) and others it found
// installed (Gemini, Antigravity, Cursor…), which get their place now.
export type AgentHealth = {
  agent: string;
  name?: string;
  supported?: boolean;
  installed: boolean;
  signedIn: boolean;
  usable?: boolean;
  resetsAt?: number | null;
  error?: string;
};
export type Decision = string | Record<string, unknown>;
export type SessionPrompt = {
  id: string;
  // Codex: command, file-change, permissions, question, elicitation.
  // Claude Code: tool (a permission request), question, dialog (answered on the Mac).
  kind: "command" | "file-change" | "permissions" | "question" | "elicitation" | "tool" | "dialog" | "unknown";
  title: string;
  command?: string;
  cwd?: string;
  reason?: string;
  files?: string[];
  message?: string;
  decisions?: Decision[];
  questions?: {
    id: string;
    header: string;
    question: string;
    options: { label: string; description: string }[];
    other: boolean;
    secret: boolean;
  }[];
};
// What Reach sees live for a session it drives (server/agent-sessions/codex-live).
export type LiveView = {
  version: number;
  status: "running" | "waiting" | "idle" | null;
  error: string | null;
  prompts: SessionPrompt[];
  streaming: string;
  activity: string | null;
  items: number;
};
export type AgentModel = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string | null;
  images: boolean;
  isDefault: boolean;
};

export const agentLabel = (agent: string) =>
  agent === "codex" ? "Codex" : agent === "claude" ? "Claude Code" : agent;

// The agent the Chat tab shows, remembered here and shared with the tab bar
// (which wears that agent's logo).
const CHAT_AGENT = "reach.chatAgent";
export const readChatAgent = (): string => {
  try {
    return localStorage.getItem(CHAT_AGENT) || "codex";
  } catch {
    return "codex";
  }
};
export function saveChatAgent(agent: string) {
  try {
    localStorage.setItem(CHAT_AGENT, agent);
  } catch {
    /* this visit only */
  }
  window.dispatchEvent(new Event("reach-chat-agent"));
}
export function useChatAgent(): [string, (agent: string) => void] {
  const [agent, setAgent] = useState(readChatAgent);
  useEffect(() => {
    const update = () => setAgent(readChatAgent());
    window.addEventListener("reach-chat-agent", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("reach-chat-agent", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return [agent, saveChatAgent];
}

export function whereLabel(s: AgentSession) {
  if (s.held === "codex-app") return "Open in Codex app";
  if (s.live?.where === "terminal" || s.held === "terminal") return "Terminal";
  if (s.live?.where === "claude-app" || (s.agent === "claude" && s.inApp)) return "Claude app";
  if (s.agent === "codex" && s.origin === "app") return "Codex app";
  if (s.origin === "reach") return "Reach";
  return "CLI";
}

export const projectName = (cwd: string) =>
  cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

// The words each app uses for thinking levels and permission modes (read
// from the Codex app's strings and the Claude app's composer).
const EFFORTS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  persistent: "Persistent",
};
export const effortLabel = (effort?: string | null, agent: AgentName = "codex") =>
  !effort ? "" : agent === "claude" && effort === "xhigh" ? "Extra" : EFFORTS[effort] || effort;
const MODES: Record<AgentName, Record<string, string>> = {
  codex: {
    auto: "Ask for approval",
    "guardian-approvals": "Approve for me",
    "full-access": "Full access",
    "read-only": "Read only",
    custom: "Custom",
  },
  claude: {
    auto: "Auto",
    manual: "Manual",
    default: "Manual", // the Claude app shows "Manual" for --permission-mode default
    acceptEdits: "Accept edits",
    plan: "Plan",
    bypassPermissions: "Bypass permissions",
    dontAsk: "Don't ask",
  },
};
export const modeLabel = (agent: AgentName, mode?: string | null) =>
  mode ? MODES[agent][mode] || mode : "";
// The Codex app's menu for new chats, in its order.
export const CODEX_MODE_CHOICES = [
  { id: "auto", label: "Ask for approval", note: "Always ask to edit external files and use the internet" },
  { id: "guardian-approvals", label: "Approve for me", note: "Only ask for actions detected as potentially unsafe" },
  { id: "full-access", label: "Full access", note: "" },
  { id: "custom", label: "Custom (config.toml)", note: "Uses permissions defined in config.toml" },
];

export type AgentFeed = ReturnType<typeof useAgentSessions>;

// One feed for the whole app, started as soon as Reach connects: Home, the
// Chat tab and its badge all read it. Polls while the page is visible; the
// list is cheap (cached on the server).
export function useAgentSessions(peer: Peer | null, everyMs = 4000) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<AgentHealth[]>([]);
  const [failure, setFailure] = useState("");
  const alive = useRef(true);
  // The version we hold; an unchanged list costs a few bytes and no render.
  const known = useRef("");
  // Health on demand (after signing in), besides once a minute.
  const recheck = useRef<() => void>(() => {});
  const key = peer ? `${peer.url} ${peer.token}` : "";
  const load = useCallback(async () => {
    if (!peer || document.hidden) return;
    try {
      const r = await request<
        | { unchanged: true; version: string }
        | { sessions: AgentSession[]; errors: Record<string, string>; version: string }
      >(peer, `/api/sessions${known.current ? `?known=${known.current}` : ""}`);
      if (!alive.current) return;
      known.current = r.version;
      setFailure("");
      if ("unchanged" in r) return;
      setSessions(r.sessions);
      setErrors(r.errors || {});
    } catch (e) {
      if (alive.current) setFailure((e as Error).message);
    }
  }, [key]);
  useEffect(() => {
    setSessions(null);
    setErrors({});
    setHealth([]);
    known.current = "";
    if (!peer) return;
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), everyMs);
    const visible = () => !document.hidden && void load();
    document.addEventListener("visibilitychange", visible);
    // Sign-in and usage change rarely; check on open and every minute.
    let lastHealth = "";
    const checkHealth = () =>
      request<{ agents: AgentHealth[] }>(peer, "/api/sessions/health")
        .then((r) => {
          const next = JSON.stringify(r.agents);
          if (alive.current && next !== lastHealth) {
            lastHealth = next;
            setHealth(r.agents);
          }
        })
        .catch(() => {});
    recheck.current = () => void checkHealth();
    void checkHealth();
    const healthTimer = setInterval(checkHealth, 60000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      clearInterval(healthTimer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load, everyMs]);
  return { sessions, errors, health, failure, reload: load, recheck: () => recheck.current() };
}

const sessionPath = (s: { agent: AgentName; id: string }) =>
  `/api/sessions/${s.agent}/${encodeURIComponent(s.id)}`;

export type SessionPage = { session: AgentSession; items: SessionItem[]; before: string | null; version?: string };
// The newest page, or { unchanged } when it matches the version we hold.
export function readSession(
  peer: Peer,
  s: { agent: AgentName; id: string },
  before?: string | null,
  known?: string,
) {
  const query = new URLSearchParams({
    limit: "150",
    ...(before ? { before } : {}),
    ...(known && !before ? { known } : {}),
  });
  return request<SessionPage | { unchanged: true; version: string }>(peer, `${sessionPath(s)}?${query}`);
}

export const openInApp = (peer: Peer, s: { agent: AgentName; id: string }) =>
  post(peer, `${sessionPath(s)}/open`);

export type Outgoing = { text: string; images: string[]; model?: string; effort?: string; mode?: string };
export const sendMessage = (peer: Peer, s: { agent: AgentName; id: string }, body: Outgoing) =>
  post<{ turnId?: string; steered?: boolean; queued?: boolean; delivered?: boolean }>(
    peer,
    `${sessionPath(s)}/messages`,
    body,
  );
export const answerPrompt = (
  peer: Peer,
  s: { agent: AgentName; id: string },
  prompt: string,
  answer: { decision?: string; answers?: Record<string, string[]>; content?: unknown },
) => post(peer, `${sessionPath(s)}/prompts/${encodeURIComponent(prompt)}`, answer);
export const stopSession = (peer: Peer, s: { agent: AgentName; id: string }) =>
  post(peer, `${sessionPath(s)}/stop`);
export const startSession = (
  peer: Peer,
  body: Outgoing & { agent: AgentName; cwd: string; mode?: string },
) => post<{ threadId: string; turnId: string | null }>(peer, "/api/sessions", body);
// Models, and the mode the agent's app starts new chats in. They change
// rarely, so each Mac's list is fetched once per ten minutes.
const modelCache = new Map<string, { at: number; value: Promise<{ models: AgentModel[]; mode: string | null }> }>();
export function listModels(peer: Peer, agent: AgentName) {
  const key = `${peer.url} ${agent}`;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.value;
  const value = request<{ models: AgentModel[]; mode: string | null }>(peer, `/api/sessions/models?agent=${agent}`);
  modelCache.set(key, { at: Date.now(), value });
  value.catch(() => modelCache.delete(key));
  return value;
}

// Slash commands the agent offers after "/", fetched once per Mac.
export type AgentCommand = { name: string; description: string; hint: string };
const commandCache = new Map<string, Promise<AgentCommand[]>>();
export function listCommands(peer: Peer, agent: AgentName) {
  const key = `${peer.url} ${agent}`;
  if (!commandCache.has(key)) {
    const value = request<{ commands: AgentCommand[] }>(peer, `/api/sessions/commands?agent=${agent}`).then((r) => r.commands);
    commandCache.set(key, value);
    value.catch(() => commandCache.delete(key));
  }
  return commandCache.get(key)!;
}

export async function uploadImage(peer: Peer, file: Blob, name = "image") {
  const form = new FormData();
  form.append("file", file, name);
  const r = await request<{ id: string }>(peer, "/api/sessions/images", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  return r.id;
}

// AbortSignal.any is missing on older iOS. `done` lets go of the outer
// signal once the request settles, so a long session doesn't pile up listeners.
function either(a: AbortSignal, ms: number) {
  const both = new AbortController();
  const stop = () => both.abort();
  const timer = setTimeout(stop, ms);
  a.addEventListener("abort", stop, { once: true });
  return {
    signal: both.signal,
    done: () => {
      clearTimeout(timer);
      a.removeEventListener("abort", stop);
    },
  };
}

const EMPTY: LiveView = {
  version: 0,
  status: null,
  error: null,
  prompts: [],
  streaming: "",
  activity: null,
  items: 0,
};

// Live state of one session by long polling: the server answers as soon as
// something changes (streamed text, a prompt, the turn ending).
export function useSessionLive(peer: Peer, s: { agent: AgentName; id: string } | null) {
  const [view, setView] = useState<LiveView>(EMPTY);
  const key = s ? `${peer.url} ${peer.token} ${s.agent} ${s.id}` : "";
  const [poke, setPoke] = useState(0);
  useEffect(() => {
    setView(EMPTY);
    if (!s) return;
    const controller = new AbortController();
    let version: number | null = null;
    let failures = 0;
    void (async () => {
      while (!controller.signal.aborted) {
        const wait = either(controller.signal, 35000);
        try {
          const next: LiveView = await request<LiveView>(
            peer,
            `${sessionPath(s)}/live${version === null ? "" : `?since=${version}`}`,
            { signal: wait.signal },
          ).finally(wait.done);
          if (controller.signal.aborted) return;
          failures = 0;
          version = next.version;
          setView(next);
        } catch {
          if (controller.signal.aborted) return;
          // Back off while the Mac is out of reach.
          await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** failures++)));
        }
      }
    })();
    return () => controller.abort();
  }, [key, poke]);
  return { view, refresh: () => setPoke((n) => n + 1) };
}
