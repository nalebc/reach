import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
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
  Laptop,
  Loader2,
  Monitor,
  MoreHorizontal,
  Plus,
  Share,
  ShieldCheck,
  Sparkle,
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
import ChatSheet from "./ChatSheet";
import { ContinuedIn, MoveHint, MoveOffer } from "./MoveChat";
import ChatList from "./ChatList";
import { useAppIcon } from "./app-icons";
import { CLAUDE_DECISIONS, DECISIONS } from "./decision-words";
import { AgentLogo, ClaudeSpark, type AgentLogos } from "./agent-logos";
import { useClaudeFonts } from "./agent-fonts";
import { computerWord } from "./pause";
import {
  agentLabel,
  answerPrompt,
  sessionImage,
  effortLabel,
  listCommands,
  listModels,
  modeLabel,
  modesFor,
  CODEX_MODE_CHOICES,
  openInApp,
  projectName,
  resetTime,
  resetUsage,
  readSession,
  sendMessage,
  cancelQueuedMessage,
  syncAgentDraft,
  stopSession,
  uploadImage,
  usageLink,
  useSessionLive,
  whereLabel,
  type AgentAsking,
  type AgentHealth,
  type AgentMode,
  type AgentCommand,
  type UsageLink,
  type AgentModel,
  type AgentName,
  type AgentSession,
  type Decision,
  type SessionItem,
  type SessionPage,
  type SessionPrompt,
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
  if (agent === "codex")
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

// A question or permission request Claude waits on in another app (the
// Claude app, a terminal), already showing there: said here, answered there.
// word: "Mac" or "computer" (pause.ts computerWord).
function AskingCard({
  asking,
  logos,
  where,
  word,
}: {
  asking: AgentAsking;
  logos: AgentLogos;
  where: string;
  word: string;
}) {
  return (
    <section
      className={`as-prompt ${asking.kind === "question" ? "question" : "tool"} elsewhere`}
      aria-live="polite"
    >
      <header>
        <AgentLogo agent="claude" logos={logos} size={18} />
        <strong>
          Waiting for your answer in the {where} on your {word}
        </strong>
      </header>
      {asking.kind === "question" ? (
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
      ) : asking.command ? (
        <pre className="as-prompt-command">{asking.text}</pre>
      ) : (
        <p>{asking.text}</p>
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

function PromptCard({
  prompt,
  agent,
  logos,
  word,
  onAnswer,
}: {
  prompt: SessionPrompt;
  agent: AgentName;
  logos: AgentLogos;
  word: string;
  onAnswer: (answer: {
    decision?: string;
    answers?: Record<string, string[]>;
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  // Picked choices per question, and what was typed instead ("Something else").
  const [picked, setPicked] = useState<Record<string, string[]>>({});
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
    setBusy(key);
    try {
      await onAnswer(answer);
    } finally {
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
      {prompt.command && (
        <pre className="as-prompt-command">{prompt.command}</pre>
      )}
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
                  !!busy || questions.some((q) => !answerOf(q.id).length)
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
              disabled={!!busy}
              onClick={() => void act(key, { decision: key })}
            >
              {busy === key ? (
                <Loader2 size={14} className="spin" />
              ) : prompt.kind === "dialog" ? (
                `Answer on my ${word}`
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

// Model and thinking as two small chip rows that open above the composer,
// in place of the apps' menus; no popup. A thinking level finishes the pick.
export function ModelPicker({
  agent,
  models,
  model,
  effort,
  onPick,
}: {
  agent: AgentName;
  models: AgentModel[];
  model: string | null;
  effort: string | null;
  onPick: (choice: { model?: string; effort?: string }, done: boolean) => void;
}) {
  const current =
    models.find((m) => m.id === model) ||
    models.find((m) => m.isDefault) ||
    models[0];
  return (
    <div
      className={`as-picker ${agent}`}
      role="group"
      aria-label="Model and thinking"
    >
      <div className="as-picker-row" aria-label="Model">
        {models.map((m) => (
          <button
            key={m.id}
            aria-pressed={m.id === current?.id}
            onClick={() =>
              onPick(
                {
                  model: m.id,
                  effort:
                    effort && m.efforts.includes(effort)
                      ? effort
                      : m.defaultEffort || undefined,
                },
                false,
              )
            }
          >
            {m.name}
          </button>
        ))}
      </div>
      {current?.efforts.length ? (
        <div className="as-picker-row" aria-label="Thinking">
          {current.efforts.map((e) => (
            <button
              key={e}
              aria-pressed={e === (effort || current.defaultEffort)}
              title={current.effortNotes?.[e]}
              onClick={() => onPick({ model: current.id, effort: e }, true)}
            >
              {effortLabel(e, agent)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
  const [switching, setSwitching] = useState(false);
  const [settings, setSettings] = useState(false);
  const [reviewing, setReviewing] = useState(true);
  const [reviewId, setReviewId] = useState("");
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
  const [stopping, setStopping] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [modes, setModes] = useState<AgentMode[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [choice, setChoice] = useState<{
    model?: string;
    effort?: string;
    mode?: string;
  }>({});
  const [picking, setPicking] = useState(false);
  const [choosingMode, setChoosingMode] = useState(false);
  const [commands, setCommands] = useState<AgentCommand[] | null>(null);
  const { view: live } = useSessionLive(peer, initial);
  const promptIds = live.prompts.map((p) => p.id).join(",");
  const askingKey = JSON.stringify(info.asking);
  useEffect(() => {
    setReviewing(true);
  }, [promptIds, askingKey]);
  const reviewCount = live.prompts.length || (info.asking ? 1 : 0);
  const selectedPrompt =
    live.prompts.find((p) => p.id === reviewId) || live.prompts[0];
  const page = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);
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
  const load = useCallback(
    async (first: boolean) => {
      if (document.hidden && !first) return;
      try {
        const r = await readSession(
          peer,
          initial,
          null,
          first ? undefined : known.current,
        );
        known.current = r.version || "";
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
        setLoadError((e as Error).message);
      }
    },
    [peer.url, peer.token, initial.agent, initial.id],
  );
  useEffect(() => {
    void load(true);
  }, [load]);
  // Faster while something runs; the live view wakes it instantly on news.
  useEffect(() => {
    const timer = setInterval(
      () => void load(false),
      working || pending.length ? 2000 : 5000,
    );
    return () => clearInterval(timer);
  }, [load, working, pending.length]);
  useEffect(() => {
    if (live.items) void load(false);
  }, [live.items, load]);
  useEffect(() => {
    listModels(peer, agent).then(
      (r) => {
        setModels(r.models);
        if (r.modes?.length) setModes(r.modes);
      },
      () => {},
    );
  }, [peer.url, peer.token, agent]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prepend.current) {
      el.scrollTop =
        prepend.current.top + el.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, live.streaming, live.prompts.length, working]);
  // Follow the last message through keyboard/composer resizing only when the
  // reader was already at the end. Reading history never fights new output.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
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
    if (!before) return;
    setOlderBusy(true);
    try {
      // Older pages are never versioned, so they always come back whole.
      const r = (await readSession(peer, initial, before)) as SessionPage;
      atBottom.current = false;
      setReadingHistory(true);
      const el = scroller.current;
      if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      setItems((current) => [...r.items, ...(current || [])]);
      setBefore(r.before);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setOlderBusy(false);
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
      if (item.role === "user" && !item.text && !item.images) continue;
      const last = out[out.length - 1];
      if (item.role === "tool") {
        if (last?.type === "tools") last.items.push(item);
        else out.push({ type: "tools", items: [item] });
      } else out.push({ type: "item", item });
    }
    return out;
  }, [items]);
  // The newest reply, when the chat ends on one: it gets copy and share.
  const lastBlock = blocks[blocks.length - 1];
  const lastReply =
    lastBlock?.type === "item" &&
    lastBlock.item.role === "assistant" &&
    lastBlock.item.kind === "text"
      ? lastBlock.item.text
      : "";

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
    agent === "claude"
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
    setResetting(true);
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
      setConfirmReset(false);
      onSignedIn();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setResetting(false);
    }
  };
  // Signing in is what's missing (not an app or terminal holding the session).
  const needsSignIn =
    agent === "claude"
      ? claudeSignedOut && (!elsewhere || elsewhere === "claude-app")
      : !!codexHealth && codexHealth.installed && !codexHealth.signedIn;

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
  const canSend =
    !sending &&
    !uploading &&
    (text.trim().length > 0 || attachments.some((a) => a.id));
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
  const modeName = (id: string | null) =>
    !id
      ? ""
      : modeChoices.find(
          (m) => m.id === id || (id === "default" && m.id === "manual"),
        )?.label || modeLabel(agent, id);
  const modeShown = choice.mode || info.mode || null;
  // Claude Code's slash commands while the message starts with "/".
  const slash =
    agent === "claude" && /^\/[\w:-]*$/.test(text)
      ? text.slice(1).toLowerCase()
      : null;
  useEffect(() => {
    if (slash !== null && !commands)
      listCommands(peer, "claude").then(setCommands, () => setCommands([]));
  }, [slash !== null]);
  const suggestions =
    slash === null || !commands
      ? []
      : commands
          .filter((c) => c.name.toLowerCase().startsWith(slash))
          .slice(0, 6);

  const send = async () => {
    if (!canSend) return;
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
    setSending(true);
    setProblem("");
    setPending((list) => [...list, message]);
    setText("");
    setAttachments([]);
    atBottom.current = true;
    try {
      await draftSync.current?.flush();
      const r = await sendMessage(peer, initial, {
        text: message.text,
        images: ready.map((a) => a.id!),
        ...(!heldByApp && choice.model ? { model: choice.model } : {}),
        ...(!heldByApp && choice.effort ? { effort: choice.effort } : {}),
        ...(!heldByApp && choice.mode ? { mode: choice.mode } : {}),
      });
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
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  // Since the newest message, one still on its way included (the last one in
  // the transcript could be a day old: it read "1327m").
  const since = Math.max(lastUser?.at || 0, ...pending.map((p) => p.at));
  const elapsed =
    working && since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  const elapsedLabel =
    elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
      : `${elapsed}s`;
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
        <button
          className="as-app-switch"
          aria-label="Switch conversations"
          aria-haspopup="dialog"
          aria-expanded={switching}
          onClick={() => setSwitching(true)}
        >
          <AgentLogo agent={agent} logos={logos} size={22} />
          <span className="as-app-switch-name">{agentLabel(agent)}</span>
          <ChevronDown size={13} />
        </button>
        <span className="as-bar-pill">
          {onNew && (
            <button className="as-icon" aria-label="New chat" onClick={onNew}>
              <skin.compose size={19} />
            </button>
          )}
          <button
            className="as-icon"
            aria-label="More"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            <MoreHorizontal size={20} />
          </button>
        </span>
      </header>
      {items && items.length > 2 && (
        <MoveHint session={info} health={health} logos={logos} onOpen={() => setSwitching(true)} />
      )}
      {details && (
        <div className="as-details">
          <strong className="as-details-title">{info.title}</strong>
          <span>
            {agentLabel(agent)}
            {info.branch ? ` · ${info.branch}` : ""}
            {info.cwd ? ` · ${info.cwd}` : ""}
          </span>
          <button
            className="as-details-open"
            onClick={async () => {
              try {
                await openInApp(peer, info);
                setNote(`Opened in the ${skin.app} on your ${word}.`);
                setDetails(false);
              } catch (e) {
                setProblem((e as Error).message);
              }
            }}
          >
            <Monitor size={14} /> Open in the {skin.app}
          </button>
        </div>
      )}
      <div
        className="as-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
          blocks.map((b, i) =>
            b.type === "tools" ? (
              <ToolRun key={`tools-${b.items[0].id}`} items={b.items} />
            ) : b.item.role === "user" ? (
              <div key={b.item.id} className="as-user">
                {b.item.queued && (
                  <span className="as-tag">Sent while working</span>
                )}
                {b.item.images ? (
                  agent === "claude" ? (
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
              <div key={b.item.id} className="as-assistant">
                <AgentMarkdown text={b.item.text} />
              </div>
            ),
          )
        )}
        {lastReply &&
          !working &&
          !live.streaming &&
          !pending.length &&
          !live.outbox?.length && (
            <ReplyActions text={lastReply} disclaimer={skin.disclaimer} />
          )}
        {pending
          .filter(
            (p) =>
              !removedQueue.includes(p.messageId || "") && !live.outbox?.some((m) => m.id === p.messageId || m.text === p.text),
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
              <AgentMarkdown text={p.text} />
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
            {agent === "claude" ? (
              <ClaudeSpark logos={logos} size={17} spinning />
            ) : null}
            {/* Claude Code puts the time first: "1h 6m 42s · Almost done thinking…". */}
            {agent === "claude" && elapsed > 0 && (
              <small>{elapsedLabel} ·</small>
            )}
            <span className={agent === "codex" ? "as-shimmer" : ""}>
              {activity}
            </span>
            {agent === "codex" && elapsed > 0 && <small>{elapsedLabel}</small>}
          </div>
        )}
        {!working && <ContinuedIn session={info} logos={logos} onOpen={onSelect} />}
      </div>
      {switching && (
        <ChatSheet
          title="Switch conversation"
          onClose={() => setSwitching(false)}
        >
          <MoveOffer
            peer={peer}
            session={info}
            health={health}
            logos={logos}
            word={word}
            onMoved={(s) => {
              setSwitching(false);
              onSelect(s);
            }}
          />
          <ChatList
            compact
            peer={peer}
            sessions={siblings.length ? siblings : [initial]}
            agent={initial.agent}
            apps={[
              {
                agent: initial.agent,
                name: agentLabel(initial.agent),
                supported: true,
              },
            ]}
            logos={logos}
            onOpen={(s) => {
              setSwitching(false);
              if (s.agent !== initial.agent || s.id !== initial.id) onSelect(s);
            }}
            onNew={() => {
              setSwitching(false);
              onNew?.();
            }}
          />
        </ChatSheet>
      )}
      {!!deviceRequests && onReviewDevice && (
        <section className="as-review-dock" aria-label="Computer permissions">
          <button className="as-review-toggle" onClick={onReviewDevice}>
            <span><Monitor size={16} />{deviceRequests === 1 ? "Your Mac needs you" : `${deviceRequests} Mac requests need you`}</span>
            <ChevronRight size={16} />
          </button>
        </section>
      )}
      {!!reviewCount && (
        <section className="as-review-dock" aria-label="Pending decisions">
          <button
            className="as-review-toggle"
            aria-expanded={reviewing}
            aria-controls="session-decision-body"
            onClick={() => setReviewing(!reviewing)}
          >
            <span>
              <ShieldCheck size={16} />
              {reviewCount === 1
                ? "Your decision is needed"
                : String(reviewCount) + " decisions need you"}
            </span>
            <ChevronDown size={16} />
          </button>
          <div
            id="session-decision-body"
            className="as-review-body"
            hidden={!reviewing}
          >
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
                  asking={info.asking}
                  logos={logos}
                  where={
                    info.live?.where === "terminal" ? "terminal" : "Claude app"
                  }
                  word={word}
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
        {!!live.outbox?.filter((m) => !removedQueue.includes(m.id)).length && (
          <section className="as-queue" aria-label="Queued messages">
            <header>Queued</header>
            {live.outbox.filter((m) => !removedQueue.includes(m.id)).map((m) => (
              <div className="as-queue-row" key={m.id}>
                <div className="as-queue-message">
                  <p>{visibleUserText(m.text) || (m.images ? `${m.images} image${m.images === 1 ? "" : "s"}` : "Message")}</p>
                  {m.images > 0 && m.text && <small>{m.images} image{m.images === 1 ? "" : "s"}</small>}
                  {m.error && <small role="status">{m.error}</small>}
                </div>
                {!m.images && <button aria-label="Edit queued message" title="Edit" disabled={!!queueBusy || !!text.trim()} onClick={async () => {
                  setQueueBusy(m.id);
                  try {
                    await cancelQueuedMessage(peer, initial, m.id);
                    setRemovedQueue((old) => [...old, m.id]);
                    setPending((old) => old.filter((p) => p.messageId !== m.id && p.text !== m.text));
                    setText(visibleUserText(m.text));
                    field.current?.focus({ preventScroll: true });
                  } catch (error) { setProblem((error as Error).message); }
                  finally { setQueueBusy(null); }
                }}><SquarePen size={14} /></button>}
                <button aria-label="Remove queued message" title="Remove" disabled={!!queueBusy} onClick={async () => {
                  setQueueBusy(m.id);
                  try {
                    await cancelQueuedMessage(peer, initial, m.id);
                    setRemovedQueue((old) => [...old, m.id]);
                    setPending((old) => old.filter((p) => p.messageId !== m.id && p.text !== m.text));
                  } catch (error) { setProblem((error as Error).message); }
                  finally { setQueueBusy(null); }
                }}><X size={14} /></button>
              </div>
            ))}
          </section>
        )}
        {readingHistory && (
          <button
            className="as-latest"
            onClick={latest}
            aria-label="Jump to latest message"
          >
            <ChevronDown size={16} /> Latest
          </button>
        )}
        {claudeLimit && !limitShown && (
          <ErrorNote agent="claude" text={claudeLimit} detail="rate_limit" />
        )}
        {outOfUsage && (
          <div className="as-banner codex-usage">
            <div>
              <strong>You’re out of Codex usage</strong>
              <span>
                {codexHealth?.resetsAt
                  ? `Your rate limit resets on ${resetTime(codexHealth.resetsAt, false)}. `
                  : ""}
                {codexHealth?.resetCredits
                  ? "Upgrade or use one of your rate limit resets now."
                  : "Upgrade to keep going."}
              </span>
            </div>
            {confirmReset ? (
              <div className="as-banner-actions">
                <span>Use your rate limit reset now? It can’t be undone.</span>
                <button
                  className="as-banner-btn"
                  onClick={() => setConfirmReset(false)}
                >
                  Cancel
                </button>
                <button
                  className="as-banner-btn primary"
                  disabled={resetting}
                  onClick={() => void useReset()}
                >
                  {resetting ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    "Reset usage"
                  )}
                </button>
              </div>
            ) : (
              <div className="as-banner-actions">
                {!!codexHealth?.resetCredits && (
                  <button
                    className="as-banner-btn"
                    onClick={() => setConfirmReset(true)}
                  >
                    Reset usage
                  </button>
                )}
                <a
                  className="as-banner-btn primary"
                  href={
                    usageLink("codex", { detail: "usageLimitExceeded" })?.url
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Sparkle size={14} fill="currentColor" /> Upgrade
                </a>
              </div>
            )}
          </div>
        )}
        {(claudeLimit || outOfUsage) && (
          <MoveOffer variant="usage" peer={peer} session={info} health={health} logos={logos} word={word} onMoved={onSelect} />
        )}
        {(problem || note || blocked) && (
          <p className={`as-hint ${problem ? "bad" : ""}`}>
            {problem || blocked || note}
          </p>
        )}
        {needsSignIn && (
          <AgentAccess
            peer={peer}
            agent={agent}
            health={agent === "claude" ? claudeHealth : codexHealth}
            logos={logos}
            onSignedIn={onSignedIn}
          />
        )}
        {/* Signed out here: or keep going with the other agent. */}
        {needsSignIn && (
          <MoveOffer variant="usage" peer={peer} session={info} health={health} logos={logos} word={word} onMoved={onSelect} />
        )}
        {settings && choosingMode && (
          <div
            className={`as-picker ${agent}`}
            role="group"
            aria-label="Permissions"
          >
            <div className="as-picker-row">
              {modeChoices.map((m) => (
                <button
                  key={m.id}
                  aria-pressed={
                    m.id === modeShown ||
                    (modeShown === "default" && m.id === "manual")
                  }
                  title={m.note || undefined}
                  onClick={() => {
                    setChoice({ ...choice, mode: m.id });
                    setChoosingMode(false);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="as-commands" role="listbox" aria-label="Commands">
            {suggestions.map((c) => (
              <button
                key={c.name}
                role="option"
                aria-selected={false}
                onClick={() => {
                  setText(`/${c.name} `);
                  field.current?.focus({ preventScroll: true });
                }}
              >
                <b>/{c.name}</b>
                {c.hint && <code>{c.hint}</code>}
                <span>{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {settings && picking && (
          <ModelPicker
            agent={agent}
            models={models}
            model={modelId}
            effort={effort}
            onPick={(next, done) => {
              setChoice(next);
              if (done) setPicking(false);
            }}
          />
        )}
        {settings && picking && (
          <MoveOffer
            variant="picker"
            peer={peer}
            session={info}
            health={health}
            logos={logos}
            word={word}
            onMoved={(s) => {
              setPicking(false);
              onSelect(s);
            }}
          />
        )}
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
            {settings && (
              <button
                className={`as-mode ${agent}`}
                disabled={heldByApp}
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
            {settings && modelLabel && (
              <button
                className="as-model"
                disabled={heldByApp || !models.length}
                aria-expanded={picking}
                onClick={() => {
                  setPicking(!picking);
                  setChoosingMode(false);
                }}
              >
                {modelLabel} <span>{effortLabel(effort, agent)}</span>
                {!heldByApp && models.length > 0 && <ChevronDown size={14} />}
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
                className={`as-send ${text.trim() || attachments.length ? "ready" : ""}`}
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
      </footer>
    </div>
  );
}
