import { useLayoutEffect, useState, type RefObject } from "react";
import { chromeLayout, safeInsets, type ChromeLayout } from "./screen-chrome";

// The fullscreen Screen's controls in the room the picture leaves (see
// src/screen-chrome.ts), measured again when the phone turns, the window
// resizes, or the computer's screen changes shape.
export function useScreenChrome(
  viewer: RefObject<HTMLElement | null>,
  active: boolean,
  aspect: number,
): ChromeLayout | null {
  const [layout, setLayout] = useState<ChromeLayout | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setLayout(null);
      return;
    }
    const measure = () => {
      const box = viewer.current;
      const view = window.visualViewport;
      const width = box?.clientWidth || view?.width || window.innerWidth;
      const height = box?.clientHeight || view?.height || window.innerHeight;
      const next = chromeLayout(width, height, aspect, safeInsets());
      setLayout((was) =>
        was && was.placement === next.placement && was.rail === next.rail ? was : next,
      );
    };
    // The first one at once, so fullscreen opens already laid out.
    measure();
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const view = window.visualViewport;
    window.addEventListener("resize", later);
    view?.addEventListener("resize", later);
    screen.orientation?.addEventListener?.("change", later);
    const observer = new ResizeObserver(later);
    if (viewer.current) observer.observe(viewer.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", later);
      view?.removeEventListener("resize", later);
      screen.orientation?.removeEventListener?.("change", later);
      observer.disconnect();
    };
  }, [active, aspect, viewer]);
  return layout;
}
