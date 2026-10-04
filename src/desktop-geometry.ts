export type View = { scale: number; x: number; y: number };
export function boundView(
  scale: number,
  x: number,
  y: number,
  baseW: number,
  baseH: number,
  width: number,
  height: number,
): View {
  scale = Math.max(1, Math.min(4, scale));
  const maxX = Math.max(0, (baseW * scale - width) / 2),
    maxY = Math.max(0, (baseH * scale - height) / 2);
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
  );
}

// Center the tapped field above the phone keyboard, keeping desktop text legible.
// The anchor is normalized to the captured display, so Retina/resizing is safe.
export function typingView(
  initial: View,
  point: { x: number; y: number },
  baseW: number,
  baseH: number,
  width: number,
  height: number,
): View {
  const scale = Math.min(
    4,
    Math.max(initial.scale, Math.min(3, 900 / Math.max(1, baseW))),
  );
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
