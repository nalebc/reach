import { ChevronRight, Terminal } from "lucide-react";
import type { Peer, Session } from "./api";
import type { MacTerminal } from "./DesktopTerminals";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { describeMacTerminal, describeReachTerminal } from "./terminal-titles";
import type { Peek } from "./useTerminalPeeks";
import { useViewState, viewScope } from "./view-memory";
import "./home-terminals.css";

// Output is observable; whether a quiet shell is busy is not. Never claim
// a job is running just because its terminal process is still open.
const RECENT_OUTPUT_MS = 15000;
export default function HomeTerminals({
  peer, sessions, tabs, peeks, desktopPeeks, now, logos, onOpen, onOpenDesktop, onAll,
}: {
  peer: Peer;
  sessions: Session[];
  tabs: MacTerminal[];
  peeks: Record<string, Peek>;
  desktopPeeks: Record<string, { line: string; at: number }>;
  now: number;
  logos: AgentLogos;
  onOpen: (id: string) => void;
  onOpenDesktop: (id: string) => void;
  onAll: () => void;
}) {
  const [lastViewed] = useViewState(viewScope(peer, "terminal"), "lastViewed", "");
  const terminals = [
    ...sessions.filter(s => s.status === "running").map(s => {
      const peek = peeks[s.id];
      return {
        key: `reach:${s.id}`, ...describeReachTerminal(s),
        line: peek ? peek.lines?.at(-1) : s.preview?.at(-1),
        at: peek?.at || 0, open: () => onOpen(s.id),
      };
    }),
    ...tabs.map(t => ({
      key: `mac:${t.id}`, ...describeMacTerminal(t.name, t.provider),
      line: desktopPeeks[t.id]?.line, at: desktopPeeks[t.id]?.at || 0,
      open: () => onOpenDesktop(t.id),
    })),
  ];
  const recent = (at: number) => at > 0 && now - at < RECENT_OUTPUT_MS;
  const resume = terminals.find(t => t.key === lastViewed);
  const active = terminals.filter(t => t !== resume && recent(t.at)).sort((a, b) => b.at - a.at).slice(0, 3);
  if (!terminals.length) return null;
  const row = (terminal: (typeof terminals)[number], resuming = false) => {
    const label = resuming ? "Resume terminal" : "Recent output";
    return (
      <button key={terminal.key} className="home-terminal" aria-label={`${label}: ${terminal.title}`} onClick={terminal.open}>
        <span className="home-terminal-icon">
          {logos[terminal.agent || "terminal"]
            ? <AgentLogo agent={terminal.agent || "terminal"} name={terminal.agent ? undefined : "Terminal"} logos={logos} size={26} />
            : <Terminal size={22} aria-hidden="true" />}
        </span>
        <span className="home-terminal-copy">
          <small>{label}{resuming && recent(terminal.at) ? " · Recent output" : resuming ? " · Open" : ""}</small>
          <strong>{terminal.title}</strong>
          <span>{terminal.line || terminal.detail}</span>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    );
  };
  return (
    <section className="home-terminals" aria-label="Terminals">
      <header>
        <h2>Terminals <span>{terminals.length} open</span></h2>
        <button onClick={onAll} aria-label="View all terminals">View all <ChevronRight size={15} aria-hidden="true" /></button>
      </header>
      {resume && row(resume, true)}
      {active.map(t => row(t))}
      {!resume && !active.length && <p>Your open terminals are ready in Tools.</p>}
    </section>
  );
}
