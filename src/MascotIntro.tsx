import { useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionContext } from "./motion";
import { Computer, ReachMark } from "./ReachIdentity";
import "./mascot-intro.css";

// The first time someone opens Reach (after scanning the computer's code, or
// from an invitation), a short scene before the connect page, at a calm,
// human pace: a black screen; a spotlight slowly comes up and the mascot
// walks into it; it clicks on a flashlight, looks around, and finds the Reach
// logo at its feet. The lights come on: a laptop (the one on the welcome
// page, smaller) stands beside it, its screen off. The mascot picks up
// Reach's plug, walks the cable over and plugs it in; the screen comes on;
// it waves, and the page appears. About 15 s,
// CSS only; Skip (or a tap) ends it. Shown once on each phone, never with
// reduced motion.
const SEEN = "reach.intro.v1";

function firstTime() {
  try {
    if (localStorage.getItem(SEEN) === "seen") return false;
    localStorage.setItem(SEEN, "seen");
    return true;
  } catch {
    return false;
  }
}

// Once it starts, the scene plays in its own layer on the page, so the page
// that started it can go away underneath: an invitation is accepted in about
// a second and its page makes way for Reach, which used to cut the scene off
// (already counted as seen, it never came back).
let playing = false;
export default function MascotIntro() {
  const motion = useContext(MotionContext);
  useEffect(() => {
    if (playing) return;
    const quiet =
      !motion.enabled ||
      motion.reduced ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (quiet || !firstTime()) return;
    playing = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const layer = createRoot(host);
    layer.render(
      <IntroScene
        onDone={() =>
          setTimeout(() => {
            layer.unmount();
            host.remove();
            playing = false;
          })
        }
      />,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function IntroScene({ onDone }: { onDone: () => void }) {
  const [show, setShow] = useState(true);
  useEffect(() => {
    if (!show) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // It ends with its own fade, so a phone that pauses it in the background
  // picks up where it was.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const ended = (event: AnimationEvent) => {
      if (
        event.target === element &&
        ["intro-out", "intro-skip"].includes(event.animationName)
      )
        setShow(false);
    };
    element.addEventListener("animationend", ended);
    return () => element.removeEventListener("animationend", ended);
  }, [show]);
  // Only a guard against animations never running; it counts while the page
  // is visible, as the animation does.
  useEffect(() => {
    if (!show) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (!document.hidden)
        timer = setTimeout(() => setShow(false), leaving ? 1000 : 20000);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [show, leaving]);
  if (!show) return null;
  return (
    <div
      ref={root}
      className={`mascot-intro ${leaving ? "leaving" : ""}`}
      role="presentation"
      onClick={() => setLeaving(true)}
    >
      <div className="intro-stage">
        <svg className="intro-world" viewBox="0 0 320 280" aria-hidden="true">
          <path
            d="M10 200H310"
            stroke="#2c3a31"
            strokeWidth="2"
            strokeDasharray="3 6"
          />
          {/* Beside it, in the dark: the laptop, screen off until Reach is
              plugged into its side. */}
          <g className="intro-mac">
            <g transform="translate(214 133.3) scale(0.48)">
              <Computer x={0} y={0} />
              <path
                className="intro-mac-off"
                d="M15 13H157V99H15Z"
                fill="#0c1410"
              />
            </g>
          </g>
          {/* At its feet: Reach, and the cable it carries to the laptop. */}
          <g className="intro-logo">
            <svg x="102" y="212" width="28" height="28" viewBox="0 0 32 32">
              <ReachMark />
            </svg>
            <text x="134" y="234">
              reach
            </text>
          </g>
          <g
            className="intro-cable"
            fill="none"
            stroke="#8fd3a8"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <path
              className="intro-cable-up"
              d="M126 234C138 236 116 182 123.9 168.4"
            />
            <path className="intro-cable-run" d="M123.9 168.4H199.9" />
          </g>
          <g
            className="intro-plugged"
            transform="translate(76 0) rotate(136 105.6 149.4)"
          >
            <g
              transform="translate(88 200) scale(2.2)"
              shapeRendering="crispEdges"
            >
              <path d="M6.5 -41H9.5V-35H6.5Z" fill="#cfd8d2" />
              <path
                d="M6.8 -44H7.6V-41H6.8ZM8.4 -44H9.2V-41H8.4Z"
                fill="#7b8a80"
              />
            </g>
          </g>
          <g
            className="intro-spark"
            stroke="#f4ffd8"
            strokeWidth="3"
            strokeLinecap="round"
          >
            <path d="M211 176L206 168M217 176L222 168M211 189L206 197M217 189L222 197" />
          </g>
          {/* The mascot is in the dark too: seen only where light falls. */}
          <g className="intro-walker">
            <g className="intro-body">
              {/* The arm turns with the beam; it holds the flashlight, then
                  Reach's plug. */}
              <g className="intro-arm">
                <g
                  transform="translate(88 200) scale(2.2)"
                  shapeRendering="crispEdges"
                >
                  <path d="M8 -23V-35" stroke="#b9efd4" strokeWidth="4" />
                  <g className="intro-flashlight">
                    <path d="M6 -44H10V-35H6Z" fill="#53635a" />
                    <path
                      className="intro-lens"
                      d="M5 -47H11V-44H5Z"
                      fill="#fff3bf"
                    />
                  </g>
                  <g className="intro-hand-plug">
                    <path d="M6.5 -41H9.5V-35H6.5Z" fill="#cfd8d2" />
                    <path
                      d="M6.8 -44H7.6V-41H6.8ZM8.4 -44H9.2V-41H8.4Z"
                      fill="#7b8a80"
                    />
                  </g>
                </g>
              </g>
              <g
                transform="translate(88 200) scale(2.2)"
                shapeRendering="crispEdges"
              >
                <ellipse cy="1" rx="11" ry="2" fill="#000" opacity=".35" />
                <g fill="none" strokeWidth="4" strokeLinejoin="bevel">
                  <path
                    className="intro-leg intro-leg-back"
                    d="M-4 -9L-7 -4L-4 0"
                    stroke="#a6bea7"
                  />
                  <path
                    className="intro-leg intro-leg-front"
                    d="M4 -9L7 -4L4 0"
                    stroke="#e0edd6"
                  />
                </g>
                <g className="intro-bob">
                  <path
                    d="M-8 -23L-12 -17L-11 -11"
                    fill="none"
                    stroke="#8bcca8"
                    strokeWidth="4"
                    strokeLinejoin="bevel"
                  />
                  <path d="M-17 -28H-12V-12H-17Z" fill="#618c70" />
                  <path d="M-7 -21H8V-9H-7Z" fill="#88c7a1" />
                  <path d="M-3 -19H4V-16H-3Z" fill="#d1f6d8" />
                  <path
                    d="M-9 -43H9V-39H13V-25H9V-21H-9V-25H-13V-39H-9Z"
                    fill="#b9efd4"
                  />
                  <path d="M-9 -41H9V-38H-9Z" fill="#e2ffe6" />
                  <path d="M-8 -35H8V-27H-8Z" fill="#173a2b" />
                  <g className="intro-eyes" fill="#f1f3dd">
                    <path d="M-5 -34H-2V-30H-5ZM3 -34H6V-30H3Z" />
                  </g>
                </g>
              </g>
            </g>
            <g className="intro-bubble intro-what">
              <text x="94" y="95">
                ?
              </text>
            </g>
            <g className="intro-bubble intro-found">
              <text x="94" y="95">
                !
              </text>
            </g>
          </g>
        </svg>
      </div>
      {/* The dark, with the spotlight and the flashlight cut out of it, and
          the haze of both lights over it. */}
      <div className="intro-dark" aria-hidden="true" />
      <div className="intro-under" aria-hidden="true" />
      <div className="intro-haze" aria-hidden="true" />
      <div className="intro-torch" aria-hidden="true" />
      <button
        type="button"
        className="intro-skip-button"
        onClick={(event) => {
          event.stopPropagation();
          setLeaving(true);
        }}
      >
        Skip
      </button>
    </div>
  );
}
