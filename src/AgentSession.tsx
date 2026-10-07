import { useWantedPrompt } from "./notification-focus";
import { AccountUsage } from "./AccountUsage";
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
  SlidersHorizontal,
  ChevronRight,
  FileText,
  Globe,
  Info,
  Copy,
  Ellipsis,
  Laptop,
  Loader2,
  Monitor,
  Plus,
  Share,
  ShieldCheck,
  SquarePen,
  Square,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import type { Peer } from "./api";
import AgentMarkdown from "./AgentMarkdown";
import { createDraftSync } from "./draft-sync";
import { visibleUserText } from "../server/agent-sessions/message-text.mjs";
import { useViewportBox } from "./useViewportBox";
import AgentAccess from "./AgentAccess";
import QueuedMessages from "./QueuedMessages";
import { ClaudeModelSheet, CodexConfigureSheet, CodexEffortStrip } from "./ModelSheet";
import { ContinuedIn, MoveHint, MoveItems } from "./MoveChat";
import UsageStrip from "./UsageStrip";
import MascotTyping from "./MascotTyping";
import { SkillChip, SlashMenu, useSlashMenu } from "./SlashMenu";
import { useAppIcon } from "./app-icons";
import { CLAUDE_DECISIONS, DECISIONS } from "./decision-words";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { useClaudeFonts } from "./agent-fonts";
import { computerWord } from "./pause";
import {
  agentLabel,
  answerPrompt,
  appCard,
  sessionImage,
  effortLabel,
  listModels,
  modeLabel,
  modesFor,
  CODEX_MODE_CHOICES,
  projectName,
  resetTime,
  resetUsage,
  readSession,
  sendMessage,
  cancelQueuedMessage,
  reorderQueued,
  sendQueuedNow,
  syncAgentDraft,
  setAgentMode,
  setAgentModel,
  stopSession,
  uploadImage,
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
}: {
  text: string;
  disclaimer: string;
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
  children,
}: {
  text: string;
  side: "user" | "assistant";
  bare?: boolean;
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
        </div>
      )}
    </div>
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
  const other = items.filter((i) => i.kind === "tool").length;
  const parts = [
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
        <code>{item.text || "(step)"}</code>
      </button>
      {open && item.detail && <pre>{item.detail}</pre>}
    </div>
  );
}

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
function ModeMenu({
  agent,
  choices,
  current,
  anchor,
  locked,
  busy = false,
  error,
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
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const rank = (id: string) => (CLAUDE_MODE_ORDER.includes(id) ? CLAUDE_MODE_ORDER.indexOf(id) : CLAUDE_MODE_ORDER.length);
  const list =
    agent === "claude"
      ? [...choices].sort((a, b) => rank(a.id) - rank(b.id)).map((m) => ({ ...m, label: modeLabel("claude", m.id) || m.label, note: "" }))
      : choices.map((m) => ({ ...m, note: CODEX_MODE_NOTES[m.id] ?? m.note ?? "" }));
  return (
    <ComposerMenu anchor={anchor} label="Permissions" className={agent} onClose={onClose}>
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
      {error && <p role="alert" className="as-mode-menu-locked">{error}</p>}
    </ComposerMenu>
  );
}

// A small menu over a composer button, as the apps open theirs: drawn on the
// chat's page (the composer scrolls its own contents and clipped it out of
// sight), lined up with its button, closed by a tap outside or Escape.
function ComposerMenu({
  anchor,
  label,
  className = "",
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
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
  const over = anchor ?? (typeof document !== "undefined" ? document.querySelector<HTMLElement>(".as-page .as-composer") : null);
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
  anchor,
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
  anchor: HTMLElement | null;
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
function FoldedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
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
          <img key={n} src={sources[n]!} alt="" />
        ) : (
          <span key={n} className="as-image-wait" aria-hidden="true" />
        ),
      )}
      {count > shownCount && (
        <span className="as-tag">+{count - shownCount}</span>
      )}
    </div>
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
}: {
  agent: string;
  asking: AgentAsking;
  logos: AgentLogos;
  where: string;
  word: string;
  onScreen?: () => void;
  loadCard?: () => Promise<AppCard>;
  onAnswer?: (label: string) => Promise<void>;
}) {
  const id = asking.kind === "permission" ? asking.id : undefined;
  const answerable = !!id && !!loadCard && !!onAnswer;
  const [card, setCard] = useState<AppCard | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const answering = useRef(false);
  useEffect(() => {
    if (!answerable) return;
    let active = true;
    setCard(null);
    setFailed("");
    loadCard!().then(
      (c) => active && setCard(c),
      (e) => active && setFailed((e as Error).message),
    );
    return () => {
      active = false;
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
          {onScreen && (
            <div className="as-prompt-actions">
              <button className="primary" onClick={onScreen}>Open screen to answer</button>
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

function AsyncQuestions({ item, logos, word, onAnswer }: {
  item: SessionItem;
  logos: AgentLogos;
  word: string;
  onAnswer: (text: string) => Promise<void>;
}) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const questions = item.questions || [];
  if (sent) return <p className="as-note">Answer sent</p>;
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
          const text = questions.map((q, i) => `${q.title}\n${(answers?.[String(i)] || []).join(", ")}`).join("\n\n");
          await onAnswer(text);
          setSent(true);
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

function PromptCard({
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
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
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
    answer: { decision?: string; answers?: Record<string, string[]> },
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
      {prompt.kind === "question" ? (
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

type Attachment = { key: number; url: string; id?: string; error?: string };
let attachmentSeq = 0;

// A new chat's model and effort: the same pickers as in a chat (ModelSheet.tsx).
export function ModelPicker({
  agent,
  models,
  model,
  effort,
  speed,
  onPick,
  onClose,
}: {
  agent: AgentName;
  models: AgentModel[];
  model: string | null;
  effort: string | null;
  speed?: string | null;
  onPick: (choice: { model?: string; effort?: string; speed?: string }, done: boolean) => void;
  onClose: () => void;
}) {
  const [configuring, setConfiguring] = useState(false);
  const shared = { agent, models, model, effort, speed, onClose };
  if (agent !== "codex") return <ClaudeModelSheet {...shared} onPick={(next) => onPick(next, true)} />;
  if (configuring) return <CodexConfigureSheet {...shared} onPick={(next) => onPick(next, false)} onClose={() => setConfiguring(false)} />;
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
  const [settings, setSettings] = useState(false);
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
  const savingModel = useRef(false);
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
  const modelButton = useRef<HTMLButtonElement>(null);
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
  const readLife = useMemo(() => ({ active: false, generation: 0 }), [peer.url, peer.token, initial.agent, initial.id]);
  useLayoutEffect(() => {
    readLife.active = true;
    readLife.generation++;
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
        // A question answered elsewhere is simply gone from the new read.
        setInfo((old) => ({ ...old, asking: undefined, ...r.session }));
        setItems((current) => {
          if (!current || first) return r.items;
          // Keep older pages already loaded; replace the newest page.
          const oldest = r.items[0]?.id;
          const at = oldest ? current.findIndex((i) => i.id === oldest) : -1;
          return [...(at >= 0 ? current.slice(0, at) : []), ...r.items];
        });
        if (first) setBefore(r.before);
        setLoadError("");
        // A sent message is shown until the transcript has one more copy of it
        // than when it was sent (a repeated "continue" must not clear early).
        setPending((list) =>
          list.filter(
            (p) =>
              r.items.filter(
                (i) => i.role === "user" && i.text.trim() === p.text.trim(),
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
      setItems((current) => [...r.items, ...(current || [])]);
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
    )[] = [];
    for (const raw of items || []) {
      // Also normalize older companions until their server has restarted.
      const item = raw.role === "user" ? { ...raw, text: visibleUserText(raw.text) } : raw;
      if (item.role === "user" && !item.text && !item.images && !item.skills?.length) continue;
      const last = out[out.length - 1];
      if (item.role === "tool") {
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
  const placeMoves = (nodes: ReactNode[]) => {
    if (!movePlaces.size) return nodes;
    const out: ReactNode[] = [];
    const at = (i: number) => {
      const moves = movePlaces.get(i);
      if (moves && i < blocks.length - 1)
        out.push(<ContinuedIn key={`moved-${i}`} session={info} moves={moves} logos={logos} onOpen={onSelect} />);
    };
    at(-1);
    nodes.forEach((node, i) => {
      out.push(node);
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
  const modelLabel =
    models.find((m) => m.id === modelId)?.name ||
    (agent === "codex"
      ? modelId
        ? modelId.toUpperCase().replace(/-/g, " ")
        : ""
      : claudeModel(modelId));

  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name))
        continue;
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
  const removeAttachment = (key: number) =>
    setAttachments((list) => {
      const gone = list.find((a) => a.key === key);
      if (gone) URL.revokeObjectURL(gone.url);
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
    models.find((m) => m.id === modelId),
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
      (i) => i.role === "user" && i.text.trim() === text.trim(),
    ).length;
    const message = {
      id: `pending-${Date.now()}`,
      text,
      images: ready.length,
      urls: ready.map((a) => a.url),
      seen,
      at: Date.now(),
    };
    const keep = { text, attachments };
    sendingNow.current = true;
    setSending(true);
    setProblem("");
    setPending((list) => [...list, message]);
    setText("");
    setAttachments([]);
    atBottom.current = true;
    try {
      await draftSync.current?.settle();
      const r = await sendMessage(peer, initial, {
        text: message.text,
        images: ready.map((a) => a.id!),
        ...(!heldByApp && choice.model ? { model: choice.model } : {}),
        ...(!heldByApp && choice.effort ? { effort: choice.effort } : {}),
        ...(!heldByApp && choice.speed ? { speed: choice.speed } : {}),
        ...(!heldByApp && choice.mode ? { mode: choice.mode } : {}),
        ...(skill ? { skill: skill.name } : {}),
      });
      if (skill) slashMenu.clearSkill();
      sentUrls.current.push(...ready.map((a) => a.url));
      // Waiting in the Mac's outbox: shown from there from now on (it outlives this page).
      if (r.messageId)
        setPending((list) =>
          list.map((p) =>
            p === message ? { ...p, messageId: r.messageId } : p,
          ),
        );
      setChoice({});
      setNote("");
      void load(false);
    } catch (e) {
      setPending((list) => list.filter((p) => p !== message));
      setText(keep.text);
      setAttachments(keep.attachments);
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
  const answerAsyncQuestion = async (text: string) => {
    if (sendingNow.current) throw new Error("A message is being sent. Try again in a moment.");
    sendingNow.current = true;
    setSending(true);
    try {
      const r = await sendMessage(peer, initial, { text, images: [] });
      setPending((list) => [...list, {
        id: `pending-${Date.now()}`, text, images: 0, urls: [], at: Date.now(),
        seen: (items || []).filter((i) => i.role === "user" && i.text.trim() === text.trim()).length,
        ...(r.messageId ? { messageId: r.messageId } : {}),
      }]);
      void load(false);
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
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
  const lastUser = [...(items || [])].reverse().find((i) => i.role === "user");
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
      {items && items.length > 2 && (
        <MoveHint session={info} health={health} logos={logos} onOpen={() => setDetails(true)} />
      )}
      <AccountUsage health={health.find((h) => h.agent === agent)} />
      {details && (
        <>
          {/* A tap anywhere else closes the menu. */}
          <div className="as-details-scrim" aria-hidden="true" onClick={() => setDetails(false)} />
          <div className="as-details" role="menu" aria-label="Chat details">
            <div className="as-details-head">
              <strong className="as-details-title">{info.title}</strong>
              <small>
                {[agentLabel(agent), info.branch, projectName(info.cwd)].filter(Boolean).join(" · ")}
              </small>
            </div>
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
          </div>
        </>
      )}
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
            ) : b.item.role === "user" ? (
              <Copyable key={b.item.id} text={b.item.text} side="user" bare={!b.item.text.trim()}>
              <div className="as-user">
                {b.item.queued && (
                  <span className="as-tag">Sent while working</span>
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
                <AsyncQuestions item={b.item} logos={logos} word={word} onAnswer={answerAsyncQuestion} />
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
              <Copyable key={b.item.id} text={b.item.text} side="assistant" bare={i === blocks.length - 1 && replyActions}>
                <div className="as-assistant">
                  <AgentMarkdown text={b.item.text} />
                </div>
              </Copyable>
            ),
          ))
        )}
        {replyActions && (
            <ReplyActions text={lastReply} disclaimer={skin.disclaimer} />
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
              (info.asking.kind === "question" && info.asking.id ? (
                // Claude's question in the Claude app: its options tapped
                // here, pressed there (no live screen needed).
                <PromptCard
                  prompt={{
                    id: info.asking.id,
                    kind: "question",
                    title: `${agentLabel(agent)} has a question`,
                    questions: info.asking.questions.map((q, i) => ({
                      id: `q${i}`,
                      header: q.header || "",
                      question: q.question,
                      options: q.options.map((o) => ({ label: o.label, description: o.description || "" })),
                      other: false,
                      secret: false,
                      multiSelect: !!q.multiSelect,
                    })),
                  }}
                  agent={agent}
                  logos={logos}
                  word={word}
                  onAnswer={async ({ answers }) => {
                    const asked = info.asking;
                    if (asked?.kind !== "question" || !asked.id) return;
                    try {
                      await answerPrompt(peer, initial, asked.id, { answers });
                      setInfo((old) => ({ ...old, asking: undefined }));
                    } catch (e) {
                      setProblem((e as Error).message);
                    }
                  }}
                />
              ) : info.asking.kind === "consent" && info.asking.id ? (
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

        {/* Out of usage: one slim line, with the way to more (the other app is in ⋯). */}
        {(outOfUsage || claudeLimit) && (
          <UsageStrip
            agent={agent}
            text={
              outOfUsage
                ? `Out of Codex usage${codexHealth?.resetsAt ? ` until ${resetTime(codexHealth.resetsAt, false)}` : ""}`
                : claudeHealth?.resetsAt
                  ? `Out of Claude usage until ${resetTime(claudeHealth.resetsAt, false)}`
                  : claudeLimit
            }
            upgrade={
              outOfUsage
                ? usageLink("codex", { detail: "usageLimitExceeded" })
                : limitShown
                  ? null
                  : usageLink("claude", { text: claudeLimit, detail: "rate_limit" })
            }
            resets={outOfUsage ? codexHealth?.resetCredits || 0 : 0}
            onReset={useReset}
          />
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
            anchor={modelButton.current}
            busy={modelsLoading || modelSaving}
            error={modelError}
            working={working}
            onRetry={() => setModelReload((n) => n + 1)}
            onClose={() => setPicking(false)}
            onPick={async (next, stay) => {
              // The speed goes with the next message (Codex has no other way
              // to change a chat's speed).
              if (next.speed) {
                setChoice((previous) => ({ ...previous, speed: next.speed }));
                return;
              }
              if (savingModel.current) return;
              savingModel.current = true;
              setModelSaving(true);
              setModelError("");
              try {
                const result = await setAgentModel(peer, initial, next);
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
                setModelError((e as Error).message);
              } finally {
                savingModel.current = false;
                setModelSaving(false);
              }
            }}
          />
        )}
        {/* Right on top of the message box, as both apps put their queue. */}
        {!!queued.length && (
          <QueuedMessages
            agent={agent}
            messages={queued}
            busy={queueBusy}
            canEdit={!queueBusy && !text.trim()}
            onEdit={async (m) => {
              setQueueBusy(m.id);
              try {
                await cancelQueuedMessage(peer, initial, m.id);
                setRemovedQueue((old) => [...old, m.id]);
                setPending((old) => old.filter((p) => p.messageId !== m.id && p.text !== m.text));
                setText(visibleUserText(m.text));
                field.current?.focus({ preventScroll: true });
              } catch (error) { setProblem((error as Error).message); }
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
            {...(agent === "claude" && {
              onSendNow: async (m: OutboxMessage) => {
                setQueueBusy(m.id);
                try {
                  await sendQueuedNow(peer, initial, m.id);
                } catch (error) { setProblem((error as Error).message); }
                finally { setQueueBusy(null); }
              },
              onReorder: async (ids: string[]) => {
                try {
                  await reorderQueued(peer, initial, ids);
                } catch (error) { setProblem((error as Error).message); }
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
                    <img src={a.url} alt="" />
                    {!a.id && !a.error && (
                      <Loader2 size={16} className="spin" />
                    )}
                    <button
                      aria-label="Remove image"
                      onClick={() => removeAttachment(a.key)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <SkillChip menu={slashMenu} />
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
              accept="image/*"
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
            <span className="as-spacer" />
            {settings && (agent === "codex" || agent === "claude") && (
              <button
                ref={modelButton}
                className="as-model"
                aria-expanded={picking}
                onClick={() => {
                  setChoosingMode(false);
                  setPicking(!picking);
                }}
              >
                {modelLabel || "Model"}{" "}
                <span>{effortLabel(effort || (models.find((m) => m.id === modelId) || models.find((m) => m.isDefault))?.defaultEffort, agent)}</span>
                <ChevronDown size={14} />
              </button>
            )}
            <button
              className="as-icon"
              aria-label="Chat settings"
              aria-expanded={settings}
              onClick={() => {
                setSettings(!settings);
                setPicking(false);
                setChoosingMode(false);
              }}
            >
              <SlidersHorizontal size={18} />
            </button>
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
    </div>
  );
}
