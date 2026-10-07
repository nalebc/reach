// The last lines a shell printed, as plain text, for Home's live cards. Mirrors
// terminalPreview() in server/terminal.mjs. Full-screen programs (Codex, vim)
// redraw with cursor moves, so they get no preview (null).
export function terminalPreview(buffer: string, lines = 2): string[] | null {
  const tail = buffer.slice(-8000);
  const left = tail.lastIndexOf("\x1b[?1049l");
  if (tail.lastIndexOf("\x1b[?1049h") > left) return null;
  // Only what the shell printed after a full-screen program closed.
  return (left >= 0 ? tail.slice(left + 8) : tail)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .split("\n")
    .map((line) =>
      // A carriage return redraws the line; keep what is left visible.
      (line.split("\r").filter((part) => part.trim()).pop() || "")
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trimEnd(),
    )
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .slice(-lines)
    .map((line) => line.slice(0, 120));
}
