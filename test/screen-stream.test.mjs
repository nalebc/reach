import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { RemoteBroadcast } from "../server/remote-screen.mjs";
import {
  NativeScreenSource,
  ScreenBroadcast,
} from "../server/screen-stream.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail("Timed out waiting for stream state");
}

test("native frame pipe handles split packets and reuses one capture process", async () => {
  const source = new NativeScreenSource(process.execPath, [
    "-e",
    `let n=0;process.stdin.on('data',()=>{const b=Buffer.from('frame-'+(++n));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(h.subarray(0,2));setTimeout(()=>{process.stdout.write(h.subarray(2));process.stdout.write(b);},5);});`,
  ]);
  try {
    assert.equal((await source.next()).toString(), "frame-1");
    assert.equal((await source.next()).toString(), "frame-2");
  } finally {
    source.stop();
  }
  await assert.rejects(source.next(), /stopped/);
});

test("requested keyframes survive dropped pipe replies and normal frames resume on the same helper", { timeout: 10000 }, async () => {
  // Actual length-prefixed helper protocol through an inert Node child. The
  // payload is a synthetic video envelope; this does not exercise an encoder
  // or claim that its placeholder NAL bytes decode as H.264.
  const source = new NativeScreenSource(process.execPath, [
    "-e",
    `const {createInterface}=require('node:readline');let n=0;
     createInterface({input:process.stdin}).on('line',command=>{
       process.stderr.write(JSON.stringify({command,n:++n})+'\\n');
       let packet=Buffer.from([0]);
       if(n>2){
         const json=Buffer.from(JSON.stringify({key:command==='key',timestamp:n*16666,width:16,height:16,codec:'avc1.64002a'}));
         const header=Buffer.alloc(4);header.writeUInt32BE(json.length);
         packet=Buffer.concat([header,json,Buffer.from([0,0,0,1,command==='key'?0x65:0x41,0x80])]);
       }
       const size=Buffer.alloc(4);size.writeUInt32BE(packet.length);
       process.stdout.write(Buffer.concat([size,packet]));
     });`,
  ]);
  const exited = once(source.child, "exit");
  let trace = "", starts = 0;
  source.child.stderr.on("data", (data) => { trace += data.toString(); });
  const frames = [], messages = [];
  const broadcast = new RemoteBroadcast(async () => () => { starts++; return source; }, {
    fps: 60, bitrate: 4000000, quality: "auto",
  });
  const ws = {
    readyState: 1, bufferedAmount: 0,
    send(data) {
      if (!Buffer.isBuffer(data)) { messages.push(JSON.parse(data)); return; }
      frames.push(data);
      broadcast.ack(ws, data.readUInt32BE(0));
      if (frames.length === 2) ws.bufferedAmount = 512 * 1024;
    },
    close() { ws.readyState = 3; },
  };
  try {
    broadcast.add(ws, () => true);
    const deadline = Date.now() + 5000;
    while ((frames.length < 2 || trace.trim().split("\n").length < 4) && Date.now() < deadline) await sleep(10);
    assert.equal(frames.length, 2, "no-frame replies must be consumed, then delivery must continue");
    assert.deepEqual(trace.trim().split("\n").map((line) => JSON.parse(line).command), ["key", "key", "key", "frame"]);
    assert.deepEqual(frames.map((packet) => packet.readUInt32BE(0)), [1, 2], "drops neither reach the viewer nor consume sequence numbers");
    const metadata = frames.map((packet) => {
      const length = packet.readUInt32BE(4);
      assert.ok(length > 0 && 8 + length < packet.length, "valid video envelope with a payload");
      return JSON.parse(packet.subarray(8, 8 + length));
    });
    assert.deepEqual(metadata.map(({ key }) => key), [true, false], "the requested keyframe arrives before normal delta delivery");
    assert.ok(metadata[1].timestamp > metadata[0].timestamp);
    assert.equal(starts, 1, "a drop must not replace the capture process");
    assert.equal(source.failure, null);
    assert.equal(messages.some((message) => message.type === "error"), false);
  } finally {
    broadcast.remove(ws);
    source.stop();
    await exited;
  }
});

test("native frame pipe rejects oversized input before buffering a frame", async () => {
  const source = new NativeScreenSource(process.execPath, [
    "-e",
    `process.stdin.on('data',()=>process.stdout.write(Buffer.from([255,255,255,255])));`,
  ]);
  try {
    await assert.rejects(source.next(), /Invalid screen frame/);
  } finally {
    source.stop();
  }
});

test("disconnect while preparing the helper never starts screen capture", async () => {
  let finish;
  let starts = 0;
  const prepare = new Promise((r) => (finish = r));
  const broadcast = new ScreenBroadcast(() => prepare);
  const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  broadcast.add(ws, () => true);
  broadcast.remove(ws);
  finish(() => {
    starts++;
    return { next: async () => Buffer.from("fixture"), stop() {} };
  });
  await sleep(20);
  assert.equal(starts, 0);
});

test(
  "screen stream enforces auth, scope, enablement, backpressure, revocation and shutdown",
  { timeout: 15000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-live-test-"));
    let starts = 0,
      stops = 0,
      captures = 0;
    const reach = await createReach({
      roots: [root],
      dataDir: path.join(root, ".reach"),
      port: 0,
      screenStreamFactory: async () => () => {
        starts++;
        return {
          next: async () => Buffer.from(`synthetic-${++captures}`),
          stop: () => {
            stops++;
          },
        };
      },
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("owner", ALL_SCOPES);
    const other = reach.auth.issue("other", ALL_SCOPES);
    const files = reach.auth.issue("files", ["files"], "agent");
    const viewer = reach.auth.issue("screen viewer", ["screen"], "agent");
    const sockets = [];
    const connect = async (token) => {
      const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/screen");
      sockets.push(ws);
      const frames = [],
        messages = [];
      ws.on("message", (b, binary) => {
        if (binary) frames.push(b);
        else messages.push(JSON.parse(b));
      });
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token }));
      return { ws, frames, messages };
    };
    const settings = async (screen) => {
      const res = await fetch(url + "/api/settings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ screen }),
      });
      assert.equal(res.status, 200);
    };
    try {
      // The first phone in turned viewing on: off again, as its owner can.
      await settings(false);
      await t.test("denied viewers never start a native capture", async () => {
        for (const token of ["invalid", files.token, owner.token]) {
          const s = await connect(token);
          await until(() => s.messages.some((m) => m.type === "error"));
          assert.equal(s.frames.length, 0);
        }
        assert.equal(starts, 0);
      });
      await t.test(
        "host, origin and Funnel protections apply to the stream",
        async () => {
          for (const headers of [
            { Origin: "https://hostile.invalid" },
            { "Tailscale-Funnel-Request": "1" },
            { Host: "hostile.invalid" },
          ]) {
            const ws = new WebSocket(
              url.replace("http:", "ws:") + "/ws/screen",
              { headers },
            );
            sockets.push(ws);
            await new Promise((resolve) => ws.once("error", resolve));
            assert.notEqual(ws.readyState, WebSocket.OPEN);
          }
          assert.equal(starts, 0);
        },
      );
      await settings(true);
      const a = await connect(owner.token);
      await until(() => a.frames.length === 1);
      const b = await connect(viewer.token);
      await until(() => b.frames.length === 1);
      await t.test(
        "viewers share capture and slow phones do not accumulate frames",
        async () => {
          assert.equal(starts, 1);
          await sleep(160);
          assert.equal(a.frames.length, 1);
          assert.equal(b.frames.length, 1);
          a.ws.send(JSON.stringify({ type: "ack" }));
          await until(() => a.frames.length === 2);
          assert.equal(b.frames.length, 1);
          assert.equal(a.messages[0].fps, 15);
        },
      );
      await t.test(
        "turning viewing off closes all viewers and stops the helper",
        async () => {
          await settings(false);
          await until(
            () =>
              a.ws.readyState === WebSocket.CLOSED &&
              b.ws.readyState === WebSocket.CLOSED,
          );
          assert.equal(stops, 1);
        },
      );
      await settings(true);
      const c = await connect(other.token);
      await until(() => c.frames.length === 1);
      await t.test("revoking access ends the stream and capture", async () => {
        const res = await fetch(url + "/api/clients/" + other.clientId, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${owner.token}` },
        });
        assert.equal(res.status, 200);
        await until(() => c.ws.readyState === WebSocket.CLOSED);
        assert.equal(stops, 2);
      });
      const d = await connect(owner.token);
      await until(() => d.frames.length === 1);
      await t.test(
        "disconnecting the last phone releases native capture",
        async () => {
          d.ws.close();
          await until(() => stops === 3);
        },
      );
    } finally {
      for (const ws of sockets) ws.terminate();
      await reach.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("revoking access during capture discards the in-flight frame", async () => {
  let complete;
  let allowed = true;
  let stopped = 0;
  const sent = [];
  const source = {
    next: () => new Promise((r) => (complete = r)),
    stop: () => stopped++,
  };
  const broadcast = new ScreenBroadcast(async () => () => source);
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (b) => sent.push(b),
    close() {},
  };
  broadcast.add(ws, () => allowed);
  await until(() => !!complete);
  allowed = false;
  complete(Buffer.from("must not leave the host"));
  await until(() => stopped === 1);
  assert.equal(sent.length, 0);
});

// Long-term references need a sender that acknowledges the receiver's LTR
// frames; Reach never does. Low-latency rate control turns them on unless
// told not to (measured Oct 18: EnableLTR read 1, every few frames asked for
// an acknowledgement), so the encoder must say false itself.
test("the Mac H.264 encoder turns long-term references off and keeps its reference count", async () => {
  const swift = await fs.readFile(new URL("../scripts/native/screen-stream.swift", import.meta.url), "utf8");
  const configure = swift.slice(swift.indexOf("func configureEncoder()"), swift.indexOf("func adjust("));
  assert.match(configure, /kVTCompressionPropertyKey_EnableLTR: false,/);
  assert.match(configure, /kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true/);
  assert.doesNotMatch(swift, /ReferenceBufferCount/);
});

// The production configureEncoder() on this Mac's hardware encoder, fed
// generated pixels: no screen is captured and nothing is posted.
test("the Mac encoder session reads EnableLTR false and its frames ask for no LTR acknowledgement", {
  skip: process.platform !== "darwin", timeout: 120000,
}, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "reach-encoder-ltr-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const swift = await fs.readFile(new URL("../scripts/native/screen-stream.swift", import.meta.url), "utf8");
  const hook = "  func compressed(_ sample: CMSampleBuffer) {\n";
  assert.ok(swift.includes(hook));
  const capture = swift.split("@main struct ReachScreenStream")[0]
    .replace(hook, hook + "    inspect(sample); return\n");
  const file = path.join(folder, "main.swift"), binary = path.join(folder, "encoder");
  await fs.writeFile(file, capture + String.raw`
var samples = 0, acknowledgements = 0
func inspect(_ sample: CMSampleBuffer) {
  samples += 1
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
  if attachments?.first?[kVTSampleAttachmentKey_RequireLTRAcknowledgementToken] != nil { acknowledgements += 1 }
}
@main struct EncoderCheck {
  static func main() {
    guard #available(macOS 12.3, *) else { print("macOS too old"); return }
    for (width, height) in [(640, 360), (1440, 900), (1920, 1200)] {
      let capture = Capture(["primary", "h264", "30", String(width), "8000000", "hardware"])
      capture.width = width
      capture.height = height
      do { try capture.configureEncoder() } catch { print("encoder unavailable: \(error)"); return }
      // An encoder without long-term references (a virtual Mac's) can't
      // say: its frames below still must not ask for acknowledgements.
      var value: CFTypeRef?
      let read = VTSessionCopyProperty(capture.encoder!, key: kVTCompressionPropertyKey_EnableLTR,
        allocator: nil, valueOut: &value)
      if read != kVTPropertyNotSupportedErr {
        precondition(read == noErr, "EnableLTR unreadable (\(read))")
        precondition((value as? Bool) == false, "EnableLTR reads \(String(describing: value))")
      }
      var made: CVPixelBuffer?
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &made)
      let buffer = made!
      samples = 0; acknowledgements = 0
      for frame in 0..<24 {
        CVPixelBufferLockBaseAddress(buffer, [])
        let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        for y in 0..<height { memset(luma + y * stride, Int32((y / 8 + frame * 7) % 200), width) }
        memset(CVPixelBufferGetBaseAddressOfPlane(buffer, 1), 128,
          CVPixelBufferGetBytesPerRowOfPlane(buffer, 1) * CVPixelBufferGetHeightOfPlane(buffer, 1))
        CVPixelBufferUnlockBaseAddress(buffer, [])
        let properties = frame == 0 ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(capture.encoder!, imageBuffer: buffer,
          presentationTimeStamp: CMTime(value: Int64(frame), timescale: 30),
          duration: CMTime(value: 1, timescale: 30), frameProperties: properties,
          sourceFrameRefcon: nil, infoFlagsOut: nil)
        VTCompressionSessionCompleteFrames(capture.encoder!, untilPresentationTimeStamp: .invalid)
      }
      capture.queue.sync {}
      precondition(samples >= 12, "\(width)x\(height): only \(samples) frames came out")
      precondition(acknowledgements == 0, "\(width)x\(height): \(acknowledgements) frames asked for an LTR acknowledgement")
      VTCompressionSessionInvalidate(capture.encoder!)
      print("\(width)x\(height): \(samples) frames, EnableLTR \(read == noErr ? "false" : "unsupported"), no LTR acknowledgements")
    }
    print("encoder LTR checks passed")
  }
}
`);
  const built = spawnSync("xcrun", ["swiftc", "-parse-as-library", "-module-cache-path", path.join(folder, "cache"), file, "-o", binary], { encoding: "utf8", timeout: 90000 });
  assert.equal(built.status, 0, built.stderr);
  const checked = spawnSync(binary, [], { encoding: "utf8", timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  // A virtual Mac (GitHub's Intel runners) has no hardware H.264 encoder.
  if (/encoder unavailable/.test(checked.stdout)) {
    const vm = (() => { try { return execFileSync("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8" }).trim() === "1"; } catch { return false; } })();
    if (vm) return t.skip(`virtual Mac without a hardware encoder: ${checked.stdout.trim()}`);
  }
  assert.match(checked.stdout, /encoder LTR checks passed/, checked.stdout);
});
