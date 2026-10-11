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
  focusView,
  pinchView,
  typingView,
} from "./desktop-geometry";
import { screenPoint } from "./screen-pointer";
import ScreenConnection from "./ScreenConnection";
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
type Point = { x: number; y: number };
type Ripple = Point & { id: number; status: string };
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
  onInteraction,
  onTextTarget,
  probe,
  onField,
  knownField,
  onStaleFields,
  resetKey,
  initialCursor,
  compact = false,
  focusPoint,
  focusRect,
  typing = false,
  touchScroll = false,
  idle,
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
  onInteraction: () => void;
  onTextTarget: (point: Point) => void;
  // Asked on touch-down: is there a text field under the finger? When the
  // answer is back before the finger lifts, onField opens the keyboard on
  // that same tap (Safari opens it only during a tap).
  probe?: (point: Point) => Promise<unknown>;
  onField?: (point: Point, secure: boolean) => void;
  // A text field the computer already said is here (its pushed map): the
  // keyboard opens on the tap without waiting for the probe.
  knownField?: (point: Point) => { secure: boolean } | null;
  // The probe found no field where the map had one: the map is out of date.
  onStaleFields?: () => void;
  // The Mac can't see what's under the finger (a game, a canvas, a remote
  // desktop): its text fields can't be found, so offer the keyboard button.
  resetKey: string;
  initialCursor: Point | null;
  compact?: boolean;
  focusPoint?: Point;
  // An area to open on (fractions of the screen): a Mac dialog to answer.
  focusRect?: { x: number; y: number; width: number; height: number } | null;
  typing?: boolean;
  // Direct swipes scroll the computer; Pan & zoom remains available in options.
  touchScroll?: boolean;
  // Shown instead of "Live view is paused" while nothing streams.
  idle?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 }),
    viewRef = useRef(view);
  viewRef.current = view;
  const beforeTyping = useRef<typeof view | null>(null);
  const cursorRef = useRef<Point>({ x: 0.5, y: 0.5 });
  const [ripples, setRipples] = useState<Ripple[]>([]),
    timers = useRef(new Set<ReturnType<typeof setTimeout>>()),
    serial = useRef(0);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    start: Point;
    last: Point;
    at: number;
    moved: boolean;
    held: boolean;
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
  } | null>(null);
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
    known: { secure: boolean } | null;
    at: number;
    acknowledged: boolean;
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
  const moveCursor = (p: Point) => {
    cursorRef.current = p;
  };
  const action = (a: DesktopAction) => {
    if (!canControl) return;
    void send(a).catch((e: Error) => onFeedback(e.message));
  };
  const release = () => {
    clearTimeout(hold.current);
    if (gesture.current?.held) {
      void send({ type: "release" }).catch(() => {});
      onDragEnd();
    }
    gesture.current = null;
    pointers.current.clear();
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
    setRipples([]);
    moveCursor({ x: 0.5, y: 0.5 });
  }, [resetKey]);
  useEffect(() => {
    release();
  }, [mode]);
  useEffect(() => {
    if (!canControl) release();
  }, [canControl]);
  useEffect(() => {
    if (initialCursor) moveCursor(initialCursor);
  }, [initialCursor]);
  useEffect(
    () => () => {
      clearTimeout(hold.current);
      for (const timer of timers.current) clearTimeout(timer);
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
  const bounded = (scale: number, x: number, y: number) =>
    boundView(scale, x, y, baseW, baseH, size.width, size.height);
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
  const zoomAt = (scale: number, p: Point) => {
    const v = viewRef.current,
      next = clamp(scale, 1, 4),
      ox = (size.width - baseW * v.scale) / 2 + v.x,
      oy = (size.height - baseH * v.scale) / 2 + v.y;
    setView(
      bounded(
        next,
        p.x - ((p.x - ox) / v.scale) * next - (size.width - baseW * next) / 2,
        p.y - ((p.y - oy) / v.scale) * next - (size.height - baseH * next) / 2,
      ),
    );
  };
  const ripple = (point: Point, right = false) => {
    const id = ++serial.current;
    setRipples((r) => [
      ...r.slice(-7),
      { ...point, id, status: canControl ? "sending" : "local" },
    ]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setRipples((r) => r.filter((x) => x.id !== id));
    }, 900);
    timers.current.add(timer);
    if (!canControl) {
      onFeedback("View only · enable control to interact");
      return;
    }
    onFeedback("");
    void send({
      type: "click",
      ...point,
      button: right || clickMode === "right" ? "right" : "left",
      count: clickMode === "double" && !right ? 2 : 1,
    })
      .then(() => {
        setRipples((r) =>
          r.map((x) => (x.id === id ? { ...x, status: "sent" } : x)),
        );
        if (id === serial.current && !right && clickMode !== "right") {
          // The host can acknowledge before Safari delivers the tap's click.
          // Wait for that click to open the keyboard before confirming focus.
          const field = tappedField.current;
          if (field?.point === point) {
            field.acknowledged = true;
            return;
          }
          onTextTarget(point);
        }
      })
      .catch(() => {
        setRipples((r) =>
          r.map((x) => (x.id === id ? { ...x, status: "failed" } : x)),
        );
        onFeedback("Click was not sent");
        if (id === serial.current) {
          tappedField.current = null;
          onInteraction();
        }
      });
  };
  wheelHandler.current = (e) => {
    if (e.ctrlKey || e.metaKey || mode === "pan" || !canControl)
      zoomAt(
        view.scale * Math.exp(-e.deltaY * 0.002),
        local(e.clientX, e.clientY),
      );
    else {
      const point = normalized(e.clientX, e.clientY);
      if (!point) return;
      action({ type: "move", ...point });
      const units =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.height : 1;
      action({
        type: "scroll",
        dx: clamp(-e.deltaX * units, -120, 120) || 0,
        dy: clamp(-e.deltaY * units, -120, 120) || 0,
      });
    }
  };
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    serial.current++;
    if (typing) event.preventDefault();
    else stage.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = local(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, p);
    if (pointers.current.size === 1) {
      const point =
        mode === "trackpad"
          ? cursorRef.current
          : normalized(event.clientX, event.clientY);
      gesture.current = {
        start: p,
        last: p,
        at: performance.now(),
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
      tappedField.current = null;
      if (point && mode !== "pan" && canControl && probe && onField) {
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
        const begin = () => {
          if (
            gesture.current &&
            !gesture.current.multiple &&
            !gesture.current.moved
          ) {
            gesture.current.held = true;
            action({
              type: "down",
              ...cursorRef.current,
              button: clickMode === "right" ? "right" : "left",
            });
            onFeedback("Dragging · lift to release");
          }
        };
        if (drag) begin();
        else hold.current = setTimeout(begin, 400);
      }
    } else if (pointers.current.size === 2 && gesture.current) {
      clearTimeout(hold.current);
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
      });
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
      if (Math.abs(distance / Math.max(1, g.distance) - 1) > 0.06)
        g.pinch = true;
      if (g.pinch) {
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
      } else if (mode === "trackpad" && canControl) {
        action({
          type: "scroll",
          dx: clamp(mid.x - g.mid.x, -120, 120),
          dy: clamp(mid.y - g.mid.y, -120, 120),
        });
      } else
        setView((v) =>
          bounded(v.scale, v.x + mid.x - g.mid.x, v.y + mid.y - g.mid.y),
        );
      g.mid = mid;
      return;
    }
    if (g.multiple) return;
    const dx = p.x - g.last.x,
      dy = p.y - g.last.y;
    if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 8) {
      g.moved = true;
      clearTimeout(hold.current);
    }
    if (mode === "trackpad" && canControl) {
      const point = {
        x: clamp(cursorRef.current.x + dx / Math.max(1, baseW), 0, 1),
        y: clamp(cursorRef.current.y + dy / Math.max(1, baseH), 0, 1),
      };
      moveCursor(point);
      action({ type: "move", ...point });
    } else if (g.held && canControl) {
      const box = canvas.current!.getBoundingClientRect();
      const point = {
        x: clamp((event.clientX - box.left) / box.width, 0, 1),
        y: clamp((event.clientY - box.top) / box.height, 0, 1),
      };
      moveCursor(point);
      action({ type: "move", ...point });
    } else if (
      g.moved &&
      touchScroll &&
      mode === "direct" &&
      canControl &&
      event.pointerType === "touch"
    ) {
      // The pointer goes there once, then only the scroll: a move with each
      // step kept the steps from merging, and control ended in half a second.
      if (!g.scrolling) {
        g.scrolling = true;
        action({ type: "move", ...cursorRef.current });
      }
      action({
        type: "scroll",
        dx: clamp(dx, -120, 120),
        dy: clamp(dy, -120, 120),
      });
    } else if (g.moved) setView((v) => bounded(v.scale, v.x + dx, v.y + dy));
    g.last = p;
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    clearTimeout(hold.current);
    pointers.current.delete(event.pointerId);
    if (!g) return;
    if (g.held) {
      action({
        type: "up",
        ...cursorRef.current,
        button: clickMode === "right" ? "right" : "left",
      });
      g.held = false;
      onDragEnd();
      onInteraction();
      onFeedback("Drag released");
    } else if (
      !g.multiple &&
      !g.moved &&
      performance.now() - g.at < 400 &&
      mode !== "pan" &&
      event.button !== 2
    ) {
      const point =
        mode === "trackpad"
          ? cursorRef.current
          : normalized(event.clientX, event.clientY);
      if (point) {
        onInteraction();
        const answer = probeAnswer.current;
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
          };
        ripple(point);
      }
    }
    if (!pointers.current.size) gesture.current = null;
  };
  // The click that follows a tap is when Safari lets the keyboard open.
  const clicked = () => {
    const field = tappedField.current;
    tappedField.current = null;
    if (field && canControl && ready && performance.now() - field.at < 1000) {
      // The probe's own answer is the freshest; the map stands in until it comes.
      const answer = probeAnswer.current;
      if (answer?.id === field.probe) {
        if (answer.field) onField?.(field.point, answer.secure);
      } else if (field.known) onField?.(field.point, field.known.secure);
      if (field.acknowledged) onTextTarget(field.point);
    }
  };
  return (
    <>
      <div
        className="remote-stage"
        ref={stage}
        tabIndex={0}
        aria-label={`Remote desktop. ${mode === "trackpad" ? "Trackpad mode moves the cursor." : "Tap to click."} Pinch to zoom. Long press to drag.`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onClick={clicked}
        onPointerCancel={release}
        onLostPointerCapture={(e) => {
          if (pointers.current.has(e.pointerId)) release();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (gesture.current?.held) return;
          const point =
            mode === "trackpad"
              ? cursorRef.current
              : normalized(e.clientX, e.clientY);
          if (point) {
            onInteraction();
            ripple(point, true);
          }
        }}
        onKeyDown={(e) => {
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
            visibility: ready ? "visible" : "hidden",
            opacity: stale ? 0.45 : 1,
            transition: "opacity 0.4s ease",
          }}
        />
        {!ready && !connecting && (
          <div className="remote-loading">{idle ?? "Live view is paused"}</div>
        )}
        <ScreenConnection active={connecting} ready={ready} />
        {ripples.map((r) => (
          <span
            key={r.id}
            aria-hidden="true"
            className={`screen-click-ripple ${r.status}`}
            style={{ left: left + r.x * imageW, top: top + r.y * imageH }}
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
                  : "drag the view to pan"}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
