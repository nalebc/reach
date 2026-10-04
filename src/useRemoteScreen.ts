import { useEffect, useRef, useState } from "react";
import type { Peer } from "./api";
import { ReconnectTimer, screenCanRetry } from "./reconnect";
export function useRemoteScreen(
  peer: Peer,
  enabled: boolean,
  live: boolean,
  display: string,
  quality: string,
  revision: number,
  compatibility: boolean,
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
  });
  const [selectedDisplay, setSelectedDisplay] = useState("");
  const [fallback, setFallback] = useState(false);
  const [fallbackReason, setFallbackReason] = useState("");
  const retry = useRef(new ReconnectTimer());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    retry.current.reset();
    setFallback(false);
    setFallbackReason("");
  }, [peer.url, peer.token, display, quality, revision, compatibility]);
  useEffect(() => {
    if (!enabled || !live) {
      retry.current.cancel();
      setState((s) => ({ ...s, ready: false, connecting: false, fps: 0 }));
      return;
    }
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
      waitKey = true;
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
    });
    const ack = (id: number, keyframe = false) => {
      if (id > lastAck && socket.readyState === WebSocket.OPEN) {
        lastAck = id;
        socket.send(JSON.stringify({ type: "ack", id, keyframe }));
      }
    };
    const fail = (error: string, retryable = true, codecFailure = false) => {
      if (stopped || failed) return;
      failed = true;
      clearTimeout(watchdog);
      clearInterval(metrics);
      socket.close();
      if (codecFailure && format === "h264" && retryable) {
        setFallbackReason(error);
        setFallback(true);
        return;
      }
      setState((s) => ({
        ...s,
        ready: false,
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
      deadline(20000);
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
      socket.send(
        JSON.stringify({
          type: "auth",
          token: peer.token,
          protocol: 2,
          display,
          quality,
          format,
        }),
      );
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
        fail("Could not decode the screen frame.", true, true);
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
            fail(message.error, screenCanRetry(message), true);
          if (message.type === "ready") {
            wireFormat = message.format;
            setSelectedDisplay(message.display);
            setState((s) => ({ ...s, format: wireFormat }));
          }
        } catch {
          fail("Invalid screen response.", false);
        }
        return;
      }
      const buffer = event.data as ArrayBuffer;
      if (!received) {
        received = true;
        deadline(20000);
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
        if (!decoder)
          decoder = new VideoDecoder({
            output: (frame) => {
              try {
                if (!stopped && !failed)
                  draw(frame, frame.displayWidth, frame.displayHeight);
              } finally {
                frame.close();
              }
            },
            error: (error) =>
              fail(`Video decoder: ${error.message}`, true, true),
          });
        if (decoder.decodeQueueSize > 4) {
          decoder.reset();
          configured = "";
          waitKey = true;
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
          decoder.configure({
            codec: meta.codec,
            codedWidth: meta.width,
            codedHeight: meta.height,
            optimizeForLatency: true,
          });
          configured = config;
        }
        waitKey = false;

        decoder.decode(
          new EncodedVideoChunk({
            type: meta.key ? "key" : "delta",
            timestamp: meta.timestamp,
            data: data.subarray(4 + length),
          }),
        );
        // Admit a bounded decode queue without making startup depend on the
        // codec's internal output delay. Frames are drawn as the decoder emits.
        ack(id);
      } catch (e) {
        fail((e as Error).message, true, true);
      }
    };
    socket.onerror = () => fail("Could not connect to the screen stream.");
    socket.onclose = (event) =>
      fail(
        "Screen connection ended. Reconnecting…",
        event.code !== 4003 && !/revoked|expired/i.test(event.reason),
      );
    const wake = () => {
      if (!document.hidden) retry.current.wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      retry.current.cancel();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      clearTimeout(watchdog);
      clearInterval(metrics);
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
  ]);
  return { selectedDisplay, canvas, ...state, fallback, fallbackReason };
}
