// Popups hold the page still behind them. A modal dialog doesn't stop the
// page under it from scrolling (iPhone Safari scrolls it with any swipe), so
// the body is pinned where it is and put back on close. Nested popups share
// one hold; a page already pinned (the full-screen Screen view) stays as is.
let holds = 0;
let release: (() => void) | null = null;

export function holdPage(): () => void {
  if (holds++ === 0) release = pin();
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

function pin() {
  const body = document.body;
  if (body.style.position === "fixed") return null;
  const saved = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    width: body.style.width,
    overflow: body.style.overflow,
  };
  const root = document.documentElement;
  const bounce = root.style.overscrollBehavior;
  const x = window.scrollX,
    y = window.scrollY;
  Object.assign(body.style, {
    position: "fixed",
    top: `${-y}px`,
    left: `${-x}px`,
    width: "100%",
    overflow: "hidden",
  });
  // No rubber band on the page either (Safari bounces even a pinned page).
  root.style.overscrollBehavior = "none";
  return () => {
    root.style.overscrollBehavior = bounce;
    Object.assign(body.style, saved);
    window.scrollTo(x, y);
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
