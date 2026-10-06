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
import type { Peer } from "./api";
import AgentSessionView, { ModelPicker } from "./AgentSession";
import AgentAccess from "./AgentAccess";
import OpenClawSpace from "./OpenClawSpace";
import ChatList, {
  ChatAppPicker,
  ChatComingSoon,
  type ChatAppChoice,
} from "./ChatList";
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
function NewChat({
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
  const folders = useMemo(() => {
    const seen: string[] = [];
    for (const s of sessions)
      if (s.cwd && !seen.includes(s.cwd)) seen.push(s.cwd);
    return seen.slice(0, 12);
  }, [sessions]);
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
    if (!ready) return;
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
              ...folders.map((f) => ({ id: f, label: projectName(f) })),
              { id: "\u0000other", label: "Other…" },
            ],
            otherFolder ? "\u0000other" : cwd,
            (id) => {
              if (id === "\u0000other") {
                setOtherFolder(true);
                setCwd("");
              } else {
                setOtherFolder(false);
                setCwd(id);
                setPanel("");
              }
            },
            "Folder",
          )}
          {otherFolder && (
            <input
              className="as-folder-input"
              placeholder="/Users/you/project"
              aria-label="Folder path"
              value={cwd}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setCwd(e.target.value)}
            />
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
              in {projectName(cwd)}
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
              aria-expanded={panel === "folder"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPanel(panel === "folder" ? "" : "folder")}
            >
              <FolderOpen size={14} />
              <span>{cwd ? projectName(cwd) : "Folder"}</span>
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
        <p>{name} isn't installed on this {computerWord(peer.platform)}. Install it there, then check again to discover your conversations.</p>
        <div className="chat-setup-actions">
          <a href={agent === "codex" ? "https://developers.openai.com/codex/cli/" : "https://code.claude.com/docs/en/setup"} target="_blank" rel="noopener noreferrer">Install {name}</a>
          <button onClick={recheck}>Check again</button>
        </div>
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

type Target = { agent: AgentName; id: string };

export default function EverythingChat({
  peer,
  feed: shared,
  target,
  onTargetOpened,
  showOnScreen,
}: {
  peer: Peer;
  feed?: AgentFeed;
  target?: Target | null;
  onTargetOpened?: () => void;
  showOnScreen?: (prompt: MacPrompt) => void;
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
          supported: item.agent === "openclaw",
        });
    }
    return list;
  }, [health]);
  const picked = apps.find((app) => app.agent === savedAgent) || apps[0];
  useEffect(() => {
    if (health.length && !apps.some((app) => app.agent === savedAgent)) setAgent("codex");
  }, [health, apps, savedAgent]);
  const current: AgentName = picked.agent === "claude" ? "claude" : "codex";
  const [open, setOpen] = useState<AgentSession | null>(null);
  const [sheet, setSheet] = useState<"" | "new" | "review">("");
  useClaudeFonts(peer, current === "claude" || open?.agent === "claude");
  const openChat = (s: AgentSession) => {
    setAgent(s.agent);
    setSheet("");
    setOpen(s);
  };
  useEffect(() => {
    if (!target) return;
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
          onAppChange={setAgent} appPending={appPending} onDiscover={recheck}
          deviceRequests={macPrompts.length} onReviewDevice={() => setSheet("review")} />
      ) : (
        <div className="chat-workspace" aria-hidden={!!sheet || undefined}>
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
            canStart={!needsSetup}
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
            <p className="chat-sheet-intro">Your OpenClaw sessions are discovered automatically. Close this panel to open one.</p>
          ) : !picked.supported ? (
            <ChatComingSoon app={picked} logos={logos} />
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
