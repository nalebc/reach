import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The phone's stream keeps smooth H.264 video. A server asking it to
// reconnect (a restart, an app's window being refit) must never switch it to
// still images: that once left phones on 20 fps JPEG after every Reach
// restart. Only this phone's decoder failing before a single frame, three
// times in a minute, does, and the computer is told why. A decoder that fails
// is replaced on the same connection: reconnecting took a second or two, and
// Reach's log said only "Decoder failure".
class FakeSocket {
  static OPEN = 1;
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1000, reason: "" }), 0);
  }
  says(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  frame(id, meta) {
    const json = Buffer.from(JSON.stringify(meta));
    const packet = Buffer.alloc(8 + json.length + 4);
    packet.writeUInt32BE(id, 0);
    packet.writeUInt32BE(json.length, 4);
    json.copy(packet, 8);
    this.onmessage?.({ data: packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.length) });
  }
}
class FakeDecoder {
  static all = [];
  constructor(init) {
    this.init = init;
    this.state = "unconfigured";
    this.decodeQueueSize = 0;
    FakeDecoder.all.push(this);
  }
  configure(config) {
    this.config = config;
    this.state = "configured";
  }
  decode(chunk) {
    if (this.state !== "configured") throw new Error("VideoDecoder is not configured");
    (this.chunks ??= []).push(chunk);
  }
  reset() {
    this.state = "unconfigured";
  }
  // Safari closes a decoder before telling the page it failed.
  fails(message = "Decoder failure") {
    this.state = "closed";
    this.init.error(new Error(message));
  }
  shows() {
    this.init.output({ displayWidth: 1320, displayHeight: 2868, close() {} });
  }
  close() {
    this.state = "closed";
  }
}
const keyframe = { key: true, timestamp: 0, width: 1320, height: 2868, codec: "avc1.64002a" };
const delta = { ...keyframe, key: false };

let dom, React, useRemoteScreen, saved;
before(async () => {
  dom = await startDom({ mobile: true });
  saved = { WebSocket: globalThis.WebSocket };
  globalThis.WebSocket = FakeSocket;
  globalThis.VideoDecoder = dom.window.VideoDecoder = FakeDecoder;
  globalThis.EncodedVideoChunk = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  Object.defineProperty(dom.window.screen, "width", { value: 440, configurable: true });
  Object.defineProperty(dom.window.screen, "height", { value: 956, configurable: true });
  Object.defineProperty(dom.window, "devicePixelRatio", { value: 3, configurable: true });
  React = dom.React;
  ({ useRemoteScreen } = await dom.load("/src/useRemoteScreen.ts"));
});
after(async () => {
  globalThis.WebSocket = saved.WebSocket;
  delete globalThis.VideoDecoder;
  delete globalThis.EncodedVideoChunk;
  await dom?.close();
});

async function watch() {
  FakeSocket.all.length = 0;
  FakeDecoder.all.length = 0;
  let stream;
  function Host() {
    stream = useRemoteScreen(
      { url: "https://reach.test", token: "t" },
      true,
      true,
      "primary",
      "auto",
      0,
      false,
    );
    return React.createElement("canvas", { ref: stream.canvas });
  }
  const view = await dom.render(React.createElement(Host));
  await dom.waitFor(() => FakeSocket.all[0]?.sent.length);
  return { view, state: () => stream };
}
const auth = (i) => FakeSocket.all[i].sent.find((m) => m.type === "auth");

test("the stream asks for this phone's full resolution, on H.264", async () => {
  const { view } = await watch();
  assert.deepEqual(
    { format: auth(0).format, maxWidth: auth(0).maxWidth },
    { format: "h264", maxWidth: 2868 },
  );
  await view.unmount();
});

test("a server asking to reconnect keeps H.264, never still images", async () => {
  const { view, state } = await watch();
  FakeSocket.all[0].says({ type: "ready", format: "h264", display: "1" });
  FakeSocket.all[0].says({ type: "error", error: "Reach is shutting down.", retryable: true });
  await dom.waitFor(() => FakeSocket.all[1]?.sent.length, 3000);
  assert.equal(auth(1).format, "h264");
  assert.equal(state().fallback, false);
  await view.unmount();
});

test("a failed decoder is replaced on the same connection, from the next keyframe", async () => {
  const { view, state } = await watch();
  const socket = FakeSocket.all[0];
  socket.says({ type: "ready", format: "h264", display: "1" });
  socket.frame(1, keyframe);
  const first = FakeDecoder.all[0];
  first.shows();
  socket.frame(2, delta);
  first.fails();
  const told = socket.sent.find((m) => m.type === "diagnostic");
  assert.match(told.text, /decoder restarted \(1 this minute\): Video decoder: Decoder failure/);
  assert.match(told.text, /screen 1320×2868 avc1\.64002a · after 1 frames · on a delta/, "the log says what failed");
  socket.frame(3, delta);
  assert.equal(FakeDecoder.all.length, 2, "a new decoder");
  assert.deepEqual(socket.sent.at(-1), { type: "ack", id: 3, keyframe: true }, "asks for a keyframe");
  socket.frame(4, keyframe);
  assert.equal(FakeDecoder.all[1].chunks.length, 1, "decodes from the keyframe");
  // Safari's late word about the old decoder doesn't touch the new one.
  first.init.error(new Error("Decoder failure"));
  socket.frame(5, delta);
  assert.equal(FakeDecoder.all.length, 2);
  assert.equal(FakeDecoder.all[1].chunks.length, 2);
  await settle(50);
  assert.equal(FakeSocket.all.length, 1, "no reconnect");
  assert.equal(socket.readyState, 1);
  assert.equal(state().fallback, false);
  await view.unmount();
});

test("a decode into a decoder Safari already closed restarts it the same way", async () => {
  const { view } = await watch();
  const socket = FakeSocket.all[0];
  socket.says({ type: "ready", format: "h264", display: "1" });
  socket.frame(1, keyframe);
  FakeDecoder.all[0].shows();
  FakeDecoder.all[0].state = "closed"; // its error event is still on the way
  socket.frame(2, delta);
  socket.frame(3, delta);
  assert.equal(FakeDecoder.all.length, 2);
  assert.match(socket.sent.find((m) => m.type === "diagnostic").text, /decoder restarted .*after 1 frames/);
  assert.deepEqual(socket.sent.at(-1), { type: "ack", id: 3, keyframe: true });
  await settle(50);
  assert.equal(FakeSocket.all.length, 1, "no reconnect");
  await view.unmount();
});

test("a decoder still starting up is not reset for its queue, nor the stream stepped down", async () => {
  const { view } = await watch();
  const socket = FakeSocket.all[0];
  socket.says({ type: "ready", format: "h264", display: "1" });
  socket.frame(1, keyframe);
  const starting = FakeDecoder.all[0];
  for (let id = 2; id < 20; id++) {
    starting.decodeQueueSize = id; // Safari holds chunks until its decoder exists
    socket.frame(id, delta);
  }
  assert.equal(starting.state, "configured", "never reset");
  assert.equal(starting.chunks.length, 19, "every chunk kept");
  assert.equal(socket.sent.filter((m) => m.type === "diagnostic").length, 0);
  // Once it shows frames, a growing queue is a phone falling behind again.
  starting.shows();
  starting.decodeQueueSize = 5;
  socket.frame(20, delta);
  assert.equal(starting.state, "unconfigured");
  await view.unmount();
  assert.equal(auth(0).maxWidth, 2868);
});

test("a decoder failing before its first frame gets the phone a moment before the next", async () => {
  const { view, state } = await watch();
  const socket = FakeSocket.all[0];
  socket.says({ type: "ready", format: "h264", display: "1" });
  socket.frame(1, keyframe);
  FakeDecoder.all[0].fails();
  socket.frame(2, delta);
  socket.frame(3, keyframe);
  assert.equal(FakeDecoder.all.length, 1, "no new decoder straight away");
  assert.deepEqual(socket.sent.at(-1), { type: "ack", id: 3, keyframe: false }, "the stream carries on");
  await settle(1100);
  socket.frame(4, delta);
  assert.equal(FakeDecoder.all.length, 2, "then a new one");
  assert.deepEqual(socket.sent.at(-1), { type: "ack", id: 4, keyframe: true });
  assert.equal(state().fallback, false);
  assert.equal(FakeSocket.all.length, 1);
  await view.unmount();
});

test("only decoders failing before their first frame switch to still images, and the computer hears why", async () => {
  const { view, state } = await watch();
  const socket = FakeSocket.all[0];
  socket.says({ type: "ready", format: "h264", display: "1" });
  let id = 1;
  for (let round = 0; round < 3; round++) {
    if (round) await settle(round === 1 ? 1100 : 2100);
    socket.frame(id++, delta); // a new decoder asks for a keyframe
    socket.frame(id++, keyframe);
    FakeDecoder.all.at(-1).fails();
    const told = socket.sent.filter((m) => m.type === "diagnostic").at(-1);
    assert.match(
      told.text,
      round < 2 ? /decoder restarted .*before its first frame/ : /switching to still images: Video decoder: Decoder failure/,
    );
  }
  assert.equal(FakeDecoder.all.length, 3);
  await dom.waitFor(() => FakeSocket.all[1]?.sent.length, 3000);
  assert.equal(state().fallback, true);
  assert.equal(auth(1).format, "jpeg");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("decoders that fail mid-stream keep the video", async () => {
  const { view, state } = await watch();
  const socket = FakeSocket.all[0];
  socket.says({ type: "ready", format: "h264", display: "1" });
  for (let id = 1; id <= 9; id++) {
    socket.frame(id, keyframe);
    FakeDecoder.all.at(-1).shows();
    FakeDecoder.all.at(-1).fails();
  }
  assert.equal(FakeDecoder.all.length, 9, "each failure gets a new decoder");
  await settle(50);
  assert.equal(FakeSocket.all.length, 1);
  assert.equal(FakeSocket.all[0].readyState, 1, "the connection stays open");
  assert.equal(state().fallback, false);
  await view.unmount();
});
