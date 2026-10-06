import { AgentLogo, type AgentLogos } from "./agent-logos";
import "./agent-coin.css";

// The chat menu's mark ("Continue in…"): a coin that flips through the other
// agents, one real app icon at a time (read from the apps on the Mac). CSS
// only; with reduced motion, the first one stays.
export default function AgentCoin({ agents, logos, size = 26 }: { agents: string[]; logos: AgentLogos; size?: number }) {
  const faces = agents.slice(0, 4);
  return (
    <span className={`agent-coin n${faces.length}`} style={{ width: size, height: size }} aria-hidden="true">
      {faces.map((agent, i) => (
        <span key={agent} className="agent-coin-face" style={{ animationDelay: `${i * 3.5}s` }}>
          <AgentLogo agent={agent} logos={logos} size={size} />
        </span>
      ))}
    </span>
  );
}
