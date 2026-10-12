import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopDisplays } from "../server/desktop-native.mjs";
import { NativeScreenSource } from "../server/screen-stream.mjs";
import { powershellFile, scriptBlocked } from "../server/powershell.mjs";

// Oct 11: a first Windows user's live screen never loaded, and no CI lane had
// ever run Reach's real screen helpers: GitHub's runners allow every script,
// a normal PC refuses them. On a real Windows runner, after the CI step sets
// Windows' default policy (Restricted), these run the helpers exactly as Reach
// does. Elsewhere, or without REACH_TEST_WINDOWS_DESKTOP, they're skipped.
const exec = promisify(execFile);
const run = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const native = path.resolve("scripts/native");
const report = {};
const note = (values) => {
  Object.assign(report, values);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-desktop.json", JSON.stringify(report, null, 2));
};

test("a normal PC's policy refuses a helper started without Reach's bypass, in words Reach recognizes", { skip: !run, timeout: 120000 }, async () => {
  const policy = (await exec("powershell.exe", ["-NoProfile", "-Command", "Get-ExecutionPolicy"])).stdout.trim();
  note({ policy });
  assert.equal(policy, "Restricted", "the CI step sets a normal PC's policy first");
  const refused = await exec(
    "powershell.exe",
    ["-NoProfile", "-File", path.join(native, "desktop-input.ps1"), "--list"],
    { timeout: 60000, windowsHide: true },
  ).then(() => null, (error) => error);
  assert.ok(refused, "without the bypass, Windows refuses the helper (the Oct 11 failure)");
  note({ refusedWith: String(refused.stderr).trim().split(/\r?\n/)[0] });
  assert.ok(scriptBlocked(refused.stderr), String(refused.stderr));
});

test("Reach lists the displays and captures a real, non-black frame under that policy", { skip: !run, timeout: 240000 }, async (t) => {
  let started = Date.now();
  const displays = await desktopDisplays({});
  note({ displays, listMs: Date.now() - started });
  assert.ok(displays.length >= 1, "at least one display");
  const primary = displays.find((d) => d.primary) || displays[0];
  // Exactly the live screen's own helper and arguments (server/remote-screen.mjs).
  const source = new NativeScreenSource(
    "powershell.exe",
    powershellFile(path.join(native, "screen-stream.ps1"), [primary.id, "1600"]),
  );
  t.after(() => source.stop());
  started = Date.now();
  const frame = await source.next("key");
  const firstFrameMs = Date.now() - started;
  started = Date.now();
  await source.next("frame");
  note({ firstFrameMs, warmFrameMs: Date.now() - started, bytes: frame.length });
  assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
  // Not a black rectangle: the colors on a 40×40 grid of the picture.
  const file = path.join(os.tmpdir(), `reach-windows-frame-${process.pid}.jpg`);
  fs.writeFileSync(file, frame);
  t.after(() => fs.rmSync(file, { force: true }));
  const { stdout } = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Drawing; $b=[Drawing.Bitmap]::FromFile($env:REACH_FRAME); $w=$b.Width; $h=$b.Height; $seen=@{}; for($x=0;$x -lt $w;$x+=[Math]::Max(1,[int]($w/40))){for($y=0;$y -lt $h;$y+=[Math]::Max(1,[int]($h/40))){$seen[$b.GetPixel($x,$y).ToArgb()]=1}}; $b.Dispose(); \"$w $h $($seen.Count)\"",
    ],
    { env: { ...process.env, REACH_FRAME: file }, windowsHide: true },
  );
  const [width, height, colors] = stdout.trim().split(" ").map(Number);
  note({ width, height, colors });
  assert.ok(width > 0 && width <= 1600 && height > 0, `${width}×${height}`);
  assert.ok(colors > 4, `the picture shows something (${colors} colors on a 40×40 grid)`);
});
