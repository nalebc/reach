#!/usr/bin/env node
// Synthetic H.264 encode + pipe measurement, never screen capture or input injection.
// Usage: node scripts/benchmark-desktop.mjs /path/to/screen-helper [width height fps]
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { NativeScreenSource } from "../server/screen-stream.mjs";
const [helper, width = "2752", height = "2064", fps = "60"] =
  process.argv.slice(2);
if (!helper) throw Error("Pass the compiled screen-stream helper path.");
const rate = Number(fps);
if (!Number.isInteger(rate) || rate < 1 || rate > 60)
  throw Error("FPS must be 1–60.");
const source = new NativeScreenSource(helper, [
  "--self-test",
  width,
  height,
  fps,
]);
const times = [];
let bytes = 0,
  keyframes = 0;
try {
  await source.next("key"); // Exclude cold startup and the initial encoder allocation.
  const start = performance.now();
  for (let i = 0; i < 300; i++) {
    const begin = performance.now(),
      frame = await source.next(i % 120 === 0 ? "key" : "frame");
    times.push(performance.now() - begin);
    bytes += frame.length;
    const metadata = JSON.parse(frame.subarray(4, 4 + frame.readUInt32BE()));
    if (metadata.key) keyframes++;
    const wait = start + ((i + 1) * 1000) / rate - performance.now();
    if (wait > 0) await delay(wait);
  }
  const elapsed = performance.now() - start,
    sorted = [...times].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        kind: "synthetic-hardware-encode-and-pipe",
        resolution: `${width}x${height}`,
        targetFps: rate,
        frames: times.length,
        seconds: +(elapsed / 1000).toFixed(2),
        fps: +((times.length * 1000) / elapsed).toFixed(1),
        mbps: +((bytes * 8) / elapsed / 1000).toFixed(2),
        encodeAndPipeP50Ms: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
        encodeAndPipeP95Ms:
          +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        keyframes,
        glassToGlassMs: null,
        note: "Includes synthetic CPU raster generation and native encoding. Excludes ScreenCaptureKit, Tailscale, iPad decoding/display, and physical input. Not an end-to-end latency result.",
      },
      null,
      2,
    ),
  );
} finally {
  source.stop();
}
