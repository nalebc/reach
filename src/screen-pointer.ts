export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// The primary-display frame is centered with object-fit: contain. Measure the
// rendered image, not the surrounding viewport or the JPEG's pixel count.
// Client coordinates and DOMRects share CSS pixels even on Retina displays.
export function screenPoint(
  clientX: number,
  clientY: number,
  box: ScreenRect,
  naturalWidth: number,
  naturalHeight: number,
) {
  if (
    ![
      clientX,
      clientY,
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
  if (
    clientX < left ||
    clientX > left + width ||
    clientY < top ||
    clientY > top + height
  )
    return null;
  return { x: (clientX - left) / width, y: (clientY - top) / height };
}
