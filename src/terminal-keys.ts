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

// Text pasted from the phone, as a terminal should take it: no control
// characters but tab and line breaks. An ESC in a clipboard could end a
// bracketed paste early and run what follows it; the others act as keys
// (ctrl-C, ctrl-D…).
export const pastable = (text: string) =>
  text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");

// What to ask before a paste whose line breaks run commands as it arrives
// (each line break is a Return), or null when it runs nothing.
export function pasteQuestion(text: string) {
  const runs = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  if (!runs) return null;
  return runs === 1
    ? "Pasting this runs a command. Paste it?"
    : `Pasting this runs ${runs} commands, one per line. Paste it?`;
}

// A terminal's input message holds at most 32,768 characters in a 64 KB
// frame (server/index.mjs), and the server drops a longer one. Longer input
// (a big paste) goes in pieces, in order, never splitting a character: 8,192
// fits even if every character escapes to six bytes of JSON.
export function inputPieces(data: string, size = 8192) {
  const pieces: string[] = [];
  for (let at = 0; at < data.length; ) {
    let end = Math.min(at + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(data.slice(at, end));
    at = end;
  }
  return pieces;
}
