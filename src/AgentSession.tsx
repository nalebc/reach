import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  FileText,
  Globe,
  Info,
  Loader2,
  Monitor,
  Plus,
  ShieldCheck,
  Square,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import type { Peer } from "./api";
import AgentMarkdown from "./AgentMarkdown";
import { useViewportBox } from "./useViewportBox";
import AgentSignIn from "./AgentSignIn";
import { AgentLogo, ClaudeSpark, type AgentLogos } from "./agent-logos";
import {
  agentLabel,
  answerPrompt,
  effortLabel,
  listCommands,
  listModels,
  modeLabel,
  openInApp,
  projectName,
  readSession,
  sendMessage,
  stopSession,
  uploadImage,
  useSessionLive,
  whereLabel,
  type AgentHealth,
  type AgentCommand,
  type AgentModel,
  type AgentName,
  type AgentSession,
  type Decision,
  type SessionItem,
  type SessionPage,
  type SessionPrompt,
} from "./agent-sessions";
import "./agent-session.css";


// Each agent's own words, so the screen reads like its app.
const SKIN = {
  codex: { placeholder: "Do anything", app: "Codex app" },
  claude: { placeholder: "Type / for commands", app: "Claude app" },
} as const;

// "claude-opus-5-5" → "Opus 5.5", as the Claude app writes it.
const claudeModel = (id?: string | null) => {
  if (id === "default") return "Default";
  const m = String(id || "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : String(id || "");
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
  kind === "command" ? Terminal : kind === "file-change" ? FileText : kind === "web" ? Globe : Wrench;
const base = (file: string) => file.split(/[\\/]/).pop() || file;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));

// "Edited App.tsx, ran 2 commands" with the diff size, like both apps show.
function runSummary(items: SessionItem[]) {
  const files = [...new Set(items.filter((i) => i.kind === "file-change").map((i) => i.text))];
  const commands = items.filter((i) => i.kind === "command").length;
  const web = items.filter((i) => i.kind === "web").length;
  const other = items.filter((i) => i.kind === "tool").length;
  const parts = [
    files.length && (files.length === 1 ? `edited ${base(files[0])}` : `edited ${files.length} files`),
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
  const running = items.some((i) => i.status === "running" || i.status === "inProgress");
  return (
    <div className={`as-run ${open ? "open" : ""}`}>
      <button className="as-run-head" onClick={() => setOpen(!open)} aria-expanded={open}>
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
      <button onClick={() => item.detail && setOpen(!open)} aria-expanded={open}>
        <Icon size={13} />
        <code>{item.text || "(step)"}</code>
      </button>
      {open && item.detail && <pre>{item.detail}</pre>}
    </div>
  );
}

// The choices exactly as the agent offered them, in plain words.
const DECISIONS: Record<string, string> = {
  accept: "Yes",
  acceptForSession: "Yes, for this session",
  acceptWithExecpolicyAmendment: "Yes, always allow this",
  decline: "No",
  cancel: "No, and stop",
  allowAlways: "Yes, and don't ask again",
  approved: "Yes",
  approved_for_session: "Yes, for this session",
  abort: "No, and stop",
  allow: "Allow",
  deny: "Deny",
};
// Claude Code's permission dialog words it its own way.
const CLAUDE_DECISIONS: Record<string, string> = { allow: "Yes", allowAlways: "Yes, and don't ask again", deny: "No" };
const decisionKey = (d: Decision) => (typeof d === "string" ? d : Object.keys(d)[0]);

function PromptCard({
  prompt,
  agent,
  logos,
  onAnswer,
}: {
  prompt: SessionPrompt;
  agent: AgentName;
  logos: AgentLogos;
  onAnswer: (answer: { decision?: string; answers?: Record<string, string[]> }) => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const act = async (key: string, answer: { decision?: string; answers?: Record<string, string[]> }) => {
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
      {prompt.command && <pre className="as-prompt-command">{prompt.command}</pre>}
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
          {prompt.questions?.map((q) => (
            <div className="as-question" key={q.id}>
              {q.header && <b>{q.header}</b>}
              <p>{q.question}</p>
              <div className="as-choices">
                {q.options.map((o) => (
                  <button
                    key={o.label}
                    className={answers[q.id] === o.label ? "chosen" : ""}
                    onClick={() => setAnswers({ ...answers, [q.id]: o.label })}
                  >
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </button>
                ))}
              </div>
              {(q.other || !q.options.length) && (
                <input
                  type={q.secret ? "password" : "text"}
                  placeholder={q.options.length ? "Something else…" : "Your answer"}
                  value={q.options.some((o) => o.label === answers[q.id]) ? "" : answers[q.id] || ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                />
              )}
            </div>
          ))}
          <div className="as-prompt-actions">
            <button
              className="primary"
              disabled={!!busy || prompt.questions?.some((q) => !answers[q.id]?.trim())}
              onClick={() =>
                void act("answer", {
                  answers: Object.fromEntries((prompt.questions || []).map((q) => [q.id, [answers[q.id]]])),
                })
              }
            >
              {busy ? <Loader2 size={14} className="spin" /> : "Answer"}
            </button>
          </div>
        </>
      ) : (
        <div className="as-prompt-actions">
          {decisions.map((key) => (
            <button
              key={key}
              className={positive(key) && key === decisions.find(positive) ? "primary" : ""}
              disabled={!!busy}
              onClick={() => void act(key, { decision: key })}
            >
              {busy === key ? (
                <Loader2 size={14} className="spin" />
              ) : prompt.kind === "dialog" ? (
                "Answer on my Mac"
              ) : (
                (prompt.kind === "tool" ? CLAUDE_DECISIONS[key] : DECISIONS[key]) || key
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
  const current = models.find((m) => m.id === model) || models.find((m) => m.isDefault) || models[0];
  return (
    <div className={`as-picker ${agent}`} role="group" aria-label="Model and thinking">
      <div className="as-picker-row" aria-label="Model">
        {models.map((m) => (
          <button
            key={m.id}
            aria-pressed={m.id === current?.id}
            onClick={() =>
              onPick(
                {
                  model: m.id,
                  effort: effort && m.efforts.includes(effort) ? effort : m.defaultEffort || undefined,
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
  siblings,
  health,
  onSelect,
  onBack,
  onSignedIn = () => {},
  logos = {},
}: {
  peer: Peer;
  session: AgentSession;
  siblings: AgentSession[];
  health: AgentHealth[];
  onSelect: (s: AgentSession) => void;
  onBack: () => void;
  onSignedIn?: () => void;
  logos?: AgentLogos;
}) {
  const agent = initial.agent;
  const skin = SKIN[agent];
  const [info, setInfo] = useState<AgentSession>(initial);
  const [items, setItems] = useState<SessionItem[] | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [olderBusy, setOlderBusy] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Sent but not yet in the transcript; `seen` counts the same text already there.
  const [pending, setPending] = useState<{ id: string; text: string; images: number; seen: number }[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [choice, setChoice] = useState<{ model?: string; effort?: string; mode?: string }>({});
  const [picking, setPicking] = useState(false);
  const [choosingMode, setChoosingMode] = useState(false);
  const [commands, setCommands] = useState<AgentCommand[] | null>(null);
  const { view: live } = useSessionLive(peer, initial);
  const page = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);
  const narrow = useNarrow();
  const keyboard = useKeyboardOpen();
  useViewportBox(page, narrow);

  const runningHere = live.status === "running" || live.status === "waiting";
  const runningElsewhere = !runningHere && info.status === "running";
  const working = runningHere || runningElsewhere;
  const heldByApp = info.held === "codex-app";

  // The version of the newest page we hold; unchanged polls cost no render.
  const known = useRef("");
  const load = useCallback(
    async (first: boolean) => {
      if (document.hidden && !first) return;
      try {
        const r = await readSession(peer, initial, null, first ? undefined : known.current);
        known.current = r.version || "";
        if ("unchanged" in r) {
          setLoadError("");
          return;
        }
        setInfo((old) => ({ ...old, ...r.session }));
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
            (p) => r.items.filter((i) => i.role === "user" && i.text.trim() === p.text.trim()).length <= p.seen,
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
    const timer = setInterval(() => void load(false), working || pending.length ? 2000 : 5000);
    return () => clearInterval(timer);
  }, [load, working, pending.length]);
  useEffect(() => {
    if (live.items) void load(false);
  }, [live.items, load]);
  useEffect(() => {
    listModels(peer, agent).then((r) => setModels(r.models), () => {});
  }, [peer.url, peer.token, agent]);
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, pending, live.streaming, live.prompts.length, working]);
  const shown = useRef(attachments);
  shown.current = attachments;
  useEffect(
    () => () => {
      for (const a of shown.current) URL.revokeObjectURL(a.url);
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
    const out: ({ type: "item"; item: SessionItem } | { type: "tools"; items: SessionItem[] })[] = [];
    for (const item of items || []) {
      const last = out[out.length - 1];
      if (item.role === "tool") {
        if (last?.type === "tools") last.items.push(item);
        else out.push({ type: "tools", items: [item] });
      } else out.push({ type: "item", item });
    }
    return out;
  }, [items]);

  // Why replying isn't possible from here, if it isn't.
  const claudeHealth = health.find((h) => h.agent === "claude");
  const codexHealth = health.find((h) => h.agent === "codex");
  // Where the session lives decides what sending does; writing is never
  // switched off, the note just says what will happen.
  const elsewhere = agent === "claude" && info.held !== "reach" ? info.live?.where : undefined;
  const blocked =
    agent === "claude"
      ? elsewhere === "claude-app"
        ? info.status === "running"
          ? "Claude is working on this in the Claude app. What you send goes next, in this same session."
          : "Same session as in the Claude app: what you send here is there too."
        : elsewhere === "terminal"
          ? "Running in a terminal on your Mac. Reply there or from the Terminal tab."
          : elsewhere
            ? "Open in another Claude Code process on your Mac."
            : claudeHealth && !claudeHealth.signedIn
              ? "Claude Code is signed out on your Mac. Sign in to reply from here."
              : ""
      : codexHealth && codexHealth.installed && !codexHealth.signedIn
        ? "Codex is signed out on your Mac."
        : "";
  const outOfUsage = agent === "codex" && codexHealth?.usable === false;
  // Signing in is what's missing (not an app or terminal holding the session).
  const needsSignIn =
    agent === "claude"
      ? !elsewhere && !!claudeHealth && claudeHealth.installed && !claudeHealth.signedIn
      : !!codexHealth && codexHealth.installed && !codexHealth.signedIn;

  const modelId = choice.model || info.model || null;
  const effort = choice.effort || info.effort || null;
  const modelLabel =
    models.find((m) => m.id === modelId)?.name ||
    (agent === "codex" ? (modelId ? modelId.toUpperCase().replace(/-/g, " ") : "") : claudeModel(modelId));

  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) continue;
      const key = ++attachmentSeq;
      setAttachments((list) => [...list, { key, url: URL.createObjectURL(file) }]);
      uploadImage(peer, file, file.name || "image").then(
        (id) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, id } : a))),
        (e) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, error: (e as Error).message } : a))),
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
  const canSend = !sending && !uploading && (text.trim().length > 0 || attachments.some((a) => a.id));
  // Permission modes the session can switch to, in the agent's own words.
  const modeChoices = agent === "codex" ? ["auto", "guardian-approvals", "full-access", "read-only"] : ["auto", "manual", "acceptEdits", "plan"];
  const modeShown = choice.mode || info.mode || null;
  // Claude Code's slash commands while the message starts with "/".
  const slash = agent === "claude" && /^\/[\w:-]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  useEffect(() => {
    if (slash !== null && !commands) listCommands(peer, "claude").then(setCommands, () => setCommands([]));
  }, [slash !== null]);
  const suggestions = slash === null || !commands ? [] : commands.filter((c) => c.name.toLowerCase().startsWith(slash)).slice(0, 6);

  const send = async () => {
    if (!canSend) return;
    const ready = attachments.filter((a) => a.id);
    const seen = (items || []).filter((i) => i.role === "user" && i.text.trim() === text.trim()).length;
    const message = { id: `pending-${Date.now()}`, text, images: ready.length, seen };
    const keep = { text, attachments };
    setSending(true);
    setProblem("");
    setPending((list) => [...list, message]);
    setText("");
    setAttachments([]);
    atBottom.current = true;
    try {
      const r = await sendMessage(peer, initial, {
        text: message.text,
        images: ready.map((a) => a.id!),
        ...(!heldByApp && choice.model ? { model: choice.model } : {}),
        ...(!heldByApp && choice.effort ? { effort: choice.effort } : {}),
        ...(!heldByApp && choice.mode ? { mode: choice.mode } : {}),
      });
      for (const a of ready) URL.revokeObjectURL(a.url);
      setChoice({});
      setNote(
        r.queued
          ? r.delivered
            ? "Sent to the Codex app on your Mac."
            : agent === "claude"
              ? "Goes next, when Claude finishes in the Claude app."
              : "Queued in the Codex app. It runs after the current turn."
          : r.steered
            ? "Added to the running turn."
            : "",
      );
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

  const index = siblings.findIndex((s) => s.agent === initial.agent && s.id === initial.id);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [details, setDetails] = useState(false);
  const lastUser = [...(items || [])].reverse().find((i) => i.role === "user");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const elapsed = working && lastUser?.at ? Math.max(0, Math.round((now - lastUser.at) / 1000)) : 0;
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
  const activity = live.activity || (runningElsewhere ? `Working in the ${skin.app}` : "Working");

  return (
    <div ref={page} className={`as-page ${agent} ${keyboard ? "kb-open" : ""}`}>
      <header className="as-bar">
        <button className="as-icon" aria-label="Back to all sessions" onClick={onBack}>
          <ChevronLeft size={21} />
        </button>
        <button className="as-title" aria-expanded={details} onClick={() => setDetails(!details)}>
          <strong>{info.title}</strong>
          <small>
            {projectName(info.cwd)} · {whereLabel(info)}
          </small>
        </button>
        <AgentLogo agent={agent} logos={logos} size={24} />
      </header>
      {details && (
        <div className="as-details">
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
                setNote(`Opened in the ${skin.app} on your Mac.`);
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
        onTouchStart={(e) => {
          const t = e.touches[0];
          // Scrolling sideways through code, output or chips isn't a swipe.
          for (let el = e.target as HTMLElement | null; el && el !== e.currentTarget; el = el.parentElement)
            if (el.matches("pre, .as-picker-row, .as-attachments") || el.scrollWidth > el.clientWidth + 1) {
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
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {before && (
          <button className="as-older" disabled={olderBusy} onClick={() => void older()}>
            {olderBusy ? "Loading…" : "Show earlier"}
          </button>
        )}
        {loadError && <p className="as-note">{loadError}</p>}
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
                {b.item.queued && <span className="as-tag">Sent while working</span>}
                <AgentMarkdown text={b.item.text} />
                {b.item.images ? (
                  <span className="as-tag">
                    {b.item.images} image{b.item.images === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
            ) : b.item.kind === "compaction" ? (
              <div key={b.item.id || `c${i}`} className="as-divider">
                Context compacted
              </div>
            ) : b.item.kind === "error" ? (
              agent === "codex" ? (
                <p key={b.item.id} className="as-error codex">
                  <Info size={15} /> <span>{b.item.text}</span>
                </p>
              ) : (
                <section key={b.item.id} className="as-error claude">
                  <header>
                    <TriangleAlert size={15} />{" "}
                    {b.item.detail
                      ? b.item.detail.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
                      : "Error"}
                  </header>
                  <p>{b.item.text}</p>
                </section>
              )
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
        {pending.map((p) => (
          <div key={p.id} className="as-user pending">
            <AgentMarkdown text={p.text} />
            {p.images ? (
              <span className="as-tag">
                {p.images} image{p.images === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        ))}
        {live.streaming && (
          <div className="as-assistant streaming">
            <AgentMarkdown text={live.streaming} />
          </div>
        )}
        {live.error && !working && (
          <p className="as-error codex">
            <Info size={15} /> <span>{live.error}</span>
          </p>
        )}
        {working && !live.prompts.length && (
          <div className={`as-working ${agent}`} role="status">
            {agent === "claude" ? <ClaudeSpark logos={logos} size={17} spinning /> : null}
            <span className={agent === "codex" ? "as-shimmer" : ""}>{activity}</span>
            {elapsed > 0 && <small>{elapsedLabel}</small>}
          </div>
        )}
        {live.prompts.map((p) => (
          <PromptCard
            key={p.id}
            prompt={p}
            agent={agent}
            logos={logos}
            onAnswer={async (answer) => {
              try {
                await answerPrompt(peer, initial, p.id, answer);
              } catch (e) {
                setProblem((e as Error).message);
              }
            }}
          />
        ))}
      </div>
      <footer className="as-composer">
        {outOfUsage && (
          <div className="as-banner">
            <strong>You're out of Codex usage</strong>
            <span>
              {codexHealth?.resetsAt
                ? `Your rate limit resets on ${new Date(codexHealth.resetsAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
                : "Your rate limit resets soon."}
            </span>
          </div>
        )}
        {(problem || note || blocked || heldByApp) && (
          <p className={`as-hint ${problem ? "bad" : ""}`}>
            {problem ||
              blocked ||
              note ||
              "This chat is open in the Codex app on your Mac. Your message goes there, with the app's settings; approvals show on your Mac."}
          </p>
        )}
        {needsSignIn && <AgentSignIn peer={peer} agent={agent} onDone={onSignedIn} />}
        {choosingMode && (
          <div className={`as-picker ${agent}`} role="group" aria-label="Permissions">
            <div className="as-picker-row">
              {modeChoices.map((m) => (
                <button
                  key={m}
                  aria-pressed={m === modeShown}
                  onClick={() => {
                    setChoice({ ...choice, mode: m });
                    setChoosingMode(false);
                  }}
                >
                  {modeLabel(agent, m)}
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
                  field.current?.focus();
                }}
              >
                <b>/{c.name}</b>
                {c.hint && <code>{c.hint}</code>}
                <span>{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {picking && (
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
        <div className="as-field">
          {attachments.length > 0 && (
            <div className="as-attachments">
              {attachments.map((a) => (
                <span key={a.key} className={`as-thumb ${a.error ? "bad" : ""}`} title={a.error}>
                  <img src={a.url} alt="" />
                  {!a.id && !a.error && <Loader2 size={16} className="spin" />}
                  <button aria-label="Remove image" onClick={() => removeAttachment(a.key)}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={field}
            rows={1}
            value={text}
            placeholder={skin.placeholder}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              addFiles(files);
            }}
            onKeyDown={(e) => {
              // Enter sends on a computer; on a phone it's a new line, as in the apps.
              if (e.key === "Enter" && !e.shiftKey && !narrow && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {agent === "claude" && (
            <button className="as-enter" aria-label="Send" disabled={!canSend} onClick={() => void send()}>
              <CornerDownLeft size={16} />
            </button>
          )}
        </div>
        <div className="as-tools">
          <button className="as-icon" aria-label="Add images" onClick={() => picker.current?.click()}>
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
            {modeShown ? modeLabel(agent, modeShown) : "Default"}
          </button>
          <span className="as-spacer" />
          {modelLabel && (
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
          {agent === "codex" &&
            (runningHere && live.status !== "waiting" && !text.trim() ? (
              <button className="as-send stop" aria-label="Stop" disabled={stopping} onClick={() => void stop()}>
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button className="as-send" aria-label="Send" disabled={!canSend} onClick={() => void send()}>
                {sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={17} />}
              </button>
            ))}
          {agent === "claude" && runningHere && (
            <button className="as-icon" aria-label="Stop" disabled={stopping} onClick={() => void stop()}>
              <Square size={14} />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
