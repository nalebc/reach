import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
import { adpcmEncoder, encodeAdpcm, INDEX, QUIET, STEPS } from "../server/screen-sound.mjs";

// The speaker in Screen's bar (Oct 13, "Build the sound"): one tap to hear
// the computer on the phone, one to stop. Its audio context is made inside
// the tap (browsers start sound only during one), it plays with the ringer
// switch on silent where the phone allows it, and it shows only where the
// computer offers sound. A stand-in audio context, worklet and socket: no
// sound is played here.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const device = (capabilities = {}, extra = {}) => ({
  id: "mac", name: "Mac", platform: "darwin", arch: "arm64", release: "25.0", roots: [],
  memory: { total: 1, free: 1 }, uptime: 1, network: { connected: true, peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false, sound: true, ...capabilities },
  ...extra,
});
class FakeSocket {
  static OPEN = 1;
  static all = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    FakeSocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.(), 0);
  }
  receive(data) {
    this.onmessage?.({ data: typeof data === "string" ? data : data });
  }
}
let clicking = false;
class FakeContext {
  static all = [];
  constructor(options) {
    this.options = options;
    this.madeInTap = clicking;
    this.state = "suspended";
    // A phone whose speaker runs at 44.1 kHz: the 48 kHz sound is resampled.
    this.sampleRate = 44100;
    this.destination = { kind: "speaker" };
    this.modules = [];
    this.audioWorklet = { addModule: async (url) => void this.modules.push(url) };
    this.resumes = 0;
    FakeContext.all.push(this);
  }
  resume() {
    this.resumes++;
    if (this.state !== "closed") this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    if (this.state !== "closed") this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}
class FakeNode {
  static all = [];
  constructor(context, name, options) {
    Object.assign(this, { context, name, options, connected: null });
    this.port = { messages: [], postMessage: (m) => this.port.messages.push(m), close() {} };
    FakeNode.all.push(this);
  }
  connect(to) {
    this.connected = to;
  }
  disconnect() {
    this.connected = null;
  }
}
let dom, React, Screen, codec;
const saved = {};
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": (init) => ({ enabled: JSON.parse(init.body).enabled }),
      "/api/screen/displays": () => ({ displays: [{ id: "primary", name: "Built-in", primary: true, width: 1470, height: 956, x: 0, y: 0 }] }),
    },
  });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };
  for (const [name, value] of [["WebSocket", FakeSocket], ["AudioContext", FakeContext], ["AudioWorkletNode", FakeNode]]) {
    saved[name] = globalThis[name];
    globalThis[name] = value;
    dom.window[name] = value;
  }
  Object.defineProperty(dom.window.navigator, "audioSession", { value: { type: "auto" }, configurable: true });
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  codec = await dom.load("/src/sound-codec.ts");
});
after(async () => {
  for (const [name, value] of Object.entries(saved)) globalThis[name] = value;
  await dom?.close();
});
beforeEach(() => {
  FakeSocket.all = [];
  FakeContext.all = [];
  FakeNode.all = [];
});
const $ = (s) => dom.document.querySelector(s);
const names = (root) => [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim());
const bar = () => dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
const soundSocket = () => FakeSocket.all.find((s) => s.url.endsWith("/ws/screen-sound") && s.readyState !== 3);
const packet = (sequence, flags = 0) => {
  const samples = new Int16Array(960 * 2).map((_, i) => Math.round(8000 * Math.sin(i / 7)));
  const data = encodeAdpcm(adpcmEncoder(2), samples, 48000, sequence);
  data[3] = flags;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
};

test("one tap hears the computer, inside the tap; a second stops it", async (t) => {
  const toasts = [];
  const view = await dom.render(React.createElement(Screen, { peer, device: device(), toast: (t) => toasts.push(t), onChanged: () => {} }));
  const controls = await bar();
  assert.deepEqual(names(controls), ["Control", "Sound", "Enter fullscreen", "Screen options"]);
  const speaker = controls.querySelector('[aria-label="Sound"]');
  assert.equal(speaker.getAttribute("aria-pressed"), "false");
  assert.equal(speaker.textContent.trim(), "", "an icon, no words");
  clicking = true;
  speaker.click();
  clicking = false;
  // Made and resumed during the tap itself, before anything awaited.
  assert.equal(FakeContext.all.length, 1);
  assert.deepEqual([FakeContext.all[0].madeInTap, FakeContext.all[0].resumes > 0], [true, true]);
  assert.equal(FakeContext.all[0].options.latencyHint, "interactive");
  assert.equal(dom.window.navigator.audioSession.type, "playback", "plays with the ringer switch on silent");
  const ws = await dom.waitFor(soundSocket);
  assert.equal(ws.url, "wss://reach.test/ws/screen-sound");
  await dom.waitFor(() => ws.sent.length);
  assert.deepEqual(ws.sent[0], { type: "auth", token: "t", codecs: ["adpcm"] });
  assert.equal(speaker.getAttribute("aria-busy"), "true", "on its way");
  ws.receive(JSON.stringify({ type: "ready", codec: "adpcm" }));
  await dom.waitFor(() => speaker.getAttribute("aria-pressed") === "true" && !speaker.hasAttribute("aria-busy"));
  // A packet plays through the worklet, at the phone's own rate, stereo.
  const node = FakeNode.all[0];
  assert.deepEqual([node.name, node.options.outputChannelCount, node.connected?.kind], ["reach-sound", [2], "speaker"]);
  assert.ok(FakeContext.all[0].modules[0].includes("sound-worklet"), FakeContext.all[0].modules[0]);
  ws.receive(packet(7));
  const played = node.port.messages.find((m) => m.type === "samples");
  assert.ok(Math.abs(played.samples.length / 2 - 882) <= 2, `${played.samples.length / 2} frames at 44.1 kHz`);
  assert.deepEqual(ws.sent.at(-1), { type: "ack", seq: 7 });
  // A silent computer's packet is a sign of life, not sound.
  ws.receive(packet(8, QUIET));
  assert.deepEqual(node.port.messages.at(-1), { type: "quiet" });
  speaker.click();
  await dom.waitFor(() => speaker.getAttribute("aria-pressed") === "false");
  await dom.waitFor(() => ws.readyState === 3 && FakeContext.all[0].state === "suspended");
  assert.equal(soundSocket(), undefined);
  assert.deepEqual(toasts, []);
  await view.unmount();
  assert.equal(FakeContext.all[0].state, "closed", "leaving Screen lets the phone's audio go");
});

test("a refusal says why once and turns the speaker off; a blip after it played just reconnects", async (t) => {
  const toasts = [];
  const view = await dom.render(React.createElement(Screen, { peer, device: device(), toast: (t) => toasts.push(t), onChanged: () => {} }));
  t.after(() => view.unmount());
  const speaker = (await bar()).querySelector('[aria-label="Sound"]');
  speaker.click();
  let ws = await dom.waitFor(soundSocket);
  ws.receive(JSON.stringify({ type: "ready", codec: "adpcm" }));
  await dom.waitFor(() => speaker.getAttribute("aria-pressed") === "true");
  // The link drops: the next connection comes by itself, nothing said.
  ws.close();
  ws = await dom.waitFor(() => soundSocket() !== ws && soundSocket());
  ws.receive(JSON.stringify({ type: "ready", codec: "adpcm" }));
  assert.deepEqual(toasts, []);
  // Refused: said once, speaker off, no retry.
  ws.receive(JSON.stringify({ type: "error", error: "Only the owner and people with full access hear this computer.", retryable: false, status: 403 }));
  ws.close();
  await dom.waitFor(() => speaker.getAttribute("aria-pressed") === "false" && toasts.length === 1);
  assert.deepEqual(toasts, ["Only the owner and people with full access hear this computer."]);
  await settle(1200);
  assert.equal(soundSocket(), undefined, "no retry after a refusal");
  // A computer with no sound to give: twice before any sound played is
  // enough to say why instead of trying forever.
  speaker.click();
  for (let i = 0; i < 2; i++) {
    const next = await dom.waitFor(soundSocket);
    next.receive(JSON.stringify({ type: "error", error: "This PC has no sound output for Reach to hear.", retryable: true, status: 503 }));
    next.close();
    await dom.waitFor(() => next.readyState === 3 && soundSocket() !== next);
  }
  await dom.waitFor(() => toasts.length === 2);
  assert.equal(toasts[1], "This PC has no sound output for Reach to hear.");
  assert.equal(speaker.getAttribute("aria-pressed"), "false");
  // Turned away at the door without a word (the host guard does that), three
  // times before any sound: said, and the speaker goes off.
  speaker.click();
  for (let i = 0; i < 3; i++) {
    const next = await dom.waitFor(soundSocket);
    next.close();
    await dom.waitFor(() => next.readyState === 3 && soundSocket() !== next);
  }
  await dom.waitFor(() => toasts.length === 3);
  assert.equal(toasts[2], "The computer's sound didn't connect. Tap the speaker to try again.");
  assert.equal(speaker.getAttribute("aria-pressed"), "false");
});

test("no speaker where the computer offers no sound, or on the computer itself", async () => {
  for (const [why, d] of [
    ["a server without sound (not restarted yet), or a person with less access", device({ sound: false })],
    ["a browser on the computer itself", device({}, { sameComputer: true })],
  ]) {
    const view = await dom.render(React.createElement(Screen, { peer, device: d, toast: () => {}, onChanged: () => {} }));
    try {
      // On the computer itself the screen waits behind "Show anyway"; shown
      // anyway, it still has no speaker.
      if (d.sameComputer) (await dom.waitFor(() => [...dom.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Show anyway"))).click();
      const controls = await bar();
      assert.ok(!names(controls).includes("Sound"), why);
    } finally {
      await view.unmount();
    }
  }
});

// IMA ADPCM as the standard decodes it, sample by sample.
function reference(packet) {
  const channels = packet[2];
  const predictor = [], index = [];
  for (let c = 0; c < channels; c++) {
    predictor[c] = packet.readInt16LE(16 + 4 * c);
    index[c] = packet[18 + 4 * c];
  }
  const out = [];
  const start = 16 + 4 * channels;
  for (let i = 0; i < packet.readUInt16LE(12) * channels; i++) {
    const c = i % channels;
    const nibble = i & 1 ? packet[start + (i >> 1)] >> 4 : packet[start + (i >> 1)] & 15;
    const step = STEPS[index[c]];
    let delta = step >> 3;
    if (nibble & 4) delta += step;
    if (nibble & 2) delta += step >> 1;
    if (nibble & 1) delta += step >> 2;
    predictor[c] = Math.max(-32768, Math.min(32767, predictor[c] + (nibble & 8 ? -delta : delta)));
    index[c] = Math.max(0, Math.min(88, index[c] + INDEX[nibble & 7]));
    out.push(predictor[c]);
  }
  return out;
}

test("the phone decodes exactly what the computer encoded, and joins packets without a jump", () => {
  const encoder = adpcmEncoder(2);
  for (let p = 1; p <= 3; p++) {
    const samples = new Int16Array(960 * 2).map((_, i) => Math.round(12000 * Math.sin((p * 960 + (i >> 1)) / 9 + (i & 1))));
    const data = encodeAdpcm(encoder, samples, 48000, p);
    const decoded = codec.decodeSoundPacket(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    assert.deepEqual([decoded.rate, decoded.channels, decoded.sequence, decoded.quiet, decoded.samples.length], [48000, 2, p, false, 1920]);
    assert.deepEqual([...decoded.samples].map((v) => Math.round(v * 32768)), reference(data));
  }
  // Not a packet: nothing played.
  assert.equal(codec.decodeSoundPacket(new ArrayBuffer(8)), null);
  const wrong = new Uint8Array(packet(1));
  wrong[1] = 9;
  assert.equal(codec.decodeSoundPacket(wrong.buffer), null);
  // 24 kHz mono to 48 kHz stereo, packet after packet, never a jump.
  const resampler = new codec.Resampler();
  let last = null, step = 0;
  for (let p = 0; p < 10; p++) {
    const mono = new Float32Array(480).map((_, i) => Math.sin((2 * Math.PI * 440 * (p * 480 + i)) / 24000));
    const out = resampler.push(mono, 1, 24000, 48000);
    for (let i = 0; i < out.length; i += 2) {
      assert.equal(out[i], out[i + 1], "mono in both ears");
      if (last !== null) step = Math.max(step, Math.abs(out[i] - last));
      last = out[i];
    }
  }
  assert.ok(step <= (2 * Math.PI * 440) / 48000 + 1e-6, `largest step ${step}`);
});
