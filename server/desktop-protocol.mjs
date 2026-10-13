import { fail } from "./core.mjs";
export const QUALITY = {
  // Highest quality: a high bitrate ceiling, lowered only on a struggling
  // connection. Phones send their own resolution as the width.
  auto: { width: 1600, fps: 60, bitrate: 16000000 },
  saver: { width: 1280, fps: 30, bitrate: 2000000 },
  balanced: { width: 1920, fps: 30, bitrate: 6000000 },
  smooth: { width: 1920, fps: 60, bitrate: 9000000 },
  // The live screen inside Home's laptop: sharp and smooth; the stream lowers
  // bitrate and frame rate by itself only when the connection struggles.
  preview: { width: 960, fps: 30, bitrate: 2000000 },
};
export const MODIFIERS = ["meta", "alt", "control", "shift", "fn", "caps"];
export const KEYS = [
  "enter",
  "backspace",
  "tab",
  "escape",
  "left",
  "right",
  "up",
  "down",
  "delete",
  "home",
  "end",
  "pageup",
  "pagedown",
  "space",
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];
export function streamOptions(value = {}) {
  const { display = "primary", quality = "balanced", format = "jpeg" } = value;
  if (
    typeof display !== "string" ||
    !/^(primary|[0-9]{1,10}|DISPLAY[0-9]{1,3})$/.test(display) ||
    !Object.hasOwn(QUALITY, quality) ||
    !["jpeg", "h264"].includes(format)
  )
    throw fail(400, "Invalid display or video settings.");
  return { display, quality, format, ...QUALITY[quality] };
}
export function inputAction(value) {
  if (!value || typeof value !== "object")
    throw fail(400, "Invalid desktop action.");
  const type = value.type;
  const focus = value.focus;
  if (
    focus !== undefined &&
    (typeof focus !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(focus))
  )
    throw fail(400, "Invalid typing target.");
  if (type === "focus") {
    if (value.x === undefined && value.y === undefined) return { type };
    if (
      ![value.x, value.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    )
      throw fail(400, "Invalid focus coordinates.");
    return { type, x: value.x, y: value.y };
  }
  // Is there a text field under the finger? (Asked on touch-down.)
  if (type === "probe") {
    if (
      ![value.x, value.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    )
      throw fail(400, "Invalid probe coordinates.");
    return { type, x: value.x, y: value.y };
  }
  if (type === "type-edit") {
    if (
      !focus ||
      !Number.isInteger(value.delete) ||
      value.delete < 0 ||
      value.delete > 256 ||
      typeof value.text !== "string" ||
      Buffer.byteLength(value.text) > 8000 ||
      value.text.includes("\0")
    )
      throw fail(400, "Invalid typing edit.");
    return { type, focus, delete: value.delete, text: value.text };
  }

  if (["move", "down", "up", "click"].includes(type)) {
    if (
      ![value.x, value.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    )
      throw fail(400, "Pointer coordinates must be between 0 and 1.");
    const button = value.button ?? "left",
      count = value.count ?? 1;
    if (!["left", "right"].includes(button) || ![1, 2].includes(count))
      throw fail(400, "Invalid mouse button or click count.");
    const clickId = value.clickId, clickState = value.clickState === undefined ? 1 : value.clickState;
    if ((clickId !== undefined || value.clickState !== undefined) &&
      (type !== "click" || button !== "left" || count !== 1 ||
        !Number.isInteger(clickId) || clickId < 1 || clickId > 2147483647 || ![1, 2].includes(clickState)))
      throw fail(400, "Invalid click sequence.");
    const touch = value.touch;
    if (touch !== undefined &&
      (type !== "click" || button !== "left" || !touch ||
        ![touch.x, touch.y].every((n) => Number.isFinite(n) && n > 0 && n <= 0.1)))
      throw fail(400, "Invalid touch tolerance.");
    return { type, x: value.x, y: value.y, button, count,
      ...(touch ? { touch: { x: touch.x, y: touch.y } } : {}),
      ...(clickId !== undefined ? { clickId, clickState } : {}) };
  }
  if (type === "scroll") {
    const dx = value.dx ?? 0,
      dy = value.dy ?? value.delta;
    if (![dx, dy].every((n) => Number.isFinite(n) && Math.abs(n) <= 120))
      throw fail(400, "Invalid scroll amount.");
    const phase = value.phase,
      momentum = value.momentum;
    if (
      (phase !== undefined &&
        !["began", "changed", "ended", "cancelled", "none"].includes(phase)) ||
      (momentum !== undefined &&
        !["began", "changed", "ended", "none"].includes(momentum))
    )
      throw fail(400, "Invalid scroll phase.");
    return {
      type,
      dx,
      dy,
      ...(phase ? { phase } : {}),
      ...(momentum ? { momentum } : {}),
    };
  }
  if (type === "key") {
    const modifiers = value.modifiers ?? [];
    if (
      !KEYS.includes(value.key) ||
      !Array.isArray(modifiers) ||
      modifiers.length > 6 ||
      modifiers.some((m) => !MODIFIERS.includes(m)) ||
      new Set(modifiers).size !== modifiers.length
    )
      throw fail(400, "Invalid key or modifier.");
    return { type, key: value.key, modifiers, ...(focus ? { focus } : {}) };
  }
  if (["text", "clipboard-write"].includes(type)) {
    if (
      typeof value.text !== "string" ||
      Buffer.byteLength(value.text) > (type === "text" ? 8000 : 16384) ||
      value.text.includes("\0")
    )
      throw fail(400, "Text is too large or contains unsupported characters.");
    return { type, text: value.text };
  }
  if (
    ["release", "heartbeat", "clipboard-read", "selection-read"].includes(type)
  )
    return { type };
  // Context shortcuts: which app is in front and its menu commands.
  if (type === "context") {
    const since = value.since;
    if (since !== undefined && (typeof since !== "string" || since.length > 64))
      throw fail(400, "Invalid context request.");
    return { type, ...(since ? { since } : {}) };
  }
  if (type === "menu") {
    const path = value.path;
    if (
      !Array.isArray(path) ||
      path.length < 2 ||
      path.length > 4 ||
      path.some(
        (title) =>
          typeof title !== "string" ||
          !title ||
          title.length > 200 ||
          /[\u0000-\u001f\u007f]/.test(title),
      )
    )
      throw fail(400, "Invalid menu command.");
    return { type, path };
  }
  throw fail(400, "Unsupported desktop action.");
}
