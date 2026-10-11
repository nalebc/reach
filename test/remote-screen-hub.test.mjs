import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteBroadcast,
  RemoteScreenHub,
  sentKeyframe,
  privateWindows,
} from "../server/remote-screen.mjs";
import { NativeScreenSource } from "../server/screen-stream.mjs";

// The live screen's server side, with fake capture sources: no real screen
// is captured here.
const until = async (check, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const socket = () => {
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send: (m) => ws.sent.push(m),
    close() {
      ws.readyState = 3;
    },
  };
  return ws;
};
const json = (ws) =>
  ws.sent.filter((m) => typeof m === "string").map((m) => JSON.parse(m));
const binary = (ws) => ws.sent.filter((m) => Buffer.isBuffer(m));
const video = (key) => {
  const meta = Buffer.from(JSON.stringify({ key, timestamp: 0, width: 2, height: 2, codec: "avc1.64002a" }));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(meta.length);
  return Buffer.concat([head, meta, Buffer.from([0, 0, 0, 1, 9])]);
};

test("a frame clears a viewer's keyframe request only when it was a keyframe", async () => {
  assert.equal(sentKeyframe(video(true), "h264"), true);
  assert.equal(sentKeyframe(video(false), "h264"), false);
  assert.equal(sentKeyframe(Buffer.from("garbled"), "h264"), false);
  assert.equal(sentKeyframe(Buffer.from([0xff, 0xd8, 1]), "jpeg"), true);
  const commands = [];
  // The encoder answers the first "key" with a delta (it was mid-frame).
  const answers = [video(false), video(true), video(false), video(false)];
  const group = new RemoteBroadcast(
    async () => () => ({
      next: async (c) => {
        commands.push(c);
        return answers.shift() ?? Buffer.from([0]);
      },
      stop() {},
    }),
    { fps: 60, format: "h264", quality: "high", bitrate: 1e6 },
  );
  const ws = socket();
  group.add(ws, () => true);
  await until(() => commands.length >= 4);
  group.remove(ws);
  // Still waiting for a keyframe after the delta: asked again.
  assert.deepEqual(commands.slice(0, 3), ["key", "key", "frame"]);
});

test("a stale group never frees the key a newer group holds, and empties once", async () => {
  let stops = 0;
  const hub = new RemoteScreenHub({}, async () => () => ({
    next: async () => video(true),
    stop: () => stops++,
  }));
  const first = socket();
  await hub.add(first, () => true, { display: "1", format: "h264" });
  const [key] = hub.groups.keys();
  const stale = hub.groups.get(key);
  let empties = 0;
  const onEmpty = stale.onEmpty;
  stale.onEmpty = () => {
    empties++;
    onEmpty();
  };
  await until(() => binary(first).length > 0);
  // The group drops its viewer itself (stopped responding): the hub still
  // maps the socket to it until the socket closes.
  stale.fail(first, "Screen viewer stopped responding.");
  assert.equal(hub.groups.has(key), false);
  const second = socket();
  await hub.add(second, () => true, { display: "1", format: "h264" });
  const fresh = hub.groups.get(key);
  assert.notEqual(fresh, stale);
  await until(() => binary(second).length > 0);
  // The first socket's close arrives late: the stale group stays quiet.
  hub.remove(first);
  stale.remove(first);
  assert.equal(empties, 1);
  assert.equal(hub.groups.get(key), fresh);
  // A stale onEmpty that still runs can't take the newer group's key either.
  onEmpty();
  assert.equal(hub.groups.get(key), fresh);
  hub.remove(second);
  assert.equal(hub.groups.has(key), false);
  assert.equal(stops, 2);
});

test("a display that isn't shared with this viewer is refused, with a reason", async () => {
  let started = 0;
  const hub = new RemoteScreenHub({}, async () => {
    started++;
    return () => ({ next: async () => video(true), stop() {} });
  });
  const ws = socket();
  await assert.rejects(
    hub.add(ws, () => true, { display: "901", format: "h264" }, {
      mayViewDisplay: (id) => id !== "901",
    }),
    (e) => e.status === 403 && /isn't shared with you/.test(e.message),
  );
  assert.equal(hub.viewers.size, 0, "the reservation is freed");
  assert.equal(started, 0);
  // Becoming an app's display mid-stream ends it, named, not silently.
  let shared = true;
  const viewer = socket();
  await hub.add(viewer, () => true, { display: "2", format: "h264" }, {
    mayViewDisplay: () => shared,
  });
  await until(() => binary(viewer).length > 0);
  shared = false;
  await until(() => viewer.readyState === 3);
  const error = json(viewer).find((m) => m.type === "error");
  assert.equal(error.retryable, false);
  assert.match(error.error, /isn't shared with you/);
  hub.remove(viewer);
});

test("a sleeping Mac's helper answers why; viewers hear it, keep waiting, and get a keyframe after", async () => {
  // A fake helper: a length-prefixed answer per request line. A picture,
  // then asleep, then locked, then pictures again.
  const script = `
    let n = 0;
    const out = (b) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); process.stdout.write(Buffer.concat([h, b])); };
    require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
      n++;
      process.stderr.write(line + "\\n");
      if (n === 2) out(Buffer.from([1]));
      else if (n === 3) out(Buffer.from([2]));
      else out(Buffer.from(line === "key" ? "KEYFRAME" : "delta"));
    });`;
  const lines = [];
  const group = new RemoteBroadcast(
    async () => () => {
      const source = new NativeScreenSource(process.execPath, ["-e", script]);
      source.child.stderr.on("data", (b) => lines.push(...b.toString().split("\n").filter(Boolean)));
      return source;
    },
    { fps: 60, format: "jpeg", quality: "high", bitrate: 1e6 },
  );
  const ws = socket();
  const started = Date.now();
  group.add(ws, () => true);
  await until(() => binary(ws).length > 1, 8000);
  const elapsed = Date.now() - started;
  group.remove(ws);
  const statuses = json(ws).filter((m) => m.type === "status").map((m) => m.idle);
  assert.deepEqual(statuses, ["asleep", "locked", ""]);
  assert.equal(group.idle, "");
  // Asked about once a second while there's nothing to show, not 60 times.
  assert.ok(elapsed >= 1800, `took ${elapsed} ms`);
  assert.deepEqual(lines.slice(0, 4), ["key", "frame", "key", "key"]);
  assert.deepEqual(
    binary(ws).slice(0, 2).map((p) => p.subarray(4).toString()),
    ["KEYFRAME", "KEYFRAME"],
    "the first picture after waking is a keyframe",
  );
  assert.equal(json(ws).some((m) => m.type === "error"), false);
});

test("a guest's picture is its own stream that leaves out private windows; the owner's is unchanged", async () => {
  const prepared = [];
  const hub = new RemoteScreenHub({}, async (options, extra) => {
    prepared.push(extra.privateView);
    return () => ({ next: async () => video(true), stop() {} });
  });
  const owner = socket(),
    guest = socket();
  await hub.add(owner, () => true, { display: "1", format: "h264" });
  await hub.add(guest, () => true, { display: "1", format: "h264" }, { privateView: true });
  await until(() => binary(owner).length > 0 && binary(guest).length > 0);
  assert.equal(hub.groups.size, 2);
  assert.deepEqual(prepared, [false, true]);
  // The ready message is the same for both: the setting stays server-side.
  const ready = (ws) => json(ws).find((m) => m.type === "ready");
  assert.deepEqual(ready(guest), ready(owner));
  hub.remove(owner);
  hub.remove(guest);
  // What the Mac helper is told to leave out: the agents' lists, which its
  // decoder reads as four lists of words.
  const rules = JSON.parse(privateWindows());
  assert.deepEqual(Object.keys(rules).sort(), ["ids", "names", "titles", "words"]);
  for (const list of Object.values(rules))
    assert.ok(list.length && list.every((w) => typeof w === "string" && w === w.toLowerCase()));
  assert.ok(rules.ids.includes("com.1password"));
  assert.ok(rules.words.includes("reach"));
});

test(
  "the Mac helper refuses to stream unfiltered when it can't read what to hide",
  { skip: !process.env.REACH_TEST_VIDEO_HELPER, timeout: 20000 },
  async () => {
    // Exits before any capture starts: no screen is read.
    const source = new NativeScreenSource(process.env.REACH_TEST_VIDEO_HELPER, [
      "1", "h264", "30", "640", "1000000", "auto", "", "{not json",
    ]);
    const error = await source.next().catch((e) => e);
    assert.match(error.message, /Invalid privacy rules/);
  },
);

test("the first protocol's shared Mac picture leaves out private windows for everyone on it", async () => {
  // No phone of the owner's speaks it any more; a guest still could.
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../server/screen-stream.mjs", import.meta.url), "utf8");
  const create = source.slice(source.indexOf("export async function createScreenSource"));
  assert.match(
    create.slice(0, create.indexOf("powershell")),
    /new NativeScreenSource\(binary, \[\s*"primary",\s*"jpeg",\s*"15",\s*"1600",\s*"6000000",\s*"auto",\s*"",\s*privateWindows\(\),\s*\]\)/,
  );
});
