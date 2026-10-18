import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

// What the computer itself received from Reach's screen control, for the
// screen-control journeys: a recorder window (clicks, keys, text) and a
// terminal reading raw key bytes, on a Mac and on a Windows PC alike.
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const windows = process.platform === "win32";
export const INITIAL_TEXT = "alpha bravo charlie delta echo foxtrot";

// Which process owns the window in front (Windows): its id, or 0.
const WINDOWS_FRONT = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ReachRecorderFront {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$pid0 = 0; [ReachRecorderFront]::GetWindowThreadProcessId([ReachRecorderFront]::GetForegroundWindow(), [ref]$pid0) | Out-Null; $pid0
`;
const frontPid = async () =>
  Number((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_FRONT, "utf16le").toString("base64")], { windowsHide: true, timeout: 30000 })).stdout.trim()) || 0;
const frontMacApp = async () =>
  (await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { timeout: 15000 })).stdout.trim();

// The Windows recorder: the Mac one's regions and events, in WinForms, DPI
// aware so its pixels are the ones Reach streams.
const WINDOWS_RECORDER = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ReachRecorderDpi { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v); }
'@
[ReachRecorderDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$out = $env:REACH_RECORDER_OUT
$started = [DateTime]::UtcNow
$script:lines = New-Object System.Collections.Generic.List[string]
function Log($entry) {
  $entry["t"] = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  $script:lines.Add(($entry | ConvertTo-Json -Compress))
  [IO.File]::WriteAllText("$out.events", ($script:lines -join "\`n") + "\`n")
}
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.TopMost = $true; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $true
$f.KeyPreview = $true
$scale = $f.DeviceDpi / 96.0
$W = [int](900 * $scale); $H = [int](520 * $scale); $cellH = [int](110 * $scale)
$f.Left = [int](80 * $scale); $f.Top = [int](60 * $scale); $f.Width = $W; $f.Height = $H
$f.BackColor = [System.Drawing.Color]::White
$cells = @()
for ($i = 0; $i -lt 8; $i++) {
  $p = New-Object System.Windows.Forms.Panel
  $p.Left = [int](($i % 4) * $W / 4); $p.Top = [int]([math]::Floor($i / 4) * $cellH); $p.Width = [int]($W / 4); $p.Height = $cellH
  $p.BackColor = [System.Drawing.Color]::FromArgb(255, 60 + $i * 24, 200 - $i * 15, 120 + $i * 10)
  $p.BorderStyle = 'FixedSingle'
  $p.Tag = $i
  $p.Add_MouseDown({ param($s, $e) $kind = if ($e.Button -eq 'Right') { 'right' } else { 'down' }; Log @{ kind = $kind; cell = [int]$s.Tag; x = $e.X / $scale; y = $e.Y / $scale; count = $e.Clicks } })
  $p.Add_MouseUp({ param($s, $e) Log @{ kind = 'up'; cell = [int]$s.Tag; x = $e.X / $scale; y = $e.Y / $scale; count = $e.Clicks } })
  $p.Add_MouseWheel({ param($s, $e) Log @{ kind = 'scroll'; cell = [int]$s.Tag; dx = 0; dy = $e.Delta } })
  $f.Controls.Add($p); $cells += $p
}
$field = New-Object System.Windows.Forms.TextBox
$field.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$field.Left = [int](20 * $scale); $field.Top = 2 * $cellH + [int](20 * $scale); $field.Width = $W - [int](40 * $scale)
$field.Add_TextChanged({ [IO.File]::WriteAllText("$out.field", $field.Text); Log @{ kind = 'field'; value = $field.Text } })
$field.Add_MouseDown({ param($s, $e) Log @{ kind = 'mouse'; type = 1; x = ($e.X + $s.Left) / $scale; y = ($e.Y + $s.Top) / $scale; count = $e.Clicks } })
$f.Controls.Add($field)
$text = New-Object System.Windows.Forms.RichTextBox
$text.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$text.Left = [int](20 * $scale); $text.Top = 2 * $cellH + [int](74 * $scale); $text.Width = $W - [int](40 * $scale); $text.Height = $H - $text.Top - [int](20 * $scale)
$text.Text = '${INITIAL_TEXT}'
$text.DetectUrls = $false
$text.Add_TextChanged({ [IO.File]::WriteAllText("$out.text", $text.Text); Log @{ kind = 'text'; value = $text.Text } })
$text.Add_SelectionChanged({ Log @{ kind = 'selection'; location = $text.SelectionStart; length = $text.SelectionLength; selected = $text.SelectedText } })
$text.Add_MouseDown({ param($s, $e) Log @{ kind = 'mouse'; type = 1; x = ($e.X + $s.Left) / $scale; y = ($e.Y + $s.Top) / $scale; count = $e.Clicks } })
$f.Controls.Add($text)
$f.Add_KeyDown({ param($s, $e) Log @{ kind = 'key'; code = [int]$e.KeyCode; mods = [int]$e.Modifiers } })
$f.Add_Shown({
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $regions = @{}
  for ($i = 0; $i -lt 8; $i++) { $c = $cells[$i]; $pt = $c.PointToScreen([System.Drawing.Point]::Empty); $regions["cell$i"] = @{ x = ($pt.X - $b.Left) / $scale; y = ($pt.Y - $b.Top) / $scale; width = $c.Width / $scale; height = $c.Height / $scale } }
  foreach ($pair in @(@('field', $field), @('text', $text))) { $c = $pair[1]; $pt = $c.PointToScreen([System.Drawing.Point]::Empty); $regions[$pair[0]] = @{ x = ($pt.X - $b.Left) / $scale; y = ($pt.Y - $b.Top) / $scale; width = $c.Width / $scale; height = $c.Height / $scale } }
  $ready = @{ display = @{ width = $b.Width / $scale; height = $b.Height / $scale }; regions = $regions }
  [IO.File]::WriteAllText("$out.ready", ($ready | ConvertTo-Json -Compress -Depth 5))
  $f.Activate()
})
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 600000; $timer.Add_Tick({ $f.Close() }); $timer.Start()
[System.Windows.Forms.Application]::Run($f)
`;

// The recorder window, open on the main display; its regions as shares of
// the display; what it got so far.
export async function recorder(t, dir) {
  const out = path.join(dir, "rec");
  let child;
  if (windows) {
    child = spawn("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_RECORDER, "utf16le").toString("base64")], {
      env: { ...process.env, REACH_RECORDER_OUT: out },
      stdio: "ignore",
    });
  } else {
    const binary = path.join(dir, "input-recorder");
    await run("/usr/bin/xcrun", ["swiftc", "-O", path.resolve("test/fixtures/mac/input-recorder.swift"), "-o", binary], { timeout: 240000 });
    child = spawn(binary, [out], { stdio: "ignore" });
  }
  const stop = () => {
    try {
      child.kill();
    } catch {}
  };
  t.after(stop);
  for (const end = Date.now() + 90000; !fs.existsSync(`${out}.ready`); await sleep(100))
    if (Date.now() > end || child.exitCode !== null) throw Error("The recorder didn't open.");
  await sleep(300);
  const ready = JSON.parse(fs.readFileSync(`${out}.ready`, "utf8"));
  const { width, height } = ready.display;
  const share = (r, fx = 0.5, fy = 0.5) => ({ x: (r.x + r.width * fx) / width, y: (r.y + r.height * fy) / height });
  const read = (name, fallback = "") => {
    try {
      return fs.readFileSync(`${out}.${name}`, "utf8");
    } catch {
      return fallback;
    }
  };
  const events = () =>
    read("events")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  // The recorder's own rectangle: the only place its scenarios may tap.
  const r = Object.values(ready.regions);
  const left = Math.min(...r.map((v) => v.x)), top = Math.min(...r.map((v) => v.y));
  const right = Math.max(...r.map((v) => v.x + v.width)), bottom = Math.max(...r.map((v) => v.y + v.height));
  return {
    stop,
    // Is the recorder the window in front (typing goes to it, nowhere else)?
    front: async () => (windows ? (await frontPid()) === child.pid : (await frontMacApp()) === "input-recorder"),
    contains: (at) => at.x * width >= left && at.x * width <= right && at.y * height >= top && at.y * height <= bottom,
    regions: ready.regions,
    display: ready.display,
    share,
    events,
    field: () => read("field"),
    // Windows' rich text box keeps "\n" lines, as the Mac's text view does.
    text: () => read("text", INITIAL_TEXT),
  };
}

// The PowerShell a Windows console runs: it places its own window, says
// where, and appends each key's character to the file.
const WINDOWS_TERMINAL = (file, ready) => `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ReachRecorderConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[ReachRecorderConsole]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$h = [ReachRecorderConsole]::GetConsoleWindow()
$scale = [ReachRecorderConsole]::GetDpiForWindow($h) / 96.0
[ReachRecorderConsole]::SetWindowPos($h, [IntPtr](-1), [int](200 * $scale), [int](140 * $scale), [int](800 * $scale), [int](500 * $scale), 0x40) | Out-Null
[ReachRecorderConsole]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$r = New-Object ReachRecorderConsole+RECT
[ReachRecorderConsole]::GetWindowRect($h, [ref]$r) | Out-Null
[IO.File]::WriteAllText('${ready}', "$($r.Left / $scale),$($r.Top / $scale),$($r.Right / $scale),$($r.Bottom / $scale)")
while ($true) { $k = [Console]::ReadKey($true); [IO.File]::AppendAllText('${file}', [string]$k.KeyChar) }
`;

// A terminal of the test's own, frontmost, reading raw key bytes into a
// file: a Mac's Terminal in raw mode, a Windows console reading keys.
// bounds: [left, top, right, bottom] in points (DIPs) of the main display.
export async function rawTerminal(t, dir) {
  const file = path.join(dir, "terminal.raw");
  fs.writeFileSync(file, "");
  if (windows) {
    const ready = path.join(dir, "terminal.ready");
    const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const script = Buffer.from(WINDOWS_TERMINAL(file, ready), "utf16le").toString("base64");
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Start-Process -FilePath '${path.join(system, "conhost.exe")}' -ArgumentList 'powershell.exe -NoProfile -EncodedCommand ${script}' -PassThru).Id`],
      { windowsHide: true, timeout: 60000 },
    );
    const pid = Number(stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, `the console window started: ${stdout}`);
    t.after(() => run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {}));
    for (const end = Date.now() + 60000; !fs.existsSync(ready); await sleep(100)) if (Date.now() > end) throw Error("The console didn't open.");
    await sleep(300);
    const bounds = fs.readFileSync(ready, "utf8").split(",").map(Number);
    return { file, bounds, bytes: () => fs.readFileSync(file), enter: "\r", backspace: "\b", front: async () => (await frontPid()) === pid };
  }
  const tell = async (body) => (await run("/usr/bin/osascript", ["-e", `tell application "Terminal"\n${body}\nend tell`], { timeout: 30000 })).stdout.trim();
  const tty = await tell(`activate\nset t to do script "stty raw -echo; exec cat > '${file}'"\nset custom title of t to "reach-screen-control"\nreturn tty of t`);
  assert.match(tty, /^\/dev\/ttys\d+$/);
  const each = (then) => `repeat with w in windows\nrepeat with t in tabs of w\nif tty of t is "${tty}" then\n${then}\nend if\nend repeat\nend repeat`;
  t.after(() => tell(each("close w saving no\nreturn")).catch(() => {}));
  await sleep(1500);
  await tell(each("set bounds of w to {200, 140, 1000, 640}\nset index of w to 1\nreturn"));
  await sleep(500);
  const bounds = (await tell(each("return bounds of w"))).split(/,\s*/).map(Number);
  // Terminal in front, and this test's window in front of Terminal's.
  const front = async () =>
    (await frontMacApp()) === "Terminal" && (await tell("return tty of selected tab of front window").catch(() => "")) === tty;
  return { file, bounds, bytes: () => fs.readFileSync(file), enter: "\r", backspace: "\x7f", front };
}
