import { execFile } from "node:child_process";
import path from "node:path";
import { cleanPowerShellEnv } from "../../server/powershell.mjs";

// Windows PowerShell running a command an agent on a Windows PC was given,
// as it would type it: under the PC's own script policy (a new PC's is
// Restricted, as the CI runner's is made), with Windows PowerShell's own
// modules, and `home` as the profile ($HOME). The command is the text as
// given (-EncodedCommand: nothing re-quoted on the way).
export function agentPowerShell(command, home, { input, timeout = 60000 } = {}) {
  const env = { ...process.env, USERPROFILE: home, HOMEDRIVE: path.win32.parse(home).root.replace(/\\$/, ""), HOMEPATH: home.slice(path.win32.parse(home).root.length - 1) };
  cleanPowerShellEnv(env, "win32");
  return new Promise((resolve) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { env, windowsHide: true, timeout, maxBuffer: 8 << 20 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}
// What PowerShell says when a command or its module can't be used here.
export const UNUSABLE = /is not recognized|could not be loaded|cannot be loaded|running scripts is disabled|CommandNotFoundException/i;
