import { useState } from "react";
import { ArrowRight, Bell, BellRing, LoaderCircle, RefreshCw } from "lucide-react";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import type { UsageLink } from "./agent-sessions";
import type { Peer } from "./api";
import { useNotifyBack } from "./notify-back";
import "./usage-strip.css";

// Out of usage: one slim line above the message box, not cards. What's out
// and until when, then the way to more: Upgrade, or a reset the account has
// (a first tap says what it does, the next one does it). Under it, the way
// on without waiting: Continue in another agent that has usage, which picks
// the chat up where it stopped and keeps working (the same two taps).
// Or wait: Notify me sends one notification when the limit is back.
// Auto-continue opens the provider order for switching on every limit.
export default function UsageStrip({
  text,
  upgrade,
  resets = 0,
  onReset,
  agent,
  from = "",
  continueIn = [],
  onContinue,
  onAutoContinue,
  logos = {},
  peer,
  session,
  notifyAsked = false,
}: {
  text: string;
  upgrade: UsageLink | null;
  resets?: number;
  onReset?: () => Promise<void>;
  agent: string;
  // The agent out of usage, by name, and the ones that can take the chat.
  from?: string;
  continueIn?: { agent: string; name: string }[];
  onContinue?: (to: string) => Promise<void>;
  onAutoContinue?: () => void;
  logos?: AgentLogos;
  // Where to ask for "Notify me when it's back", and whether it's asked.
  peer?: Peer;
  session?: string;
  notifyAsked?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The agent tapped once (it says what happens), then moving there.
  const [going, setGoing] = useState("");
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState("");
  const back = useNotifyBack(peer as Peer, agent, session, notifyAsked);
  const reset = async () => {
    setBusy(true);
    try {
      await onReset?.();
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };
  const go = async (to: string) => {
    setMoving(true);
    setProblem("");
    try {
      await onContinue?.(to);
    } catch (e) {
      setProblem((e as Error).message);
      setMoving(false);
    }
  };
  const target = continueIn.find((c) => c.agent === going);
  return (
    <>
      <div className="usage-strip" role="status">
        <span className="usage-strip-text">
          {asking ? "Use a rate limit reset now? It can’t be undone." : back.problem || text}
        </span>
        <span className="usage-strip-actions">
          {asking ? (
            <>
              <button disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy} onClick={() => void reset()}>
                {busy ? <LoaderCircle size={14} className="spin" /> : "Reset"}
              </button>
            </>
          ) : (
            <>
              {peer && (
                <button
                  className={back.on ? "usage-notify on" : "usage-notify"}
                  aria-pressed={back.on}
                  aria-label={back.on ? "Notifying when it’s back. Tap to stop." : "Notify me when it’s back"}
                  disabled={back.busy}
                  onClick={() => void back.toggle()}
                >
                  {back.busy ? <LoaderCircle size={14} className="spin" /> : back.on ? <BellRing size={14} /> : <Bell size={14} />}
                  {back.on ? "Notifying" : "Notify me"}
                </button>
              )}
              {!!resets && onReset && (
                <button onClick={() => setAsking(true)}>Reset</button>
              )}
              {upgrade && (
                <a href={upgrade.url} target="_blank" rel="noopener noreferrer">
                  {agent === "codex" ? "Upgrade" : "More usage"}
                </a>
              )}
            </>
          )}
        </span>
      </div>
      {((onContinue && continueIn.length > 0) || onAutoContinue) && (
        <div className="usage-continue" role="group" aria-label="Continue in another agent">
          {target ? (
            <>
              <span className="usage-continue-text">
                {problem ||
                  (moving
                    ? `Moving to ${target.name}…`
                    : `${target.name} picks up where ${from || "this chat"} stopped and keeps working. This chat stays as it is.`)}
              </span>
              <span className="usage-strip-actions">
                <button disabled={moving} onClick={() => (setGoing(""), setProblem(""))}>
                  Cancel
                </button>
                <button className="primary" disabled={moving} onClick={() => void go(target.agent)}>
                  {moving ? <LoaderCircle size={14} className="spin" /> : "Continue"}
                </button>
              </span>
            </>
          ) : (
            <>
              {onContinue && continueIn.map((c) => (
                <button key={c.agent} className="usage-continue-offer" onClick={() => setGoing(c.agent)}>
                  <AgentLogo agent={c.agent} name={c.name} logos={logos} size={18} />
                  <span>Continue in {c.name}</span>
                  <ArrowRight size={14} />
                </button>
              ))}
              {onAutoContinue && (
                <button className="usage-continue-offer usage-auto-continue" onClick={onAutoContinue}>
                  <RefreshCw size={16} />
                  <span>Auto-continue</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
