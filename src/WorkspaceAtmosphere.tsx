import { useContext, useEffect, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { ReachArrival, ReachMark } from "./ReachIdentity";
import { MessageSquare, CircleAlert } from "lucide-react";
import { MotionContext } from "./motion";

export function WorkspaceAtmosphere({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem("reach.motion") !== "off";
    } catch {
      return true;
    }
  });
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener("change", preference);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", preference);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const toggle = () =>
    setEnabled((previous) => {
      try {
        localStorage.setItem("reach.motion", previous ? "off" : "on");
      } catch {
        /* Motion still works without storage. */
      }
      return !previous;
    });
  return (
    <MotionContext.Provider value={{ enabled, reduced, hidden, toggle }}>
      <div
        className={`reach-universe ${!enabled || reduced || hidden ? "motion-paused" : ""}`}
      >
        <div className="ambient-network" aria-hidden="true" />
        <ReachArrival />
        {children}
      </div>
    </MotionContext.Provider>
  );
}

export function MotionToggle() {
  const { enabled, reduced, toggle } = useContext(MotionContext);
  return (
    <button
      className="icon-button motion-toggle"
      aria-label={
        reduced
          ? "Motion disabled by your device’s accessibility setting"
          : enabled
            ? "Pause background animation"
            : "Play background animation"
      }
      title={
        reduced
          ? "Reduced motion is on"
          : enabled
            ? "Pause motion"
            : "Play motion"
      }
      aria-pressed={enabled && !reduced}
      disabled={reduced}
      onClick={toggle}
    >
      {enabled && !reduced ? <Pause size={15} /> : <Play size={15} />}
    </button>
  );
}

export function AgentAvatar({
  working = false,
  waiting = false,
}: {
  working?: boolean;
  waiting?: boolean;
}) {
  return (
    <span className="agent-avatar" aria-hidden="true">
      {working ? (
        <span className="agent-signal">
          <ReachMark />
        </span>
      ) : waiting ? (
        <CircleAlert size={21} />
      ) : (
        <MessageSquare size={20} />
      )}
    </span>
  );
}
