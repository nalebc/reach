import path from "node:path";

// How an app, and a file an agent opens, is named on each computer, checked
// strictly before a policy keeps it or the desktop helper opens it
// (agent-presets.mjs, agent-desktop.mjs, agent-guard.mjs).
//
// A Mac app is its bundle's POSIX path (/Applications/Notes.app), on any
// host: these rules never change with the platform. On Windows only: an
// installed program by the absolute path of its .exe, or a Store app by its
// Start-menu id (an AUMID: Microsoft.WindowsCalculator_8wekyb3d8bbwe!App).
// Anything else is refused, never guessed at.

const macControls = (value) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
export const macAppPath = (value) =>
  typeof value === "string" && value.length <= 4096 && path.posix.isAbsolute(value) && value.endsWith(".app") &&
  !macControls(value) && !value.includes("\\") && path.posix.normalize(value) === value;

// Windows names hold no control characters at all (tab and newline included),
// nothing that hides or reorders text (every format character: direction
// marks, zero-width joiners and spaces, soft hyphens, the BOM), no line or
// paragraph separators and no half of a surrogate pair.
export const windowsHidden = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
// Device names: NUL, CON, COM1… open a device whatever folder or extension
// they're given, and whatever spaces end the name before its extension
// ("NUL .exe" is NUL).
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;
// Trailing dots and spaces cut by walking back from the end: /[. ]+$/ retries
// from every space of a long run, and a 64k-space name an agent sent held the
// server for seconds (CodeQL #243).
const trimDotsSpaces = (text) => {
  let end = text.length;
  while (end && (text[end - 1] === "." || text[end - 1] === " ")) end--;
  return text.slice(0, end);
};
const deviceName = (name) => RESERVED.test(trimDotsSpaces(name.split(".")[0]));
// One spelling per name, as Windows compares them: it upper-cases each
// letter (ſ is S, ı is I, ς and σ are Σ), where lower-casing alone keeps
// them apart. Lower-cased after, to meet lists written in lower case.
export const windowsFold = (value) => String(value).toUpperCase().toLowerCase();
/**
 * A Windows path as the one file it names, for comparing with protected
 * folders: a device or long-path prefix (\\?\, \\.\, \??\) and an admin share
 * (\\localhost\c$) read as the drive; each name without the dots and spaces
 * Windows trims, or a stream (:$DATA); letters folded (windowsFold).
 */
export function windowsCanonicalPath(value) {
  let text = String(value).replace(/\//g, "\\");
  text = text.replace(/^\\\\[?.]\\(unc\\)?|^\\\?\?\\(unc\\)?/i, (_, a, b) => (a || b ? "\\\\" : ""));
  text = text.replace(/^\\\\[^\\]+\\([a-z])\$(?=\\|$)/i, "$1:");
  // Each name as Windows reads it, before ".." is followed: no stream, no
  // trailing dots or spaces (".. " is "..").
  const drive = /^[a-z]:/i.test(text) ? text.slice(0, 2) : "";
  const names = text.slice(drive.length).split("\\").map((name) => {
    const plain = name.replace(/:.*$/s, "");
    return /^\.+ *$/.test(plain) ? plain.trimEnd() : trimDotsSpaces(plain);
  });
  const joined = drive + names.join("\\");
  // Root-relative (\Windows) stays on no drive in particular (windowsWithin),
  // never this host's working folder.
  return windowsFold(/^\\(?!\\)/.test(joined) ? path.win32.normalize(joined) : path.win32.resolve(joined));
}
/** A canonical Windows path is a protected folder or inside it; a root-relative one (\Users\me) on any drive. */
export function windowsWithin(target, root) {
  const inside = (value, folder) => value === folder || value.startsWith(folder.endsWith("\\") ? folder : folder + "\\");
  return inside(target, root) || (/^\\(?!\\)/.test(target) && /^[a-z]:\\/.test(root) && inside(target, root.slice(2)));
}
/** A short (8.3) alias in a Windows path: PROGRA~1, another name for a folder that would dodge a check by name. */
export const windowsShortName = (value) => String(value).split(/[\\/]/).some((name) => /~\d/.test(name));

/** An absolute Windows path, exactly as Windows keeps it: one name for one file. */
export function windowsPath(value) {
  if (typeof value !== "string" || value.length > 4096 || windowsHidden.test(value)) return false;
  // A drive letter, then the path: never a share (\\server\share), a device
  // or long-path prefix (\\?\, \\.\), a drive-relative path (C:notes) or the
  // drive itself.
  if (!/^[A-Za-z]:\\[^\\]/.test(value)) return false;
  // Backslashes only; no wildcards, quotes, pipes or redirections; no colon
  // after the drive's (an alternate data stream of a file).
  if (/[/<>:"|?*]/.test(value.slice(2))) return false;
  if (path.win32.normalize(value) !== value) return false;
  // Every name as Windows keeps it: none empty, "." or ".."; none starting
  // with a space or ending in a dot or space (Windows trims those: another
  // name for the same file); no device name; no 8.3 short alias (PROGRA~1,
  // another name that would dodge a check by name).
  return value.slice(3).split("\\").every((name) =>
    name && name !== "." && name !== ".." && !/^\s|[. ]$/.test(name) && !deviceName(name) && !/~\d/.test(name));
}
export const windowsExePath = (value) => windowsPath(value) && /\.exe$/i.test(value);

// A Store app's Start-menu id: its package family name (the package's name,
// 3 to 50 letters, digits, dots or dashes; "_"; the publisher's 13-character
// id in Windows' base32), "!", then the app's id within the package (1 to 64
// characters, dot-separated parts that each start with a letter). Desktop
// programs' own ids (Chrome, {GUID}\…) aren't accepted: their .exe path is.
export const windowsAppId = (value) =>
  typeof value === "string" && value.length <= 130 &&
  /^[A-Za-z0-9.-]{3,50}_[0-9a-hjkmnp-tv-z]{13}![A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(value) &&
  value.slice(value.indexOf("!") + 1).length <= 64;
/** The package name of a Store app's id (Microsoft.WindowsCalculator), or "". */
export const windowsPackageName = (value) => (windowsAppId(value) ? value.slice(0, value.indexOf("_")) : "");

/** An app an agent may be given, on this platform: a Mac bundle path anywhere; on Windows also an .exe path or a Store app id. */
export const validAppPath = (value, { platform = process.platform } = {}) =>
  macAppPath(value) || (platform === "win32" && (windowsExePath(value) || windowsAppId(value)));

/** The app's own name from its id, for when the catalog gave none: "Notes", "chrome", "Microsoft.WindowsCalculator". */
export function appLabel(id, { platform = process.platform } = {}) {
  if (platform !== "win32") return path.basename(id, ".app");
  if (windowsAppId(id)) return windowsPackageName(id);
  return String(id).split(/[\\/]/).at(-1).replace(/\.(exe|app)$/i, "");
}
