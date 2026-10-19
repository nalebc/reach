// Disposable hosted-runner preparation, not a Reach runtime or installer path.
// Suppressing the first-logon prompt does not accept optional sharing choices.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function assertDisposableWindows({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || env.GITHUB_ACTIONS !== "true" || env.CI !== "true" ||
      env.RUNNER_ENVIRONMENT !== "github-hosted" || env.GITHUB_REPOSITORY !== "nalebc/reach" ||
      env.REACH_CI_DESKTOP_PREFLIGHT !== "1") throw Error("Desktop preparation requires the explicit disposable public GitHub-hosted Windows gate.");
  if (!/^[A-Za-z]:\\Windows$/i.test(env.SystemRoot || "")) throw Error("Desktop preparation requires Windows' fixed system directory.");
}

export function desktopRequiredForSelection(value = "") {
  const names = String(value).split(/\s+/).filter(Boolean);
  // Only these known independent files may omit desktop preparation. New or
  // unknown selections retain the requirement until their boundary is reviewed.
  const independent = new Set(["windows-tailscaled-peer", "windows-codex-socket-native", "windows-owner-rights",
    "windows-state-normalization", "windows-native-build", "windows-claude-hooks", "windows-existing-state"]);
  return !names.length || names.some((name) => !independent.has(name));
}

export function lastDesktopCheckpoint(stderr) {
  const names = new Set(["powershell-start", "compiled", "native-run", "known-setup", "probe-show", "probe-shown",
    "probe-activate", "probe-activated", "probe-loop", "probe-click", "probe-type", "probe-pixel"]);
  let last = null;
  for (const line of String(stderr ?? "").slice(-128 * 1024).split(/\r?\n/)) {
    const prefix = "REACH_CI_DESKTOP_STAGE:";
    if (line.startsWith(prefix) && names.has(line.slice(prefix.length))) last = line.slice(prefix.length);
  }
  return last;
}

export function prepareWindowsDesktop({ ifNeeded = false } = {}) {
  assertDisposableWindows(); // Before filesystem writes, compilation or any OS mutation.
  const reportPath = fileURLToPath(new URL("../../reports/windows-desktop-preflight.json", import.meta.url));
  const retain = (report) => {
    report.head = process.env.GITHUB_SHA;
    report.architecture = process.arch;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    return report;
  };
  if (ifNeeded && process.env.REACH_CI_DESKTOP_REQUIRED !== "1" && !desktopRequiredForSelection(process.env.TESTS))
    return retain({ schema: 1, required: false, ready: null, stage: "not-required" });
  const source = fs.readFileSync(new URL("./windows-desktop-preflight.cs", import.meta.url), "utf8");
  if (source.length > 24000) throw Error("Desktop preparation source exceeds its bounded environment protocol.");
  const executable = path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Fixed command. Checked-in C# is passed as data, never interpolated with
  // runner paths, titles or process command lines. No execution-policy change.
  const command = "$ErrorActionPreference='Stop'; try { [Console]::Error.WriteLine('REACH_CI_DESKTOP_STAGE:powershell-start') } catch {}; Add-Type -TypeDefinition $env:REACH_CI_DESKTOP_SOURCE -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions; try { [Console]::Error.WriteLine('REACH_CI_DESKTOP_STAGE:compiled') } catch {}; [ReachCiDesktop]::Run()";
  let report;
  try {
    const output = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-STA", "-Command", command], {
      env: { ...process.env, REACH_CI_DESKTOP_SOURCE: source }, encoding: "utf8", windowsHide: true,
      stdio: "pipe", timeout: 60000, maxBuffer: 128 * 1024,
    });
    report = JSON.parse(output.trim());
    if (report.schema !== 1 || typeof report.ready !== "boolean") throw Error("Desktop preparation returned an invalid report.");
  } catch (error) {
    report = { schema: 1, ready: false, stage: "bootstrap", reason: error?.code === "ETIMEDOUT" ? "deadline" : "helper-failed",
      checkpoint: lastDesktopCheckpoint(error?.stderr),
      compilerCodes: [...new Set(String(error?.stderr || "").match(/\bCS\d{4}\b/g) || [])].slice(0, 8) };
  }
  retain({ ...report, required: true });
  if (!report.ready) throw Error(`Windows desktop preflight refused: ${report.stage}/${report.reason}.`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareWindowsDesktop({ ifNeeded: process.argv.includes("--if-needed") });
