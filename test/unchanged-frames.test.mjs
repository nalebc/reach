import test from "node:test";
import assert from "node:assert/strict";
import { RemoteBroadcast } from "../server/remote-screen.mjs";
import { ScreenBroadcast } from "../server/screen-stream.mjs";

// The capture helper answers "nothing changed on screen" with one byte. The
// stream stays live (every change goes out at once) without sending the same
// picture again, so phones don't decode and draw duplicates.
const unchanged = Buffer.from([0]);
const until = async (check, timeout = 2000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const viewer = () => {
  const sent = [];
  return { sent, ws: { readyState: 1, bufferedAmount: 0, send: (d) => sent.push(d), close() {} } };
};

test("the live stream sends every change and skips unchanged frames", async () => {
  const queue = [unchanged, Buffer.from("change-1"), unchanged, unchanged, Buffer.from("change-2")];
  let asked = 0;
  const source = {
    next: async () => {
      asked++;
      return queue.shift() ?? unchanged;
    },
    stop() {},
    setBitrate() {},
  };
  const broadcast = new RemoteBroadcast(async () => () => source, {
    fps: 60,
    bitrate: 4000000,
    quality: "auto",
  });
  const { sent, ws } = viewer();
  broadcast.add(ws, () => true);
  await until(() => asked >= 8);
  broadcast.remove(ws);
  const frames = sent.filter(Buffer.isBuffer);
  assert.deepEqual(
    frames.map((f) => f.subarray(4).toString()),
    ["change-1", "change-2"],
  );
  // Sequence numbers stay consecutive: the phone sees no gaps to recover from.
  assert.deepEqual(
    frames.map((f) => f.readUInt32BE(0)),
    [1, 2],
  );
});

test("older viewers skip unchanged frames too", async () => {
  const queue = [unchanged, Buffer.from("jpeg-1"), unchanged];
  let asked = 0;
  const broadcast = new ScreenBroadcast(async () => () => ({
    next: async () => {
      asked++;
      return queue.shift() ?? unchanged;
    },
    stop() {},
  }));
  const { sent, ws } = viewer();
  broadcast.add(ws, () => true);
  await until(() => sent.some(Buffer.isBuffer));
  // These viewers acknowledge each picture before getting the next.
  broadcast.ack(ws);
  await until(() => asked >= 4, 3000);
  broadcast.remove(ws);
  assert.deepEqual(
    sent.filter(Buffer.isBuffer).map((f) => f.toString()),
    ["jpeg-1"],
  );
});
