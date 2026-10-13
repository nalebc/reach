// Where Reach's own controls go in a fullscreen Screen (Oct 12: "i could not
// see my doc and top bar from mac even in control"). The bars used to float
// over the picture, exactly where the Mac's menu bar and Dock are. Now they
// take the room the picture leaves: a phone on its side is wider than a
// 16:10 Mac, so the controls go in a rail at the side; held upright (or a
// tablet), there's room above and below. The picture never sits under them,
// and showing or hiding them never moves it (the space stays theirs), so a
// tap lands where it was aimed. Zoomed in, the picture fills its own area,
// still clear of the controls. src/screen-chrome.css follows these sizes.
export type Rect = { x: number; y: number; w: number; h: number };
export type Insets = { top: number; right: number; bottom: number; left: number };
export type ChromeLayout = {
  placement: "side" | "ends";
  // The side rail's width (side) in CSS pixels, safe area not included.
  rail: number;
  // The picture's own area (zoomed in, it fills this), where the picture
  // is at fit, and where Reach's controls are.
  stage: Rect;
  picture: Rect;
  chrome: Rect[];
};
export const RAIL_MIN = 60;
export const RAIL_MAX = 168;
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
  // Wider than the picture: the room is at the sides.
  if (areaH > 0 && areaW / areaH > ratio) {
    const rail = Math.round(
      Math.min(RAIL_MAX, Math.max(RAIL_MIN, areaW - areaH * ratio)),
    );
    const stage = { x: insets.left, y: insets.top, w: Math.max(0, areaW - rail), h: areaH };
    return {
      placement: "side",
      rail,
      stage,
      picture: fit(stage, ratio),
      chrome: [{ x: insets.left + stage.w, y: 0, w: rail + insets.right, h: height }],
    };
  }
  const top = insets.top + TOP_ROW,
    bottom = BOTTOM_ROW + insets.bottom;
  const stage = { x: insets.left, y: top, w: areaW, h: Math.max(0, height - top - bottom) };
  return {
    placement: "ends",
    rail: 0,
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
