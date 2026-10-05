import { NativeScreenSource } from "./screen-stream.mjs";
import { desktopBinary, desktopDisplays } from "./desktop-native.mjs";
import { streamOptions } from "./desktop-protocol.mjs";
import { fileURLToPath } from "node:url";
import { windowsVideoAvailable, WindowsVideoSource } from "./windows-video.mjs";
import { fail } from "./core.mjs";

export class RemoteScreenHub {
  constructor(config, prepare) {
    this.config = config;
    this.prepare = prepare;
    this.groups = new Map();
    this.viewers = new Map();
  }
  async add(ws, authorize, value) {
    if (this.viewers.size >= 4)
      throw fail(429, "Four screen viewers are already connected.");
    const options = streamOptions(value);
    // The phone's own resolution (its longest side in pixels): in auto
    // quality, the stream is as sharp as that screen can show.
    const cap = value?.maxWidth;
    if (Number.isInteger(cap) && cap >= 640 && cap <= 3840)
      options.width =
        options.quality === "auto" ? cap : Math.min(options.width, cap);
    let selectedDisplay;
    // Reserve before asynchronous native preparation to enforce the global limit.
    const reservation = {};
    this.viewers.set(ws, reservation);
    try {
      if (!this.prepare) {
        const displays = await desktopDisplays(this.config);
        const display =
          options.display === "primary"
            ? displays.find((d) => d.primary)
            : displays.find((d) => d.id === options.display);
        if (!display)
          throw fail(
            400,
            "This display is unavailable. Refresh the display list.",
          );
        options.display = display.id;
        selectedDisplay = display;
        if (
          process.platform !== "darwin" &&
          !(process.platform === "win32" && (await windowsVideoAvailable()))
        )
          options.format = "jpeg";
      }
      if (options.format === "jpeg") options.fps = Math.min(options.fps, 20);
      if (
        this.viewers.get(ws) !== reservation ||
        !authorize() ||
        ws.readyState !== 1
      ) {
        this.remove(ws);
        return;
      }
      const key = JSON.stringify(options);
      let group = this.groups.get(key);
      if (!group) {
        const prepare = this.prepare
          ? () => this.prepare(options)
          : async () => {
              if (process.platform === "darwin") {
                const binary = await desktopBinary(
                  this.config,
                  "screen-stream",
                );
                return () =>
                  new NativeScreenSource(binary, [
                    options.display,
                    options.format,
                    String(options.fps),
                    String(options.width),
                    String(options.bitrate),
                    "auto",
                  ]);
              }
              if (options.format === "h264")
                return () => new WindowsVideoSource(selectedDisplay, options);
              return () =>
                new NativeScreenSource("powershell.exe", [
                  "-NoProfile",
                  "-File",
                  fileURLToPath(
                    new URL(
                      "../scripts/native/screen-stream.ps1",
                      import.meta.url,
                    ),
                  ),
                  options.display,
                  String(options.width),
                ]);
            };
        group = new RemoteBroadcast(prepare, options, () =>
          this.groups.delete(key),
        );
        this.groups.set(key, group);
      }
      this.viewers.set(ws, group);
      ws.send(JSON.stringify({ type: "ready", protocol: 2, ...options }));
      group.add(ws, authorize);
    } catch (e) {
      if (this.viewers.get(ws) === reservation) this.viewers.delete(ws);
      throw e;
    }
  }
  ack(ws, id, keyframe = false) {
    const group = this.viewers.get(ws);
    group?.ack?.(ws, id);
    if (keyframe && group?.viewers.get(ws)) group.viewers.get(ws).key = true;
  }
  remove(ws) {
    this.viewers.get(ws)?.remove?.(ws);
    this.viewers.delete(ws);
  }
  stop(message = "Screen viewing is off.", retryable = false) {
    for (const [ws, group] of this.viewers) {
      group.fail?.(ws, message, retryable);
      if (!group.fail) ws.close(retryable ? 1012 : 4003, message);
    }
    this.viewers.clear();
  }
}
// Short bounded frame window instead of waiting a full network round trip for
// every frame. Slow viewers skip ahead to an IDR; no undecodable delta frames.
export class RemoteBroadcast {
  constructor(prepare, options, onEmpty = () => {}) {
    Object.assign(this, { prepare, options, onEmpty });
    this.viewers = new Map();
    this.generation = 0;
    this.sequence = 0;
    this.source = null;
    this.timer = null;
    this.pacing = options.fps;
    this.bitrate = options.bitrate;
    this.adjustedAt = Date.now();
    this.healthy = 0;
  }
  add(ws, authorize) {
    this.viewers.set(ws, {
      authorize,
      pending: new Map(),
      key: true,
      rtt: 0,
      blocked: false,
      bytes: 0,
      frames: 0,
      statsAt: Date.now(),
    });
    if (this.viewers.size === 1) void this.start();
  }
  ack(ws, id) {
    const viewer = this.viewers.get(ws);
    if (!viewer || !Number.isInteger(id) || !viewer.pending.has(id))
      throw fail(400, "Invalid frame acknowledgment.");
    const elapsed = Date.now() - viewer.pending.get(id);
    viewer.rtt = viewer.rtt ? viewer.rtt * 0.8 + elapsed * 0.2 : elapsed;
    for (const seq of viewer.pending.keys())
      if (seq <= id) viewer.pending.delete(seq);
  }
  remove(ws) {
    this.viewers.delete(ws);
    if (!this.viewers.size) {
      this.generation++;
      clearTimeout(this.timer);
      this.source?.stop();
      this.source = null;
      this.onEmpty();
    }
  }
  fail(ws, message, retryable = true) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", error: message, retryable }));
      ws.close(retryable ? 1012 : 4003, "Screen stream ended");
    }
    this.remove(ws);
  }
  async start() {
    const generation = ++this.generation;
    try {
      const factory = await this.prepare();
      if (generation !== this.generation || !this.viewers.size) return;
      for (const [ws, v] of this.viewers) if (!v.authorize()) this.remove(ws);
      if (!this.viewers.size) return;
      this.source = factory();
      const tick = async () => {
        if (generation !== this.generation) return;
        const start = Date.now();
        try {
          const ready = [];
          let key = false;
          for (const [ws, v] of this.viewers) {
            if (!v.authorize() || ws.readyState !== 1) {
              this.remove(ws);
              continue;
            }
            const first = v.pending.values().next().value;
            if (first && Date.now() - first > 10000) {
              this.fail(ws, "Screen viewer stopped responding.");
              continue;
            }
            if (v.pending.size >= 6 || ws.bufferedAmount > 256 * 1024) {
              v.key = true;
              v.blocked = true;
              continue;
            }
            ready.push([ws, v]);
            key ||= v.key;
          }
          if (
            ["auto", "preview"].includes(this.options.quality) &&
            start - this.adjustedAt >= 1000
          ) {
            this.adjustedAt = start;
            const viewers = [...this.viewers.values()];
            // A slow viewer cannot drag every other viewer down. Groups use the
            // healthiest viewer; each slow viewer retains its own bounded window.
            const congested =
              viewers.length && viewers.every((v) => v.blocked || v.rtt > 180);
            if (congested) {
              this.healthy = 0;
              this.pacing = Math.max(20, Math.floor(this.pacing * 0.8));
              this.bitrate = Math.max(750000, Math.floor(this.bitrate * 0.75));
              this.source?.setBitrate?.(this.bitrate);
            } else if (++this.healthy >= 5) {
              this.healthy = 0;
              this.pacing = Math.min(this.options.fps, this.pacing + 5);
              this.bitrate = Math.min(
                this.options.bitrate,
                Math.floor(this.bitrate * 1.15),
              );
              this.source?.setBitrate?.(this.bitrate);
            }
            for (const v of viewers) v.blocked = false;
          }
          if (ready.length && this.source) {
            const data = await this.source.next(key ? "key" : "frame");
            if (generation !== this.generation) return;
            // One byte from the helper: nothing changed on screen, send nothing.
            if (data.length > 1) {
              const seq = ++this.sequence;
              const head = Buffer.alloc(4);
              head.writeUInt32BE(seq);
              const packet = Buffer.concat([head, data]);
              for (const [ws, v] of ready) {
                if (!v.authorize() || ws.readyState !== 1) continue;
                v.key = false;
                v.pending.set(seq, Date.now());
                ws.send(packet);
                v.bytes += packet.length;
                v.frames++;
                const interval = Date.now() - v.statsAt;
                if (interval >= 1000) {
                  ws.send(
                    JSON.stringify({
                      type: "quality",
                      fps: Math.round((v.frames * 1000) / interval),
                      bitrate: Math.round((v.bytes * 8000) / interval),
                      ackLatency: Math.round(v.rtt),
                      targetFps: this.pacing,
                    }),
                  );
                  v.bytes = 0;
                  v.frames = 0;
                  v.statsAt = Date.now();
                }
              }
            }
          }
          if (generation === this.generation && this.viewers.size)
            this.timer = setTimeout(
              tick,
              Math.max(1, 1000 / this.pacing - (Date.now() - start)),
            );
        } catch (e) {
          for (const ws of this.viewers.keys()) this.fail(ws, e.message);
        }
      };
      void tick();
    } catch (e) {
      if (generation === this.generation)
        for (const ws of this.viewers.keys()) this.fail(ws, e.message);
    }
  }
}
