import { useEffect, useState, type CSSProperties } from "react";
import { request, type Peer } from "./api";
import { agentLabel } from "./agent-sessions";

// The agents' real logos, read from the apps on the Mac (server/agent-sessions/
// logos.mjs). Fetched once per version and kept in this browser, so they show
// at once and cost nothing after the first visit.
// codex, codex-light, claude, claude-spark, and any other agent's app icon.
export type AgentLogos = Partial<Record<string, string>>;
type Stored = { version: string; logos: AgentLogos };

const key = (peer: Peer) => `reach.agentLogos.${peer.id}`;
const memory = new Map<string, Stored>();
const checked = new Set<string>();
const listeners = new Set<() => void>();

function stored(peer: Peer): Stored | null {
  const hit = memory.get(peer.id);
  if (hit) return hit;
  try {
    const value = JSON.parse(localStorage.getItem(key(peer)) || "null");
    if (value?.version && value.logos) {
      memory.set(peer.id, value);
      return value;
    }
  } catch {
    /* private mode or cleared storage: fetch again */
  }
  return null;
}

// `null` for a device that can't see the agents (a guest): nothing is asked.
export function useAgentLogos(peer: Peer | null): AgentLogos {
  const [logos, setLogos] = useState<AgentLogos>(() => (peer && stored(peer)?.logos) || {});
  useEffect(() => {
    if (!peer) return;
    const update = () => setLogos(stored(peer)?.logos || {});
    listeners.add(update);
    update();
    // One check per Mac per page load; unchanged logos cost a few bytes.
    if (!checked.has(peer.id)) {
      checked.add(peer.id);
      const known = stored(peer)?.version || "";
      request<{ unchanged?: boolean; version: string; logos?: AgentLogos }>(
        peer,
        `/api/sessions/logos${known ? `?known=${known}` : ""}`,
      ).then(
        (r) => {
          if (r.unchanged || !r.logos) return;
          const value = { version: r.version, logos: r.logos };
          memory.set(peer.id, value);
          try {
            localStorage.setItem(key(peer), JSON.stringify(value));
          } catch {
            /* kept in memory for this visit */
          }
          for (const listener of listeners) listener();
        },
        () => checked.delete(peer.id),
      );
    }
    return () => {
      listeners.delete(update);
    };
  }, [peer?.id, peer?.url, peer?.token]);
  return logos;
}

// An agent's app icon; its initials when the app's icon isn't on the Mac.
export function AgentLogo({
  agent,
  logos,
  name = agentLabel(agent),
  size = 28,
  light = false,
  className = "",
}: {
  agent: string;
  logos: AgentLogos;
  name?: string;
  size?: number;
  light?: boolean;
  className?: string;
}) {
  const src = agent === "codex" ? (light && logos["codex-light"]) || logos.codex : logos[agent];
  const style: CSSProperties = { width: size, height: size };
  return src ? (
    <img className={`agent-logo ${className}`} src={src} style={style} alt={name} draggable={false} />
  ) : (
    <span className={`agent-logo text ${agent} ${className}`} style={{ ...style, fontSize: size * 0.4 }} role="img" aria-label={name}>
      {agent === "codex" ? "Cx" : agent === "claude" ? "Cl" : name.replace(/[^A-Za-z]/g, "").slice(0, 2)}
    </span>
  );
}

// Claude's spark, tinted and turning while Claude works, as in Claude Code.
export function ClaudeSpark({ logos, size = 16, spinning = false }: { logos: AgentLogos; size?: number; spinning?: boolean }) {
  const mask = logos["claude-spark"];
  return (
    <span
      className={`claude-spark ${spinning ? "spinning" : ""} ${mask ? "" : "plain"}`}
      style={{
        width: size,
        height: size,
        ...(mask ? { WebkitMaskImage: `url(${mask})`, maskImage: `url(${mask})` } : {}),
      }}
      aria-hidden="true"
    />
  );
}
