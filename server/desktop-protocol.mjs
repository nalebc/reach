import { fail } from "./core.mjs";
export const QUALITY = {
  desktop: { width: 2752, fps: 60, bitrate: 16000000 },
  auto: { width: 1600, fps: 60, bitrate: 4000000 },
  saver: { width: 1280, fps: 30, bitrate: 2000000 },
  balanced: { width: 1920, fps: 30, bitrate: 6000000 },
  smooth: { width: 1920, fps: 60, bitrate: 9000000 },
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
  const options = { display, quality, format, ...QUALITY[quality] };
  if (quality === "desktop" && value.width !== undefined) {
    if (
      !Number.isInteger(value.width) ||
      value.width < 640 ||
      value.width > 3840
    )
      throw fail(400, "Invalid desktop width.");
    options.width = value.width - (value.width % 2);
  }
  return options;
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

  if (["keyDown", "keyUp"].includes(type)) {
    const modifiers = value.modifiers ?? [];
    if (
      !HID_KEYS.includes(value.usage) ||
      !Array.isArray(modifiers) ||
      modifiers.length > 6 ||
      modifiers.some((m) => !MODIFIERS.includes(m)) ||
      new Set(modifiers).size !== modifiers.length ||
      (value.repeat !== undefined && typeof value.repeat !== "boolean")
    )
      throw fail(400, "Invalid physical keyboard event.");
    return {
      type,
      usage: value.usage,
      modifiers,
      repeat: type === "keyDown" && value.repeat === true,
    };
  }
  if (["mouseMove", "mouseDown", "mouseUp"].includes(type)) {
    const button = value.button ?? "left";
    if (!["left", "right", "middle"].includes(button))
      throw fail(400, "Invalid mouse button.");
    if (value.relative === true) {
      if (
        ![value.dx, value.dy].every(
          (n) => Number.isFinite(n) && Math.abs(n) <= 2048,
        )
      )
        throw fail(400, "Invalid relative pointer movement.");
      return { type, relative: true, dx: value.dx, dy: value.dy, button };
    }
    if (
      ![value.x, value.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    )
      throw fail(400, "Invalid pointer coordinates.");
    return { type, x: value.x, y: value.y, button };
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
    return { type, x: value.x, y: value.y, button, count };
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

// USB keyboard page 0x07: supported physical keys only; no consumer/system usages.
export const HID_KEYS = [
  ...Array.from({ length: 108 }, (_, i) => i + 4),
  ...Array.from({ length: 8 }, (_, i) => 224 + i),
].filter((n) => ![70, 72, 102].includes(n));
