import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChevronsUpDown,
  ClipboardList,
  FolderOpen,
  Gauge,
  Laptop,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkle,
  X,
} from "lucide-react";
import { post, request, type Peer } from "./api";
import AgentSessionView, { ModeMenu, ModelPicker } from "./AgentSession";
import { modelDisplayName } from "./ModelSheet";
import { SessionLinkContext } from "./AgentMarkdown";
import AgentAccess from "./AgentAccess";
import OpenClawSpace from "./OpenClawSpace";
import { ClawModelControls, useClawCatalog } from "./OpenClawControls";
import ChatList, {
  ChatAppPicker,
  ChatComingSoon,
  type ChatAppChoice,
} from "./ChatList";
import StrandedMessages from "./StrandedMessages";
import { FolderPicker } from "./FolderBrowser";
import ChatSheet from "./ChatSheet";
import { BrandCourier } from "./ReachIdentity";
import { useAppNotifications } from "./Notifications";
import ChatAppPager from "./ChatAppPager";
import { NeedsYouStrip, agentNeeds } from "./NeedsYou";
import {
  useAgentLogos,
  type AgentLogos,
} from "./agent-logos";
import { useClaudeFonts } from "./agent-fonts";
import { computerWord } from "./pause";
import { rememberPlace } from "./deep-link";
import {
  CODEX_MODE_CHOICES,
  agentLabel,
  effortLabel,
  listModels,
  modeLabel,
  modesFor,
  projectName,
  resetTime,
  startSession,
  uploadImage,
  usageLink,
  useAgentSessions,
  useChatAgent,
  type AgentFeed,
  type AgentHealth,
  type AgentMode,
  type AgentModel,
  type AgentName,
  type AgentSession,
  type MacPrompt,
  installAgent,
  type InstallPlan,
} from "./agent-sessions";
import "./agent-session.css";
import "./chat-home.css";
import "./chat-workspace.css";

const AGENTS: AgentName[] = ["codex", "claude"];

// Claude Code's --permission-mode choices for a new chat; "Default" leaves
// Claude Code's own settings in charge.
// Until Claude Code's own list arrives.
const CLAUDE_MODE_CHOICES = ["manual", "acceptEdits", "plan", "auto"];

type Attachment = { key: number; url: string; id?: string; error?: string };

// A focused new-chat composer. Model and permission choices open on demand.

// The folders a new chat can start in: where your chats are, newest first,
// each project once. A Claude app worktree (<project>/.claude/worktrees/x) is
// its project; a Codex app worktree (~/.codex/worktrees/…) is left out: both
// are temporary, and a new chat landed in one by default.
export function chatFolders(sessions: { cwd?: string }[]) {
  const seen: string[] = [];
  for (const s of sessions) {
    const cwd = (s.cwd || "").replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/, "");
    if (!cwd || /[\\/]\.codex[\\/]worktrees[\\/]/.test(cwd) || seen.includes(cwd)) continue;
    seen.push(cwd);
  }
  return seen.slice(0, 12);
}
// Its name, with the folder above it when another has the same name (two
// chips both said "reach").
export function folderLabel(cwd: string, folders: string[]) {
  const name = projectName(cwd);
  if (!folders.some((f) => f !== cwd && projectName(f) === name)) return name;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

export function NewChat({
  peer,
  agent,
  sessions,
  onStarted,
  autoFocus = false,
  folder = "",
}: {
  peer: Peer;
  agent: AgentName;
  sessions: AgentSession[];
  onStarted: (s: AgentSession) => void;
  autoFocus?: boolean;
  // Where to start (a chat's menu on the list: "New chat in reach").
  folder?: string;
}) {
  const folders = useMemo(() => chatFolders(sessions), [sessions]);
  const [cwd, setCwd] = useState(folder);
  const [otherFolder, setOtherFolder] = useState(false);
  const draftKey = "reach-new-chat-draft:" + peer.id;
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

  const [images, setImages] = useState<Attachment[]>([]);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelError, setModelError] = useState("");
  const [modelReload, setModelReload] = useState(0);
  const modelDefaults = useRef(true);
  const [modes, setModes] = useState<AgentMode[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [speed, setSpeed] = useState<string | null>(null);
  const [mode, setMode] = useState(agent === "codex" ? "auto" : "default");
  const [panel, setPanel] = useState<"" | "folder" | "mode" | "model">("");
  const [busy, setBusy] = useState(false);
  // Taps in the same instant come before `busy` re-renders: one chat.
  const startingNow = useRef(false);
  const [problem, setProblem] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, []);
  useEffect(() => {
    if (!cwd && folders[0] && !otherFolder) setCwd(folders[0]);
  }, [folders[0]]);
  useEffect(() => {
    setModels([]);
    setModel(null);
    setEffort(null);
    setSpeed(null);
    setMode(agent === "codex" ? "auto" : "default");
    setPanel("");
    setModes(null);
    modelDefaults.current = true;
  }, [peer.url, peer.token, agent]);
  useEffect(() => {
    let live = true;
    setModelsLoading(true);
    setModelError("");
    listModels(peer, agent, { refresh: modelReload > 0 })
      .then(
        (r) => {
          if (!live) return;
          setModels(r.models);
          if (r.modes?.length) setModes(r.modes);
          if (!r.models.length)
            setModelError("No models were returned. Try loading them again.");
          if (!modelDefaults.current) return;
          // New chats start the way the agent's app would start them.
          if (agent === "codex" && r.mode) setMode(r.mode);
          const first = r.models.find((m) => m.isDefault) || r.models[0];
          if (first) {
            modelDefaults.current = false;
            setModel(first.id);
            setEffort(first.defaultEffort);
          }
        },
        (e) => {
          if (live) setModelError((e as Error).message);
        },
      )
      .finally(() => {
        if (live) setModelsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, agent, modelReload]);
  const current = models.find((m) => m.id === model);
  // Permission modes for the new chat, as the agent offers them now. Claude
  // Code starts in your settings' default unless you pick one.
  const modeChoices: AgentMode[] =
    agent === "codex"
      ? modes || CODEX_MODE_CHOICES
      : [
          { id: "default", label: "Default" },
          ...modesFor(
            modes ||
              CLAUDE_MODE_CHOICES.map((id) => ({
                id,
                label: modeLabel("claude", id),
              })),
            current,
          ),
        ];
  const uploading = images.some((i) => !i.id && !i.error);
  const ready =
    !busy &&
    !uploading &&
    !!cwd &&
    (text.trim().length > 0 || images.some((i) => i.id));
  const modeName =
    modeChoices.find((m) => m.id === mode)?.label || modeLabel(agent, mode);
  const ModeIcon =
    mode === "plan"
      ? ClipboardList
      : ["full-access", "bypassPermissions", "dontAsk"].includes(mode)
        ? ShieldAlert
        : ShieldCheck;
  const modelDescription = current
    ? [current.name, effortLabel(effort, agent), speed === "fast" ? "Fast" : ""]
        .filter(Boolean)
        .join(" · ")
    : model
      ? modelDisplayName(model)
      : modelsLoading
        ? "Loading models…"
        : "Choose a model";
  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name))
        continue;
      const key = ++seq.current;
      setImages((list) => [...list, { key, url: URL.createObjectURL(file) }]);
      uploadImage(peer, file, file.name || "image").then(
        (id) =>
          setImages((list) =>
            list.map((i) => (i.key === key ? { ...i, id } : i)),
          ),
        (e) =>
          setImages((list) =>
            list.map((i) =>
              i.key === key ? { ...i, error: (e as Error).message } : i,
            ),
          ),
      );
    }
  };
  const start = async () => {
    if (!ready || startingNow.current) return;
    startingNow.current = true;
    setBusy(true);
    setProblem("");
    try {
      const first = text.trim().split("\n")[0].slice(0, 80);
      const r = await startSession(peer, {
        agent,
        cwd,
        text,
        images: images.filter((i) => i.id).map((i) => i.id!),
        ...(model && !(agent === "claude" && model === "default")
          ? { model }
          : {}),
        ...(effort ? { effort } : {}),
        ...(speed ? { speed } : {}),
        ...(mode !== "default" ? { mode } : {}),
      });
      for (const i of images) URL.revokeObjectURL(i.url);
      setText("");
      setImages([]);
      try {
        sessionStorage.removeItem(draftKey);
      } catch {}
      onStarted({
        agent,
        id: r.threadId,
        title: first || "New chat",
        cwd,
        branch: "",
        origin: "reach",
        inApp: agent === "codex",
        updatedAt: Date.now(),
        createdAt: Date.now(),
        status: "running",
        preview: first,
        archived: false,
      });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      startingNow.current = false;
      setBusy(false);
    }
  };
  const choiceRow = (
    items: { id: string; label: string }[],
    chosen: string,
    choose: (id: string) => void,
    label: string,
  ) => (
    <div className={`as-picker ${agent}`} role="group" aria-label={label}>
      <div className="as-picker-row">
        {items.map((item) => (
          <button
            key={item.id}
            aria-pressed={item.id === chosen}
            onClick={() => choose(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <section
      className={`chat-new ${agent}`}
      aria-label={`New ${agentLabel(agent)} chat`}
    >
      <button
        className="chat-new-context chat-folder"
        aria-label={cwd ? `Folder: ${cwd}` : "Choose a folder"}
        title={cwd || "Choose a folder"}
        aria-expanded={panel === "folder"}
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setPanel(panel === "folder" ? "" : "folder")}
      >
        <FolderOpen size={18} />
        <span>{cwd ? folderLabel(cwd, folders) : "Choose a folder"}</span>
        <ChevronsUpDown size={14} />
      </button>
      {problem && (
        <p className="as-hint bad" role="alert">
          {problem}
        </p>
      )}
      {panel === "folder" && (
        <>
          {choiceRow(
            [
              ...folders.map((f) => ({
                id: f,
                label: folderLabel(f, folders),
              })),
              // A folder picked by browsing, until another is chosen.
              ...(cwd && !folders.includes(cwd)
                ? [{ id: cwd, label: folderLabel(cwd, folders) }]
                : []),
              { id: "\u0000other", label: "Browse…" },
            ],
            otherFolder ? "\u0000other" : cwd,
            (id) => {
              if (id === "\u0000other") setOtherFolder(!otherFolder);
              else {
                setOtherFolder(false);
                setCwd(id);
                setPanel("");
              }
            },
            "Folder",
          )}
          {otherFolder && (
            <div className={agent}>
              <FolderPicker
                peer={peer}
                onPick={(full) => {
                  setOtherFolder(false);
                  setCwd(full);
                  setPanel("");
                }}
              />
            </div>
          )}
        </>
      )}
      {/* The same menu as in a chat, in its place above the box. */}
      {panel === "mode" && (
        <ModeMenu
          agent={agent}
          choices={modeChoices}
          current={mode}
          anchor={null}
          inline
          onPick={(id) => {
            setMode(id);
            setPanel("");
          }}
          onClose={() => setPanel("")}
        />
      )}
      {panel === "model" && (
        <ModelPicker
          agent={agent}
          models={models}
          model={model}
          effort={effort}
          speed={speed}
          busy={modelsLoading || busy}
          error={modelError}
          onRetry={() => setModelReload((n) => n + 1)}
          onPick={(next, done) => {
            if (next.speed) return setSpeed(next.speed);
            if (next.model) setModel(next.model);
            setEffort(next.effort || null);
            if (done) setPanel("");
          }}
          onClose={() => setPanel("")}
        />
      )}
      <div className="as-box">
        <div className="as-field">
          {images.length > 0 && (
            <div className="as-attachments">
              {images.map((i) => (
                <span
                  key={i.key}
                  className={`as-thumb ${i.error ? "bad" : ""}`}
                  title={i.error}
                >
                  <img src={i.url} alt="" />
                  {!i.id && !i.error && <Loader2 size={16} className="spin" />}
                  <button
                    aria-label="Remove image"
                    onClick={() => {
                      URL.revokeObjectURL(i.url);
                      setImages((list) => list.filter((x) => x.key !== i.key));
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            rows={3}
            value={text}
            placeholder="What would you like to work on?"
            aria-label={`New ${agentLabel(agent)} chat`}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              addFiles(files);
            }}
          />
        </div>
        <div className="as-tools chat-new-tools">
          <button
            className="as-icon"
            aria-label="Add images"
            title="Add images"
            disabled={busy}
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
          <button
            className="as-icon as-mode-pick"
            aria-label={`Permissions: ${modeName}`}
            title={`Permissions: ${modeName}`}
            aria-expanded={panel === "mode"}
            aria-haspopup="menu"
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPanel(panel === "mode" ? "" : "mode")}
          >
            <ModeIcon size={21} />
          </button>
          <button
            className="as-icon chat-model"
            aria-label={`Model and thinking: ${modelDescription}`}
            title={`Model and thinking: ${modelDescription}`}
            aria-expanded={panel === "model"}
            data-custom={
              (!!current &&
                (!current.isDefault ||
                  effort !== current.defaultEffort ||
                  speed === "fast")) ||
              undefined
            }
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPanel(panel === "model" ? "" : "model")}
          >
            <Gauge size={21} />
          </button>
          <span className="as-spacer" />
          <button
            className={`as-send ${ready ? "ready" : ""}`}
            aria-label="Start"
            disabled={!ready}
            onClick={() => void start()}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <ArrowUp size={21} />
            )}
          </button>
        </div>
      </div>
    </section>
  );
}

// "Install on Mac": its maker's own command, shown first and run once
// confirmed, in a Reach terminal that ends with it (server/agent-install.mjs);
// then a check again finds it. Its newest output line shows while it runs.
function InstallAgent({ peer, agent, name, recheck }: { peer: Peer; agent: AgentName; name: string; recheck: () => void }) {
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [step, setStep] = useState<"" | "confirm" | "running" | "failed">("");
  const [line, setLine] = useState("");
  const [problem, setProblem] = useState("");
  const terminal = useRef("");
  const word = computerWord(peer.platform);
  useEffect(() => {
    if (step !== "running") return;
    // Only while it runs (a minute or two): its terminal's state.
    const timer = setInterval(async () => {
      try {
        const list = await request<{ id: string; status: string; exitCode?: number; preview?: string }[]>(peer, "/api/terminals");
        const t = list.find((x) => x.id === terminal.current);
        if (t?.preview) setLine(t.preview.trim().split("\n").pop() || "");
        if (t?.status === "running") return;
        // Ended, or its terminal gone (closed, or Reach restarted): checked
        // again either way, so one that did install shows as installed; never
        // left spinning.
        if (!t) setLine("");
        setStep(t?.exitCode === 0 ? "" : "failed");
        recheck();
      } catch {
        /* the next look tells */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [step]);
  const ask = async () => {
    setProblem("");
    try {
      setPlan(await installAgent(peer, agent));
      setStep("confirm");
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const run = async () => {
    setProblem("");
    try {
      const started = await installAgent(peer, agent, true);
      terminal.current = started.terminal?.id || "";
      setLine("");
      setStep("running");
    } catch (e) {
      setProblem((e as Error).message);
      setStep("");
    }
  };
  return (
    <>
      {step === "confirm" && plan ? (
        <>
          <p>Reach runs {name}'s own installer on your {word}:</p>
          <pre className="chat-setup-command">{plan.command}</pre>
          <div className="chat-setup-actions">
            <button className="primary" onClick={() => void run()}>Install</button>
            <button onClick={() => setStep("")}>Cancel</button>
          </div>
        </>
      ) : step === "running" ? (
        <p className="chat-setup-running">
          <Loader2 size={14} className="spin" /> Installing {name} on your {word}…
          {line && <code>{line}</code>}
        </p>
      ) : (
        <>
          {step === "failed" && (
            <p className="chat-setup-problem">
              The install stopped before finishing.{line ? ` ${line}` : ""}
            </p>
          )}
          <div className="chat-setup-actions">
            <button className="primary" onClick={() => void ask()}>
              {step === "failed" ? "Try again" : `Install on ${word}`}
            </button>
            <button onClick={recheck}>Check again</button>
          </div>
        </>
      )}
      {problem && <p className="chat-setup-problem">{problem}</p>}
    </>
  );
}

function AgentStatus({
  peer,
  agent,
  health,
  logos,
  recheck,
}: {
  peer: Peer;
  agent: AgentName;
  health?: AgentHealth;
  logos: AgentLogos;
  recheck: () => void;
}) {
  if (!health) return null;
  const name = agentLabel(agent);
  if (health.error)
    return <div className="chat-setup" role="status">
      <strong>Couldn’t check {name}</strong>
      <p>{health.error}</p>
      <button onClick={recheck}>Check again</button>
    </div>;
  if (!health.installed)
    return (
      <section className="chat-setup" aria-label={`Set up ${name}`}>
        <strong>Set up {name} on {peer.name}</strong>
        <p>{name} isn't installed on this {computerWord(peer.platform)}.</p>
        {agent === "claude" || agent === "codex" ? (
          <InstallAgent peer={peer} agent={agent} name={name} recheck={recheck} />
        ) : (
          <div className="chat-setup-actions">
            <a href="https://github.com/google-gemini/gemini-cli" target="_blank" rel="noopener noreferrer">Install {name}</a>
            <button onClick={recheck}>Check again</button>
          </div>
        )}
      </section>
    );
  if (!health.signedIn)
    return (
      <AgentAccess
        peer={peer}
        agent={agent}
        health={health}
        logos={logos}
        onSignedIn={recheck}
      />
    );
  if (health.usable === false)
    return (
      <div className="chat-status out-of-usage">
        <span>
          You’re out of {name} usage
          {health.resetsAt ? ` until ${resetTime(health.resetsAt, false)}` : ""}
          .
        </span>
        <a
          className="as-banner-btn primary"
          href={
            usageLink(agent, {
              detail: "usageLimitExceeded",
              text: "usage limit",
            })?.url
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          <Sparkle size={14} fill="currentColor" /> Upgrade
        </a>
      </div>
    );
  return null;
}

type Target = { agent: AgentName | "openclaw"; id: string };

export default function EverythingChat({
  peer,
  feed: shared,
  target,
  onTargetOpened,
  showOnScreen,
  onScreen,
}: {
  peer: Peer;
  feed?: AgentFeed;
  target?: Target | null;
  onTargetOpened?: () => void;
  showOnScreen?: (prompt: MacPrompt) => void;
  onScreen?: () => void;
}) {
  const own = useAgentSessions(shared ? null : peer);
  const { sessions, errors, health, failure, reload, recheck } = shared || own;
  const macPrompts = (shared || own).macPrompts || [];
  const notificationCounts = useAppNotifications(peer);
  const logos = useAgentLogos(peer);
  const [savedAgent, setAgent] = useChatAgent();
  const apps = useMemo<ChatAppChoice[]>(() => {
    const list = AGENTS.map((agent) => ({
      agent: agent as string,
      name: agentLabel(agent),
      supported: true,
    }));
    for (const item of health) {
      if (item.installed && !list.some((a) => a.agent === item.agent))
        list.push({
          agent: item.agent,
          name: item.name || item.agent,
          // OpenClaw has its own space; others as the Mac says (Gemini CLI's
          // chats are read here).
          supported: item.agent === "openclaw" || !!item.supported,
        });
    }
    return list;
  }, [health]);
  const picked = apps.find((app) => app.agent === savedAgent) || apps[0];
  useEffect(() => {
    if (health.length && !apps.some((app) => app.agent === savedAgent)) setAgent("codex");
  }, [health, apps, savedAgent]);
  const current: AgentName = picked.agent === "claude" || picked.agent === "gemini" ? picked.agent : "codex";
  const [open, setOpen] = useState<AgentSession | null>(null);
  const [sheet, setSheet] = useState<"" | "new" | "review">("");
  // A new chat's folder, when one was asked for (a chat's menu on the list).
  const [newFolder, setNewFolder] = useState("");
  // An OpenClaw chat to open in its own space (one a chat just moved to).
  const [clawOpen, setClawOpen] = useState<string | null>(null);
  useClaudeFonts(peer, current === "claude" || open?.agent === "claude");
  const openChat = (s: AgentSession) => {
    if ((s.agent as string) === "openclaw") {
      setAgent("openclaw");
      setSheet("");
      setOpen(null);
      setClawOpen(s.id);
      return;
    }
    setAgent(s.agent);
    setSheet("");
    setOpen(s);
  };
  useEffect(() => {
    if (!target) return;
    if (target.agent === "openclaw") {
      setAgent("openclaw"); setSheet(""); setOpen(null); setClawOpen(target.id);
      onTargetOpened?.(); return;
    }
    const found = sessions?.find(
      (s) => s.agent === target.agent && s.id === target.id,
    );
    openChat(
      found || {
        agent: target.agent,
        id: target.id,
        title: "Session",
        cwd: "",
        branch: "",
        origin: "reach",
        inApp: target.agent === "codex",
        updatedAt: Date.now(),
        createdAt: Date.now(),
        status: "idle",
        preview: "",
        archived: false,
      },
    );
    onTargetOpened?.();
  }, [target?.agent, target?.id]);
  // The chat open now, so a reload comes back to it (src/deep-link.ts).
  useEffect(() => {
    rememberPlace(peer.id, { chat: open ? { agent: open.agent, id: open.id } : null });
  }, [peer.id, open?.agent, open?.id]);
  const allNeeds = agentNeeds({
    peer,
    sessions: (sessions || []).filter((s) => !s.archived),
    macPrompts,
    logos,
    open: openChat,
    answered: reload,
    showOnScreen,
  }).map((item) => {
    const session = (sessions || []).find((s) =>
      item.key.startsWith(s.agent + ":" + s.id + ":"),
    );
    const prompt = session?.prompts?.find(
      (p) => item.key === session.agent + ":" + session.id + ":" + p.id,
    );
    if (!prompt) return item;
    return {
      ...item,
      detail: [
        session?.title,
        prompt.command,
        prompt.cwd,
        prompt.reason,
        prompt.files?.join(", "),
        prompt.message,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
  const needs = allNeeds.filter(
    (item) =>
      item.key.startsWith(picked.agent + ":") ||
      (picked.supported && item.key.startsWith("mac:")),
  );
  const appPending = Object.fromEntries(
    apps.map((app) => [
      app.agent,
      // Both feeds describe the same requests. Keep live session updates
      // immediate without counting the inbox's copy a second time.
      Math.max(notificationCounts[app.agent] || 0,
        allNeeds.filter((item) => item.key.startsWith(app.agent + ":")).length),
    ]),
  );
  const status = health.find((h) => h.agent === current);
  const reviewNeeds = open ? allNeeds.filter((item) => item.key.startsWith("mac:")) : needs;
  const library = (app: ChatAppChoice, active: boolean) => {
    if (app.agent === "openclaw")
      return <OpenClawSpace peer={peer} apps={apps} logos={logos}
        onScreen={onScreen}
        openKey={active ? clawOpen : null} onOpened={() => setClawOpen(null)} health={health} onOpenChat={openChat}
        onAppChange={setAgent} appPending={appPending} onDiscover={recheck}
        deviceRequests={macPrompts.length} onReviewDevice={() => setSheet("review")}
        onNew={() => { setNewFolder(""); setSheet("new"); }} />;
    const agent: AgentName = app.agent === "claude" || app.agent === "gemini" ? app.agent : "codex";
    const appHealth = health.find(h => h.agent === agent);
    const needsSetup = app.supported && !!appHealth && (!appHealth.installed || !appHealth.signedIn || !!appHealth.error);
    const pending = allNeeds.filter(item => item.key.startsWith(app.agent + ":") || (app.supported && item.key.startsWith("mac:"))).length;
    return (
      <div className="chat-workspace">
        {active && <StrandedMessages peer={peer} sessions={sessions} logos={logos} onChanged={() => void reload()} />}
        <ChatList peer={peer} sessions={sessions} logos={logos} apps={apps}
          agent={app.agent} onAgentChange={setAgent} appPending={appPending}
          onRefresh={() => { recheck(); void reload(); }} health={health}
          onSectionMoved={() => void reload()} onArchived={() => void reload()}
          canStart={!needsSetup && app.agent !== "gemini"}
          setup={needsSetup ? <AgentStatus peer={peer} agent={agent} health={appHealth} logos={logos} recheck={recheck} /> : undefined}
          errors={errors[app.agent] ? { [app.agent]: errors[app.agent] } : {}}
          failure={failure} onOpen={openChat}
          onNew={(cwd) => { setNewFolder(cwd || ""); setSheet("new"); }}
          pending={pending} onReview={() => setSheet("review")} />
      </div>
    );
  };
  return (
    <>
      {open ? (
        <SessionLinkContext.Provider
          // A message's link to another Claude session ("[title](#local_…)",
          // as the Claude app writes them) opens that session here.
          value={(appSessionId) => {
            const linked = (sessions || []).find(
              (s) => s.appSessionId?.toLowerCase() === appSessionId.toLowerCase(),
            );
            if (!linked) return false;
            if (linked.id !== open.id || linked.agent !== open.agent) openChat(linked);
            return true;
          }}
        >
          <AgentSessionView
            key={peer.id + ":" + open.agent + ":" + open.id}
            peer={peer}
            session={open}
            siblings={(sessions || []).filter(
              (s) => !s.archived && s.agent === open.agent,
            )}
            health={health}
            logos={logos}
            deviceRequests={macPrompts.length}
            onReviewDevice={() => setSheet("review")}
            onScreen={onScreen}
            onSignedIn={recheck}
            onSelect={openChat}
            onBack={() => {
              setOpen(null);
              void reload();
            }}
            onNew={() => {
              setAgent(open.agent);
              setNewFolder("");
              setSheet("new");
            }}
          />
        </SessionLinkContext.Provider>
      ) : (
        <ChatAppPager key={peer.id} apps={apps} value={picked.agent} onChange={setAgent} hidden={!!sheet}>
          {library}
        </ChatAppPager>
      )}
      {sheet === "new" && (
        <ChatSheet title="New conversation" className="chat-create-sheet" leading={<BrandCourier active />} onClose={() => setSheet("")}>
          <div className="chat-new-app-row">
            <ChatAppPicker
              apps={apps}
              value={picked.agent}
              onChange={setAgent}
              logos={logos}
              pending={appPending}
            />
          </div>
          <div className="chat-new-computer" title={peer.name}>
            <Laptop size={16} />
            <span>{peer.name}</span>
          </div>
          {picked.agent === "openclaw" ? (
            // A chat of Reach's own (webchat): replies stay in Reach and OpenClaw.
            <NewClawChat
              key={JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId])}
              peer={peer}
              onStarted={(key) => {
                setAgent("openclaw");
                setSheet("");
                setOpen(null);
                setClawOpen(key);
              }}
            />
          ) : !picked.supported ? (
            <ChatComingSoon app={picked} logos={logos} />
          ) : picked.agent === "gemini" ? (
            // Its chats are read here; it no longer answers personal accounts,
            // and a new one was refused only after Start.
            <ChatComingSoon
              app={picked}
              logos={logos}
              label="Read only"
              text={`Reach shows your ${picked.name} chats. To start a new one, pick another app above.`}
            />
          ) : (
            <>
              <AgentStatus
                peer={peer}
                agent={current}
                health={status}
                logos={logos}
                recheck={recheck}
              />
              {(!status || (status.installed && status.signedIn && !status.error)) && (
                <NewChat
                  key={newFolder}
                  folder={newFolder}
                  peer={peer}
                  agent={current}
                  sessions={sessions || []}
                  onStarted={openChat}
                  autoFocus
                />
              )}
            </>
          )}
        </ChatSheet>
      )}
      {sheet === "review" && (
        <ChatSheet title="Needs you" onClose={() => setSheet("")}>
          {reviewNeeds.length ? (
            <>
              <p className="chat-sheet-intro">
                Review one request at a time, with its context.
              </p>
              <NeedsYouStrip items={reviewNeeds} />
            </>
          ) : (
            <p className="chat-sheet-intro">You’re all caught up.</p>
          )}
        </ChatSheet>
      )}
    </>
  );
}

// A new OpenClaw chat from Reach: a session of its own (never one of WhatsApp's
// or Discord's), its first message sent as it starts (server/openclaw.mjs).
function NewClawChat({
  peer,
  onStarted,
}: {
  peer: Peer;
  onStarted: (key: string) => void;
}) {
  const { catalog, error: catalogError } = useClawCatalog(peer);
  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const startingNow = useRef(false);
  const modelDescription = [
    catalog?.models.find((m) => m.id === model)?.name ||
      model ||
      "Agent default",
    thinking ? `Thinking: ${thinking}` : "Default thinking",
  ].join(" · ");
  // Asked again (a dropped answer), the same message starts the same chat.
  const attempt = useRef<{
    intent: string;
    body: { text: string; requestId: string; agentId?: string; model?: string; thinkingLevel?: string };
  } | null>(null);
  const start = async () => {
    if (!text.trim() || busy || startingNow.current) return;
    startingNow.current = true;
    // Discovery may finish after an uncertain send. Only a changed user
    // choice creates a new attempt; retries retain the exact original body.
    const intent = JSON.stringify([text, agentId, model, thinking]);
    if (attempt.current?.intent !== intent) {
      attempt.current = {
        intent,
        body: {
          text,
          requestId: crypto.randomUUID(),
          ...(agentId || catalog?.agents?.length ? { agentId: agentId || catalog?.defaultAgentId } : {}),
          ...(model ? { model } : {}),
          ...(thinking ? { thinkingLevel: thinking } : {}),
        },
      };
    }
    setBusy(true);
    setProblem("");
    try {
      const { key } = await post<{ key: string }>(
        peer,
        "/api/sessions/openclaw/new",
        attempt.current.body,
      );
      // Closing or switching apps does not cancel the dispatched task, but
      // its old reply must not navigate the replacement view.
      if (active.current) onStarted(key);
    } catch (e) {
      if (!active.current) return;
      startingNow.current = false;
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <form
      className="chat-new-claw"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      {catalog?.agents?.length ? (
        <label className="chat-new-context claw-new-agent">
          <Bot size={18} />
          <select
            aria-label="OpenClaw agent"
            disabled={busy}
            value={agentId || catalog.defaultAgentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {catalog.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <ChevronsUpDown size={14} />
        </label>
      ) : null}
      {optionsOpen && (
        <div className="chat-new-settings">
          <div className="chat-new-settings-heading">
            <span>Model & thinking</span>
            <button
              type="button"
              className="as-icon"
              aria-label="Close model and thinking"
              onClick={() => setOptionsOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          {catalog ? (
            <ClawModelControls
              peer={peer}
              catalog={catalog}
              model={model}
              thinking={thinking}
              disabled={busy}
              onModel={setModel}
              onThinking={setThinking}
            />
          ) : (
            <p className="claw-note">{catalogError || "Loading models…"}</p>
          )}
          {catalog?.errors?.map((message) => (
            <p className="claw-note" key={message}>
              {message}
            </p>
          ))}
        </div>
      )}
      <div className="as-box">
        <div className="as-field">
          <textarea
            aria-label="New OpenClaw chat"
            placeholder="What would you like OpenClaw to do?"
            rows={3}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="as-tools chat-new-tools">
          <button
            type="button"
            className="as-icon chat-model"
            aria-label="Model & thinking"
            aria-description={modelDescription}
            title={`Model & thinking: ${modelDescription}`}
            aria-expanded={optionsOpen}
            data-custom={!!(model || thinking) || undefined}
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOptionsOpen(!optionsOpen)}
          >
            <Gauge size={21} />
          </button>
          <span className="as-spacer" />
          <button
            className={`as-send ${text.trim() && !busy ? "ready" : ""}`}
            aria-label="Start"
            disabled={!text.trim() || busy}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <ArrowUp size={21} />
            )}
          </button>
        </div>
      </div>
      <small className="claw-note">Replies stay in Reach and OpenClaw.</small>
      {problem && (
        <p className="chat-sheet-intro" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
