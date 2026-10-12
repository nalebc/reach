import fs from "node:fs";
import { fail } from "./core.mjs";

// A file Reach checked by its path (real path, inside a shared folder) and
// then uses. Between the two, a program running as you could put a link or
// another file in its place (CodeQL js/file-system-race). So the file is
// opened once, never through a final link (O_NOFOLLOW) and never waiting on
// a pipe (O_NONBLOCK), and the check runs again on where the path leads now:
// the same folder rules, and the very file that was opened (device and
// inode). Anything else is refused before a byte is read or written.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const NONBLOCK = fs.constants.O_NONBLOCK || 0;
export async function openConfined(file, flags, confine, { mode = 0o644, open = fs.promises.open, stat = fs.promises.stat } = {}) {
  const handle = await open(file, flags | NOFOLLOW | NONBLOCK, mode).catch((error) => {
    // A link in the file's place: O_NOFOLLOW's answer.
    if (error?.code === "ELOOP" || error?.code === "EMLINK") throw fail(403, "Links are not opened through Reach.");
    if (error?.code === "EISDIR") throw fail(400, "Choose a file.");
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw fail(400, "Choose a file.");
    const changed = () => fail(409, "This file changed while Reach opened it. Try again.");
    if (confine() !== file) throw changed();
    const there = await stat(file, { bigint: true }).catch(() => null);
    if (there?.dev !== opened.dev || there?.ino !== opened.ino) throw changed();
    return { handle, size: Number(opened.size), mode: Number(opened.mode) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
// Its first `limit` bytes, or null when it holds more (it may have grown
// since it was measured).
export async function readUpTo(handle, limit) {
  const buffer = Buffer.alloc(limit + 1);
  let at = 0;
  while (at < buffer.length) {
    const { bytesRead } = await handle.read(buffer, at, buffer.length - at, at);
    if (!bytesRead) break;
    at += bytesRead;
  }
  return at > limit ? null : buffer.subarray(0, at);
}
