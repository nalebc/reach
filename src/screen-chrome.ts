// Landscape uses the whole usable viewport: controls float and fade over
// the picture instead of reserving a sidebar. Portrait keeps its controls
// above and below the image. Showing controls never changes the image's
// size or origin, so taps and held drags keep their target.
export type Rect = { x: number; y: number; w: number; h: number };
export type Insets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
export type ChromeLayout = {
  placement: "overlay" | "ends";
  stage: Rect;
  picture: Rect;
  // Space reserved for controls. Floating landscape controls reserve none.
  chrome: Rect[];
};
// Upright: the status row on top and the bar's row below, safe areas apart.
export const TOP_ROW = 44;
export const BOTTOM_ROW = 96;
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
  const areaW = Math.max(0, width - insets.left - insets.right),
    areaH = Math.max(0, height - insets.top - insets.bottom);
  // This follows the viewport, independent of the remote display's shape.
  // A portrait Windows display on a landscape phone still gets fullscreen.
  if (width > height) {
    const stage = { x: insets.left, y: insets.top, w: areaW, h: areaH };
    return {
      placement: "overlay",
      stage,
      picture: fit(stage, ratio),
      chrome: [],
    };
  }
  const top = insets.top + TOP_ROW,
    bottom = BOTTOM_ROW + insets.bottom;
  const stage = {
    x: insets.left,
    y: top,
    w: areaW,
    h: Math.max(0, height - top - bottom),
  };
  return {
    placement: "ends",
    stage,
    picture: fit(stage, ratio),
    chrome: [
      { x: 0, y: 0, w: width, h: top },
      { x: 0, y: height - bottom, w: width, h: bottom },
    ],
  };
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
