import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import type { Peer } from "./api";
import { computerWord, setPaused } from "./pause";
import "./pause.css";

// Pause or resume Reach on the computer from the phone. The switch shows the
// new state at once and settles when the computer confirms it through its
// live connection (or after a moment, if that connection is down).
export function usePauseToggle(
  peer: Peer,
  paused: boolean,
  toast?: (message: string) => void,
) {
  const [want, setWant] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (want !== null && want === paused) setWant(null);
  }, [paused, want]);
  useEffect(() => () => clearTimeout(settle.current), []);
  const shown = want ?? paused;
  const toggle = async (value = !shown) => {
    if (busy) return;
    clearTimeout(settle.current);
    setWant(value);
    setBusy(true);
    try {
      await setPaused(peer, value);
      settle.current = setTimeout(() => setWant(null), 4000);
    } catch (e) {
      setWant(null);
      toast?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { paused: shown, busy, toggle };
}

// A small round button: pause when Reach is on, resume when it's paused.
export function PauseButton({
  peer,
  paused,
  platform,
  className = "",
  toast,
}: {
  peer: Peer;
  paused: boolean;
  platform?: string;
  className?: string;
  toast?: (message: string) => void;
}) {
  const pause = usePauseToggle(peer, paused, toast);
  const word = computerWord(platform);
  const label = pause.paused
    ? `Resume Reach on your ${word}`
    : `Pause Reach on your ${word}`;
  return (
    <button
      className={`icon-button pause-button ${pause.paused ? "is-paused" : ""} ${className}`}
      aria-label={label}
      aria-pressed={pause.paused}
      title={label}
      disabled={pause.busy}
      onClick={() => void pause.toggle()}
    >
      {pause.paused ? (
        <Play size={17} fill="currentColor" />
      ) : (
        <Pause size={17} fill="currentColor" />
      )}
    </button>
  );
}

// Where the screen or an app would be while Reach is paused. The owner can
// resume from here; invited people just see that it's paused.
export function PausedCover({
  peer,
  platform,
  owner,
  toast,
  children,
}: {
  peer: Peer;
  platform?: string;
  owner: boolean;
  toast?: (message: string) => void;
  // More ways out, such as back to Reach.
  children?: ReactNode;
}) {
  const pause = usePauseToggle(peer, true, toast);
  const word = computerWord(platform);
  return (
    <div className="paused-cover" role="status">
      <span className="paused-cover-icon" aria-hidden="true">
        <Pause size={20} fill="currentColor" />
      </span>
      <strong>Paused</strong>
      <small>
        {owner
          ? `Reach isn't using your ${word} right now.`
          : `Reach is paused on this ${word}.`}
      </small>
      {owner && (
        <button
          className="button primary small"
          disabled={pause.busy || !pause.paused}
          onClick={() => void pause.toggle(false)}
        >
          <Play size={15} fill="currentColor" /> Resume
        </button>
      )}
      {children}
    </div>
  );
}
