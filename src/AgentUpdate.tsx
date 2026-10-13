import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { request, type Peer, type Session } from "./api";
import { agentUpdates, updateAgent, type AgentName, type AgentUpdateInfo } from "./agent-sessions";
import { computerWord } from "./pause";

// A Reach terminal running an installer or updater: its newest line while
// it runs, then onEnd(ok) once it ends, or once it's gone (closed, or Reach
// restarted): never left spinning.
// The installer's own newest line, not the shell's: zsh closing its session
// ("…saving history…truncating history files…", "…completed.") and the typed
// command's echo used to be what the phone showed when an install ended.
const SHELL_NOISE = /^(?:\.\.\.)?\s*(?:saving session|saving history|truncating history|restored session|\.*completed\.?$)/i;
export function installerLine(preview: string[]) {
  const lines = preview.join("\n").split("\n").map((l) => l.trim());
  return [...lines].reverse().find((l) => l && !SHELL_NOISE.test(l) && !/;\s*exit$/.test(l)) || "";
}
export function useTerminalRun(peer: Peer, id: string | null, onEnd: (ok: boolean) => void) {
  const [line, setLine] = useState("");
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    if (id === null) return;
    setLine("");
    let over = false;
    let checking = false;
    const abort = new AbortController();
    const timer = setInterval(async () => {
      if (over || checking) return;
      checking = true;
      try {
        const list = await request<(Session & { exitCode?: number })[]>(peer, "/api/terminals", { signal: abort.signal });
        if (over) return;
        const t = list.find((x) => x.id === id);
        if (t?.preview) setLine(installerLine(t.preview));
        if (t?.status === "running") return;
        if (!t) setLine("");
        over = true;
        clearInterval(timer);
        end.current(t?.exitCode === 0);
      } catch {
        /* the next look tells */
      } finally {
        checking = false;
      }
    }, 2000);
    return () => {
      over = true;
      abort.abort();
      clearInterval(timer);
    };
  }, [id, peer.id, peer.url, peer.token]);
  return line;
}

// "Claude Code 2.1.295 is out · Update": offered only when the Mac is sure
// of it (server/agent-updates.mjs). Its maker's command shown first, run once
// confirmed in a Reach terminal, then checked again. Nothing shows when it's
// current, can't be told, or updates with an app.
export default function AgentUpdate({ peer, agent }: { peer: Peer; agent: AgentName }) {
  const [info, setInfo] = useState<AgentUpdateInfo | null>(null);
  const [command, setCommand] = useState("");
  const [step, setStep] = useState<"" | "confirm" | "running" | "failed" | "done">("");
  const [terminal, setTerminal] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const starting = useRef(false);
  const [launching, setLaunching] = useState(false);
  const word = computerWord(peer.platform);
  const check = (fresh = false) =>
    agentUpdates(peer, fresh).then(
      (r) => setInfo((Array.isArray(r?.agents) && r.agents.find((a) => a.agent === agent)) || null),
      () => setInfo(null),
    );
  useEffect(() => {
    setInfo(null);
    setStep("");
    setProblem("");
    if (agent === "claude" || agent === "codex") void check();
  }, [peer.id, agent]);
  const line = useTerminalRun(peer, step === "running" ? terminal : null, (ok) => {
    setStep(ok ? "done" : "failed");
    void check(true);
  });
  const ask = async () => {
    setProblem("");
    try {
      setCommand((await updateAgent(peer, agent)).command);
      setStep("confirm");
    } catch (e) {
      setProblem((e as Error).message);
      void check(true);
    }
  };
  const run = async () => {
    if (starting.current) return;
    starting.current = true;
    setLaunching(true);
    setProblem("");
    try {
      const started = await updateAgent(peer, agent, true);
      setTerminal(started.terminal?.id || "");
      setStep("running");
    } catch (e) {
      setProblem((e as Error).message);
      setStep("");
    } finally {
      starting.current = false;
      setLaunching(false);
    }
  };
  if (!info) return null;
  const name = info.name;
  if (step === "done")
    return info.state === "current" ? (
      <div className="chat-status agent-update" role="status">
        <span>{name} updated to {info.installed}</span>
      </div>
    ) : null;
  if (step === "confirm")
    return (
      <div className="chat-status agent-update open">
        <span>Runs on your {word}:</span>
        <pre className="chat-setup-command">{command}</pre>
        <div className="agent-update-actions">
          <button className="as-banner-btn" disabled={launching} onClick={() => setStep("")}>Cancel</button>
          <button className="as-banner-btn primary" disabled={launching} onClick={() => void run()}>Update</button>
        </div>
      </div>
    );
  if (step === "running")
    return (
      <div className="chat-status agent-update open" role="status">
        <span className="chat-setup-running">
          <Loader2 size={14} className="spin" /> Updating {name}…{line && <code>{line}</code>}
        </span>
      </div>
    );
  if (info.state !== "available" && step !== "failed") return null;
  return (
    <div className="chat-status agent-update">
      <span className={step === "failed" || problem ? "chat-setup-problem" : undefined}>
        {problem || (step === "failed" ? `Update stopped.${line ? ` ${line}` : ""}` : `${name} ${info.latest} is out`)}
      </span>
      {info.state === "available" && (
        <button className="as-banner-btn primary" onClick={() => void ask()}>
          {step === "failed" ? "Try again" : "Update"}
        </button>
      )}
    </div>
  );
}
