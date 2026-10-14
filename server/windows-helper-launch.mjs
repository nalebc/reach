import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { windowsPath } from "./app-identity.mjs";

// Why Windows won't run the agent helper Reach built on this PC
// (docs/parity/B-desktop-helper.md §3.4): Smart App Control read before a
// build, Windows' own logs read after a helper that never answered. Only
// programs in the Windows folder are run, by their full path, never through a
// shell or PowerShell. Nothing is guessed: a log that can't be read, or holds
// nothing about the helper, gives the plain "stopped before it was ready".
const exec = promisify(execFile);

/** The Windows folder, from the environment when it's one absolute drive path; C:\Windows otherwise. Never from PATH. */
export function systemRoot(env = process.env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  return windowsPath(root) ? root : "C:\\Windows";
}
const system32 = (env, name) => path.win32.join(systemRoot(env), "System32", name);

export const SMART_APP_CONTROL_REFUSAL = "Smart App Control on this PC only runs signed programs. This version of Reach can't give agents the screen here yet.";
export const POLICY_REFUSAL = "Windows' application control on this PC (an administrator's policy, Smart App Control or antivirus) blocked Reach's agent helper. Reach can't change that policy.";
export const QUARANTINE_REFUSAL = "Windows security removed Reach's agent helper after it was built. Reach can't change that.";

/** Smart App Control: 1 on, 2 evaluation, 0 off; null when Windows wouldn't say. */
export async function smartAppControlState({ run = exec, env = process.env } = {}) {
  try {
    const { stdout } = await run(system32(env, "reg.exe"), ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy", "/v", "VerifiedAndReputablePolicyState"],
      { timeout: 5000, windowsHide: true, maxBuffer: 65536 });
    const value = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]{1,8})\b/i.exec(String(stdout));
    return value ? parseInt(value[1], 16) : null;
  } catch {
    return null;
  }
}

// The logs where Windows says it stopped a program: code integrity (Smart App
// Control, App Control for Business), AppLocker, and Defender's detections.
const POLICY_LOGS = [
  ["Microsoft-Windows-CodeIntegrity/Operational", [3077, 3033, 3034]],
  ["Microsoft-Windows-AppLocker/EXE and DLL", [8004]],
  ["Microsoft-Windows-Windows Defender/Operational", [1116, 1117]],
];
/** Whether one of those logs, in the last 30 seconds, names this file: Windows blocked or removed it. */
export async function blockedByPolicy(file, { run = exec, env = process.env, now = Date.now } = {}) {
  const name = path.win32.basename(String(file)).toLowerCase();
  if (!name) return false;
  for (const [log, ids] of POLICY_LOGS) {
    let xml = "";
    try {
      ({ stdout: xml } = await run(system32(env, "wevtutil.exe"), ["qe", log, "/rd:true", "/c:20", "/f:xml"], { timeout: 5000, windowsHide: true, maxBuffer: 4 << 20 }));
    } catch {
      continue; // a standard user may not read it
    }
    for (const event of String(xml).split("</Event>")) {
      const id = Number(/<EventID[^>]*>(\d{1,6})<\/EventID>/.exec(event)?.[1]);
      const at = Date.parse(/<TimeCreated SystemTime=['"]([^'"]{1,40})['"]/.exec(event)?.[1] || "");
      if (ids.includes(id) && Number.isFinite(at) && Math.abs(now() - at) <= 30000 && event.toLowerCase().includes(name)) return true;
    }
  }
  return false;
}

// What the helper's own process may see of Reach's environment: Windows' and
// the user's folders, nothing of Reach's or Node's. Never COR_*, COMPlus_*,
// DOTNET_* or CORECLR_*: those load a profiler into the helper's runtime.
export const WINDOWS_HELPER_ENV = ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH",
  "USERNAME", "USERDOMAIN", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
  "CommonProgramFiles(x86)", "CommonProgramW6432", "ProgramData", "ALLUSERSPROFILE", "PUBLIC", "ComSpec"];
/** The agent helper's environment: the allowlist above, and PATH as the Windows folder alone. */
export function windowsHelperEnv(env = process.env) {
  // Windows' own environment ignores case; a plain object doesn't.
  const keys = Object.keys(env);
  const read = (name) => env[name] ?? env[keys.find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""];
  const out = {};
  for (const name of WINDOWS_HELPER_ENV) {
    const value = read(name);
    if (typeof value === "string" && value && !/[\u0000]/.test(value)) out[name] = value;
  }
  const root = systemRoot(env);
  out.SystemRoot = root;
  out.PATH = `${root}\\System32;${root}`;
  return out;
}
