import { computerWord } from "./pause";
import type { ReactNode } from "react";
import { FolderOpen, Monitor, Square, Check } from "lucide-react";
import type { Peer, Session } from "./api";
import type { MacTerminal } from "./DesktopTerminals";
import AppLogo from "./AppLogo";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import { Terminal } from "./ui";
import {
  AGENT_NAMES,
  describeMacTerminal,
  describeReachTerminal,
  type Agent,
  type TerminalSummary,
} from "./terminal-titles";
import { useFirstTime } from "./first-time";
import "./terminal-list.css";

const MAC_APPS: Record<string, { id: string; name: string }> = {
  terminal: {
    id: "/System/Applications/Utilities/Terminal.app",
    name: "Terminal",
  },
  iterm2: { id: "/Applications/iTerm.app", name: "iTerm2" },
};

// Every terminal in one place, grouped by where it lives: shells started from
// this phone, then windows already open on the Mac. Each row reads as
// "what it is" over "where and what's running", with the real app's logo.
export default function TerminalList({
  peer,
  logos,
  sessions,
  macTabs,
  macLoaded,
  macError,
  macHidden = 0,
  showMac,
  currentKey,
  agents,
  starting,
  onStart,
  onFolder,
  onOpen,
  onOpenMac,
  onEnd,
  onShowOnScreen,
  onCloseMac,
}: {
  peer: Peer;
  logos: AgentLogos;
  sessions: Session[];
  macTabs: MacTerminal[];
  macLoaded: boolean;
  macError: string;
  // Consoles running as administrator, which a Windows PC can't show.
  macHidden?: number;
  showMac: boolean;
  currentKey: string;
  // Agents installed on the computer; null while still checking. Without
  // `onStart`, the list only switches between terminals.
  agents?: string[] | null;
  starting?: boolean;
  onStart?: (agent?: string) => void;
  onFolder?: () => void;
  onOpen: (id: string) => void;
  onOpenMac: (tab: MacTerminal) => void;
  onEnd: (id: string) => void;
  onShowOnScreen?: (tab: MacTerminal) => void;
  onCloseMac?: (tab: MacTerminal) => void;
}) {
  const icon = (summary: TerminalSummary, mac?: MacTerminal) =>
    summary.agent ? (
      <AgentLogo agent={summary.agent} logos={logos} size={34} />
    ) : mac && MAC_APPS[mac.provider] ? (
      <AppLogo
        peer={peer}
        appId={MAC_APPS[mac.provider].id}
        name={MAC_APPS[mac.provider].name}
        size={34}
        fallback={
          <span className="terminal-glyph" aria-hidden="true">
            <Terminal size={18} />
          </span>
        }
      />
    ) : (
      <span className="terminal-glyph" aria-hidden="true">
        <Terminal size={18} />
      </span>
    );
  const row = (
    key: string,
    summary: TerminalSummary,
    open: () => void,
    extra: ReactNode,
    mac?: MacTerminal,
  ) => {
    const current = key === currentKey;
    return (
      <li key={key} className={`terminal-row ${current ? "current" : ""}`}>
        <button
          className="terminal-row-main"
          aria-current={current}
          onClick={open}
        >
          <span className="terminal-row-icon">{icon(summary, mac)}</span>
          <span className="terminal-row-text">
            <strong>{summary.title}</strong>
            <small>{summary.detail}</small>
          </span>
          {current && (
            <Check
              className="terminal-row-check"
              size={17}
              aria-label="Open now"
            />
          )}
        </button>
        {extra}
      </li>
    );
  };
  // First visit only: say what the start row does.
  const [hint, hintSeen] = useFirstTime("terminal-start");
  const begin = (agent?: string) => {
    hintSeen();
    onStart?.(agent);
  };
  const shells = sessions.filter(
    (s) => s.status === "running" || `reach:${s.id}` === currentKey,
  );
  const nothing =
    !shells.length &&
    (!showMac || (macLoaded && !macTabs.length && !macError && !macHidden));
  return (
    <div className="terminal-list">
      {onStart && (
        <div
          className="terminal-quick"
          role="group"
          aria-label="Start a terminal"
        >
          <button
            className={hint ? "hinted" : ""}
            disabled={starting}
            onClick={() => begin()}
          >
            <span className="terminal-glyph" aria-hidden="true">
              <Terminal size={18} />
            </span>
            Terminal
          </button>
          {(agents ?? []).map((agent) => (
            <button
              key={agent}
              disabled={starting}
              onClick={() => begin(agent)}
            >
              <AgentLogo agent={agent} logos={logos} size={34} />
              {AGENT_NAMES[agent as Agent] ?? agent}
            </button>
          ))}
          {onFolder && (
            <button
              disabled={starting}
              onClick={() => {
                hintSeen();
                onFolder();
              }}
            >
              <span className="terminal-glyph quiet" aria-hidden="true">
                <FolderOpen size={18} />
              </span>
              Folder…
            </button>
          )}
        </div>
      )}
      {/* Said once: with nothing open, the empty note below says it. */}
      {onStart && hint && (shells.length > 0 || (showMac && macTabs.length > 0)) && (
        <button className="terminal-hint" onClick={hintSeen}>
          Tap one to open a terminal on your {computerWord(peer.platform)}. It
          keeps running when you leave.
        </button>
      )}
      {shells.length > 0 && (
        <section aria-label="From your phone">
          <h3>From your phone</h3>
          <ul className="terminal-group">
            {shells.map((s) => {
              const summary = describeReachTerminal(s);
              return row(
                `reach:${s.id}`,
                summary,
                () => onOpen(s.id),
                s.status === "running" && (
                  <button
                    className="terminal-row-action"
                    aria-label={`End ${s.name}`}
                    onClick={() => onEnd(s.id)}
                  >
                    <Square size={13} />
                  </button>
                ),
              );
            })}
          </ul>
        </section>
      )}
      {showMac && (macTabs.length > 0 || macError || !macLoaded || macHidden > 0) && (
        <section aria-label={`On your ${computerWord(peer.platform)}`}>
          <h3>On your {computerWord(peer.platform)}</h3>
          {macError ? (
            <p className="terminal-list-note">{macError}</p>
          ) : !macLoaded ? (
            <p className="terminal-list-note">
              {peer.platform === "win32"
                ? "Looking for Windows Terminal and console windows…"
                : "Looking for Terminal and iTerm2 windows…"}
            </p>
          ) : (
            <ul className="terminal-group">
              {macTabs.map((tab) =>
                row(
                  `mac:${tab.id}`,
                  describeMacTerminal(tab.name, tab.provider),
                  () => onOpenMac(tab),
                  <>
                    {onShowOnScreen && (
                      <button
                        className="terminal-row-action"
                        aria-label={`Show ${tab.name || "this window"} on Screen`}
                        onClick={() => onShowOnScreen(tab)}
                      >
                        <Monitor size={15} />
                      </button>
                    )}
                    {onCloseMac && (
                      <button
                        className="terminal-row-action"
                        aria-label={`Close ${tab.name || "this window"} on your ${computerWord(peer.platform)}`}
                        onClick={() => onCloseMac(tab)}
                      >
                        <Square size={13} />
                      </button>
                    )}
                  </>,
                  tab,
                ),
              )}
            </ul>
          )}
          {macHidden > 0 && (
            <p className="terminal-list-note">
              Terminals running as administrator on your{" "}
              {computerWord(peer.platform)} aren't shown: Windows keeps Reach
              out of them.
            </p>
          )}
        </section>
      )}
      {nothing && (
        <p className="terminal-list-note center">
          {onStart
            ? `Nothing open yet. Start one above; it keeps running on your ${computerWord(peer.platform)}.`
            : "Nothing open yet."}
        </p>
      )}
    </div>
  );
}
