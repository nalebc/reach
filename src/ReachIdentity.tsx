import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { MotionContext } from "./motion";
import CourierActor from "./CourierActor";

export function ReachMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M6 25V13a7 7 0 0 1 7-7h5v7h-5v12M18 9h4a5 5 0 0 1 5 5v6"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M23 20h8v6h-8z" fill="currentColor" />
      <path d="M25 26v3m4-3v3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function Courier() {
  return (
    <g className="courier-sprite" shapeRendering="crispEdges">
      <path d="M-5 15H0V32H-5Z" fill="#648b78" />
      <g className="courier-bob">
        <path d="M4 3H22V7H26V21H22V25H4V21H0V7H4Z" fill="#b9efd4" />
        <path d="M4 5H22V8H4Z" fill="#e1ffe9" />
        <path d="M5 11H21V19H5Z" fill="#16362c" />
        <path
          className="courier-eyes"
          d="M8 12H11V16H8ZM16 12H19V16H16Z"
          fill="#f2f1dc"
        />
        <path d="M6 25H21V37H6Z" fill="#84c5a6" />
        <path d="M10 27H17V30H10Z" fill="#d4f7de" />
        <path
          className="courier-arm"
          d="M21 27H26V23H30V30H26V33H21Z"
          fill="#b9efd4"
        />
      </g>
      <path
        className="courier-leg-one"
        d="M6 36H12V43H3V40H6Z"
        fill="#d9e6d6"
      />
      <path
        className="courier-leg-two"
        d="M16 36H22V40H25V43H16Z"
        fill="#88a592"
      />
    </g>
  );
}
export function Computer({
  x,
  y,
  scale = 1,
  open = false,
}: {
  x: number;
  y: number;
  scale?: number;
  /** Leave the display see-through so a live screen can show beneath it. */
  open?: boolean;
}) {
  if (open)
    return (
      <g
        transform={`translate(${x} ${y}) scale(${scale})`}
        shapeRendering="crispEdges"
      >
        <path
          d="M8 0H164V5H169V112H3V5H8ZM15 13V99H157V13Z"
          fill="#71867b"
          fillRule="evenodd"
        />
        <path d="M9 7H163V105H9ZM15 13V99H157V13Z" fill="#101b18" fillRule="evenodd" />
        <path d="M3 112H169L189 130V135H-17V130Z" fill="#97a697" />
        <path d="M15 116H157L169 126H3Z" fill="#496153" />
        <path d="M65 127H106V131H65Z" fill="#c4d0bd" />
        <path d="M-12 135H184V139H-12Z" fill="#4b6657" />
      </g>
    );
  return (
    <g
      transform={`translate(${x} ${y}) scale(${scale})`}
      shapeRendering="crispEdges"
    >
      <path d="M8 0H164V5H169V112H3V5H8Z" fill="#71867b" />
      <path d="M9 7H163V105H9Z" fill="#101b18" />
      <path d="M15 13H157V99H15Z" fill="#1b3028" />
      <path d="M15 13H157V24H15Z" fill="#2b4438" />
      <path
        d="M20 17H23V20H20ZM27 17H30V20H27ZM34 17H37V20H34Z"
        fill="#8aab95"
      />
      <g className="pixel-screen-lines" fill="#b9efd4">
        <path d="M27 41H31V45H35V49H31V53H27V49H31V45H27ZM39 53H51V56H39Z" />
        <path d="M27 67H70V70H27ZM27 76H59V79H27Z" opacity=".35" />
      </g>
      <g className="pixel-screen-window">
        <path d="M101 39H140V80H96V45H101Z" fill="#60866e" />
        <path d="M102 49H134V74H102Z" fill="#a7d1ad" />
        <path d="M107 57H128V60H107ZM107 64H122V67H107Z" fill="#63886b" />
      </g>
      <path d="M3 112H169L189 130V135H-17V130Z" fill="#97a697" />
      <path d="M15 116H157L169 126H3Z" fill="#496153" />
      <path d="M65 127H106V131H65Z" fill="#c4d0bd" />
      <path d="M-12 135H184V139H-12Z" fill="#4b6657" />
      <path className="pixel-port" d="M0 99H7V106H0Z" fill="#c4f3d5" />
    </g>
  );
}

/** Small, code-native scene: no video download or animation library. */
export const ReachScene = memo(function ReachScene({
  mode = "journey",
  companion = true,
  className = "",
  connected = false,
  liveScreen = false,
}: {
  connected?: boolean;
  /** A live view of the computer is placed under the laptop's display. */
  liveScreen?: boolean;
  mode?: "journey" | "computer" | "loading";
  companion?: boolean;
  className?: string;
}) {
  const motion = useContext(MotionContext);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [finishFrom, setFinishFrom] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!connected) {
      setFinishFrom(null);
      return;
    }
    // Preserve the current walk position when a fast connection arrives midway.
    // Read once at handoff; CSS keeps all animation frames off the React loop.
    const courier = ref.current?.querySelector(".courier-travel");
    setFinishFrom(
      courier ? getComputedStyle(courier).transform : "translateX(106px)",
    );
  }, [connected]);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const playing =
    visible && motion.enabled && !motion.reduced && !motion.hidden;
  const single = mode === "computer";
  return (
    <div
      ref={ref}
      className={`reach-scene scene-${mode} ${playing ? "is-playing" : ""} ${connected && finishFrom ? "is-connected" : ""} ${className}`}
      style={
        { "--finish-from": finishFrom || "translateX(106px)" } as CSSProperties
      }
      aria-hidden="true"
    >
      <svg viewBox={single ? "0 -40 400 275" : "0 0 480 265"} fill="none">
        <g className="scene-specks" fill="currentColor">
          {Array.from({ length: liveScreen ? 0 : 24 }, (_, i) => (
            <rect
              key={i}
              x={25 + ((i * 67) % (single ? 350 : 430))}
              y={22 + ((i * 37) % 160)}
              width={i % 3 ? 2 : 3}
              height={i % 3 ? 2 : 3}
              style={{ "--phase": `${i * -0.37}s` } as CSSProperties}
            />
          ))}
        </g>
        <path
          d={single ? "M25 212H375" : "M20 224H460"}
          stroke="currentColor"
          strokeOpacity=".16"
          strokeDasharray="2 5"
        />
        {single ? (
          <>
            <g shapeRendering="crispEdges" fill="#304235">
              <path d="M97 185H331V190H97ZM115 190H121V212H115ZM305 190H311V212H305Z" />
            </g>
            <Computer x={119} y={32} scale={1.1} open={liveScreen} />
            {companion && <CourierActor playing={playing} />}
          </>
        ) : (
          <>
            <g shapeRendering="crispEdges">
              <path
                d="M37 146H76V151H81V214H76V219H37V214H32V151H37Z"
                fill="#8caa97"
              />
              <path d="M37 153H76V209H37Z" fill="#20372c" />
              <path d="M48 149H65V152H48Z" fill="#213b2e" />
              <g className="phone-signal" fill="#b9efd4">
                <path d="M45 189H50V200H45ZM54 181H59V200H54ZM63 173H68V200H63Z" />
              </g>
            </g>
            <path
              d="M81 199H96V218H237V167H265"
              stroke="#486c57"
              strokeWidth="3"
            />
            <path
              className="courier-current"
              d="M81 199H96V218H237V167H265"
              stroke="#c0f6d5"
              strokeWidth="3"
              pathLength="100"
            />
            <Computer x={265} y={64} />
            <g className="courier-travel">
              <g transform="translate(111 175)">
                {mode === "loading" ? (
                  <CourierActor playing={playing} connecting />
                ) : (
                  <Courier />
                )}
                <path
                  d="M27 27H33V17H39V-8H44"
                  stroke="#b9efd4"
                  strokeWidth="3"
                />
                <path d="M40 -12H48V-4H40Z" fill="#e2f7dd" />
              </g>
            </g>
            <path
              className="courier-spark"
              d="M249 151V143M240 155L235 150M250 177V185"
              stroke="#dcffbd"
              strokeWidth="3"
            />
            <text x="56" y="248" textAnchor="middle">
              YOU, ANYWHERE
            </text>
            <text x="350" y="248" textAnchor="middle">
              YOUR COMPUTER
            </text>
          </>
        )}
      </svg>
    </div>
  );
});

/** A brief welcome, not a loading gate: the interface is interactive immediately. */
export function ReachArrival() {
  const motion = useContext(MotionContext);
  const [show, setShow] = useState(() => {
    try {
      return sessionStorage.getItem("reach.arrival.v1") !== "seen";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!show) return;
    try {
      sessionStorage.setItem("reach.arrival.v1", "seen");
    } catch {
      /* optional */
    }
    const timer = setTimeout(() => setShow(false), 1600);
    return () => clearTimeout(timer);
  }, [show]);
  if (!show || motion.reduced || !motion.enabled || motion.hidden) return null;
  return (
    <div className="reach-arrival" aria-hidden="true">
      <ReachMark />
      <span>reach</span>
      <i />
    </div>
  );
}

export function BrandCourier({ active = false }: { active?: boolean }) {
  const motion = useContext(MotionContext);
  return (
    <svg className="brand-courier" viewBox="0 0 40 52" aria-hidden="true">
      <CourierActor
        greeting
        playing={active && motion.enabled && !motion.reduced && !motion.hidden}
      />
    </svg>
  );
}
