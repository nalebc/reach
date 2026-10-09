import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChevronsUpDown,
  ClipboardList,
  FolderOpen,
  Gauge,
  Laptop,
  Bell,
  BellRing,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkle,
  X,
} from "lucide-react";
import { useNotifyBack } from "./notify-back";
import { post, type Peer } from "./api";
import AgentSessionView, { ModeMenu, ModelPicker } from "./AgentSession";
import { modelDisplayName } from "./ModelSheet";
import { SessionLinkContext } from "./AgentMarkdown";
import AgentAccess from "./AgentAccess";
import AgentUpdate, { useTerminalRun } from "./AgentUpdate";
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
import ChatHub from "./ChatHub";
import type { FleetConnections } from "./useFleetConnections";
import { relayAgents } from "./Relays";
import { TeamPicker } from "./Teams";
import { WorkflowIntro, WorkflowSheet, WorkflowsPage, planWorkflow, type Workflow } from "./Workflows";
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
  startTeam,
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
// A new chat starts on each app's auto mode (Oct 8): Claude's Auto, Codex's
// "Approve for me". Claude falls back to Default on a model without Auto,
// Codex to its app's own mode when Approve for me is switched off.
const autoMode = (agent: AgentName) => (agent === "codex" ? "guardian-approvals" : "auto");
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
  health = [],
  logos = {},
  onAgent,
  onWorkflow,
  startAs = "",
}: {
  peer: Peer;
  agent: AgentName;
  sessions: AgentSession[];
  onStarted: (s: AgentSession) => void;
  autoFocus?: boolean;
  // Where to start (a chat's menu on the list: "New chat in reach").
  folder?: string;
  // For a team (Teams.tsx): the agents here, their logos, and switching the lead.
  health?: AgentHealth[];
  logos?: AgentLogos;
  onAgent?: (agent: AgentName) => void;
  // A workflow planned from here (Workflows.tsx), and opening on that choice.
  onWorkflow?: (workflow: Workflow) => void;
  startAs?: "" | "workflow";
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
  const [mode, setMode] = useState(autoMode(agent));
  const [panel, setPanel] = useState<"" | "folder" | "mode" | "model">("");
  // A team (docs/ACROSS_AGENTS.md): this agent leads, helpers take tasks.
  const teamAgents = relayAgents(health, { openclaw: false });
  const canTeam = (agent === "codex" || agent === "claude") && teamAgents.length > 0;
  const [teamMode, setTeamMode] = useState(false);
  const [helpers, setHelpers] = useState<string[]>([]);
  useEffect(() => {
    if (helpers.length || !teamAgents.length) return;
    setHelpers([teamAgents.find((a) => a !== agent) || teamAgents[0]]);
  }, [teamAgents.join(), agent]);
  const team = teamMode && canTeam;
  // A workflow (docs/WORKFLOWS.md): this agent plans it, reading only.
  const canFlow = (agent === "codex" || agent === "claude") && !!onWorkflow;
  const [flowMode, setFlowMode] = useState(startAs === "workflow");
  const flow = flowMode && canFlow && !team;
  const [busy, setBusy] = useState(false);
  // Taps in the same instant come before `busy` re-renders: one chat.
  const startingNow = useRef(false);
  const [problem, setProblem] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  // Closed while a start was on its way: its answer must not clear a newer
  // draft or open the chat over whatever is shown now.
  const mounted = useRef(true);
  const shownImages = useRef(images);
  shownImages.current = images;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const i of shownImages.current) URL.revokeObjectURL(i.url);
    };
  }, []);
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
    setMode(autoMode(agent));
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
          if (agent === "codex")
            setMode(
              !r.modes?.length || r.modes.some((m) => m.id === "guardian-approvals")
                ? "guardian-approvals"
                : r.mode || "auto",
            );
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
  useEffect(() => {
    if (agent === "claude" && mode === "auto" && current?.autoMode === false) setMode("default");
  }, [agent, mode, current?.id]);
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
  // Sent: its saved draft goes, unless a newer draft has replaced it.
  const clearSent = (sent: string) => {
    try {
      if (sessionStorage.getItem(draftKey) === sent) sessionStorage.removeItem(draftKey);
    } catch {}
  };
  const start = async () => {
    if (!ready || startingNow.current) return;
    startingNow.current = true;
    setBusy(true);
    setProblem("");
    try {
      const first = text.trim().split("\n")[0].slice(0, 80);
      const body = {
        cwd,
        text,
        images: images.filter((i) => i.id).map((i) => i.id!),
        ...(model && !(agent === "claude" && model === "default")
          ? { model }
          : {}),
        ...(effort ? { effort } : {}),
        ...(speed ? { speed } : {}),
        ...(mode !== "default" ? { mode } : {}),
      };
      if (flow) {
        // The planner reads only: no permission mode goes with it.
        const planned = await planWorkflow(peer, {
          agent,
          cwd,
          text,
          images: body.images,
          ...(body.model ? { model: body.model } : {}),
          ...(effort ? { effort } : {}),
          ...(speed ? { speed } : {}),
        });
        clearSent(text);
        if (!mounted.current) return;
        for (const i of images) URL.revokeObjectURL(i.url);
        setText("");
        setImages([]);
        onWorkflow?.(planned.workflow);
        return;
      }
      const r = team
        ? await startTeam(peer, { ...body, lead: agent, helpers })
        : await startSession(peer, { ...body, agent });
      clearSent(text);
      if (!mounted.current) return;
      for (const i of images) URL.revokeObjectURL(i.url);
      setText("");
      setImages([]);
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
      if (mounted.current) setProblem((e as Error).message);
    } finally {
      startingNow.current = false;
      if (mounted.current) setBusy(false);
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
      {(canTeam || canFlow) && (
        <div className="team-mode" role="group" aria-label="Solo or team">
          <button aria-pressed={!team && !flow} disabled={busy} onClick={() => (setTeamMode(false), setFlowMode(false))}>
            Solo
          </button>
          {canTeam && (
            <button aria-pressed={team} disabled={busy} onClick={() => (setTeamMode(true), setFlowMode(false))}>
              Team
            </button>
          )}
          {canFlow && (
            <button aria-pressed={flow} disabled={busy} onClick={() => (setFlowMode(true), setTeamMode(false))}>
              Workflow
            </button>
          )}
        </div>
      )}
      {flow && <WorkflowIntro peer={peer} agent={agent} cwd={cwd} title={text} disabled={busy} onCreated={(w) => onWorkflow?.(w)} />}
      {team && (
        <TeamPicker
          lead={agent}
          helpers={helpers}
          available={teamAgents}
          logos={logos}
          onLead={(next) => onAgent?.(next as AgentName)}
          onHelpers={setHelpers}
        />
      )}
      <div className="chat-new-folder-controls">
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
        <button
          type="button"
          className="chat-folder-browse"
          aria-expanded={panel === "folder" && otherFolder}
          disabled={busy}
          onClick={() => {
            // Wait for a folder tap instead of reusing the previous selection.
            setCwd("");
            setOtherFolder(true);
            setPanel("folder");
          }}
        >
          Browse folders…
        </button>
      </div>
      {otherFolder && !cwd && (
        <p className="as-hint">Tap a folder to choose where this chat works.</p>
      )}
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
            ],
            cwd,
            (id) => {
              setOtherFolder(false);
              setCwd(id);
              setPanel("");
            },
            "Folder",
          )}
          {otherFolder && (
            <div className={agent}>
              <FolderPicker
                peer={peer}
                onNavigate={setCwd}
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
            placeholder={flow ? "Describe the work to plan" : team ? "What should the team do?" : "What would you like to work on?"}
            aria-label={flow ? `Workflow planned by ${agentLabel(agent)}` : team ? `New team led by ${agentLabel(agent)}` : `New ${agentLabel(agent)} chat`}
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
          {!flow && <button
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
          </button>}
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
            aria-label={flow ? "Plan workflow" : team ? "Start team" : "Start"}
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
  const [problem, setProblem] = useState("");
  const terminal = useRef("");
  const word = computerWord(peer.platform);
  // Ended, or its terminal gone: checked again either way, so one that did
  // install shows as installed.
  const line = useTerminalRun(peer, step === "running" ? terminal.current : null, (ok) => {
    setStep(ok ? "" : "failed");
    recheck();
  });
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
  if (health.usable === false) return <OutOfUsage peer={peer} agent={agent} name={name} health={health} />;
  return null;
}

// Out of usage: one quiet line, Notify me (when it's back) and Upgrade.
function OutOfUsage({ peer, agent, name, health }: { peer: Peer; agent: AgentName; name: string; health: AgentHealth }) {
  const back = useNotifyBack(peer, agent, undefined, !!health.notifyWhenBack);
  return (
      <div className="chat-status out-of-usage">
        <span>
          {back.problem || <>
          You’re out of {name} usage
          {health.resetsAt ? ` until ${resetTime(health.resetsAt, false)}` : ""}
          .</>}
        </span>
        <button
          className={`as-banner-btn usage-notify${back.on ? " on" : ""}`}
          aria-pressed={back.on}
          aria-label={back.on ? "Notifying when it’s back. Tap to stop." : "Notify me when it’s back"}
          disabled={back.busy}
          onClick={() => void back.toggle()}
        >
          {back.busy ? <Loader2 size={14} className="spin" /> : back.on ? <BellRing size={14} /> : <Bell size={14} />}
          {back.on ? "Notifying" : "Notify me"}
        </button>
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
}

type Target = { agent: AgentName | "openclaw"; id: string };

export default function EverythingChat({
  peer,
  feed: shared,
  target,
  onTargetOpened,
  showOnScreen,
  onScreen,
  computers,
  connections,
  onOpenOn,
}: {
  peer: Peer;
  feed?: AgentFeed;
  target?: Target | null;
  onTargetOpened?: () => void;
  showOnScreen?: (prompt: MacPrompt) => void;
  onScreen?: () => void;
  // The All page covers every paired computer (ChatHub.tsx); a chat on
  // another one opens there.
  computers?: Peer[];
  connections?: FleetConnections;
  onOpenOn?: (computer: Peer, chat: { agent: string; id: string; title?: string }) => void;
}) {
  const own = useAgentSessions(shared ? null : peer);
  const { sessions, errors, health, failure, reload, recheck } = shared || own;
  // Relays and teams on this computer (Relays.tsx, Teams.tsx), with the chat list.
  const relays = (shared || own).relays || [];
  const teams = (shared || own).teams || [];
  const workflows = (shared || own).workflows || [];
  const flowEntry = {
    active: workflows.filter((w) => w.state === "running" || w.state === "paused").length,
    paused: workflows.filter((w) => w.state === "paused").length,
    onOpen: () => setFlowsOpen(true),
  };
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
    // With more than one agent here: every agent's chats together, first
    // (ChatHub.tsx, docs/ACROSS_AGENTS.md).
    const here = list.filter((a) => a.supported && health.some((h) => h.agent === a.agent && h.installed));
    if (here.length > 1) list.unshift({ agent: "all", name: "All", supported: true });
    return list;
  }, [health]);
  // The apps a new chat can be started in (not All).
  const startApps = apps.filter((app) => app.agent !== "all");
  const picked = apps.find((app) => app.agent === savedAgent) || apps[0];
  // The app a new chat starts in: the one shown, or from All, the first.
  const newApp = picked.agent === "all" ? apps.find((app) => app.agent !== "all") || picked : picked;
  useEffect(() => {
    // The app last picked isn't here (anymore): All when there is one.
    if (health.length && !apps.some((app) => app.agent === savedAgent)) setAgent(apps.some((app) => app.agent === "all") ? "all" : "codex");
  }, [health, apps, savedAgent]);
  const current: AgentName = picked.agent === "claude" || picked.agent === "gemini" ? picked.agent : "codex";
  const [open, setOpen] = useState<AgentSession | null>(null);
  const [sheet, setSheet] = useState<"" | "new" | "review">("");
  // A new chat's folder, when one was asked for (a chat's menu on the list).
  const [newFolder, setNewFolder] = useState("");
  // An OpenClaw chat to open in its own space (one a chat just moved to).
  const [clawOpen, setClawOpen] = useState<string | null>(null);
  // Workflows (Workflows.tsx): their page, one workflow's page (back to the
  // list when opened from it), and New chat opening on Workflow.
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [flow, setFlow] = useState<{ id: string; first: Workflow | null; back?: boolean } | null>(null);
  const [newKind, setNewKind] = useState<"" | "workflow">("");
  // Closed (a chat started, another sheet): the next New chat starts as usual.
  useEffect(() => {
    if (sheet !== "new") setNewKind("");
  }, [sheet]);
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
      picked.agent === "all" ||
      item.key.startsWith(picked.agent + ":") ||
      (picked.supported && item.key.startsWith("mac:")),
  );
  const appPending = Object.fromEntries(
    apps.map((app) => [
      app.agent,
      // Both feeds describe the same requests. Keep live session updates
      // immediate without counting the inbox's copy a second time.
      app.agent === "all"
        ? allNeeds.length
        : Math.max(notificationCounts[app.agent] || 0,
            allNeeds.filter((item) => item.key.startsWith(app.agent + ":")).length),
    ]),
  );
  const status = health.find((h) => h.agent === current);
  const reviewNeeds = open ? allNeeds.filter((item) => item.key.startsWith("mac:")) : needs;
  // A chat the All page points at, as the list has it (or enough to open it).
  const openRef = (ref: { agent: string; id: string; title?: string }) =>
    openChat(
      (sessions || []).find((s) => s.agent === ref.agent && s.id === ref.id) ||
        ({
          agent: ref.agent as AgentName,
          id: ref.id,
          title: ref.title || "",
          cwd: "",
          branch: "",
          origin: "reach",
          inApp: ref.agent === "codex",
          updatedAt: Date.now(),
          createdAt: Date.now(),
          status: "idle",
          preview: "",
          archived: false,
        } as AgentSession),
    );
  const library = (app: ChatAppChoice, active: boolean) => {
    if (app.agent === "all")
      return (
        <div className="chat-workspace">
          {active && <StrandedMessages peer={peer} sessions={sessions} logos={logos} onChanged={() => void reload()} />}
          <ChatHub
            peer={peer}
            computers={computers}
            connections={connections}
            onOpenOn={onOpenOn}
            sessions={sessions}
            relays={relays}
            teams={teams}
            logos={logos}
            apps={apps}
            appPending={appPending}
            pending={allNeeds.length}
            onAgentChange={setAgent}
            onOpen={openRef}
            onNew={() => {
              setNewFolder("");
              setSheet("new");
            }}
            onRefresh={() => {
              recheck();
              void reload();
            }}
            onReview={() => setSheet("review")}
            onRelaysChanged={() => void reload()}
            workflows={flowEntry}
            health={health}
          />
        </div>
      );
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
          notice={app.supported && appHealth?.installed && !needsSetup ? <AgentUpdate peer={peer} agent={agent} /> : undefined}
          workflows={flowEntry}
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
            relays={relays}
            teams={teams}
            everyone={sessions || []}
            onRelaysChanged={() => void reload()}
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
        <ChatSheet title="New conversation" className="chat-create-sheet" leading={<BrandCourier active />} onClose={() => (setSheet(""), setNewKind(""))}>
          <div className="chat-new-app-row">
            <ChatAppPicker
              apps={startApps}
              value={newApp.agent}
              onChange={setAgent}
              logos={logos}
              pending={appPending}
              health={health}
            />
          </div>
          <div className="chat-new-computer" title={peer.name}>
            <Laptop size={16} />
            <span>{peer.name}</span>
          </div>
          {newApp.agent === "openclaw" ? (
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
          ) : !newApp.supported ? (
            <ChatComingSoon app={newApp} logos={logos} />
          ) : newApp.agent === "gemini" ? (
            // Its chats are read here; it no longer answers personal accounts,
            // and a new one was refused only after Start.
            <ChatComingSoon
              app={newApp}
              logos={logos}
              label="Read only"
              text={`Reach shows your ${newApp.name} chats. To start a new one, pick another app above.`}
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
                  key={newFolder + newKind}
                  folder={newFolder}
                  peer={peer}
                  agent={current}
                  sessions={sessions || []}
                  onStarted={openChat}
                  autoFocus
                  health={health}
                  logos={logos}
                  onAgent={setAgent}
                  startAs={newKind}
                  onWorkflow={(w) => {
                    setSheet("");
                    setNewKind("");
                    setFlow({ id: w.id, first: w });
                  }}
                />
              )}
            </>
          )}
        </ChatSheet>
      )}
      {flowsOpen && (
        <WorkflowsPage
          workflows={workflows}
          logos={logos}
          onOpen={(w) => {
            setFlowsOpen(false);
            setFlow({ id: w.id, first: null, back: true });
          }}
          onNew={() => {
            setFlowsOpen(false);
            setNewFolder("");
            setNewKind("workflow");
            setSheet("new");
          }}
          onNewChat={() => {
            setFlowsOpen(false);
            setNewFolder("");
            setNewKind("");
            setSheet("new");
          }}
          onClose={() => setFlowsOpen(false)}
        />
      )}
      {flow && (
        <WorkflowSheet
          peer={peer}
          id={flow.id}
          initial={flow.first}
          stamp={workflows.find((w) => w.id === flow.id)?.updatedAt}
          logos={logos}
          agents={relayAgents(health).length ? relayAgents(health) : undefined}
          onOpenChat={(chat) => {
            setFlow(null);
            openRef(chat);
          }}
          onClose={() => {
            setFlow(null);
            if (flow.back) setFlowsOpen(true);
          }}
        />
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
