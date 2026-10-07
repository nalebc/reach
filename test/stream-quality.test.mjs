import test from "node:test";
import assert from "node:assert/strict";
import { RemoteScreenHub } from "../server/remote-screen.mjs";
import { QUALITY } from "../server/desktop-protocol.mjs";

// The Screen stream is as sharp as the phone's own screen (its longest side
// in pixels), with a high bitrate ceiling that auto mode lowers only on a
// struggling connection.
async function streamFor(message) {
  let options;
  const hub = new RemoteScreenHub({}, async (o) => {
    options = o;
    return () => ({ next: async () => Buffer.from("frame"), stop() {} });
  });
  const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  await hub.add(ws, () => true, { display: "primary", format: "h264", ...message });
  for (let i = 0; i < 50 && !options; i++) await new Promise((r) => setTimeout(r, 5));
  hub.remove(ws);
  return options;
}

test("Screen streams at the phone's own resolution, with a high bitrate ceiling", async () => {
  assert.equal(QUALITY.auto.bitrate, 16000000);
  const phone = await streamFor({ quality: "auto", maxWidth: 2868 });
  assert.equal(phone.width, 2868);
  assert.equal(phone.bitrate, 16000000);
  assert.equal(phone.fps, 60);
  // Older pages that don't say keep the previous width.
  assert.equal((await streamFor({ quality: "auto" })).width, 1600);
  for (const maxWidth of [100, 5000, "2868", 2868.5])
    assert.equal((await streamFor({ quality: "auto", maxWidth })).width, 1600);
  // Fixed presets are never made heavier than they are.
  assert.equal((await streamFor({ quality: "saver", maxWidth: 2868 })).width, 1280);
  assert.equal((await streamFor({ quality: "saver", maxWidth: 1000 })).width, 1000);
});
