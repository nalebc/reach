import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { UsageLink } from "./agent-sessions";
import "./usage-strip.css";

// Out of usage: one slim line above the message box, not cards. What's out
// and until when, then the way to more: Upgrade, or a reset the account has
// (a first tap says what it does, the next one does it). Continuing in the
// other app is in the chat's ⋯ menu.
export default function UsageStrip({
  text,
  upgrade,
  resets = 0,
  onReset,
  agent,
}: {
  text: string;
  upgrade: UsageLink | null;
  resets?: number;
  onReset?: () => Promise<void>;
  agent: string;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      await onReset?.();
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };
  return (
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
  );
}
