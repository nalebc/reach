// Recording a voice memo in a chat's composer. Phones record in their own
// format (Safari: MP4, Chrome: WebM); the Mac reads WAV everywhere, so the
// memo is decoded here and sent as 16 kHz mono WAV, which speech models
// take as is. If decoding fails, the recording goes as recorded.
import { useEffect, useRef, useState } from "react";

export const MAX_SECONDS = 5 * 60;
export const canRecord = () =>
  typeof window !== "undefined" &&
  typeof MediaRecorder !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia;

const TYPES = ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
const pickType = () => TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";

export function wavFrom(samples: Float32Array, rate: number) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

async function toWav(recording: Blob): Promise<Blob> {
  const Context = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context || typeof OfflineAudioContext === "undefined") return recording;
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer());
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return wavFrom(rendered.getChannelData(0), rate);
  } catch {
    return recording;
  } finally {
    void context.close().catch(() => {});
  }
}

// "idle" → "recording" (seconds so far) → "working" while it becomes words.
// `onMemo` gets the recording; whatever it throws is the caller's to show.
export function useVoiceMemo(onMemo: (memo: Blob) => Promise<void>, onProblem: (message: string) => void) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const keep = useRef(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
    recorder.current = null;
  };
  // Leaving the chat stops the microphone; nothing is sent.
  useEffect(
    () => () => {
      keep.current = false;
      if (recorder.current?.state === "recording") recorder.current.stop();
      release();
    },
    [],
  );

  const start = async () => {
    if (state !== "idle") return;
    if (!canRecord()) return onProblem("This browser can't record. Use your keyboard's dictation instead.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as Error)?.name;
      return onProblem(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Reach isn't allowed to use the microphone. Allow it in Settings, or use your keyboard's dictation."
          : name === "NotFoundError"
            ? "No microphone was found."
            : "The microphone couldn't start. Use your keyboard's dictation instead.",
      );
    }
    let rec: MediaRecorder;
    try {
      const type = pickType();
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      return onProblem("This browser can't record. Use your keyboard's dictation instead.");
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      release();
      if (!keep.current || !chunks.length) {
        setState("idle");
        return;
      }
      setState("working");
      try {
        await onMemo(await toWav(new Blob(chunks, { type: rec.mimeType || chunks[0].type })));
      } catch (e) {
        onProblem((e as Error).message || "The memo couldn't be sent to the Mac.");
      } finally {
        setState("idle");
      }
    };
    recorder.current = rec;
    keep.current = true;
    setSeconds(0);
    const began = Date.now();
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - began) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS && rec.state === "recording") rec.stop();
    }, 250);
    rec.start(1000);
    setState("recording");
  };
  const stop = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  const cancel = () => {
    keep.current = false;
    stop();
  };
  return { state, seconds, start, stop, cancel };
}
