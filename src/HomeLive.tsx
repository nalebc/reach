import { useEffect, useRef, useState } from "react";
import { macTerminalsFingerprint } from "./mac-terminal-live";
import {
  Asterisk,
  Bell,
  ChevronRight,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Sparkles,
  Terminal,
  Upload,
  UserRoundPlus,
} from "lucide-react";
import {
  post,
  request,
  type AgentRequest,
  type Device,
  type Peer,
  type Session,
} from "./api";
import type { WorkspaceCapabilities } from "./capabilities";
import type { FleetConnections } from "./useFleetConnections";
import type { MacTerminal } from "./DesktopTerminals";
import { ReachScene } from "./ReachIdentity";
import type { AgentSession } from "./agent-sessions";
import { AgentLogo, useAgentLogos, type AgentLogos } from "./agent-logos";
import ScreenPopup from "./ScreenPopup";
import { useRemoteScreen } from "./useRemoteScreen";
import { useTerminalPeeks } from "./useTerminalPeeks";
import { useShortcuts } from "./shortcuts";
import ShortcutIcon from "./ShortcutIcon";
import "./home-live.css";

const agentName: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
};
// Output within this window makes a story ring spin.
const ACTIVE_MS = 4000;

// One circle in "Live on your Mac", like a story.
type Story = {
  key: string;
  name: string;
  kind: "codex" | "claude" | "shell" | "chat";
  mac?: boolean;
  state: "attention" | "active" | "running" | "idle";
  line?: string;
  at: number;
  open: () => void;
};
const kindOf = (name: string): Story["kind"] =>
  /claude/i.test(name) ? "claude" : /codex/i.test(name) ? "codex" : "shell";
// Codex, Claude Code and terminals wear their real app icons (from the Mac),
// filling the round frame.
const Glyph = ({ kind, logos = {} }: { kind: Story["kind"]; logos?: AgentLogos }) => {
  const icon = kind === "shell" ? "terminal" : kind;
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
const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 5
    ? "now"
    : s < 60
      ? `${s}s ago`
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : `${Math.floor(s / 3600)}h ago`;
};

function usePageVisible() {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}

// Tabs already open in Terminal on the Mac, with their last line. Terminal.app
// can only be read, not streamed, so tabs are read one after another.
function useMacTabs(
  peer: Peer,
  enabled: boolean,
  visible: boolean,
  changes?: string,
) {
  const [tabs, setTabs] = useState<MacTerminal[]>([]);
  const [peeks, setPeeks] = useState<Record<string, { line: string; at: number }>>({});
  const list = useRef<MacTerminal[]>([]);
  // A Mac that tells when its Terminal windows change is asked only then
  // (server/mac-terminal-watch.mjs); others every few seconds, as before.
  const pushed = macTerminalsFingerprint(changes);
  const told = pushed !== undefined;
  // A changed last line counts as new output.
  const note = (id: string, line: string) =>
    setPeeks((current) =>
      current[id]?.line === line
        ? current
        : { ...current, [id]: { line, at: current[id] ? Date.now() : 0 } },
    );
  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const r = await request<{ sessions: MacTerminal[] }>(
          peer,
          "/api/terminals/desktop",
        );
        if (stopped) return;
        list.current = r.sessions;
        setTabs(r.sessions);
      } catch {
        /* Permission or app missing: no Mac tabs on Home. */
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
      // Every tab's last line, answered by the Mac when one changes.
      const waits = new Set<AbortController>();
      void (async () => {
        let version = -1;
        while (!stopped) {
          const wait = new AbortController();
          waits.add(wait);
          const limit = setTimeout(() => wait.abort(), 30000);
          try {
            const r = await request<{
              version: number;
              peeks: Record<string, string>;
            }>(peer, `/api/terminals/desktop/activity?after=${version}`, {
              signal: wait.signal,
            });
            if (stopped) return;
            // Nothing new right away: never spin.
            if (r.version === version) await new Promise((r) => setTimeout(r, 1000));
            version = r.version;
            for (const [id, line] of Object.entries(r.peeks || {}))
              note(id, String(line));
          } catch (e) {
            if (stopped) return;
            if ((e as Error).name !== "AbortError")
              await new Promise((r) => setTimeout(r, 3000));
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
        const { text } = await request<{ text: string }>(
          peer,
          `/api/terminals/desktop/${tab.id}`,
        );
        if (stopped) return;
        note(
          tab.id,
          String(text)
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => /[\p{L}\p{N}]/u.test(l))
            .pop() || "",
        );
      } catch {}
    };
    const reader = setInterval(() => void read(), 900);
    return () => {
      stopped = true;
      clearInterval(reader);
    };
  }, [enabled, visible, peer.url, peer.token, told]);
  return { tabs: enabled ? tabs : [], peeks };
}

export default function HomeLive({
  features,
  device,
  peer,
  active,
  connections,
  connection,
  terminals,
  chats,
  pending,
  decide,
  navigate,
  openChat,
  openTerminal,
  openMacTab,
  agentSessions = [],
  openAgentSession,
  onShortcuts,
  refreshSessions,
  toast,
}: {
  features: WorkspaceCapabilities;
  device: Device;
  peer: Peer;
  active: string;
  connections: FleetConnections;
  connection: string;
  terminals: Session[];
  chats: Session[];
  pending: AgentRequest[];
  decide: (request: AgentRequest, decision: "approve" | "deny") => void;
  navigate: (page: string) => void;
  openChat: (id: string) => void;
  openTerminal: (id: string) => void;
  openMacTab: (id: string) => void;
  // Codex and Claude Code sessions anywhere on the Mac (the Chat feed).
  agentSessions?: AgentSession[];
  openAgentSession?: (session: AgentSession) => void;
  onShortcuts: () => void;
  refreshSessions: () => void;
  toast: (message: string) => void;
}) {
  const visible = usePageVisible();
  const logos = useAgentLogos(openAgentSession ? peer : null);
  const online = connections[active]?.state === "connected";
  // Live screen inside the laptop: the same stream as Screen, at preview size.
  const stream = useRemoteScreen(
    peer,
    features.screen,
    features.screen && visible,
    "primary",
    "preview",
    0,
    false,
  );
  const peeks = useTerminalPeeks(peer, features.terminal ? terminals : []);
  const mac = useMacTabs(
    peer,
    features.desktopTerminals,
    visible,
    connections[active]?.changes,
  );
  // Ages and spinning rings follow the clock.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  const waitingChats = features.codex
    ? chats.filter((c) => c.status === "waiting")
    : [];
  const waitingAgents = openAgentSession
    ? agentSessions.filter((s) => s.status === "waiting")
    : [];
  const needsYou =
    waitingChats.length + pending.length + waitingAgents.length > 0;
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
    ...mac.tabs.map((t): Story => {
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
    ...(features.codex ? chats : [])
      .filter((c) => ["waiting", "running", "starting", "idle"].includes(c.status))
      .slice(0, 4)
      .map(
        (c): Story => ({
          key: `chat:${c.id}`,
          name: c.name,
          kind: "chat",
          state:
            c.status === "waiting"
              ? "attention"
              : c.status === "idle"
                ? "idle"
                : "active",
          at: 0,
          open: () => openChat(c.id),
        }),
      ),
    // Agent sessions working anywhere on the Mac: apps, terminals, Reach.
    ...(openAgentSession ? agentSessions : [])
      .filter((s) => !s.archived && (s.live || s.status !== "idle"))
      .slice(0, 6)
      .map(
        (s): Story => ({
          key: `agent:${s.agent}:${s.id}`,
          name: s.title,
          kind: s.agent,
          state:
            s.status === "waiting"
              ? "attention"
              : s.status === "running"
                ? "active"
                : "running",
          line: s.preview,
          at: s.updatedAt,
          open: () => openAgentSession!(s),
        }),
      ),
  ];
  // What needs you first, then what is printing right now, newest first.
  const rank = { attention: 0, active: 1, running: 2, idle: 3 };
  stories.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
  const latest = stories
    .filter((s) => s.line && s.at)
    .sort((a, b) => b.at - a.at)[0];

  // ＋: start something, send a file, or open an app on the Mac.
  const [sheet, setSheet] = useState(false),
    [agents, setAgents] = useState<string[] | null>(null),
    [busy, setBusy] = useState("");
  useEffect(() => {
    if (!sheet || !features.terminal || agents) return;
    void request<{ agents: string[] }>(peer, "/api/terminals/agents")
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]));
  }, [sheet, features.terminal, peer.url]);
  const start = async (run?: string) => {
    setSheet(false);
    setBusy("start");
    try {
      const created = await post<Session>(peer, "/api/terminals", {
        root: 0,
        ...(run ? { run } : {}),
      });
      refreshSessions();
      openTerminal(created.id);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const { items: shortcuts } = useShortcuts(peer);
  // Codex and Claude Code already start above, in a Reach terminal.
  const apps = features.shortcuts
    ? shortcuts
        .filter((a) => (a.custom || a.suggested) && !a.id.startsWith("recipe:"))
        .slice(0, 8)
    : [];
  const fileInput = useRef<HTMLInputElement>(null);
  const send = async (files: FileList | null) => {
    const list = [...(files || [])];
    if (!list.length) return;
    setBusy("send");
    try {
      for (const file of list) {
        const form = new FormData();
        form.append("file", file);
        await request(peer, "/api/files/upload?root=0&path=", {
          method: "POST",
          body: form,
        });
      }
      const folder =
        device.roots[0]?.path.split(/[\\/]/).filter(Boolean).pop() || "Mac";
      toast(
        list.length === 1
          ? `Sent ${list[0].name} to ${folder}`
          : `Sent ${list.length} files to ${folder}`,
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const canStart = features.terminal || features.codex;
  const canPlus = canStart || features.writeFiles || apps.length > 0;
  const live = features.screen && stream.ready;
  return (
    <div className="home-live">
      <section className="home-hero">
        <button
          className="home-hero-scene"
          aria-label={
            features.screen ? `Open ${device.name}'s screen` : "Set up screen"
          }
          onClick={() => navigate(features.screen ? "screen" : "settings")}
        >
          {features.screen && (
            <canvas
              ref={stream.canvas}
              className={`home-peek ${live ? "is-live" : ""}`}
              aria-hidden="true"
            />
          )}
          <ReachScene
            mode="computer"
            companion
            liveScreen={live}
            className="home-scene"
          />
        </button>
        <div className="home-hero-text">
          <h1>{device.name}</h1>
          <p>
            <i className={`status-dot ${online ? "" : "off"}`} />
            {online ? "Online" : "Connecting…"} · {connection}
            {live ? " · live" : ""}
          </p>
        </div>
        {features.owner && (
          <button
            className="icon-button home-invite"
            aria-label="Invite someone"
            onClick={() => navigate("invite")}
          >
            <UserRoundPlus size={18} />
          </button>
        )}
      </section>

      {needsYou && (
        <section className="home-needs" aria-label="Needs you">
          {pending.map((r) => (
            <div className="home-need" key={r.id}>
              <Bell size={17} />
              <span>
                {r.name} wants access to {device.name}
              </span>
              <button className="button secondary small" onClick={() => decide(r, "deny")}>
                Deny
              </button>
              <button className="button primary small" onClick={() => decide(r, "approve")}>
                Allow
              </button>
            </div>
          ))}
          {waitingChats.map((c) => (
            <button className="home-need" key={c.id} onClick={() => openChat(c.id)}>
              <Bell size={17} />
              <span>{c.name} needs your approval</span>
              <strong>Review</strong>
            </button>
          ))}
          {waitingAgents.map((s) => (
            <button
              className="home-need"
              key={`${s.agent}:${s.id}`}
              onClick={() => openAgentSession?.(s)}
            >
              <Bell size={17} />
              <span>
                {s.title} · {s.agent === "codex" ? "Codex" : "Claude Code"} is
                waiting for you
              </span>
              <strong>Review</strong>
            </button>
          ))}
        </section>
      )}

      {(canPlus || stories.length > 0) && (
        <section className="home-section" aria-label="Live on your Mac">
          <header>
            <h2>Live on your Mac</h2>
          </header>
          <div className="home-stories">
            {canPlus && (
              <button
                className="story"
                aria-haspopup="dialog"
                onClick={() => setSheet(true)}
              >
                <span className="story-ring new">
                  <span>
                    {busy ? (
                      <Loader2 size={22} className="spin" />
                    ) : (
                      <Plus size={24} />
                    )}
                  </span>
                </span>
                <small>{stories.length ? "New" : "Start"}</small>
              </button>
            )}
            {stories.map((story) => (
              <button
                key={story.key}
                className="story"
                aria-label={`${story.name}${story.mac ? ", on your Mac" : ""}${story.state === "attention" ? ", needs you" : story.state === "active" ? ", working" : ""}`}
                onClick={story.open}
              >
                <span className={`story-ring ${story.state}`}>
                  <span>
                    <Glyph kind={story.kind} logos={logos} />
                  </span>
                  {story.mac && <i className="story-badge">Mac</i>}
                </span>
                <small>{story.name}</small>
              </button>
            ))}
            {!stories.length && canStart && (
              <p className="home-stories-hint">
                Start Codex, Claude Code or a terminal on {device.name}. It
                shows up here while it runs.
              </p>
            )}
          </div>
          {latest && (
            <button className="home-now" onClick={latest.open}>
              <ChevronRight size={15} />
              <strong>{latest.name}</strong>
              <code>{latest.line}</code>
              <small>{ago(latest.at, now)}</small>
            </button>
          )}
        </section>
      )}

      {sheet && (
        <ScreenPopup
          title="Start or send"
          className="home-plus"
          onClose={() => setSheet(false)}
        >
          {canStart && (
            <div className="home-plus-list">
              {features.terminal &&
                (agents ?? []).map((agent) => (
                  <button key={agent} onClick={() => void start(agent)}>
                    <span className="home-plus-icon">
                      <Glyph kind={agent === "claude" ? "claude" : "codex"} logos={logos} />
                    </span>
                    <span>
                      {agentName[agent] ?? agent}
                      <small>In a new terminal on {device.name}</small>
                    </span>
                  </button>
                ))}
              {features.terminal && (
                <button onClick={() => void start()}>
                  <span className="home-plus-icon">
                    <Terminal size={20} />
                  </span>
                  <span>
                    Terminal
                    <small>A new shell in your shared folder</small>
                  </span>
                </button>
              )}
              {features.codex && (
                <button
                  onClick={() => {
                    setSheet(false);
                    navigate("chat");
                  }}
                >
                  <span className="home-plus-icon">
                    <MessageSquare size={20} />
                  </span>
                  <span>
                    Codex chat
                    <small>Talk to Codex with approvals</small>
                  </span>
                </button>
              )}
            </div>
          )}
          {features.writeFiles && (
            <div className="home-plus-list">
              <button
                onClick={() => {
                  setSheet(false);
                  fileInput.current?.click();
                }}
              >
                <span className="home-plus-icon send">
                  <Upload size={20} />
                </span>
                <span>
                  Send a file
                  <small>
                    From this phone to{" "}
                    {device.roots[0]?.path.split(/[\\/]/).filter(Boolean).pop() ||
                      device.name}
                  </small>
                </span>
              </button>
            </div>
          )}
          {apps.length > 0 && (
            <>
              <header className="home-plus-heading">
                <span>Open on {device.name}</span>
                <button
                  className="home-edit"
                  onClick={() => {
                    setSheet(false);
                    onShortcuts();
                  }}
                >
                  <Pencil size={13} /> Edit
                </button>
              </header>
              <div className="home-plus-apps">
                {apps.map((shortcut) => (
                  <button
                    key={shortcut.id}
                    onClick={async () => {
                      setSheet(false);
                      try {
                        await post(peer, "/api/apps/shortcuts", {
                          id: shortcut.id,
                        });
                        toast(`${shortcut.name} opened on ${device.name}`);
                      } catch (e) {
                        toast((e as Error).message);
                      }
                    }}
                  >
                    <span>
                      <ShortcutIcon peer={peer} shortcut={shortcut} size={30} />
                    </span>
                    <small>{shortcut.name.replace(/^Open /, "")}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </ScreenPopup>
      )}
      {features.writeFiles && (
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => void send(e.target.files)}
        />
      )}
    </div>
  );
}
