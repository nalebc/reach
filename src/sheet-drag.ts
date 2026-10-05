// A bottom sheet follows your finger down from its handle (or its header)
// and closes once pulled past a quarter of its height, or flicked; otherwise
// it springs back. Only while the handle shows (bottom sheets on phones).
export function dragToClose(sheet: HTMLElement, close: () => void) {
  let start: { y: number; id: number } | null = null;
  let last = { y: 0, at: 0 },
    speed = 0,
    pulled = 0;
  const grabbable = (target: EventTarget | null) => {
    const handle = sheet.querySelector<HTMLElement>(".sheet-handle");
    if (!handle || getComputedStyle(handle).display === "none") return false;
    const el = target instanceof Element ? target : null;
    return (
      !!el?.closest(".sheet-handle, [data-sheet-grab]") &&
      !el.closest("button, a, input, textarea, select")
    );
  };
  const slide = (y: number, animate: boolean) => {
    sheet.style.transition = animate
      ? "translate 0.24s cubic-bezier(0.2, 0.8, 0.2, 1)"
      : "none";
    sheet.style.translate = y ? `0 ${y}px` : "";
  };
  const move = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) return;
    const dt = event.timeStamp - last.at;
    if (dt > 0) speed = (event.clientY - last.y) / dt;
    last = { y: event.clientY, at: event.timeStamp };
    pulled = Math.max(0, event.clientY - start.y);
    slide(pulled, false);
  };
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    // A drag isn't a tap: the click that follows it does nothing.
    if (pulled > 6) {
      const swallow = (e: Event) => e.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true));
    }
    const far = pulled > Math.min(140, sheet.offsetHeight * 0.25 || 140);
    const flick = pulled > 24 && speed > 0.6;
    if (event.type === "pointerup" && (far || flick)) {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) close();
      else {
        slide(sheet.offsetHeight || window.innerHeight, true);
        setTimeout(close, 200);
      }
    } else slide(0, true);
  };
  const down = (event: PointerEvent) => {
    if (start || !grabbable(event.target)) return;
    start = { y: event.clientY, id: event.pointerId };
    last = { y: event.clientY, at: event.timeStamp };
    speed = 0;
    pulled = 0;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  sheet.addEventListener("pointerdown", down);
  return () => {
    sheet.removeEventListener("pointerdown", down);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
}
