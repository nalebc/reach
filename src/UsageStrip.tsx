import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import type { UsageLink } from "./agent-sessions";
import "./usage-strip.css";

// Out of usage: one slim line above the message box, not cards. What's out
// and until when, then the way to more: Upgrade, or a reset the account has
// (a first tap says what it does, the next one does it). Under it, the way
// on without waiting: Continue in another agent that has usage, which picks
// the chat up where it stopped and keeps working (the same two taps).
export default function UsageStrip({
  text,
  upgrade,
  resets = 0,
  onReset,
  agent,
  from = "",
  continueIn = [],
  onContinue,
  logos = {},
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
  logos?: AgentLogos;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The agent tapped once (it says what happens), then moving there.
  const [going, setGoing] = useState("");
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState("");
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
          {asking ? "Use a rate limit reset now? It can’t be undone." : text}
        </span>
        <span className="usage-strip-actions">
          {asking ? (
            <>
              <button disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy} onClick={() => void reset()}>
                {busy ? <Loader2 size={14} className="spin" /> : "Reset"}
              </button>
            </>
          ) : (
            <>
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
      {onContinue && continueIn.length > 0 && (
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
                  {moving ? <Loader2 size={14} className="spin" /> : "Continue"}
                </button>
              </span>
            </>
          ) : (
            continueIn.map((c) => (
              <button key={c.agent} className="usage-continue-offer" onClick={() => setGoing(c.agent)}>
                <AgentLogo agent={c.agent} name={c.name} logos={logos} size={18} />
                <span>Continue in {c.name}</span>
                <ArrowRight size={14} />
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}
