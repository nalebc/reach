import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsTerminalExe } from "../../server/windows-shell.mjs";
import { windowsProcesses } from "../../server/windows-processes.mjs";

// Windows Terminal itself for the real-Windows tests, so its paths are proven
// rather than skipped. GitHub's runner has it registered as the default
// terminal (consoles are handed to it) but no wt.exe (Oct 14): then its own
// unpackaged build is used, from its official release
// (github.com/microsoft/terminal/releases), pinned by version and by the
// SHA-256 GitHub publishes for the asset (the release notes publish none).
// It runs portable (settings beside it, never the PC's own), from a folder
// with a space in its name, put first on PATH for the test and every Reach it
// starts. Only on Windows, only for tests. While any Windows Terminal runs, it
// takes the consoles Windows hands over (each instance registers for them),
// so the portable one is ended as soon as its tests are done.
export const PORTABLE = {
  version: "1.25.2733.0",
  assets: {
    x64: { name: "Microsoft.WindowsTerminal_1.25.2733.0_x64.zip", sha256: "bf3ef2012f6c44d8340a4c58125acc9498d19b580f9890dc043cdf831852e796" },
    arm64: { name: "Microsoft.WindowsTerminal_1.25.2733.0_arm64.zip", sha256: "11b4fe264ecaa71b08cd84195536f68c669808155338e9f47f4da668b4cf0e26" },
  },
};
const run = promisify(execFile);
const system = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32");

// wt.exe in the unpacked archive (a folder named for its version).
function findTerminal(dir, depth = 2) {
  if (fs.existsSync(path.join(dir, "wt.exe")) && fs.existsSync(path.join(dir, "WindowsTerminal.exe"))) return dir;
  if (!depth) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) {
      const found = findTerminal(path.join(dir, entry.name), depth - 1);
      if (found) return found;
    }
  return null;
}

let ready = null;
/**
 * Windows Terminal for this test file: the PC's own when it has a wt.exe,
 * else the pinned portable build, put first on PATH (process.env, so every
 * process the test starts has it). { source, wt, folder, exe, version? }
 */
export function useWindowsTerminal() {
  if (process.platform !== "win32") return Promise.reject(Error("Windows Terminal is for the real-Windows tests."));
  ready ??= (async () => {
    const own = windowsTerminalExe({ env: process.env });
    if (own) return { source: "installed", wt: own, folder: path.dirname(own), exe: null };
    const asset = PORTABLE.assets[process.arch];
    if (!asset) throw Error(`Windows Terminal publishes no portable build for ${process.arch}.`);
    const url = `https://github.com/microsoft/terminal/releases/download/v${PORTABLE.version}/${asset.name}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error(`Downloading ${url} answered ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== asset.sha256) throw Error(`${asset.name} isn't the one GitHub published: SHA-256 ${sha256}, expected ${asset.sha256}.`);
    // Its long name (never C:\Users\RUNNER~1\…): Windows names a running
    // program by it, and that's how its processes are found to be ended.
    const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "reach windows terminal-"));
    const zip = path.join(dir, asset.name);
    fs.writeFileSync(zip, bytes);
    const unpacked = path.join(dir, "unpacked");
    fs.mkdirSync(unpacked);
    // Windows' own tar (bsdtar, in System32 since Windows 10 1803) reads zips.
    await run(path.join(system(), "tar.exe"), ["-xf", zip, "-C", unpacked], { timeout: 120000, windowsHide: true });
    const folder = findTerminal(unpacked);
    if (!folder) throw Error(`${asset.name} has no wt.exe beside WindowsTerminal.exe: ${fs.readdirSync(unpacked).join(", ")}`);
    fs.writeFileSync(path.join(folder, ".portable"), "");
    process.env.PATH = `${folder};${process.env.PATH || ""}`;
    return { source: "portable", version: PORTABLE.version, wt: path.join(folder, "wt.exe"), folder, exe: path.join(folder, "WindowsTerminal.exe"), dir };
  })();
  return ready;
}

/** Ends the portable Windows Terminal's processes and removes it (the PC's own is left alone). */
export async function endWindowsTerminal({ nativeDir } = {}) {
  const terminal = ready && (await ready.catch(() => null));
  if (!terminal || terminal.source !== "portable") return;
  const folder = `${terminal.folder.toLowerCase()}\\`;
  for (let round = 0; round < 3; round++) {
    let inside = [];
    try {
      inside = (await windowsProcesses({ nativeDir })).filter((p) => p.path && p.path.toLowerCase().startsWith(folder));
    } catch {}
    if (!inside.length) break;
    for (const p of inside) await run("taskkill.exe", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  ready = null;
  // Best effort: a file Windows still holds stays in the temp folder.
  try {
    fs.rmSync(terminal.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}
/** Whether a running program is this test's Windows Terminal (the portable one by its path; the PC's own by its name). */
export const isTerminal = (process, terminal) =>
  !!process && /^WindowsTerminal\.exe$/i.test(process.image) && (!terminal.exe || String(process.path).toLowerCase() === terminal.exe.toLowerCase());

/**
 * Why Windows Terminal shows nothing, when it doesn't: whether its program
 * runs, and what Windows logged about it starting (a missing runtime DLL, a
 * side-by-side error) in the last ten minutes.
 */
export async function whyNoWindowsTerminal({ nativeDir } = {}) {
  const terminal = ready && (await ready.catch((error) => ({ error })));
  if (!terminal) return "Windows Terminal wasn't set up.";
  if (terminal.error) return terminal.error.message;
  const said = [];
  try {
    const running = (await windowsProcesses({ nativeDir })).filter((p) => /^(WindowsTerminal|wt|OpenConsole)\.exe$/i.test(p.image));
    said.push(`running: ${running.map((p) => `${p.image} ${p.path || "?"}`).join("; ") || "none"}`);
  } catch (error) {
    said.push(`processes unknown: ${error.message}`);
  }
  try {
    const { stdout } = await run(
      path.join(system(), "wevtutil.exe"),
      ["qe", "Application", "/c:20", "/rd:true", "/f:text", "/q:*[System[(Level=1 or Level=2) and TimeCreated[timediff(@SystemTime) <= 600000]]]"],
      { windowsHide: true, timeout: 30000, maxBuffer: 1 << 20 },
    );
    const events = String(stdout).split(/\r?\nEvent\[/).filter((e) => /WindowsTerminal|wt\.exe|OpenConsole|SideBySide/i.test(e));
    said.push(events.length ? `Windows logged: ${events.map((e) => e.replace(/\s+/g, " ").slice(0, 400)).join(" | ")}` : "Windows logged no error about it");
  } catch (error) {
    said.push(`event log unread: ${error.message}`);
  }
  return `${terminal.source} Windows Terminal at ${terminal.wt}: ${said.join("; ")}`;
}

/**
 * Every Windows Terminal window's tabs as UI Automation sees them (what the
 * PC shows): [{ window, pid, tabs: [{ name, selected }] }]. Read by Windows
 * PowerShell's own UI Automation, never by Reach's helper it checks.
 */
export async function windowsTerminalTabs() {
  const script = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$byClass = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$isTab = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$out = @(foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byClass)) {
  $tabs = @(foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isTab)) {
    $p = $null
    $selected = $false
    if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $selected = $p.Current.IsSelected }
    [pscustomobject]@{ name = $t.Current.Name; selected = $selected }
  })
  [pscustomobject]@{ window = $w.Current.Name; pid = $w.Current.ProcessId; tabs = $tabs }
})
ConvertTo-Json -Depth 5 -Compress -InputObject $out
`;
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 60000, maxBuffer: 1 << 20 },
  );
  const text = String(stdout).trim();
  const value = text ? JSON.parse(text) : [];
  return (Array.isArray(value) ? value : [value]).map((w) => ({ ...w, tabs: Array.isArray(w.tabs) ? w.tabs : w.tabs ? [w.tabs] : [] }));
}
