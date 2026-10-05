import { useEffect, useState, type CSSProperties } from "react";
import {
  Asterisk,
  Bot,
  Monitor,
  MousePointer2,
  Orbit,
  Sparkle,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
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

// Stand-ins when an app's icon isn't on the computer: a thin line icon in the
// text color, one per agent so a row of them still tells them apart (Codex
// and Claude as HomeLive draws them). Never letters or a colored tile.
const GLYPHS: Record<string, LucideIcon> = {
  codex: Sparkles,
  claude: Asterisk,
  gemini: Sparkle,
  cursor: MousePointer2,
  antigravity: Orbit,
  terminal: Terminal,
  macos: Monitor,
};

// An agent's app icon; its line icon when the app's icon isn't on the computer.
// `fill`: the icon's own background fills a round frame edge to edge (Mac
// app icons leave a clear margin around their body; CSS crops it).
export function AgentLogo({
  agent,
  logos,
  name = agentLabel(agent),
  size = 28,
  light = false,
  fill = false,
  className = "",
}: {
  agent: string;
  logos: AgentLogos;
  name?: string;
  size?: number;
  light?: boolean;
  fill?: boolean;
  className?: string;
}) {
  const src = agent === "codex" ? (light && logos["codex-light"]) || logos.codex : logos[agent];
  const style: CSSProperties = { width: size, height: size };
  const Glyph = GLYPHS[agent] || Bot;
  return src ? (
    <img
      className={`agent-logo ${fill ? "fill" : ""} ${className}`}
      src={src}
      style={fill ? undefined : style}
      alt={name}
      draggable={false}
    />
  ) : (
    <span className={`agent-logo glyph ${agent} ${className}`} style={style} role="img" aria-label={name}>
      <Glyph size={Math.round(size * 0.78)} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
    </span>
  );
}

// Claude's spark, tinted and turning while Claude works, as in Claude Code.
// Without the Claude app's spark on the computer: a line asterisk in the same
// tint, never a filled square.
export function ClaudeSpark({ logos, size = 16, spinning = false }: { logos: AgentLogos; size?: number; spinning?: boolean }) {
  const mask = logos["claude-spark"];
  if (!mask)
    return (
      <Asterisk
        className={spinning ? "claude-spark plain spinning" : "claude-spark plain"}
        size={size}
        strokeWidth={2}
        absoluteStrokeWidth
        aria-hidden="true"
      />
    );
  return (
    <span
      className={`claude-spark ${spinning ? "spinning" : ""}`}
      style={{ width: size, height: size, WebkitMaskImage: `url(${mask})`, maskImage: `url(${mask})` }}
      aria-hidden="true"
    />
  );
}
