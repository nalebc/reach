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

// Without FFmpeg, Windows streamed a full JPEG 20 times a second even when
// nothing moved (parity audit #26). A picture identical to the last one is
// now the Mac's one-byte "unchanged", and a real one still goes at least
// every second and whenever a picture is asked to start.
test("a still Windows screen answers unchanged instead of the same picture again", { skip: !run, timeout: 120000 }, async (t) => {
  const displays = await desktopDisplays({});
  const primary = displays.find((d) => d.primary) || displays[0];
  const source = new NativeScreenSource("powershell.exe", powershellFile(path.join(native, "screen-stream.ps1"), [primary.id, "1600"]));
  t.after(() => source.stop());
  const first = await source.next("key");
  assert.deepEqual([...first.subarray(0, 2)], [0xff, 0xd8]);
  const answers = [];
  for (let i = 0; i < 8; i++) answers.push(await source.next("frame"));
  const unchanged = answers.filter((a) => a.length === 1).length;
  note({ unchangedOfEight: unchanged });
  assert.ok(answers.every((a) => (a.length === 1 && a[0] === 0) || (a[0] === 0xff && a[1] === 0xd8)), "each is a picture or unchanged");
  assert.ok(unchanged >= 1, "a still desktop repeats itself as unchanged");
  // Asked to start a picture, it always sends one.
  assert.deepEqual([...(await source.next("key")).subarray(0, 2)], [0xff, 0xd8]);
});

// A locked PC ended the live screen (parity audit #5): the helper now says
// "locked" as the Mac's does, one byte (2), and keeps answering. Locking the
// runner itself would end every later desktop test, so the lock is told.
// The frame above proves the real check reads this unlocked runner as such.
test("a locked session answers the Mac's one-byte locked status, and keeps answering", { skip: !run, timeout: 120000 }, async (t) => {
  const displays = await desktopDisplays({});
  const primary = displays.find((d) => d.primary) || displays[0];
  process.env.REACH_TEST_SCREEN_LOCKED = "1";
  let source;
  try {
    source = new NativeScreenSource("powershell.exe", powershellFile(path.join(native, "screen-stream.ps1"), [primary.id, "1600"]));
  } finally {
    delete process.env.REACH_TEST_SCREEN_LOCKED;
  }
  t.after(() => source.stop());
  for (const command of ["key", "frame", "frame"])
    assert.deepEqual([...(await source.next(command))], [2], "locked, for as long as it is");
});
