import { useLayoutEffect, type RefObject } from "react";

// Pins an element to the part of the screen the phone keyboard leaves visible.
// iOS Safari shrinks visualViewport, not the layout viewport, when the
// keyboard opens, so the element follows it via --vv-top and --vv-height.
export function useViewportBox(
  element: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useLayoutEffect(() => {
    const box = element.current;
    if (!active || !box) return;
    const body = document.body;
    const saved = body.style.cssText;
    const x = window.scrollX,
      y = window.scrollY;
    // iOS Safari draws a fixed element shifted by however far the page was
    // scrolled once the page underneath is frozen (a chat opened from a list
    // scrolled down showed up half way down the screen, its composer off it).
    // Freeze the page from its top instead; it goes back where it was after.
    if (x || y) window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    // Stop the page underneath from scrolling when the keyboard opens.
    Object.assign(body.style, {
      position: "fixed",
      top: "0px",
      left: "0px",
      width: "100%",
      overflow: "hidden",
    });
    const viewport = window.visualViewport;
    let frame = 0;
    let last = "";
    let still = 0;
    const place = () => {
      const top = viewport?.offsetTop || 0;
      const height = viewport?.height || window.innerHeight;
      box.style.setProperty("--vv-top", `${top}px`);
      box.style.setProperty("--vv-height", `${height}px`);
      return `${top} ${height}`;
    };
    // iOS reports the keyboard's size while it is still sliding in or out and
    // says nothing once it stops (the view stayed squeezed for seconds after
    // the keyboard closed): keep reading each frame until it holds still.
    const settle = () => {
      const now = place();
      still = now === last ? still + 1 : 0;
      last = now;
      frame = still < 20 ? requestAnimationFrame(settle) : 0;
    };
    const schedule = () => {
      still = 0;
      if (!frame) frame = requestAnimationFrame(settle);
    };
    last = place();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    // The keyboard starts to close when a field lets go (sending, picking a photo).
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      box.style.removeProperty("--vv-top");
      box.style.removeProperty("--vv-height");
      body.style.cssText = saved;
      window.scrollTo({ left: x, top: y, behavior: "instant" });
    };
  }, [element, active]);
}
