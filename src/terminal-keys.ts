// Bytes a terminal expects for the keys a phone keyboard lacks.

// Full-screen programs (Codex, vim, less) switch the terminal to "application
// cursor" mode, where arrows are ESC O x instead of ESC [ x.
export function arrowKey(
  direction: "up" | "down" | "right" | "left",
  applicationMode: boolean,
) {
  const letter = { up: "A", down: "B", right: "C", left: "D" }[direction];
  return `${applicationMode ? "\x1bO" : "\x1b["}${letter}`;
}

// Ctrl plus a typed character, as a terminal sends it (Ctrl C = \x03), or
// null when the combination has no control code.
export function controlKey(typed: string) {
  if (typed.length !== 1) return null;
  if (typed === " ") return "\x00";
  const code = typed.toUpperCase().charCodeAt(0);
  // @ A–Z [ \ ] ^ _
  return code >= 64 && code <= 95 ? String.fromCharCode(code & 0x1f) : null;
}
