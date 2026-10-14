import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { claudeAppData, claudeAppDataDirs, claudeAppInstalled } from "../server/agent-sessions/claude-app-paths.mjs";
import { claudeAppMain, claudeAppRunning, claudeAppStartedAt } from "../server/agent-sessions/claude-import.mjs";
import { useProcessesFolder, windowsProcesses } from "../server/windows-processes.mjs";

const exec = promisify(execFile);

// The Claude desktop app itself on a real Windows runner, not a stand-in:
// Anthropic's own package (MSIX), installed as its deployment guide says
// (Add-AppxPackage, as an administrator, which the runner is), opened, then
// found by what Reach reads on an owner's PC: its program among Claude
// Code's and Electron's claude.exe, its package and data folders, when it
// started. Only when this file is asked for: it downloads the app.
const real = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const MSIX = `https://claude.ai/api/desktop/win32/${process.arch === "arm64" ? "arm64" : "x64"}/msix/latest/redirect`;
// The test's own installing, under the runner's Restricted policy: Windows'
// Appx module brings files that policy refuses to load.
const powershell = (script, env = {}) =>
  exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 600000, maxBuffer: 16 << 20, env: { ...process.env, ...env } });
const until = async (check, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`${what} within ${ms / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

test("on real Windows, the Claude app itself: its program told from every other claude.exe, its package and data folders, its start", { skip: !real && "needs a real Windows PC (REACH_TEST_WINDOWS_DESKTOP=1)", timeout: 1500000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach claude app-"));
  const report = { msix: MSIX };
  t.after(() => {
    fs.mkdirSync("reports", { recursive: true });
    fs.writeFileSync(path.join("reports", "windows-claude-app.json"), JSON.stringify(report, null, 2));
  });
  const file = path.join(dir, "Claude.msix");
  const response = await fetch(MSIX, { redirect: "follow" });
  assert.equal(response.status, 200, `the download: ${response.status} ${response.url}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  report.download = { from: response.url, bytes: fs.statSync(file).size };

  const listed = async () => JSON.parse((await powershell("@(Get-AppxPackage | ForEach-Object { $_.PackageFullName }) | ConvertTo-Json -Compress")).stdout || "[]");
  const before = new Set(await listed());
  try {
    await powershell("Add-AppxPackage -Path $env:REACH_MSIX", { REACH_MSIX: file });
  } catch (error) {
    report.install = String(error.stderr || error.message).slice(0, 4000);
    throw error;
  }
  const added = (await listed()).filter((name) => !before.has(name));
  report.added = added;
  assert.equal(added.length, 1, `one package added: ${JSON.stringify(added)}`);
  const pkg = JSON.parse(
    (
      await powershell(
        "$p = Get-AppxPackage | Where-Object { $_.PackageFullName -eq $env:REACH_PKG }; [pscustomobject]@{ Name = $p.Name; Family = $p.PackageFamilyName; Location = $p.InstallLocation; App = @((Get-AppxPackageManifest -Package $p.PackageFullName).Package.Applications.Application)[0].Id } | ConvertTo-Json -Compress",
        { REACH_PKG: added[0] },
      )
    ).stdout,
  );
  report.package = pkg;
  t.after(async () => {
    await powershell("Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($env:REACH_DIR, 'OrdinalIgnoreCase') } | Stop-Process -Force -ErrorAction SilentlyContinue; Remove-AppxPackage -Package $env:REACH_PKG", { REACH_DIR: pkg.Location, REACH_PKG: added[0] }).catch(() => {});
  });

  // The package as claude-app-paths.mjs looks for it. Installed but never
  // opened: noted (Windows may make its Packages folder only when it opens).
  assert.match(pkg.Family, /^Claude_[a-z0-9]{13}$/i, "its family name, as the Packages folder is named");
  report.installedBeforeOpening = claudeAppInstalled();

  // Opened as the Start menu opens it.
  await powershell("Start-Process -FilePath ('shell:AppsFolder\\' + $env:REACH_AUMID)", { REACH_AUMID: `${pkg.Family}!${pkg.App}` });
  const opened = Date.now();
  const nativeDir = path.join(dir, "native");
  const main = await until(async () => {
    const rows = await windowsProcesses({ nativeDir });
    report.processes = rows.filter((row) => /claude/i.test(row.image)).map(({ pid, ppid, image, path: where, commandLine, startedAt }) => ({ pid, ppid, image, path: where, commandLine: commandLine && commandLine.slice(0, 400), startedAt }));
    const found = claudeAppMain(rows);
    return found.length ? found : null;
  }, 120000, "the app's own process found");
  report.main = main.map((p) => p.pid);
  assert.equal(main.length, 1, `one main process: ${JSON.stringify(report.processes)}`);
  assert.ok(main[0].path.toLowerCase().startsWith(pkg.Location.toLowerCase() + "\\"), `in its package: ${main[0].path}`);
  assert.ok(main[0].startedAt >= opened - 60000 && main[0].startedAt <= Date.now(), `started when it was opened (${main[0].startedAt} vs ${opened})`);

  // The server's own readers, through Reach's data folder.
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir);
  useProcessesFolder(dataDir);
  t.after(() => useProcessesFolder(null));
  assert.equal(await claudeAppRunning(), true);
  assert.equal(await claudeAppStartedAt(), main[0].startedAt);
  assert.equal(claudeAppInstalled(), true, "installed, as Reach reads it");

  // Its data in the package's own copy of %APPDATA%, which is what it reads.
  report.dataDirs = claudeAppDataDirs();
  const data = await until(() => (fs.existsSync(report.dataDirs[0]) ? report.dataDirs[0] : null), 120000, `its data folder ${report.dataDirs[0]}`);
  assert.equal(claudeAppData(), data);
  report.data = fs.readdirSync(data).slice(0, 40);
});
