import { useContext } from "react";
import { MotionContext } from "./motion";
import "./mascot-typing.css";

// While an agent works: Reach's mascot sits cross-legged with a laptop on its
// lap, peeking over the screen and typing. Same pixel drawing as the courier
// (CourierActor.tsx). Its hands tap the keys, the screen's light flickers on
// its face, in pure CSS (mascot-typing.css). Still when motion is off or reduced.
export default function MascotTyping() {
  const motion = useContext(MotionContext);
  const playing = motion.enabled && !motion.reduced && !motion.hidden;
  return (
    <svg
      className={`mascot-typing ${playing ? "playing" : ""}`}
      viewBox="-19 -45 38 46"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      <ellipse cy="0" rx="17" ry="1.6" fill="#050d08" opacity=".22" />
      {/* The head, over the laptop's lid. */}
      <path d="M-9 -43H9V-39H13V-25H9V-21H-9V-25H-13V-39H-9Z" fill="#b9efd4" />
      <path d="M-9 -41H9V-38H-9Z" fill="#e2ffe6" />
      <path d="M-8 -35H8V-27H-8Z" fill="#173a2b" />
      {/* The screen's light on its face. */}
      <path className="mt-glow" d="M-8 -35H8V-27H-8Z" fill="#88c7a1" opacity="0" />
      {/* Looking down at the screen. */}
      <path className="mt-eyes" d="M-5 -31H-2V-28H-5ZM3 -31H6V-28H3Z" fill="#f1f3dd" />
      {/* Its arms go round the lid to the keys. */}
      <g fill="none" strokeWidth="4" strokeLinejoin="bevel">
        <path d="M-8 -22L-15 -17L-13 -12" stroke="#8bcca8" />
        <path d="M8 -22L15 -17L13 -12" stroke="#b9efd4" />
      </g>
      {/* The laptop on its lap: the lid's back, a soft Reach light on it. */}
      <path d="M-10 -25H10V-10H-10Z" fill="#3b4c43" />
      <path d="M-10 -25H10V-24H-10Z" fill="#5d7266" />
      <path className="mt-logo" d="M-2 -19H2V-16H-2Z" fill="#b9efd4" />
      <path d="M-16 -10H16V-7H-16Z" fill="#6b8274" />
      <path d="M-16 -7H16V-6H-16Z" fill="#2c3a33" />
      {/* Its hands on the keys, tapping in turn. */}
      <path className="mt-hand mt-left mt-a" d="M-15 -12H-11V-9H-15Z" fill="#8bcca8" />
      <path className="mt-hand mt-left mt-b" d="M-15 -14H-11V-11H-15Z" fill="#8bcca8" />
      <path className="mt-hand mt-right mt-a" d="M11 -14H15V-11H11Z" fill="#b9efd4" />
      <path className="mt-hand mt-right mt-b" d="M11 -12H15V-9H11Z" fill="#b9efd4" />
      {/* Sitting cross-legged under it: knees out, feet tucked in. */}
      <path d="M-18 -6H-6V-3H-2V0H-14V-3H-18Z" fill="#a6bea7" />
      <path d="M18 -6H6V-3H2V0H14V-3H18Z" fill="#e0edd6" />
    </svg>
  );
}
