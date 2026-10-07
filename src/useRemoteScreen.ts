import { useEffect, useRef, useState } from "react";
import type { Peer } from "./api";
import { ReconnectTimer, screenCanRetry } from "./reconnect";
import { latestFramePainter } from "./frame-painter";
import { holdReload } from "./build-reload";
// Video decoders open on this page, for the log when one fails: a phone runs
// only so many hardware decoders at once.
const decoders = new Set<VideoDecoder>();
const openDecoders = () => {
  for (const d of decoders) if (d.state === "closed") decoders.delete(d);
  return decoders.size;
};
const lastMinute = (times: number[], now: number) => [
  ...times.filter((at) => now - at < 60000),
  now,
];
export function useRemoteScreen(
  peer: Peer,
  enabled: boolean,
  live: boolean,
  display: string,
  quality: string,
  revision: number,
  compatibility: boolean,
  // An app on the phone: stream only that app's window (server/app-threads.mjs).
  thread?: string,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState({
    ready: false,
    connecting: false,
    error: "",
    format: "",
    fps: 0,
    mbps: 0,
    updated: 0,
    width: 0,
    height: 0,
    // The computer's view of this link (its "quality" report each second):
    // the time its frames take to be acknowledged, and whether it has had
    // to lower the stream for a while. `slow` is what the toolbar says.
    latency: 0,
    slow: false,
  });
  const [selectedDisplay, setSelectedDisplay] = useState("");
  const [fallback, setFallback] = useState(false);
  const [fallbackReason, setFallbackReason] = useState("");
  // Blips come back within a few seconds: retry soon (a quarter second the
  // first time), never 30 s later.
  const retry = useRef(new ReconnectTimer(Math.random, 4000, 250));
  // The source whose picture is on the canvas. Reconnecting to the same one
  // keeps that picture (the toolbar says "Connecting…") instead of the
  // loading scene; only 5 s without a fresh frame brings the scene back.
  const shown = useRef("");
  const blank = useRef<ReturnType<typeof setTimeout>>(undefined);
  const holdFrame = () => {
    blank.current ??= setTimeout(() => {
      blank.current = undefined;
      setState((s) => ({ ...s, ready: false }));
    }, 5000);
  };
  const clearHold = () => {
    clearTimeout(blank.current);
    blank.current = undefined;
  };
  useEffect(() => clearHold, []);
  // Why the last connection ended, told to the computer by the next one.
  const lost = useRef<{
    reason: string;
    at: number;
    frameAt: number;
    code?: number;
    times: number;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Decoders that failed before showing a single frame, in the last minute:
  // the third means this phone can't decode the stream, so still images.
  const codecFailures = useRef<number[]>([]);
  // Decoders that failed mid-stream: each is replaced on the same connection;
  // only a steady run of them gives up on video.
  const hiccups = useRef<number[]>([]);
  // Steps down from this phone's full resolution, only if its decoder can't
  // keep up.
  const [step, setStep] = useState(0);
  useEffect(() => {
    retry.current.reset();
    codecFailures.current = [];
    hiccups.current = [];
    setFallback(false);
    setFallbackReason("");
    setStep(0);
  }, [peer.url, peer.token, display, quality, revision, compatibility, thread]);
  useEffect(() => {
    if (!enabled || !live) {
      retry.current.cancel();
      clearHold();
      lost.current = null;
      setState((s) => ({ ...s, ready: false, connecting: false, fps: 0 }));
      return;
    }
    const source = JSON.stringify([
      peer.url,
      peer.token,
      display,
      quality,
      revision,
      compatibility,
      thread ?? "",
    ]);
    // The Screen tab or an app's window (not Home's small preview): a new
    // phone interface waits until it's closed instead of reloading mid-use.
    const release = quality === "preview" ? () => {} : holdReload();
    const format =
      !compatibility && !fallback && "VideoDecoder" in window ? "h264" : "jpeg";
    const url = new URL("/ws/screen", peer.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let stopped = false,
      failed = false,
      decoder: VideoDecoder | undefined,
      configured = "",
      wireFormat = "",
      waitKey = true,
      // Frames the current decoder has shown, and the last chunk it was given.
      decoded = 0,
      lastChunk = { key: false, width: 0, height: 0, codec: "" },
      // No new decoder before this: one that failed before its first frame
      // gets the phone a moment (1 s, then 2 s), as reconnecting once did.
      retryAt = 0;
    const opened = Date.now();
    let backlogs = 0;
    let last = 0,
      count = 0,
      bytes = 0,
      received = false,
      decodingImage = false,
      imagePending: { id: number; data: Uint8Array<ArrayBuffer> } | undefined,
      lastAck = 0,
      drawnWidth = 0,
      drawnHeight = 0,
      watchdog: ReturnType<typeof setTimeout>;

    if (shown.current === source) {
      holdFrame();
      setState((s) => ({
        ...s,
        connecting: true,
        error: "",
        fps: 0,
        mbps: 0,
        latency: 0,
        slow: false,
      }));
    } else {
      clearHold();
      shown.current = "";
      lost.current = null;
      setState({
        ready: false,
        connecting: true,
        error: "",
        format: "",
        fps: 0,
        mbps: 0,
        updated: 0,
        width: 0,
        height: 0,
        latency: 0,
        slow: false,
      });
    }
    // The frame rate the computer aims for on this connection, and how many
    // of its reports in a row found the link struggling or fine: the toolbar
    // says "slow" after two struggling seconds, and drops it after three
    // fine ones, never flickering on a single late acknowledgment.
    let targetCap = 0,
      struggling = 0,
      fine = 0;
    const ack = (id: number, keyframe = false) => {
      if (id > lastAck && socket.readyState === WebSocket.OPEN) {
        lastAck = id;
        socket.send(JSON.stringify({ type: "ack", id, keyframe }));
      }
    };
    // Tells the computer why the video changed; it lands in Reach's log.
    const report = (text: string) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "diagnostic", text }));
    };
    // Server messages and garbled packets reconnect, staying on H.264.
    const fail = (error: string, retryable = true, stillImages = false) => {
      if (stopped || failed) return;
      failed = true;
      lost.current = {
        reason: error,
        at: Date.now(),
        frameAt: last || lost.current?.frameAt || 0,
        times: (lost.current?.times ?? 0) + 1,
      };
      clearTimeout(watchdog);
      clearInterval(metrics);
      painter.stop();
      socket.close();
      if (stillImages) {
        setFallbackReason(error);
        setFallback(true);
        return;
      }
      const keep = retryable && shown.current === source;
      if (keep) holdFrame();
      else clearHold();
      setState((s) => ({
        ...s,
        ready: keep && s.ready,
        connecting: retryable,
        error: retryable ? "" : error,
        fps: 0,
      }));
      if (retryable)
        retry.current.schedule(() => {
          if (!stopped) setAttempt((n) => n + 1);
        });
    };
    const deadline = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => fail("Screen stream stalled. Reconnecting…"),
        ms,
      );
    };
    const draw = (frame: CanvasImageSource, width: number, height: number) => {
      const surface = canvas.current;
      if (!surface || stopped) return;
      if (surface.width !== width || surface.height !== height) {
        surface.width = width;
        surface.height = height;
      }
      surface
        .getContext("2d", { alpha: false, desynchronized: true })
        ?.drawImage(frame, 0, 0, width, height);
      count++;
      last = Date.now();
      retry.current.reset();
      shown.current = source;
      lost.current = null;
      clearHold();
      // The computer sends a real frame at least every second, even when
      // nothing changed: 10 s of silence means the connection is gone.
      deadline(10000);
      if (drawnWidth !== width || drawnHeight !== height) {
        drawnWidth = width;
        drawnHeight = height;
        setState((s) => ({
          ...s,
          ready: true,
          connecting: false,
          width,
          height,
          updated: last,
        }));
      }
    };
    const painter = latestFramePainter<VideoFrame>((frame) =>
      draw(frame, frame.displayWidth, frame.displayHeight),
    );
    const startDecoder = () => {
      const next: VideoDecoder = new VideoDecoder({
        // Newest frame per screen refresh: a phone that can't draw every
        // frame skips some instead of falling further and further behind.
        output: (frame) => {
          if (stopped || failed || next !== decoder) frame.close();
          else {
            decoded++;
            painter.push(frame);
          }
        },
        error: (error) =>
          decoderFailed(next, `Video decoder: ${error.message}`),
      });
      openDecoders();
      decoders.add(next);
      decoded = 0;
      configured = "";
      waitKey = true;
      return next;
    };
    // This phone's decoder gave up (Safari closes it on any error). A new one
    // takes over on the same connection from the next keyframe; the last
    // frame stays on screen meanwhile. Reconnecting took a second or two.
    const decoderFailed = (which: VideoDecoder | undefined, error: string) => {
      if (stopped || failed || which !== decoder) return;
      const now = Date.now();
      const firstFrame = !decoded;
      const queued = which?.decodeQueueSize ?? 0;
      if (which && which.state !== "closed") which.close();
      decoder = undefined;
      configured = "";
      waitKey = true;
      if (firstFrame)
        codecFailures.current = lastMinute(codecFailures.current, now);
      else hiccups.current = lastMinute(hiccups.current, now);
      // Failing mid-stream again and again at this size: a notch smaller
      // (as when the phone falls behind) before ever giving up on video.
      const smaller = !firstFrame && hiccups.current.length >= 3 && step < 2;
      const giveUp =
        codecFailures.current.length >= 3 ||
        (step >= 2 && hiccups.current.length >= 10);
      // Enough to tell why from the computer's log.
      const where = thread ? "app" : quality === "preview" ? "home" : "screen";
      const chunk = lastChunk;
      const resets = codecFailures.current.length + hiccups.current.length;
      report(
        `${giveUp ? "switching to still images" : smaller ? `stepping down from ${chunk.width}×${chunk.height} after ${resets} decoder restarts this minute` : `decoder restarted (${resets} this minute)`}: ${error} · ${where} ${chunk.width}×${chunk.height} ${chunk.codec} · ${firstFrame ? "before its first frame" : `after ${decoded} frames`} · on a ${chunk.key ? "keyframe" : "delta"} · ${queued} queued · ${openDecoders()} decoders open · page ${document.hidden ? "hidden" : "visible"} · ${Math.round((now - opened) / 1000)} s in`,
      );
      decoded = 0;
      if (firstFrame)
        retryAt = now + 1000 * 2 ** (codecFailures.current.length - 1);
      if (giveUp) fail(error, true, true);
      else if (smaller) {
        hiccups.current = [];
        setStep((n) => n + 1);
      }
    };
    const metrics = setInterval(() => {
      setState((s) => ({
        ...s,
        fps: count,
        mbps: Math.round((bytes * 8) / 100000) / 10,
        updated: last || s.updated,
      }));
      count = 0;
      bytes = 0;
    }, 1000);
    // Network handshakes must not wait for the native-helper build deadline.
    deadline(12000);
    socket.onopen = () => {
      if (stopped || failed) {
        socket.close();
        return;
      }
      deadline(150000);
      // As sharp as this phone's screen can show, longest side, in pixels.
      const full = Math.round(
        Math.max(window.screen?.width || 0, window.screen?.height || 0) *
          (window.devicePixelRatio || 1),
      );
      const maxWidth = Math.round(full * 0.75 ** step);
      socket.send(
        JSON.stringify({
          type: "auth",
          token: peer.token,
          protocol: 2,
          display,
          quality,
          format,
          ...(maxWidth >= 640 && { maxWidth: Math.min(3840, maxWidth) }),
          ...(thread && { thread }),
        }),
      );
      const was = lost.current;
      if (was) {
        const where = thread ? "app" : quality === "preview" ? "home" : "screen";
        const ago = (at: number) => `${((Date.now() - at) / 1000).toFixed(1)} s`;
        report(
          `${where} reconnecting (${was.times}× since the last frame) after: ${was.reason}${was.code ? ` · closed ${was.code}` : ""} · ${ago(was.at)} ago · last frame ${was.frameAt ? `${ago(was.frameAt)} ago` : "never"} · page ${document.hidden ? "hidden" : "visible"}${navigator.onLine === false ? " · offline" : ""}`,
        );
      }
    };
    const decodeLatestImage = async () => {
      if (decodingImage) return;
      decodingImage = true;
      try {
        while (imagePending && !stopped && !failed) {
          const item = imagePending;
          imagePending = undefined;
          const bitmap = await createImageBitmap(
            new Blob([item.data], { type: "image/jpeg" }),
          );
          try {
            if (!stopped && !failed) draw(bitmap, bitmap.width, bitmap.height);
          } finally {
            bitmap.close();
          }
          ack(item.id);
        }
      } catch {
        fail("Could not decode the screen frame.");
      } finally {
        decodingImage = false;
      }
    };
    socket.onmessage = (event) => {
      if (stopped || failed) return;
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "error")
            fail(message.error, screenCanRetry(message));
          if (message.type === "ready") {
            wireFormat = message.format;
            targetCap = Number(message.fps) || 0;
            setSelectedDisplay(message.display);
            setState((s) => ({ ...s, format: wireFormat }));
          }
          if (message.type === "quality") {
            const latency = Math.max(0, Number(message.ackLatency) || 0);
            const target = Number(message.targetFps) || 0;
            const struggles =
              latency > 300 ||
              (targetCap > 0 && target > 0 && target < targetCap * 0.6);
            struggling = struggles ? struggling + 1 : 0;
            fine = struggles ? 0 : fine + 1;
            // React may batch several reports before rendering. Each queued
            // update must use the counters from its own report.
            const strugglingReports = struggling,
              fineReports = fine;
            setState((s) => {
              const slow = s.slow ? fineReports < 3 : strugglingReports >= 2;
              return s.slow === slow && s.latency === latency
                ? s
                : { ...s, slow, latency };
            });
          }
        } catch {
          fail("Invalid screen response.", false);
        }
        return;
      }
      const buffer = event.data as ArrayBuffer;
      if (!received) {
        received = true;
        deadline(10000);
      }
      bytes += buffer.byteLength;
      if (buffer.byteLength < 5 || buffer.byteLength > 8 * 1024 * 1024 + 4) {
        fail("Invalid screen packet.", false);
        return;
      }
      const packet = new DataView(buffer),
        id = packet.getUint32(0),
        data = new Uint8Array(buffer, 4);
      if (wireFormat === "jpeg") {
        // Decode the newest waiting image, not every stale frame in a backlog.
        if (imagePending) ack(imagePending.id);
        imagePending = { id, data };
        void decodeLatestImage();
        return;
      }
      try {
        const length = new DataView(data.buffer, data.byteOffset).getUint32(0);
        if (length > 1024 || length + 4 >= data.length)
          throw Error("Invalid video header.");
        const meta = JSON.parse(
          new TextDecoder().decode(data.subarray(4, 4 + length)),
        );
        if (
          !Number.isFinite(meta.timestamp) ||
          !Number.isInteger(meta.width) ||
          !Number.isInteger(meta.height) ||
          meta.width < 2 ||
          meta.height < 2 ||
          meta.width > 4096 ||
          meta.height > 4096 ||
          !/^avc1\.[0-9a-f]{6}$/i.test(meta.codec)
        )
          throw Error("Invalid video format.");
        if (decoder?.state === "closed") {
          decoderFailed(decoder, "Video decoder closed.");
          if (failed) return;
        }
        if (!decoder && Date.now() < retryAt) {
          ack(id);
          return;
        }
        if (!decoder) decoder = startDecoder();
        lastChunk = {
          key: !!meta.key,
          width: meta.width,
          height: meta.height,
          codec: meta.codec,
        };
        // A queue that keeps growing means this phone can't decode this
        // resolution in time: one step down, then a fresh start. Not while
        // the decoder is still starting (Safari queues every chunk until its
        // hardware decoder exists): resetting then only started another one,
        // and another, each just as slow to start.
        if (decoder.decodeQueueSize > (decoded ? 4 : 60)) {
          if (++backlogs >= 3 && step < 2) {
            report(`decoder falling behind at ${meta.width}×${meta.height}`);
            setStep((n) => n + 1);
          }
          decoder.reset();
          configured = "";
          waitKey = true;
          decoded = 0;
        }
        if (waitKey && !meta.key) {
          ack(id, true);
          return;
        }
        const config = JSON.stringify([meta.codec, meta.width, meta.height]);
        if (configured !== config) {
          if (!meta.key) {
            ack(id, true);
            return;
          }
          try {
            decoder.configure({
              codec: meta.codec,
              codedWidth: meta.width,
              codedHeight: meta.height,
              optimizeForLatency: true,
            });
          } catch (e) {
            decoderFailed(decoder, `Video decoder: ${(e as Error).message}`);
            return;
          }
          configured = config;
        }
        waitKey = false;

        try {
          decoder.decode(
            new EncodedVideoChunk({
              type: meta.key ? "key" : "delta",
              timestamp: meta.timestamp,
              data: data.subarray(4 + length),
            }),
          );
        } catch (e) {
          // Closed by an error Safari hasn't reported yet: same as reported.
          decoderFailed(decoder, `Video decoder: ${(e as Error).message}`);
          return;
        }
        // Admit a bounded decode queue without making startup depend on the
        // codec's internal output delay. Frames are drawn as the decoder emits.
        ack(id);
      } catch (e) {
        // A garbled packet: reconnect, still with H.264.
        fail((e as Error).message, true);
      }
    };
    socket.onerror = () => fail("Could not connect to the screen stream.");
    socket.onclose = (event) => {
      fail(
        "Screen connection ended. Reconnecting…",
        event.code !== 4003 && !/revoked|expired/i.test(event.reason),
      );
      // The close code, also after an error event already ended it.
      if (!stopped && lost.current && !lost.current.code)
        lost.current.code = event.code;
    };
    const wake = () => {
      if (!document.hidden) retry.current.wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      release();
      retry.current.cancel();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      clearTimeout(watchdog);
      clearInterval(metrics);
      painter.stop();
      socket.close();
      if (decoder && decoder.state !== "closed") decoder.close();
    };
  }, [
    peer.url,
    peer.token,
    enabled,
    live,
    display,
    quality,
    revision,
    compatibility,
    fallback,
    attempt,
    thread,
    step,
  ]);
  return { selectedDisplay, canvas, ...state, fallback, fallbackReason };
}
