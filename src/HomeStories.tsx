import { useEffect, useRef, useState } from "react";
import { Asterisk, Check, MessageSquare, Plus, Sparkles, Terminal } from "lucide-react";
import { request, type Device, type Peer, type Session } from "./api";
import type { WorkspaceCapabilities } from "./capabilities";
import type { MacTerminal } from "./DesktopTerminals";
import type { AgentSession } from "./agent-sessions";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { macTerminalsFingerprint } from "./mac-terminal-live";
import { useTerminalPeeks } from "./useTerminalPeeks";
import { computerWord } from "./pause";
import "./home-stories.css";

// "Live on your Mac": one circle per thing running on the computer, like
// stories. A ring turns while it prints, pulses amber when it needs you, and
// a just-finished one keeps a check (or "!") for a few minutes. Tapping a
// circle opens it. Home shows what's alive at a glance.

// Output within this window makes a story ring spin.
const ACTIVE_MS = 4000;
// A chat that ended its turn this recently keeps its circle, marked done.
const DONE_MS = 10 * 60 * 1000;

type Story = {
  key: string;
  name: string;
  kind: "codex" | "claude" | "gemini" | "shell" | "chat";
  mac?: boolean;
  state: "attention" | "failed" | "active" | "done" | "running" | "idle";
  line?: string;
  at: number;
  open: () => void;
};
// The windows Reach itself runs in (its launcher on a Mac, its own "Reach"
// window on a PC) are Reach, not something you're running.
export const reachOwnWindow = (name = "") =>
  /^start-(in-terminal|at-login)(\.command)?\b/i.test(name.trim()) || name.trim() === "Reach";
const kindOf = (name: string): Story["kind"] =>
  /claude/i.test(name) ? "claude" : /codex/i.test(name) ? "codex" : /gemini/i.test(name) ? "gemini" : "shell";
// Codex, Claude Code and terminals wear their real app icons (from the
// computer), filling the round frame.
const Glyph = ({ kind, logos = {} }: { kind: Story["kind"]; logos?: AgentLogos }) => {
  const icon = kind === "shell" ? "terminal" : kind;
  // Gemini's mark ships with Reach (no app to read it from).
  if (kind === "gemini") return <AgentLogo agent="gemini" logos={logos} size={30} />;
  return logos[icon] && icon !== "chat" ? (
    <AgentLogo agent={icon} logos={logos} name={icon === "terminal" ? "Terminal" : undefined} fill />
  ) : kind === "codex" ? (
    <Sparkles size={22} />
  ) : kind === "claude" ? (
    <Asterisk size={24} />
  ) : kind === "chat" ? (
    <MessageSquare size={21} />
  ) : (
    <Terminal size={22} />
  );
};

// The computer's own terminal windows and each one's last line. A computer
// that tells when its windows change is asked only then
// (server/mac-terminal-watch.mjs); others every few seconds.
function useMacTabs(peer: Peer, enabled: boolean, visible: boolean, changes?: string) {
  const [tabs, setTabs] = useState<MacTerminal[]>([]);
  const [peeks, setPeeks] = useState<Record<string, { line: string; at: number }>>({});
  const list = useRef<MacTerminal[]>([]);
  useEffect(() => {
    list.current = [];
    setTabs([]);
    setPeeks({});
  }, [peer.url, peer.token]);
  const pushed = macTerminalsFingerprint(changes);
  const told = pushed !== undefined;
  // A changed last line counts as new output.
  const note = (id: string, line: string) =>
    setPeeks((current) => (current[id]?.line === line ? current : { ...current, [id]: { line, at: Date.now() } }));
  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const r = await request<{ sessions: MacTerminal[] }>(peer, "/api/terminals/desktop");
        if (stopped) return;
        list.current = r.sessions;
        setTabs(r.sessions);
      } catch {
        /* Permission or app missing: no computer tabs on Home. */
      }
    };
    void refresh();
    const lister = told ? undefined : setInterval(() => void refresh(), 5000);
    return () => {
      stopped = true;
      clearInterval(lister);
    };
  }, [enabled, visible, peer.url, peer.token, told, pushed]);
  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false;
    if (told) {
      // Every tab's last line, answered by the computer when one changes.
      const waits = new Set<AbortController>();
      void (async () => {
        let version = -1;
        while (!stopped) {
          const wait = new AbortController();
          waits.add(wait);
          const limit = setTimeout(() => wait.abort(), 30000);
          try {
            const r = await request<{ version: number; peeks: Record<string, string> }>(
              peer,
              `/api/terminals/desktop/activity?after=${version}`,
              { signal: wait.signal },
            );
            if (stopped) return;
            // Nothing new right away: never spin.
            if (r.version === version) await new Promise((done) => setTimeout(done, 1000));
            version = r.version;
            for (const [id, line] of Object.entries(r.peeks || {})) note(id, String(line));
          } catch (e) {
            if (stopped) return;
            if ((e as Error).name !== "AbortError") await new Promise((done) => setTimeout(done, 3000));
          } finally {
            clearTimeout(limit);
            waits.delete(wait);
          }
        }
      })();
      return () => {
        stopped = true;
        for (const wait of waits) wait.abort();
      };
    }
    let turn = 0;
    const read = async () => {
      const tab = list.current[turn++ % Math.max(1, list.current.length)];
      if (!tab || stopped) return;
      try {
        const { text } = await request<{ text: string }>(peer, `/api/terminals/desktop/${tab.id}`);
        if (stopped) return;
        note(
          tab.id,
          String(text)
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => /[\p{L}\p{N}]/u.test(l))
            .pop() || "",
        );
      } catch {
        /* That window closed: the next refresh drops it. */
      }
    };
    const reader = setInterval(() => void read(), 900);
    return () => {
      stopped = true;
      clearInterval(reader);
    };
  }, [enabled, visible, peer.url, peer.token, told]);
  return { tabs: enabled ? tabs : [], peeks };
}

export default function HomeStories({
  peer,
  device,
  features,
  visible,
  changes,
  terminals,
  agentSessions,
  logos,
  openTerminal,
  openMacTab,
  openAgentSession,
  onStart,
}: {
  peer: Peer;
  device: Device;
  features: WorkspaceCapabilities;
  visible: boolean;
  // The computer's fingerprints of what changed (useFleetConnections).
  changes?: string;
  terminals: Session[];
  agentSessions: AgentSession[];
  logos?: AgentLogos;
  openTerminal: (id: string) => void;
  openMacTab: (id: string) => void;
  openAgentSession?: (session: AgentSession) => void;
  // ＋: where agents and terminals are started.
  onStart?: () => void;
}) {
  const word = computerWord(device.platform);
  const peeks = useTerminalPeeks(peer, features.terminal ? terminals : []);
  const mac = useMacTabs(peer, features.desktopTerminals, visible, changes);
  // Ages and spinning rings follow the clock.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  const recent = (at: number) => at > 0 && now - at < ACTIVE_MS;
  const stories: Story[] = [
    ...(features.terminal ? terminals : [])
      .filter((t) => t.status === "running")
      .map((t): Story => {
        const peek = peeks[t.id];
        const lines = peek ? peek.lines : t.preview;
        return {
          key: `terminal:${t.id}`,
          name: t.name,
          kind: kindOf(t.name),
          state: recent(peek?.at || 0) ? "active" : "running",
          line: lines?.[lines.length - 1],
          at: peek?.at || 0,
          open: () => openTerminal(t.id),
        };
      }),
    ...mac.tabs.filter((t) => !reachOwnWindow(t.name)).map((t): Story => {
      const peek = mac.peeks[t.id];
      return {
        key: `mac:${t.id}`,
        name: t.name || "Terminal",
        kind: kindOf(t.name || ""),
        mac: true,
        state: recent(peek?.at || 0) ? "active" : "running",
        line: peek?.line,
        at: peek?.at || 0,
        open: () => openMacTab(t.id),
      };
    }),
    // Agent sessions working anywhere on the computer: apps, terminals,
    // Reach. Just finished (or failed): kept a few minutes, so you see it.
    ...(openAgentSession ? agentSessions : [])
      .filter((s) => !s.archived && (s.live || s.status !== "idle" || now - s.updatedAt < DONE_MS))
      .map((s): Story => ({
        key: `agent:${s.agent}:${s.id}`,
        name: s.title,
        kind: s.agent,
        state:
          s.status === "waiting"
            ? "attention"
            : s.status === "running"
              ? "active"
              : now - s.updatedAt < DONE_MS
                ? s.status === "error"
                  ? "failed"
                  : "done"
                : "running",
        line: s.preview,
        at: s.updatedAt,
        open: () => openAgentSession!(s),
      })),
  ];
  // What needs you first, then what is printing right now, newest first.
  const rank = { attention: 0, failed: 1, active: 2, done: 3, running: 4, idle: 5 };
  stories.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
  // At most six agent sessions, chosen after ranking so attention is never cut.
  let agentShown = 0;
  const shown = stories.filter((s) => !s.key.startsWith("agent:") || ++agentShown <= 6);
  // Nothing running: no row at all (Home stays quiet). Once something runs,
  // ＋ leads the row to start another.
  if (!shown.length) return null;
  const canStart = !!onStart && (features.terminal || features.desktopTerminals);
  return (
    <section className="home-section" aria-label={`Live on your ${word}`}>
      <header>
        <h2>Live on your {word}</h2>
      </header>
      <div className="home-stories">
        {canStart && (
          <button className="story" onClick={onStart}>
            <span className="story-ring new">
              <span>
                <Plus size={24} />
              </span>
            </span>
            <small>New</small>
          </button>
        )}
        {shown.map((story) => (
          <button
            key={story.key}
            className="story"
            aria-label={`${story.name}${story.mac ? `, on your ${word}` : ""}${story.state === "attention" ? ", needs you" : story.state === "active" ? ", working" : story.state === "done" ? ", done" : story.state === "failed" ? ", stopped with an error" : ""}`}
            onClick={story.open}
          >
            <span className={`story-ring ${story.state}`}>
              <span>
                <Glyph kind={story.kind} logos={logos} />
              </span>
              {/* The computer's own window: "Mac" or "PC", the short word. */}
              {story.mac && <i className="story-badge">{word.split(" ").pop()}</i>}
              {story.state === "done" && (
                <i className="story-mark">
                  <Check size={11} strokeWidth={3} />
                </i>
              )}
              {story.state === "failed" && <i className="story-mark">!</i>}
            </span>
            <small>{story.name}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
