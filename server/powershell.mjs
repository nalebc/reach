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
// A command as cmd would start it ("C:\\…\\claude.exe", or "node.exe"
// "cli.js": app-shortcuts.mjs) as PowerShell runs it: a call (&) with each
// part in single quotes ($ and backticks stay as written; PowerShell takes
// curly quotes as quotes too, so they're doubled as well). Typed as it is,
// PowerShell only echoes one quoted path and refuses two. Anything else
// passes through.
export const powershellCall = (command) =>
  /^"/.test(command)
    ? `& ${command.replace(/"([^"]*)"/g, (_, part) => `'${part.replace(/['\u2018-\u201B]/g, "$&$&")}'`)}`
    : command;
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

// Windows PowerShell's own modules, never PowerShell 7's. Started from a
// PowerShell 7 window (Windows Terminal's default where it's installed),
// Reach and every child inherit 7's PSModulePath; Windows PowerShell then
// finds 7's copies of its modules first and can't load them ("…was found in
// the module 'Microsoft.PowerShell.Security', but the module could not be
// loaded"): Add-Type, Get-ExecutionPolicy… fail and the screen never loads
// (Oct 12, a real Windows runner). 7's own folders are dropped; the
// owner's other folders stay; Windows PowerShell's defaults are kept.
const SEVEN = /\\PowerShell\\(?:\d+(?:[.-][\w.-]+)?\\)?Modules\\?$/i;
export function windowsPowerShellModulePath(value = "", env = process.env) {
  const kept = String(value).split(";").map((dir) => dir.trim()).filter((dir) => dir && !SEVEN.test(dir));
  const at = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const defaults = [
    at("USERPROFILE") && `${at("USERPROFILE")}\\Documents\\WindowsPowerShell\\Modules`,
    `${at("PROGRAMFILES") || "C:\\Program Files"}\\WindowsPowerShell\\Modules`,
    `${at("SYSTEMROOT") || "C:\\Windows"}\\system32\\WindowsPowerShell\\v1.0\\Modules`,
  ].filter(Boolean);
  for (const dir of defaults) if (!kept.some((have) => have.toLowerCase() === dir.toLowerCase())) kept.push(dir);
  return kept.join(";");
}
// Once, for this process and so every PowerShell it starts (helpers, the
// owner's terminals, jobs, setup's checks).
export function cleanPowerShellEnv(env = process.env, platform = process.platform) {
  if (platform !== "win32") return;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PSMODULEPATH") || "PSModulePath";
  env[key] = windowsPowerShellModulePath(env[key], env);
}
cleanPowerShellEnv();
