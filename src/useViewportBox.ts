import { useLayoutEffect, type RefObject } from "react";
import { holdPage } from "./page-hold";

// Pins an element to the part of the screen the phone keyboard leaves visible.
// iOS Safari shrinks visualViewport, not the layout viewport, when the
// keyboard opens, so the element follows it via --vv-top and --vv-height.
export function useViewportBox(
  element: RefObject<HTMLElement | null>,
  active: boolean,
  prefix = "vv",
) {
  useLayoutEffect(() => {
    const box = element.current;
    if (!active || !box) return;
    // The page underneath frozen from its top (src/page-hold.ts), shared
    // with every other hold: it goes back where it was once the last lets go.
    const letGo = holdPage({ fromTop: true });
    const viewport = window.visualViewport;
    let frame = 0;
    let last = "";
    let still = 0;
    let startedAt = 0;
    const nowMs = () =>
      typeof performance !== "undefined" ? performance.now() : Date.now();
    // The page underneath is frozen at its top, but Safari still scrolls it
    // to show a field (coming back from the photo picker, opening the
    // keyboard), and then draws this view that far down with taps landing
    // off it: put the page back at once.
    const pin = () => {
      if (window.scrollX || window.scrollY) window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    };
    const place = () => {
      pin();
      const top = viewport?.offsetTop || 0;
      const height = viewport?.height || window.innerHeight;
      box.style.setProperty(`--${prefix}-top`, `${top}px`);
      box.style.setProperty(`--${prefix}-height`, `${height}px`);
      box.style.setProperty(`--${prefix}-left`, `${viewport?.offsetLeft || 0}px`);
      box.style.setProperty(`--${prefix}-width`, `${viewport?.width || window.innerWidth}px`);
      box.dataset.compactViewport = String(height < 360);
      return `${top} ${height}`;
    };
    // iOS reports the keyboard's size while it is still sliding in or out and
    // says nothing once it stops (and on 120Hz ProMotion or Home Screen resume
    // can pause >20 frames before updating): keep reading until both frame
    // count and elapsed settle window complete.
    const settle = () => {
      const now = place();
      still = now === last ? still + 1 : 0;
      last = now;
      frame = still < 20 || nowMs() - startedAt < 380 ? requestAnimationFrame(settle) : 0;
    };
    const schedule = () => {
      still = 0;
      startedAt = nowMs();
      if (!frame) frame = requestAnimationFrame(settle);
    };
    last = place();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    // The keyboard starts to close when a field lets go (sending, picking a photo).
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    window.addEventListener("scroll", pin);
    // Back from the Home Screen, photo picker or another app.
    window.addEventListener("focus", schedule);
    window.addEventListener("pageshow", schedule);
    document.addEventListener("resume", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      window.removeEventListener("scroll", pin);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("pageshow", schedule);
      document.removeEventListener("resume", schedule);
      document.removeEventListener("visibilitychange", schedule);
      for (const name of ["top", "height", "left", "width"])
        box.style.removeProperty(`--${prefix}-${name}`);
      delete box.dataset.compactViewport;
      letGo();
    };
  }, [element, active, prefix]);
}
