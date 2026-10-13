export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// The primary-display frame is centered with object-fit: contain. Measure the
// rendered image, not the surrounding viewport or the JPEG's pixel count.
// Client coordinates and DOMRects share CSS pixels even on Retina displays.
export function screenImageRect(
  box: ScreenRect,
  naturalWidth: number,
  naturalHeight: number,
) {
  if (
    ![
      box.left,
      box.top,
      box.width,
      box.height,
      naturalWidth,
      naturalHeight,
    ].every(Number.isFinite) ||
    box.width <= 0 ||
    box.height <= 0 ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  )
    return null;
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  const width = naturalWidth * scale,
    height = naturalHeight * scale;
  const left = box.left + (box.width - width) / 2,
    top = box.top + (box.height - height) / 2;
  return { left, top, width, height };
}

// Finger tolerance and coordinate mapping share the measured image, including
// Retina, letterboxing, browser scaling, and the user's current zoom.
export function screenTouchTolerance(
  box: ScreenRect,
  naturalWidth: number,
  naturalHeight: number,
) {
  const image = screenImageRect(box, naturalWidth, naturalHeight);
  return image ? { x: Math.min(0.1, 10 / image.width), y: Math.min(0.1, 10 / image.height) } : undefined;
}

export function screenPoint(
  clientX: number,
  clientY: number,
  box: ScreenRect,
  naturalWidth: number,
  naturalHeight: number,
  clampOutside = false,
) {
  if (![clientX, clientY].every(Number.isFinite)) return null;
  const image = screenImageRect(box, naturalWidth, naturalHeight);
  if (!image) return null;
  const { left, top, width, height } = image;
  if (!clampOutside && (
    clientX < left ||
    clientX > left + width ||
    clientY < top ||
    clientY > top + height
  ))
    return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - left) / width)),
    y: Math.max(0, Math.min(1, (clientY - top) / height)),
  };
}
