import { useEffect, useState } from "react";
import type { Peer } from "./api";

export function useScreenStream(
  peer: Peer,
  enabled: boolean,
  live: boolean,
  visible: boolean,
  revision: number,
) {
  const [image, setImage] = useState("");
  const [updated, setUpdated] = useState<number | null>(null);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    setFps(0);
    if (!enabled) {
      setImage("");
      setUpdated(null);
    }
    if (!enabled || !live || !visible) {
      setConnecting(false);
      return;
    }
    const url = new URL("/ws/screen", peer.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "blob";
    let stopped = false;
    let failed = false;
    const urls = new Set<string>();
    let frame = "";
    let rendering = false;
    let animation = 0;
    let count = 0;
    let since = performance.now();
    let watchdog: ReturnType<typeof setTimeout>;
    setConnecting(true);
    setError("");
    setImage("");
    setUpdated(null);
    const fail = (message: string) => {
      if (stopped || failed) return;
      failed = true;
      clearTimeout(watchdog);
      setConnecting(false);
      setFps(0);
      setError(message);
      socket.close();
    };
    const deadline = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () =>
          fail(
            "Live screen stopped responding. Check your computer and reconnect.",
          ),
        ms,
      );
    };
    // The first use may compile the native helper. Later frames have a short watchdog.
    deadline(150000);
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: "auth", token: peer.token }));
    socket.onmessage = async (event) => {
      if (stopped || failed) return;
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "error") fail(message.error);
        } catch {
          fail("Invalid screen stream response.");
        }
        return;
      }
      if (
        rendering ||
        !(event.data instanceof Blob) ||
        event.data.size > 8 * 1024 * 1024
      ) {
        fail("Invalid screen frame.");
        return;
      }
      rendering = true;
      const next = URL.createObjectURL(
        new Blob([event.data], { type: "image/jpeg" }),
      );
      urls.add(next);
      try {
        const decoded = new Image();
        decoded.src = next;
        await decoded.decode();
        if (stopped || failed) {
          URL.revokeObjectURL(next);
          urls.delete(next);
          return;
        }
        const previous = frame;
        frame = next;
        setImage(next);
        setUpdated(Date.now());
        setConnecting(false);
        count++;
        const elapsed = performance.now() - since;
        if (elapsed >= 1000) {
          setFps(Math.round((count * 1000) / elapsed));
          count = 0;
          since = performance.now();
        }
        deadline(20000);
        animation = requestAnimationFrame(() => {
          URL.revokeObjectURL(previous);
          urls.delete(previous);
          rendering = false;
          if (!stopped && !failed && socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "ack" }));
        });
      } catch {
        URL.revokeObjectURL(next);
        urls.delete(next);
        fail("Could not decode the screen stream. Reconnect to try again.");
      }
    };
    socket.onerror = () =>
      fail(
        "Couldn’t connect to live screen. Restart Reach on your computer to load the latest version, then reconnect.",
      );
    socket.onclose = () =>
      fail("The screen stream disconnected. Reconnect to continue.");
    return () => {
      stopped = true;
      clearTimeout(watchdog);
      cancelAnimationFrame(animation);
      socket.close();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [peer.url, peer.token, enabled, live, visible, revision]);
  return { image, updated, fps, error, connecting };
}
