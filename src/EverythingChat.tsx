import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Sparkle,
  X,
} from "lucide-react";
import type { Peer } from "./api";
import AgentSessionView, { ModelPicker, UsageButton } from "./AgentSession";
import AgentAccess from "./AgentAccess";
import MacPromptCard from "./MacPrompts";
import { AgentLogo, ClaudeSpark, useAgentLogos, type AgentLogos } from "./agent-logos";
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
  whereLabel,
  type AgentFeed,
  type AgentHealth,
  type AgentMode,
  type AgentModel,
  type AgentProject,
  type AgentName,
  type AgentSession,
} from "./agent-sessions";
import "./agent-session.css";
import "./chat-home.css";

// Chat: one world per agent, in its own look. A switch picks Codex or Claude
// Code; below it, a composer for a new chat and that agent's sessions on the
// Mac. Opening a session shows it like its own app (AgentSession.tsx).

const AGENTS: AgentName[] = ["codex", "claude"];
const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
};

// Every agent on the Mac in one row of real app icons. The chosen one wears
// its name on a knob that slides over, its icon rolling in from the side you
// came from; more agents (Gemini, Cursor…) just extend the row.
type PickerAgent = { agent: string; name: string; supported: boolean };
function AgentPicker({
  agents,
  current,
  onChange,
  logos,
  waiting,
}: {
  agents: PickerAgent[];
  current: string;
  onChange: (agent: string) => void;
  logos: AgentLogos;
  waiting: Record<string, number>;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<{ left: number; width: number } | null>(null);
  const [rolling, setRolling] = useState<"" | "from-left" | "from-right">("");
  useLayoutEffect(() => {
    const el = row.current?.querySelector<HTMLElement>(`[data-agent="${current}"]`);
    if (!el) return;
    setKnob({ left: el.offsetLeft, width: el.offsetWidth });
    el.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [current, agents.map((a) => a.agent).join(), logos[current]]);
  const at = agents.findIndex((a) => a.agent === current);
  return (
    <div ref={row} className={`agent-picker ${rolling}`} role="radiogroup" aria-label="Agent">
      {knob && (
        <span
          className="agent-picker-knob"
          aria-hidden="true"
          style={{ transform: `translateX(${knob.left}px)`, width: knob.width }}
        />
      )}
      {agents.map((a, i) => (
        <button
          key={a.agent}
          data-agent={a.agent}
          role="radio"
          aria-checked={a.agent === current}
          aria-label={a.supported ? a.name : `${a.name}, coming soon`}
          className={a.supported ? "" : "soon"}
          onAnimationEnd={() => setRolling("")}
          onClick={() => {
            if (a.agent === current) return;
            setRolling(i > at ? "from-left" : "from-right");
            onChange(a.agent);
          }}
        >
          <AgentLogo agent={a.agent} name={a.name} logos={logos} size={26} className="agent-picker-logo" />
          {a.agent === current && <b>{a.name}</b>}
          {a.agent !== current && waiting[a.agent] > 0 && (
            <i className="agent-switch-badge" aria-label={`${waiting[a.agent]} waiting for you`}>
              {waiting[a.agent]}
            </i>
          )}
        </button>
      ))}
    </div>
  );
}

// Claude Code's --permission-mode choices for a new chat; "Default" leaves
// Claude Code's own settings in charge.
// Until Claude Code's own list arrives.
const CLAUDE_MODE_CHOICES = ["manual", "acceptEdits", "plan", "auto"];

type Attachment = { key: number; url: string; id?: string; error?: string };

// A new chat, in the agent's own composer. One line at rest; folder, access
// and model appear while you write.
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
    for (const s of sessions) if (s.cwd && !seen.includes(s.cwd)) seen.push(s.cwd);
    return seen.slice(0, 12);
  }, [sessions]);
  const [cwd, setCwd] = useState("");
  const [otherFolder, setOtherFolder] = useState(false);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [images, setImages] = useState<Attachment[]>([]);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [modes, setModes] = useState<AgentMode[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [mode, setMode] = useState(agent === "codex" ? "auto" : "default");
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
    listModels(peer, agent).then((r) => {
      setModels(r.models);
      if (r.modes?.length) setModes(r.modes);
      // New chats start the way the agent's app would start them.
      if (agent === "codex" && r.mode) setMode(r.mode);
      const first = r.models.find((m) => m.isDefault) || r.models[0];
      if (first) {
        setModel(first.id);
        setEffort(first.defaultEffort);
      }
    }, () => {});
  }, [peer.url, peer.token, agent]);
  const current = models.find((m) => m.id === model);
  // Permission modes for the new chat, as the agent offers them now. Claude
  // Code starts in your settings' default unless you pick one.
  const modeChoices: AgentMode[] =
    agent === "codex"
      ? modes || CODEX_MODE_CHOICES
      : [
          { id: "default", label: "Default" },
          ...modesFor(modes || CLAUDE_MODE_CHOICES.map((id) => ({ id, label: modeLabel("claude", id) })), current),
        ];
  const uploading = images.some((i) => !i.id && !i.error);
  const ready = !busy && !uploading && !!cwd && (text.trim().length > 0 || images.some((i) => i.id));
  const open = focused || !!text || images.length > 0 || !!panel;
  const modeName = modeChoices.find((m) => m.id === mode)?.label || modeLabel(agent, mode);
  const addFiles = (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) continue;
      const key = ++seq.current;
      setImages((list) => [...list, { key, url: URL.createObjectURL(file) }]);
      uploadImage(peer, file, file.name || "image").then(
        (id) => setImages((list) => list.map((i) => (i.key === key ? { ...i, id } : i))),
        (e) => setImages((list) => list.map((i) => (i.key === key ? { ...i, error: (e as Error).message } : i))),
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
        ...(model && !(agent === "claude" && model === "default") ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(mode !== "default" ? { mode } : {}),
      });
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
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choiceRow = (items: { id: string; label: string }[], chosen: string, choose: (id: string) => void, label: string) => (
    <div className={`as-picker ${agent}`} role="group" aria-label={label}>
      <div className="as-picker-row">
        {items.map((item) => (
          <button key={item.id} aria-pressed={item.id === chosen} onClick={() => choose(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <section className={`chat-new ${open ? "open" : ""}`} aria-label={`New ${agentLabel(agent)} chat`}>
      {problem && <p className="as-hint bad">{problem}</p>}
      {panel === "folder" && (
        <>
          {choiceRow(
            [...folders.map((f) => ({ id: f, label: projectName(f) })), { id: "\u0000other", label: "Other…" }],
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
          agent === "codex" ? "How should Codex actions be approved?" : "Permissions",
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
              <span key={i.key} className={`as-thumb ${i.error ? "bad" : ""}`} title={i.error}>
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
          placeholder={agent === "codex" ? "Do anything" : "Chat with Claude"}
          aria-label={`New ${agentLabel(agent)} chat`}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
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
            className="as-model chat-folder"
            aria-expanded={panel === "folder"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPanel(panel === "folder" ? "" : "folder")}
          >
            <FolderOpen size={14} />
            <span>{cwd ? projectName(cwd) : "Folder"}</span>
          </button>
          <button
            className="as-model as-mode-pick"
            aria-expanded={panel === "mode"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPanel(panel === "mode" ? "" : "mode")}
          >
            {agent === "codex" && <ShieldCheck size={14} />}
            <span>{modeName}</span>
          </button>
          <span className="as-spacer" />
          {current && (
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
          <button className={`as-send ${ready ? "ready" : ""}`} aria-label="Start" disabled={!ready} onClick={() => void start()}>
            {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={18} />}
          </button>
        </div>
      )}
      </div>
    </section>
  );
}

// The agent's sessions on the Mac, listed the way its app lists them.
// The sessions as each app's sidebar lists them. Codex: its projects (from
// Codex, each with its newest threads), then Recents; a spinner on a thread at
// work. Claude Code: a search field, then sessions under their folder's name,
// with the app's dot.
function SessionList({
  agent,
  sessions,
  projects = [],
  logos,
  word,
  onOpen,
}: {
  agent: AgentName;
  sessions: AgentSession[];
  projects?: AgentProject[];
  logos: AgentLogos;
  // "Mac" or "computer" (pause.ts computerWord).
  word: string;
  onOpen: (s: AgentSession) => void;
}) {
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const state = (s: AgentSession) =>
    s.status === "waiting" ? "Waiting for you" : s.status === "running" ? "Working" : "";
  const row = (s: AgentSession) => (
    <button
      key={s.id}
      className={`chat-session ${s.status}`}
      aria-label={[s.title, state(s)].filter(Boolean).join(", ")}
      onClick={() => onOpen(s)}
    >
      {agent === "claude" &&
        (s.status === "running" ? (
          <ClaudeSpark logos={logos} size={12} spinning />
        ) : (
          <i className={`chat-dot ${s.status}`} aria-hidden="true" />
        ))}
      <span className="chat-session-title">{s.title}</span>
      {agent === "codex" && s.status === "running" && <Loader2 size={13} className="spin" aria-hidden="true" />}
      {agent === "codex" && s.status === "waiting" && <i className="chat-dot waiting" aria-hidden="true" />}
    </button>
  );
  const shown = (key: string, list: AgentSession[], first: number) => (
    <>
      {list.slice(0, more[key] ? list.length : first).map(row)}
      {!more[key] && list.length > first && (
        <button className="chat-more" onClick={() => setMore({ ...more, [key]: true })}>
          Show more
        </button>
      )}
    </>
  );
  if (!sessions.length)
    return (
      <p className="chat-empty">
        No {agentLabel(agent)} sessions on your {word} yet.
      </p>
    );
  if (agent === "codex") {
    const inside = (s: AgentSession, p: AgentProject) =>
      p.roots.some((root) => s.cwd === root || s.cwd.startsWith(`${root}/`));
    const groups = projects
      .map((p) => ({ p, list: sessions.filter((s) => inside(s, p)) }))
      .filter((g) => g.list.length)
      .sort((a, b) => b.list[0].updatedAt - a.list[0].updatedAt);
    return (
      <div className="chat-sessions codex">
        {groups.length > 0 && (
          <section aria-label="Projects">
            <h3>Projects</h3>
            {groups.map(({ p, list }) => (
              <div className="chat-project" key={p.id}>
                <span className="chat-project-name">
                  <FolderOpen size={16} /> {p.name}
                </span>
                {shown(p.id, list, 5)}
              </div>
            ))}
          </section>
        )}
        <section aria-label="Recents">
          <h3>Recents</h3>
          {shown("recents", sessions, 15)}
        </section>
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const found = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  const groups: { name: string; list: AgentSession[] }[] = [];
  for (const s of found) {
    const name = projectName(s.cwd) || "Other";
    const group = groups.find((g) => g.name === name);
    if (group) group.list.push(s);
    else groups.push({ name, list: [s] });
  }
  return (
    <div className="chat-sessions claude">
      <label className="chat-search">
        <Search size={15} />
        <input
          type="search"
          placeholder="Search"
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {groups.map((g) => (
        <section key={g.name} aria-label={g.name}>
          <h3>{g.name}</h3>
          {shown(g.name, g.list, q ? g.list.length : 6)}
        </section>
      ))}
      {!groups.length && <p className="chat-empty">No sessions match.</p>}
    </div>
  );
}

// The apps' composer before you tap it: its words, "+", the model it will
// use, and the send button. A tap opens the real one, ready to type.
function RestingComposer({ peer, agent, onOpen }: { peer: Peer; agent: AgentName; onOpen: () => void }) {
  const [model, setModel] = useState<{ name: string; effort: string } | null>(null);
  useEffect(() => {
    let live = true;
    setModel(null);
    listModels(peer, agent).then(
      (r) => {
        const first = r.models.find((m) => m.isDefault) || r.models[0];
        if (live && first) setModel({ name: first.name, effort: effortLabel(first.defaultEffort ?? null, agent) });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [peer.url, peer.token, agent]);
  const words = agent === "codex" ? "Do anything" : "Chat with Claude";
  return (
    <button className={`chat-new-row resting ${agent}`} aria-label={words} onClick={onOpen}>
      <span className="chat-new-placeholder">{words}</span>
      <span className="chat-new-tools" aria-hidden="true">
        <i className="chat-new-plus">
          <Plus size={18} />
        </i>
        {model && (
          <i className="chat-new-model">
            {model.name} <em>{model.effort}</em>
          </i>
        )}
        <i className="as-spacer" />
        <i className="as-send">
          <ArrowUp size={18} />
        </i>
      </span>
    </button>
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
  if (!health.installed)
    return (
      <p className="chat-status">
        {name} isn't installed on this {computerWord(peer.platform)}.
      </p>
    );
  if (!health.signedIn) return <AgentAccess peer={peer} agent={agent} health={health} logos={logos} onSignedIn={recheck} />;
  if (health.usable === false)
    return (
      <div className="chat-status out-of-usage">
        <span>
          You’re out of {name} usage{health.resetsAt ? ` until ${resetTime(health.resetsAt, false)}` : ""}.
        </span>
        <a
          className="as-banner-btn primary"
          href={usageLink(agent, { detail: "usageLimitExceeded", text: "usage limit" })?.url}
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
}: {
  peer: Peer;
  // The app-wide feed (started when Reach connects); a page of its own otherwise.
  feed?: AgentFeed;
  target?: Target | null;
  onTargetOpened?: () => void;
}) {
  const own = useAgentSessions(shared ? null : peer);
  const { sessions, errors, health, failure, reload, recheck } = shared || own;
  const projects = (shared || own).projects || [];
  const macPrompts = (shared || own).macPrompts || [];
  // The apps' "New chat" / "New" row opens the composer for a new session.
  const [composing, setComposing] = useState(false);
  const logos = useAgentLogos(peer);
  const [agent, setAgent] = useChatAgent();
  // The two Reach drives, then the agents coming next, installed or not.
  const agents: PickerAgent[] = useMemo(() => {
    const list: PickerAgent[] = AGENTS.map((a) => ({ agent: a, name: agentLabel(a), supported: true }));
    for (const h of health)
      if (!h.supported && !list.some((a) => a.agent === h.agent))
        list.push({ agent: h.agent, name: h.name || h.agent, supported: false });
    return list;
  }, [health]);
  const picked = agents.find((a) => a.agent === agent) || agents[0];
  const [open, setOpen] = useState<AgentSession | null>(null);
  useClaudeFonts(peer, (open?.agent || picked.agent) === "claude");
  // Opened from Home (a story or "needs you").
  useEffect(() => {
    if (!target) return;
    const found = sessions?.find((s) => s.agent === target.agent && s.id === target.id);
    setAgent(target.agent);
    setOpen(
      found ||
        ({
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
        } as AgentSession),
    );
    onTargetOpened?.();
  }, [target?.agent, target?.id]);
  const mine = useMemo(() => (sessions || []).filter((s) => s.agent === picked.agent && !s.archived), [sessions, picked.agent]);
  const waiting = useMemo(
    () =>
      Object.fromEntries(
        AGENTS.map((a) => [a, (sessions || []).filter((s) => s.agent === a && s.status === "waiting").length]),
      ) as Record<string, number>,
    [sessions],
  );
  if (open)
    return (
      <AgentSessionView
        key={`${open.agent}:${open.id}`}
        peer={peer}
        session={open}
        siblings={(sessions || []).filter((s) => s.agent === open.agent && !s.archived)}
        health={health}
        logos={logos}
        onSignedIn={recheck}
        onSelect={setOpen}
        onBack={() => {
          setOpen(null);
          void reload();
        }}
        onNew={() => {
          setAgent(open.agent);
          setOpen(null);
          setComposing(true);
          void reload();
        }}
      />
    );
  const status = health.find((h) => h.agent === picked.agent);
  if (!picked.supported)
    return (
      <div className={`chat-home ${picked.agent}`}>
        <AgentPicker agents={agents} current={picked.agent} onChange={setAgent} logos={logos} waiting={waiting} />
        <div className="chat-soon">
          <AgentLogo agent={picked.agent} name={picked.name} logos={logos} size={64} />
          <strong>{picked.name}</strong>
          <em>Coming soon</em>
          <p>
            Reach will list your {picked.name} sessions here and let you continue them from your phone, like Codex and
            Claude Code.
          </p>
        </div>
      </div>
    );
  const current = picked.agent as AgentName;
  return (
    <div className={`chat-home ${current}`}>
      <AgentPicker agents={agents} current={current} onChange={setAgent} logos={logos} waiting={waiting} />
      {macPrompts.map((p) => (
        <MacPromptCard key={p.id} prompt={p} logos={logos} compact />
      ))}
      <AgentStatus peer={peer} agent={current} health={status} logos={logos} recheck={recheck} />
      {/* Each app opens on its own words: Claude's spark and a greeting in
          its serif; the Codex app's "Let's build". */}
      <div className="chat-greeting">
        {current === "claude" ? (
          <ClaudeSpark logos={logos} size={34} />
        ) : (
          <AgentLogo agent={current} logos={logos} size={40} className="chat-greeting-logo" />
        )}
        <h2>{current === "claude" ? greeting() : "Let’s build"}</h2>
      </div>
      {(!status || (status.installed && status.signedIn)) &&
        (composing ? (
          <NewChat key={current} peer={peer} agent={current} sessions={sessions || []} onStarted={setOpen} autoFocus />
        ) : (
          <RestingComposer peer={peer} agent={current} onOpen={() => setComposing(true)} />
        ))}
      {failure && <p className="chat-status">{failure}</p>}
      {errors[current] && <p className="chat-status">{errors[current]}</p>}
      {!sessions ? (
        <p className="chat-empty">
          <Loader2 size={15} className="spin" /> Looking for your sessions…
        </p>
      ) : (
        <SessionList
          agent={current}
          sessions={mine}
          projects={projects}
          logos={logos}
          word={computerWord(peer.platform)}
          onOpen={setOpen}
        />
      )}
    </div>
  );
}
