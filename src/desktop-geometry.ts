export type View = { scale: number; x: number; y: number };
export function boundView(
  scale: number,
  x: number,
  y: number,
  baseW: number,
  baseH: number,
  width: number,
  height: number,
  edgeTravel = 0,
): View {
  scale = Math.max(1, Math.min(4, scale));
  // Let screen-edge controls move clear of a finger, the safe area and Fit.
  // At Fit the entire display stays centered; zooming adds a little travel.
  const edge = scale > 1 ? edgeTravel : 0;
  const maxX = Math.max(0, (baseW * scale - width) / 2) + edge,
    maxY = Math.max(0, (baseH * scale - height) / 2) + edge;
  return {
    scale,
    x: Math.max(-maxX, Math.min(maxX, x)),
    y: Math.max(-maxY, Math.min(maxY, y)),
  };
}
export function pinchView(
  initial: View,
  start: { x: number; y: number },
  current: { x: number; y: number },
  ratio: number,
  baseW: number,
  baseH: number,
  width: number,
  height: number,
): View {
  const scale = Math.max(1, Math.min(4, initial.scale * ratio));
  const x =
    (start.x - (width - baseW * initial.scale) / 2 - initial.x) /
    (baseW * initial.scale);
  const y =
    (start.y - (height - baseH * initial.scale) / 2 - initial.y) /
    (baseH * initial.scale);
  return boundView(
    scale,
    current.x - x * baseW * scale - (width - baseW * scale) / 2,
    current.y - y * baseH * scale - (height - baseH * scale) / 2,
    baseW,
    baseH,
    width,
    height,
    48,
  );
}

// Keep the tapped field above the keyboard at the user's chosen zoom.
// The anchor is normalized to the captured display, so Retina/resizing is safe.
// A phone on its side leaves a short, wide strip above the keyboard: the
// screen fitted into it was a thumbnail, so it spans the strip's width
// (rows around the field, the whole width) until the keyboard closes.
export function typingView(
  initial: View,
  point: { x: number; y: number },
  baseW: number,
  baseH: number,
  width: number,
  height: number,
): View {
  const scale = Math.max(initial.scale, Math.min(4, width / Math.max(1, baseW)));
  return boundView(
    scale,
    (0.5 - point.x) * baseW * scale,
    (0.5 - point.y) * baseH * scale,
    baseW,
    baseH,
    width,
    height,
  );
}

// A view that frames one area of the screen (fractions of it): zoomed so the
// area fills most of the stage (up to 4×), centered on it, kept in bounds.
export function focusView(
  area: { x: number; y: number; width: number; height: number },
  baseW: number,
  baseH: number,
  width: number,
  height: number,
): View {
  const fill = 0.9 * Math.min(width / Math.max(1, area.width * baseW), height / Math.max(1, area.height * baseH));
  const scale = Math.max(1, Math.min(4, fill));
  const cx = area.x + area.width / 2,
    cy = area.y + area.height / 2;
  return boundView(scale, baseW * scale * (0.5 - cx), baseH * scale * (0.5 - cy), baseW, baseH, width, height);
}
