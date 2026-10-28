// One hold on the page for everything that freezes it: popups and sheets
// (holdPage) and the views pinned to what the keyboard leaves visible
// (useViewportBox). A modal dialog doesn't stop the page under it from
// scrolling (iPhone Safari scrolls it with any swipe), so the body is pinned
// and put back when the last holder lets go, whatever the order. Each
// holder used to save and put back the page on its own: a sheet closing
// after a chat opened under it (or before it) put back a stale copy, and the
// page stayed pinned with nothing open, drawn in one place and tapped in
// another on an iPhone ("taps and typing do nothing", Oct 27).
let holds = 0;
let release: (() => void) | null = null;

// `fromTop`: frozen from the page's top, not where it is (a keyboard view:
// iOS Safari draws a fixed view shifted by however far the page was
// scrolled). Only the first holder chooses; later ones share its hold.
export function holdPage({ fromTop = false }: { fromTop?: boolean } = {}): () => void {
  if (holds++ === 0) release = pin(fromTop);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--holds === 0) {
      release?.();
      release = null;
    }
  };
}
// Whether anything holds the page now (tests and the freeze record).
export const pageHeld = () => holds > 0;

function pin(fromTop: boolean) {
  const body = document.body;
  const saved = body.style.cssText;
  const root = document.documentElement;
  const bounce = root.style.overscrollBehavior;
  const x = window.scrollX,
    y = window.scrollY;
  if (fromTop && (x || y)) window.scrollTo({ left: 0, top: 0, behavior: "instant" });
  Object.assign(body.style, {
    position: "fixed",
    top: fromTop ? "0px" : `${-y}px`,
    left: fromTop ? "0px" : `${-x}px`,
    width: "100%",
    overflow: "hidden",
  });
  // No rubber band on the page either (Safari bounces even a pinned page).
  root.style.overscrollBehavior = "none";
  return () => {
    root.style.overscrollBehavior = bounce;
    body.style.cssText = saved;
    // Back where it was, as each holder always put it back.
    if (fromTop) window.scrollTo({ left: x, top: y, behavior: "instant" });
    else window.scrollTo(x, y);
  };
}

// iPhone Safari still drags a sheet whose content fits, and the page under
// it. Inside a popup a swipe moves only something that can scroll there (a
// long list, a text box) or a slider; anything else is held.
export function holdTouches(popup: HTMLElement) {
  const move = (event: Event) => {
    if (!movable(event.target, popup)) event.preventDefault();
  };
  popup.addEventListener("touchmove", move, { passive: false });
  return () => popup.removeEventListener("touchmove", move);
}

function movable(target: EventTarget | null, popup: HTMLElement) {
  const scrolls = (overflow: string, size: number, room: number) =>
    /(auto|scroll)/.test(overflow) && size > room;
  for (
    let el = target instanceof Element ? target : null;
    el;
    el = el.parentElement
  ) {
    if (el.matches('input[type="range"]')) return true;
    const style = getComputedStyle(el);
    if (
      scrolls(style.overflowY, el.scrollHeight, el.clientHeight) ||
      scrolls(style.overflowX, el.scrollWidth, el.clientWidth)
    )
      return true;
    if (el === popup) break;
  }
  return false;
}
