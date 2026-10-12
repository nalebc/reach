import { NativeScreenSource, privateWindows } from "./screen-stream.mjs";
import { desktopBinary, desktopDisplays } from "./desktop-native.mjs";
import { streamOptions } from "./desktop-protocol.mjs";
import { fileURLToPath } from "node:url";
import { windowsVideoAvailable, WindowsVideoSource } from "./windows-video.mjs";
import { powershellFile } from "./powershell.mjs";
import { fail } from "./core.mjs";
export { privateWindows };
// Why the live screen failed, in Reach's window on the computer too: the
// phone may only show "Connecting…", and a person at the computer can act on
// the cause. Each cause once a minute, not once per retry or viewer.
const told = new Map();
export function screenTrouble(message, { now = Date.now, log = console.warn } = {}) {
  const text = String(message || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
  if (!text || (told.has(text) && now() - told.get(text) < 60000)) return false;
  told.set(text, now());
  if (told.size > 50) told.delete(told.keys().next().value);
  log(`Reach: live screen: ${text}`);
  return true;
}

export class RemoteScreenHub {
  constructor(config, prepare) {
    this.config = config;
    this.prepare = prepare;
    this.groups = new Map();
    this.viewers = new Map();
  }
  // mayViewDisplay(id): whether this viewer may watch that display. The
  // hidden displays Reach makes for apps on phones (server/app-threads.mjs)
  // are only for whoever may use that app.
  // privateView: a viewer who isn't the owner (a guest): password managers
  // and Reach's own windows are left out of their picture (Mac), in a group
  // of its own so the owner's view is unchanged.
  async add(
    ws,
    authorize,
    value,
    { mayViewDisplay = () => true, privateView = false } = {},
  ) {
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
      if (!mayViewDisplay(options.display))
        throw fail(403, "This display isn't shared with you.");
      if (
        this.viewers.get(ws) !== reservation ||
        !authorize() ||
        ws.readyState !== 1
      ) {
        this.remove(ws);
        return;
      }
      const key = JSON.stringify(privateView ? [options, "private"] : options);
      let group = this.groups.get(key);
      if (!group) {
        const prepare = this.prepare
          ? () => this.prepare(options, { privateView })
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
                    ...(privateView ? ["", privateWindows()] : []),
                  ]);
              }
              if (options.format === "h264")
                return () => new WindowsVideoSource(selectedDisplay, options);
              return () =>
                new NativeScreenSource(
                  "powershell.exe",
                  powershellFile(
                    fileURLToPath(
                      new URL(
                        "../scripts/native/screen-stream.ps1",
                        import.meta.url,
                      ),
                    ),
                    [options.display, String(options.width)],
                  ),
                );
            };
        // A group that emptied out frees its key only if it still holds it:
        // a newer group for the same stream may have taken its place.
        const created = new RemoteBroadcast(prepare, options, () => {
          if (this.groups.get(key) === created) this.groups.delete(key);
        });
        group = created;
        this.groups.set(key, group);
      }
      this.viewers.set(ws, group);
      ws.send(JSON.stringify({ type: "ready", protocol: 2, ...options }));
      // The display could become an app's hidden display later (ids are
      // reused): checked again with every frame, refused with a reason.
      const display = options.display;
      group.add(ws, () => {
        if (!authorize()) return false;
        if (mayViewDisplay(display)) return true;
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: "This display isn't shared with you.",
              status: 403,
              retryable: false,
            }),
          );
          ws.close(4003, "Screen access ended");
        }
        return false;
      });
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
// The screen helper's one-byte answers (scripts/native/screen-stream.swift):
// 0 is "nothing changed"; these say why there is nothing to capture.
export const IDLE = { 1: "asleep", 2: "locked" };
// Whether a frame from the helper starts a picture on its own: every still
// image does; a video frame does when its metadata says it's a keyframe.
export function sentKeyframe(data, format) {
  if (format !== "h264") return true;
  try {
    const length = data.readUInt32BE(0);
    if (length > 1024 || length + 4 > data.length) return false;
    // Read as the phone reads it (src/useRemoteScreen.ts: !!meta.key).
    return !!JSON.parse(data.subarray(4, 4 + length).toString()).key;
  } catch {
    return false;
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
    // Why the helper has nothing to capture now ("asleep", "locked"), or "".
    this.idle = "";
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
    // Not (or no longer) watching here: nothing to stop, and an empty
    // group's onEmpty never runs twice.
    if (!this.viewers.delete(ws)) return;
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
            // One byte from the helper: nothing changed on screen (0), send
            // nothing; or the Mac shows nothing to capture (asleep, locked):
            // the phones keep the last picture and say why, and the helper
            // is asked again about once a second instead of every frame.
            const idle = data.length === 1 ? IDLE[data[0]] || "" : "";
            if (idle) {
              this.idle = idle;
              for (const [ws, v] of ready) {
                if (!v.authorize() || ws.readyState !== 1) continue;
                // The first picture after it wakes starts a fresh video.
                v.key = true;
                ws.send(JSON.stringify({ type: "status", idle }));
              }
            } else if (data.length > 1 && this.idle) {
              this.idle = "";
              for (const [ws, v] of this.viewers)
                if (v.authorize() && ws.readyState === 1)
                  ws.send(JSON.stringify({ type: "status", idle: "" }));
            }
            if (data.length > 1) {
              const seq = ++this.sequence;
              const head = Buffer.alloc(4);
              head.writeUInt32BE(seq);
              const packet = Buffer.concat([head, data]);
              const keyframe = sentKeyframe(data, this.options.format);
              for (const [ws, v] of ready) {
                if (!v.authorize() || ws.readyState !== 1) continue;
                // A viewer waiting for a keyframe keeps asking until one went
                // out: a delta frame can't start its decoder.
                if (keyframe) v.key = false;
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
              Math.max(
                1,
                (this.idle ? 1000 : 1000 / this.pacing) - (Date.now() - start),
              ),
            );
        } catch (e) {
          if (this.viewers.size) screenTrouble(e.message);
          for (const ws of this.viewers.keys())
            this.fail(ws, e.message, !e.permanent);
        }
      };
      void tick();
    } catch (e) {
      if (generation === this.generation) {
        if (this.viewers.size) screenTrouble(e.message);
        for (const ws of this.viewers.keys()) this.fail(ws, e.message);
      }
    }
  }
}
