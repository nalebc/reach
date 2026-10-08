import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, SearchCheck, Workflow } from "lucide-react";
import { request, type Peer } from "./api";
import { projectName, type AgentHealth, type AgentName, type AgentSession } from "./agent-sessions";
import type { AgentLogos } from "./agent-logos";
import { FolderPicker } from "./FolderBrowser";
import { RelaySheet, SecondOpinionSheet, relayAgents, type RelayStarted } from "./Relays";
import "./openclaw-relay.css";

// Under an OpenClaw reply: hand it to Codex or Claude Code (relay, second
// opinion), in a folder picked here. OpenClaw has no folder of its own, so
// the relay needs one (server/agent-sessions/relays.mjs `start`).

const folderKey = (peer: Peer) => `reach-claw-relay-folder:${peer.id}`;
const remembered = (peer: Peer) => {
  try {
    return localStorage.getItem(folderKey(peer)) || "";
  } catch {
    return "";
  }
};
const remember = (peer: Peer, cwd: string) => {
  try {
    localStorage.setItem(folderKey(peer), cwd);
  } catch {
    /* private window: picked again next time */
  }
};
// As EverythingChat's (not imported: it mounts OpenClawSpace, which mounts this).
function chatFolders(sessions: { cwd?: string }[]) {
  const seen: string[] = [];
  for (const s of sessions) {
    const cwd = (s.cwd || "").replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/, "");
    if (!cwd || /[\\/]\.codex[\\/]worktrees[\\/]/.test(cwd) || seen.includes(cwd)) continue;
    seen.push(cwd);
  }
  return seen.slice(0, 12);
}
function folderLabel(cwd: string, folders: string[]) {
  const name = projectName(cwd);
  if (!folders.some((f) => f !== cwd && projectName(f) === name)) return name;
  return cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

type Mode = "opinion" | "relay";

export function ClawRelayAction({
  peer,
  sessionKey,
  title,
  item,
  health,
  logos,
  onOpenChat,
}: {
  peer: Peer;
  sessionKey: string;
  title: string;
  item: string;
  health: AgentHealth[];
  logos: AgentLogos;
  onOpenChat?: (s: AgentSession) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  // Shown for the newest reply, or once its reply is tapped (or hovered: CSS).
  const [latest, setLatest] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [cwd, setCwd] = useState(() => remembered(peer));
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [picking, setPicking] = useState<null | { then: Mode | null }>(null);
  const [browse, setBrowse] = useState(false);
  const [sheet, setSheet] = useState<Mode | null>(null);
  const [started, setStarted] = useState(false);
  const [problem, setProblem] = useState("");
  // Only Codex and Claude Code: OpenClaw's own chats get no folder.
  const agents = health.filter((h) => h.agent !== "openclaw");
  const able = relayAgents(health, { openclaw: false }).length > 0;

  // The newest reply's row is the last one in the transcript.
  useLayoutEffect(() => {
    const el = row.current;
    const all = el?.closest(".claw-transcript")?.querySelectorAll(".claw-relay");
    const last = !all || all[all.length - 1] === el;
    if (last !== latest) setLatest(last);
  });
  useEffect(() => {
    const reply = row.current?.closest("article");
    if (!reply) return;
    const tap = () => setTapped(true);
    reply.addEventListener("click", tap);
    return () => reply.removeEventListener("click", tap);
  }, [able]);
  useEffect(() => {
    if (!started) return;
    const t = setTimeout(() => setStarted(false), 4000);
    return () => clearTimeout(t);
  }, [started]);

  if (!able) return null;

  // The Mac's chats, once: their folders, and the chats a relay can go to.
  const load = () => {
    if (sessions) return;
    request<{ sessions: AgentSession[] }>(peer, "/api/sessions")
      .then((r) => setSessions((r.sessions || []).filter((s) => s.agent === "codex" || s.agent === "claude")))
      .catch((e) => {
        setSessions([]);
        setProblem((e as Error).message);
      });
  };
  const ask = (mode: Mode) => {
    setProblem("");
    load();
    if (cwd) setSheet(mode);
    else setPicking({ then: mode });
  };
  const pick = (full: string) => {
    setCwd(full);
    remember(peer, full);
    setBrowse(false);
    const then = picking?.then;
    setPicking(null);
    if (then) setSheet(then);
  };
  const done = ({ opened }: RelayStarted) => {
    setSheet(null);
    if (opened && onOpenChat)
      onOpenChat({
        agent: opened.agent as AgentName,
        id: opened.id,
        title: "",
        cwd,
        branch: "",
        origin: "reach",
        inApp: false,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        status: "running",
        preview: "",
        archived: false,
      });
    else setStarted(true);
  };
  const folders = chatFolders([...(cwd ? [{ cwd }] : []), ...(sessions || [])]);
  // The OpenClaw chat as the sheets take it.
  const source = {
    agent: "openclaw" as AgentName,
    id: sessionKey,
    title,
    cwd,
    branch: "",
    origin: "reach",
    inApp: false,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    status: "idle",
    preview: "",
    archived: false,
  } as AgentSession;

  return (
    <div ref={row} className={`claw-relay${latest || tapped || picking || sheet ? " on" : ""}`}>
      <div className="claw-relay-pills" role="group" aria-label="Hand off">
        <button className="claw-relay-pill" onClick={() => ask("opinion")}>
          <SearchCheck size={14} /> Second opinion
        </button>
        <button className="claw-relay-pill" onClick={() => ask("relay")}>
          <Workflow size={14} /> Relay
        </button>
        {cwd && (
          <button
            className="claw-relay-pill quiet"
            aria-label={`Folder: ${cwd}`}
            aria-expanded={!!picking}
            onClick={() => {
              load();
              setPicking(picking ? null : { then: null });
            }}
          >
            <FolderOpen size={14} /> {projectName(cwd)}
          </button>
        )}
        {started && (
          <span className="claw-relay-done" role="status">
            <Check size={14} /> Started
          </span>
        )}
      </div>
      {picking && (
        <div className="claw-relay-folders" role="listbox" aria-label="Folder">
          {!sessions && <Loader2 size={14} className="spin" />}
          {folders.map((f) => (
            <button key={f} role="option" aria-selected={f === cwd} className="claw-relay-pill" title={f} onClick={() => pick(f)}>
              {folderLabel(f, folders)}
            </button>
          ))}
          <button role="option" aria-selected={browse} className="claw-relay-pill quiet" onClick={() => setBrowse(!browse)}>
            Browse…
          </button>
          {browse && (
            <div className="claw-relay-browse">
              <FolderPicker peer={peer} onPick={pick} />
            </div>
          )}
        </div>
      )}
      {problem && (
        <p className="claw-error" role="alert">
          {problem}
        </p>
      )}
      {sheet === "opinion" && (
        <SecondOpinionSheet
          peer={peer}
          session={source}
          item={item}
          cwd={cwd}
          health={agents}
          logos={logos}
          onClose={() => setSheet(null)}
          onStarted={done}
        />
      )}
      {sheet === "relay" && (
        <RelaySheet
          peer={peer}
          session={source}
          working={false}
          hasReply
          sessions={sessions || []}
          cwd={cwd}
          // An older reply goes on from itself, now.
          item={latest ? undefined : item}
          health={agents}
          logos={logos}
          onClose={() => setSheet(null)}
          onStarted={done}
        />
      )}
    </div>
  );
}
