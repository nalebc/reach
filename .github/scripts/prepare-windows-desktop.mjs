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

const desktopStages = new Set(["powershell-start", "compile-start", "compiled", "native-run", "known-setup", "probe-show", "probe-shown",
  "probe-activate", "probe-activated", "probe-loop", "probe-click", "probe-type", "probe-pixel", "probe-pixel-geometry",
  "probe-pixel-ready", "probe-pixel-copied", "probe-pixel-read", "probe-pixel-disposed", "probe-finally", "probe-close",
  "probe-closed", "probe-restored", "verify-privacy", "verify-snapshot", "verify-complete", "catch-snapshot",
  "catch-snapshot-done", "serialize-start", "serialize-complete", "powershell-return"]);

export function lastDesktopCheckpoint(stderr) {
  let last = null;
  for (const line of String(stderr ?? "").slice(-128 * 1024).split(/\r?\n/)) {
    const prefix = "REACH_CI_DESKTOP_STAGE:";
    if (line.startsWith(prefix) && desktopStages.has(line.slice(prefix.length))) last = line.slice(prefix.length);
  }
  return last;
}

export function desktopTimingEvidence(stderr) {
  const samples = [];
  let rejected = 0, truncated = false;
  for (const line of String(stderr ?? "").slice(-128 * 1024).split(/\r?\n/)) {
    if (!line.startsWith("REACH_CI_DESKTOP_TIME:")) continue;
    const match = /^REACH_CI_DESKTOP_TIME:([a-z-]+):(0|[1-9][0-9]{0,5}):([1-9][0-9]{0,9})$/.exec(line);
    const elapsedMs = match ? Number(match[2]) : -1, pid = match ? Number(match[3]) : 0;
    const previous = samples.at(-1);
    if (!match || !desktopStages.has(match[1]) || elapsedMs > 120000 || pid <= 1 || pid > 2147483647 ||
        (previous && (previous.pid !== pid || previous.elapsedMs > elapsedMs))) {
      rejected = Math.min(48, rejected + 1);
      continue;
    }
    if (samples.length === 48) { truncated = true; continue; }
    samples.push({ stage: match[1], elapsedMs, pid });
  }
  return { samples, rejected, truncated };
}

export function desktopFailureEvidence(error = {}) {
  const codes = new Set(["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES", "EPERM", "UNKNOWN"]);
  const signals = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT", "SIGBREAK"]);
  const stdout = Buffer.isBuffer(error.stdout) ? error.stdout : typeof error.stdout === "string" ? Buffer.from(error.stdout) : Buffer.alloc(0);
  let nativeReportComplete = false, nativeReady = null;
  if (stdout.length <= 128 * 1024) {
    try {
      const value = JSON.parse(stdout.toString("utf8").trim());
      nativeReportComplete = value?.schema === 1 && typeof value.ready === "boolean";
      if (nativeReportComplete) nativeReady = value.ready;
    } catch {}
  }
  return {
    code: error.code == null ? null : codes.has(error.code) ? error.code : "other",
    status: Number.isInteger(error.status) && error.status >= -2147483648 && error.status <= 4294967295 ? error.status : null,
    signal: signals.has(error.signal) ? error.signal : null,
    stdoutBytes: Math.min(128 * 1024 + 1, stdout.length), nativeReportComplete, nativeReady,
  };
}

export function desktopSourcePayload(source) {
  // Compile the same canonical text when Windows checks out the source as CRLF.
  // Bound the actual environment payload after normalizing its line endings.
  const payload = source.replace(/\r\n/g, "\n");
  if (payload.length > 24000) throw Error("Desktop preparation source exceeds its bounded environment protocol.");
  return payload;
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
  const source = desktopSourcePayload(fs.readFileSync(new URL("./windows-desktop-preflight.cs", import.meta.url), "utf8"));
  const executable = path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Fixed command. Checked-in C# is passed as data, never interpolated with
  // runner paths, titles or process command lines. No execution-policy change.
  const command = "$ErrorActionPreference='Stop'; $reachCiClock=[Diagnostics.Stopwatch]::StartNew(); $reachCiMark={param($stage) try { [Console]::Error.WriteLine('REACH_CI_DESKTOP_STAGE:'+$stage); [Console]::Error.WriteLine('REACH_CI_DESKTOP_TIME:'+$stage+':'+$reachCiClock.ElapsedMilliseconds+':'+$PID) } catch {}}; & $reachCiMark 'powershell-start'; $reachCiCompileStart=$reachCiClock.ElapsedMilliseconds; & $reachCiMark 'compile-start'; Add-Type -TypeDefinition $env:REACH_CI_DESKTOP_SOURCE -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions; & $reachCiMark 'compiled'; [ReachCiDesktop]::DiagnosticClock=$reachCiClock; [ReachCiDesktop]::CompileElapsedMs=$reachCiClock.ElapsedMilliseconds-$reachCiCompileStart; $reachCiReport=[ReachCiDesktop]::Run(); & $reachCiMark 'powershell-return'; $reachCiReport";
  let report, output = "";
  const started = performance.now();
  try {
    output = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-STA", "-Command", command], {
      env: { ...process.env, REACH_CI_DESKTOP_SOURCE: source }, encoding: "utf8", windowsHide: true,
      stdio: "pipe", timeout: 60000, maxBuffer: 128 * 1024,
    });
    report = JSON.parse(output.trim());
    if (report.schema !== 1 || typeof report.ready !== "boolean") throw Error("Desktop preparation returned an invalid report.");
  } catch (error) {
    report = { schema: 1, ready: false, stage: "bootstrap", reason: error?.code === "ETIMEDOUT" ? "deadline" : "helper-failed",
      checkpoint: lastDesktopCheckpoint(error?.stderr),
      timings: desktopTimingEvidence(error?.stderr),
      failure: desktopFailureEvidence({ code: error?.code, status: error?.status, signal: error?.signal, stdout: error?.stdout ?? output }),
      compilerCodes: [...new Set(String(error?.stderr || "").match(/\bCS\d{4}\b/g) || [])].slice(0, 8) };
  }
  report.parentElapsedMs = Math.round(performance.now() - started);
  retain({ ...report, required: true });
  if (!report.ready) throw Error(`Windows desktop preflight refused: ${report.stage}/${report.reason}.`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareWindowsDesktop({ ifNeeded: process.argv.includes("--if-needed") });
