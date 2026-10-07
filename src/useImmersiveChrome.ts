import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// Fullscreen shows only the computer. Lifting a finger anywhere reveals the
// controls for a few seconds; the touch itself still reaches the computer.
// Revealing on pointerup (not pointerdown) keeps bars from appearing under a
// tap that is still in progress. Pinned states keep the controls visible.
export function useImmersiveChrome(
  viewer: RefObject<HTMLElement | null>,
  active: boolean,
  pinned: boolean,
  delay = 3000,
) {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), delay);
  }, [delay]);
  useEffect(() => {
    if (!active) {
      clearTimeout(timer.current);
      setVisible(true);
      return;
    }
    // Show briefly on entry so people see where the controls went.
    reveal();
    const element = viewer.current;
    // Taps on the always-visible essentials must not swap them out mid-tap.
    const touched = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-immersive-keep]"))
        reveal();
    };
    element?.addEventListener("pointerup", touched, { capture: true, passive: true });
    return () => {
      clearTimeout(timer.current);
      element?.removeEventListener("pointerup", touched, { capture: true });
    };
  }, [active, reveal, viewer]);
  useEffect(() => {
    if (active && !pinned) reveal();
  }, [active, pinned, reveal]);
  return !active || pinned || visible;
}
