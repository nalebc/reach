import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  forgetWindowsVideo,
  windowsNativeSource,
  windowsNativeVideo,
  windowsNativeVideoFailed,
  windowsVideoChoice,
} from "../server/windows-video.mjs";
import { RemoteScreenHub, videoFor } from "../server/remote-screen.mjs";
import { NativeScreenSource } from "../server/screen-stream.mjs";

// Windows' live screen chooses its video once and says which and why
// (docs/parity/AUDIT.md #26): H.264 from Windows itself
// (scripts/native/screen-video.cs), else FFmpeg's, else still images. Here
// with stand-ins for the build, the helper and the PC: no Windows, no screen.
// The real helper on a real PC: test/windows-screen-video-native.test.mjs.
const helperFile = "C:\\Reach\\reach-screen-video-abcdef012345.exe";
const found = { stdout: '{"encoder":"H264 Encoder MFT","hardware":false,"capture":"duplication","tried":[],"ms":180}\n' };
const noEncoder = Object.assign(Error("Command failed"), {
  code: 3,
  stderr: "note: Desktop Duplication isn't available for this display (0x887A0004); GDI captures it instead.\r\nThis N edition of Windows has no H.264 video encoder: it comes with the Media Feature Pack (Settings, Apps, Optional features).\r\n",
});

test("Windows' own H.264 is asked of its helper once and kept; not found, asked again a few minutes later", async () => {
  forgetWindowsVideo();
  let clock = 1_000_000,
    builds = 0,
    asked = [],
    works = false;
  const deps = {
    build: async () => (builds++, helperFile),
    run: async (file, args, options) => {
      asked.push({ file, args, options });
      if (!works) throw noEncoder;
      return found;
    },
    now: () => clock,
  };
  const missing = await windowsNativeVideo({ dataDir: "C:\\Reach" }, deps);
  assert.equal(missing.ok, false);
  assert.equal(missing.why, "This N edition of Windows has no H.264 video encoder: it comes with the Media Feature Pack (Settings, Apps, Optional features).", "the helper's own words, never its notes");
  assert.deepEqual(asked[0].args, ["--probe"]);
  assert.equal(asked[0].file, helperFile);
  assert.equal(asked[0].options.windowsHide, true);
  assert.ok(asked[0].options.timeout >= 10000);
  await windowsNativeVideo({}, deps);
  assert.equal(asked.length, 1, "not asked again at once");
  works = true;
  clock += 6 * 60 * 1000;
  const have = await windowsNativeVideo({}, deps);
  assert.deepEqual(have, { ok: true, file: helperFile, encoder: "H264 Encoder MFT", hardware: false, capture: "duplication" }, "the Media Feature Pack installed meanwhile: found, no restart");
  clock += 60 * 60 * 1000;
  await windowsNativeVideo({}, deps);
  assert.equal(asked.length, 2, "found once, kept");
  // Two viewers at once share one probe.
  forgetWindowsVideo();
  const [a, b] = await Promise.all([windowsNativeVideo({}, deps), windowsNativeVideo({}, deps)]);
  assert.equal(a, b);
  assert.equal(asked.length, 3);
});

test("when the check can't say, the reason is still in words: refused, too slow, not built, unreadable", async () => {
  const why = async (deps) => {
    forgetWindowsVideo();
    return (await windowsNativeVideo({}, { build: async () => helperFile, now: () => 1, ...deps })).why;
  };
  assert.match(
    await why({ run: async () => { throw Object.assign(Error("spawn UNKNOWN"), { code: "UNKNOWN", syscall: `spawn ${helperFile}` }); } }),
    /Windows refused to run Reach's video helper: an application control policy \(Smart App Control/,
  );
  assert.match(await why({ run: async () => { throw Object.assign(Error("timed out"), { killed: true, signal: "SIGTERM" }); } }), /didn't finish in time/);
  assert.equal(
    await why({ build: async () => { throw Error("This needs Windows' C# compiler (csc.exe, part of the .NET Framework 4.8 that comes with Windows), and it isn't on this PC."); } }),
    "This needs Windows' C# compiler (csc.exe, part of the .NET Framework 4.8 that comes with Windows), and it isn't on this PC.",
  );
  assert.match(await why({ run: async () => ({ stdout: "not json" }) }), /video check failed/);
  assert.match(await why({ run: async () => ({ stdout: '{"hardware":true}' }) }), /video check failed/);
  // A crash (Oct 14, the runner: an access violation in a COM call) is said
  // as one, never as its .NET stack.
  assert.equal(
    await why({ run: async () => { throw Object.assign(Error("Command failed"), { code: 3221225477, stderr: "\r\nUnhandled Exception: System.AccessViolationException: Attempted to read or write protected memory.\r\n   at IMFAttributes.GetBlob(Guid& key, Byte[] buffer, Int32 size, Int32& written)\r\n   at ReachScreenVideo.Main(String[] args)\r\n" }); } }),
    "Reach's Windows video helper crashed on this PC (0xC0000005).",
  );
  assert.equal(
    await why({ run: async () => { throw Object.assign(Error("Command failed"), { code: 3, stderr: "Windows' H.264 encoder stopped: Attempted to read or write protected memory.\r\n   at Encoder.Configure()\r\n" }); } }),
    "Windows' H.264 encoder stopped: Attempted to read or write protected memory.",
  );
  // Control characters from a helper never reach the log or the phone.
  assert.equal(await why({ run: async () => { throw Object.assign(Error("x"), { stderr: "Bad\u001b[2J news" }); } }), "Bad [2J news");
});

test("the best video wins and is said once in Reach's log: Windows' own, else FFmpeg, else still images, each with why", async () => {
  forgetWindowsVideo();
  const log = [];
  const choose = (own, ffmpeg) => windowsVideoChoice({}, { native: async () => own, ffmpeg: async () => ffmpeg, log: (line) => log.push(line) });
  const hardware = await choose({ ok: true, file: helperFile, encoder: "NVIDIA H.264 Encoder MFT", hardware: true }, true);
  assert.deepEqual(hardware, { source: "windows", file: helperFile, label: "H.264, hardware", why: "", encoder: "NVIDIA H.264 Encoder MFT" }, "Windows' own beats FFmpeg");
  await choose({ ok: true, file: helperFile, encoder: "NVIDIA H.264 Encoder MFT", hardware: true }, true);
  assert.deepEqual(log, ["Reach: live screen: H.264 video from Windows itself (NVIDIA H.264 Encoder MFT, hardware)."], "once, not once per viewer");
  const software = await choose({ ok: true, file: helperFile, encoder: "H264 Encoder MFT", hardware: false }, false);
  assert.equal(software.label, "H.264");
  const n = "This N edition of Windows has no H.264 video encoder: it comes with the Media Feature Pack (Settings, Apps, Optional features).";
  const ffmpeg = await choose({ ok: false, why: n }, true);
  assert.equal(ffmpeg.source, "ffmpeg");
  assert.equal(ffmpeg.label, "H.264 by FFmpeg");
  assert.equal(ffmpeg.why, `${n} FFmpeg makes the video instead.`);
  const still = await choose({ ok: false, why: n }, false);
  assert.equal(still.source, "jpeg");
  assert.equal(still.label, "Still images");
  assert.equal(still.why, `${n} Until then, the screen comes as still images.`);
  assert.deepEqual(log.slice(-3), [
    "Reach: live screen: H.264 video from Windows itself (H264 Encoder MFT).",
    `Reach: live screen: ${n} FFmpeg makes the video instead.`,
    `Reach: live screen: ${n} The screen comes as still images instead.`,
  ]);
});

test("Windows' own helper gets the display, rate, width and bitrate; an encoder that gave out sends the next viewer elsewhere, with why", async () => {
  forgetWindowsVideo();
  const started = [];
  const failed = [];
  const source = windowsNativeSource(helperFile, { display: "DISPLAY2", fps: 60, width: 1920, bitrate: 16000000, format: "h264" }, {
    start: (file, args) => (started.push({ file, args }), { next() {}, stop() {} }),
    failed: (why) => failed.push(why),
  });
  assert.deepEqual(started, [{ file: helperFile, args: ["DISPLAY2", "60", "1920", "16000000"] }]);
  source.onExit(1, Error("This display is unavailable. Select an available display and reconnect."));
  assert.deepEqual(failed, [], "a display gone is not the PC's video gone");
  source.onExit(3, Error("Windows' H.264 encoder stopped: H264 Encoder MFT (output 0x8000FFFF)."));
  assert.deepEqual(failed, ["Windows' H.264 encoder stopped: H264 Encoder MFT (output 0x8000FFFF)."]);
  // A crash, wherever it was: not started again for the next viewer either.
  source.onExit(3221225477, Error("Attempted to read or write protected memory."));
  assert.equal(failed.at(-1), "Reach's Windows video helper crashed (0xC0000005).");
  failed.length = 1;
  // The real failure path: the next choice is FFmpeg or still images, with why.
  windowsNativeVideoFailed("Windows' H.264 encoder stopped: H264 Encoder MFT (output 0x8000FFFF).", { now: () => 5 });
  const next = await windowsNativeVideo({}, { build: async () => assert.fail("not asked again yet"), now: () => 6 });
  assert.deepEqual(next, { ok: false, why: "Windows' H.264 encoder stopped: H264 Encoder MFT (output 0x8000FFFF)." });
  const choice = await windowsVideoChoice({}, { native: () => windowsNativeVideo({}, { now: () => 7 }), ffmpeg: async () => false, log: () => {} });
  assert.equal(choice.source, "jpeg");
  assert.match(choice.why, /^Windows' H\.264 encoder stopped: .* Until then, the screen comes as still images\.$/);
  forgetWindowsVideo();
});

test("which video: a Mac's own H.264, Windows' choice, and still images when the phone asked for them", async () => {
  let asked = 0;
  const choose = async () => (asked++, { source: "windows", file: helperFile, label: "H.264, hardware", why: "" });
  assert.deepEqual(await videoFor("h264", { platform: "darwin", choose }), { format: "h264", source: "mac", label: "H.264", why: "" });
  assert.deepEqual(await videoFor("h264", { platform: "win32", choose }), { source: "windows", file: helperFile, label: "H.264, hardware", why: "", format: "h264" });
  const still = await videoFor("h264", { platform: "win32", choose: async () => ({ source: "jpeg", label: "Still images", why: "No encoder. Until then, the screen comes as still images." }) });
  assert.equal(still.format, "jpeg");
  assert.match(still.why, /No encoder/);
  // Its decoder failed, or compatibility video: still images, and the
  // phone knows why itself; Windows isn't even asked.
  const before = asked;
  assert.deepEqual(await videoFor("jpeg", { platform: "win32", choose }), { format: "jpeg", source: "jpeg", label: "Still images", why: "" });
  assert.deepEqual(await videoFor("jpeg", { platform: "darwin", choose }), { format: "jpeg", source: "jpeg", label: "Still images", why: "" });
  assert.equal(asked, before);
});

const socket = () => {
  const ws = { readyState: 1, bufferedAmount: 0, sent: [], send: (m) => ws.sent.push(m), close() { ws.readyState = 3; } };
  return ws;
};
const ready = (ws) => ws.sent.filter((m) => typeof m === "string").map((m) => JSON.parse(m)).find((m) => m.type === "ready");
const until = async (check) => {
  for (const end = Date.now() + 3000; !check(); ) {
    if (Date.now() > end) throw Error(`Timed out: ${check}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const displays = async () => [{ id: "DISPLAY1", name: "\\\\.\\DISPLAY1", primary: true, width: 2560, height: 1440, x: 0, y: 0 }];

test("on a Windows PC the phone hears which video and why, and the chosen source streams it", async () => {
  const made = [];
  const fake = (kind) => (...args) => (made.push({ kind, args }), { next: async () => Buffer.from([0]), stop() {} });
  const hub = (choice) =>
    new RemoteScreenHub({ dataDir: "C:\\Reach" }, undefined, {
      platform: "win32",
      displays,
      chooseVideo: async () => choice,
      nativeSource: fake("windows"),
      ffmpegSource: fake("ffmpeg"),
      stillSource: fake("still"),
    });
  // Windows' own encoder.
  let ws = socket();
  let h = hub({ source: "windows", file: helperFile, label: "H.264, hardware", why: "", encoder: "NVIDIA H.264 Encoder MFT" });
  await h.add(ws, () => true, { display: "primary", quality: "auto", format: "h264", maxWidth: 1920 });
  assert.deepEqual(
    { format: ready(ws).format, fps: ready(ws).fps, display: ready(ws).display, video: ready(ws).video, why: ready(ws).videoWhy },
    { format: "h264", fps: 60, display: "DISPLAY1", video: "H.264, hardware", why: undefined },
  );
  await until(() => made.length === 1);
  assert.equal(made[0].kind, "windows");
  assert.equal(made[0].args[0], helperFile);
  assert.deepEqual([made[0].args[1].display, made[0].args[1].fps, made[0].args[1].width], ["DISPLAY1", 60, 1920]);
  h.remove(ws);
  // No encoder, no FFmpeg: still images at up to 20 a second, and why.
  ws = socket();
  h = hub({ source: "jpeg", label: "Still images", why: "This Windows Server has no H.264 video encoder. Until then, the screen comes as still images." });
  await h.add(ws, () => true, { display: "primary", quality: "auto", format: "h264" });
  assert.deepEqual(
    { format: ready(ws).format, fps: ready(ws).fps, video: ready(ws).video, why: ready(ws).videoWhy },
    { format: "jpeg", fps: 20, video: "Still images", why: "This Windows Server has no H.264 video encoder. Until then, the screen comes as still images." },
  );
  await until(() => made.length === 2);
  assert.equal(made[1].kind, "still");
  h.remove(ws);
  // FFmpeg.
  ws = socket();
  h = hub({ source: "ffmpeg", label: "H.264 by FFmpeg", why: "No encoder. FFmpeg makes the video instead." });
  await h.add(ws, () => true, { display: "primary", quality: "balanced", format: "h264" });
  assert.equal(ready(ws).format, "h264");
  assert.equal(ready(ws).video, "H.264 by FFmpeg");
  await until(() => made.length === 3);
  assert.equal(made[2].kind, "ffmpeg");
  assert.equal(made[2].args[0].id, "DISPLAY1", "FFmpeg is given the display's bounds");
  h.remove(ws);
});

test("viewers of one display share a stream only from the same source", async () => {
  let choice = { source: "jpeg", label: "Still images", why: "No encoder. Until then, the screen comes as still images." };
  const h = new RemoteScreenHub({}, undefined, {
    platform: "win32",
    displays,
    chooseVideo: async () => choice,
    nativeSource: () => ({ next: async () => Buffer.from([0]), stop() {} }),
    stillSource: () => ({ next: async () => Buffer.from([0]), stop() {} }),
    ffmpegSource: () => ({ next: async () => Buffer.from([0]), stop() {} }),
  });
  const [a, b, c] = [socket(), socket(), socket()];
  await h.add(a, () => true, { display: "primary", quality: "balanced", format: "jpeg" });
  await h.add(b, () => true, { display: "primary", quality: "balanced", format: "jpeg" });
  assert.equal(h.viewers.get(a), h.viewers.get(b));
  // The Media Feature Pack installed meanwhile: a new viewer's video is H.264.
  choice = { source: "windows", file: helperFile, label: "H.264", why: "" };
  await h.add(c, () => true, { display: "primary", quality: "balanced", format: "h264" });
  assert.notEqual(h.viewers.get(c), h.viewers.get(a));
  assert.equal(ready(c).format, "h264");
  for (const ws of [a, b, c]) h.remove(ws);
});

test("a Mac's or a test's ready message names its video too", async () => {
  const h = new RemoteScreenHub({}, async () => () => ({ next: async () => Buffer.from([0]), stop() {} }));
  const ws = socket();
  await h.add(ws, () => true, { display: "1", quality: "balanced", format: "h264" });
  assert.equal(ready(ws).video, "H.264");
  assert.equal(ready(ws).videoWhy, undefined);
  h.remove(ws);
  const still = socket();
  await h.add(still, () => true, { display: "1", quality: "balanced", format: "jpeg" });
  assert.equal(ready(still).video, "Still images");
  h.remove(still);
});

test("a helper's notes go to Reach's log, never into why it stopped; onExit hears only a helper that ended by itself", async () => {
  const notes = [];
  const source = new NativeScreenSource(
    process.execPath,
    ["-e", "process.stderr.write('note: NVIDIA H.264 Encoder MFT stopped (input 0x8000FFFF); H264 Encoder MFT takes over.\\n'); setTimeout(() => { process.stderr.write(\"Windows' H.264 encoder stopped: H264 Encoder MFT (output 0x8000FFFF).\\n\"); process.exit(3); }, 50)"],
    { note: (text) => notes.push(text) },
  );
  const exits = [];
  source.onExit = (code, error) => exits.push([code, error.message]);
  const answer = source.next("key");
  await assert.rejects(answer, /Windows' H\.264 encoder stopped: H264 Encoder MFT \(output 0x8000FFFF\)\./);
  assert.deepEqual(notes, ["NVIDIA H.264 Encoder MFT stopped (input 0x8000FFFF); H264 Encoder MFT takes over."]);
  assert.deepEqual(exits, [[3, "Windows' H.264 encoder stopped: H264 Encoder MFT (output 0x8000FFFF)."]]);
  assert.doesNotMatch(source.failure.message, /note:/);
  // A .NET helper's crash: its message, not its stack.
  const crash = new NativeScreenSource(
    process.execPath,
    ["-e", "process.stderr.write('\\r\\nUnhandled Exception: System.AccessViolationException: Attempted to read or write protected memory.\\r\\n   at IMFAttributes.GetBlob(Guid& key, Byte[] buffer)\\r\\n   at ReachScreenVideo.Main(String[] args)\\r\\n'); process.exit(1)"],
    { note: () => {} },
  );
  await assert.rejects(crash.next("key"), (e) => e.message === "Attempted to read or write protected memory.");
  // Stopped by Reach: not a helper that ended by itself.
  const stopped = new NativeScreenSource(process.execPath, ["-e", "process.stdin.resume()"], { note: () => {} });
  const heard = [];
  stopped.onExit = (code) => heard.push(code);
  const exited = new Promise((r) => stopped.child.once("exit", r));
  stopped.stop();
  await exited;
  assert.deepEqual(heard, []);
});

// The helper's COM interfaces are declared by hand (no SDK on a PC): each
// method's place in its vtable must be the Windows SDK's, or a call lands
// on another method. Counted here from the source, against the SDK headers'
// own order (dxgi.h, dxgi1_2.h, dxgi1_5.h, d3d11.h, mfobjects.h,
// mftransform.h, mfidl.h, strmif.h).
test("screen-video.cs: every COM method it calls sits at its SDK vtable slot, under its SDK IID", () => {
  const source = fs.readFileSync(new URL("../scripts/native/screen-video.cs", import.meta.url), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "");
  const interfaces = {};
  for (const [, guid, name, body] of code.matchAll(/\[ComImport, Guid\("([0-9a-f-]+)"\), InterfaceType\(ComInterfaceType\.InterfaceIsIUnknown\)\]\s*interface (\w+) \{([^}]*)\}/g))
    interfaces[name] = { guid, methods: [...body.matchAll(/(?:void|int)\s+(\w+)\(/g)].map((m) => m[1]) };
  const slot = (iface, method) => {
    const at = interfaces[iface]?.methods.indexOf(method);
    return at === undefined || at < 0 ? null : 3 + at;
  };
  const expected = {
    IDXGIFactory1: ["770aae78-f26f-4dba-a829-253c83d1b387", { EnumAdapters1: 12 }],
    IDXGIAdapter1: ["29038f61-3839-4626-91fd-086879011a05", { EnumOutputs: 7 }],
    IDXGIOutput: ["ae02eedb-c735-4690-8d52-5a8dc20213aa", { GetDesc: 7 }],
    IDXGIOutput1: ["00cddea8-939b-4b83-a340-a685226666cc", { DuplicateOutput: 22 }],
    IDXGIOutput5: ["80a07424-ab52-42eb-833c-0c42fd282d98", { DuplicateOutput1: 26 }],
    IDXGIOutputDuplication: ["191cfac3-a341-470d-b26e-a864f428319c", { GetDesc: 7, AcquireNextFrame: 8, GetFrameDirtyRects: 9, GetFrameMoveRects: 10, GetFramePointerShape: 11, ReleaseFrame: 14 }],
    IDXGIResource: ["035f3ab4-482e-4e50-b41f-8a7f8bd8960b", {}],
    ID3D11Resource: ["dc8e63f3-d12b-4952-b47b-5e45026a862d", {}],
    ID3D11Texture2D: ["6f15aaf2-d208-4e89-9ab4-489535d34f9c", {}],
    ID3D11Device: ["db6f6ddb-ac77-4e88-8253-819df9bbf140", { CreateTexture2D: 5 }],
    ID3D11DeviceContext: ["c0bfa96c-e089-44fb-8eaf-26f8796190da", { Map: 14, Unmap: 15, CopySubresourceRegion: 46, CopyResource: 47 }],
    IMFAttributes: ["2cd2d921-c447-44a7-a13c-4adabfc247e3", { GetUINT32: 7, GetUINT64: 8, GetGUID: 10, GetAllocatedString: 13, GetBlobSize: 14, GetBlob: 15, SetUINT32: 21, SetUINT64: 22, SetGUID: 24 }],
    IMFMediaType: ["44ae0fa8-ea31-4109-8d2e-4cae4997c555", {}],
    IMFActivate: ["7fee9e9a-4a89-47a6-899c-b6a53a70fb67", { ActivateObject: 33, ShutdownObject: 34 }],
    IMFSample: ["c40a00f2-b93a-4d80-ae8c-5a1c634f58e4", { GetSampleTime: 35, SetSampleTime: 36, SetSampleDuration: 38, ConvertToContiguousBuffer: 41, AddBuffer: 42 }],
    IMFMediaBuffer: ["045fa593-8799-42b8-bc8d-8968c6453507", { Lock: 3, Unlock: 4, GetCurrentLength: 5, SetCurrentLength: 6 }],
    IMFTransform: ["bf94c121-5b05-4e6f-8000-ba598961414d", { GetOutputStreamInfo: 7, GetAttributes: 8, GetInputAvailableType: 13, GetOutputAvailableType: 14, SetInputType: 15, SetOutputType: 16, GetOutputCurrentType: 18, ProcessMessage: 23, ProcessInput: 24, ProcessOutput: 25 }],
    IMFMediaEventGenerator: ["2cd0bd52-bcd5-4b89-b62c-eadc0c031e7d", { GetEvent: 3 }],
    // GetEventType is the SDK's GetType (the name is .NET's own).
    IMFMediaEvent: ["df598932-f10c-4e39-bba2-c308f101daa3", { GetEventType: 33, GetStatus: 35 }],
    IMFShutdown: ["97ec2ea4-0e42-4937-97ac-9d6d328824e1", { Shutdown: 3 }],
    ICodecAPI: ["901db4c7-31ce-41a2-85dc-8fa0bf41b8da", { SetValue: 9 }],
  };
  assert.deepEqual(Object.keys(interfaces).sort(), Object.keys(expected).sort(), "every declared interface is checked");
  for (const [name, [guid, slots]] of Object.entries(expected)) {
    assert.equal(interfaces[name].guid, guid, `${name}'s IID`);
    for (const [method, at] of Object.entries(slots)) assert.equal(slot(name, method), at, `${name}.${method} at vtable slot ${at}`);
  }
});

// Arrays and booleans cross a COM interface the COM way unless told
// otherwise: an array as a SAFEARRAY (Oct 14: GetBlob crashed the runner's
// helper with an access violation), a bool as a VARIANT_BOOL, a string as
// a BSTR. Every one in these interfaces is a C array, or isn't there.
test("screen-video.cs: no COM method takes an array the COM way, nor a bool or a string", () => {
  const code = fs.readFileSync(new URL("../scripts/native/screen-video.cs", import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
  const bodies = [...code.matchAll(/\[ComImport[^\]]*\]\s*interface (\w+) \{([^}]*)\}/g)];
  assert.ok(bodies.length >= 20);
  for (const [, name, body] of bodies)
    for (const [, params] of body.matchAll(/\w+\(([^)]*)\);/g))
      for (const param of params.split(",").map((p) => p.trim()).filter(Boolean)) {
        if (/\[\]\s+\w+$/.test(param)) assert.match(param, /MarshalAs\(UnmanagedType\.LPArray\)/, `${name}: ${param}`);
        assert.doesNotMatch(param, /\b(bool|string)\s+\w+$/, `${name}: ${param}`);
      }
});

test("screen-video.cs speaks the Mac helper's protocol, reads the lock as screen-stream.ps1 does, and stays in C# 5 and its lane", () => {
  const source = fs.readFileSync(new URL("../scripts/native/screen-video.cs", import.meta.url), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "");
  // Requests: frame, key, bitrate N; answers: 0 unchanged, 2 locked; an AUD first.
  assert.match(code, /line != "frame" && line != "key"/);
  assert.match(code, /line\.StartsWith\("bitrate "\)/);
  assert.match(code, /new byte\[\] \{ 2 \}/);
  assert.match(code, /new byte\[\] \{ 0 \}/);
  assert.match(code, /Delimiter = \{ 0, 0, 0, 1, 9, 0xF0 \}/);
  // Locked only when both say so, read as the PowerShell helper reads them.
  assert.match(code, /WTSQuerySessionInformation\(IntPtr\.Zero, -1, 25,/);
  assert.match(code, /Marshal\.ReadInt32\(buffer\) == 1 && Marshal\.ReadInt32\(buffer, 16\) == 0/);
  assert.match(code, /name\.ToString\(\) == "Default"/);
  assert.match(code, /return SessionLocked\(\) && !InputOnDefault\(\);/);
  assert.match(code, /REACH_TEST_SCREEN_LOCKED/);
  // Ends with stdin; exit 3 is "no H.264 encoder works here".
  assert.match(code, /while \(\(line = input\.ReadLine\(\)\) != null\)/);
  assert.match(code, /new VideoException\(3,/);
  // Media Foundation's H.264 encoders taking NV12; low latency; keyframes on request.
  assert.match(code, /new Guid\("f79eac7d-e545-4387-bdee-d647d7bde42a"\)/, "MFT_CATEGORY_VIDEO_ENCODER");
  assert.match(code, /new Guid\("3231564e-0000-0010-8000-00aa00389b71"\)/, "NV12");
  assert.match(code, /new Guid\("34363248-0000-0010-8000-00aa00389b71"\)/, "H.264");
  assert.match(code, /LowLatencyMode = new Guid\("9c27891a-ed7a-40e1-88e8-b22727a024ee"\)/);
  assert.match(code, /ForceKeyFrame = new Guid\("398c1b98-8353-475a-9ef2-8f265d260345"\)/);
  assert.match(code, /MeanBitRate = new Guid\("f7222374-2144-4815-b550-a37f8e12ee52"\)/);
  // Its lane: no files, network, processes or settings of its own.
  for (const word of ["File.", "Directory.", "FileStream", "StreamWriter", "Process.Start", "Socket", "WebClient", "HttpClient", "SetValue(@", "Registry.SetValue", "CreateKey"])
    assert.ok(!code.includes(word), word);
  // C# 5: what Windows' own csc.exe takes.
  for (const later of [/[\s=(,]\$"/, /\?\./, /\?\[/, /\bnameof\(/, /=>/, /\bout var\b/, /\{ get; \}/])
    assert.doesNotMatch(code, later);
});
