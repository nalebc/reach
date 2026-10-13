import {
  Hand,
  HandGrab,
  MousePointer2,
  Move,
  MoveVertical,
  ZoomIn,
  ArrowUp,
  ChevronsUp,
} from "lucide-react";
import "./screen-gesture.css";

export type GestureFeedback = {
  kind:
    | "hold"
    | "grabbing"
    | "held"
    | "drag"
    | "two"
    | "scroll"
    | "coast"
    | "pan"
    | "zoom";
  point: { x: number; y: number };
  angle?: number;
  fast?: boolean;
};
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(Math.max(min, max), n));
const labels = {
  hold: "Keep holding to drag",
  grabbing: "Grabbing. Keep your finger down",
  held: "Held. Drag to move",
  drag: "Dragging. Lift to drop",
  two: "Move two fingers together to scroll",
  scroll: "Scrolling. Lift to coast",
  coast: "Scrolling with momentum. Touch to stop",
  pan: "Moving view. Two fingers to scroll",
  zoom: "Zooming. Move fingers apart or together",
} as const;

export default function ScreenGestureFeedback({
  feedback,
  width,
  height,
}: {
  feedback: GestureFeedback;
  width: number;
  height: number;
}) {
  const { kind, point, angle = 0, fast = false } = feedback;
  const diameter = Math.max(16, Math.min(40, width - 8, height - 8)),
    edge = diameter / 2 + 4;
  const finger = { x: clamp(point.x, 0, width), y: clamp(point.y, 0, height) };
  // Above the thumb whenever there is room. At the top edge, step to the
  // side instead; clamping above it would put the icon under the thumb.
  const above = finger.y >= 64 + edge;
  const x = clamp(
      above ? finger.x : finger.x + (finger.x < width / 2 ? 64 : -64),
      edge,
      width - edge,
    ),
    y = clamp(above ? finger.y - 64 : finger.y, edge, height - edge);
  const hold = kind === "hold";
  const scrolling = kind === "scroll" || kind === "coast";
  const Icon = scrolling
    ? fast
      ? ChevronsUp
      : ArrowUp
    : kind === "two"
      ? MoveVertical
      : kind === "pan"
        ? Move
        : kind === "zoom"
          ? ZoomIn
          : kind === "grabbing"
            ? MousePointer2
            : HandGrab;
  return (
    <div className={`screen-gesture-feedback ${kind}${fast ? " fast" : ""}`}>
      <span
        className="screen-gesture-marker"
        aria-hidden="true"
        style={{ left: x, top: y, width: diameter, height: diameter }}
      >
        {hold ? (
          <>
            <svg viewBox="0 0 48 48" className="screen-hold-progress">
              <circle className="track" cx="24" cy="24" r="20" />
              <circle
                className="progress"
                cx="24"
                cy="24"
                r="20"
                pathLength="1"
              />
            </svg>
            <Hand size={16} />
          </>
        ) : (
          <Icon
            size={20}
            style={scrolling ? { transform: `rotate(${angle}deg)` } : undefined}
          />
        )}
      </span>
      <span role="status" className="screen-gesture-status">
        {labels[kind]}
      </span>
    </div>
  );
}
