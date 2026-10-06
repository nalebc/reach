import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  FolderOpen,
  Loader2,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  X,
} from "lucide-react";
import { post, request, type Peer } from "./api";
import AgentSessionView, { ModelPicker } from "./AgentSession";
import AgentAccess from "./AgentAccess";
import OpenClawSpace from "./OpenClawSpace";
import ChatList, {
  ChatAppPicker,
  ChatComingSoon,
  type ChatAppChoice,
} from "./ChatList";
import StrandedMessages from "./StrandedMessages";
import { FolderPicker } from "./FolderBrowser";
import ChatSheet from "./ChatSheet";
import { NeedsYouStrip, agentNeeds } from "./NeedsYou";
import {
  AgentLogo,
  ClaudeSpark,
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
}: {
  peer: Peer;
  agent: AgentName;
  sessions: AgentSession[];
  onStarted: (s: AgentSession) => void;
  autoFocus?: boolean;
}) {
  const folders = useMemo(() => chatFolders(sessions), [sessions]);
  const [cwd, setCwd] = useState("");
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
  const [modes, setModes] = useState<AgentMode[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [mode, setMode] = useState(agent === "codex" ? "auto" : "default");
  const [settings, setSettings] = useState(false);
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
    setMode(agent === "codex" ? "auto" : "default");
    setPanel("");
    setModes(null);
    let live = true;
    listModels(peer, agent).then(
      (r) => {
        if (!live) return;
        setModels(r.models);
        if (r.modes?.length) setModes(r.modes);
        // New chats start the way the agent's app would start them.
        if (agent === "codex" && r.mode) setMode(r.mode);
        const first = r.models.find((m) => m.isDefault) || r.models[0];
        if (first) {
          setModel(first.id);
          setEffort(first.defaultEffort);
        }
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, agent]);
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
  const open = true;
  const modeName =
    modeChoices.find((m) => m.id === mode)?.label || modeLabel(agent, mode);
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
      className={`chat-new ${open ? "open" : ""}`}
      aria-label={`New ${agentLabel(agent)} chat`}
    >
      {problem && <p className="as-hint bad">{problem}</p>}
      {panel === "folder" && (
        <>
          {choiceRow(
            [
              ...folders.map((f) => ({ id: f, label: folderLabel(f, folders) })),
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
      {panel === "mode" &&
        choiceRow(
          modeChoices.map((m) => ({ id: m.id, label: m.label })),
          mode,
          (id) => {
            setMode(id);
            setPanel("");
          },
          agent === "codex"
            ? "How should Codex actions be approved?"
            : "Permissions",
        )}
      {panel === "model" && (
        <ModelPicker
          agent={agent}
          models={models}
          model={model}
          effort={effort}
          onPick={(next, done) => {
            if (next.model) setModel(next.model);
            setEffort(next.effort || null);
            if (done) setPanel("");
          }}
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
            rows={open ? 3 : 1}
            value={text}
            placeholder="What would you like to work on?"
            aria-label={`New ${agentLabel(agent)} chat`}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              addFiles(files);
            }}
          />
          {!open && cwd && (
            <span className="chat-new-where" aria-hidden="true">
              in {folderLabel(cwd, folders)}
            </span>
          )}
        </div>
        {open && (
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
            <button
              className="as-model chat-folder"
              aria-label={cwd ? `Folder: ${cwd}` : "Choose a folder"}
              aria-expanded={panel === "folder"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPanel(panel === "folder" ? "" : "folder")}
            >
              <FolderOpen size={14} />
              <span>{cwd ? folderLabel(cwd, folders) : "Folder"}</span>
            </button>
            {settings && (
              <button
                className="as-model as-mode-pick"
                aria-expanded={panel === "mode"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPanel(panel === "mode" ? "" : "mode")}
              >
                {agent === "codex" && <ShieldCheck size={14} />}
                <span>{modeName}</span>
              </button>
            )}
            <span className="as-spacer" />
            {settings && current && (
              <button
                className="as-model chat-model"
                aria-expanded={panel === "model"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPanel(panel === "model" ? "" : "model")}
              >
                {current.name} <span>{effortLabel(effort, agent)}</span>
                <ChevronDown size={14} />
              </button>
            )}
            <button
              className="as-icon"
              aria-label="Chat settings"
              aria-expanded={settings}
              onClick={() => {
                setSettings(!settings);
                setPanel("");
              }}
            >
              <SlidersHorizontal size={18} />
            </button>
            <button
              className={`as-send ${ready ? "ready" : ""}`}
              aria-label="Start"
              disabled={!ready}
              onClick={() => void start()}
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// The Claude app greets by the moment: a new week on Monday morning,
// otherwise the time of day.
export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (now.getDay() === 1 && hour >= 5 && hour < 12) return "New week";
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
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
      allNeeds.filter((item) => item.key.startsWith(app.agent + ":")).length,
    ]),
  );
  const status = health.find((h) => h.agent === current);
  const needsSetup = picked.supported && picked.agent !== "openclaw" && !!status && (!status.installed || !status.signedIn || !!status.error);

  const reviewNeeds = open ? allNeeds.filter((item) => item.key.startsWith("mac:")) : needs;
  return (
    <>
      {open ? (
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
            setSheet("new");
          }}
        />
      ) : picked.agent === "openclaw" ? (
        <OpenClawSpace key={peer.id} peer={peer} apps={apps} logos={logos}
          onScreen={onScreen}
          openKey={clawOpen} onOpened={() => setClawOpen(null)} health={health} onOpenChat={openChat}
          onAppChange={setAgent} appPending={appPending} onDiscover={recheck}
          deviceRequests={macPrompts.length} onReviewDevice={() => setSheet("review")}
          onNew={() => setSheet("new")} />
      ) : (
        <div className="chat-workspace" aria-hidden={!!sheet || undefined}>
          {/* Messages whose chat was deleted, to send elsewhere or delete. */}
          <StrandedMessages peer={peer} sessions={sessions} logos={logos} onChanged={() => void reload()} />
          <ChatList
            key={peer.id}
            peer={peer}
            sessions={sessions}
            logos={logos}
            apps={apps}
            agent={picked.agent}
            onAgentChange={setAgent}
            appPending={appPending}
            onRefresh={() => { recheck(); void reload(); }}
            // Gemini CLI chats are read here (it no longer answers personal accounts): no new ones.
            canStart={!needsSetup && picked.agent !== "gemini"}
            setup={needsSetup ? <AgentStatus peer={peer} agent={current} health={status} logos={logos} recheck={recheck} /> : undefined}
            errors={
              errors[picked.agent]
                ? { [picked.agent]: errors[picked.agent] }
                : {}
            }
            failure={failure}
            onOpen={openChat}
            onNew={() => setSheet("new")}
            pending={needs.length}
            onReview={() => setSheet("review")}
          />
        </div>
      )}
      {sheet === "new" && (
        <ChatSheet title="New conversation" onClose={() => setSheet("")}>
          <div className="chat-new-app-row">
            <ChatAppPicker
              apps={apps}
              value={picked.agent}
              onChange={setAgent}
              logos={logos}
            />
          </div>
          {picked.agent === "openclaw" ? (
            // A chat of Reach's own (webchat): replies stay in Reach and OpenClaw.
            <NewClawChat
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
                  peer={peer}
                  agent={current}
                  sessions={sessions || []}
                  onStarted={openChat}
                  autoFocus
                />
              )}
              <p className="chat-sheet-footnote">On {peer.name}</p>
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
function NewClawChat({ peer, onStarted }: { peer: Peer; onStarted: (key: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const startingNow = useRef(false);
  const start = async () => {
    if (!text.trim() || busy || startingNow.current) return;
    startingNow.current = true;
    setBusy(true);
    setProblem("");
    try {
      const { key } = await post<{ key: string }>(peer, "/api/sessions/openclaw/new", { text });
      onStarted(key);
    } catch (e) {
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
      <textarea
        aria-label="New OpenClaw chat"
        placeholder="What would you like OpenClaw to do?"
        rows={3}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <div className="chat-new-claw-tools">
        <small>Replies stay in Reach and OpenClaw.</small>
        <button className="as-send ready" aria-label="Start" disabled={!text.trim() || busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={18} />}
        </button>
      </div>
      {problem && (
        <p className="chat-sheet-intro" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
