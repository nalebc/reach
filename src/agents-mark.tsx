import { AgentLogo, type AgentLogos } from "./agent-logos";
import { agentLabel } from "./agent-sessions";
import "./agents-mark.css";

// The Chat tab's mark: one disc shared by every agent on the computer, each
// holding its slice of its real app icon (two agents: a diagonal split; more:
// wedges). It turns slowly while any of them works, and wears a dot when one
// waits for you.
export function wedge(i: number, n: number) {
  if (n < 2) return undefined;
  const from = -45 + (360 / n) * i;
  const points = ["50% 50%"];
  for (let a = from; ; a += 15) {
    const at = Math.min(a, from + 360 / n);
    const r = (at * Math.PI) / 180;
    points.push(`${(50 + 75 * Math.cos(r)).toFixed(1)}% ${(50 + 75 * Math.sin(r)).toFixed(1)}%`);
    if (at >= from + 360 / n) break;
  }
  return `polygon(${points.join(", ")})`;
}

export function AgentsMark({
  agents,
  logos,
  size = 24,
  working = false,
  waiting = false,
}: {
  agents: string[];
  logos: AgentLogos;
  size?: number;
  working?: boolean;
  waiting?: boolean;
}) {
  const names = agents.map((a) => agentLabel(a)).join(" and ");
  return (
    <span
      className={`agents-mark ${working ? "working" : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={[names, working && "working", waiting && "needs you"].filter(Boolean).join(", ")}
    >
      <span className="agents-mark-disc" aria-hidden="true">
        {agents.map((a, i) => (
          <span key={a} className="agents-mark-slice" style={{ clipPath: wedge(i, agents.length) }}>
            <AgentLogo agent={a} logos={logos} size={size} fill />
          </span>
        ))}
      </span>
      {waiting && <i className="agents-mark-dot" aria-hidden="true" />}
    </span>
  );
}
