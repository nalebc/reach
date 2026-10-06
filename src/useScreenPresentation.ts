import { useViewportBox } from "./useViewportBox";
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
  // A laptop with an optional touchscreen still uses its mouse/keyboard UI.
  // Only the primary pointer (or a genuinely narrow window) selects touch UI.
  const query = "(pointer: coarse), (max-width: 700px)";
  const [mobile, setMobile] = useState(() => matchMedia(query).matches);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
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
        fullscreenRef.current &&
        (!document.fullscreenElement ||
          document.fullscreenElement === viewer.current)
      ) {
        // Capture before the remote surface forwards Escape to the computer.
        // This also exits the viewport fallback in embedded browsers.
        event.preventDefault();
        event.stopPropagation();
        if (document.fullscreenElement === viewer.current)
          void document.exitFullscreen().catch(() => {});
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      document.removeEventListener("keydown", escape, true);
    };
  }, [viewer]);
  useViewportBox(viewer, expanded, "screen");
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
