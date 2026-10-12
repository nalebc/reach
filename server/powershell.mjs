// Reach's PowerShell helpers on Windows (scripts/native/*.ps1). Windows'
// default policy refuses every script; .\reach.cmd starts Reach with this
// session's bypass, but npm's `reach`, `npm start` and a Startup entry don't
// pass it on. So each helper asks for its own. A policy an administrator set
// (Group Policy) or application control (Constrained Language Mode) still
// wins: scriptBlocked() says so instead of a raw PowerShell error.
export const powershellFile = (script, args = [], { sta = false } = {}) => [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  ...(sta ? ["-STA"] : []),
  "-File",
  script,
  ...args,
];
// What PowerShell prints when policy stops a script before it runs, or when
// application control refuses Add-Type (every helper compiles a little C#).
const BLOCKED =
  /running scripts is disabled|cannot be loaded because|is not digitally signed|PSSecurityException|UnauthorizedAccess|language mode/i;
export const SCRIPT_BLOCKED =
  "Windows' security policy on this PC blocks Reach's PowerShell helpers. Reach can't change a policy set by an administrator: ask them to allow PowerShell scripts for your account.";
export const scriptBlocked = (text) => BLOCKED.test(String(text || ""));
// Cold helpers compile that C# on every start, and antivirus scans it first:
// seconds on a fast PC, tens of seconds on a slow one. The first answer gets
// this long; later ones the usual few seconds.
export const COLD_START_MS = 60000;
