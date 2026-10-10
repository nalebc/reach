import type { AgentHealth } from "./agent-sessions";

// How full an agent's account is, decided once for every agent and every
// place that shows it (the ring on its logo, the All page's row, the line
// above the message box): from the fullest window's percent, so Claude and
// Codex turn amber and red at the same points. Out is the Mac's word for it
// (`usable: false`), the same the message box goes by.
export const WARN_AT = 80;
export const CRITICAL_AT = 95;
export const NEAR_AT = 90;
export type UsageLevel = "rest" | "warning" | "critical" | "out";
export type Usage = {
  agent: string;
  level: UsageLevel;
  percent: number;
  label: string;
  resetsAt: number | null;
  // An old reading (the account couldn't be asked just now).
  stale: boolean;
};

export function usageOf(health?: AgentHealth): Usage | null {
  if (!health?.signedIn) return null;
  // A window without a readable percentage tells nothing (never "NaN% used").
  const windows = (health.usage?.windows || []).filter((w) => Number.isFinite(w.usedPercent));
  const fullest = windows.reduce<(typeof windows)[number] | undefined>(
    (best, w) => (!best || w.usedPercent > best.usedPercent ? w : best),
    undefined,
  );
  const out = health.usable === false;
  if (!fullest && !out) return null;
  const percent = out ? Math.max(100, fullest?.usedPercent || 0) : fullest!.usedPercent;
  return {
    agent: health.agent,
    level: out || percent >= 100 ? "out" : percent >= CRITICAL_AT ? "critical" : percent >= WARN_AT ? "warning" : "rest",
    percent: Math.min(100, Math.round(percent)),
    label: fullest?.label || "",
    resetsAt: (out ? health.resetsAt : null) ?? fullest?.resetsAt ?? null,
    stale: !out && health.usage?.available === false,
  };
}

// The same agent on several computers is one account (or the fullest of
// them, which is the one that runs out first).
export function mergeHealth(lists: AgentHealth[][]): AgentHealth[] {
  const by = new Map<string, AgentHealth>();
  for (const list of lists)
    for (const h of list) {
      const held = by.get(h.agent);
      const a = usageOf(held);
      const b = usageOf(h);
      if (!held || (b && (!a || rank(b) > rank(a)))) by.set(h.agent, h);
    }
  return [...by.values()];
}
const rank = (u: Usage) => (u.level === "out" ? 1000 : u.percent);

// "4:00 PM" today, "Mon 4:00 PM" this week, "Oct 14" later.
export function shortReset(at: number, now = Date.now()) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  if (at - now < 6 * 24 * 3600 * 1000) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Under a logo, where only a word fits: "4 PM" today, "Sat" this week.
export function tinyReset(at: number, now = Date.now()) {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString([], { hour: "numeric" });
  if (at - now < 6 * 24 * 3600 * 1000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// What a screen reader hears for the ring.
export function usageSentence(name: string, u: Usage) {
  const reset = u.resetsAt ? `, resets ${shortReset(u.resetsAt)}` : "";
  if (u.level === "out") return `${name}, out of usage${reset}`;
  return `${name}, ${u.percent}% of ${u.label || "usage"} used${reset}`;
}
