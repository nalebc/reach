import { useCallback, useRef } from "react";

// A page swipe changes apps; rails, fields and overlays keep their own gestures.
export function useChatAppSwipe(
  apps: readonly { agent: string }[],
  value: string,
  onChange: (app: string) => void,
) {
  const latest = useRef({ apps, value, onChange });
  latest.current = { apps, value, onChange };

  return useCallback((page: HTMLDivElement | null) => {
    if (!page) return;
    let gesture: {
      id: number;
      x: number;
      y: number;
      at: number;
      app: string;
      horizontal: boolean;
    } | null = null;
    let suppressClickUntil = 0;
    const blocked = () =>
      page.ownerDocument.querySelector('[role="dialog"], [role="menu"]') ||
      page.ownerDocument.getSelection()?.isCollapsed === false;
    const start = (event: TouchEvent) => {
      gesture = null;
      suppressClickUntil = 0;
      // Leave swipes at the screen edges to the phone's navigation.
      const point = event.touches[0];
      if (
        event.touches.length !== 1 ||
        latest.current.apps.length < 2 ||
        !point ||
        point.clientX < 24 ||
        point.clientX > window.innerWidth - 24 ||
        blocked()
      )
        return;
      const target = event.target as Element;
      if (
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], .chat-app-rail, .claw-channels, .needs-track, pre',
        )
      )
        return;
      for (let el = target; el && el !== page; el = el.parentElement!) {
        if (
          el.scrollWidth > el.clientWidth + 1 &&
          /auto|scroll/.test(window.getComputedStyle(el).overflowX)
        )
          return;
      }
      gesture = {
        id: point.identifier,
        x: point.clientX,
        y: point.clientY,
        at: Date.now(),
        app: latest.current.value,
        horizontal: false,
      };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || blocked()) {
        gesture = null;
        return;
      }
      const point = event.touches[0];
      if (point.identifier !== gesture.id) {
        gesture = null;
        return;
      }
      const dx = Math.abs(point.clientX - gesture.x);
      const dy = Math.abs(point.clientY - gesture.y);
      if (!gesture.horizontal) {
        if (dy > 12 && dy >= dx) {
          gesture = null;
          return;
        }
        if (dx < 12 || dx < dy * 1.6) return;
        gesture.horizontal = true;
      }
      // A non-passive listener keeps Safari from scrolling or tapping a row
      // after a horizontal gesture. Vertical scrolling never reaches this.
      if (event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const from = gesture;
      gesture = null;
      if (!from) return;
      const point = [...event.changedTouches].find(
        (t) => t.identifier === from.id,
      );
      if (event.touches.length || !point || blocked()) return;
      const dx = point.clientX - from.x;
      const dy = Math.abs(point.clientY - from.y);
      if (from.horizontal) {
        suppressClickUntil = Date.now() + 400;
        if (event.cancelable) event.preventDefault();
      }
      if (
        Math.abs(dx) < 80 ||
        dy > 48 ||
        Math.abs(dx) < dy * 1.6 ||
        Date.now() - from.at > 800 ||
        from.app !== latest.current.value
      )
        return;
      suppressClickUntil = Date.now() + 400;
      if (event.cancelable) event.preventDefault();
      const { apps, value, onChange } = latest.current;
      const index = apps.findIndex((app) => app.agent === value);
      const next = apps[index + (dx < 0 ? 1 : -1)];
      if (index >= 0 && next) onChange(next.agent);
    };
    const cancel = () => {
      gesture = null;
    };
    const click = (event: MouseEvent) => {
      if (event.detail && Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    page.addEventListener("touchstart", start, { passive: true });
    page.addEventListener("touchmove", move, { passive: false });
    page.addEventListener("touchend", end, { passive: false });
    page.addEventListener("touchcancel", cancel);
    page.addEventListener("click", click, true);
    return () => {
      page.removeEventListener("touchstart", start);
      page.removeEventListener("touchmove", move);
      page.removeEventListener("touchend", end);
      page.removeEventListener("touchcancel", cancel);
      page.removeEventListener("click", click, true);
    };
  }, []);
}
