import { withQuestionReplies } from "../server/agent-sessions/codex-questions.mjs";
import { useWantedPrompt } from "./notification-focus";
import { UsageSheet } from "./UsageRing";
import { NEAR_AT, shortReset, usageOf } from "./usage";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlignLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  Globe,
  Info,
  Copy,
  Ellipsis,
  Laptop,
  Loader2,
  Mic,
  Monitor,
  Plus,
  Share,
  ShieldCheck,
  SquarePen,
  ListChecks,
  GitFork,
  AtSign,
  SearchCheck,
  Workflow,
  RotateCcw,
  Trash2,
  Square,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import type { Peer } from "./api";
import AgentMarkdown from "./AgentMarkdown";
import { createDraftSync } from "./draft-sync";
import { mentionedChats, visibleUserText } from "../server/agent-sessions/message-text.mjs";
import { useViewportBox } from "./useViewportBox";
import AgentAccess from "./AgentAccess";
import { SubagentCard, SubagentStrip, TodoStrip } from "./Subagents";
import MentionMenu from "./MentionMenu";
import QueuedMessages from "./QueuedMessages";
import { ClaudeModelSheet, CodexConfigureSheet, CodexEffortStrip, currentModel, modelDisplayName } from "./ModelSheet";
import { ContinuedIn, MoveHint, MoveItems, moveBlocked, movedChat, moveTargets } from "./MoveChat";
import UsageStrip from "./UsageStrip";
import { RelaySheet, RelayStrip, SecondOpinionButton, SecondOpinionSheet, type RelayStarted } from "./Relays";
import { HelperBadge, TeamStrip, teamHelping, teamLedBy, teamToolLabel } from "./Teams";
import MascotTyping from "./MascotTyping";
import { SkillChip, SlashMenu, runSlashCommand, useSlashMenu } from "./SlashMenu";
import { useAppIcon } from "./app-icons";
import { CLAUDE_DECISIONS, DECISIONS } from "./decision-words";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { useClaudeFonts } from "./agent-fonts";
import { computerWord } from "./pause";
import { canRecord, useVoiceMemo } from "./voice-memo";
import {
  transcribeVoice,
  agentLabel,
  answerCodexQuestions,
  answerPrompt,
  appCard,
  setPhoneAnswers,
  sessionImage,
  effortLabel,
  listModels,
  modeLabel,
  modesFor,
  moveSession,
  CODEX_MODE_CHOICES,
  projectName,
  resetTime,
  resetUsage,
  readSession,
  sendMessage,
  cancelQueuedMessage,
  editLastMessage,
  editQueued,
  renameSession,
  deleteSession,
  stopSubagent,
  rewindSession,
  type RewindPreview,
  reorderQueued,
  sendQueuedNow,
  syncAgentDraft,
  setAgentMode,
  setAgentModel,
  stopSession,
  uploadImage,
  uploadFile,
  usageLink,
  useSessionLive,
  whereLabel,
  type AgentAsking,
  type AppCard,
  type AgentHealth,
  type AgentMode,
  type UsageLink,
  type AgentModel,
  type AgentName,
  type AgentSession,
  type Decision,
  type SessionItem,
  type SessionPage,
  type SessionPrompt,
  type OutboxMessage,
  type Relay,
  type Team,
} from "./agent-sessions";
import "./agent-session.css";
import "./chat-home.css";
import "./chat-workspace.css";

// ChatGPT's (and Codex's) menu mark: two lines, the lower one shorter.
function TwoLines({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 9h16M4 15h10" />
    </svg>
  );
}

// The Claude app's new-chat mark: a filled speech bubble with a plus cut out.
function ClaudeNewChat({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M12 3a9 9 0 0 0-7.9 13.3L3 21l4.8-1.1A9 9 0 1 0 12 3Zm1 5h-2v3H8v2h3v3h2v-3h3v-2h-3V8Z"
      />
    </svg>
  );
}

// Each agent's own words and marks, so the screen reads like its phone app
// (the Claude app; ChatGPT, where Codex lives). The layout is shared; a new
// agent is a new entry here plus its colors in agent-session.css.
const SKIN = {
  codex: {
    placeholder: "Do anything",
    app: "Codex app",
    menu: TwoLines,
    compose: SquarePen,
    where: null,
    disclaimer: "",
  },
  claude: {
    placeholder: "Reply to Claude",
    app: "Claude app",
    menu: AlignLeft,
    compose: ClaudeNewChat,
    where: Laptop,
    disclaimer: "Claude is AI and can make mistakes.",
  },
  // Gemini CLI's sessions, in the Gemini app's look; its own prompt words.
  gemini: {
    placeholder: "Type your message or @path/to/file",
    app: "Gemini CLI",
    menu: AlignLeft,
    compose: SquarePen,
    where: Terminal,
    disclaimer: "",
  },
} as const;

// Under the newest reply, as both apps put them: copy it, share it.
function ReplyActions({
  text,
  disclaimer,
  onSecondOpinion,
  onRelay,
}: {
  text: string;
  disclaimer: string;
  // Another agent reviews this reply's turn, or carries it on (Relays.tsx).
  onSecondOpinion?: () => void;
  onRelay?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="as-reply-actions">
      <div>
        <button
          className="as-icon"
          aria-label={copied ? "Copied" : "Copy"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* nothing to copy into */
            }
          }}
        >
          {copied ? <Check size={19} /> : <Copy size={19} />}
        </button>
        {canShare && (
          <button
            className="as-icon"
            aria-label="Share"
            onClick={() => void navigator.share({ text }).catch(() => {})}
          >
            <Share size={19} />
          </button>
        )}
        {onSecondOpinion && <SecondOpinionButton labelled onClick={onSecondOpinion} />}
        {onRelay && (
          <button className="relay-opinion" aria-label="Relay this reply" onClick={onRelay}>
            <Workflow size={17} /> <span>Relay</span>
          </button>
        )}
      </div>
      {disclaimer && <p className="as-disclaimer">{disclaimer}</p>}
    </div>
  );
}

// Any message, yours or the agent's, can be copied: its copy button shows on
// hover with a mouse, or when the message is tapped on a phone.
function Copyable({
  text,
  side,
  bare = false,
  onEdit,
  onFork,
  onRewind,
  onSecondOpinion,
  children,
}: {
  text: string;
  side: "user" | "assistant";
  bare?: boolean;
  // Your last message, edited and sent again (the Codex app's Edit).
  onEdit?: () => void;
  // A new chat with everything up to here (the Codex app's Fork).
  onFork?: () => void;
  // Back to before this message (Claude Code's rewind).
  onRewind?: () => void;
  // Another agent reviews this reply's turn (Relays.tsx).
  onSecondOpinion?: () => void;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={`as-msg ${side} ${shown ? "shown" : ""}`}
      onClick={(e) => {
        if (bare || (e.target as HTMLElement).closest("a, button, summary, img, input, textarea")) return;
        if (String(window.getSelection?.() || "")) return;
        setShown(!shown);
      }}
    >
      {children}
      {!bare && (
        <div className="as-msg-actions">
          <button
            className="as-icon"
            aria-label={copied ? "Copied" : "Copy message"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* nothing to copy into */
              }
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          {onEdit && (
            <button className="as-icon" aria-label="Edit message" onClick={onEdit}>
              <SquarePen size={15} />
            </button>
          )}
          {onFork && (
            <button className="as-icon" aria-label="Fork from here" onClick={onFork}>
              <GitFork size={15} />
            </button>
          )}
          {onRewind && (
            <button className="as-icon" aria-label="Rewind to before this" onClick={onRewind}>
              <RotateCcw size={15} />
            </button>
          )}
          {onSecondOpinion && <SecondOpinionButton onClick={onSecondOpinion} />}
        </div>
      )}
    </div>
  );
}

// How full the chat's context is, as both apps show it: a ring and the share.
function ContextMeter({ used, window: size }: { used: number; window: number | null }) {
  if (!Number.isFinite(used) || used < 0) return null;
  if (size === null || !Number.isFinite(size) || size <= 0) {
    const label = `${used.toLocaleString()} tokens reported; context capacity unknown`;
    return <span className="as-context unknown" title={label} aria-label={label}>{used.toLocaleString()} tokens</span>;
  }
  const share = Math.min(1, used / size);
  const percent = Math.round(share * 100);
  const r = 7;
  const around = 2 * Math.PI * r;
  return (
    <span
      className={`as-context ${share >= 0.8 ? "full" : ""}`}
      title={`${used.toLocaleString()} of ${size.toLocaleString()} tokens of context used`}
      aria-label={`${percent}% of context used`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${around * share} ${around}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
      </svg>
      <span className="as-context-num">{percent}%</span>
    </span>
  );
}

// "claude-opus-5-5" → "Opus 5.5", as the Claude app writes it.
const claudeModel = (id?: string | null) => {
  if (id === "default") return "Default";
  const m = String(id || "").match(
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/,
  );
  return m
    ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`
    : String(id || "");
};

const QUERY = "(max-width: 1024px), (pointer: coarse)";
// How long a message just sent shows as sent while it's handed over, before
// the queue says why it waits.
const HANDOVER_MS = 4000;
// How long the agent has been at it ("1m 5s"), ticking on its own each second.
function Elapsed({ since, after = "" }: { since: number; after?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.round((now - since) / 1000));
  if (!elapsed) return null;
  return (
    <small>
      {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}
      {after}
    </small>
  );
}
function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(QUERY).matches);
  useEffect(() => {
    const media = matchMedia(QUERY);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return narrow;
}

// True while the phone keyboard covers the bottom of the screen.
function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const check = () => setOpen(window.innerHeight - viewport.height > 120);
    check();
    viewport.addEventListener("resize", check);
    return () => viewport.removeEventListener("resize", check);
  }, []);
  return open;
}

const toolIcon = (kind: SessionItem["kind"]) =>
  kind === "command"
    ? Terminal
    : kind === "file-change"
      ? FileText
      : kind === "web"
        ? Globe
        : Wrench;
const base = (file: string) => file.split(/[\\/]/).pop() || file;
const plural = (n: number, one: string, many: string) =>
  n === 1 ? one : many.replace("#", String(n));

// "Edited App.tsx, ran 2 commands" with the diff size, like both apps show.
function runSummary(items: SessionItem[]) {
  const files = [
    ...new Set(
      items.filter((i) => i.kind === "file-change").map((i) => i.text),
    ),
  ];
  const commands = items.filter((i) => i.kind === "command").length;
  const web = items.filter((i) => i.kind === "web").length;
  // A team's lead handing work to helpers (Teams.tsx), said as such.
  const handed = items.filter((i) => i.kind === "tool" && /team_delegate$/.test(i.text)).length;
  const other = items.filter((i) => i.kind === "tool" && !/team_delegate$/.test(i.text)).length;
  const parts = [
    handed && plural(handed, "handed off a task", "handed off # tasks"),
    files.length &&
      (files.length === 1
        ? `edited ${base(files[0])}`
        : `edited ${files.length} files`),
    commands && plural(commands, "ran a command", "ran # commands"),
    web && plural(web, "searched the web", "searched the web # times"),
    other && plural(other, "used a tool", "used # tools"),
  ].filter(Boolean) as string[];
  const text = parts.join(", ") || "worked";
  let added = 0;
  let removed = 0;
  for (const i of items)
    if (i.kind === "file-change" && i.detail)
      for (const line of i.detail.split("\n")) {
        if (/^\+(?!\+\+)/.test(line)) added++;
        else if (/^-(?!--)/.test(line)) removed++;
      }
  return { text: text[0].toUpperCase() + text.slice(1), added, removed };
}

function ToolRun({ items }: { items: SessionItem[] }) {
  const [open, setOpen] = useState(false);
  const { text, added, removed } = runSummary(items);
  const failed = items.filter((i) => i.status === "failed").length;
  const running = items.some(
    (i) => i.status === "running" || i.status === "inProgress",
  );
  return (
    <div className={`as-run ${open ? "open" : ""}`}>
      <button
        className="as-run-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {running && <Loader2 size={13} className="spin" />}
        <span>{text}</span>
        {added > 0 && <b className="plus">+{added}</b>}
        {removed > 0 && <b className="minus">-{removed}</b>}
        {failed > 0 && <em>{failed} failed</em>}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && items.map((item) => <ToolStep key={item.id} item={item} />)}
    </div>
  );
}

function ToolStep({ item }: { item: SessionItem }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(item.kind);
  return (
    <div className={`as-step ${item.status === "failed" ? "failed" : ""}`}>
      <button
        onClick={() => item.detail && setOpen(!open)}
        aria-expanded={open}
      >
        <Icon size={13} />
        <code>{teamToolLabel(item.text || "") || item.text || "(step)"}</code>
      </button>
      {open && item.detail && <pre>{item.detail}</pre>}
    </div>
  );
}

// Claude Code's plan approvals, in its words.
const PLAN_CHOICES: Record<string, string> = {
  auto: "Yes, and use auto mode",
  acceptEdits: "Yes, auto-accept edits",
  default: "Yes, manually approve edits",
};
const decisionKey = (d: Decision) =>
  typeof d === "string" ? d : Object.keys(d)[0];

// "Today 12:37 PM", "Yesterday 9:02 AM", "Oct 2 4:10 PM": as the Codex app dates a chat.
function whenLabel(at: number, now = Date.now()) {
  const day = (t: number) => new Date(t).toDateString();
  const time = new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (day(at) === day(now)) return `Today ${time}`;
  if (day(at) === day(now - 86400000)) return `Yesterday ${time}`;
  return `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// Where to get more usage, opened in this browser.
export function UsageButton({ link }: { link: UsageLink | null }) {
  return link ? (
    <a
      className="as-usage"
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {link.label}
    </a>
  ) : null;
}

// Codex's used-up-limit message in the Codex app's own words, keeping the
// date the message itself gives ("try again at Oct 9th, 2026 9:25 PM" reads
// "Oct 9, 2026, 9:25 PM"); null when the message isn't that one.
export function codexLimitLine(text: string) {
  const m = text.match(
    /try again at ([A-Z][a-z]{2,8}) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}:\d{2}\s?[AP]M)/,
  );
  return m
    ? `You’ve hit your usage limit. Upgrade your plan or add credits to continue, or try again at ${m[1]} ${m[2]}, ${m[3]}, ${m[4]}.`
    : null;
}

// An agent's error, the way its app shows it: a quiet line in Codex (a used-up
// limit in the Codex app's own words; its card below offers the way out), a
// card in Claude Code with the way to more usage.
function ErrorNote({
  agent,
  text,
  detail,
}: {
  agent: string;
  text: string;
  detail?: string;
}) {
  const link = usageLink(agent, { text, detail });
  // Claude's card is Claude's; Codex and Gemini CLI say it in one quiet line.
  if (agent !== "claude")
    return (
      <div className="as-error codex">
        <p>
          <Info size={15} />{" "}
          <span>{(link && codexLimitLine(text)) || text}</span>
        </p>
      </div>
    );
  return (
    <section className="as-error claude">
      <header>
        <TriangleAlert size={15} />{" "}
        {link
          ? "Usage limit reached"
          : detail
            ? detail.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
            : "Error"}
      </header>
      <p>{text}</p>
      {link && (
        <footer>
          <UsageButton link={link} />
        </footer>
      )}
    </section>
  );
}

// Pictures sent with a message, above its text as the apps show them: from
// this page's own copy while sending, then from the session's transcript.
// The permission mode, picked as each app has you pick it: a small menu over
// its composer's mode button, the one in force checked, a tap outside closing
// it. The Claude app's names, in its order; the Codex app's title, and the
// line under each choice (both read from the apps themselves).
const CLAUDE_MODE_ORDER = ["manual", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"];
const CODEX_MODE_NOTES: Record<string, string> = {
  auto: "Always ask to edit external files and use the internet",
  "guardian-approvals": "Only ask for actions detected as potentially unsafe",
  "full-access": "Unrestricted access to the internet and any file on your computer",
  custom: "Uses permissions defined in config.toml",
};
export function ModeMenu({
  agent,
  choices,
  current,
  anchor,
  locked,
  busy = false,
  error,
  pending,
  inline = false,
  onPick,
  onClose,
}: {
  agent: AgentName;
  choices: { id: string; label: string; note?: string }[];
  current: string | null;
  // The mode button: the menu opens just above it.
  anchor: HTMLElement | null;
  // Set by another app (the Codex app runs this chat's messages with its own
  // mode): shown, not changeable here, and said why.
  locked?: string;
  busy?: boolean;
  error?: string;
  // A mode picked here that Claude Code takes at its next step (a Claude app
  // or terminal chat; a step that would ask asks here, and switches with the
  // allow): said, not shown as the mode it's in.
  pending?: string;
  // A new chat's menu: drawn in its place above the box (a chat may be open
  // under the sheet), its "Default" (your settings' own) first, as named.
  inline?: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const settingsDefault = (id: string) => inline && id === "default";
  const rank = (id: string) =>
    settingsDefault(id) ? -1 : CLAUDE_MODE_ORDER.includes(id) ? CLAUDE_MODE_ORDER.indexOf(id) : CLAUDE_MODE_ORDER.length;
  const list =
    agent === "claude"
      ? [...choices].sort((a, b) => rank(a.id) - rank(b.id)).map((m) => ({ ...m, label: (!settingsDefault(m.id) && modeLabel("claude", m.id)) || m.label, note: "" }))
      : choices.map((m) => ({ ...m, note: CODEX_MODE_NOTES[m.id] ?? m.note ?? "" }));
  return (
    <ComposerMenu anchor={anchor} inline={inline} label="Permissions" className={agent} onClose={onClose}>
      {agent === "codex" && <p className="as-mode-menu-title">How should ChatGPT actions be approved?</p>}
      {list.map((m) => (
        <button key={m.id} role="menuitemradio" aria-checked={m.id === current} disabled={!!locked || busy} onClick={() => onPick(m.id)}>
          <span className="as-mode-menu-text">
            <span>{m.label}</span>
            {m.note && <small>{m.note}</small>}
          </span>
          {m.id === current && <Check size={16} />}
        </button>
      ))}
      {locked && <p className="as-mode-menu-locked">{locked}</p>}
      {busy && <p role="status">Changing permissions…</p>}
      {pending && !busy && (
        <p role="status" className="as-mode-menu-locked">
          {list.find((m) => m.id === pending || (pending === "default" && m.id === "manual"))?.label || pending} from
          Claude's next step.
        </p>
      )}
      {error && <p role="alert" className="as-mode-menu-locked">{error}</p>}
    </ComposerMenu>
  );
}

// A small menu over a composer button, as the apps open theirs: drawn on the
// chat's page (the composer scrolls its own contents and clipped it out of
// sight), lined up with its button, closed by a tap outside or Escape.
function ComposerMenu({
  anchor,
  inline = false,
  label,
  className = "",
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  inline?: boolean;
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  // No button to open over (the model picked from "/model" while the model
  // button is hidden): over the composer.
  const over = inline ? null : anchor ?? (typeof document !== "undefined" ? document.querySelector<HTMLElement>(".as-page .as-composer") : null);
  const page = over?.closest<HTMLElement>(".as-page") ?? null;
  const at = (() => {
    if (!over || !page) return undefined;
    const box = page.getBoundingClientRect();
    const button = over.getBoundingClientRect();
    const width = Math.min(300, box.width - 24);
    // Over its button: from its left edge, or (a button on the right) to its right edge.
    const onRight = button.left + button.width / 2 > box.left + box.width / 2;
    const left = onRight ? button.right - box.left - width : button.left - box.left;
    return { bottom: Math.max(8, box.bottom - button.top + 6), left: Math.max(8, Math.min(left, box.width - width - 8)) };
  })();
  const menu = (
    <>
      <div className="as-mode-scrim" onClick={onClose} />
      <div className={`as-mode-menu ${className}`} role="menu" aria-label={label} style={at}>
        {children}
      </div>
    </>
  );
  return page ? createPortal(menu, page) : menu;
}

// The model and effort, picked as each app has you pick them (ModelSheet.tsx):
// Claude's "Select model" sheet; Codex's words and effort dots over the
// composer, its models in "Configure".
function ModelMenu({
  agent,
  models,
  model,
  effort,
  speed,
  busy,
  error,
  working,
  onRetry,
  onPick,
  onClose,
}: {
  agent: AgentName;
  models: AgentModel[];
  model: string | null;
  effort: string | null;
  speed?: string | null;
  busy?: boolean;
  error?: string;
  working?: boolean;
  onRetry: () => void;
  // `stay`: the dots keep the strip open, as the app's slider stays.
  onPick: (choice: { model?: string; effort?: string; speed?: string }, stay?: boolean) => void;
  onClose: () => void;
}) {
  const [configuring, setConfiguring] = useState(false);
  const shared = { agent, models, model, effort, speed, busy, error, working, onRetry, onClose };
  if (agent !== "codex") return <ClaudeModelSheet {...shared} onPick={(next) => onPick(next)} />;
  if (configuring || !models.length || error)
    return <CodexConfigureSheet {...shared} onPick={(next) => onPick(next, true)} />;
  return (
    <ComposerMenu anchor={null} label="Model and effort" className="codex as-model-strip" onClose={onClose}>
      {working && <p className="as-mode-menu-locked">Applies to the next turn.</p>}
      <CodexEffortStrip {...shared} onPick={(next) => onPick(next, true)} onConfigure={() => setConfiguring(true)} />
    </ComposerMenu>
  );
}

// A long message you sent folds to its first lines, as the Claude and Codex
// apps fold it (an 8,000-character paste took eleven screens).
function FoldedText({ text: value }: { text: string }) {
  const [open, setOpen] = useState(false);
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= 1200 && text.split("\n").length <= 20) return <AgentMarkdown text={text} />;
  return (
    <>
      <div className={open ? "as-fold" : "as-fold folded"}>
        <AgentMarkdown text={text} />
      </div>
      <button className="as-fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Show less" : "Show more"}
      </button>
    </>
  );
}

function SentImages({
  peer,
  session,
  item,
  urls,
  count,
}: {
  peer: Peer;
  session: { agent: AgentName; id: string };
  item?: string;
  urls?: string[];
  count: number;
}) {
  const shownCount = Math.min(count, 4);
  const [loaded, setLoaded] = useState<(string | null)[]>([]);
  useEffect(() => {
    if (urls || !item) return;
    let active = true;
    void Promise.all(
      Array.from({ length: shownCount }, (_, n) =>
        sessionImage(peer, session, item, n).catch(() => null),
      ),
    ).then((list) => active && setLoaded(list));
    return () => {
      active = false;
    };
  }, [peer.url, peer.token, session.agent, session.id, item, shownCount, urls]);
  const sources = urls || loaded;
  const [open, setOpen] = useState<number | null>(null);
  // Gone from the Mac (a temporary file the app attached): said, not blank.
  if (!urls && loaded.length && loaded.every((l) => !l))
    return (
      <span className="as-tag">
        {count} image{count === 1 ? "" : "s"}
      </span>
    );
  return (
    <div className="as-user-images">
      {Array.from({ length: shownCount }, (_, n) =>
        sources[n] ? (
          <button key={n} type="button" className="as-image-open" aria-label={`Open image ${n + 1} of ${count}`} onClick={() => setOpen(n)}>
            <img src={sources[n]!} alt="" />
          </button>
        ) : (
          <span key={n} className="as-image-wait" aria-hidden="true" />
        ),
      )}
      {count > shownCount && (
        <button type="button" className="as-tag as-image-more" aria-label={`Open image ${shownCount + 1} of ${count}`} onClick={() => setOpen(shownCount)}>
          +{count - shownCount}
        </button>
      )}
      {open !== null && (
        <ImageViewer
          count={urls ? urls.length : count}
          at={open}
          onMove={setOpen}
          onClose={() => setOpen(null)}
          source={(n) => (urls ? Promise.resolve(urls[n]) : item ? sessionImage(peer, session, item, n) : Promise.reject())}
        />
      )}
    </div>
  );
}

// A sent picture full screen, to look at closely: the others a swipe or an
// arrow away; closed by its X, the dark around it, or Escape.
function ImageViewer({
  count,
  at,
  onMove,
  onClose,
  source,
}: {
  count: number;
  at: number;
  onMove: (n: number) => void;
  onClose: () => void;
  source: (n: number) => Promise<string>;
}) {
  const [shown, setShown] = useState<{ n: number; url: string | null } | null>(null);
  const touch = useRef<number | null>(null);
  useEffect(() => {
    let active = true;
    source(at).then(
      (url) => active && setShown({ n: at, url }),
      () => active && setShown({ n: at, url: null }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  const move = (by: number) => {
    const n = at + by;
    if (n >= 0 && n < count) onMove(n);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const current = shown?.n === at ? shown : null;
  return createPortal(
    <div
      className="as-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${at + 1} of ${count}`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touch.current === null) return;
        const dx = e.changedTouches[0].clientX - touch.current;
        touch.current = null;
        if (Math.abs(dx) > 50) move(dx < 0 ? 1 : -1);
      }}
    >
      <button type="button" className="as-viewer-close" aria-label="Close" onClick={onClose}>
        <X size={22} />
      </button>
      {count > 1 && <span className="as-viewer-count">{at + 1} / {count}</span>}
      {!current ? (
        <span className="as-viewer-wait" aria-label="Loading">
          <Loader2 size={26} className="spin" />
        </span>
      ) : current.url ? (
        <img src={current.url} alt="" />
      ) : (
        <span className="as-viewer-gone">This picture isn't on the Mac anymore.</span>
      )}
      {at > 0 && (
        <button type="button" className="as-viewer-arrow left" aria-label="Previous image" onClick={() => move(-1)}>
          <ChevronLeft size={26} />
        </button>
      )}
      {at < count - 1 && (
        <button type="button" className="as-viewer-arrow right" aria-label="Next image" onClick={() => move(1)}>
          <ChevronRight size={26} />
        </button>
      )}
    </div>,
    document.body,
  );
}

// A command an agent asks to run: its first lines, and the rest a tap away, so
// the card's buttons stay in sight without scrolling past a long script.
const PREVIEW_LINES = 3;
function CommandPreview({ text }: { text: string }) {
  const box = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // Measured where the page has a layout; by its lines where it has none.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    setOverflows(
      el.clientHeight > 0
        ? el.scrollHeight > el.clientHeight + 1
        : text.split("\n").length > PREVIEW_LINES,
    );
  }, [text, open]);
  useEffect(() => setOpen(false), [text]);
  return (
    <div className="as-command-preview">
      <pre
        ref={box}
        className={`as-prompt-command${open ? " open" : overflows ? " clipped" : ""}`}
      >
        {text}
      </pre>
      {(overflows || open) && (
        <button
          className="as-command-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show all"}
          <ChevronDown size={13} />
        </button>
      )}
    </div>
  );
}

// A question or permission request an agent waits on in another app (the
// Claude app, the Codex app, a terminal), already showing there: said here.
// The Claude app's and the Codex app's permission cards are drawn here as the
// app draws them (its words, its buttons, in order: read from the app, with
// that chat brought up there) and answered with the same buttons, pressed on
// that card in the app. Anything else is answered there.
// word: "Mac", "Windows PC" or "computer" (pause.ts computerWord).
function AskingCard({
  agent,
  asking,
  logos,
  where,
  word,
  onScreen,
  loadCard,
  onAnswer,
  phoneAnswers,
  onPhoneAnswers,
}: {
  agent: string;
  asking: AgentAsking;
  logos: AgentLogos;
  where: string;
  word: string;
  onScreen?: () => void;
  loadCard?: () => Promise<AppCard>;
  onAnswer?: (label: string) => Promise<void>;
  // Claude Code there can't be answered from the phone until Reach's hook is
  // in its settings: one tap puts it there (from Claude's next request on;
  // this one stays with the Mac).
  phoneAnswers?: "off" | "outdated" | "unsupported";
  onPhoneAnswers?: () => Promise<void>;
}) {
  const id = asking.kind === "permission" ? asking.id : undefined;
  const answerable = !!id && !!loadCard && !!onAnswer;
  const [card, setCard] = useState<AppCard | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const answering = useRef(false);
  const loading = useRef(0);
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const load = () => {
    const turn = ++loading.current;
    setCard(null);
    setFailed("");
    loadCard!().then(
      (c) => turn === loading.current && setCard(c),
      (e) => turn === loading.current && setFailed((e as Error).message),
    );
  };
  useEffect(() => {
    if (!answerable) return;
    load();
    return () => {
      loading.current++;
    };
  }, [id, answerable]);
  const press = async (label: string) => {
    if (answering.current) return;
    answering.current = true;
    setBusy(label);
    try {
      await onAnswer?.(label);
    } catch (error) {
      setCard(null);
      setFailed((error as Error).message);
    } finally {
      setBusy(null);
      answering.current = false;
    }
  };
  // Claude Code without Reach's hook: answerable from the phone after one tap
  // (Claude Code then asks the phone too, from its next request on).
  const canEnable = agent === "claude" && (phoneAnswers === "off" || phoneAnswers === "outdated") && !!onPhoneAnswers && asking.kind !== "consent" && asking.kind !== "dialog";
  // Its main choice, as the apps make it: the one-time Allow.
  const primary = card?.buttons.find((b) => /^Allow once\b/.test(b)) ?? card?.buttons.find((b) => /^Allow\b/.test(b));
  const command = asking.kind === "permission" && asking.command ? asking.text : "";
  return (
    <section
      className={`as-prompt ${asking.kind === "question" ? "question" : "tool"} elsewhere`}
      aria-live="polite"
    >
      <header>
        <AgentLogo agent={agent} logos={logos} size={18} />
        <strong>
          Waiting for your answer in the {where} on your {word}
        </strong>
      </header>
      {card ? (
        // The app's own words, as its card has them.
        <div className="as-app-card">
          {card.texts.map((t, i) =>
            command && t.trim() === command.trim() ? (
              <CommandPreview key={i} text={t} />
            ) : i === 0 ? (
              <p key={i} className="as-app-card-title">{t}</p>
            ) : (
              <p key={i}>{t}</p>
            ),
          )}
        </div>
      ) : asking.kind === "question" ? (
        asking.questions.map((q, i) => (
          <div className="as-question" key={i}>
            <p>{q.question}</p>
            <p className="as-asked">
              {q.options.map((o) => o.label).join(" · ")}
            </p>
          </div>
        ))
      ) : asking.kind === "consent" ? (
        <>
          <p>{asking.title}</p>
          {asking.reason && <p className="as-reason">{asking.reason}</p>}
          {!!asking.options?.length && (
            <p className="as-asked">{asking.options.join(" · ")}</p>
          )}
        </>
      ) : command ? (
        <CommandPreview text={asking.text} />
      ) : (
        <p>{asking.text}</p>
      )}
      {answerable && card ? (
        <>
          <div className="as-prompt-actions as-app-card-actions">
            {card.buttons.map((label) => (
              <button
                key={label}
                className={label === primary ? "primary" : undefined}
                disabled={!!busy}
                onClick={() => void press(label)}
              >
                {busy === label ? <Loader2 size={14} className="spin" /> : label}
              </button>
            ))}
          </div>
          {/* The card's menu of more choices, folded as the app folds it. */}
          {!!card.more?.length && (
            <>
              <button className="as-app-card-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
                More choices
              </button>
              {moreOpen && (
                <div className="as-prompt-actions as-app-card-actions">
                  {card.more.map((label) => (
                    <button key={label} disabled={!!busy} onClick={() => void press(label)}>
                      {busy === label ? <Loader2 size={14} className="spin" /> : label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {card.moreInApp && <p className="as-reason">More choices are on the card in the {where}.</p>}
        </>
      ) : answerable && !failed ? (
        <p className="as-reason as-app-card-loading">
          <Loader2 size={14} className="spin" /> Getting the choices from the {where}…
        </p>
      ) : (
        <>
          <p className="as-reason">
            {failed || `This request is already open in the ${where}.`} Answer it on your {word}
            {onScreen ? " through live screen." : "."}
          </p>
          {enabled && (
            <p className="as-reason" role="status">
              Claude's next requests come here too.
            </p>
          )}
          {(onScreen || (answerable && failed) || canEnable) && (
            <div className="as-prompt-actions">
              {canEnable && (
                <button
                  className="primary"
                  disabled={enabling}
                  onClick={async () => {
                    setEnabling(true);
                    try {
                      await onPhoneAnswers?.();
                      setEnabled(true);
                    } catch {
                      /* said by the chat */
                    } finally {
                      setEnabling(false);
                    }
                  }}
                >
                  {enabling ? <Loader2 size={14} className="spin" /> : "Answer Claude from your phone"}
                </button>
              )}
              {answerable && failed && <button onClick={() => load()}>Try again</button>}
              {onScreen && <button className={canEnable ? undefined : "primary"} onClick={onScreen}>Open screen to answer</button>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// The Claude app's own consent card (letting Claude use apps), drawn as the
// app draws it and answered here: Reach presses the same button in the app.
function ConsentCard({
  asking,
  peer,
  onAnswer,
}: {
  asking: Extract<AgentAsking, { kind: "consent" }>;
  peer: Peer;
  onAnswer: (decision: "deny" | "allow") => Promise<void>;
}) {
  const [busy, setBusy] = useState<"deny" | "allow" | null>(null);
  const [deny = "Deny", allow = "Allow for this session"] =
    asking.options || [];
  const act = async (decision: "deny" | "allow") => {
    setBusy(decision);
    try {
      await onAnswer(decision);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="as-consent" aria-live="polite">
      <strong>{asking.title}</strong>
      {asking.reason && <p>{asking.reason}</p>}
      {asking.about === "apps" && (
        <small>
          Claude will work in these apps in the background while you keep using
          your {computerWord(peer.platform)}.
        </small>
      )}
      {!!asking.apps?.length && (
        <ul>
          {asking.apps.map((app) => (
            <ConsentApp key={app.name} peer={peer} app={app} />
          ))}
        </ul>
      )}
      <div className="as-consent-actions">
        <button disabled={!!busy} onClick={() => void act("deny")}>
          {busy === "deny" ? <Loader2 size={14} className="spin" /> : deny}
        </button>
        <button
          className="primary"
          disabled={!!busy}
          onClick={() => void act("allow")}
        >
          {busy === "allow" ? <Loader2 size={14} className="spin" /> : allow}
        </button>
      </div>
    </section>
  );
}

function ConsentApp({
  peer,
  app,
}: {
  peer: Peer;
  app: { name: string; appId?: string };
}) {
  const icon = useAppIcon(peer, app.appId, true);
  return (
    <li>
      {icon ? (
        <img src={icon} alt="" />
      ) : (
        <span className="as-consent-noicon" aria-hidden="true" />
      )}
      <span>{app.name}</span>
    </li>
  );
}

// Codex's questions asked while it works, as the Codex app shows them:
// answered here while the turn that asked still runs (into that turn, never
// queued), then each answer on its question; once Codex moves on, only said.
function AsyncQuestions({ item, logos, word, answerable, onAnswer }: {
  item: SessionItem;
  logos: AgentLogos;
  word: string;
  answerable: boolean;
  onAnswer: (answers: { index: number; answer: string }[]) => Promise<void>;
}) {
  const [sent, setSent] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const questions = item.questions || [];
  const answered = questions.some((q) => q.answer != null) || !!sent;
  if (answered || !answerable)
    return (
      <section className="as-prompt question elsewhere">
        {questions.map((q, i) => {
          const answer = q.answer ?? sent?.[i];
          return (
            <div className="as-question" key={i}>
              <p>{q.title}</p>
              {answer ? (
                <p className="as-answered">{answer}</p>
              ) : !answered && q.options.length ? (
                <p className="as-asked">{q.options.join(" · ")}</p>
              ) : null}
            </div>
          );
        })}
      </section>
    );
  return <>
    <PromptCard
      agent="codex" logos={logos} word={word}
      initialAnswers={Object.fromEntries(questions.map((q, i) => [String(i), q.options.length ? [q.options[0]] : []]))}
      prompt={{ id: item.id, kind: "question", title: "Codex has a question", questions: questions.map((q, i) => ({
        id: String(i), header: "", question: q.title,
        options: q.options.map((label) => ({ label, description: "" })), other: true, secret: false,
      })) }}
      onAnswer={async ({ answers }) => {
        if (sending.current) return;
        sending.current = true;
        setError("");
        try {
          const picked = questions.map((_, i) => (answers?.[String(i)] || []).join(", ").trim());
          await onAnswer(picked.map((answer, index) => ({ index, answer })));
          setSent(picked);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          sending.current = false;
        }
      }}
    />
    {error && <p role="alert" className="as-note">{error}</p>}
  </>;
}

export function PromptCard({
  prompt,
  agent,
  logos,
  word,
  onAnswer,
  initialAnswers = {},
}: {
  prompt: SessionPrompt;
  agent: AgentName;
  logos: AgentLogos;
  word: string;
  initialAnswers?: Record<string, string[]>;
  onAnswer: (answer: {
    decision?: string;
    answers?: Record<string, string[]>;
    message?: string;
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  // What to change in a plan sent back (Claude's "No, keep planning").
  const [feedback, setFeedback] = useState("");
  const answering = useRef(false);
  // Picked choices per question, and what was typed instead ("Something else").
  const [picked, setPicked] = useState<Record<string, string[]>>(initialAnswers);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const answerOf = (id: string) => [
    ...(picked[id] || []),
    ...(typed[id]?.trim() ? [typed[id].trim()] : []),
  ];
  // One question per page, as Claude Code and Codex ask them; picking the one
  // answer of a question moves on to the next.
  const questions = prompt.questions || [];
  const [page, setPage] = useState(0);
  const at = Math.min(page, Math.max(0, questions.length - 1));
  const current = questions[at];
  const last = at >= questions.length - 1;
  const pick = (q: { id: string; multiSelect?: boolean }, label: string) => {
    const now = picked[q.id] || [];
    if (q.multiSelect)
      setPicked({
        ...picked,
        [q.id]: now.includes(label)
          ? now.filter((l) => l !== label)
          : [...now, label],
      });
    else {
      setPicked({ ...picked, [q.id]: [label] });
      setTyped({ ...typed, [q.id]: "" });
      if (!last) setPage(at + 1);
    }
  };
  const act = async (
    key: string,
    answer: { decision?: string; answers?: Record<string, string[]>; message?: string },
  ) => {
    if (answering.current || prompt.attempted) return;
    answering.current = true;
    setBusy(key);
    try {
      await onAnswer(answer);
    } finally {
      answering.current = false;
      setBusy("");
    }
  };
  const decisions = prompt.decisions?.map(decisionKey) || [];
  const positive = (key: string) => /^(accept|approved|allow)/.test(key);
  return (
    <section className={`as-prompt ${prompt.kind}`} aria-live="polite">
      <header>
        <AgentLogo agent={agent} logos={logos} size={18} />
        <strong>{prompt.title}</strong>
      </header>
      {prompt.command && <CommandPreview text={prompt.command} />}
      {prompt.cwd && <small>in {prompt.cwd}</small>}
      {prompt.files?.length ? (
        <ul className="as-prompt-files">
          {prompt.files.map((f) => (
            <li key={f}>
              <FileText size={13} /> {f}
            </li>
          ))}
        </ul>
      ) : null}
      {prompt.message && <p>{prompt.message}</p>}
      {prompt.reason && <p className="as-prompt-reason">{prompt.reason}</p>}
      {prompt.attempted && <p className="as-prompt-reason" role="status">The previous answer could not be confirmed. Check {agentLabel(agent)} on your {word} before answering again.</p>}
      {prompt.kind === "plan" ? (
        <>
          {prompt.plan && (
            <div className="as-plan">
              <AgentMarkdown text={prompt.plan} />
            </div>
          )}
          <div className="as-prompt-actions as-plan-actions">
            {decisions
              .filter((key) => key.startsWith("plan:"))
              .map((key, i) => (
                <button
                  key={key}
                  className={i === 0 ? "primary" : ""}
                  disabled={!!busy || prompt.attempted}
                  onClick={() => void act(key, { decision: key })}
                >
                  {busy === key ? <Loader2 size={14} className="spin" /> : PLAN_CHOICES[key.slice(5)] || key.slice(5)}
                </button>
              ))}
          </div>
          {decisions.includes("keepPlanning") && (
            <form
              className="as-plan-feedback"
              onSubmit={(e) => {
                e.preventDefault();
                void act("keepPlanning", { decision: "keepPlanning", message: feedback.trim() });
              }}
            >
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="No, keep planning: tell Claude what to change"
                aria-label="What to change in the plan"
              />
              <button type="submit" disabled={!!busy || prompt.attempted}>
                {busy === "keepPlanning" ? <Loader2 size={14} className="spin" /> : "Keep planning"}
              </button>
            </form>
          )}
        </>
      ) : prompt.kind === "question" ? (
        <>
          {questions.length > 1 && (
            <nav className="as-steps" aria-label="Questions">
              {questions.map((q, i) => (
                <button
                  key={q.id}
                  className={`${i === at ? "current" : ""} ${answerOf(q.id).length ? "done" : ""}`}
                  aria-current={i === at ? "step" : undefined}
                  onClick={() => setPage(i)}
                >
                  {answerOf(q.id).length ? <Check size={12} /> : null}
                  {q.header || `Question ${i + 1}`}
                </button>
              ))}
            </nav>
          )}
          {current && (
            <div className="as-question" key={current.id}>
              {questions.length === 1 && current.header && (
                <b>{current.header}</b>
              )}
              <p>{current.question}</p>
              {current.multiSelect && (
                <small className="as-question-hint">
                  Choose any that apply
                </small>
              )}
              <div className="as-choices">
                {current.options.map((o) => (
                  <button
                    key={o.label}
                    className={
                      picked[current.id]?.includes(o.label) ? "chosen" : ""
                    }
                    aria-pressed={!!picked[current.id]?.includes(o.label)}
                    onClick={() => pick(current, o.label)}
                  >
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </button>
                ))}
              </div>
              {(current.other || !current.options.length) && (
                <input
                  type={current.secret ? "password" : "text"}
                  placeholder={
                    current.options.length ? "Something else…" : "Your answer"
                  }
                  value={typed[current.id] || ""}
                  onChange={(e) => {
                    setTyped({ ...typed, [current.id]: e.target.value });
                    // One answer per question unless several may be picked.
                    if (!current.multiSelect)
                      setPicked({ ...picked, [current.id]: [] });
                  }}
                />
              )}
            </div>
          )}
          <div className="as-prompt-actions">
            {last ? (
              <button
                className="primary"
                disabled={
                  !!busy || prompt.attempted || questions.some((q) => !answerOf(q.id).length)
                }
                onClick={() =>
                  void act("answer", {
                    answers: Object.fromEntries(
                      questions.map((q) => [q.id, answerOf(q.id)]),
                    ),
                  })
                }
              >
                {busy ? <Loader2 size={14} className="spin" /> : "Submit"}
              </button>
            ) : (
              <button
                className="primary"
                disabled={!current || !answerOf(current.id).length}
                onClick={() => setPage(at + 1)}
              >
                Next
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="as-prompt-actions">
          {decisions.map((key) => (
            <button
              key={key}
              className={
                positive(key) && key === decisions.find(positive)
                  ? "primary"
                  : ""
              }
              disabled={!!busy || prompt.attempted}
              onClick={() => void act(key, { decision: key })}
            >
              {busy === key ? (
                <Loader2 size={14} className="spin" />
              ) : prompt.kind === "dialog" ? (
                "Cancel request"
              ) : (
                (prompt.kind === "tool"
                  ? CLAUDE_DECISIONS[key]
                  : DECISIONS[key]) || key
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// A picture (url: its preview), or any other file (file: its name).
type Attachment = { key: number; url: string; id?: string; error?: string; file?: string };
let attachmentSeq = 0;

// A new chat's model and effort: the same pickers as in a chat (ModelSheet.tsx).
export function ModelPicker({
  agent,
  models,
  model,
  effort,
  speed,
  busy,
  error,
  onRetry,
  onPick,
  onClose,
}: {
  agent: AgentName;
  models: AgentModel[];
  model: string | null;
  effort: string | null;
  speed?: string | null;
  busy?: boolean;
  error?: string;
  onRetry?: () => void;
  onPick: (choice: { model?: string; effort?: string; speed?: string }, done: boolean) => void;
  onClose: () => void;
}) {
  const [configuring, setConfiguring] = useState(false);
  const shared = { agent, models, model, effort, speed, busy, error, onRetry, onClose };
  if (agent !== "codex") return <ClaudeModelSheet {...shared} onPick={(next) => onPick(next, true)} />;
  if (configuring || error || !models.length) return <CodexConfigureSheet {...shared} onPick={(next) => onPick(next, false)} onClose={configuring ? () => setConfiguring(false) : onClose} />;
  return <CodexEffortStrip {...shared} onPick={(next) => onPick(next, false)} onConfigure={() => setConfiguring(true)} />;
}

export default function AgentSessionView({
  peer,
  session: initial,
  siblings: allSiblings,
  health,
  onSelect,
  onBack,
  onSignedIn = () => {},
  logos = {},
  onNew,
  deviceRequests = 0,
  onReviewDevice,
  onScreen,
  relays = [],
  teams = [],
  everyone = [],
  onRelaysChanged,
}: {
  peer: Peer;
  session: AgentSession;
  siblings: AgentSession[];
  health: AgentHealth[];
  onSelect: (s: AgentSession) => void;
  onBack: () => void;
  onSignedIn?: () => void;
  logos?: AgentLogos;
  // A new chat with the same agent (the apps' new-chat button).
  onNew?: () => void;
  deviceRequests?: number;
  onReviewDevice?: () => void;
  onScreen?: () => void;
  // Relays and teams on this computer (Relays.tsx, Teams.tsx), and every
  // agent's chats (one to relay to).
  relays?: Relay[];
  teams?: Team[];
  everyone?: AgentSession[];
  onRelaysChanged?: () => void;
}) {
  const agent = initial.agent;
  const siblings = useMemo(
    () => allSiblings.filter((s) => s.agent === agent && !s.archived),
    [allSiblings, agent],
  );
  const skin = SKIN[agent];
  useClaudeFonts(peer, agent === "claude");
  const word = computerWord(peer.platform);
  const [info, setInfo] = useState<AgentSession>(initial);
  const [items, setItems] = useState<SessionItem[] | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [olderBusy, setOlderBusy] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const draftKey =
    "reach-chat-draft:" + peer.id + ":" + initial.agent + ":" + initial.id;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) || "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, text]);
  const draftSync = useRef<ReturnType<typeof createDraftSync> | null>(null);
  useEffect(() => {
    if (agent !== "claude" || !initial.inApp) return;
    const sync = createDraftSync((value) => syncAgentDraft(peer, initial, value));
    draftSync.current = sync;
    return () => { sync.close(); draftSync.current = null; };
  }, [peer.url, peer.token, initial.id, agent, initial.inApp]);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);
  const [removedQueue, setRemovedQueue] = useState<string[]>([]);
  const [reviewId, setReviewId] = useState("");
  useWantedPrompt(initial.agent, initial.id, setReviewId);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Sent but not yet in the transcript; `seen` counts the same text already there.
  // messageId: where it waits in the Mac's outbox, when it waits there.
  const [pending, setPending] = useState<
    {
      id: string;
      text: string;
      images: number;
      urls?: string[];
      seen: number;
      messageId?: string;
      at: number;
    }[]
  >([]);
  const [sending, setSending] = useState(false);
  // Taps in the same instant come before `sending` re-renders: one send.
  const sendingNow = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const savingModel = useRef<object | null>(null);
  const [modelReload, setModelReload] = useState(0);
  const [modes, setModes] = useState<AgentMode[] | null>(null);
  const [choice, setChoice] = useState<{
    model?: string;
    effort?: string;
    speed?: string;
    mode?: string;
  }>({});
  const [picking, setPicking] = useState(false);
  const [choosingMode, setChoosingMode] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState("");
  const savingMode = useRef(false);
  const modeButton = useRef<HTMLButtonElement>(null);
  const { view: live } = useSessionLive(peer, initial);
  const reviewCount = live.prompts.length || (info.asking ? 1 : 0);
  const selectedPrompt =
    live.prompts.find((p) => p.id === reviewId) || live.prompts[0];
  const page = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);
  const touchingTranscript = useRef(false);
  const [readingHistory, setReadingHistory] = useState(false);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const latest = () => {
    atBottom.current = true;
    setReadingHistory(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const narrow = useNarrow();
  const keyboard = useKeyboardOpen();
  useViewportBox(page, narrow);

  const runningHere = live.status === "running" || live.status === "waiting";
  const runningElsewhere = !runningHere && (info.status === "running" || info.status === "waiting");
  const working = runningHere || runningElsewhere;
  const heldByApp = info.held === "codex-app";
  // "@" typed last in the box: the chats and files to pick from (MentionMenu).
  const mentionQuery = /(?:^|\s)@([^\s@]{0,80})$/.exec(text)?.[1] ?? null;
  // Chats mentioned in the message being written (three at most).
  const [mentions, setMentions] = useState<AgentSession[]>([]);
  // The chat's new name, while it's being typed (⋯ → its pencil).
  const [renaming, setRenaming] = useState<string | null>(null);
  // Codex's plan mode, as the Codex app's Plan toggle: kept per chat on this
  // phone; once touched, each message says whether it's on.
  const planKey = `reach:codex-plan:${initial.id}`;
  const [planMode, setPlanMode] = useState<"plan" | "default" | null>(() => {
    try {
      const saved = localStorage.getItem(planKey);
      return saved === "plan" || saved === "default" ? saved : null;
    } catch {
      return null;
    }
  });
  const togglePlan = () => {
    const next = planMode === "plan" ? "default" : "plan";
    setPlanMode(next);
    try {
      localStorage.setItem(planKey, next);
    } catch {}
  };

  // The version of the newest page we hold; unchanged polls cost no render.
  const known = useRef("");
  // One read at a time: wakes that come while one is on its way are read once
  // after it (a Codex item woke two or three overlapping reads).
  const reading = useRef<{ again: boolean } | null>(null);
  // A read that fails while the Mac is out of reach for a moment (the phone
  // waking, Reach restarting) is tried again soon, and said only if it lasts.
  const failed = useRef(0);
  const retryRead = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Every mounted identity owns its reads. Closing the chat or replacing its
  // credential invalidates pending replies before they can update this view,
  // retry, or drain a queued reread. A generation also separates effect
  // re-activation (Strict Mode) from the previous setup's pending requests.
  const readLife = useMemo(() => ({ active: false, generation: 0, settingsGeneration: 0, settingsReadPending: false }), [peer.url, peer.token, initial.agent, initial.id]);
  useLayoutEffect(() => {
    readLife.active = true;
    readLife.generation++;
    savingModel.current = null;
    setModelSaving(false);
    known.current = "";
    reading.current = null;
    failed.current = 0;
    clearTimeout(retryRead.current);
    setOlderBusy(false);
    return () => {
      readLife.active = false;
      clearTimeout(retryRead.current);
      reading.current = null;
    };
  }, [readLife]);
  const load = useCallback(
    async (first: boolean) => {
      const generation = readLife.generation;
      const settingsGeneration = readLife.settingsGeneration;
      const current = () => readLife.active && readLife.generation === generation;
      if (!current() || (document.hidden && !first)) return;
      if (!first && reading.current) {
        reading.current.again = true;
        return;
      }
      const turn = { again: false };
      if (!first) reading.current = turn;
      try {
        const r = await readSession(
          peer,
          initial,
          null,
          first ? undefined : known.current,
        );
        if (!current()) return;
        known.current = r.version || "";
        failed.current = 0;
        clearTimeout(retryRead.current);
        if ("unchanged" in r) {
          setLoadError("");
          return;
        }
        // A read started before/during a settings write can arrive after
        // its acknowledgement. Keep its transcript, but never let those old
        // settings undo the selected effort; a fresh read still follows
        // later changes made in the native app or another device.
        const staleSettings = settingsGeneration !== readLife.settingsGeneration || !!savingModel.current;
        const session = { ...r.session };
        if (staleSettings) {
          delete session.model;
          delete session.effort;
          delete session.speed;
          if (savingModel.current) readLife.settingsReadPending = true;
          else if (first) void again.current(false);
          else turn.again = true;
        }
        // A question answered elsewhere is simply gone from the new read.
        setInfo((old) => ({ ...old, asking: undefined, context: undefined, ...session }));
        setItems((current) => {
          if (!current || first) return withQuestionReplies(r.items);
          // Keep older pages already loaded; replace the newest page.
          const oldest = r.items[0]?.id;
          const at = oldest ? current.findIndex((i) => i.id === oldest) : -1;
          return withQuestionReplies([...(at >= 0 ? current.slice(0, at) : []), ...r.items]);
        });
        if (first) setBefore(r.before);
        setLoadError("");
        // A sent message is shown until the transcript has one more copy of it
        // than when it was sent (a repeated "continue" must not clear early).
        setPending((list) =>
          list.filter(
            (p) =>
              r.items.filter(
                (i) => i.role === "user" && visibleUserText(i.text).trim() === p.text.trim(),
              ).length <= p.seen,
          ),
        );
      } catch (e) {
        if (!current()) return;
        failed.current++;
        if (failed.current > 1) setLoadError((e as Error).message);
        clearTimeout(retryRead.current);
        retryRead.current = setTimeout(() => {
          if (current()) void again.current(first);
        }, Math.min(8000, 1000 * 2 ** (failed.current - 1)));
      } finally {
        if (current() && reading.current === turn) {
          reading.current = null;
          if (turn.again) void again.current(false);
        }
      }
    },
    [peer.url, peer.token, initial.agent, initial.id, readLife],
  );
  const again = useRef(load);
  again.current = load;
  useEffect(() => {
    void load(true);
  }, [load]);
  // The live view wakes it the moment the chat changes (live.items, below),
  // so it isn't read on a beat: a slow look stays as the safety net, and a
  // page coming back reads again (news while it was hidden waited).
  useEffect(() => {
    const timer = setInterval(() => void load(false), 30000);
    const shown = () => !document.hidden && void load(false);
    document.addEventListener("visibilitychange", shown);
    // The phone's network back: read at once.
    window.addEventListener("online", shown);
    return () => {
      clearInterval(timer);
      clearTimeout(retryRead.current);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("online", shown);
    };
  }, [load]);
  useEffect(() => {
    if (live.items) void load(false);
  }, [live.items, load]);
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setModelError("");
    listModels(peer, agent, { refresh: modelReload > 0 }).then(
      (r) => {
        if (cancelled) return;
        setModels(r.models);
        if (r.modes?.length) setModes(r.modes);
        if (!r.models.length) setModelError("No models were returned. Try loading them again.");
      },
      (e) => { if (!cancelled) setModelError((e as Error).message); },
    ).finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [peer.url, peer.token, agent, modelReload]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prepend.current) {
      el.scrollTop =
        prepend.current.top + el.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (atBottom.current && !touchingTranscript.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, live.streaming, live.prompts.length, working]);
  // Where this chat was being read, kept for the tab: the page reloaded (a
  // new interface, a reconnect) and the chat came back at its end, the
  // reader scrolling up again (Oct 8). The message at the top of the screen
  // and how far down it sits; earlier pages are loaded again to find it.
  const placeKey = `reach-chat-place:${peer.id}:${initial.agent}:${initial.id}`;
  const place = useRef<{ at: string; offset: number; tries: number } | null | undefined>(undefined);
  if (place.current === undefined)
    try {
      const saved = JSON.parse(sessionStorage.getItem(placeKey) || "null");
      place.current = typeof saved?.at === "string" && typeof saved.offset === "number" ? { at: saved.at, offset: saved.offset, tries: 0 } : null;
    } catch {
      place.current = null;
    }
  const findingPlace = useRef(false);
  useLayoutEffect(() => {
    const want = place.current;
    const el = scroller.current;
    if (!want || !items || !el || findingPlace.current) return;
    const mark = [...el.querySelectorAll<HTMLElement>(".as-at")].find((m) => m.dataset.at === want.at);
    const box = mark?.firstElementChild;
    if (box) {
      el.scrollTop += box.getBoundingClientRect().top - el.getBoundingClientRect().top - want.offset;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
      setReadingHistory(!atBottom.current);
      place.current = null;
    } else if (before && want.tries < 6) {
      want.tries++;
      findingPlace.current = true;
      void older().finally(() => (findingPlace.current = false));
    } else place.current = null;
  }, [items, before]);
  const placeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepPlace = () => {
    clearTimeout(placeTimer.current);
    placeTimer.current = setTimeout(() => {
      const el = scroller.current;
      // Not while coming back to it (the first scroll to the end would forget it).
      if (!el || place.current) return;
      try {
        if (atBottom.current) return sessionStorage.removeItem(placeKey);
        const top = el.getBoundingClientRect().top;
        for (const mark of el.querySelectorAll<HTMLElement>(".as-at")) {
          const box = mark.firstElementChild?.getBoundingClientRect();
          if (box && box.bottom > top) {
            sessionStorage.setItem(placeKey, JSON.stringify({ at: mark.dataset.at, offset: box.top - top }));
            return;
          }
        }
      } catch {}
    }, 250);
  };
  useEffect(() => () => clearTimeout(placeTimer.current), []);
  // Follow the last message through keyboard/composer resizing only when the
  // reader was already at the end. Reading history never fights new output.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && !touchingTranscript.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const shown = useRef(attachments);
  shown.current = attachments;
  // Pictures sent from here stay shown in their message until the page closes.
  const sentUrls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const a of shown.current) URL.revokeObjectURL(a.url);
      for (const url of sentUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const older = async () => {
    const generation = readLife.generation;
    const current = () => readLife.active && readLife.generation === generation;
    if (!before || !current()) return;
    setOlderBusy(true);
    try {
      // Older pages are never versioned, so they always come back whole.
      const r = (await readSession(peer, initial, before)) as SessionPage;
      if (!current()) return;
      atBottom.current = false;
      setReadingHistory(true);
      const el = scroller.current;
      if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      setItems((current) => withQuestionReplies([...r.items, ...(current || [])]));
      setBefore(r.before);
    } catch (e) {
      if (current()) setLoadError((e as Error).message);
    } finally {
      if (current()) setOlderBusy(false);
    }
  };

  // Tool steps between messages fold into one line, like the apps do.
  const blocks = useMemo(() => {
    const out: (
      | { type: "item"; item: SessionItem }
      | { type: "tools"; items: SessionItem[] }
      | { type: "agent"; item: SessionItem }
    )[] = [];
    for (const raw of items || []) {
      // Also normalize older companions until their server has restarted.
      const item = raw.role === "user" ? { ...raw, text: visibleUserText(raw.text), mentions: mentionedChats(raw.text) } : raw;
      if (item.role === "user" && !item.text && !item.images && !item.skills?.length && !item.attachments?.length) continue;
      const last = out[out.length - 1];
      // A sub-agent stands on its own, not folded into the steps.
      if (item.kind === "agent") out.push({ type: "agent", item });
      else if (item.role === "tool") {
        if (last?.type === "tools") last.items.push(item);
        else out.push({ type: "tools", items: [item] });
      } else out.push({ type: "item", item });
    }
    return out;
  }, [items]);
  // "Continued in …" where the chat moved, not pinned under what was said
  // after it (by time, when the items have one; else at the end).
  const movePlaces = useMemo(() => {
    const places = new Map<number, NonNullable<AgentSession["movedTo"]>>();
    const times = blocks.map((b) => (b.type === "tools" ? b.items[0]?.at : b.item.at));
    const timed = times.some((t) => typeof t === "number");
    for (const m of info.movedTo || []) {
      let place = blocks.length - 1;
      if (m.at && timed) {
        place = -1;
        times.forEach((t, i) => {
          if (typeof t === "number" && t <= m.at!) place = i;
        });
      }
      places.set(place, [...(places.get(place) || []), m]);
    }
    return places;
  }, [blocks, info.movedTo]);
  // Each message marked with its id (no box of its own), so a reload can
  // come back to the one being read (`place` below).
  const placeMoves = (nodes: ReactNode[]) => {
    const out: ReactNode[] = [];
    const at = (i: number) => {
      const moves = movePlaces.get(i);
      if (moves && i < blocks.length - 1)
        out.push(<ContinuedIn key={`moved-${i}`} session={info} moves={moves} logos={logos} onOpen={onSelect} />);
    };
    at(-1);
    nodes.forEach((node, i) => {
      const b = blocks[i];
      const id = b.type === "tools" ? `tools-${b.items[0].id}` : b.item.id;
      out.push(<div key={id} className="as-at" data-at={id}>{node}</div>);
      at(i);
    });
    return out;
  };
  // The newest reply, when the chat ends on one: it gets copy and share.
  const lastBlock = blocks[blocks.length - 1];
  const lastReply =
    lastBlock?.type === "item" &&
    lastBlock.item.role === "assistant" &&
    lastBlock.item.kind === "text"
      ? lastBlock.item.text
      : "";

  const replyActions =
    !!lastReply &&
    !working &&
    !live.streaming &&
    !pending.length &&
    !live.outbox?.length;

  // Why replying isn't possible from here, if it isn't.
  const claudeHealth = health.find((h) => h.agent === "claude");
  const codexHealth = health.find((h) => h.agent === "codex");
  // Where the session lives decides what sending does; writing is never
  // switched off, the note just says what will happen.
  const elsewhere =
    agent === "claude" && info.held !== "reach" ? info.live?.where : undefined;
  // Reach replies through the claude command on the Mac (Claude Code's CLI),
  // which signs in on its own: the Claude app's sign-in isn't shared with it.
  const claudeSignedOut =
    !!claudeHealth && claudeHealth.installed && !claudeHealth.signedIn;
  const blocked =
    agent === "gemini"
      ? "Gemini CLI no longer answers personal Google accounts (Google moved them to Antigravity). Continue this chat in another app from ⋯."
      : agent === "claude"
      ? elsewhere === "terminal"
        ? `Running in a terminal on your ${word}. Reply there or from the Terminal tab.`
        : elsewhere && elsewhere !== "claude-app"
          ? `Open in another Claude Code process on your ${word}.`
          : claudeSignedOut
            ? ""
            : elsewhere === "claude-app" && info.status === "waiting"
              ? "Claude is waiting for your answer in the Claude app. What you send goes after it, in this same session."
              : elsewhere === "claude-app" && info.status === "running"
                ? "Claude is working on this in the Claude app. What you send goes next, in this same session."
                : ""
      : codexHealth && codexHealth.installed && !codexHealth.signedIn
        ? `Codex is signed out on your ${word}.`
        : "";
  const outOfUsage = agent === "codex" && codexHealth?.usable === false;
  // Claude out of usage: the limit it hit, in Claude Code's own words, on
  // Claude's card above the composer, unless the chat already ends on it.
  const claudeLimit =
    agent === "claude" && claudeHealth?.signedIn && claudeHealth.usable === false
      ? claudeHealth.limit ||
        `You've hit your usage limit${claudeHealth.resetsAt ? ` · resets ${resetTime(claudeHealth.resetsAt, false)}` : ""}`
      : "";
  const lastItem = items?.at(-1);
  const limitShown = lastItem?.kind === "error" && lastItem.text === claudeLimit;
  // The chat itself stopped on a used-up limit: lately (the Mac's health is
  // read once a minute), or while its agent is still out.
  const stoppedOnLimit =
    !working &&
    lastItem?.kind === "error" &&
    !!usageLink(agent, { text: lastItem.text, detail: lastItem.detail }) &&
    (health.find((h) => h.agent === agent)?.usable !== true || Date.now() - (lastItem.at || 0) < 10 * 60 * 1000);
  // Close to its limit (90% and up) and not out yet: said above the message
  // box before it runs out; a tap shows its limits. Out, the strip below
  // says so instead.
  const nearLimit = usageOf(health.find((h) => h.agent === agent));
  const nearShown = !!nearLimit && nearLimit.level !== "out" && nearLimit.percent >= NEAR_AT && !nearLimit.stale;
  const [usageOpen, setUsageOpen] = useState(false);
  // Agents with usage that can take the chat on from here (MoveChat.tsx).
  const continueIn =
    outOfUsage || claudeLimit || stoppedOnLimit
      ? moveTargets(agent, health)
          .filter((to) => to !== "openclaw" && !moveBlocked(to, health, word))
          .map((to) => ({ agent: to, name: agentLabel(to) }))
      : [];
  // Moved there with its history, and told to keep going; the new chat opens.
  // If that message couldn't go, it waits in the new chat's box instead.
  const continueElsewhere = async (to: string) => {
    const moved = await moveSession(peer, info, to, { resume: true });
    if (moved.resumeError)
      try {
        sessionStorage.setItem(`reach-chat-draft:${peer.id}:${to}:${moved.id}`, "Continue where you left off.");
      } catch {}
    onSelect(movedChat(info, moved));
  };
  // Spends the account's rate-limit reset, only after the person confirms.
  const useReset = async () => {
    try {
      const { outcome } = await resetUsage(peer, "codex");
      setNote(
        outcome === "reset"
          ? "Your Codex usage is reset."
          : outcome === "nothingToReset"
            ? "There's nothing to reset right now."
            : outcome === "noCredit"
              ? "There's no reset left on your account."
              : "This reset was already used.",
      );
      onSignedIn();
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  // Signing in is what's missing (not an app or terminal holding the session).
  const needsSignIn =
    agent === "claude"
      ? claudeSignedOut && (!elsewhere || elsewhere === "claude-app")
      : agent === "codex" && !!codexHealth && codexHealth.installed && !codexHealth.signedIn;

  const modelId = choice.model || info.model || null;
  const effort = choice.effort || info.effort || null;
  const selectedModel = currentModel(models, modelId);
  const modelLabel =
    selectedModel?.name ||
    (agent === "codex"
      ? modelId
        ? modelDisplayName(modelId)
        : ""
      : claudeModel(modelId));

  const addFiles = (files: File[]) => {
    for (const file of files) {
      // Not a picture: sent as a file, the agent reads it by its path.
      if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) {
        const key = ++attachmentSeq;
        setAttachments((list) => [...list, { key, url: "", file: file.name || "file" }]);
        uploadFile(peer, file, file.name || "file").then(
          (id) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, id } : a))),
          (e) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, error: (e as Error).message } : a))),
        );
        continue;
      }
      const key = ++attachmentSeq;
      setAttachments((list) => [
        ...list,
        { key, url: URL.createObjectURL(file) },
      ]);
      uploadImage(peer, file, file.name || "image").then(
        (id) =>
          setAttachments((list) =>
            list.map((a) => (a.key === key ? { ...a, id } : a)),
          ),
        (e) =>
          setAttachments((list) =>
            list.map((a) =>
              a.key === key ? { ...a, error: (e as Error).message } : a,
            ),
          ),
      );
    }
  };
  // A voice memo: its words join what's typed, to read over before sending.
  // If the Mac can't make words of it, the recording is attached instead.
  const memo = useVoiceMemo(
    async (recording) => {
      setProblem("");
      let heard: Awaited<ReturnType<typeof transcribeVoice>>;
      try {
        heard = await transcribeVoice(peer, recording);
      } catch (e) {
        // The Mac didn't answer: keep the recording as a file all the same.
        const name = `voice-memo-${Date.now()}.${recording.type === "audio/wav" ? "wav" : recording.type.includes("webm") ? "webm" : "m4a"}`;
        const id = await uploadFile(peer, recording, name).catch(() => {
          throw new Error(`${(e as Error).message} The memo couldn't be kept; record it again.`);
        });
        heard = { problem: (e as Error).message, file: { id, name } };
      }
      if (heard.text) {
        setText((typed) => (typed.trim() ? `${typed.trimEnd()} ${heard.text}` : heard.text!));
        field.current?.focus({ preventScroll: true });
        return;
      }
      if (heard.file) {
        const file = heard.file;
        setAttachments((list) => [...list, { key: ++attachmentSeq, url: "", file: file.name, id: file.id }]);
        setProblem(`${heard.problem || "The memo couldn't become words."} The recording is attached instead.`);
      }
    },
    setProblem,
  );
  const removeAttachment = (key: number) =>
    setAttachments((list) => {
      const gone = list.find((a) => a.key === key);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return list.filter((a) => a.key !== key);
    });
  const uploading = attachments.some((a) => !a.id && !a.error);
  // "/" in the box: the agent's own commands (SlashMenu.tsx).
  const slashMenu = useSlashMenu({
    peer,
    session: initial,
    text,
    setText,
    focus: () => field.current?.focus({ preventScroll: true }),
    onModel: () => setPicking(true),
    onNew,
    onOpen: onSelect,
    onDone: () => void load(false),
  });
  const canSend =
    !sending &&
    !uploading &&
    (text.trim().length > 0 || attachments.some((a) => a.id) || !!slashMenu.skill);
  // Permission modes the session can switch to: what the agent offers now, in
  // its own words (until that arrives, the ones it always has).
  const modeChoices = modesFor(
    modes ||
      (agent === "codex"
        ? CODEX_MODE_CHOICES.filter((m) => m.id !== "custom")
        : ["manual", "acceptEdits", "plan", "auto"].map((id) => ({
            id,
            label: modeLabel("claude", id),
          }))),
    selectedModel,
  );
  // The Claude app's own names (Claude Code says "Default" where the app
  // says "Manual"); otherwise the agent's word for it.
  const modeName = (id: string | null) =>
    !id
      ? ""
      : (agent === "claude" && modeLabel("claude", id) !== id ? modeLabel("claude", id) : "") ||
        modeChoices.find((m) => m.id === id || (id === "default" && m.id === "manual"))?.label ||
        modeLabel(agent, id);
  const modeShown = choice.mode || info.mode || null;
  const send = async () => {
    if (!canSend || sendingNow.current) return;
    // One of Codex's own commands ("/status") runs instead of being sent.
    if (!attachments.length && slashMenu.runOnSend(text)) return;
    const skill = slashMenu.skill;
    const ready = attachments.filter((a) => a.id);
    const seen = (items || []).filter(
      (i) => i.role === "user" && visibleUserText(i.text).trim() === text.trim(),
    ).length;
    const message = {
      id: `pending-${Date.now()}`,
      text,
      images: ready.length,
      urls: ready.map((a) => a.url),
      seen,
      at: Date.now(),
    };
    const keep = { text, attachments, mentions };
    sendingNow.current = true;
    setSending(true);
    setProblem("");
    setPending((list) => [...list, message]);
    setText("");
    setAttachments([]);
    setMentions([]);
    atBottom.current = true;
    try {
      await draftSync.current?.settle();
      const r = await sendMessage(peer, initial, {
        text: message.text,
        images: ready.filter((a) => !a.file).map((a) => a.id!),
        ...(ready.some((a) => a.file) ? { files: ready.filter((a) => a.file).map((a) => a.id!) } : {}),
        ...(keep.mentions.length ? { chats: keep.mentions.map((m) => ({ agent: m.agent, id: m.id })) } : {}),
        ...(!heldByApp && choice.model ? { model: choice.model } : {}),
        ...(!heldByApp && choice.effort ? { effort: choice.effort } : {}),
        ...(!heldByApp && choice.speed ? { speed: choice.speed } : {}),
        ...(!heldByApp && choice.mode ? { mode: choice.mode } : {}),
        ...(skill ? { skill: skill.name } : {}),
        ...(agent === "codex" && planMode ? { collaboration: planMode } : {}),
      });
      if (skill) slashMenu.clearSkill();
      sentUrls.current.push(...ready.map((a) => a.url));
      // The acknowledged queue now owns this message. Keep no optimistic
      // copy: cancelling it in the native app does not create a transcript
      // message, so a copy waiting for that transcript would survive forever.
      if (r.messageId) setPending((list) => list.filter((p) => p !== message));
      setChoice({});
      setNote("");
      void load(false);
    } catch (e) {
      setPending((list) => list.filter((p) => p !== message));
      setText(keep.text);
      setAttachments(keep.attachments);
      setMentions(keep.mentions);
      setProblem((e as Error).message);
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    try {
      await stopSession(peer, initial);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setStopping(false);
    }
  };
  // Your last message, editable as in the Codex app: the most recent one,
  // while Codex isn't working.
  const [editingLast, setEditingLast] = useState<{ id: string; turnId: string; text: string; busy: boolean } | null>(null);
  const lastEditable = useMemo(() => {
    if (agent !== "codex" || info.status === "running" || info.status === "waiting") return null;
    const last = [...(items || [])].reverse().find((i) => i.role === "user");
    return last?.turnId && !last.slash ? last.id : null;
  }, [agent, info.status, items]);
  // Rewind, as Claude Code's own: what would change, then which to restore.
  const [rewinding, setRewinding] = useState<{ item: SessionItem; preview: RewindPreview | null; busy: string; error: string } | null>(null);
  const openRewind = async (item: SessionItem) => {
    setRewinding({ item, preview: null, busy: "preview", error: "" });
    try {
      const preview = await rewindSession(peer, initial, { messageId: item.id, dryRun: true });
      setRewinding((r) => (r?.item.id === item.id ? { ...r, preview, busy: "" } : r));
    } catch (e) {
      setRewinding((r) => (r?.item.id === item.id ? { ...r, busy: "", error: (e as Error).message } : r));
    }
  };
  const doRewind = async (what: { code: boolean; conversation: boolean }, key: string) => {
    if (!rewinding || rewinding.busy) return;
    setRewinding({ ...rewinding, busy: key, error: "" });
    try {
      await rewindSession(peer, initial, { messageId: rewinding.item.id, ...what });
      // As in Claude Code: the message is back in the box, to send again or change.
      if (what.conversation) setText(visibleUserText(rewinding.item.text));
      setRewinding(null);
      void load(false);
    } catch (e) {
      setRewinding((r) => (r ? { ...r, busy: "", error: (e as Error).message } : r));
    }
  };
  // A new chat with everything up to this message (the Codex app's Fork).
  const forkFrom = async (turnId: string) => {
    try {
      const r = await runSlashCommand(peer, initial, "fork", turnId);
      if (r.session) onSelect(r.session as AgentSession);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const saveLastEdit = async () => {
    if (!editingLast || editingLast.busy) return;
    setEditingLast({ ...editingLast, busy: true });
    try {
      await editLastMessage(peer, initial, { turnId: editingLast.turnId, text: editingLast.text });
      setEditingLast(null);
      void load(false);
    } catch (e) {
      setProblem((e as Error).message);
      setEditingLast((old) => (old ? { ...old, busy: false } : old));
    }
  };
  // Into the turn that asked, as the Codex app answers: shown on the
  // question, not as a message of its own.
  const answerAsyncQuestion = async (item: SessionItem, answers: { index: number; answer: string }[]) => {
    if (!item.turnId) throw new Error("Codex has moved on from this question. Send your answer as a message.");
    await answerCodexQuestions(peer, initial, item.id, { turnId: item.turnId, answers });
    void load(false);
  };
  const grow = () => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };
  useEffect(grow, [text]);

  const index = siblings.findIndex(
    (s) => s.agent === initial.agent && s.id === initial.id,
  );
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [details, setDetails] = useState(false);
  // A second opinion on a reply, or a relay for when this chat's agent
  // finishes (Relays.tsx). One just set up shows at once, before the list has it.
  const [relaySheet, setRelaySheet] = useState<null | { mode: "opinion"; item?: string } | { mode: "relay" }>(null);
  const [ownRelays, setOwnRelays] = useState<Relay[]>([]);
  const shownRelays = useMemo(() => {
    const byId = new Map(ownRelays.map((r) => [r.id, r]));
    for (const r of relays) byId.set(r.id, r);
    return [...byId.values()];
  }, [relays, ownRelays]);
  // The team this chat leads, or works in as a helper (Teams.tsx).
  const ledTeam = teamLedBy(teams, initial);
  const helping = ledTeam ? null : teamHelping(teams, initial);
  const relayStarted = ({ relay }: RelayStarted) => {
    setOwnRelays((list) => [...list.filter((r) => r.id !== relay.id), relay]);
    setRelaySheet(null);
    onRelaysChanged?.();
  };
  // A chat a relay went to, as the list has it (or enough to open it).
  const chatOf = (c: { agent: string; id: string; title?: string }): AgentSession =>
    everyone.find((s) => s.agent === c.agent && s.id === c.id) ||
    ({
      agent: c.agent as AgentName,
      id: c.id,
      title: c.title || "",
      cwd: info.cwd,
      branch: "",
      origin: "reach",
      inApp: false,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      status: "idle",
      preview: "",
      archived: false,
    } as AgentSession);
  const lastUser = [...(items || [])].reverse().find((i) => i.role === "user");
  // The turn Codex is on: only its questions can still be answered.
  const lastTurnId = live.turnId || [...(items || [])].reverse().find((i) => i.turnId)?.turnId;
  // A message just sent goes straight into the conversation, as in the
  // agents' own apps: it shows in the queue only when it has to wait (the
  // agent is working, or something holds it up, saying what).
  const [handoverTick, setHandoverTick] = useState(0);
  const handingOver = (m: OutboxMessage) =>
    !m.error &&
    !working &&
    (!!m.sending || pending.some((p) => (p.messageId === m.id || p.text === m.text) && Date.now() - p.at < HANDOVER_MS));
  const queued = (live.outbox || []).filter((m) => !removedQueue.includes(m.id) && !handingOver(m));
  // Still on its way a few seconds later: once, it moves to the queue.
  useEffect(() => {
    const left = pending.map((p) => HANDOVER_MS - (Date.now() - p.at)).filter((ms) => ms > 0);
    if (!left.length) return;
    const timer = setTimeout(() => setHandoverTick((n) => n + 1), Math.min(...left) + 50);
    return () => clearTimeout(timer);
  }, [pending, handoverTick]);
  // Since the newest message, one still on its way included (the last one in
  // the transcript could be a day old: it read "1327m"). Its clock (Elapsed)
  // ticks by itself: ticking here redrew the whole chat every second.
  const since = Math.max(lastUser?.at || 0, ...pending.map((p) => p.at));
  const activity =
    live.activity ||
    "Working";

  return (
    <div
      ref={page}
      className={`as-page chat-redesign ${agent} ${keyboard ? "kb-open" : ""}`}
    >
      <header
        className="as-bar"
        onTouchStart={(e) => {
          const t = e.touches[0];
          // Scrolling sideways through code, output or chips isn't a swipe.
          for (
            let el = e.target as HTMLElement | null;
            el && el !== e.currentTarget;
            el = el.parentElement
          )
            if (
              el.matches("pre, .as-picker-row, .as-attachments") ||
              el.scrollWidth > el.clientWidth + 1
            ) {
              swipe.current = null;
              return;
            }
          swipe.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const from = swipe.current;
          swipe.current = null;
          const t = e.changedTouches[0];
          if (!from || !t) return;
          const dx = t.clientX - from.x;
          if (Math.abs(dx) < 70 || Math.abs(t.clientY - from.y) > 40) return;
          const next = siblings[index + (dx < 0 ? 1 : -1)];
          if (index >= 0 && next) onSelect(next);
        }}
      >
        {/* The apps' floating round buttons: the list of chats on the left;
            where it runs, a new chat and more on the right. */}
        <button
          className="as-icon"
          aria-label="Back to all sessions"
          onClick={onBack}
        >
          <ChevronLeft size={22} />
        </button>
        <button
          className="as-title"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          <strong>{info.title}</strong>
          <small>
            {[
              ...new Set(
                [projectName(info.cwd), whereLabel(info)].filter(Boolean),
              ),
            ].join(" · ")}
          </small>
        </button>
        <span className="as-bar-pill">
          {/* The Mac asks for something (a password, a permission): a small sign. */}
          {!!deviceRequests && onReviewDevice && (
            <button
              className="as-icon as-mac-needs"
              aria-label={deviceRequests === 1 ? "Your Mac needs you" : `${deviceRequests} Mac requests need you`}
              title="Your Mac needs you"
              onClick={onReviewDevice}
            >
              <Monitor size={18} />
              <small>{deviceRequests}</small>
            </button>
          )}
          {onNew && (
            <button className="as-icon" aria-label="New chat" onClick={onNew}>
              <skin.compose size={19} />
            </button>
          )}
          {/* The chat's menu (details, "Continue in…"): a plain ⋯, still. */}
          <button
            className="as-icon"
            aria-label="More"
            title="Chat details"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            <Ellipsis size={20} />
          </button>
        </span>
      </header>
      {helping && <HelperBadge team={helping.team} task={helping.task} logos={logos} onOpen={(c) => onSelect(chatOf(c))} />}
      {items && items.length > 2 && !helping && !ledTeam && (
        <MoveHint session={info} health={health} logos={logos} onOpen={() => setDetails(true)} />
      )}
      {details && (
        <>
          {/* A tap anywhere else closes the menu. */}
          <div className="as-details-scrim" aria-hidden="true" onClick={() => setDetails(false)} />
          <div className="as-details" role="menu" aria-label="Chat details">
            <div className="as-details-head">
              {renaming !== null && (agent === "claude" || agent === "codex") ? (
                <form
                  className="as-rename"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!renaming.trim()) return;
                    try {
                      const r = await renameSession(peer, initial, renaming);
                      setInfo((old) => ({ ...old, title: r.title }));
                      setRenaming(null);
                    } catch (error) {
                      setProblem((error as Error).message);
                    }
                  }}
                >
                  <input autoFocus aria-label="Chat name" value={renaming} maxLength={200} onChange={(e) => setRenaming(e.target.value)} />
                  <button type="submit" disabled={!renaming.trim()}>Save</button>
                </form>
              ) : (
                <strong className="as-details-title">
                  {info.title}
                  {(agent === "claude" || agent === "codex") && (
                    <button className="as-icon" aria-label="Rename chat" onClick={() => setRenaming(info.title || "")}>
                      <SquarePen size={14} />
                    </button>
                  )}
                </strong>
              )}
              <small>
                {[agentLabel(agent), info.branch, projectName(info.cwd)].filter(Boolean).join(" · ")}
              </small>
            </div>
            {(agent === "claude" || agent === "codex") && (
              <button
                className="as-details-delete"
                role="menuitem"
                onClick={async () => {
                  if (!window.confirm(agent === "codex" ? "Delete this chat? Codex deletes it for good." : "Delete this chat? It goes to the Trash on your " + word + "."))
                    return;
                  try {
                    await deleteSession(peer, initial);
                    setDetails(false);
                    onBack();
                  } catch (error) {
                    setProblem((error as Error).message);
                  }
                }}
              >
                <Trash2 size={15} /> Delete chat
              </button>
            )}
            {/* Continue this chat in the other app. */}
            <MoveItems
              peer={peer}
              session={info}
              health={health}
              logos={logos}
              word={word}
              onMoved={(s) => {
                setDetails(false);
                onSelect(s);
              }}
            />
            {/* Its work goes on to another agent (Relays.tsx). */}
            <button
              className="relay-menu-item"
              role="menuitem"
              onClick={() => {
                setDetails(false);
                setRelaySheet({ mode: "relay" });
              }}
            >
              <Workflow size={18} />
              <span className="move-item-text">
                <span>Relay when done</span>
                <small>Another agent builds or reviews this</small>
              </span>
            </button>
            {!!lastReply && (
              <button
                className="relay-menu-item"
                role="menuitem"
                onClick={() => {
                  setDetails(false);
                  setRelaySheet({ mode: "opinion" });
                }}
              >
                <SearchCheck size={18} />
                <span className="move-item-text">
                  <span>Second opinion</span>
                  <small>Another agent reviews the last reply</small>
                </span>
              </button>
            )}
            {/* Its account's limits (UsageRing.tsx), as on the chat list. */}
            {nearLimit && (
              <button
                className="relay-menu-item"
                role="menuitem"
                onClick={() => {
                  setDetails(false);
                  setUsageOpen(true);
                }}
              >
                <Gauge size={18} />
                <span className="move-item-text">
                  <span>Usage</span>
                  <small>{nearLimit.level === "out" ? "Out of usage" : `${nearLimit.percent}% used`}{nearLimit.resetsAt ? ` · resets ${shortReset(nearLimit.resetsAt)}` : ""}</small>
                </span>
              </button>
            )}
          </div>
        </>
      )}
      {rewinding && (
        <>
          <div className="as-details-scrim" aria-hidden="true" onClick={() => !rewinding.busy && setRewinding(null)} />
          <div className="as-rewind" role="dialog" aria-label="Rewind">
            <strong>Rewind to before this message?</strong>
            <p className="as-rewind-quote">{visibleUserText(rewinding.item.text).slice(0, 200)}</p>
            {rewinding.busy === "preview" ? (
              <p>
                <Loader2 size={14} className="spin" /> Checking what would change…
              </p>
            ) : rewinding.preview && rewinding.preview.files.length ? (
              <p>
                {rewinding.preview.files.length} file{rewinding.preview.files.length === 1 ? "" : "s"} will change{" "}
                <b className="plus">+{rewinding.preview.insertions}</b> <b className="minus">-{rewinding.preview.deletions}</b>
              </p>
            ) : rewinding.preview ? (
              <p>No code changed since then.</p>
            ) : null}
            {rewinding.error && <p className="bad">{rewinding.error}</p>}
            <div className="as-rewind-actions">
              {!!rewinding.preview?.files.length && rewinding.preview.canRewind && (
                <button className="primary" disabled={!!rewinding.busy} onClick={() => void doRewind({ code: true, conversation: true }, "both")}>
                  {rewinding.busy === "both" ? <Loader2 size={14} className="spin" /> : "Restore code and conversation"}
                </button>
              )}
              <button className={rewinding.preview?.files.length ? "" : "primary"} disabled={!!rewinding.busy || rewinding.busy === "preview"} onClick={() => void doRewind({ code: false, conversation: true }, "conversation")}>
                {rewinding.busy === "conversation" ? <Loader2 size={14} className="spin" /> : "Restore conversation"}
              </button>
              {!!rewinding.preview?.files.length && rewinding.preview.canRewind && (
                <button disabled={!!rewinding.busy} onClick={() => void doRewind({ code: true, conversation: false }, "code")}>
                  {rewinding.busy === "code" ? <Loader2 size={14} className="spin" /> : "Restore code only"}
                </button>
              )}
              <button className="quiet" disabled={!!rewinding.busy && rewinding.busy !== "preview"} onClick={() => setRewinding(null)}>
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
      {info.rewound && <p className="as-note as-rewound">Rewound. Your next message continues from here.</p>}
      {/* Its sub-agents at a glance, above the conversation. */}
      {!!info.subagents?.length && <SubagentStrip agents={info.subagents} />}
      <div
        className="as-scroll"
        ref={scroller}
        onTouchStart={() => { touchingTranscript.current = true; }}
        onTouchEnd={() => { touchingTranscript.current = false; }}
        onTouchCancel={() => { touchingTranscript.current = false; }}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
          setReadingHistory(!atBottom.current);
          keepPlace();
        }}
      >
        {before && (
          <button
            className="as-older"
            disabled={olderBusy}
            onClick={() => void older()}
          >
            {olderBusy ? "Loading…" : "Show earlier"}
          </button>
        )}
        {loadError && <p className="as-note">{loadError}</p>}
        {/* When the chat began, above its first message, as the Codex app shows it. */}
        {agent === "codex" && !before && items?.[0]?.at ? (
          <p className="as-divider as-when">{whenLabel(items[0].at)}</p>
        ) : null}
        {!items ? (
          <p className="as-note">
            <Loader2 size={15} className="spin" /> Opening…
          </p>
        ) : (
          placeMoves(blocks.map((b, i) =>
            b.type === "tools" ? (
              <ToolRun key={`tools-${b.items[0].id}`} items={b.items} />
            ) : b.type === "agent" ? (
              <SubagentCard
                key={b.item.id}
                item={b.item}
                agent={info.subagents?.find((a) => a.toolUseId === b.item.id || a.id === b.item.agentId)}
                onStop={async (task) => {
                  try {
                    await stopSubagent(peer, initial, task);
                    void load(false);
                  } catch (e) {
                    setProblem((e as Error).message);
                  }
                }}
              />
            ) : b.item.role === "user" && editingLast?.id === b.item.id ? (
              <form
                key={b.item.id}
                className="as-edit-last"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveLastEdit();
                }}
              >
                <textarea
                  autoFocus
                  aria-label="Edit your message"
                  value={editingLast.text}
                  rows={Math.min(10, Math.max(3, editingLast.text.split("\n").length + 1))}
                  onChange={(e) => setEditingLast({ ...editingLast, text: e.target.value })}
                />
                <span className="as-edit-actions">
                  <button type="button" disabled={editingLast.busy} onClick={() => setEditingLast(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="primary" disabled={editingLast.busy || !editingLast.text.trim()}>
                    {editingLast.busy ? <Loader2 size={14} className="spin" /> : "Send"}
                  </button>
                </span>
              </form>
            ) : b.item.role === "user" ? (
              <Copyable
                key={b.item.id}
                text={b.item.text}
                side="user"
                bare={!b.item.text.trim()}
                onEdit={b.item.id === lastEditable ? () => setEditingLast({ id: b.item.id, turnId: b.item.turnId!, text: visibleUserText(b.item.text), busy: false }) : undefined}
                onFork={agent === "codex" && b.item.turnId ? () => void forkFrom(b.item.turnId!) : undefined}
                onRewind={agent === "claude" && !b.item.slash && info.status !== "running" && info.status !== "waiting" ? () => void openRewind(b.item) : undefined}
              >
              <div className="as-user">
                {b.item.queued && (
                  <span className="as-tag as-queued">Sent while working</span>
                )}
                {b.item.images ? (
                  agent === "claude" || agent === "codex" ? (
                    <SentImages
                      peer={peer}
                      session={initial}
                      item={b.item.id}
                      count={b.item.images}
                    />
                  ) : (
                    <span className="as-tag">
                      {b.item.images} image{b.item.images === 1 ? "" : "s"}
                    </span>
                  )
                ) : null}
                {b.item.skills?.map((name) => (
                  <span key={name} className="as-skill">{name}</span>
                ))}
                {b.item.attachments?.map((label, i) => (
                  <span key={i} className="as-tag as-attachment">
                    {label === "Voice message" ? <Mic size={13} /> : <FileText size={13} />} {label}
                  </span>
                ))}
                {b.item.mentions?.map((m, i) => (
                  <span key={`m${i}`} className="as-tag as-attachment" title={m.from}>
                    <AtSign size={13} /> {m.chat || m.from}
                  </span>
                ))}
                {b.item.slash ? (
                  <code className="as-slash">{b.item.text}</code>
                ) : (
                  <FoldedText text={b.item.text} />
                )}
              </div>
              </Copyable>
            ) : b.item.questions?.length ? (
              <div key={b.item.id} className="as-async-questions">
                {b.item.text && b.item.text !== b.item.questions.map((q) => [q.title, ...q.options.map((o) => `- ${o}`)].join("\n")).join("\n\n") && <AgentMarkdown text={b.item.text} />}
                <AsyncQuestions item={b.item} logos={logos} word={word} answerable={working && !!b.item.turnId && b.item.turnId === lastTurnId} onAnswer={(answers) => answerAsyncQuestion(b.item, answers)} />
              </div>
            ) : b.item.kind === "output" ? (
              <div key={b.item.id} className="as-output">
                <AgentMarkdown text={b.item.text} />
              </div>
            ) : b.item.kind === "compaction" ? (
              <div key={b.item.id || `c${i}`} className="as-divider">
                Context compacted
              </div>
            ) : b.item.kind === "error" ? (
              <ErrorNote
                key={b.item.id}
                agent={agent}
                text={b.item.text}
                detail={b.item.detail}
              />
            ) : b.item.kind === "notice" ? (
              <p key={b.item.id} className="as-divider">
                {b.item.text}
              </p>
            ) : (
              // The newest reply has its own copy and share row beneath.
              <Copyable
                key={b.item.id}
                text={b.item.text}
                side="assistant"
                bare={i === blocks.length - 1 && replyActions}
                onSecondOpinion={b.item.kind === "text" && b.item.text.trim() ? () => setRelaySheet({ mode: "opinion", item: b.item.id }) : undefined}
              >
                <div className="as-assistant">
                  <AgentMarkdown text={b.item.text} />
                </div>
              </Copyable>
            ),
          ))
        )}
        {replyActions && (
            <ReplyActions
              text={lastReply}
              disclaimer={skin.disclaimer}
              onSecondOpinion={() => setRelaySheet({ mode: "opinion", ...(lastBlock?.type === "item" ? { item: lastBlock.item.id } : {}) })}
              onRelay={() => setRelaySheet({ mode: "relay" })}
            />
          )}
        {pending
          .filter(
            (p) =>
              !removedQueue.includes(p.messageId || "") && !queued.some((m) => m.id === p.messageId || m.text === p.text),
          )
          .map((p) => (
            <div key={p.id} className="as-user pending">
              {p.images ? (
                <SentImages
                  peer={peer}
                  session={initial}
                  urls={p.urls}
                  count={p.images}
                />
              ) : null}
              <FoldedText text={p.text} />
            </div>
          ))}
        {/* Being handed over from the Mac's outbox (sent before a reload). */}
        {(live.outbox || [])
          .filter(
            (m) =>
              !removedQueue.includes(m.id) && handingOver(m) && !pending.some((p) => p.messageId === m.id || p.text === m.text),
          )
          .map((m) => (
            <div key={m.id} className="as-user pending">
              {m.images ? <SentImages peer={peer} session={initial} count={m.images} /> : null}
              <FoldedText text={visibleUserText(m.text)} />
            </div>
          ))}
        {live.streaming && (
          <div className="as-assistant streaming">
            <AgentMarkdown text={live.streaming} />
          </div>
        )}
        {/* Until the transcript has the turn's error, the live state shows it. */}
        {live.error &&
          !working &&
          !items?.some((i) => i.kind === "error" && i.text === live.error) && (
            <ErrorNote agent={agent} text={live.error} />
          )}
        {working && !live.prompts.length && (
          <div className={`as-working ${agent}`} role="status">
            {/* Reach's mascot, typing at its laptop. */}
            <MascotTyping />
            {/* Claude Code puts the time first: "1h 6m 42s · Almost done thinking…". */}
            {agent === "claude" && since > 0 && <Elapsed since={since} after=" ·" />}
            <span className={agent === "codex" ? "as-shimmer" : ""}>
              {activity}
            </span>
            {agent === "codex" && since > 0 && <Elapsed since={since} />}
          </div>
        )}
        {!working && (
          <ContinuedIn session={info} moves={movePlaces.get(blocks.length - 1) || []} logos={logos} onOpen={onSelect} />
        )}
      </div>
      <div className="as-latest-anchor">
        {readingHistory && (
          <button
            className="as-latest"
            onClick={latest}
            aria-label="Jump to latest message"
          >
            <ChevronDown size={16} /> Latest
          </button>
        )}
      </div>
      {!!reviewCount && (
        // The agent's own card, as its app shows it above the box: no
        // wrapper of Reach's around it.
        <section className="as-review-dock" aria-label="Pending decisions">
          <div className="as-review-body">
            {live.prompts.length > 1 && (
              <div
                className="as-review-tabs"
                role="group"
                aria-label="Pending requests"
              >
                {live.prompts.map((p, i) => (
                  <button
                    key={p.id}
                    aria-pressed={p.id === selectedPrompt?.id}
                    onClick={() => setReviewId(p.id)}
                  >
                    {i + 1}. {p.title}
                  </button>
                ))}
              </div>
            )}
            {info.asking &&
              !live.prompts.length &&
              (info.asking.kind === "consent" && info.asking.id ? (
                <ConsentCard
                  asking={info.asking}
                  peer={peer}
                  onAnswer={async (decision) => {
                    const asked = info.asking;
                    if (asked?.kind !== "consent" || !asked.id) return;
                    try {
                      await answerPrompt(peer, initial, asked.id, { decision });
                      setInfo((old) => ({ ...old, asking: undefined }));
                    } catch (e) {
                      setProblem((e as Error).message);
                    }
                  }}
                />
              ) : (
                <AskingCard
                  agent={agent}
                  asking={info.asking}
                  logos={logos}
                  where={
                    agent === "codex"
                      ? info.held === "terminal" ? "terminal" : "Codex app"
                      : agent === "claude" && info.live?.where !== "terminal"
                        ? "Claude app"
                        : "terminal" // Gemini CLI runs only in a terminal
                  }
                  word={word}
                  onScreen={onScreen}
                  loadCard={() => appCard(peer, initial)}
                  phoneAnswers={info.phoneAnswers}
                  onPhoneAnswers={async () => {
                    try {
                      await setPhoneAnswers(peer, true);
                      setInfo((old) => ({ ...old, phoneAnswers: undefined }));
                    } catch (e) {
                      setProblem((e as Error).message);
                      throw e;
                    }
                  }}
                  onAnswer={async (label) => {
                    const asked = info.asking;
                    if (asked?.kind !== "permission" || !asked.id) return;
                    try {
                      await answerPrompt(peer, initial, asked.id, { label });
                      setInfo((old) => ({ ...old, asking: undefined }));
                    } catch (e) {
                      setProblem((e as Error).message);
                      throw e;
                    }
                  }}
                />
              ))}
            {live.prompts.map((p) => (
              <div
                key={p.id}
                className="as-review-item"
                hidden={p.id !== selectedPrompt?.id}
              >
                <PromptCard
                  prompt={p}
                  agent={agent}
                  logos={logos}
                  word={word}
                  onAnswer={async (answer) => {
                    try {
                      await answerPrompt(peer, initial, p.id, answer);
                    } catch (e) {
                      setProblem((e as Error).message);
                    }
                  }}
                />
              </div>
            ))}
          </div>
        </section>
      )}
      <footer className="as-composer">

        {/* Out of usage: one slim line, with the way to more, and the way on
            in another agent that has usage. */}
        {(outOfUsage || claudeLimit || stoppedOnLimit) && (
          <UsageStrip
            agent={agent}
            text={
              outOfUsage
                ? `Out of Codex usage${codexHealth?.resetsAt ? ` until ${resetTime(codexHealth.resetsAt, false)}` : ""}`
                : claudeLimit
                  ? claudeHealth?.resetsAt
                    ? `Out of Claude usage until ${resetTime(claudeHealth.resetsAt, false)}`
                    : claudeLimit
                  : `${agentLabel(agent)} is out of usage`
            }
            upgrade={
              outOfUsage
                ? usageLink("codex", { detail: "usageLimitExceeded" })
                : limitShown || stoppedOnLimit
                  ? null
                  : usageLink("claude", { text: claudeLimit, detail: "rate_limit" })
            }
            resets={outOfUsage ? codexHealth?.resetCredits || 0 : 0}
            onReset={useReset}
            from={agentLabel(agent)}
            continueIn={continueIn}
            onContinue={continueElsewhere}
            logos={logos}
          />
        )}
        {nearShown && !(outOfUsage || claudeLimit || stoppedOnLimit) && (
          <button className={`usage-near ${nearLimit!.level}`} onClick={() => setUsageOpen(true)}>
            {agentLabel(agent)} {nearLimit!.percent}% used
            {nearLimit!.resetsAt ? ` · resets ${shortReset(nearLimit!.resetsAt)}` : ""}
          </button>
        )}
        {usageOpen && (
          <UsageSheet health={health.filter((h) => h.agent === agent)} logos={logos} onClose={() => setUsageOpen(false)} />
        )}
        {(problem || note || blocked) && (
          <p className={`as-hint ${problem ? "bad" : ""}`}>
            {problem || blocked || note}
          </p>
        )}
        {agent === "gemini" && onScreen && (
          <div className="as-prompt-actions">
            <button onClick={onScreen}>Open live screen</button>
          </div>
        )}
        {needsSignIn && (
          <AgentAccess
            peer={peer}
            agent={agent}
            health={health.find((h) => h.agent === agent)}
            logos={logos}
            onSignedIn={onSignedIn}
          />
        )}
        {choosingMode && (
          <ModeMenu
            agent={agent}
            choices={modeChoices}
            current={modeShown === "default" ? "manual" : modeShown}
            anchor={modeButton.current}
            busy={modeSaving}
            error={modeError}
            pending={info.pendingMode || undefined}
            onClose={() => setChoosingMode(false)}
            onPick={async (id) => {
              if (savingMode.current) return;
              savingMode.current = true;
              setModeSaving(true);
              setModeError("");
              try {
                const result = await setAgentMode(peer, initial, id);
                if (result.applied) {
                  setInfo((old) => ({ ...old, mode: id }));
                  setChoice((old) => ({ ...old, mode: undefined }));
                } else if (result.next === "request") {
                  // Claude Code there takes it with its next request: the
                  // mode it's in stays shown, and the menu says what's coming.
                  setInfo((old) => ({ ...old, pendingMode: id }));
                  return;
                } else setChoice((old) => ({ ...old, mode: id }));
                setChoosingMode(false);
              } catch (error) {
                setModeError((error as Error).message);
              } finally {
                savingMode.current = false;
                setModeSaving(false);
              }
            }}
          />
        )}
        <SlashMenu menu={slashMenu} />
        {picking && (
          <ModelMenu
            agent={agent}
            models={models}
            model={modelId}
            effort={effort}
            speed={choice.speed || info.speed || null}
            busy={modelsLoading || modelSaving}
            error={modelError}
            working={working}
            onRetry={() => setModelReload((n) => n + 1)}
            onClose={() => setPicking(false)}
            onPick={async (next, stay) => {
              // The speed changes the chat's own setting at once, as in the
              // Codex app (thread settings; the app's when it holds the chat).
              if (next.speed && !next.model) next = { ...next, model: modelId || info.model || undefined };
              if (savingModel.current) return;
              const operation = {};
              const generation = readLife.generation;
              const current = () => readLife.active && readLife.generation === generation && savingModel.current === operation;
              savingModel.current = operation;
              readLife.settingsGeneration++;
              setModelSaving(true);
              setModelError("");
              try {
                const result = await setAgentModel(peer, initial, next);
                if (!current()) return;
                if (result.applied) {
                  // Once native settings are confirmed, follow subsequent
                  // desktop/device changes instead of pinning this old pick.
                  setInfo((previous) => ({ ...previous, ...next }));
                  setChoice((previous) => ({
                    ...previous,
                    ...(next.model !== undefined ? { model: undefined } : {}),
                    ...(next.effort !== undefined ? { effort: undefined } : {}),
                  }));
                } else setChoice((previous) => ({ ...previous, ...next }));
                if (!stay) setPicking(false);
              } catch (e) {
                if (current()) setModelError((e as Error).message);
              } finally {
                if (current()) {
                  readLife.settingsGeneration++;
                  savingModel.current = null;
                  setModelSaving(false);
                  if (readLife.settingsReadPending) {
                    readLife.settingsReadPending = false;
                    void load(false);
                  }
                }
              }
            }}
          />
        )}
        {/* While it works: what happens when it's done (Relays.tsx), unless
            a relay already waits on this chat. */}
        {working &&
          (agent === "codex" || agent === "claude") &&
          !shownRelays.some((r) => r.state === "waiting" && r.chain.at(-1)?.agent === agent && r.chain.at(-1)?.id === initial.id) && (
            <button className="relay-when-chip" aria-label="Relay when done" onClick={() => setRelaySheet({ mode: "relay" })}>
              <Workflow size={14} /> When done, relay…
            </button>
          )}
        {/* The team this chat leads (Teams.tsx). */}
        {ledTeam && (
          <TeamStrip peer={peer} team={ledTeam} logos={logos} onOpen={(c) => onSelect(chatOf(c))} onChanged={onRelaysChanged} />
        )}
        {/* Relays this chat is part of: what's set up, and where it stands. */}
        <RelayStrip
          peer={peer}
          relays={shownRelays}
          here={initial}
          logos={logos}
          onOpen={(c) => onSelect(chatOf(c))}
          onChanged={onRelaysChanged}
        />
        {/* Claude's todo list, pinned above the composer as in the Claude app. */}
        {!!info.todos?.length && info.todos.some((t) => t.status !== "completed") && <TodoStrip todos={info.todos} />}
        {/* Right on top of the message box, as both apps put their queue. */}
        {!!queued.length && (
          <QueuedMessages
            agent={agent}
            messages={queued}
            busy={queueBusy}
            canEdit={!queueBusy}
            onEdit={async (m, words) => {
              setQueueBusy(m.id);
              // What Reach put ahead of the words (chats mentioned) stays with them.
              const shown = visibleUserText(m.text);
              const ahead = shown && m.text.endsWith(shown) ? m.text.slice(0, m.text.length - shown.length) : "";
              try {
                await editQueued(peer, initial, m.id, ahead + words);
                void load(false);
              } catch (error) { setProblem((error as Error).message); throw error; }
              finally { setQueueBusy(null); }
            }}
            onRemove={async (m) => {
              setQueueBusy(m.id);
              try {
                await cancelQueuedMessage(peer, initial, m.id);
                setRemovedQueue((old) => [...old, m.id]);
                setPending((old) => old.filter((p) => p.messageId !== m.id && p.text !== m.text));
              } catch (error) { setProblem((error as Error).message); }
              finally { setQueueBusy(null); }
            }}
            onSendNow={async (m: OutboxMessage) => {
              setQueueBusy(m.id);
              try {
                await sendQueuedNow(peer, initial, m.id);
                void load(false);
              } catch (error) { setProblem((error as Error).message); }
              finally { setQueueBusy(null); }
            }}
            {...((agent === "claude" || agent === "codex") && {
              onReorder: async (ids: string[]) => {
                setQueueBusy("order");
                try {
                  await reorderQueued(peer, initial, ids);
                  void load(false);
                } catch (error) { setProblem((error as Error).message); throw error; }
                finally { setQueueBusy(null); }
              },
            })}
          />
        )}
        {/* Gemini CLI chats are read here: no box to type in (it only refused after sending). */}
        {agent !== "gemini" && (
        <div className="as-box">
          <div className="as-field">
            {attachments.length > 0 && (
              <div className="as-attachments">
                {attachments.map((a) => (
                  <span
                    key={a.key}
                    className={`as-thumb ${a.error ? "bad" : ""}`}
                    title={a.error}
                  >
                    {a.file ? (
                      <span className="as-file-chip">
                        <FileText size={14} aria-hidden="true" /> {a.file}
                      </span>
                    ) : (
                      <img src={a.url} alt="" />
                    )}
                    {!a.id && !a.error && (
                      <Loader2 size={16} className="spin" />
                    )}
                    <button
                      aria-label={a.file ? "Remove file" : "Remove image"}
                      onClick={() => removeAttachment(a.key)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <SkillChip menu={slashMenu} />
            {mentions.length > 0 && (
              <div className="as-attachments as-mentioned" aria-label="Chats mentioned">
                {mentions.map((m) => (
                  <span key={`${m.agent}:${m.id}`} className="as-file-chip as-mention-chip">
                    <AgentLogo agent={m.agent} logos={logos} size={14} /> {m.title || "Untitled"}
                    <button
                      aria-label={`Don't mention ${m.title || "this chat"}`}
                      onClick={() => setMentions((list) => list.filter((x) => !(x.agent === m.agent && x.id === m.id)))}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {(agent === "claude" || agent === "codex") && mentionQuery !== null && (
              <MentionMenu
                peer={peer}
                session={initial}
                query={mentionQuery}
                chats={everyone}
                logos={logos}
                onPickChat={(chat) => {
                  setMentions((list) =>
                    list.some((m) => m.agent === chat.agent && m.id === chat.id) ? list : [...list, chat].slice(-3),
                  );
                  const next = text.replace(/@([^\s@]{0,80})$/, "");
                  setText(next);
                  draftSync.current?.update(next);
                  field.current?.focus({ preventScroll: true });
                }}
                onPick={(file) => {
                  // As each agent names a file: @path for Claude Code, the path for Codex.
                  const next = text.replace(/@([^\s@]{0,80})$/, `${agent === "claude" ? "@" : ""}${file} `);
                  setText(next);
                  draftSync.current?.update(next);
                  field.current?.focus({ preventScroll: true });
                }}
              />
            )}
            <textarea
              ref={field}
              aria-label="Message"
              rows={1}
              value={text}
              placeholder={skin.placeholder}
              onChange={(e) => { setText(e.target.value); if (!sending) draftSync.current?.update(e.target.value); }}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (!files.length) return;
                if (!e.clipboardData.getData("text/plain")) e.preventDefault();
                addFiles(files);
              }}
              onKeyDown={(e) => {
                if (slashMenu.onKeyDown(e)) return;
                // Enter sends on a computer; on a phone it's a new line, as in the apps.
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !narrow &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div className="as-tools">
            <button
              className="as-icon"
              aria-label="Add images"
              onClick={() => picker.current?.click()}
            >
              <Plus size={18} />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files || [])]);
                e.target.value = "";
              }}
            />
            {/* Always in sight, as in the Claude and Codex apps: the mode
                there and here is the same one. */}
            {(agent === "claude" || agent === "codex") && (
              <button
                ref={modeButton}
                className={`as-mode ${agent}`}
                aria-expanded={choosingMode}
                onClick={() => {
                  setChoosingMode(!choosingMode);
                  setPicking(false);
                }}
              >
                {agent === "codex" && <ShieldCheck size={14} />}
                <span>{modeShown ? modeName(modeShown) : "Default"}</span>
              </button>
            )}
            {agent === "codex" && (
              <button
                className={`as-plan-toggle ${planMode === "plan" ? "on" : ""}`}
                aria-pressed={planMode === "plan"}
                title={heldByApp ? "The Codex app has this chat open: turn Plan on there" : "Plan before doing, as the Codex app's Plan"}
                onClick={togglePlan}
              >
                <ListChecks size={14} /> Plan
              </button>
            )}
            <span className="as-spacer" />
            {info.context && <ContextMeter used={info.context.used} window={info.context.window} />}
            {/* Always in sight, as both apps keep their model by the box. */}
            {(agent === "codex" || agent === "claude") && (
              <button
                className="as-model"
                aria-expanded={picking}
                onClick={() => {
                  setChoosingMode(false);
                  setPicking(!picking);
                }}
              >
                <span className="as-model-name">{modelLabel || "Model"}</span>{" "}
                <span className="as-model-effort">{effortLabel(effort || selectedModel?.defaultEffort, agent)}</span>
                <ChevronDown size={14} />
              </button>
            )}
            {/* Voice: tap to record, tap again for its words in the box. */}
            {memo.state === "recording" && (
              <button className="as-icon" aria-label="Discard memo" onClick={memo.cancel}>
                <X size={16} />
              </button>
            )}
            {(canRecord() || memo.state !== "idle") && (
              <button
                className={`as-icon as-mic ${memo.state}`}
                aria-label={memo.state === "recording" ? "Stop recording" : memo.state === "working" ? "Transcribing" : "Record a voice memo"}
                disabled={memo.state === "working"}
                onClick={() => void (memo.state === "recording" ? memo.stop() : memo.start())}
              >
                {memo.state === "working" ? (
                  <Loader2 size={16} className="spin" />
                ) : memo.state === "recording" ? (
                  <span className="as-mic-time">
                    {Math.floor(memo.seconds / 60)}:{String(memo.seconds % 60).padStart(2, "0")}
                  </span>
                ) : (
                  <Mic size={17} />
                )}
              </button>
            )}
            {/* One round button, as in both apps: send, or stop while it works
              and nothing is typed. */}
            {working && !text.trim() ? (
              <button
                className="as-send stop"
                aria-label="Stop"
                disabled={stopping}
                onClick={() => void stop()}
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                className={`as-send ${text.trim() || attachments.length || slashMenu.skill ? "ready" : ""}`}
                aria-label="Send"
                disabled={!canSend}
                onClick={() => void send()}
              >
                {sending ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <ArrowUp size={18} />
                )}
              </button>
            )}
          </div>
        </div>
        )}
      </footer>
      {relaySheet?.mode === "opinion" && (
        <SecondOpinionSheet
          peer={peer}
          session={info}
          item={relaySheet.item}
          health={health}
          logos={logos}
          onClose={() => setRelaySheet(null)}
          onStarted={relayStarted}
        />
      )}
      {relaySheet?.mode === "relay" && (
        <RelaySheet
          peer={peer}
          session={info}
          working={working}
          hasReply={!!lastReply}
          sessions={everyone}
          health={health}
          logos={logos}
          onClose={() => setRelaySheet(null)}
          onStarted={relayStarted}
        />
      )}
    </div>
  );
}
