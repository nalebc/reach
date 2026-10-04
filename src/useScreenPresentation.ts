import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

// Keep the desktop and native keyboard in the same visible viewport. Safari's keyboard
// changes visualViewport without necessarily resizing the layout viewport.
export function useScreenPresentation(
  viewer: RefObject<HTMLElement | null>,
  typing: boolean,
) {
  const query = "(any-pointer: coarse), (max-width: 700px)";
  const [mobile, setMobile] = useState(() => matchMedia(query).matches);
  const [fullscreen, setFullscreen] = useState(false);
  const nativeActive = useRef(false);
  const nativeEnteredAt = useRef(0);
  const expanded = fullscreen || (typing && mobile);
  useLayoutEffect(() => {
    const media = matchMedia(query);
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    const changed = () => {
      if (document.fullscreenElement === viewer.current) {
        nativeActive.current = true;
        setFullscreen(true);
        nativeEnteredAt.current = performance.now();
      } else if (nativeActive.current) {
        nativeActive.current = false;
        // Some embedded browsers enter and immediately withdraw fullscreen.
        // Keep our viewport fallback for that failed transition.
        if (performance.now() - nativeEnteredAt.current >= 250)
          setFullscreen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        (nativeActive.current || !document.fullscreenElement) &&
        !event.defaultPrevented
      )
        setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      document.removeEventListener("keydown", escape);
    };
  }, [viewer]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const element = viewer.current;
    if (!element) return;
    const body = document.body;
    const saved = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    const x = window.scrollX,
      y = window.scrollY;
    Object.assign(body.style, {
      position: "fixed",
      top: `${-y}px`,
      left: `${-x}px`,
      width: "100%",
      overflow: "hidden",
    });
    const viewport = window.visualViewport;
    let frame = 0;
    const position = () => {
      frame = 0;
      element.style.setProperty(
        "--screen-top",
        `${viewport?.offsetTop || 0}px`,
      );
      element.style.setProperty(
        "--screen-left",
        `${viewport?.offsetLeft || 0}px`,
      );
      element.style.setProperty(
        "--screen-width",
        `${viewport?.width || window.innerWidth}px`,
      );
      element.dataset.compactViewport = String(
        (viewport?.height || window.innerHeight) < 360,
      );
      element.style.setProperty(
        "--screen-height",
        `${viewport?.height || window.innerHeight}px`,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(position);
    };
    position();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      for (const name of ["top", "left", "width", "height"])
        element.style.removeProperty(`--screen-${name}`);
      delete element.dataset.compactViewport;
      Object.assign(body.style, saved);
      window.scrollTo({ left: x, top: y, behavior: "instant" });
    };
  }, [expanded, viewer]);
  const toggleFullscreen = useCallback(async () => {
    if (fullscreen) {
      if (document.fullscreenElement === viewer.current)
        await document.exitFullscreen().catch(() => {});
      setFullscreen(false);
    } else {
      setFullscreen(true);
      // Use an in-page fullscreen on touch devices so the native keyboard can
      // coexist with the desktop. Desktop browsers still get native fullscreen.
      if (!mobile) {
        try {
          await viewer.current?.requestFullscreen?.();
        } catch {
          /* The viewport fallback remains usable when the API is denied. */
        }
      }
    }
  }, [fullscreen, mobile, viewer]);
  return { fullscreen, expanded, mobile, toggleFullscreen };
}
