import { useContext, useEffect, useState, type CSSProperties } from "react";
import { MotionContext } from "./motion";
import { BrandCourier } from "./ReachIdentity";
import "./living-logo.css";

// Short acts the logo plays now and then, picked at random. Each is pure CSS,
// keyed on data-act; this only chooses one and clears it when it ends.
const ACTS = {
  flashlight: 3400, // the word goes dark; a beam reveals letters; lights on
  wave: 1900, // letters jump one after another; the mascot hops
  typewriter: 2900, // the word retypes itself behind a terminal cursor
  snooze: 3600, // the mascot dozes off, z's float up, then it jolts awake
} as const;
type Act = keyof typeof ACTS;
const WORD = "reach";

export default function LivingLogo({ companion = false }: { companion?: boolean }) {
  const motion = useContext(MotionContext);
  const live = motion.enabled && !motion.reduced && !motion.hidden;
  const [act, setAct] = useState<Act | "">("");
  useEffect(() => {
    if (!live) {
      setAct("");
      return;
    }
    let last: Act | "" = "",
      timer: ReturnType<typeof setTimeout>;
    const names = Object.keys(ACTS) as Act[];
    const next = (delay: number) => {
      timer = setTimeout(() => {
        // Never the same act twice in a row.
        const choices = names.filter((name) => name !== last);
        const chosen = choices[Math.floor(Math.random() * choices.length)];
        last = chosen;
        setAct(chosen);
        timer = setTimeout(() => {
          setAct("");
          next(6000 + Math.random() * 7000);
        }, ACTS[chosen]);
      }, delay);
    };
    next(2500 + Math.random() * 2000);
    return () => clearTimeout(timer);
  }, [live]);
  return (
    <div className="brand living-brand" data-act={act || undefined}>
      <span className="brand-mark">
        <BrandCourier active={companion} />
        <i className="brand-z" aria-hidden="true">
          <b>z</b>
          <b>z</b>
          <b>Z</b>
        </i>
      </span>
      <span className="brand-word" aria-label="reach">
        <span className="brand-word-dim" aria-hidden="true">
          {WORD}
        </span>
        <span className="brand-word-lit" aria-hidden="true">
          {[...WORD].map((letter, i) => (
            <span key={i} className="brand-letter" style={{ "--i": i } as CSSProperties}>
              {letter}
            </span>
          ))}
          <span className="brand-cursor" />
        </span>
        <span className="brand-beam" aria-hidden="true" />
        <span className="brand-torch" aria-hidden="true" />
      </span>
    </div>
  );
}
