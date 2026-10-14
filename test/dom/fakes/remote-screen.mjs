import { useEffect, useRef, useState } from "react";
import { computer } from "./computer.mjs";

// Stands in for src/useRemoteScreen.ts: a live stream whose frames arrive
// when the test calls computer.frame().
export function useRemoteScreen(
  peer,
  enabled,
  live,
  display,
  quality,
  revision,
  compatibility,
  thread,
) {
  const canvas = useRef(null);
  const [updated, setUpdated] = useState(Date.now);
  if (enabled && live) computer.stream = { display, thread };
  useEffect(() => {
    const deliver = () => setUpdated((last) => Math.max(Date.now(), last + 1));
    computer.frames.add(deliver);
    return () => computer.frames.delete(deliver);
  }, []);
  return {
    selectedDisplay: display === "primary" ? "primary" : display,
    canvas,
    ready: enabled && live,
    connecting: false,
    error: "",
    format: "h264",
    fps: 60,
    mbps: 6,
    updated,
    width: computer.size.width,
    height: computer.size.height,
    fallback: false,
    fallbackReason: "",
    // What the computer said it sends, and why not better (a PC without
    // an H.264 encoder).
    video: computer.video ?? "H.264",
    videoWhy: computer.videoWhy ?? "",
  };
}
