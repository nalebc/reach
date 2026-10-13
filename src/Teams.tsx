import { useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import type { Peer } from "./api";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel, stopTeam, type Team, type TeamTask } from "./agent-sessions";
import { Route, type RouteNode } from "./Relays";
import "./relays.css";
import "./teams.css";

// Team chats (docs/ACROSS_AGENTS.md; server/agent-sessions/teams.mjs): a lead
// that hands work to helpers and checks what comes back. Drawn in Reach's own
// look, as relays are: the lead's tile, then its helpers along the route.

type ChatRef = { agent: string; id: string; title?: string };
const TEAM_AGENTS = ["codex", "claude"];

// The team a chat leads, or works in as a helper (with its task).
export const teamLedBy = (teams: Team[], chat: ChatRef) =>
  teams.find((t) => t.state === "active" && t.lead.agent === chat.agent && t.lead.id === chat.id) || null;
export function teamHelping(teams: Team[], chat: ChatRef) {
  // A stopped team (listed a day after) no longer claims its helpers.
  for (const team of teams) {
    if (team.state !== "active") continue;
    const task = team.tasks.find((x) => x.chat.agent === chat.agent && x.chat.id === chat.id);
    if (task) return { team, task };
  }
  return null;
}

// A lead's team tool, in plain words (its transcript names them as tools).
export function teamToolLabel(text: string) {
  const name = /^(?:mcp__reach_team__|reach_team: )(team_\w+)$/.exec(text.trim())?.[1];
  return name
    ? ({ team_delegate: "Handed work to a helper", team_message: "Sent a helper a follow-up", team_stop: "Stopped a helper", team_roster: "Checked the team" }[name] ??
        null)
    : null;
}

// In New chat: who leads and who helps. The lead's tile switches the lead;
// a helper's tile takes it off; the last place adds one.
export function TeamPicker({
  lead,
  helpers,
  available,
  logos,
  onLead,
  onHelpers,
}: {
  lead: string;
  helpers: string[];
  available: string[];
  logos: AgentLogos;
  onLead: (agent: string) => void;
  onHelpers: (helpers: string[]) => void;
}) {
  const leads = TEAM_AGENTS.filter((a) => available.includes(a));
  const free = TEAM_AGENTS.filter((a) => available.includes(a) && !helpers.includes(a));
  const nodes: RouteNode[] = [
    { key: "lead", agent: lead, label: "leads" },
    ...helpers.map((h) => ({ key: `helper:${h}`, agent: h, label: h === lead ? "a second one" : "helps" })),
  ];
  const names = helpers.map((h) => (h === lead ? `another ${agentLabel(h)}` : agentLabel(h)));
  return (
    <div className="team-picker reach-native">
      <Route
        nodes={nodes}
        logos={logos}
        selected={0}
        onSelect={(i) => {
          if (i === 0 && leads.length > 1) onLead(leads[(leads.indexOf(lead) + 1) % leads.length]);
          else if (i > 0 && helpers.length > 1) onHelpers(helpers.filter((_, n) => n !== i - 1));
        }}
        {...(free.length ? { add: { label: `Add ${agentLabel(free[0])} as a helper`, caption: "helper", onAdd: () => onHelpers([...helpers, free[0]]) } } : {})}
      />
      <p className="team-say">
        {agentLabel(lead)} leads. It hands work to {names.join(" and ") || "a helper"} and checks what comes back.
      </p>
    </div>
  );
}

const STATE: Record<TeamTask["state"], string> = { working: "Working", done: "Done", stopped: "Stopped" };

// Above the lead's message box: the team at work, each helper's task a tap
// from its chat, and Stop team (a second tap does it).
export function TeamStrip({
  peer,
  team,
  logos,
  onOpen,
  onChanged,
}: {
  peer: Peer;
  team: Team;
  logos: AgentLogos;
  onOpen: (chat: ChatRef) => void;
  onChanged?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const working = team.tasks.filter((t) => t.state === "working").length;
  const stop = async () => {
    setBusy(true);
    setProblem("");
    try {
      await stopTeam(peer, team.id);
      setAsking(false);
      onChanged?.();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="team-strip reach-native" aria-label="Team">
      <header>
        <span className="team-strip-crew" aria-hidden="true">
          <AgentLogo agent={team.lead.agent} logos={logos} size={16} />
          <i />
          {team.helpers.map((h, n) => (
            <AgentLogo key={`${h}${n}`} agent={h} logos={logos} size={16} />
          ))}
        </span>
        <strong>Team</strong>
        <small>
          {working ? `${working} working` : team.tasks.length ? "Helpers idle" : "No hand-offs yet"} · {team.left} left
        </small>
        {asking ? (
          <span className="team-strip-confirm">
            <button disabled={busy} onClick={() => setAsking(false)}>
              Keep
            </button>
            <button className="danger" disabled={busy} onClick={() => void stop()}>
              {busy ? <LoaderCircle size={14} className="spin" /> : "Stop team"}
            </button>
          </span>
        ) : (
          <button className="team-strip-stop" onClick={() => setAsking(true)}>
            Stop
          </button>
        )}
      </header>
      {asking && <p className="team-strip-note">Stops its helpers at work. Their chats stay; this chat carries on without them.</p>}
      {team.tasks.length > 0 && (
        <ul>
          {team.tasks
            .slice()
            .reverse()
            .slice(0, 4)
            .map((t) => (
              <li key={t.id}>
                <button onClick={() => onOpen(t.chat)} aria-label={`${t.title}, ${agentLabel(t.helper)}, ${STATE[t.state]}`}>
                  <AgentLogo agent={t.helper} logos={logos} size={18} />
                  <span className="team-task-title">{t.title}</span>
                  <span className={`team-task-state ${t.state}`}>
                    {t.state === "working" ? <LoaderCircle size={13} className="spin" /> : t.state === "done" ? <Check size={13} /> : <X size={13} />}
                    {t.kind === "review" && t.state === "working" ? "Reviewing" : STATE[t.state]}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}
      {problem && <p className="team-strip-note bad">{problem}</p>}
    </section>
  );
}

// Under a helper chat's header: whose team it works for, and the way back.
export function HelperBadge({ team, task, logos, onOpen }: { team: Team; task: TeamTask; logos: AgentLogos; onOpen: (chat: ChatRef) => void }) {
  return (
    <button className="team-helper-badge reach-native" onClick={() => onOpen(team.lead)}>
      <AgentLogo agent={team.lead.agent} logos={logos} size={16} />
      <span>
        {task.kind === "review" ? "Reviewing" : "Working"} for {agentLabel(team.lead.agent)}’s team
      </span>
      <small>Open lead</small>
    </button>
  );
}
