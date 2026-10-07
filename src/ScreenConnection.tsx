import { useContext, useEffect, useState } from "react";
import { ReachScene } from "./ReachIdentity";
import { MotionContext } from "./motion";

/** The live canvas appears immediately; the decorative courier finishes above it. */
export default function ScreenConnection({
  active,
  ready = false,
}: {
  active: boolean;
  ready?: boolean;
}) {
  const motion = useContext(MotionContext);
  const animateFinish =
    ready && motion.enabled && !motion.reduced && !motion.hidden;
  const [visible, setVisible] = useState(active);
  useEffect(() => {
    if (active) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(false), animateFinish ? 720 : 0);
    return () => clearTimeout(timer);
  }, [active, animateFinish]);
  if (!active && (!visible || !animateFinish)) return null;
  return (
    <div
      className={`screen-connection ${active ? "" : "is-finishing"}`}
      role="status"
      aria-live="polite"
    >
      <div className="screen-connection-content">
        <ReachScene
          mode="loading"
          connected={!active && ready}
          className="connection-device"
        />
        <div className="screen-connection-copy">
          <span className="screen-connection-eyebrow">
            {active ? "MAKING THE CONNECTION" : "CONNECTED"}
          </span>
          <strong>
            {active ? "Bringing your screen closer" : "All plugged in."}
            <span className="screen-connection-dots" aria-hidden="true">
              ...
            </span>
          </strong>
          <span>
            {active
              ? "Just getting the cable sorted."
              : "Your computer, right here."}
          </span>
        </div>
      </div>
    </div>
  );
}
