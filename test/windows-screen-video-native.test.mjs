import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { desktopDisplays, windowsBinary } from "../server/desktop-native.mjs";
import { AnnexBFrames, forgetWindowsVideo, windowsVideoChoice } from "../server/windows-video.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Windows' live screen as H.264 with nothing installed (parity audit #26):
// scripts/native/screen-video.cs, Desktop Duplication into Media
// Foundation's H.264 encoder. On a real Windows runner (after the CI step
// sets a normal PC's script policy) this builds the helper with the PC's own
// csc.exe, asks what the PC can do, streams its real screen while a window
// changes and the pointer moves, checks the stream as the phone and FFmpeg's
// parser read it, has a real browser's WebCodecs decode it as phones do, and
// watches it through Reach's own socket. A runner without an H.264 encoder
// must say so in words, and Reach must fall back with that reason.
// Elsewhere, or without REACH_TEST_WINDOWS_DESKTOP, it's skipped.
const run = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const exec = promisify(execFile);
const report = {};
const note = (values) => {
  Object.assign(report, values);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-screen-video.json", JSON.stringify(report, null, 2));
};
const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; !(await check()); ) {
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timing = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
  return { count: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
};

// The helper driven as Reach drives it: one request a line, one
// length-prefixed answer each.
function helper(file, args, env = {}) {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } });
  let buffer = Buffer.alloc(0),
    stderr = "";
  const waiting = [];
  child.stdout.on("data", (b) => {
    buffer = Buffer.concat([buffer, b]);
    while (buffer.length >= 4) {
      const n = buffer.readUInt32BE(0);
      if (buffer.length < 4 + n) break;
      const answer = Buffer.from(buffer.subarray(4, 4 + n));
      buffer = buffer.subarray(4 + n);
      waiting.shift()?.(answer);
    }
  });
  child.stderr.on("data", (b) => (stderr += b));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    exited,
    stderr: () => stderr,
    ask(line, ms = 60000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`no answer to ${line}: ${stderr}`)), ms);
        waiting.push((answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        child.stdin.write(`${line}\n`);
      });
    },
  };
}
// One answer: a status byte, or a video frame's metadata and Annex B (and
// the answer itself, as Reach passes it on to the phone).
const parse = (answer) => {
  if (answer.length === 1) return { byte: answer[0] };
  const n = answer.readUInt32BE(0);
  return { raw: answer, meta: JSON.parse(answer.subarray(4, 4 + n).toString()), annexb: answer.subarray(4 + n) };
};
const nalTypes = (annexb) => {
  const types = [];
  for (let i = 0; i + 3 < annexb.length; i++)
    if (annexb[i] === 0 && annexb[i + 1] === 0 && annexb[i + 2] === 1) {
      types.push(annexb[i + 3] & 31);
      i += 2;
    }
  return types;
};
// What an SPS says about the picture (H.264 7.3.2.1.1, E.1.1): its size and
// cropping, and whether it names its colours (the matrix a phone's decoder
// converts with) and promises no reordering (no frames held back).
function readSps(nal) {
  const bytes = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    bytes.push(nal[i]);
  }
  let bit = 0;
  const u = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (u(1) === 0 && zeros < 32) zeros++;
    return 2 ** zeros - 1 + u(zeros);
  };
  const se = () => {
    const k = ue();
    return k % 2 ? (k + 1) / 2 : -k / 2;
  };
  const sps = { profile: u(8), constraints: u(8), level: u(8) };
  ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(sps.profile)) {
    const chroma = ue();
    if (chroma === 3) u(1);
    ue();
    ue();
    u(1);
    if (u(1))
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++)
        if (u(1)) {
          let last = 8,
            next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
  }
  ue();
  const poc = ue();
  if (poc === 0) ue();
  else if (poc === 1) {
    u(1);
    se();
    se();
    for (let i = ue(); i > 0; i--) se();
  }
  sps.refs = ue();
  u(1);
  sps.width = (ue() + 1) * 16;
  sps.height = (ue() + 1) * 16;
  const frames = u(1);
  if (!frames) u(1);
  u(1);
  if (u(1)) sps.crop = [ue(), ue(), ue(), ue()];
  sps.vui = !!u(1);
  if (sps.vui) {
    if (u(1) && u(8) === 255) u(32);
    if (u(1)) u(1);
    if ((sps.videoSignal = !!u(1))) {
      sps.videoFormat = u(3);
      sps.fullRange = !!u(1);
      if ((sps.colourDescription = !!u(1))) [sps.primaries, sps.transfer, sps.matrix] = [u(8), u(8), u(8)];
    }
    if (u(1)) {
      ue();
      ue();
    }
    if ((sps.timing = !!u(1))) u(65);
    const hrd = () => {
      const count = ue() + 1;
      u(8);
      for (let i = 0; i < count; i++) {
        ue();
        ue();
        u(1);
      }
      u(20);
    };
    const nalHrd = u(1);
    if (nalHrd) hrd();
    const vclHrd = u(1);
    if (vclHrd) hrd();
    if (nalHrd || vclHrd) u(1);
    u(1);
    if ((sps.restriction = !!u(1))) {
      u(1);
      ue();
      ue();
      ue();
      ue();
      sps.reorder = ue();
      sps.decodeBuffer = ue();
    }
  }
  return sps;
}
const unitOf = (annexb, type) => {
  const starts = [];
  for (let i = 0; i + 3 < annexb.length; i++)
    if (annexb[i] === 0 && annexb[i + 1] === 0 && annexb[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  for (let k = 0; k < starts.length; k++)
    if ((annexb[starts[k]] & 31) === type) {
      let end = k + 1 < starts.length ? starts[k + 1] - 3 : annexb.length;
      while (end > starts[k] && annexb[end - 1] === 0) end--;
      return annexb.subarray(starts[k], end);
    }
  return null;
};
// A window whose counter changes (dirty rectangles) while it moves the
// pointer (Desktop Duplication's pointer), orange where the counter isn't;
// a "flip" file turns it blue (and says when), a "still" file stops it all.
const TARGET = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class ReachVideoTargetDpi { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v); }
'@
[ReachVideoTargetDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$out = $env:REACH_TARGET_OUT
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Reach video target'; $f.TopMost = $true; $f.StartPosition = 'Manual'; $f.FormBorderStyle = 'None'
$f.Left = 100; $f.Top = 100; $f.Width = 480; $f.Height = 300; $f.BackColor = [System.Drawing.Color]::FromArgb(255, 140, 0)
$l = New-Object System.Windows.Forms.Label
$l.Left = 8; $l.Top = 8; $l.Width = 160; $l.Height = 40; $l.Text = '0'; $l.BackColor = [System.Drawing.Color]::White
$l.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$f.Controls.Add($l)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({
  if (Test-Path "$out.still") { $timer.Stop(); return }
  if ((Test-Path "$out.flip") -and -not (Test-Path "$out.flipped")) {
    $f.BackColor = [System.Drawing.Color]::FromArgb(0, 64, 255); $f.Refresh()
    [IO.File]::WriteAllText("$out.flipped", [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  }
  $n = [int]$l.Text + 1; $l.Text = [string]$n
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point((700 + ($n * 13) % 200), (480 + ($n * 7) % 100))
})
$f.Add_Shown({
  $timer.Start()
  $p = $f.PointToScreen((New-Object System.Drawing.Point(0, 0)))
  [IO.File]::WriteAllText("$out.ready", "$($p.X),$($p.Y),$($f.ClientSize.Width),$($f.ClientSize.Height)")
})
[System.Windows.Forms.Application]::Run($f)
`;
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");
// What the phone does with each frame (src/useRemoteScreen.ts): one
// VideoDecoder configured from the stream's own codec and size, Annex B in
// (no description), each frame a chunk; and the first picture's colours at
// the points asked. Served from 127.0.0.1, a secure context (WebCodecs).
const PAGE = `<!doctype html><meta charset="utf-8"><script>
window.decodeAll = async (points, every) => {
  const out = { supported: "VideoDecoder" in self, decoded: 0, errors: [], samples: [], frames: [] };
  try {
    const data = new Uint8Array(await (await fetch("/frames")).arrayBuffer());
    const view = new DataView(data.buffer);
    let first = true;
    const decoder = new VideoDecoder({
      output: (frame) => {
        out.decoded++;
        if (first || every) {
          const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(frame, 0, 0);
          const colours = points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
          if (first) {
            out.size = [frame.displayWidth, frame.displayHeight, frame.codedWidth, frame.codedHeight];
            out.colorSpace = frame.colorSpace && frame.colorSpace.toJSON ? frame.colorSpace.toJSON() : null;
            out.samples = colours;
          }
          if (every) out.frames.push(colours);
          first = false;
        }
        frame.close();
      },
      error: (e) => out.errors.push(String(e)),
    });
    for (let at = 0; at + 4 <= data.length; ) {
      const n = view.getUint32(at);
      const packet = data.subarray(at + 4, at + 4 + n);
      at += 4 + n;
      const m = new DataView(packet.buffer, packet.byteOffset).getUint32(0);
      const meta = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + m)));
      if (decoder.state === "unconfigured") {
        const config = { codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height, optimizeForLatency: true };
        out.config = (await VideoDecoder.isConfigSupported(config)).supported;
        decoder.configure(config);
      }
      decoder.decode(new EncodedVideoChunk({ type: meta.key ? "key" : "delta", timestamp: meta.timestamp, data: packet.subarray(4 + m) }));
    }
    await decoder.flush();
    decoder.close();
  } catch (e) {
    out.errors.push(String(e));
  }
  return out;
};
</script>`;
async function decodeInBrowser(t, packets, points, every = false) {
  if (!findChrome()) return { skipped: "no Chrome on this PC (set REACH_TEST_CHROME to one)" };
  const frames = Buffer.concat(
    packets.flatMap((p) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(p.raw.length);
      return [length, p.raw];
    }),
  );
  const server = http.createServer((req, res) => {
    if (req.url === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE);
    if (req.url === "/frames") return res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(frames);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const chrome = await launchChrome(t);
  try {
    const tab = await openTab(chrome);
    await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
    const result = await tab.evaluate(`decodeAll(${JSON.stringify(points)}, ${every})`);
    return { browser: (await chrome.send("Browser.getVersion")).product, problems: tab.problems, ...result };
  } finally {
    // Chrome first: the server's close waits for its connections.
    await chrome.close();
    server.close();
  }
}
// Within a few levels per channel of what was on screen (BT.709, video
// range, in and out; 4:2:0 and the encoder's own loss on a flat colour).
const near = (rgb, want, by = 20) => rgb.every((v, i) => Math.abs(v - want[i]) <= by);
const ORANGE = [255, 140, 0],
  BLUE = [0, 64, 255];

let built = null,
  probed = null,
  screen = null,
  windowAt = null,
  streamed = null,
  // Every frame from the first IDR through the flip, with when it arrived.
  timeline = null,
  flippedAt = 0;
const scratch = run ? fs.mkdtempSync(path.join(os.tmpdir(), "reach screen video-")) : null;

test("Reach builds Windows' own video helper with the PC's csc.exe, and it says what this PC can do", { skip: !run, timeout: 240000 }, async () => {
  let started = Date.now();
  built = await windowsBinary({ dataDir: scratch }, "screen-video");
  note({ buildMs: Date.now() - started, helper: path.basename(built) });
  started = Date.now();
  const answer = await exec(built, ["--probe"], { timeout: 60000, windowsHide: true }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );
  note({ probeMs: Date.now() - started, probeCode: answer.code, probeStderr: String(answer.stderr).trim() });
  const displays = await desktopDisplays({});
  screen = displays.find((d) => d.primary) || displays[0];
  note({ screen });
  if (answer.code === 0) {
    probed = JSON.parse(String(answer.stdout).trim());
    note({ probe: probed });
    assert.equal(typeof probed.encoder, "string");
    assert.ok(["duplication", "gdi"].includes(probed.capture), probed.capture);
    return;
  }
  // No encoder: said in words, as the owner reads it on the phone.
  assert.equal(answer.code, 3, String(answer.stderr));
  const said = String(answer.stderr).trim().split(/\r?\n/).filter((l) => !l.startsWith("note: ")).at(-1);
  assert.match(said, /H\.264 video encoder/);
  assert.doesNotMatch(said, /\bat [A-Z]\w+\.|Exception/, "words, not a stack");
  note({ noEncoder: said });
});

test("without an H.264 encoder, Reach falls back and says why", { skip: !run, timeout: 240000 }, async (t) => {
  if (probed) return t.skip(`this runner has one: ${probed.encoder}`);
  forgetWindowsVideo();
  const lines = [];
  const choice = await windowsVideoChoice({ dataDir: scratch }, { log: (line) => lines.push(line) });
  note({ fallback: choice, fallbackLog: lines });
  assert.ok(["ffmpeg", "jpeg"].includes(choice.source), choice.source);
  assert.match(choice.why, /H\.264 video encoder/);
  assert.match(lines.join("\n"), /Reach: live screen: .*H\.264 video encoder/);
});

test("the real screen streams as H.264 as the phone and FFmpeg's parser read it: an IDR with SPS and PPS first, an AUD before every frame, a keyframe when asked, unchanged when still, and stdin closing ends it", { skip: !run, timeout: 300000 }, async (t) => {
  if (!probed) return t.skip(`no H.264 encoder on this runner: ${report.noEncoder}`);
  const out = path.join(scratch, "target");
  const target = spawn("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded(TARGET)], { env: { ...process.env, REACH_TARGET_OUT: out }, stdio: "ignore" });
  t.after(() => target.kill());
  await until(() => fs.existsSync(`${out}.ready`), "the target window");
  const [x, y, width, height] = fs.readFileSync(`${out}.ready`, "utf8").split(",").map(Number);
  windowAt = { x, y, width, height };
  note({ window: windowAt });

  const video = helper(built, ["primary", "30", "1280", "4000000"]);
  t.after(() => video.child.kill());
  let started = Date.now();
  const first = parse(await video.ask("key"));
  first.at = Date.now();
  note({ firstFrameMs: first.at - started });
  assert.ok(first.meta, `a picture first, not ${JSON.stringify(first)}: ${video.stderr()}`);
  assert.equal(first.meta.key, true);
  assert.match(first.meta.codec, /^avc1\.[0-9a-f]{6}$/);
  assert.ok(first.meta.width <= 1280 && first.meta.width % 2 === 0 && first.meta.height % 2 === 0, `${first.meta.width}×${first.meta.height}`);
  const types = nalTypes(first.annexb);
  assert.deepEqual(types.slice(0, 3), [9, 7, 8], `AUD, SPS, PPS first: ${types}`);
  assert.ok(types.includes(5), `an IDR: ${types}`);
  assert.equal(first.annexb.readUInt32BE(0), 1, "4-byte start codes");
  const spsNal = unitOf(first.annexb, 7);
  const sps = readSps(spsNal);
  note({ sps: { ...sps, hex: Buffer.from(spsNal).toString("hex") } });
  assert.equal(first.meta.codec, `avc1.${Buffer.from(spsNal.subarray(1, 4)).toString("hex")}`, "the codec string is the SPS's own");
  // Its colours named as converted (BT.709, video range) and no frames held
  // back, as the Mac's VideoToolbox stream says: a phone neither guesses
  // the matrix nor waits to reorder.
  assert.deepEqual([sps.colourDescription, sps.primaries, sps.transfer, sps.matrix, sps.fullRange], [true, 1, 1, 1, false]);
  assert.equal(sps.reorder, 0);

  // A second and a half at 30 requests a second while the window changes.
  const packets = [first],
    took = [],
    unchanged = [];
  for (const end = Date.now() + 1500; Date.now() < end; ) {
    const asked = Date.now();
    const answer = parse(await video.ask("frame"));
    answer.at = Date.now();
    const ms = answer.at - asked;
    if (answer.meta) {
      packets.push(answer);
      took.push(ms);
    } else unchanged.push(answer.byte);
    await sleep(Math.max(0, 33 - ms));
  }
  note({
    frames: packets.length,
    unchangedAnswers: unchanged.length,
    frameMs: timing(took),
    size: [first.meta.width, first.meta.height],
    codec: first.meta.codec,
    bytes: { key: first.annexb.length, deltaMedian: timing(packets.slice(1).map((p) => p.annexb.length)).median },
    stderr: video.stderr().trim(),
  });
  assert.ok(unchanged.every((b) => b === 0), `only "unchanged" bytes: ${unchanged}`);
  assert.ok(packets.length >= 10, `the changing window made frames: ${packets.length}`);
  for (const p of packets) {
    assert.equal(nalTypes(p.annexb)[0], 9, "an AUD first");
    assert.ok(p.meta.width === first.meta.width && p.meta.height === first.meta.height);
  }
  assert.ok(packets.slice(1).some((p) => !p.meta.key), "delta frames between keyframes");

  // Asked for a keyframe mid-stream, it sends an IDR with its SPS and PPS.
  started = Date.now();
  const key = parse(await video.ask("key"));
  key.at = Date.now();
  note({ keyMs: key.at - started });
  assert.equal(key.meta?.key, true, JSON.stringify(key.meta));
  assert.deepEqual(nalTypes(key.annexb).slice(0, 3), [9, 7, 8]);
  assert.ok(nalTypes(key.annexb).includes(5));
  packets.push(key);

  // FFmpeg's parser (server/windows-video.mjs) splits it into the same
  // frames. It closes a frame when the next one's delimiter is whole, so
  // two more delimiters end the last.
  const split = [];
  const parser = new AnnexBFrames((frame) => split.push(frame));
  const all = Buffer.concat([...packets.map((p) => p.annexb), Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 9, 0xf0])]);
  for (let i = 0; i < all.length; i += 4096) parser.push(all.subarray(i, i + 4096));
  assert.equal(split.length, packets.length);
  packets.forEach((p, i) => assert.ok(split[i].equals(p.annexb), `frame ${i} splits exactly`));
  streamed = [...packets];

  // A struggling link: Reach lowers the bitrate (no answer), and the
  // stream goes on.
  video.child.stdin.write("bitrate 1500000\n");

  // The window turns blue: the frames that follow, with when each came,
  // for the time from a change on screen to its frame (decoded below).
  fs.writeFileSync(`${out}.flip`, "");
  for (const end = Date.now() + 1200; Date.now() < end; ) {
    const asked = Date.now();
    const answer = parse(await video.ask("frame"));
    answer.at = Date.now();
    if (answer.meta) packets.push(answer);
    await sleep(Math.max(0, 33 - (answer.at - asked)));
  }
  await until(() => fs.existsSync(`${out}.flipped`), "the window to turn blue", 10000);
  flippedAt = Number(fs.readFileSync(`${out}.flipped`, "utf8"));
  timeline = packets;

  // Still: nothing changes, so "unchanged", and a real frame at least every second.
  fs.writeFileSync(`${out}.still`, "");
  await sleep(500);
  const still = [];
  for (const end = Date.now() + 2500; Date.now() < end; ) {
    still.push(parse(await video.ask("frame")));
    await sleep(33);
  }
  const stillFrames = still.filter((a) => a.meta).length;
  note({ stillAnswers: still.length, stillFrames });
  assert.ok(still.filter((a) => a.byte === 0).length >= still.length * 0.8, `mostly unchanged on a still screen: ${stillFrames} of ${still.length}`);
  assert.ok(stillFrames >= 2, `a real frame every second: ${stillFrames}`);

  // Reach gone (stdin closed): the helper ends by itself, cleanly.
  video.child.stdin.end();
  const code = await Promise.race([video.exited, sleep(10000).then(() => "still running")]);
  note({ exitOnEof: code });
  assert.equal(code, 0, video.stderr());
  const { stdout } = await exec("tasklist.exe", ["/FI", `IMAGENAME eq ${path.basename(built)}`, "/NH"]);
  assert.ok(!stdout.toLowerCase().includes(path.basename(built).toLowerCase()), `no helper left: ${stdout}`);
});

test("a real browser's WebCodecs decodes every frame, as the phone does, and the window's orange comes out orange", { skip: !run, timeout: 300000 }, async (t) => {
  if (!streamed) return t.skip(probed ? "nothing was streamed" : `no H.264 encoder on this runner: ${report.noEncoder}`);
  const { width, height } = streamed[0].meta;
  const at = (px, py) => [Math.round(((px - screen.x) * width) / screen.width), Math.round(((py - screen.y) * height) / screen.height)];
  const points = [at(windowAt.x + windowAt.width * 0.7, windowAt.y + windowAt.height * 0.7), at(windowAt.x + windowAt.width * 0.4, windowAt.y + windowAt.height * 0.85)];
  const decoded = await decodeInBrowser(t, streamed, points);
  note({ decoded: { ...decoded, frames: streamed.length } });
  if (decoded.skipped) return t.skip(decoded.skipped);
  assert.equal(decoded.supported, true, "WebCodecs");
  assert.equal(decoded.config, true, `${streamed[0].meta.codec} is a configuration this decoder takes`);
  assert.deepEqual(decoded.errors, []);
  assert.equal(decoded.decoded, streamed.length, "every frame decoded");
  assert.equal(decoded.size[0], width);
  assert.equal(decoded.size[1], height);
  // Decoded with the matrix the stream names: its red is 255 again (BT.601
  // would read this orange's red as about 244).
  for (const sample of decoded.samples) assert.ok(sample[0] >= 250 && near(sample, ORANGE, 14), `orange, not ${sample}`);
  assert.equal(decoded.colorSpace?.matrix, "bt709", JSON.stringify(decoded.colorSpace));
});

test("a change on the real screen reaches a decoded frame within a frame or two of the helper's", { skip: !run, timeout: 300000 }, async (t) => {
  if (!timeline) return t.skip(probed ? "nothing was streamed" : `no H.264 encoder on this runner: ${report.noEncoder}`);
  const { width, height } = timeline[0].meta;
  const at = [Math.round(((windowAt.x + windowAt.width * 0.7 - screen.x) * width) / screen.width), Math.round(((windowAt.y + windowAt.height * 0.7 - screen.y) * height) / screen.height)];
  const decoded = await decodeInBrowser(t, timeline, [at], true);
  if (decoded.skipped) return t.skip(decoded.skipped);
  assert.deepEqual(decoded.errors, []);
  assert.equal(decoded.frames.length, timeline.length, "every frame decoded");
  const colours = decoded.frames.map((f) => f[0]);
  const blue = colours.findIndex((c) => near(c, BLUE, 40));
  assert.ok(blue > 0, `the window turned blue in the stream: ${JSON.stringify(colours.slice(-5))}`);
  assert.ok(colours.slice(0, blue).every((c) => near(c, ORANGE, 40)), "orange until then");
  // From the moment the window said it turned blue (its paint, Windows'
  // composition, Desktop Duplication, conversion, encoding, at 30 requests
  // a second) to the frame showing it, out of the helper.
  const latency = timeline[blue].at - flippedAt;
  note({ changeToFrameMs: latency, blueFrame: blue, framesBefore: blue });
  assert.ok(latency < 500, `${latency} ms from the change to its frame`);
});

test("scaled down for a smaller phone, the picture still decodes with its colours", { skip: !run, timeout: 300000 }, async (t) => {
  if (!probed) return t.skip(`no H.264 encoder on this runner: ${report.noEncoder}`);
  const out = path.join(scratch, "small");
  const target = spawn("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded(TARGET)], { env: { ...process.env, REACH_TARGET_OUT: out }, stdio: "ignore" });
  t.after(() => target.kill());
  await until(() => fs.existsSync(`${out}.ready`), "the target window");
  const [x, y, w, h] = fs.readFileSync(`${out}.ready`, "utf8").split(",").map(Number);
  // Not a whole fraction of the screen: the area-weighted scaling.
  const asked = Math.max(320, Math.round(screen.width * 0.62));
  const video = helper(built, ["primary", "30", String(asked), "2000000"]);
  t.after(() => video.child.kill());
  const packets = [parse(await video.ask("key"))];
  for (let i = 0; i < 20; i++) {
    const answer = parse(await video.ask("frame"));
    if (answer.meta) packets.push(answer);
    await sleep(33);
  }
  assert.ok(packets[0].meta?.key, video.stderr());
  const { width, height } = packets[0].meta;
  note({ scaled: { asked, size: [width, height], frames: packets.length } });
  assert.ok(width <= asked && width < screen.width);
  const at = (px, py) => [Math.round(((px - screen.x) * width) / screen.width), Math.round(((py - screen.y) * height) / screen.height)];
  const decoded = await decodeInBrowser(t, packets, [at(x + w * 0.7, y + h * 0.7)]);
  note({ scaledDecoded: decoded });
  if (decoded.skipped) return t.skip(decoded.skipped);
  assert.deepEqual(decoded.errors, []);
  assert.equal(decoded.decoded, packets.length);
  assert.ok(near(decoded.samples[0], ORANGE), `orange, not ${decoded.samples[0]}`);
});

test("a locked session answers the Mac's one-byte locked status, and keeps answering", { skip: !run, timeout: 120000 }, async (t) => {
  if (!probed) return t.skip(`no H.264 encoder on this runner: ${report.noEncoder}`);
  // Locking the runner itself would end every later desktop test, so the
  // lock is told (as for scripts/native/screen-stream.ps1); the frames above
  // prove the real check reads this unlocked runner as such.
  const video = helper(built, ["primary", "30", "1280", "4000000"], { REACH_TEST_SCREEN_LOCKED: "1" });
  t.after(() => video.child.kill());
  for (const command of ["key", "frame", "frame"]) assert.deepEqual([...(await video.ask(command))], [2], "locked, for as long as it is");
});

test("where Desktop Duplication isn't available, GDI's capture streams the same video: unchanged when still, decoded with its colours", { skip: !run, timeout: 300000 }, async (t) => {
  if (!probed) return t.skip(`no H.264 encoder on this runner: ${report.noEncoder}`);
  const out = path.join(scratch, "gdi");
  const target = spawn("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded(TARGET)], { env: { ...process.env, REACH_TARGET_OUT: out }, stdio: "ignore" });
  t.after(() => target.kill());
  await until(() => fs.existsSync(`${out}.ready`), "the target window");
  const [x, y, w, h] = fs.readFileSync(`${out}.ready`, "utf8").split(",").map(Number);
  // As a VM or a Remote Desktop session without duplication would have it.
  const video = helper(built, ["primary", "30", "1280", "4000000"], { REACH_TEST_SCREEN_GDI: "1" });
  t.after(() => video.child.kill());
  const first = parse(await video.ask("key"));
  assert.ok(first.meta?.key, `a picture first: ${video.stderr()}`);
  assert.deepEqual(nalTypes(first.annexb).slice(0, 3), [9, 7, 8]);
  const packets = [first],
    took = [];
  for (const end = Date.now() + 1500; Date.now() < end; ) {
    const asked = Date.now();
    const answer = parse(await video.ask("frame"));
    const ms = Date.now() - asked;
    if (answer.meta) {
      packets.push(answer);
      took.push(ms);
    }
    await sleep(Math.max(0, 33 - ms));
  }
  fs.writeFileSync(`${out}.still`, "");
  await sleep(500);
  const still = [];
  for (const end = Date.now() + 1500; Date.now() < end; ) {
    still.push(parse(await video.ask("frame")));
    await sleep(33);
  }
  note({ gdi: { frames: packets.length, frameMs: timing(took), stillAnswers: still.length, stillFrames: still.filter((a) => a.meta).length, stderr: video.stderr().trim() } });
  assert.ok(packets.length >= 5, `the changing window made frames: ${packets.length}`);
  for (const p of packets) assert.equal(nalTypes(p.annexb)[0], 9, "an AUD first");
  assert.ok(still.filter((a) => a.byte === 0).length >= still.length * 0.8, "mostly unchanged on a still screen");
  video.child.stdin.end();
  assert.equal(await Promise.race([video.exited, sleep(10000).then(() => "still running")]), 0, video.stderr());
  const { width, height } = first.meta;
  const at = [Math.round(((x + w * 0.7 - screen.x) * width) / screen.width), Math.round(((y + h * 0.7 - screen.y) * height) / screen.height)];
  const decoded = await decodeInBrowser(t, packets, [at]);
  note({ gdiDecoded: { ...decoded, frames: undefined } });
  if (decoded.skipped) return t.skip(decoded.skipped);
  assert.deepEqual(decoded.errors, []);
  assert.equal(decoded.decoded, packets.length, "every frame decoded");
  assert.ok(decoded.samples[0][0] >= 250 && near(decoded.samples[0], ORANGE, 14), `orange, not ${decoded.samples[0]}`);
});

test("Reach serves it to a phone: the socket says H.264 from Windows itself, the frames are video, and Pause leaves no helper running", { skip: !run, timeout: 300000 }, async (t) => {
  if (!probed) return t.skip(`no H.264 encoder on this runner: ${report.noEncoder}`);
  forgetWindowsVideo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-video-e2e-"));
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), screen: true });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const origin = `127.0.0.1:${reach.server.address().port}`;
  const url = `ws://${origin}/ws/screen`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const ws = new WebSocket(url);
  t.after(async () => {
    ws.terminate();
    await reach.close();
    // A helper just ended may hold its file a moment longer.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  const messages = [];
  ws.on("error", () => {});
  ws.on("message", (b, binary) => messages.push(binary ? b : JSON.parse(b)));
  await once(ws, "open");
  const started = Date.now();
  ws.send(JSON.stringify({ type: "auth", token: owner.token, protocol: 2, display: "primary", quality: "balanced", format: "h264", maxWidth: 1280 }));
  const frames = () => messages.filter((m) => Buffer.isBuffer(m));
  await until(() => frames().length >= 1 || messages.some((m) => m.type === "error"), "the first frame", 120000);
  const ready = messages.find((m) => m.type === "ready");
  note({ reachReady: ready, reachFirstFrameMs: Date.now() - started });
  assert.equal(messages.find((m) => m.type === "error"), undefined, JSON.stringify(messages.filter((m) => !Buffer.isBuffer(m))));
  assert.equal(ready.format, "h264");
  assert.match(ready.video, /^H\.264/);
  assert.equal(ready.videoWhy, undefined);
  const packet = frames()[0];
  const n = packet.readUInt32BE(4);
  const meta = JSON.parse(packet.subarray(8, 8 + n).toString());
  assert.equal(meta.key, true);
  assert.deepEqual(nalTypes(packet.subarray(8 + n)).slice(0, 3), [9, 7, 8]);

  // Pause gives the PC back: the stream ends, and no video helper is left
  // capturing (as the still-image helper's own test checks).
  const paused = await fetch(`http://${origin}/api/settings/pause`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ paused: true }),
  }).then((r) => r.json());
  assert.deepEqual(paused, { paused: true });
  await until(() => messages.some((m) => m.type === "error"), "the stream to end on Pause", 15000);
  const name = path.basename(built).toLowerCase();
  const running = async () => (await exec("tasklist.exe", ["/FI", `IMAGENAME eq ${name}`, "/NH"])).stdout.toLowerCase().includes(name);
  await until(async () => !(await running()), "no video helper left after Pause", 20000);
  note({ helpersAfterPause: 0 });
});
