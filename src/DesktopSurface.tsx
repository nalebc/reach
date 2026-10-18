import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { DesktopAction } from "./useDesktopInput";
import {
  boundView,
  dragView,
  focusView,
  pinchView,
  typingView,
} from "./desktop-geometry";
import { screenImageRect, screenPoint, screenTouchTolerance } from "./screen-pointer";
import { DOUBLE_TAP_MS, TapClicks } from "./tap-clicks";
import { TouchScroll } from "./touch-scroll";
import ScreenConnection from "./ScreenConnection";
import ScreenGestureFeedback, { type GestureFeedback } from "./ScreenGestureFeedback";
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
type Point = { x: number; y: number };
type Touch = { x: number; y: number };
// A click the Mac acknowledged, drawn as a wave where it landed: one ring
// for a click, two quick ones for a double-click, an inward ring for a
// right-click. Nothing for a drag, and nothing until the Mac said it's done.
export type WaveKind = "click" | "double" | "right";
type Wave = Point & { id: number; kind: WaveKind };
const SCROLL_HINT = "reach.twoFingerScrollHint";
// A tap made while control reconnects goes once it's back, if that's
// within this long; never later (the screen may have changed by then).
export const TAP_RETRY_MS = 1000;
const WAVE_MS = 600;
const HOLD_MS = 400;
const HOLD_FEEDBACK_MS = 100;
const MOVE_SLOP = 8;
// A finger aiming at the very edge (the menu bar, the Dock, the taskbar)
// can land a few CSS pixels into the dark border: that's still the edge.
// Further out is the border (a tap there only puts the keyboard away).
const EDGE_MARGIN = 4;
// After a finger lifts, phones send the tap again as mouse events and a
// click, up to this long after (iOS: about 200 ms).
const SYNTHETIC_MS = 1000;
type Pair = { x: number; y: number };
type Sequence = { clickId: number; clickState: number; pair?: Pair };
// Why a tap didn't reach the computer, as one short line.
const notSentLine = (why: string) =>
  `Tap not sent · ${why.replace(/[.…]+$/u, "").replace(/\s*Reconnecting$/u, "")}`;
export default function DesktopSurface({
  canvas,
  width,
  height,
  ready,
  connecting,
  stale = false,
  canControl,
  mode,
  drag,
  clickMode,
  send,
  onDragEnd,
  onFeedback,
  onInteractionStart,
  onInteraction,
  onTextTarget,
  probe,
  onField,
  onKeyboardActivate,
  knownField,
  onStaleFields,
  resetKey,
  initialCursor,
  hostCursor,
  compact = false,
  focusPoint,
  focusRect,
  typing = false,
  touchScroll = false,
  touchAssist = false,
  doubleClick = false,
  idle,
  blocked = "",
  waitForControl = false,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  width: number;
  height: number;
  ready: boolean;
  connecting: boolean;
  // Reconnecting behind the last picture: it stays, dimmed.
  stale?: boolean;
  canControl: boolean;
  mode: string;
  drag: boolean;
  clickMode: string;
  send: (a: DesktopAction) => Promise<unknown>;
  onDragEnd: () => void;
  onFeedback: (s: string) => void;
  // Invalidate delayed field checks at touch-down; a swipe can keep typing.
  onInteractionStart?: () => void;
  // Return true to retain a confirmed keyboard during the second click.
  onInteraction: (repeat?: boolean) => boolean | void;
  onTextTarget: (point: Point) => void;
  // Asked on touch-down: is there a text field under the finger? When the
  // answer is back before the finger lifts, onField opens the keyboard on
  // that same tap (Safari opens it only during a tap).
  probe?: (point: Point) => Promise<unknown>;
  onField?: (point: Point, secure: boolean) => void;
  onKeyboardActivate?: () => void;
  // A text field the computer already said is here (its pushed map): the
  // keyboard opens on the tap without waiting for the probe.
  knownField?: (point: Point) => { secure: boolean; x?: number; y?: number; w?: number; h?: number } | null;
  // The probe found no field where the map had one: the map is out of date.
  onStaleFields?: () => void;
  // The Mac can't see what's under the finger (a game, a canvas, a remote
  // desktop): its text fields can't be found, so offer the keyboard button.
  resetKey: string;
  initialCursor: Point | null;
  // Where the computer last said its pointer is, and when (trackpad mode
  // starts from there when that's newer than the phone's own last move).
  hostCursor?: () => (Point & { at: number }) | null;
  compact?: boolean;
  focusPoint?: Point;
  // An area to open on (fractions of the screen): a Mac dialog to answer.
  focusRect?: { x: number; y: number; width: number; height: number } | null;
  typing?: boolean;
  // Direct swipes scroll at Fit and pan when zoomed; two fingers scroll.
  touchScroll?: boolean;
  // macOS can recover a nearby miss using the live control bounds.
  touchAssist?: boolean;
  // The host can complete a double-click with just the second tap's click.
  doubleClick?: boolean;
  // Shown instead of "Live view is paused" while nothing streams.
  idle?: ReactNode;
  // Why a tap can't reach the computer now (control off, reconnecting…):
  // said in one line, never a silent tap.
  blocked?: string;
  // Control is on and coming back (its connection blinked): a tap waits
  // for it, up to TAP_RETRY_MS, instead of being dropped.
  waitForControl?: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 }),
    viewRef = useRef(view);
  viewRef.current = view;
  const beforeTyping = useRef<typeof view | null>(null);
  const tapClicks = useRef(new TapClicks());
  // When a finger last touched the picture, and its last single tap: a
  // phone's late mouse events and double-click belong to these.
  const lastTouch = useRef(-Infinity);
  const lastTap = useRef<{ clickId: number; point: Point; touch?: Touch; image: { width: number; height: number }; at: number } | null>(null);
  const cursorRef = useRef<Point>({ x: 0.5, y: 0.5 });
  // A finger on the picture: the zoom pill steps aside meanwhile.
  const [touching, setTouching] = useState(false);
  const [gestureFeedback, setGestureFeedback] = useState<GestureFeedback | null>(null);
  const [waves, setWaves] = useState<Wave[]>([]),
    timers = useRef(new Set<ReturnType<typeof setTimeout>>()),
    serial = useRef(0);
  // A tap waiting for control to come back (see waitForControl).
  const pendingTap = useRef<{
    point: Point;
    right: boolean;
    touch?: Touch;
    at: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const waveSerial = useRef(0);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    start: Point;
    clientStart: Point;
    point: Point | null;
    image: ReturnType<typeof screenImageRect>;
    touch?: Touch;
    last: Point;
    at: number;
    stopper: boolean;
    moved: boolean;
    held: boolean;
    acknowledged?: boolean;
    multiple: boolean;
    distance: number;
    scale: number;
    mid: Point;
    anchor: Point;
    pan: Point;
    pinch: boolean;
    probe?: number;
    // A one-finger scroll under way (the pointer was put there once).
    scrolling?: boolean;
    scrollLifted?: Point;
    // What two fingers are doing, decided once at their first real movement
    // and kept: a scroll whose fingers drift never turns into a zoom.
    two?: "pinch" | "scroll" | "pan";
  } | null>(null);
  // Touch scroll steps, merged per frame and sent as one.
  const scrollStep = useRef({ dx: 0, dy: 0, frame: 0 });
  const scrollMotion = useRef({ dx: 0, dy: 0, fast: false });
  const touchPhysics = useRef(new TouchScroll());
  const momentum = useRef({ frame: 0, point: { x: 0, y: 0 } });
  const momentumHandler = useRef<(at: number) => void>(() => {});
  const stopMomentum = () => {
    const active = touchPhysics.current.coasting;
    cancelAnimationFrame(momentum.current.frame);
    momentum.current.frame = 0;
    touchPhysics.current.reset();
    if (active) {
      // Also discard any scroll still waiting in the connection's queue.
      void send({ type: "scroll", dx: 0, dy: 0, phase: "cancelled" }).catch(() => {});
      setGestureFeedback(null);
    }
    return active;
  };
  // The latest touch-down's answer, and a field tapped awaiting its click.
  const probeSerial = useRef(0);
  const probeAnswer = useRef<{
    id: number;
    field: boolean;
    secure: boolean;
  } | null>(null);
  const tappedField = useRef<{
    point: Point;
    probe: number;
    known: { secure: boolean; x?: number; y?: number; w?: number; h?: number } | null;
    at: number;
    acknowledged: boolean;
    focusActivated?: boolean;
    keepTyping: boolean;
    opened?: boolean;
    retargeted?: boolean;
  } | null>(null);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  useEffect(() => {
    const area = stage.current;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      wheelHandler.current(event);
    };
    area?.addEventListener("wheel", handler, { passive: false });
    return () => area?.removeEventListener("wheel", handler);
  }, []);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdFeedback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wheelFeedback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearHold = () => {
    clearTimeout(hold.current);
    clearTimeout(holdFeedback.current);
  };
  const cue = (kind: GestureFeedback["kind"], point: Point, dx = 0, dy = 0, fast = false) => {
    clearTimeout(wheelFeedback.current);
    setGestureFeedback((previous) => {
      const continuing = previous?.kind === kind || (kind === "coast" && previous?.kind === "scroll");
      const angle = dx || dy ? Math.atan2(dx, -dy) * 180 / Math.PI : continuing ? previous?.angle : 0;
      const quick = kind === "coast" && !dx && !dy && continuing ? previous?.fast : fast;
      if (previous?.kind === kind && previous.point.x === point.x && previous.point.y === point.y &&
        previous.angle === angle && previous.fast === quick) return previous;
      return { kind, point, fast: quick, angle };
    });
  };
  const dragPan = useRef({ frame: 0, at: 0 });
  const dragPanHandler = useRef<(time: number) => void>(() => {});
  const stopDragPan = () => {
    if (dragPan.current.frame) cancelAnimationFrame(dragPan.current.frame);
    dragPan.current = { frame: 0, at: 0 };
  };
  const cursorAt = useRef(-Infinity);
  const moveCursor = (p: Point) => {
    cursorRef.current = p;
    cursorAt.current = performance.now();
  };
  const action = (a: DesktopAction) => {
    if (!canControl) return;
    void send(a).catch((e: Error) => {
      stopMomentum();
      dropScroll();
      setGestureFeedback(null);
      onFeedback(e.message);
    });
  };
  // A frame's worth of finger movement goes as one scroll, in whole
  // pixels (the remainder waits for the next frame), never more than 120 a
  // step. The pointer stays where it was put at the gesture's start.
  const flushScroll = () => {
    const step = scrollStep.current;
    if (step.frame) cancelAnimationFrame(step.frame);
    step.frame = 0;
    const dx = clamp(Math.trunc(step.dx), -120, 120),
      dy = clamp(Math.trunc(step.dy), -120, 120);
    step.dx -= dx;
    step.dy -= dy;
    if (dx || dy) action({ type: "scroll", dx, dy });
    if (Math.abs(step.dx) >= 1 || Math.abs(step.dy) >= 1)
      step.frame = requestAnimationFrame(flushScroll);
  };
  const queueScroll = (dx: number, dy: number) => {
    const step = scrollStep.current;
    // At most two frames can wait: a slow link never receives a long tail
    // of obsolete travel after the finger changes direction.
    step.dx = clamp(step.dx + dx, -240, 240);
    step.dy = clamp(step.dy + dy, -240, 240);
    if (!step.frame) step.frame = requestAnimationFrame(flushScroll);
  };
  const dropScroll = () => {
    const step = scrollStep.current;
    if (step.frame) cancelAnimationFrame(step.frame);
    scrollStep.current = { dx: 0, dy: 0, frame: 0 };
  };
  const scrollTouch = (point: Point) => {
    const step = touchPhysics.current.move(point, performance.now());
    if (step.dx || step.dy) scrollMotion.current = { dx: step.dx, dy: step.dy, fast: step.gain > 1.6 };
    const motion = scrollMotion.current;
    cue("scroll", point, motion.dx, motion.dy, motion.fast);
    queueScroll(step.dx, step.dy);
  };
  momentumHandler.current = (at) => {
    momentum.current.frame = 0;
    if (!canControl || !ready || stale || document.hidden) {
      stopMomentum();
      dropScroll();
      return;
    }
    const step = touchPhysics.current.step(at);
    if (!step) {
      dropScroll();
      setGestureFeedback(null);
      return;
    }
    cue("coast", momentum.current.point, step.dx, step.dy, step.gain > 1.6);
    queueScroll(step.dx, step.dy);
    momentum.current.frame = requestAnimationFrame((time) => momentumHandler.current(time));
  };
  const fling = (point: Point) => {
    if (!canControl || !ready || stale || !touchPhysics.current.lift(performance.now())) return;
    momentum.current.point = point;
    const motion = scrollMotion.current;
    cue("coast", point, motion.dx, motion.dy, motion.fast);
    momentum.current.frame = requestAnimationFrame((time) => momentumHandler.current(time));
  };
  const release = () => {
    tapClicks.current.reset();
    clearHold();
    clearTimeout(wheelFeedback.current);
    setGestureFeedback(null);
    dropScroll();
    stopMomentum();
    stopDragPan();
    if (gesture.current?.held) {
      void send({ type: "release" }).catch(() => {});
      onDragEnd();
    }
    gesture.current = null;
    pointers.current.clear();
    setTouching(false);
    tappedField.current = null;
    serial.current++;
    probeSerial.current++;
  };
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    if (stage.current) observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    release();
    beforeTyping.current = null;
    setView({ scale: 1, x: 0, y: 0 });
    setWaves([]);
    dropTap();
    moveCursor({ x: 0.5, y: 0.5 });
  }, [resetKey]);
  useEffect(() => {
    release();
  }, [mode]);
  useEffect(() => { tapClicks.current.reset(); }, [clickMode, doubleClick]);
  useEffect(() => {
    if (!ready || stale) {
      tapClicks.current.reset();
      stopMomentum();
      dropScroll();
    }
  }, [ready, stale]);
  useEffect(() => {
    stopMomentum();
    dropScroll();
  }, [width, height, size.width, size.height]);
  // A tap on the picture can open the keyboard and its key row right under
  // the finger; the phone's late click for that tap then lands on whatever
  // is there now (iOS pressed ↑ on the computer that way). Late mouse
  // events outside the picture count only on something the finger itself
  // pressed.
  useEffect(() => {
    let pressed: { target: EventTarget | null; at: number } = { target: null, at: -Infinity };
    const press = (event: PointerEvent) => {
      pressed = { target: event.target, at: performance.now() };
    };
    const ghost = (event: MouseEvent) => {
      const area = stage.current, target = event.target;
      if (!area || !(target instanceof Node) || area.contains(target)) return;
      // A keyboard's Enter or Space on a button clicks without a pointer.
      if (event.type === "click" && event.detail === 0) return;
      if (performance.now() - lastTouch.current > SYNTHETIC_MS) return;
      const own = pressed.target instanceof Node &&
        (pressed.target === target || pressed.target.contains(target) || target.contains(pressed.target)) &&
        performance.now() - pressed.at < SYNTHETIC_MS;
      if (own) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const types = ["mousedown", "mouseup", "click", "dblclick"] as const;
    window.addEventListener("pointerdown", press, true);
    for (const type of types) window.addEventListener(type, ghost, true);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      for (const type of types) window.removeEventListener(type, ghost, true);
    };
  }, []);
  useEffect(() => {
    const hidden = () => { if (document.hidden) release(); };
    const blur = () => release();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", blur);
    };
  }, []);
  useEffect(() => {
    if (canControl) {
      // Control is back: a tap that waited for it goes now, once, if it is
      // still recent; older, it is said and dropped, never sent late.
      const waiting = pendingTap.current;
      if (!waiting) return;
      clearTimeout(waiting.timer);
      pendingTap.current = null;
      if (performance.now() - waiting.at <= TAP_RETRY_MS) click(waiting.point, waiting.right, waiting.at, waiting.touch);
      else onFeedback(notSentLine("control came back too late"));
      return;
    }
    // A finger resting for a tap keeps its gesture: lifted while control
    // blinks, the tap waits for it. Anything under way is let go.
    const g = gesture.current;
    clearHold();
    setGestureFeedback(null);
    stopMomentum();
    dropScroll();
    if (g && !g.held && !g.moved && !g.multiple && pointers.current.size <= 1) return;
    release();
  }, [canControl]);
  useEffect(() => {
    if (initialCursor) moveCursor(initialCursor);
  }, [initialCursor]);
  // Said once, the first time a phone can control: nothing permanent.
  useEffect(() => {
    if (!canControl) return;
    try {
      if (!matchMedia("(pointer: coarse)").matches || localStorage.getItem(SCROLL_HINT)) return;
      localStorage.setItem(SCROLL_HINT, "1");
    } catch {
      return;
    }
    onFeedback("Two fingers to scroll");
  }, [canControl]);
  useEffect(
    () => () => {
      clearHold();
      clearTimeout(wheelFeedback.current);
      dropScroll();
      cancelAnimationFrame(momentum.current.frame);
      touchPhysics.current.reset();
      stopDragPan();
      if (gesture.current?.held) void send({ type: "release" }).catch(() => {});
      gesture.current = null;
      pointers.current.clear();
      for (const timer of timers.current) clearTimeout(timer);
      clearTimeout(pendingTap.current?.timer);
    },
    [],
  );
  const fit = Math.min(
      size.width / (width || 1600),
      size.height / (height || 900),
    ),
    baseW = (width || 1600) * fit,
    baseH = (height || 900) * fit;
  useLayoutEffect(() => {
    if (focusPoint) {
      beforeTyping.current ??= viewRef.current;
      setView(
        typingView(
          beforeTyping.current,
          focusPoint,
          baseW,
          baseH,
          size.width,
          size.height,
        ),
      );
    } else {
      const previous = beforeTyping.current || viewRef.current;
      beforeTyping.current = null;
      setView(
        boundView(
          previous.scale,
          previous.x,
          previous.y,
          baseW,
          baseH,
          size.width,
          size.height,
          48,
        ),
      );
    }
  }, [focusPoint?.x, focusPoint?.y, baseW, baseH, size.width, size.height]);
  // Frame a requested dialog once, never again on each keyboard resize.
  const framed = useRef("");
  useEffect(() => {
    if (!focusRect || !size.width || !size.height) return;
    const key = `${resetKey}:${JSON.stringify(focusRect)}`;
    if (framed.current === key) return;
    framed.current = key;
    setView(focusView(focusRect, baseW, baseH, size.width, size.height));
  }, [
    resetKey,
    focusRect?.x,
    focusRect?.y,
    focusRect?.width,
    focusRect?.height,
    baseW,
    baseH,
    size.width,
    size.height,
  ]);
  const imageW = baseW * view.scale,
    imageH = baseH * view.scale,
    left = (size.width - imageW) / 2 + view.x,
    top = (size.height - imageH) / 2 + view.y;
  // Rendering and feedback use the same contained image as hit testing,
  // including the brief interval between a new frame size and layout update.
  const rendered = screenImageRect({ left, top, width: imageW, height: imageH },
    canvas.current?.width || width, canvas.current?.height || height)
    ?? { left, top, width: imageW, height: imageH };
  const bounded = (scale: number, x: number, y: number) =>
    boundView(scale, x, y, baseW, baseH, size.width, size.height, 48);
  const local = (x: number, y: number) => {
    const b = stage.current!.getBoundingClientRect();
    return { x: x - b.left, y: y - b.top };
  };
  const normalized = (x: number, y: number) => {
    const el = canvas.current;
    return el
      ? screenPoint(x, y, el.getBoundingClientRect(), el.width, el.height)
      : null;
  };
  // The same image mapping as a tap, with clamping for a held mouse that
  // travels beyond the picture. Use the current view even between frames.
  const dragPosition = (p: Point, v = viewRef.current) => {
    const el = canvas.current;
    return el ? screenPoint(p.x, p.y, {
      left: (size.width - baseW * v.scale) / 2 + v.x,
      top: (size.height - baseH * v.scale) / 2 + v.y,
      width: baseW * v.scale,
      height: baseH * v.scale,
    }, el.width, el.height, true) : null;
  };
  dragPanHandler.current = (time) => {
    const step = dragPan.current;
    step.frame = 0;
    const g = gesture.current;
    if (!g?.held || !g.moved || !canControl || mode !== "direct" || pointers.current.size !== 1) {
      step.at = 0;
      return;
    }
    const v = viewRef.current;
    const next = dragView(v, g.last, step.at ? (time - step.at) / 1000 : 0.016,
      baseW, baseH, size.width, size.height);
    step.at = time;
    if (next.x === v.x && next.y === v.y) {
      step.at = 0;
      return;
    }
    viewRef.current = next;
    setView(next);
    const point = dragPosition(g.last, next);
    if (point) {
      moveCursor(point);
      action({ type: "move", ...point });
    }
    step.frame = requestAnimationFrame((at) => dragPanHandler.current(at));
  };
  const zoomAt = (scale: number, p: Point) => {
    tapClicks.current.reset();
    const v = viewRef.current,
      next = clamp(scale, 1, 4),
      ox = (size.width - baseW * v.scale) / 2 + v.x,
      oy = (size.height - baseH * v.scale) / 2 + v.y;
    const zoomed = bounded(
      next,
      p.x - ((p.x - ox) / v.scale) * next - (size.width - baseW * next) / 2,
      p.y - ((p.y - oy) / v.scale) * next - (size.height - baseH * next) / 2,
    );
    viewRef.current = zoomed;
    setView(zoomed);
  };
  // The Mac did it: a wave where it landed, gone by itself.
  const wave = (point: Point, kind: WaveKind) => {
    const id = ++waveSerial.current;
    setWaves((list) => [...list.slice(-5), { ...point, id, kind }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setWaves((list) => list.filter((entry) => entry.id !== id));
    }, WAVE_MS);
    timers.current.add(timer);
  };
  const dropTap = () => {
    clearTimeout(pendingTap.current?.timer);
    pendingTap.current = null;
  };
  // A tap while control is coming back waits for it, briefly; then it is
  // said, not dropped in silence.
  const holdTap = (point: Point, right: boolean, at: number, touch?: Touch) => {
    dropTap();
    const timer = setTimeout(() => {
      if (pendingTap.current?.timer !== timer) return;
      pendingTap.current = null;
      onFeedback(notSentLine(blockedRef.current || "control is reconnecting"));
    }, Math.max(0, at + TAP_RETRY_MS - performance.now()));
    pendingTap.current = { point, right, at, timer, touch };
  };
  const click = (point: Point, right: boolean, at: number, touch?: Touch,
    sequence?: Sequence) => {
    const id = ++serial.current;
    const kind: WaveKind = right || clickMode === "right" ? "right" : clickMode === "double" || sequence?.clickState === 2 ? "double" : "click";
    onFeedback("");
    void send({
      type: "click",
      ...point,
      button: kind === "right" ? "right" : "left",
      count: clickMode === "double" && kind !== "right" ? 2 : 1,
      ...(touch && kind !== "right" ? { touch } : {}),
      ...(sequence && { clickId: sequence.clickId, clickState: sequence.clickState }),
      ...(sequence?.clickState === 2 && sequence.pair ? { pair: sequence.pair } : {}),
    })
      .then((result) => {
        const actual = (result as { point?: Point } | null)?.point;
        const landed = actual && [actual.x, actual.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
          ? actual : point;
        if (id === serial.current) moveCursor(landed);
        const actualState = (result as { clickState?: number } | null)?.clickState;
        wave(landed, sequence?.clickState === 2 && actualState === 1 ? "click" : kind);
        if (id === serial.current && kind !== "right") {
          const field = tappedField.current;
          if (field?.point === point) {
            field.point = landed;
            // A retargeted click needs the host's focus check; the
            // touch-down probe described the uncorrected location.
            const retargeted = (result as { retargeted?: boolean } | null)?.retargeted;
            if (retargeted === true || (retargeted === undefined && Math.hypot(landed.x - point.x, landed.y - point.y) > 1e-8)) {
              field.retargeted = true;
            }
            field.acknowledged = true;
            field.focusActivated = !!(field.opened || field.keepTyping);
          }
          // Focus confirmation also runs if the browser omits its synthetic
          // click. The keyboard activation itself stays inside the touch event.
          onTextTarget(landed);
        }
      })
      .catch((error: Error & { notSent?: boolean }) => {
        if (sequence) tapClicks.current.reset(sequence.clickId);
        else if (id === serial.current) tapClicks.current.reset();
        // Never reached the Mac (its connection blinked before it went):
        // it waits for control to come back, if that's soon.
        if (id === serial.current && error?.notSent && performance.now() - at < TAP_RETRY_MS) {
          holdTap(point, right, at, touch);
          return;
        }
        onFeedback(notSentLine(error?.message || "the computer didn't answer"));
        if (id === serial.current) {
          tappedField.current = null;
          onInteraction();
        }
      });
  };
  // A tap on the picture: sent, or held a moment while control comes back,
  // or said why not. Only watching, there is no mark at all.
  const tap = (point: Point, right = false, touch?: Touch,
    sequence?: Sequence) => {
    const at = performance.now();
    if (!sequence) tapClicks.current.reset();
    if (canControl) return click(point, right, at, touch, sequence);
    if (waitForControl) return holdTap(point, right, performance.now(), touch);
    onFeedback(blocked || "View only · tap Control to use it");
  };
  // A wheel or a laptop's two-finger swipe scrolls the computer in every
  // mode; Ctrl or ⌘ (a trackpad's pinch) zooms, and so does a wheel while
  // only watching.
  wheelHandler.current = (e) => {
    tapClicks.current.reset();
    onInteractionStart?.();
    stopMomentum();
    dropScroll();
    if (e.ctrlKey || e.metaKey || !canControl)
      zoomAt(
        // The latest view: several wheel steps can come within one frame.
        viewRef.current.scale * Math.exp(-e.deltaY * 0.002),
        local(e.clientX, e.clientY),
      );
    else {
      const point = normalized(e.clientX, e.clientY);
      if (!point) return;
      action({ type: "move", ...point });
      const units =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.height : 1;
      if (e.deltaX || e.deltaY) {
        cue("scroll", local(e.clientX, e.clientY), -e.deltaX, -e.deltaY);
        wheelFeedback.current = setTimeout(() => setGestureFeedback(null), 250);
      }
      action({
        type: "scroll",
        dx: clamp(-e.deltaX * units, -120, 120) || 0,
        dy: clamp(-e.deltaY * units, -120, 120) || 0,
      });
    }
  };
  // A mouse or pen pressed and moved drags at once, as on the computer
  // itself; a finger rests first (HOLD_MS) so that a swipe can scroll.
  const startDrag = (g: NonNullable<typeof gesture.current>) => {
    if (!g.point) return;
    clearHold();
    tapClicks.current.reset();
    g.held = true;
    moveCursor(g.point);
    cue("grabbing", g.last);
    void send({ type: "down", ...g.point, button: clickMode === "right" ? "right" : "left" })
      .then(() => {
        if (gesture.current !== g || !g.held) return;
        g.acknowledged = true;
        cue("drag", g.last);
      })
      .catch((error: Error) => {
        if (gesture.current !== g || !g.held) return;
        release();
        onFeedback(`Drag not sent · ${error.message}`);
      });
  };
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") lastTouch.current = performance.now();
    if (!ready || event.button !== 0) return;
    const stopper = stopMomentum();
    dropScroll();
    serial.current++;
    if (typing) event.preventDefault();
    else stage.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = local(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, p);
    setTouching(true);
    if (pointers.current.size === 1) {
      clearHold();
      clearTimeout(wheelFeedback.current);
      setGestureFeedback(null);
      const host = mode === "trackpad" ? hostCursor?.() : null;
      if (host && host.at > cursorAt.current) moveCursor({ x: host.x, y: host.y });
      const image = canvas.current;
      const imageBox = image?.getBoundingClientRect();
      const point =
        mode === "trackpad"
          ? cursorRef.current
          : image && imageBox ? screenPoint(event.clientX, event.clientY, imageBox, image.width, image.height,
            event.pointerType === "touch" ? EDGE_MARGIN : false) : null;
      gesture.current = {
        start: p,
        clientStart: { x: event.clientX, y: event.clientY },
        point,
        image: image && imageBox ? screenImageRect(imageBox, image.width, image.height) : null,
        // Tolerance is measured on the rendered image, so zooming reduces
        // it on the Mac. Mouse, Pencil, trackpad and drags stay exact.
        touch: touchAssist && mode === "direct" && event.pointerType === "touch" && image && imageBox
          ? screenTouchTolerance(imageBox, image.width, image.height) : undefined,
        last: p,
        at: performance.now(),
        stopper,
        moved: false,
        held: false,
        multiple: false,
        distance: 0,
        scale: view.scale,
        mid: p,
        anchor: p,
        pan: { x: view.x, y: view.y },
        pinch: false,
      };
      touchPhysics.current.begin(p, performance.now());
      scrollMotion.current = { dx: 0, dy: 0, fast: false };
      tappedField.current = null;
      // Capture the tap point before dismissing a pending phone keyboard:
      // closing it can resize and move the displayed picture.
      onInteractionStart?.();
      if (!point || stopper || mode === "pan" || !canControl || event.button > 0)
        tapClicks.current.reset();
      if (point && !stopper && mode !== "pan" && canControl && probe && onField) {
        const id = ++probeSerial.current;
        gesture.current.probe = id;
        probeAnswer.current = null;
        probe(point).then(
          (answer) => {
            const a = (answer || {}) as {
              field?: unknown;
              secure?: unknown;
              blind?: unknown;
              skipped?: unknown;
            };
            // Skipped for the tap behind it: no answer, the field map stands.
            if (a.skipped === true) return;
            if (probeSerial.current === id) {
              probeAnswer.current = {
                id,
                field: a.field === true,
                secure: a.secure === true,
              };
              if (a.field !== true && knownField?.(point)) onStaleFields?.();
            }
          },
          () => {},
        );
      }
      // A held right or middle mouse button isn't a press or a drag.
      if (
        point &&
        mode !== "pan" &&
        canControl &&
        event.button <= 0
      ) {
        moveCursor(point);
        const g = gesture.current;
        const begin = () => {
          if (
            gesture.current === g &&
            !g.multiple &&
            !g.moved &&
            pointers.current.has(event.pointerId)
          ) {
            clearTimeout(holdFeedback.current);
            tapClicks.current.reset();
            g.held = true;
            onFeedback("");
            cue("grabbing", g.last);
            void send({
              type: "down",
              ...cursorRef.current,
              button: clickMode === "right" ? "right" : "left",
            }).then(() => {
              if (gesture.current !== g || !g.held) return;
              g.acknowledged = true;
              cue(g.moved ? "drag" : "held", g.last);
            }).catch((error: Error) => {
              if (gesture.current !== g || !g.held) return;
              release();
              onFeedback(`Hold not sent · ${error.message}`);
            });
          }
        };
        if (drag) begin();
        else {
          holdFeedback.current = setTimeout(() => {
            if (gesture.current === g && !g.moved && !g.multiple && !g.held)
              cue("hold", g.start);
          }, HOLD_FEEDBACK_MS);
          hold.current = setTimeout(begin, HOLD_MS);
        }
      }
    } else if (pointers.current.size === 2 && gesture.current) {
      tapClicks.current.reset();
      clearHold();
      stopDragPan();
      if (gesture.current.held) {
        action({ type: "release" });
        gesture.current.held = false;
        onDragEnd();
      }
      const [a, b] = [...pointers.current.values()];
      Object.assign(gesture.current, {
        multiple: true,
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale: view.scale,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        pan: { x: view.x, y: view.y },
        two: undefined,
        scrolling: false,
      });
      cue("two", gesture.current.mid);
      touchPhysics.current.begin(gesture.current.mid, performance.now());
      scrollMotion.current = { dx: 0, dy: 0, fast: false };
    }
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(event.pointerId)) {
      if (
        event.pointerType === "mouse" &&
        mode === "direct" &&
        canControl &&
        ready
      ) {
        stopMomentum();
        dropScroll();
        const point = normalized(event.clientX, event.clientY);
        if (point) {
          moveCursor(point);
          action({ type: "move", ...point });
        }
      }
      return;
    }
    const p = local(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, p);
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()],
        mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        distance = Math.hypot(a.x - b.x, a.y - b.y);
      // Pinch or scroll, told apart by what moved first: the distance
      // between the fingers (6 %: a pinch) or the fingers together (10 px:
      // a scroll; while only watching, a pan of the picture).
      if (!g.two) {
        const spread = Math.abs(distance / Math.max(1, g.distance) - 1) / 0.06,
          travel = Math.hypot(mid.x - g.anchor.x, mid.y - g.anchor.y) / 10;
        if (spread >= 1 || travel >= 1)
          g.two = spread >= travel ? "pinch" : canControl ? "scroll" : "pan";
      }
      g.pinch = g.two === "pinch";
      if (g.two === "scroll" && canControl) {
        // The pointer goes under the fingers once (in trackpad mode it is
        // already where the cursor is), then only the scroll steps.
        if (!g.scrolling) {
          const box = stage.current?.getBoundingClientRect();
          const point =
            mode === "trackpad" || !box
              ? null
              : normalized(g.anchor.x + box.left, g.anchor.y + box.top);
          if (point) {
            moveCursor(point);
            action({ type: "move", ...point });
          } else if (mode !== "trackpad") {
            g.mid = mid;
            return;
          }
          g.scrolling = true;
        }
        scrollTouch(mid);
      } else if (g.pinch) {
        cue("zoom", mid);
        setView(
          pinchView(
            { scale: g.scale, x: g.pan.x, y: g.pan.y },
            g.anchor,
            mid,
            distance / Math.max(1, g.distance),
            baseW,
            baseH,
            size.width,
            size.height,
          ),
        );
      } else if (g.two === "pan") {
        setGestureFeedback(null);
        setView((v) =>
          bounded(v.scale, v.x + mid.x - g.mid.x, v.y + mid.y - g.mid.y),
        );
      }
      g.mid = mid;
      return;
    }
    if (g.multiple) return;
    const dx = p.x - g.last.x,
      dy = p.y - g.last.y;
    if (Math.hypot(event.clientX - g.clientStart.x, event.clientY - g.clientStart.y) > MOVE_SLOP) {
      tapClicks.current.reset();
      g.moved = true;
      clearHold();
      if (!g.held) setGestureFeedback(null);
      if (!g.held && event.pointerType !== "touch" && mode === "direct" && canControl && !g.stopper)
        startDrag(g);
    }
    if (mode === "trackpad" && canControl) {
      // Relative to the picture as shown: zoomed in, the cursor is as
      // precise as the picture.
      const scale = viewRef.current.scale;
      const point = {
        x: clamp(cursorRef.current.x + dx / Math.max(1, baseW * scale), 0, 1),
        y: clamp(cursorRef.current.y + dy / Math.max(1, baseH * scale), 0, 1),
      };
      moveCursor(point);
      action({ type: "move", ...point });
      if (g.held) cue(g.acknowledged ? "drag" : "grabbing", p);
    } else if (g.held && canControl) {
      cue(g.acknowledged ? "drag" : "grabbing", p);
      // A resting finger wobbles: the pointer stays where it went down
      // until the finger really moves, so a long tap never selects text.
      if (!g.moved) {
        g.last = p;
        return;
      }
      const point = dragPosition(p);
      if (point) {
        moveCursor(point);
        action({ type: "move", ...point });
      }
      if (g.moved && !dragPan.current.frame)
        dragPan.current.frame = requestAnimationFrame((at) => dragPanHandler.current(at));
    } else if (
      g.moved &&
      g.point &&
      touchScroll &&
      mode === "direct" &&
      g.scale <= 1.01 &&
      canControl &&
      event.pointerType === "touch"
    ) {
      // The pointer goes there once, then only the scroll: a move with each
      // step kept the steps from merging, and control ended in half a second.
      if (!g.scrolling) {
        g.scrolling = true;
        action({ type: "move", ...cursorRef.current });
      }
      scrollTouch(p);
    } else if (g.moved) {
      if (canControl) cue("pan", p);
      setView((v) => bounded(v.scale, v.x + dx, v.y + dy));
    }
    g.last = p;
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(event.pointerId)) return;
    clearHold();
    setGestureFeedback(null);
    const lifted = local(event.clientX, event.clientY);
    if (g.scrolling) {
      // Pointer-up can carry motion the browser didn't deliver separately.
      // Remember the first lifted finger for the second finger's final midpoint.
      if (g.multiple) {
        const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1] || g.scrollLifted;
        if (other) g.mid = { x: (lifted.x + other.x) / 2, y: (lifted.y + other.y) / 2 };
        g.scrollLifted = lifted;
        scrollTouch(g.mid);
      } else {
        scrollTouch(lifted);
        g.last = lifted;
      }
      setGestureFeedback(null);
    }
    pointers.current.delete(event.pointerId);
    if (Math.hypot(event.clientX - g.clientStart.x, event.clientY - g.clientStart.y) > MOVE_SLOP)
      g.moved = true;
    // Flush the finger's final travel. Two-finger momentum waits until both
    // fingers lift; the remaining finger never produces a click.
    if (g.scrolling) {
      flushScroll();
      if (!pointers.current.size) fling(g.multiple ? g.mid : g.last);
    }
    const tapped =
      !g.held && !g.multiple && !g.moved && event.button === 0 &&
      (performance.now() - g.at < HOLD_MS || !canControl);
    const point = tapped && !g.stopper && mode !== "pan"
      ? mode === "trackpad" ? cursorRef.current
        : event.pointerType === "touch" ? g.point : normalized(event.clientX, event.clientY)
      : null;
    const image = canvas.current;
    const box = event.pointerType === "touch" ? g.image
      : image && screenImageRect(image.getBoundingClientRect(), image.width, image.height);
    const sequence = tapped && !g.stopper && mode !== "pan" && canControl && doubleClick && clickMode === "left" && box
      ? tapClicks.current.next(point, performance.now(), event.pointerType, box)
      : undefined;
    if (event.pointerType === "touch") lastTouch.current = performance.now();
    lastTap.current = sequence?.clickState === 1 && event.pointerType === "touch" && point && box
      ? { clickId: sequence.clickId, point, touch: g.touch, image: { width: box.width, height: box.height }, at: performance.now() }
      : null;
    // Ordinary taps dismiss typing, including margins, pan mode and stopping
    // momentum. A repeat can retain a confirmed editor unless its fresh hit
    // test has already established that this tap is outside an input.
    const answer = probeAnswer.current;
    const repeat = sequence?.clickState === 2 && !(answer && answer.id === g.probe && !answer.field);
    const keepTyping = tapped && onInteraction(repeat) === true;
    if (!tapped || g.stopper || mode === "pan") tapClicks.current.reset();
    if (g.held) {
      stopDragPan();
      // Pointer-up may contain the final motion when the browser coalesces
      // events. Move there before dropping, rather than at the last sample.
      const scale = viewRef.current.scale;
      const point = mode === "trackpad" ? {
        x: clamp(cursorRef.current.x + (lifted.x - g.last.x) / Math.max(1, baseW * scale), 0, 1),
        y: clamp(cursorRef.current.y + (lifted.y - g.last.y) / Math.max(1, baseH * scale), 0, 1),
      } : g.moved ? dragPosition(lifted) : null;
      if (point && Math.hypot(point.x - cursorRef.current.x, point.y - cursorRef.current.y) > 1e-8) {
        moveCursor(point);
        action({ type: "move", ...point });
      }
      action({
        type: "up",
        ...cursorRef.current,
        button: clickMode === "right" ? "right" : "left",
      });
      g.held = false;
      onDragEnd();
      onInteraction();
    } else if (
      tapped &&
      mode === "pan" &&
      !g.stopper &&
      performance.now() - g.at < HOLD_MS
    ) {
      // Pan & zoom only moves the picture: said, so a tap never seems lost.
      onFeedback(canControl ? "Pan & zoom · taps don't click" : blocked || "View only · tap Control to use it");
    } else if (tapped && mode !== "pan" && !g.stopper) {
      if (point) {
        const known = knownField?.(point) ?? null;
        // The keyboard opens only on a field the computer confirmed: this
        // touch's probe answer, or else its pushed map (a guess opened it and
        // shut it again on anything else). Keep the tap for its click while
        // the answer may still come; a field confirmed after the click gets
        // "tap to type" from the focus check instead.
        if (
          canControl &&
          clickMode !== "right" &&
          onField &&
          g.probe &&
          (answer?.id === g.probe
            ? answer.field
            : event.pointerType === "touch" || !!known)
        )
          tappedField.current = {
            point,
            probe: g.probe,
            known,
            at: performance.now(),
            acknowledged: false,
            keepTyping,
          };
        tap(point, false, g.touch, sequence);
        activateField();
      }
    }
    if (!pointers.current.size) {
      gesture.current = null;
      setTouching(false);
    }
  };
  // Try on finger-up, touch-end and click: browser keyboard activation must
  // happen inside a real gesture, without waiting for the click acknowledgement.
  const activateField = () => {
    const field = tappedField.current;
    if (field && canControl && ready && performance.now() - field.at < 1000) {
      // The probe's own answer is the freshest; the map stands in until it comes.
      const answer = probeAnswer.current;
      const { x = Infinity, y = Infinity, w = 0, h = 0 } = field.known ?? {};
      if (!field.keepTyping && !field.opened) {
        if (!field.retargeted && answer?.id === field.probe && answer.field) {
          field.opened = true;
          onField?.(field.point, answer.secure);
        } else if (field.known && (!field.retargeted || (
          field.point.x >= x && field.point.x <= x + w &&
          field.point.y >= y && field.point.y <= y + h))) {
          // A negative probe overrides a stale map at the original point.
          if (field.retargeted || answer?.id !== field.probe) {
            field.opened = true;
            onField?.(field.point, field.known.secure);
          }
        }
      }
      if (field.opened || field.keepTyping) onKeyboardActivate?.();
    }
  };
  const clicked = () => {
    activateField();
    const field = tappedField.current;
    tappedField.current = null;
    if (field && canControl && ready && performance.now() - field.at < 1000) {
      if (field.acknowledged && field.opened && !field.focusActivated)
        onTextTarget(field.point);
    }
  };
  return (
    <>
      <div
        className={`remote-stage${touching ? " is-touching" : ""}`}
        ref={stage}
        tabIndex={0}
        aria-label={`Remote desktop. ${mode === "trackpad" ? "Trackpad mode moves the cursor." : "Tap to click."} ${doubleClick ? "Tap twice quickly to double-click. " : ""}Pinch to zoom. Long press to drag. ${view.scale > 1.01 ? "Swipe to pan. " : ""}Two fingers to scroll.`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onTouchEnd={activateField}
        onClick={clicked}
        // The tap again, as the phone's late mouse events: their default
        // would focus this area and take the phone keyboard away.
        onMouseDown={(event) => {
          if (performance.now() - lastTouch.current < SYNTHETIC_MS) event.preventDefault();
        }}
        // iOS can swallow a quick second tap's touch events and say only
        // this: the second click of the pair, unless the tap itself sent it.
        onDoubleClick={() => {
          const first = lastTap.current;
          lastTap.current = null;
          if (!first || !canControl || !doubleClick || clickMode !== "left" ||
            performance.now() - first.at > DOUBLE_TAP_MS + 300 || performance.now() - lastTouch.current > SYNTHETIC_MS)
            return;
          tapClicks.current.reset();
          tap(first.point, false, first.touch, {
            clickId: first.clickId,
            clickState: 2,
            pair: { x: Math.min(0.1, 8 / Math.max(1, first.image.width)), y: Math.min(0.1, 8 / Math.max(1, first.image.height)) },
          });
        }}
        onPointerCancel={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          // The browser took the touch back mid-tap (a system gesture):
          // nothing went to the computer, and the phone says so.
          const g = gesture.current;
          if (g && !g.multiple && !g.moved && !g.held && mode !== "pan" && performance.now() - g.at < HOLD_MS)
            onFeedback("Tap didn't go through · try again");
          release();
        }}
        onLostPointerCapture={(e) => {
          if (pointers.current.has(e.pointerId)) release();
        }}
        onContextMenu={(e) => {
          tapClicks.current.reset();
          e.preventDefault();
          stopMomentum();
          dropScroll();
          // A finger's long press (Android says contextmenu) is a hold
          // or a drag, never a right-click; a mouse's right button is.
          if (gesture.current || performance.now() - lastTouch.current < SYNTHETIC_MS) return;
          const point =
            mode === "trackpad"
              ? cursorRef.current
              : normalized(e.clientX, e.clientY);
          onInteraction();
          if (point) {
            tap(point, true);
          }
        }}
        onKeyDown={(e) => {
          tapClicks.current.reset();
          stopMomentum();
          dropScroll();
          if (!canControl || e.key === "Escape") return;
          const names: Record<string, string> = {
            ArrowLeft: "left",
            ArrowRight: "right",
            ArrowUp: "up",
            ArrowDown: "down",
            PageUp: "pageup",
            PageDown: "pagedown",
            " ": "space",
          };
          const key = names[e.key] || e.key.toLowerCase();
          if (
            !e.nativeEvent.isComposing &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey &&
            Array.from(e.key).length === 1 &&
            !/^[a-z0-9 ]$/i.test(e.key)
          ) {
            onInteractionStart?.();
            e.preventDefault();
            action({ type: "text", text: e.key });
            return;
          }

          if (
            !/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|enter|backspace|tab|delete|home|end|pageup|pagedown|space|left|right|up|down)$/.test(
              key,
            )
          )
            return;
          onInteractionStart?.();
          e.preventDefault();
          action({
            type: "key",
            key,
            modifiers: [
              ...(e.metaKey ? ["meta"] : []),
              ...(e.altKey ? ["alt"] : []),
              ...(e.ctrlKey ? ["control"] : []),
              ...(e.shiftKey ? ["shift"] : []),
            ],
          });
        }}
      >
        <canvas
          ref={canvas}
          aria-label="Live laptop display"
          className="remote-canvas"
          style={{
            left,
            top,
            width: imageW,
            height: imageH,
            objectFit: "contain",
            visibility: ready ? "visible" : "hidden",
            opacity: stale ? 0.45 : 1,
            transition: "opacity 0.4s ease",
          }}
        />
        {!ready && !connecting && (
          <div className="remote-loading">{idle ?? "Live view is paused"}</div>
        )}
        <ScreenConnection active={connecting} ready={ready} />
        {ready && canControl && size.width > 0 && size.height > 0 && gestureFeedback && <ScreenGestureFeedback
          feedback={gestureFeedback} width={size.width} height={size.height}
        />}
        {waves.map((w) => (
          <span
            key={w.id}
            aria-hidden="true"
            className={`screen-wave ${w.kind}`}
            style={{ left: rendered.left + w.x * rendered.width, top: rendered.top + w.y * rendered.height }}
          >
            <span />
            <span />
          </span>
        ))}
        {/* Zoom means nothing before there's a picture: it sat on the
            connecting scene's words ("100% · Fit" over the cable line). */}
        {ready && (!compact || view.scale > 1.01) && (
          <div
            className={`remote-zoom ${compact ? "compact" : ""}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
            }}
            onPointerUp={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {!compact && (
              <button
                className="button secondary small"
                onClick={() =>
                  zoomAt(view.scale / 1.25, {
                    x: size.width / 2,
                    y: size.height / 2,
                  })
                }
                aria-label="Zoom out"
              >
                −
              </button>
            )}
            <button
              className="button secondary small"
              aria-label="Fit entire screen"
              onClick={() => {
                const fit = { scale: 1, x: 0, y: 0 };
                if (beforeTyping.current) beforeTyping.current = fit;
                setView(fit);
              }}
            >
              {Math.round(view.scale * 100)}% · Fit
            </button>
            {!compact && (
              <button
                className="button secondary small"
                onClick={() =>
                  zoomAt(view.scale * 1.25, {
                    x: size.width / 2,
                    y: size.height / 2,
                  })
                }
                aria-label="Zoom in"
              >
                +
              </button>
            )}
            {!compact && (
              <span>
                Pinch to zoom ·{" "}
                {mode === "trackpad"
                  ? "two fingers to scroll"
                  : view.scale > 1.01 || mode === "pan" ? "swipe to pan · two fingers to scroll" : "swipe to scroll"}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
