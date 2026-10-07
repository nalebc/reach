import { useCallback, useEffect, useRef, useState } from "react";
import { post, request, type Peer } from "./api";

// Every Codex and Claude Code session on the computer (server/agent-sessions).
export type AgentName = "codex" | "claude" | "gemini";
// A sub-agent a chat started (server/agent-sessions/subagents.mjs).
export type Subagent = {
  id: string;
  toolUseId: string | null;
  name: string;
  type: string;
  background: boolean;
  status: "running" | "done" | "failed" | "stopped" | "quiet";
  activity: string;
  result: string;
  startedAt: number;
  updatedAt: number;
};
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
  // Its sub-agents, newest first.
  subagents?: Subagent[];
  // Claude's todo list as it stands.
  todos?: { id: string; text: string; status: "pending" | "in_progress" | "completed" }[];
  effort?: string | null;
  // Codex's speed (service tier) the chat runs at, when it says.
  speed?: string | null;
  // Which engine holds a Codex thread right now.
  held?: "reach" | "codex-app" | "daemon" | "terminal" | "other" | null;
  // Permission mode as the agent's app names it (Codex: auto, guardian-approvals…; Claude: auto, plan…).
  mode?: string | null;
  // What it waits on you for in another app (the Claude app, a terminal).
  asking?: AgentAsking;
  // The Claude app's own consent card it waits on (id when answerable here).
  consent?: { id?: string; kind: string; title: string; reason?: string; options?: string[] };
  // Prompts waiting on the phone (permission requests, questions).
  prompts?: SessionPrompt[];
  // Continued from a chat with the other agent, as if forked (move.mjs).
  movedFrom?: { agent: string; id: string; title?: string };
  // Where this chat was continued with another agent.
  movedTo?: { agent: string; id: string; at?: number }[];
};
export type AgentQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};
export type AgentAsking =
  // id: Claude's question in the Claude app, answered from here (its options
  // pressed there).
  | { kind: "question"; questions: AgentQuestion[]; id?: string }
  // id: the Claude app's card, answerable from here (Allow once or Deny).
  | { kind: "permission"; text: string; command?: boolean; id?: string }
  // Something else Claude Code shows and waits on (a notice to acknowledge).
  | { kind: "dialog"; text: string }
  // The Claude app's own consent card (using apps, a folder).
  | {
      kind: "consent";
      id?: string;
      about?: "apps" | "screen" | "teach" | "folder";
      title: string;
      reason?: string;
      apps?: { name: string; appId?: string }[];
      options?: string[];
    };
export type SessionItem = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  kind: "text" | "command" | "file-change" | "tool" | "web" | "compaction" | "error" | "notice" | "output" | "agent";
  text: string;
  // A sub-agent the chat started (kind "agent"): its kind, whether it runs
  // in the background, and its status and doing now, from its own files.
  agentType?: string;
  background?: boolean;
  agentId?: string;
  agentStatus?: Subagent["status"];
  activity?: string;
  detail?: string;
  status?: string;
  queued?: boolean;
  images?: number;
  // A slash command as typed ("/context"); Codex skills sent with a message.
  slash?: boolean;
  skills?: string[];
  // Codex can ask these while continuing to work; answers are chat replies.
  questions?: { title: string; options: string[] }[];
  at?: number;
  turnId?: string;
};
// One agent on the Mac: the ones Reach drives (supported) and others it found
// installed (Gemini, Antigravity, Cursor…), which get their place now.
export type AgentHealth = {
  usage?: {
    available: boolean;
    error?: string;
    updatedAt?: number;
    windows: { id: string; label: string; usedPercent: number; resetsAt: number | null; severity: string }[];
    credits?: { unlimited: boolean; balance?: string | null } | null;
    spend?: { enabled: boolean; used?: { amount_minor: number; currency: string; exponent: number } | null; limit?: { amount_minor: number; currency: string; exponent: number } | null };
  };
  agent: string;
  name?: string;
  supported?: boolean;
  installed: boolean;
  signedIn: boolean;
  usable?: boolean;
  resetsAt?: number | null;
  // Codex: free rate-limit resets the account holds.
  resetCredits?: number;
  // Claude: its app's own sign-in (the CLI's is `signedIn`).
  app?: { installed: boolean; signedIn: boolean };
  // Claude, while out of usage: the limit it hit, in Claude Code's own words.
  limit?: string;
  // OpenClaw: whether its Gateway can take a chat moved from another agent.
  canTakeMoves?: boolean;
  error?: string;
};
// Spends one Codex rate-limit reset (the Codex app's "Reset usage").
export const resetUsage = (peer: Peer, agent: AgentName) =>
  post<{ outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" }>(peer, "/api/sessions/usage/reset", { agent });
// "Oct 9, 2026, 9:25 PM", as the Codex app writes a reset time.
export const resetTime = (at: number, year = true) =>
  new Date(at).toLocaleString([], { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), hour: "numeric", minute: "2-digit" });
export type Decision = string | Record<string, unknown>;
export type SessionPrompt = {
  id: string;
  attempted?: boolean;
  // Codex: command, file-change, permissions, question, elicitation.
  // Claude Code: tool (a permission request), question, dialog (answered on the Mac).
  kind: "command" | "file-change" | "permissions" | "question" | "elicitation" | "tool" | "dialog" | "plan" | "unknown";
  title: string;
  // Claude Code's plan, ready to go (kind "plan"), as markdown.
  plan?: string;
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
    // Several choices may be picked (Claude Code's multiSelect).
    multiSelect?: boolean;
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
  // Messages waiting their turn on the Mac: Claude's sent from the phone,
  // Codex's in the Codex app's own queue.
  outbox?: OutboxMessage[];
};
export type OutboxMessage = {
  id: string;
  text: string;
  images: number;
  at?: number;
  error?: string;
  via?: "app";
  // Send now pressed, or being handed over right now.
  sending?: boolean;
};
export type AgentModel = {
  id: string;
  name: string;
  description?: string;
  efforts: string[];
  // The agent's own words for each effort (Codex: "Extra high reasoning depth…").
  effortNotes?: Record<string, string>;
  defaultEffort: string | null;
  images: boolean;
  isDefault: boolean;
  // Claude Code: whether this model takes Auto mode.
  autoMode?: boolean;
  // Codex: its speeds (service tiers), as the app's Speed menu lists them.
  speeds?: { id: string; name: string; note?: string }[];
  defaultSpeed?: string | null;
};
// A dialog macOS itself shows (server/mac-prompts.mjs), answered at the Mac.
export type MacPrompt = {
  id: string;
  kind: "privacy" | "security" | "password";
  title: string;
  detail: string;
  app: string | null;
  buttons?: string[];
  // The dialog's own lines (its message first) and the button Return presses.
  lines?: string[];
  default?: string;
  // Where it is switched on in System Settings (opened on the Mac from here).
  setting?: { name: string; url: string };
  // Where the dialog is on the Mac's screen (global points).
  bounds?: { x: number; y: number; width: number; height: number };
  image?: string;
};
// A project as the Codex app's sidebar shows it: a name and its folders.
export type AgentProject = { id: string; name: string; roots: string[] };
// A permission mode as the agent offers it now (server/agent-sessions:
// Codex's permission profiles, Claude Code's --permission-mode choices).
export type AgentMode = { id: string; label: string; note?: string };
// The modes to offer for a model: the agent's list, without Auto for a
// Claude model that doesn't take it.
export const modesFor = (modes: AgentMode[], model?: AgentModel | null) =>
  modes.filter((m) => !(m.id === "auto" && model && model.autoMode === false));

export const agentLabel = (agent: string) =>
  ({ codex: "Codex", claude: "Claude Code", gemini: "Gemini CLI", openclaw: "OpenClaw" })[agent] || agent;

// Out of usage: the page each agent sends you to for more, opened on the
// phone, where you buy it. Codex's own message names its page ("Visit … to
// purchase more credits"); Claude Code links its usage settings, or the admin
// page when your organization manages usage. Fixed addresses only: an agent's
// text never becomes a link.
export type UsageLink = { label: string; url: string };
const CODEX_USAGE: UsageLink = { label: "Purchase more credits", url: "https://chatgpt.com/codex/settings/usage" };
const CLAUDE_USAGE: UsageLink = { label: "Get more usage", url: "https://claude.ai/settings/usage" };
const CLAUDE_ADMIN_USAGE: UsageLink = { label: "Get more usage", url: "https://claude.ai/admin-settings/usage" };
export function usageLink(agent: string, error: { text?: string | null; detail?: string | null }): UsageLink | null {
  const text = error.text || "";
  if (agent === "codex")
    return error.detail === "usageLimitExceeded" || /hit your usage limit|purchase more credits/i.test(text) ? CODEX_USAGE : null;
  if (agent !== "claude") return null;
  // `rate_limit` alone also covers a brief slowdown ("send a message to
  // retry"); only a used-up limit or balance gets the link.
  const outOfUsage =
    error.detail === "billing_error" ||
    /hit your [\w' ]{0,30}limit|usage limit|out of (extra )?usage|usage credits|spend limit|credit balance/i.test(text);
  if (!outOfUsage) return null;
  return /admin-settings\/usage|your admin/i.test(text) ? CLAUDE_ADMIN_USAGE : CLAUDE_USAGE;
}

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
  // Gemini CLI's --approval-mode choices.
  gemini: {
    default: "Default",
    auto_edit: "Auto-edit",
    yolo: "YOLO",
    plan: "Plan",
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

type SessionList = {
  sessions: AgentSession[];
  errors: Record<string, string>;
  projects?: { codex?: AgentProject[] };
  macPrompts?: MacPrompt[];
  version: string;
};

// One feed for the whole app, started as soon as Reach connects: Home, the
// Chat tab and its badge all read it. Polls while the page is visible; the
// list is cheap (cached on the server).
// revision: the list's revision as the Mac's live connection tells it
// (undefined when that connection doesn't: an older Reach, or not connected).
export function useAgentSessions(peer: Peer | null, everyMs = 4000, revision?: string) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [macPrompts, setMacPrompts] = useState<MacPrompt[]>([]);
  const [health, setHealth] = useState<AgentHealth[]>([]);
  const [failure, setFailure] = useState("");
  // Bumped when the feed stops or restarts: answers to requests sent
  // before are dropped, so an old "unchanged" can't set `known` over the
  // emptied list (the Chat tab stuck on "Finding your conversations…").
  const run = useRef(0);
  // The version we hold; an unchanged list costs a few bytes and no render.
  const known = useRef("");
  // Whether a list is held for `known` to stand for.
  const held = useRef(false);
  // Health on demand (after signing in), besides once a minute.
  const recheck = useRef<() => void>(() => {});
  const key = peer ? `${peer.url} ${peer.token}` : "";
  // A read that fails while the Mac is out of reach for a moment (the phone
  // waking, the network changing, Reach restarting) is tried again soon, and
  // said only if it lasts.
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const again = useRef<() => void>(() => {});
  // fresh: built anew, not the Mac's kept list (Refresh, after an action).
  const load = useCallback(async (fresh = false) => {
    if (!peer || document.hidden) return;
    const mine = run.current;
    const ask = (since: string) => {
      const query = [since && `known=${since}`, fresh && "fresh=1"].filter(Boolean).join("&");
      return request<{ unchanged: true; version: string } | SessionList>(peer, `/api/sessions${query ? `?${query}` : ""}`);
    };
    try {
      let r = await ask(known.current);
      if (mine !== run.current) return;
      // "Unchanged", yet no list here to keep: ask for the whole of it.
      if ("unchanged" in r && !held.current) {
        known.current = "";
        r = await ask("");
        if (mine !== run.current) return;
      }
      failures.current = 0;
      clearTimeout(retry.current);
      setFailure("");
      if ("unchanged" in r) return;
      known.current = r.version;
      held.current = true;
      setSessions(r.sessions);
      setErrors(r.errors || {});
      setProjects(r.projects?.codex || []);
      setMacPrompts(r.macPrompts || []);
    } catch (e) {
      if (mine !== run.current) return;
      failures.current++;
      if (failures.current > 1) setFailure((e as Error).message);
      clearTimeout(retry.current);
      retry.current = setTimeout(() => again.current(), Math.min(8000, 1000 * 2 ** (failures.current - 1)));
    }
  }, [key]);
  again.current = () => void load();
  useEffect(() => {
    setSessions(null);
    setErrors({});
    setHealth([]);
    known.current = "";
    held.current = false;
    failures.current = 0;
    clearTimeout(retry.current);
    if (!peer) return;
    void load();
    const visible = () => !document.hidden && void load();
    document.addEventListener("visibilitychange", visible);
    // The phone's network back: asked at once.
    window.addEventListener("online", visible);
    // Sign-in and usage change rarely; check on open and every minute.
    let lastHealth = "";
    let healthActive = true;
    const checkHealth = (fresh = false) =>
      request<{ agents: AgentHealth[] }>(peer, `/api/sessions/health${fresh ? "?fresh=1" : ""}`)
        .then((r) => {
          const next = JSON.stringify(r.agents);
          if (healthActive && next !== lastHealth) {
            lastHealth = next;
            setHealth(r.agents);
          }
        })
        .catch(() => {});
    recheck.current = () => void checkHealth(true);
    void checkHealth();
    const healthTimer = setInterval(checkHealth, 60000);
    return () => {
      run.current++;
      healthActive = false;
      clearInterval(healthTimer);
      clearTimeout(retry.current);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
    };
  }, [load, everyMs]);
  // The Mac says when the list changes (revision, on its live connection):
  // read then, with a slow safety look. A Mac that doesn't say is asked every
  // few seconds, as before.
  const pushed = revision !== undefined;
  useEffect(() => {
    if (!peer) return;
    const timer = setInterval(() => void load(), pushed ? Math.max(everyMs, 60000) : everyMs);
    return () => clearInterval(timer);
  }, [load, everyMs, pushed]);
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === undefined || revision === seenRevision.current) return;
    seenRevision.current = revision;
    void load();
  }, [revision, load]);
  return { sessions, errors, health, failure, projects, macPrompts, reload: () => load(true), recheck: () => recheck.current() };
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

export type Outgoing = { text: string; images: string[]; files?: string[]; model?: string; effort?: string; speed?: string; mode?: string; skill?: string; steer?: boolean; collaboration?: "plan" | "default" };
export const cancelQueuedMessage = (peer: Peer, s: { agent: AgentName; id: string }, id: string) =>
  post<{ deleted: true }>(peer, `${sessionPath(s)}/queue/${encodeURIComponent(id)}/cancel`);
// Messages from the phone whose chat was deleted (server outbox.mjs): sent to
// another chat from here, or deleted (cancelQueuedMessage, with their chat).
export type StrandedMessage = { session: string; id: string; text: string; images: number; at: number; title: string };
export const readStranded = (peer: Peer) =>
  request<{ messages: StrandedMessage[] }>(peer, "/api/sessions/stranded");
export const sendStranded = (peer: Peer, id: string, to: { agent: AgentName; id: string }) =>
  post(peer, `/api/sessions/stranded/${encodeURIComponent(id)}/send`, to);
// A chat deleted, as in its app.
export const deleteSession = (peer: Peer, s: { agent: AgentName; id: string }) =>
  request<{ deleted: true }>(peer, sessionPath(s), { method: "DELETE" });
// A chat renamed, as in its app.
export const renameSession = (peer: Peer, s: { agent: AgentName; id: string }, title: string) =>
  post<{ title: string }>(peer, `${sessionPath(s)}/rename`, { title });
// Your last message edited and sent again (the Codex app's Edit).
export const editLastMessage = (peer: Peer, s: { agent: AgentName; id: string }, body: { turnId: string; text: string }) =>
  post<{ edited: true }>(peer, `${sessionPath(s)}/edit-last`, body);
// A queued message's words changed where it waits (pictures kept).
export const editQueued = (peer: Peer, s: { agent: AgentName; id: string }, id: string, text: string) =>
  post<{ edited: true }>(peer, `${sessionPath(s)}/queue/${encodeURIComponent(id)}/edit`, { text });
// Send now, as in the agent's app: first in line, in at once.
export const sendQueuedNow = (peer: Peer, s: { agent: AgentName; id: string }, id: string) =>
  post<{ hurried: true }>(peer, `${sessionPath(s)}/queue/${encodeURIComponent(id)}/now`);
// A new order for what waits (dragged on the phone).
export const reorderQueued = (peer: Peer, s: { agent: AgentName; id: string }, order: string[]) =>
  post<{ reordered: true }>(peer, `${sessionPath(s)}/queue/order`, { order });
export const syncAgentDraft = (peer: Peer, s: { agent: AgentName; id: string }, text: string) =>
  post<{ synced: boolean; supported?: boolean }>(peer, `${sessionPath(s)}/draft`, { text });
// A permission mode picked on the phone; for a Claude app chat, picked in the
// app too (applied: false when it goes with the next message instead).
export const setAgentMode = (peer: Peer, s: { agent: AgentName; id: string }, mode: string) =>
  post<{ mode: string; applied: boolean }>(peer, `${sessionPath(s)}/mode`, { mode });
export const setAgentModel = (peer: Peer, s: { agent: AgentName; id: string }, choice: { model?: string; effort?: string }) =>
  post<{ model: string; effort?: string; applied: boolean }>(peer, `${sessionPath(s)}/model`, choice);
export const sendMessage = (peer: Peer, s: { agent: AgentName; id: string }, body: Outgoing) =>
  post<{ turnId?: string; steered?: boolean; queued?: boolean; delivered?: boolean; messageId?: string }>(
    peer,
    `${sessionPath(s)}/messages`,
    body,
  );
// Presses one of a Mac dialog's own buttons (owner only).
export const pressMacButton = (peer: Peer, id: string, button: string) =>
  post<{ pressed: string }>(peer, `/api/sessions/mac-prompts/${encodeURIComponent(id)}/press`, { button });
// Types the Mac's password into its password dialog (owner only; never kept).
export const sendMacPassword = (peer: Peer, id: string, password: string) =>
  post<{ done: true }>(peer, `/api/sessions/mac-prompts/${encodeURIComponent(id)}/password`, { password });
// Opens, on the Mac, the System Settings page a Mac prompt belongs to.
export const openMacSetting = (peer: Peer, id: string) =>
  post<{ opened: string; app: string | null }>(peer, `/api/sessions/mac-prompts/${encodeURIComponent(id)}/setting`);
// A picture sent in a session, fetched once per page (it never changes).
// The 80 most recently shown are kept; older ones are let go (fetched again
// if shown again), so a long day of chats doesn't fill the phone's memory.
const pictures = new Map<string, Promise<string>>();
const KEPT_PICTURES = 80;
export function sessionImage(peer: Peer, s: { agent: AgentName; id: string }, item: string, n: number) {
  const key = `${peer.url}|${s.agent}|${s.id}|${item}|${n}`;
  let found = pictures.get(key);
  if (found) {
    // Most recently shown last.
    pictures.delete(key);
    pictures.set(key, found);
  } else {
    while (pictures.size >= KEPT_PICTURES) {
      const [oldest, url] = pictures.entries().next().value!;
      pictures.delete(oldest);
      // A moment later: an image still on screen has long been decoded.
      void url.then((u) => setTimeout(() => URL.revokeObjectURL(u), 30000)).catch(() => {});
    }
    found = fetch(`${peer.url}${sessionPath(s)}/images/${encodeURIComponent(item)}/${n}`, {
      headers: { Authorization: `Bearer ${peer.token}` },
      redirect: "error",
    })
      .then((r) => {
        if (!r.ok) throw Error("That picture isn't available.");
        return r.blob();
      })
      .then((blob) => URL.createObjectURL(blob));
    found.catch(() => pictures.delete(key));
    pictures.set(key, found);
  }
  return found;
}
export const answerPrompt = (
  peer: Peer,
  s: { agent: AgentName; id: string },
  prompt: string,
  answer: { decision?: string; label?: string; answers?: Record<string, string[]>; content?: unknown },
) => post(peer, `${sessionPath(s)}/prompts/${encodeURIComponent(prompt)}`, answer);
// Installing Claude Code or Codex on the Mac (server/agent-install.mjs): its
// maker's command first, to show; confirmed, run in a Reach terminal.
export type InstallPlan = {
  agent: string;
  name: string;
  command: string;
  terminal?: { id: string; status: string; exitCode?: number; preview?: string };
};
export const installAgent = (peer: Peer, agent: string, confirm = false) =>
  post<InstallPlan>(peer, `/api/sessions/agent-install/${encodeURIComponent(agent)}`, { confirm });
// A permission card the Claude app or the Codex app shows, as it shows it:
// its words and its buttons, in order (that chat comes up in the app).
// more: the choices in the card's menu (the Codex app's "Approval options");
// moreInApp: a menu whose choices stay in the app.
export type AppCard = { id: string; texts: string[]; buttons: string[]; more?: string[]; moreInApp?: boolean };
export const appCard = (peer: Peer, s: { agent: AgentName; id: string }) =>
  request<AppCard>(peer, `${sessionPath(s)}/card`);
// Continues a chat with the other agent, as if forked in the same app: the
// new chat's address comes back.
export const moveSession = (peer: Peer, s: { agent: string; id: string }, to: string) =>
  post<{ agent: string; id: string }>(peer, `/api/sessions/${s.agent}/${encodeURIComponent(s.id)}/move`, { to });
// Archived (or back) in the chat's own app: it leaves Reach's list and the
// app's alike (Codex's archive; the Claude app's own record).
export const archiveSession = (peer: Peer, s: { agent: string; id: string }, archived = true) =>
  post<{ archived: boolean }>(peer, `/api/sessions/${s.agent}/${encodeURIComponent(s.id)}/archive`, { archived });
export const stopSession = (peer: Peer, s: { agent: AgentName; id: string }) =>
  post(peer, `${sessionPath(s)}/stop`);
export const startSession = (
  peer: Peer,
  body: Outgoing & { agent: AgentName; cwd: string; mode?: string },
) => post<{ threadId: string; turnId: string | null }>(peer, "/api/sessions", body);
// Models, and the mode the agent's app starts new chats in. They change
// rarely, so each Mac's list is fetched once per ten minutes.
const modelCache = new Map<string, { at: number; value: Promise<{ models: AgentModel[]; mode: string | null; modes?: AgentMode[] }> }>();
export function listModels(peer: Peer, agent: AgentName, { refresh = false } = {}) {
  const key = `${peer.url} ${peer.token} ${agent}`;
  const hit = modelCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < 600000) return hit.value;
  const value = request<{ models: AgentModel[]; mode: string | null; modes?: AgentMode[] }>(
    peer,
    `/api/sessions/models?agent=${agent}`,
  );
  modelCache.set(key, { at: Date.now(), value });
  const forget = () => { if (modelCache.get(key)?.value === value) modelCache.delete(key); };
  value.then((result) => { if (!result.models.length) forget(); }, forget);
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

// Any other file for a message; it goes to the agent as its path.
export async function uploadFile(peer: Peer, file: Blob, name = "file") {
  const form = new FormData();
  form.append("file", file, name);
  const r = await request<{ id: string; name: string }>(peer, "/api/sessions/files", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(300000),
  });
  return r.id;
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
