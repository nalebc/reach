import { useState } from "react";
import {
  ArrowUpRight,
  Bell,
  BellRing,
  Check,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { AgentLogo, type AgentLogos } from "./agent-logos";
import type { UsageLink } from "./agent-sessions";
import type { Peer } from "./api";
import { useNotifyBack } from "./notify-back";
import { shortReset } from "./usage";
import "./usage-strip.css";

// Common native limit messages repeat the heading. Keep their reset wording
// (it can be more precise than account health), and retain unfamiliar details.
function limitDetail(
  description: string | undefined,
  resetsAt: number | undefined,
) {
  const source = description?.trim();
  const stock =
    source &&
    /^you(?:['’]ve| have) hit (?:your|the) (?:(?:usage|session|weekly|daily|monthly|rate|message|plan)\s+)?limit\b/i.test(
      source,
    );
  if (stock && !/\b(?:admin|owner|contact|ask)\b/i.test(source)) {
    const reset = source.match(/\b(resets?|try again at)\s+(.+)$/i);
    if (reset) {
      let when = reset[2].replace(/\.$/, "").trim();
      const zone = when.match(/\s*\(([^()]+)\)$/);
      if (zone?.[1] === Intl.DateTimeFormat().resolvedOptions().timeZone)
        when = when.slice(0, zone.index).trim();
      when = when.replace(
        /(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/gi,
        (_, time: string, period: string) => `${time} ${period.toUpperCase()}`,
      );
      return /^try/i.test(reset[1])
        ? `Try again at ${when}`
        : `Resets ${/^\d/.test(when) ? "at " : ""}${when}`;
    }
    if (resetsAt) return `Resets at ${shortReset(resetsAt)}`;
    if (/limit[.!]?$/i.test(source)) return "Try again later";
  }
  return (
    source ||
    (resetsAt ? `Resets at ${shortReset(resetsAt)}` : "Try again later")
  );
}

// One usage card combines the provider's own limit message with recovery,
// notification and continuation actions.
export default function UsageStrip({
  text,
  description,
  upgrade,
  resets = 0,
  resetsAt,
  onReset,
  agent,
  from = "",
  continueIn = [],
  onContinue,
  onAutoContinue,
  autoContinueOn = false,
  continuation,
  logos = {},
  peer,
  session,
  notifyAsked = false,
}: {
  text: string;
  description?: string;
  upgrade: UsageLink | null;
  resets?: number;
  resetsAt?: number;
  onReset?: () => Promise<void>;
  agent: string;
  // The agent out of usage, by name, and the ones that can take the chat.
  from?: string;
  continueIn?: { agent: string; name: string }[];
  onContinue?: (to: string) => Promise<void>;
  onAutoContinue?: () => void;
  autoContinueOn?: boolean;
  continuation?: { agent: string; name: string; open: () => void };
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
  const target = !continuation && continueIn.find((c) => c.agent === going);
  const notification = peer && !asking && (
    <button
      className={`usage-notify${back.on ? " on" : ""}`}
      aria-pressed={back.on}
      aria-label={
        back.on
          ? "You’ll be notified when usage resets. Tap to turn off."
          : "Notify me when usage resets"
      }
      title={
        back.on
          ? "You’ll be notified when usage resets. Tap to turn off."
          : "Notify me when usage resets"
      }
      disabled={back.busy}
      aria-busy={back.busy}
      onClick={() => void back.toggle()}
    >
      {back.busy ? (
        <LoaderCircle size={18} className="spin usage-notify-spinner" />
      ) : back.on ? (
        <BellRing size={18} strokeWidth={1.75} />
      ) : (
        <Bell size={18} strokeWidth={1.75} />
      )}
      <span>{back.on ? "Notify on reset" : "Notify"}</span>
    </button>
  );
  return (
    <section className="usage-panel" aria-label="Usage limit">
      <div className="usage-strip">
        <div className="usage-copy">
          <strong className="usage-limit-title">Usage limit reached</strong>
          <span
            className="usage-strip-text"
            role="status"
            title={description || text}
            aria-label={
              !asking && !back.problem ? description || text : undefined
            }
          >
            {asking
              ? "Use a rate limit reset now? It can’t be undone."
              : back.problem || limitDetail(description, resetsAt)}
          </span>
        </div>
        <span className="usage-strip-actions">
          {asking ? (
            <>
              <button disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void reset()}
              >
                {busy ? <LoaderCircle size={14} className="spin" /> : "Reset"}
              </button>
            </>
          ) : (
            <>
              {!!resets && onReset && (
                <button onClick={() => setAsking(true)}>Reset</button>
              )}
              {upgrade && (
                <a
                  href={upgrade.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={agent === "codex" ? "Upgrade" : "Get more usage"}
                  title={agent === "codex" ? "Upgrade" : "Get more usage"}
                >
                  {agent === "codex" ? "Upgrade" : "Get more"}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              )}
            </>
          )}
        </span>
        <div className="usage-tools">
          {!(
            continuation ||
            (onContinue && continueIn.length > 0) ||
            onAutoContinue
          ) && notification}
          {(continuation ||
            (onContinue && continueIn.length > 0) ||
            onAutoContinue) && (
            <div
              className={`usage-continue${target ? " confirming" : ""}`}
              role="group"
              aria-label="Continue chat"
            >
              {continuation ? (
                <>
                  <button
                    className="usage-continue-offer usage-open-continuation"
                    aria-label={`Open in ${continuation.name}`}
                    title={`Open the existing chat in ${continuation.name}`}
                    onClick={continuation.open}
                  >
                    <AgentLogo
                      agent={continuation.agent}
                      name={continuation.name}
                      logos={logos}
                      size={18}
                    />
                    <span>Open {continuation.name}</span>
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </button>
                  {notification}
                </>
              ) : target ? (
                <>
                  <span className="usage-continue-text">
                    {problem ||
                      (moving
                        ? `Moving to ${target.name}…`
                        : `${target.name} picks up where ${from || "this chat"} stopped and keeps working. This chat stays as it is.`)}
                  </span>
                  <span className="usage-strip-actions">
                    <button
                      disabled={moving}
                      onClick={() => (setGoing(""), setProblem(""))}
                    >
                      Cancel
                    </button>
                    <button
                      className="primary"
                      disabled={moving}
                      onClick={() => void go(target.agent)}
                    >
                      {moving ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        "Continue"
                      )}
                    </button>
                  </span>
                </>
              ) : (
                <>
                  {onContinue &&
                    continueIn.map((c) => (
                      <button
                        key={c.agent}
                        className="usage-continue-offer"
                        aria-label={`Continue in ${c.name}`}
                        title={`Continue in ${c.name}`}
                        onClick={() => setGoing(c.agent)}
                      >
                        <AgentLogo
                          agent={c.agent}
                          name={c.name}
                          logos={logos}
                          size={18}
                        />
                        <span>{c.name}</span>
                        <ArrowUpRight size={16} aria-hidden="true" />
                      </button>
                    ))}
                  {notification}
                  {onAutoContinue && (
                    <button
                      className={`usage-continue-offer usage-auto-continue${autoContinueOn ? " on" : ""}`}
                      aria-pressed={autoContinueOn}
                      aria-haspopup="dialog"
                      aria-label={`Auto-continue, ${autoContinueOn ? "on" : "off"}. Opens settings`}
                      title={
                        autoContinueOn
                          ? "Auto-continue is on. Tap to change or turn off."
                          : "Set up auto-continue"
                      }
                      onClick={onAutoContinue}
                    >
                      {autoContinueOn ? (
                        <Check
                          className="usage-auto-check"
                          size={12}
                          strokeWidth={3}
                          aria-hidden="true"
                        />
                      ) : (
                        <RefreshCw
                          className="usage-auto-refresh"
                          size={18}
                          strokeWidth={1.75}
                          aria-hidden="true"
                        />
                      )}
                      <span>Auto-continue</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
