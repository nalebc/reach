import { useState } from "react";
import type { AgentHealth } from "./agent-sessions";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { UsageDetails } from "./AccountUsage";
import ChatSheet from "./ChatSheet";
import { tinyReset, usageOf, usageSentence, type Usage } from "./usage";
import "./usage.css";

// An agent's usage as a ring around its logo, like a battery: a faint
// hairline until 80%, amber from there, red from 95%, and under the logo
// when it's close, when it comes back ("4 PM", "Sat"); out, "Out".
export function UsageRing({ usage }: { usage: Usage | null }) {
  if (!usage) return null;
  return (
    <svg className={`usage-ring ${usage.level}`} viewBox="0 0 36 36" aria-hidden="true">
      <circle className="usage-ring-track" cx="18" cy="18" r="16.5" />
      <circle
        className="usage-ring-fill"
        cx="18"
        cy="18"
        r="16.5"
        pathLength={100}
        strokeDasharray={`${Math.max(usage.percent, 1)} 100`}
      />
    </svg>
  );
}

export function UsagePill({ usage }: { usage: Usage | null }) {
  if (!usage || (usage.level !== "critical" && usage.level !== "out")) return null;
  return (
    <span className={`usage-pill ${usage.level}`} aria-hidden="true">
      {usage.level === "out" ? "Out" : usage.resetsAt ? tinyReset(usage.resetsAt) : `${usage.percent}%`}
    </span>
  );
}

const nameOf = (h: AgentHealth) => (h.agent === "claude" ? "Claude" : h.name || h.agent[0].toUpperCase() + h.agent.slice(1));

// The fullest of these agents (on All: the one closest to running out).
export function fullestUsage(health: AgentHealth[]) {
  return health
    .map((h) => ({ health: h, usage: usageOf(h) }))
    .filter((x): x is { health: AgentHealth; usage: Usage } => !!x.usage)
    .sort((a, b) => (b.usage.level === "out" ? 1000 : b.usage.percent) - (a.usage.level === "out" ? 1000 : a.usage.percent))[0];
}

// The round button at the top of a chat list: the agent's logo in its ring
// (on All, the agent closest to its limit). It opens each agent's limits.
export function UsageButton({ health, logos }: { health: AgentHealth[]; logos: AgentLogos }) {
  const [open, setOpen] = useState(false);
  const top = fullestUsage(health);
  if (!top) return null;
  const shown = health.filter((h) => usageOf(h));
  return (
    <>
      <button
        className={`usage-button ${top.usage.level}`}
        aria-label="Usage"
        aria-description={usageSentence(nameOf(top.health), top.usage)}
        onClick={() => setOpen(true)}
      >
        <AgentLogo agent={top.health.agent} name={nameOf(top.health)} logos={logos} size={20} />
        <UsageRing usage={top.usage} />
        <UsagePill usage={top.usage} />
      </button>
      {open && <UsageSheet health={shown} logos={logos} onClose={() => setOpen(false)} />}
    </>
  );
}

export function UsageSheet({ health, logos, onClose }: { health: AgentHealth[]; logos: AgentLogos; onClose: () => void }) {
  return (
    <ChatSheet title="Usage" className="usage-sheet" onClose={onClose}>
      {health.map((h) => (
        <section key={h.agent} className="usage-sheet-agent" aria-label={nameOf(h)}>
          <h3>
            <AgentLogo agent={h.agent} name={nameOf(h)} logos={logos} size={20} />
            {nameOf(h)}
          </h3>
          <UsageDetails health={h} />
        </section>
      ))}
    </ChatSheet>
  );
}
