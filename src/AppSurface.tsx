import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { DesktopAction } from "./desktop-input-queue";

// A Mac app's window, driven like a phone app: tap clicks, a swipe scrolls
// (with iOS-style momentum after a flick), touch-and-hold right-clicks or,
// when you then move, drags. Two fingers zoom and pan the view itself.
//
// Scrolling follows the finger at once: the picture moves locally and the
// Mac's frames catch up over the connection's delay, so the app feels like
// it runs here. Points are 0..1 across the window; `map` turns them into the
// Mac's display coordinates.
const SLOP = 8; // px before a touch becomes a swipe
const HOLD = 450; // ms for touch-and-hold
const DOUBLE = 300; // ms between taps of a double click
const DECELERATION = 0.998; // momentum kept per ms, as on iPhone
const FLICK = 0.1; // points per ms needed to keep scrolling after lifting
const FASTEST = 8; // points per ms; a flick never goes faster
const STOP = 0.01; // points per ms where momentum ends
const SAMPLE = 100; // ms of finger movement used for the flick's speed

type Point = { x: number; y: number };
type Gesture = {
  id: number;
  start: Point;
  last: Point;
  lastAt: number;
  at: Point; // display-normalized point under the finger at touch down
  spot: { u: number; v: number }; // 0..1 across the window at touch down
  kind: "pending" | "scroll" | "drag";
  held: boolean;
  stopper: boolean; // this touch stopped a fling; lifting it doesn't click
  samples: { t: number; x: number; y: number }[];
  phase: "began" | "changed";
};
const clamp = (n: number, low: number, high: number) =>
  Math.min(high, Math.max(low, n));

export default function AppSurface({
  canvas,
  width,
  height,
  ready,
  map,
  regionWidth,
  send,
  onTap,
  fieldAt,
  onField,
  latency = 0,
  typing = false,
  focus,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  width: number;
  height: number;
  ready: boolean;
  map: (u: number, v: number) => Point | null;
  regionWidth: number;
  send: (action: DesktopAction) => Promise<unknown>;
  onTap?: (point: Point) => void;
  // Whether a spot (0..1 across the window) is a text field the Mac reported.
  fieldAt?: (u: number, v: number) => boolean;
  // Called inside the tap on such a field: the keyboard can open right away.
  onField?: (point: Point) => void;
  // Round trip to the Mac in ms; local scrolling hands over in about that.
  latency?: number;
  typing?: boolean;
  // While typing: the tapped spot (0..1 down the window) stays above the keyboard.
  focus?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const follow = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [base, setBase] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [hold, setHold] = useState<Point | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{
    distance: number;
    mid: Point;
    view: typeof view;
  } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastTap = useRef({ at: 0, x: 0, y: 0 });
  const momentum = useRef(0);
  const wheeled = useRef(0);
  const field = useRef<Point | null>(null);
  // Local scrolling ahead of the video, in screen pixels, fading as frames
  // from the Mac catch up.
  const ahead = useRef({ x: 0, y: 0, frame: 0, at: 0 });
  const scale = useRef(1);
  scale.current = view.scale;
  const handover = clamp(latency + 40, 60, 400);
  const act = (action: DesktopAction) => void send(action).catch(() => {});

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () =>
      setArea({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The window fits the screen like a native app. While the keyboard is up
  // it keeps that size instead of shrinking into the space left.
  useEffect(() => {
    if (typing || !area.width || !area.height || !width || !height) return;
    const fit = Math.min(area.width / width, area.height / height);
    setBase({ width: width * fit, height: height * fit });
  }, [area.width, area.height, width, height, typing]);
  useEffect(() => {
    if (!typing) setView((v) => (v.scale === 1 ? { scale: 1, x: 0, y: 0 } : v));
  }, [typing]);
  useEffect(
    () => () => {
      cancelAnimationFrame(momentum.current);
      cancelAnimationFrame(ahead.current.frame);
      clearTimeout(holdTimer.current);
    },
    [],
  );

  const place = () => {
    const { x, y } = ahead.current;
    if (follow.current)
      follow.current.style.transform =
        x || y
          ? `translate3d(${x / scale.current}px, ${y / scale.current}px, 0)`
          : "";
  };
  const fade = (now: number) => {
    const a = ahead.current;
    const keep = Math.exp(-Math.max(0, now - a.at) / handover);
    a.at = now;
    a.x *= keep;
    a.y *= keep;
    if (Math.hypot(a.x, a.y) < 0.3) {
      a.x = a.y = 0;
      a.frame = 0;
    } else a.frame = requestAnimationFrame(fade);
    place();
  };
  // Show a scroll at once; the Mac's own frames take over as they arrive.
  const scrollAhead = (dx: number, dy: number) => {
    const a = ahead.current;
    const limit = Math.max(area.width, area.height) / 2 || 400;
    if (!a.frame) a.at = performance.now();
    a.x = clamp(a.x + dx, -limit, limit);
    a.y = clamp(a.y + dy, -limit, limit);
    place();
    if (!a.frame) a.frame = requestAnimationFrame(fade);
  };

  const offset = {
    x: Math.max(0, (area.width - base.width) / 2),
    y:
      typing && focus !== undefined
        ? clamp(
            area.height * 0.4 - focus * base.height,
            area.height - base.height,
            0,
          )
        : Math.max(0, (area.height - base.height) / 2),
  };
  // Where the window sits on screen through any zoom, without the local
  // scroll lead: what was shown under a finger is where the Mac has it now.
  const rect = () => frame.current?.getBoundingClientRect();
  const locate = (clientX: number, clientY: number) => {
    const r = rect();
    if (!r?.width || !r.height) return null;
    const u = (clientX - r.left) / r.width,
      v = (clientY - r.top) / r.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { u, v };
  };
  // Finger travel on screen → points on the Mac, so content follows the finger.
  const points = () => {
    const r = rect();
    return r?.width ? regionWidth / r.width : 1;
  };
  const bounded = (s: number, x: number, y: number) => {
    if (s <= 1.02) return { scale: 1, x: 0, y: 0 };
    return {
      scale: s,
      x: clamp(x, base.width - base.width * s, 0),
      y: clamp(y, base.height - base.height * s, 0),
    };
  };
  const stopMomentum = () => {
    if (!momentum.current) return false;
    cancelAnimationFrame(momentum.current);
    momentum.current = 0;
    act({ type: "scroll", dx: 0, dy: 0, momentum: "ended" });
    return true;
  };
  const fling = (velocity: Point) => {
    let v = { ...velocity },
      last = performance.now(),
      phase: "began" | "changed" = "began";
    const k = points();
    const step = (now: number) => {
      const dt = Math.min(48, Math.max(1, now - last));
      last = now;
      const keep = DECELERATION ** dt;
      v = { x: v.x * keep, y: v.y * keep };
      if (Math.hypot(v.x, v.y) < STOP) {
        momentum.current = 0;
        act({ type: "scroll", dx: 0, dy: 0, momentum: "ended" });
        return;
      }
      const dx = clamp(v.x * dt, -120, 120),
        dy = clamp(v.y * dt, -120, 120);
      act({ type: "scroll", dx, dy, momentum: phase });
      scrollAhead(dx / k, dy / k);
      phase = "changed";
      momentum.current = requestAnimationFrame(step);
    };
    momentum.current = requestAnimationFrame(step);
  };
  const cancel = () => {
    const g = gesture.current;
    gesture.current = null;
    clearTimeout(holdTimer.current);
    setHold(null);
    if (g?.kind === "scroll")
      act({ type: "scroll", dx: 0, dy: 0, phase: "cancelled" });
    if (g?.kind === "drag") act({ type: "up", ...g.at, button: "left" });
  };

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const stopped = stopMomentum();
    if (pointers.current.size === 2) {
      cancel();
      const [a, b] = [...pointers.current.values()];
      const r = box.current!.getBoundingClientRect();
      pinch.current = {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        mid: {
          x: (a.x + b.x) / 2 - r.left - offset.x,
          y: (a.y + b.y) / 2 - r.top - offset.y,
        },
        view,
      };
      return;
    }
    if (pointers.current.size > 2 || gesture.current) return;
    const spot = locate(event.clientX, event.clientY);
    const at = spot && map(spot.u, spot.v);
    if (!spot || !at) return;
    const now = performance.now();
    const start = { x: event.clientX, y: event.clientY };
    gesture.current = {
      id: event.pointerId,
      start,
      last: start,
      lastAt: now,
      at,
      spot,
      kind: "pending",
      held: false,
      stopper: stopped,
      samples: [{ t: now, x: event.clientX, y: event.clientY }],
      phase: "began",
    };
    holdTimer.current = setTimeout(() => {
      const g = gesture.current;
      if (g?.kind !== "pending" || g.stopper) return;
      g.held = true;
      const r = box.current!.getBoundingClientRect();
      setHold({ x: start.x - r.left, y: start.y - r.top });
    }, HOLD);
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const p = pinch.current;
    if (p && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = box.current!.getBoundingClientRect();
      const mid = {
        x: (a.x + b.x) / 2 - r.left - offset.x,
        y: (a.y + b.y) / 2 - r.top - offset.y,
      };
      const s = clamp(
        (p.view.scale * Math.hypot(a.x - b.x, a.y - b.y)) / p.distance,
        1,
        4,
      );
      // Keep the content under the fingers' midpoint anchored.
      setView(
        bounded(
          s,
          mid.x - ((p.mid.x - p.view.x) * s) / p.view.scale,
          mid.y - ((p.mid.y - p.view.y) * s) / p.view.scale,
        ),
      );
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const now = performance.now();
    const dx = event.clientX - g.last.x,
      dy = event.clientY - g.last.y;
    if (g.kind === "pending") {
      if (
        Math.hypot(event.clientX - g.start.x, event.clientY - g.start.y) < SLOP
      )
        return;
      clearTimeout(holdTimer.current);
      if (g.held) {
        g.kind = "drag";
        act({ type: "down", ...g.at, button: "left" });
      } else {
        g.kind = "scroll";
        // Scrolling reaches the window under the Mac's pointer.
        act({ type: "move", ...g.at });
      }
    }
    if (g.kind === "scroll") {
      const k = points();
      act({
        type: "scroll",
        dx: clamp(dx * k, -120, 120),
        dy: clamp(dy * k, -120, 120),
        phase: g.phase,
      });
      g.phase = "changed";
      scrollAhead(dx, dy);
      g.samples.push({ t: now, x: event.clientX, y: event.clientY });
      while (g.samples.length > 2 && now - g.samples[0].t > SAMPLE)
        g.samples.shift();
    } else if (g.kind === "drag") {
      const spot = locate(event.clientX, event.clientY);
      const at = spot && map(spot.u, spot.v);
      if (at) {
        g.at = at;
        act({ type: "move", ...at });
      }
    }
    g.last = { x: event.clientX, y: event.clientY };
    g.lastAt = now;
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null;
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    clearTimeout(holdTimer.current);
    setHold(null);
    if (event.type === "pointercancel") {
      gesture.current = g;
      cancel();
      return;
    }
    if (g.kind === "scroll") {
      act({ type: "scroll", dx: 0, dy: 0, phase: "ended" });
      const first = g.samples[0],
        now = performance.now();
      const span = Math.max(1, g.lastAt - first.t);
      const k = points();
      const velocity = {
        x: clamp(((g.last.x - first.x) / span) * k, -FASTEST, FASTEST),
        y: clamp(((g.last.y - first.y) / span) * k, -FASTEST, FASTEST),
      };
      if (now - g.lastAt < 80 && Math.hypot(velocity.x, velocity.y) > FLICK)
        fling(velocity);
    } else if (g.kind === "drag") {
      act({ type: "up", ...g.at, button: "left" });
    } else if (g.stopper) {
      // Like iOS: a tap that stops a fling only stops it.
    } else if (g.held) {
      act({ type: "click", ...g.at, button: "right", count: 1 });
    } else {
      const now = performance.now();
      const again =
        now - lastTap.current.at < DOUBLE &&
        Math.hypot(
          event.clientX - lastTap.current.x,
          event.clientY - lastTap.current.y,
        ) < 24;
      act({ type: "click", ...g.at, button: "left", count: again ? 2 : 1 });
      lastTap.current = again
        ? { at: 0, x: 0, y: 0 }
        : { at: now, x: event.clientX, y: event.clientY };
      if (fieldAt?.(g.spot.u, g.spot.v)) field.current = g.at;
      onTap?.(g.at);
    }
  };
  // The click that follows a tap is when Safari lets the keyboard open.
  const click = () => {
    const at = field.current;
    field.current = null;
    if (at) onField?.(at);
  };
  const wheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!ready) return;
    const spot = locate(event.clientX, event.clientY);
    const at = spot && map(spot.u, spot.v);
    if (!at) return;
    // The pointer goes over the window once per wheel gesture, not per tick.
    if (event.timeStamp - wheeled.current > 250) act({ type: "move", ...at });
    wheeled.current = event.timeStamp;
    const k = points();
    act({
      type: "scroll",
      dx: clamp(-event.deltaX * k, -120, 120),
      dy: clamp(-event.deltaY * k, -120, 120),
    });
  };

  return (
    <div
      ref={box}
      className="app-surface"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={click}
      onWheel={wheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={frame}
        className="app-surface-window"
        style={{
          left: offset.x,
          top: offset.y,
          width: base.width || undefined,
          height: base.height || undefined,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        <div ref={follow} className="app-surface-follow">
          <canvas ref={canvas} aria-label="App on your computer" />
        </div>
      </div>
      {hold && (
        <span
          className="app-surface-hold"
          style={{ left: hold.x, top: hold.y }}
        />
      )}
    </div>
  );
}
