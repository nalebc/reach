import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The phone's stream keeps smooth H.264 video. A server asking it to
// reconnect (a restart, an app's window being refit) must never switch it to
// still images: that once left phones on 20 fps JPEG after every Reach
// restart. Only this phone's decoder failing three times in a minute does,
// and the computer is told why.
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
  decode() {}
  reset() {
    this.state = "unconfigured";
  }
  close() {
    this.state = "closed";
  }
}
const keyframe = { key: true, timestamp: 0, width: 1320, height: 2868, codec: "avc1.64002a" };

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

test("only repeated decoder failures switch to still images, and the computer hears why", async () => {
  const { view, state } = await watch();
  for (let round = 0; round < 3; round++) {
    const socket = FakeSocket.all[round];
    await dom.waitFor(() => socket.sent.length, 5000);
    assert.equal(auth(round).format, "h264", `attempt ${round + 1} is H.264`);
    socket.says({ type: "ready", format: "h264", display: "1" });
    socket.frame(round + 1, keyframe);
    FakeDecoder.all.at(-1).init.error(new Error("decode failed"));
    const told = socket.sent.find((m) => m.type === "diagnostic");
    assert.match(told.text, round < 2 ? /decoder reset: Video decoder: decode failed/ : /switching to still images/);
    if (round < 2) await dom.waitFor(() => FakeSocket.all[round + 1], 5000);
  }
  await dom.waitFor(() => FakeSocket.all[3]?.sent.length, 3000);
  assert.equal(state().fallback, true);
  assert.equal(auth(3).format, "jpeg");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
