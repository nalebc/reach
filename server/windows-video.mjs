import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsBinary } from "./desktop-native.mjs";
import { NativeScreenSource } from "./screen-stream.mjs";
const exec = promisify(execFile);
// The live screen on Windows comes, best first, as H.264 from Windows itself
// (scripts/native/screen-video.cs: Desktop Duplication and Media
// Foundation's encoder, nothing to install), as H.264 from FFmpeg when the
// owner installed it, or as still images (scripts/native/screen-stream.ps1).
// Which one, and why not a better one, goes to Reach's log and to the
// phone's Screen page (the ready message's video and videoWhy).
const MISS_MS = 5 * 60 * 1000;
let said = "";
const sayOnce = (line, log) => {
  if (line === said) return;
  said = line;
  log(`Reach: live screen: ${line}`);
};

// Whether Windows' own H.264 works on this PC, asked of its helper once
// (--probe: a real picture through the encoder). Found, kept; not found (an N
// edition without the Media Feature Pack, Windows Server without Media
// Foundation, a helper Windows refused), asked again a few minutes later.
let ownProbe = null; // { promise, result, at }
export function windowsNativeVideo(
  config,
  { build = (c) => windowsBinary(c, "screen-video"), run = exec, now = Date.now } = {},
) {
  const held = ownProbe;
  if (held && (!held.result || held.result.ok || now() - held.at < MISS_MS)) return held.promise;
  const probe = { result: null, at: now() };
  probe.promise = (async () => {
    let file;
    try {
      file = await build(config);
    } catch (e) {
      return { ok: false, why: e.message || "Reach couldn't prepare its Windows video helper." };
    }
    try {
      const { stdout } = await run(file, ["--probe"], { timeout: 30000, maxBuffer: 65536, windowsHide: true });
      const found = JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1));
      if (typeof found?.encoder !== "string" || !found.encoder) throw Error("The video check gave no encoder.");
      return {
        ok: true,
        file,
        encoder: found.encoder.slice(0, 120),
        hardware: found.hardware === true,
        capture: found.capture === "duplication" ? "duplication" : "gdi",
      };
    } catch (e) {
      return { ok: false, why: probeWhy(e) };
    }
  })().then((result) => {
    probe.result = result;
    probe.at = now();
    return result;
  });
  ownProbe = probe;
  return probe.promise;
}
// What the helper said (its words: "This N edition of Windows has no H.264
// video encoder…"), or what stopped it from saying.
function probeWhy(error) {
  if (/^spawn/.test(error?.syscall || "") && ["EACCES", "EPERM", "UNKNOWN"].includes(error?.code))
    return "Windows refused to run Reach's video helper: an application control policy (Smart App Control, App Control for Business or AppLocker) or an antivirus blocks it.";
  if (error?.killed) return "Windows' video check didn't finish in time.";
  const line = String(error?.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("note: ")).at(-1);
  return (line || "Windows' video check failed.").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
}
// A stream whose encoder gave out (the helper's exit 3): the next viewer
// gets FFmpeg or still images, and hears why; asked again a few minutes later.
export function windowsNativeVideoFailed(why, { now = Date.now } = {}) {
  const result = { ok: false, why: String(why || "Windows' H.264 encoder stopped.").slice(0, 300) };
  ownProbe = { result, at: now(), promise: Promise.resolve(result) };
}
// Forgets what was found (tests).
export function forgetWindowsVideo() {
  ownProbe = null;
  probe = undefined;
  missedAt = 0;
  said = "";
}

// The best video this PC has now: { source: "windows" (file: its helper),
// "ffmpeg" or "jpeg", label (the phone's Video row), why (when it isn't
// Windows' own: the phone's note under it) }.
export async function windowsVideoChoice(
  config,
  { native = windowsNativeVideo, ffmpeg = windowsVideoAvailable, log = console.log } = {},
) {
  const own = await native(config);
  if (own.ok) {
    sayOnce(`H.264 video from Windows itself (${own.encoder}${own.hardware ? ", hardware" : ""}).`, log);
    return { source: "windows", file: own.file, label: own.hardware ? "H.264, hardware" : "H.264", why: "", encoder: own.encoder };
  }
  if (await ffmpeg()) {
    sayOnce(`${own.why} FFmpeg makes the video instead.`, log);
    return { source: "ffmpeg", label: "H.264 by FFmpeg", why: `${own.why} FFmpeg makes the video instead.` };
  }
  sayOnce(`${own.why} The screen comes as still images instead.`, log);
  return { source: "jpeg", label: "Still images", why: `${own.why} Until then, the screen comes as still images.` };
}
// The stream from Windows' own helper (the Mac helper's protocol, so
// RemoteBroadcast reads "unchanged", "locked" and keyframes as on a Mac).
export function windowsNativeSource(file, options, { start = (f, args) => new NativeScreenSource(f, args), failed = windowsNativeVideoFailed } = {}) {
  const source = start(file, [options.display, String(options.fps), String(options.width), String(options.bitrate)]);
  source.onExit = (code, error) => {
    if (code === 3) failed(error.message);
  };
  return source;
}

// Whether FFmpeg with libx264 is here for video (otherwise the screen comes
// as still images). Found once, kept; not found, looked for again a few
// minutes later, so installing FFmpeg needs no Reach restart.
let probe, missedAt = 0;
export function windowsVideoAvailable({ run = exec, now = Date.now } = {}) {
  if (probe === false && now() - missedAt < MISS_MS) return Promise.resolve(false);
  if (!probe || probe === false)
    probe = run(
      process.env.REACH_FFMPEG || "ffmpeg",
      ["-hide_banner", "-encoders"],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    )
      .then((r) => r.stdout.includes("libx264"))
      .catch(() => false)
      .then((found) => {
        if (!found) {
          probe = false;
          missedAt = now();
        }
        return found;
      });
  return probe === false ? Promise.resolve(false) : probe;
}
// FFmpeg inserts AUD boundaries. Keep at most a few encoded frames, and resume
// at an IDR after any dropped data so slow clients never see corrupt deltas.
export class AnnexBFrames {
  buffer = Buffer.alloc(0);
  access = [];
  size = 0;
  constructor(emit) {
    this.emit = emit;
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8 * 1024 * 1024)
      throw Error("Video NAL exceeded the size limit.");
    const starts = [];
    for (let i = 0; i + 3 < this.buffer.length; i++) {
      if (
        this.buffer[i] === 0 &&
        this.buffer[i + 1] === 0 &&
        (this.buffer[i + 2] === 1 ||
          (this.buffer[i + 2] === 0 && this.buffer[i + 3] === 1))
      ) {
        const prefix = this.buffer[i + 2] === 1 ? 3 : 4;
        starts.push({ at: i, prefix });
        i += prefix - 1;
      }
    }
    if (starts.length < 2) return;
    for (let i = 0; i < starts.length - 1; i++) {
      const a = starts[i],
        b = starts[i + 1],
        nal = this.buffer.subarray(a.at + a.prefix, b.at),
        type = nal[0] & 31;
      if (type === 9 && this.access.length) {
        this.emit(Buffer.concat(this.access));
        this.access = [];
        this.size = 0;
      }
      const part = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
      this.size += part.length;
      if (this.size > 8 * 1024 * 1024)
        throw Error("Video frame exceeded the size limit.");
      this.access.push(part);
    }
    this.buffer = this.buffer.subarray(starts.at(-1).at);
  }
}
export class WindowsVideoSource {
  constructor(
    display,
    options,
    command = process.env.REACH_FFMPEG || "ffmpeg",
  ) {
    const scale = Math.min(
      1,
      options.width / display.width,
      2160 / display.height,
    );
    this.width = Math.max(2, Math.floor((display.width * scale) / 2) * 2);
    this.height = Math.max(2, Math.floor((display.height * scale) / 2) * 2);
    this.fps = options.fps;
    this.count = 0;
    this.codec = "";
    this.queue = [];
    this.pending = null;
    this.failure = null;
    this.needKey = true;
    this.child = spawn(
      command,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "gdigrab",
        "-framerate",
        String(options.fps),
        "-draw_mouse",
        "1",
        "-offset_x",
        String(display.x),
        "-offset_y",
        String(display.y),
        "-video_size",
        `${display.width}x${display.height}`,
        "-i",
        "desktop",
        "-vf",
        `scale=${this.width}:${this.height}`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        String(options.bitrate),
        "-maxrate",
        String(options.bitrate),
        "-bufsize",
        String(options.bitrate / 2),
        "-x264-params",
        `aud=1:repeat-headers=1:keyint=${Math.max(1, Math.floor(options.fps / 2))}:scenecut=0`,
        "-f",
        "h264",
        "pipe:1",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const parser = new AnnexBFrames((data) => this.frame(data));
    this.child.stdout.on("data", (b) => {
      try {
        parser.push(b);
      } catch (e) {
        this.stop(e);
      }
    });
    this.child.stderr.on("data", () => {});
    this.child.on("error", () =>
      this.stop(Error("FFmpeg video is unavailable. Use compatibility video.")),
    );
    this.child.on("exit", () =>
      this.stop(
        Error("Video capture ended. Use compatibility video or check FFmpeg."),
      ),
    );
  }
  frame(data) {
    let key = false;
    for (let i = 0; i + 4 < data.length; i++)
      if (
        data[i] === 0 &&
        data[i + 1] === 0 &&
        data[i + 2] === 0 &&
        data[i + 3] === 1
      ) {
        const type = data[i + 4] & 31;
        if (type === 5) key = true;
        if (type === 7 && i + 7 < data.length)
          this.codec = "avc1." + data.subarray(i + 5, i + 8).toString("hex");
      }
    const meta = Buffer.from(
        JSON.stringify({
          key,
          timestamp: Math.round((++this.count * 1000000) / this.fps),
          width: this.width,
          height: this.height,
          codec: this.codec,
        }),
      ),
      head = Buffer.alloc(4);
    head.writeUInt32BE(meta.length);
    if (this.queue.length >= 6) {
      this.queue = [];
      this.needKey = true;
    }
    if (this.needKey && !key) return;
    if (key) this.needKey = false;
    this.queue.push({ key, packet: Buffer.concat([head, meta, data]) });
    this.deliver();
  }
  deliver() {
    if (!this.pending || !this.queue.length) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(this.queue.shift().packet);
  }
  next(command = "frame") {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(Error("Capture already pending."));
    if (command === "key") {
      const index = this.queue.findIndex((f) => f.key);
      if (index < 0) {
        this.queue = [];
        this.needKey = true;
      } else this.queue.splice(0, index);
    }
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(
          () => this.stop(Error("Video capture timed out.")),
          15000,
        ),
      };
      this.deliver();
    });
  }
  stop(error = Error("Video stopped.")) {
    if (this.failure) return;
    this.failure = error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.queue = [];
    this.child.kill();
  }
}
