import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { MotionContext } from "./motion";
import type { ChatAppChoice } from "./ChatList";
import "./chat-app-pager.css";

type Point = { clientX: number; clientY: number; identifier: number };

// Only the current page is mounted at rest. A neighboring page is rendered
// during the drag, then promoted in place so its loaded data stays with it.
export default function ChatAppPager({
  apps,
  value,
  onChange,
  hidden,
  children,
}: {
  apps: ChatAppChoice[];
  value: string;
  onChange: (app: string) => void;
  hidden?: boolean;
  children: (app: ChatAppChoice, active: boolean) => ReactNode;
}) {
  const [neighbor, setNeighbor] = useState<string | null>(null);
  const motion = useContext(MotionContext);
  const latest = useRef({ apps, value, onChange, hidden, motion });
  latest.current = { apps, value, onChange, hidden, motion };
  const reset = useRef<() => void>(() => {});
  useLayoutEffect(() => reset.current(), [value, hidden]);

  const bind = useCallback((page: HTMLDivElement | null) => {
    if (!page) return;
    let gesture: {
      id: number;
      x: number;
      y: number;
      app: string;
      horizontal: boolean;
      lastX: number;
      lastAt: number;
      velocity: number;
    } | null = null;
    let nextApp: string | null = null;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish: (() => void) | null = null;
    let suppressClickUntil = 0;
    let offset = 0;
    const width = () => page.getBoundingClientRect().width || window.innerWidth;
    const blocked = () =>
      latest.current.hidden ||
      page.ownerDocument.querySelector(
        '[role="dialog"], dialog[open], [role="menu"]',
      ) ||
      page.ownerDocument.getSelection()?.isCollapsed === false;
    const clear = () => {
      gesture = null;
      finish = null;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      frame = 0;
      nextApp = null;
      offset = 0;
      delete page.dataset.motion;
      page.style.removeProperty("--chat-page-x");
      page.style.removeProperty("--chat-page-origin");
      page.style.removeProperty("--chat-page-visible-bottom");
      setNeighbor(null);
    };
    reset.current = clear;
    const write = () => {
      page.style.setProperty("--chat-page-x", `${offset}px`);
      frame = 0;
    };
    const settlePage = (to: string | null) => {
      const from = latest.current.value;
      cancelAnimationFrame(frame);
      write();
      // Commit the drag position before asking CSS to animate the release.
      void page.offsetWidth;
      const reduced =
        !latest.current.motion.enabled ||
        latest.current.motion.reduced ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      page.dataset.motion = "settling";
      offset = to ? (offset < 0 ? -width() : width()) : 0;
      write();
      finish = () => {
        const change =
          to &&
          latest.current.value === from &&
          latest.current.apps.some((app) => app.agent === to) &&
          !blocked();
        // The incoming keyed pane becomes the current one in the same paint.
        flushSync(() => {
          clear();
          if (change) latest.current.onChange(to!);
        });
      };
      if (reduced) finish();
      else timer = setTimeout(() => finish?.(), 320);
    };
    const cancel = () => {
      const moved = gesture?.horizontal;
      gesture = null;
      if (moved) settlePage(null);
    };
    const start = (point: Point, target: Element) => {
      if (
        finish ||
        latest.current.motion.hidden ||
        blocked() ||
        latest.current.apps.length < 2 ||
        point.clientX < 24 ||
        point.clientX > window.innerWidth - 24
      )
        return;
      if (
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], .chat-app-rail, .claw-channels, .claw-tabs, .needs-track, pre, .claw-conversation, .as-page',
        )
      )
        return;
      for (
        let el: Element | null = target;
        el && el !== page;
        el = el.parentElement
      ) {
        if (
          el.scrollWidth > el.clientWidth + 1 &&
          /auto|scroll/.test(window.getComputedStyle(el).overflowX)
        )
          return;
      }
      suppressClickUntil = 0;
      gesture = {
        id: point.identifier,
        x: point.clientX,
        y: point.clientY,
        app: latest.current.value,
        horizontal: false,
        lastX: point.clientX,
        lastAt: Date.now(),
        velocity: 0,
      };
    };
    const move = (point: Point, event: Event) => {
      const from = gesture;
      if (!from) return;
      if (
        point.identifier !== from.id ||
        blocked() ||
        from.app !== latest.current.value
      ) {
        cancel();
        return;
      }
      const dx = point.clientX - from.x;
      const dy = Math.abs(point.clientY - from.y);
      if (!from.horizontal) {
        if (dy > 12 && dy >= Math.abs(dx)) {
          gesture = null;
          return;
        }
        if (Math.abs(dx) < 12 || Math.abs(dx) < dy * 1.6) return;
        from.horizontal = true;
        page.dataset.motion = "dragging";
        page.style.setProperty(
          "--chat-page-visible-bottom",
          `${window.innerHeight - page.getBoundingClientRect().top}px`,
        );
      }
      if (event.cancelable) event.preventDefault();
      const index = latest.current.apps.findIndex(
        (app) => app.agent === from.app,
      );
      const next = latest.current.apps[index + (dx < 0 ? 1 : -1)];
      const nextValue = next?.agent || null;
      if (nextValue !== nextApp) {
        nextApp = nextValue;
        page.style.setProperty("--chat-page-origin", dx < 0 ? "100%" : "-100%");
        flushSync(() => setNeighbor(nextValue));
      }
      const now = Date.now();
      from.velocity =
        (point.clientX - from.lastX) / Math.max(1, now - from.lastAt);
      from.lastX = point.clientX;
      from.lastAt = now;
      offset = next
        ? Math.max(-width(), Math.min(width(), dx))
        : Math.sign(dx) * Math.min(32, Math.abs(dx) * 0.18);
      if (!frame) frame = requestAnimationFrame(write);
    };
    const end = (point: Point | undefined, event: Event) => {
      const from = gesture;
      gesture = null;
      if (!from?.horizontal) return;
      suppressClickUntil = Date.now() + 400;
      if (event.cancelable) event.preventDefault();
      const dx = point ? point.clientX - from.x : 0;
      const dy = point ? Math.abs(point.clientY - from.y) : Infinity;
      const index = latest.current.apps.findIndex(app => app.agent === from.app);
      const destination = latest.current.apps[index + (dx < 0 ? 1 : -1)]?.agent;
      const flick =
        Math.abs(dx) >= 64 &&
        Math.abs(from.velocity) >= 0.6 &&
        Math.sign(from.velocity) === Math.sign(dx) &&
        Date.now() - from.lastAt < 100;
      const commit =
        point?.identifier === from.id &&
        nextApp &&
        nextApp === destination &&
        !blocked() &&
        from.app === latest.current.value &&
        dy <= 48 &&
        Math.abs(dx) >= dy * 1.6 &&
        (Math.abs(dx) >= Math.min(96, width() * 0.25) || flick);
      settlePage(commit ? nextApp : null);
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        cancel();
        return;
      }
      start(event.touches[0], event.target as Element);
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        cancel();
        return;
      }
      move(event.touches[0], event);
    };
    const touchEnd = (event: TouchEvent) => {
      if (event.touches.length) {
        cancel();
        return;
      }
      end(
        [...event.changedTouches].find(
          (point) => point.identifier === gesture?.id,
        ),
        event,
      );
    };
    // Mouse dragging also makes the interaction usable with a trackpad and
    // in desktop previews. Touch stays on Safari's non-passive touch path.
    const mousePoint = (event: PointerEvent) => ({
      clientX: event.clientX,
      clientY: event.clientY,
      identifier: event.pointerId,
    });
    const pointerStart = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button === 0)
        start(mousePoint(event), event.target as Element);
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      move(mousePoint(event), event);
      if (gesture?.horizontal) page.setPointerCapture?.(event.pointerId);
    };
    const pointerEnd = (event: PointerEvent) => {
      if (event.pointerType === "mouse") end(mousePoint(event), event);
    };
    const click = (event: MouseEvent) => {
      if (event.detail && Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const transitionEnd = (event: TransitionEvent) => {
      if (
        event.target === page.firstElementChild &&
        event.propertyName === "transform"
      )
        finish?.();
    };
    const hidden = () => {
      if (page.ownerDocument.hidden) clear();
    };
    page.addEventListener("touchstart", touchStart, { passive: true });
    page.addEventListener("touchmove", touchMove, { passive: false });
    page.addEventListener("touchend", touchEnd, { passive: false });
    page.addEventListener("touchcancel", cancel);
    page.addEventListener("pointerdown", pointerStart);
    page.addEventListener("pointermove", pointerMove);
    page.addEventListener("pointerup", pointerEnd);
    page.addEventListener("pointercancel", cancel);
    page.addEventListener("click", click, true);
    page.addEventListener("transitionend", transitionEnd);
    page.ownerDocument.addEventListener("visibilitychange", hidden);
    window.addEventListener("resize", clear);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      reset.current = () => {};
      page.removeEventListener("touchstart", touchStart);
      page.removeEventListener("touchmove", touchMove);
      page.removeEventListener("touchend", touchEnd);
      page.removeEventListener("touchcancel", cancel);
      page.removeEventListener("pointerdown", pointerStart);
      page.removeEventListener("pointermove", pointerMove);
      page.removeEventListener("pointerup", pointerEnd);
      page.removeEventListener("pointercancel", cancel);
      page.removeEventListener("click", click, true);
      page.removeEventListener("transitionend", transitionEnd);
      page.ownerDocument.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("resize", clear);
    };
  }, []);
  const visible = [
    value,
    ...(neighbor && neighbor !== value ? [neighbor] : []),
  ];
  return (
    <div
      ref={bind}
      className="chat-app-pages"
      aria-hidden={hidden || undefined}
    >
      {visible.map((agent) => {
        const app = apps.find((app) => app.agent === agent);
        if (!app) return null;
        const active = agent === value;
        return (
          <div
            key={agent}
            className={`chat-page-pane ${active ? "current" : "neighbor"}`}
            data-app={agent}
            aria-hidden={!active || undefined}
            inert={!active || undefined}
          >
            {children(app, active)}
          </div>
        );
      })}
    </div>
  );
}
