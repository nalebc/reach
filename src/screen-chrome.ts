// Fullscreen is the computer and nothing else, upright or on its side, as a
// video plays fullscreen: the stage fills the usable viewport and the
// controls float over it, fading until the screen is touched. Showing them
// never changes the image's size or origin, so taps and held drags keep
// their target. Typing keeps its own keyboard layout (screen-immersive.css).
export type Rect = { x: number; y: number; w: number; h: number };
export type Insets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
export type ChromeLayout = {
  placement: "overlay";
  stage: Rect;
  picture: Rect;
};
const none: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const fit = (box: Rect, aspect: number): Rect => {
  const w = Math.min(box.w, box.h * aspect),
    h = w / aspect;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
};
export function chromeLayout(
  width: number,
  height: number,
  aspect: number,
  insets: Insets = none,
): ChromeLayout {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1.6;
  // The phone's own shape decides nothing: a Mac on an upright phone, a
  // portrait Windows display on one on its side, all fill what's there.
  // On its side the picture also takes the home bar's strip, top to bottom
  // as a video does; the notch's sides stay clear.
  const side = width > height;
  const top = side ? 0 : insets.top,
    bottom = side ? 0 : insets.bottom;
  const stage = {
    x: insets.left,
    y: top,
    w: Math.max(0, width - insets.left - insets.right),
    h: Math.max(0, height - top - bottom),
  };
  return { placement: "overlay", stage, picture: fit(stage, ratio) };
}
export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The phone's safe areas (notch, home bar) in pixels, read once per change.
export function safeInsets(): Insets {
  if (typeof document === "undefined" || !document.body) return none;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const insets = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
  probe.remove();
  return insets;
}
