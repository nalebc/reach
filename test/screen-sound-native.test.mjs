import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopBinary, windowsBinary } from "../server/desktop-native.mjs";
import { SoundSource } from "../server/screen-sound.mjs";

// The real sound helpers, built as Reach builds them: a Mac's with
// swiftc, a Windows PC's with its own csc.exe. Their self-test sends a tone
// through the same packets without capturing anything (no permission
// needed). Capturing for real needs a Mac allowed Screen Recording
// (REACH_TEST_SOUND_CAPTURE=1), or a PC with a sound output.
const folder = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-sound-native-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
// Everything a helper sends until it ends, or until `ms` passes.
function run(file, args, ms = 30000) {
  return new Promise((resolve) => {
    const seen = { info: [], packets: [], error: null, first: null };
    let source;
    const timer = setTimeout(() => source.stop(Error("Stopped by the test.")), ms);
    source = new SoundSource(file, args, {
      onInfo: (info) => seen.info.push(info),
      onSamples: (samples) => {
        seen.first ??= samples;
        seen.packets.push(samples.length);
      },
      onEnd: (error) => {
        clearTimeout(timer);
        seen.error = error;
        resolve(seen);
      },
    });
  });
}
const tone = (seen) => {
  assert.deepEqual(seen.info, [{ rate: 48000, channels: 2 }]);
  assert.deepEqual(seen.packets, Array(10).fill(1920), "ten 20 ms packets");
  // 440 Hz on the left, 660 Hz on the right.
  assert.equal(seen.first[0], 0);
  assert.ok(Math.abs(seen.first[2] - Math.round(12000 * Math.sin((2 * Math.PI * 440) / 48000))) <= 1, `${seen.first[2]}`);
  assert.ok(Math.abs(seen.first[3] - Math.round(12000 * Math.sin((2 * Math.PI * 660) / 48000))) <= 1, `${seen.first[3]}`);
};
// What a helper may say when this computer has nothing to capture: it
// names why, it never hangs or crashes.
const PLAIN = /no sound output|Windows Audio isn't running|Screen Recording|sound output changed|to itself/;

test("on a Mac, the sound helper builds and its tone comes through whole", {
  skip: process.platform !== "darwin", timeout: 240000,
}, async (t) => {
  const file = await desktopBinary({ dataDir: await folder(t) }, "screen-sound");
  const seen = await run(file, ["--self-test", "0.2"]);
  tone(seen);
  assert.equal(seen.error.message, "Sound capture stopped.", "it ended by itself, saying nothing");
});

test("on a Mac allowed Screen Recording, the helper hears the Mac and stops the moment it's told", {
  skip: !(process.platform === "darwin" && process.env.REACH_TEST_SOUND_CAPTURE === "1"), timeout: 240000,
}, async (t) => {
  const file = await desktopBinary({ dataDir: await folder(t) }, "screen-sound");
  const seen = await run(file, [], 2000);
  assert.deepEqual(seen.info, [{ rate: 48000, channels: 2 }]);
  // ScreenCaptureKit sends every 20 ms, silence included.
  assert.ok(seen.packets.length >= 40, `${seen.packets.length} packets in 2 s`);
  assert.ok(seen.packets.every((n) => n === 1920));
  assert.equal(seen.error.message, "Stopped by the test.");
});

test("on real Windows, the PC's own csc.exe builds the sound helper; its tone comes through, and a PC without sound says so", {
  skip: !(process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1"), timeout: 240000,
}, async (t) => {
  const file = await windowsBinary({ dataDir: await folder(t) }, "screen-sound");
  tone(await run(file, ["--self-test", "0.2"]));
  // GitHub's runners have no speakers: either the PC's sound, or why not.
  const seen = await run(file, [], 3000);
  if (seen.info.length) {
    assert.equal(seen.error.message, "Stopped by the test.");
    assert.ok([1, 2].includes(seen.info[0].channels));
  } else assert.match(seen.error.message, PLAIN);
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile("reports/windows-sound.json", JSON.stringify({ info: seen.info, packets: seen.packets.length, said: seen.error?.message }, null, 2));
});

test("CI and every release test the sound end to end, on a Mac and a PC, and in the shipped package", async () => {
  const { suites, testFiles } = await import("../.github/scripts/run-tests.mjs");
  // The shared tests in the Windows lane; every file (the real-helper browser
  // test included) on the Linux and Mac runners; the Mac's helper natively.
  for (const name of ["screen-sound", "screen-sound-route", "screen-sound-ui", "sound-worklet"])
    assert.ok(suites.windows.includes(name), `${name} needs the Windows lane`);
  assert.ok(suites.native.includes("screen-sound-native"), "the Mac's helper needs the native lane");
  assert.ok(testFiles("all").includes(path.join("test", "screen-sound-chrome-e2e.test.mjs")));
  const ci = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /- os: macos-15\s+node: 22\s+suite: all/, "a Mac runner runs every file");
  // The step that builds Windows helpers with the PC's own csc.exe, gate on:
  // the PC's helper, and the browser playing it.
  const step = ci.split("\n").find((line) => line.includes("test/windows-native-build.test.mjs"));
  assert.match(step, /test\/screen-sound-native\.test\.mjs/);
  assert.match(step, /test\/screen-sound-chrome-e2e\.test\.mjs/);
  // The npm and portable artifacts carry both helpers, ship the worklet as a
  // file, and build and play the helper on the release's own OS. Releases
  // run this same CI (release.yml uses ci.yml) before anything is published.
  const smoke = await fs.readFile(new URL("../scripts/smoke-package.mjs", import.meta.url), "utf8");
  for (const file of ["scripts/native/screen-sound.swift", "scripts/native/screen-sound.cs"]) assert.ok(smoke.includes(`"${file}"`), file);
  assert.match(smoke, /verify packaged sound/);
  const release = await fs.readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml/);
});
