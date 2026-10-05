import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { DesktopAction, InputResult } from "./desktop-input-queue";
import "./scroll-handle.css";
import { DEAD_ZONE, STEP, TICK, TRAVEL, scrollSpeed } from "./scroll-speed";

// A scroll joystick on the right edge of the remote screen: press and hold,
// then move up or down. The further from where you pressed, the faster it
// scrolls; let go to stop. A quick tap on an arrow scrolls one step.
export default function ScrollHandle({
  send,
  disabled,
}: {
  send: (action: DesktopAction) => Promise<InputResult>;
  disabled: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState(false);
  const press = useRef<{
    id: number;
    startY: number;
    at: number;
    offset: number;
    moved: boolean;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);
  const scroll = (dy: number) => {
    if (dy) void send({ type: "scroll", dx: 0, dy }).catch(() => {});
  };
  const release = () => {
    const p = press.current;
    if (!p) return;
    clearInterval(p.timer);
    press.current = null;
    setActive(false);
    setOffset(0);
    return p;
  };
  useEffect(() => () => void release(), []);
  return (
    <div
      className={`scroll-handle ${active ? "active" : ""}`}
      data-immersive-keep
      role="slider"
      aria-label="Scroll the computer screen. Press and drag up or down."
      aria-orientation="vertical"
      aria-valuemin={-TRAVEL}
      aria-valuemax={TRAVEL}
      aria-valuenow={offset}
      aria-disabled={disabled}
      onPointerDown={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* Capture is a convenience; scrolling still works without it. */
        }
        release();
        press.current = {
          id: event.pointerId,
          startY: event.clientY,
          at: performance.now(),
          offset: 0,
          moved: false,
          timer: setInterval(() => {
            const p = press.current;
            if (p) scroll(scrollSpeed(p.offset));
          }, TICK),
        };
        setActive(true);
      }}
      onPointerMove={(event) => {
        const p = press.current;
        if (!p || p.id !== event.pointerId) return;
        const next = Math.max(-TRAVEL, Math.min(TRAVEL, event.clientY - p.startY));
        if (Math.abs(next) > DEAD_ZONE) p.moved = true;
        p.offset = next;
        setOffset(next);
      }}
      onPointerUp={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const p = release();
        // A quick tap without dragging scrolls one step toward the tapped arrow.
        if (p && !p.moved && performance.now() - p.at < 350) {
          const up = p.startY < box.top + box.height / 2;
          scroll(up ? STEP : -STEP);
          scroll(up ? STEP : -STEP);
        }
      }}
      onPointerCancel={() => release()}
      onLostPointerCapture={() => release()}
    >
      {/* A slim line at rest; it opens into a small pill only while held. */}
      <span className="scroll-grip">
        <ChevronUp size={14} aria-hidden="true" />
        <span
          className="scroll-thumb"
          style={{ transform: `translateY(${offset}px)` }}
        />
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div>
  );
}
