import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
let probe;
export function windowsVideoAvailable() {
  if (!probe)
    probe = exec(
      process.env.REACH_FFMPEG || "ffmpeg",
      ["-hide_banner", "-encoders"],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    )
      .then((r) => r.stdout.includes("libx264"))
      .catch(() => false);
  return probe;
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
