import { useCallback, useEffect, useRef, useState } from "react";
import type { Peer } from "./api";
import { ReconnectTimer, screenCanRetry } from "./reconnect";
import { decodeSoundPacket, Resampler } from "./sound-codec";
// Its own file, never inlined as a data: address: the page's policy runs
// scripts only from Reach itself (script-src 'self'), worklets included.
import workletUrl from "./sound-worklet.js?url&no-inline";

// The computer's sound beside its live screen (server/screen-sound.mjs):
// its own connection, so it never waits behind a video frame, played
// through an audio worklet a tenth of a second behind.
type Context = typeof AudioContext;
const contextClass = (): Context | undefined =>
  typeof window === "undefined"
    ? undefined
    : window.AudioContext || (window as unknown as { webkitAudioContext?: Context }).webkitAudioContext;
// Whether this browser can play it at all (an audio worklet: Safari 14.5,
// Chrome 66).
export const soundSupported = () =>
  typeof window !== "undefined" && "AudioWorkletNode" in window && !!contextClass();
export type SoundState = "off" | "starting" | "on";
// The worklet's code, loaded once per audio context.
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
const loadWorklet = (context: AudioContext) => {
  let done = loaded.get(context);
  if (!done) {
    done = context.audioWorklet.addModule(workletUrl);
    loaded.set(context, done);
  }
  return done;
};
// Every tenth of a second at most, the newest packet heard: the computer
// sees a link backing up from these and sends lighter sound.
const ACK_MS = 100;
// The computer sends at least one packet a second, even when silent. Before
// its first, a helper may be building (a Windows PC's first, under an
// antivirus, takes tens of seconds).
const SILENT_MS = 5000;
const STARTING_MS = 60000;

export function useScreenSound(peer: Peer, active: boolean) {
  const [on, setOn] = useState(false);
  // Another computer: its sound starts only when asked. Turned off while
  // rendering it, never in an effect: React runs effects a moment after the
  // speaker is on screen, and one there, run for the first computer too,
  // undid a tap made in that moment (Oct 26: Chrome on macOS CI, tapped as
  // soon as the page loaded).
  const [soundFor, setSoundFor] = useState(peer.url);
  if (soundFor !== peer.url) {
    setSoundFor(peer.url);
    setOn(false);
  }
  const [state, setState] = useState<SoundState>("off");
  // Why sound stopped, once (the screen says it in its line).
  const [error, setError] = useState("");
  const context = useRef<AudioContext | null>(null);
  const retry = useRef(new ReconnectTimer(Math.random, 15000, 500));
  const [attempt, setAttempt] = useState(0);
  // Connections in a row that ended before any sound played. A refusal
  // twice (no sound output, a helper that can't start), or a connection
  // turned away without a word three times (the host guard does that at the
  // door), says so and turns the speaker off instead of trying forever. A
  // link that drops after it played just reconnects.
  const refusals = useRef(0);
  // Called inside the tap itself: browsers start sound only during one.
  const start = useCallback(() => {
    const Context = contextClass();
    if (!Context) return;
    setError("");
    let audio = context.current;
    if (!audio || audio.state === "closed") {
      audio = new Context({ latencyHint: "interactive" });
      context.current = audio;
    }
    // Media playback, as a video is, so the ringer switch on silent
    // shouldn't mute it (Safari 17's audio session; older ones follow the
    // switch). Not yet tried on an iPhone.
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
    } catch {}
    void audio.resume().catch(() => {});
    retry.current.reset();
    refusals.current = 0;
    setOn(true);
  }, []);
  const stop = useCallback(() => {
    setOn(false);
    void context.current?.suspend().catch(() => {});
  }, []);
  useEffect(
    () => () => {
      retry.current.cancel();
      void context.current?.close().catch(() => {});
      context.current = null;
    },
    [],
  );
  useEffect(() => {
    const audio = context.current;
    if (!on || !active || !audio) {
      setState(on ? "starting" : "off");
      if (!on || !active) void audio?.suspend().catch(() => {});
      return;
    }
    setState("starting");
    let stopped = false;
    let socket: WebSocket | undefined;
    let node: AudioWorkletNode | undefined;
    let heard = Date.now();
    let ready = false;
    let ackedAt = 0;
    let failure: { error?: string; retryable?: boolean; status?: number } | null = null;
    const resampler = new Resampler();
    const again = () => {
      if (stopped) return;
      stopped = true;
      socket?.close();
      retry.current.schedule(() => setAttempt((n) => n + 1));
    };
    const end = (message: string) => {
      if (stopped) return;
      stopped = true;
      socket?.close();
      setError(message);
      setOn(false);
    };
    // Back from the background: a phone that won't resume without a new
    // tap turns the speaker off instead of showing it on and silent.
    const resumed = setTimeout(() => {
      if (!stopped && audio.state !== "running") end("");
    }, 2000);
    void audio.resume().catch(() => {});
    const watchdog = setInterval(() => {
      if (Date.now() - heard > (ready ? SILENT_MS : STARTING_MS)) again();
    }, 1000);
    loadWorklet(audio)
      .then(() => {
        if (stopped) return;
        node = new AudioWorkletNode(audio, "reach-sound", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.connect(audio.destination);
        const url = new URL("/ws/screen-sound", peer.url);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(url);
        socket = ws;
        ws.binaryType = "arraybuffer";
        heard = Date.now();
        ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: peer.token, codecs: ["adpcm"] }));
        ws.onmessage = (event) => {
          heard = Date.now();
          if (typeof event.data === "string") {
            let message: { type?: string; error?: string; retryable?: boolean; status?: number };
            try {
              message = JSON.parse(event.data);
            } catch {
              return;
            }
            if (message.type === "ready") {
              ready = true;
              retry.current.reset();
              refusals.current = 0;
              setState("on");
            } else if (message.type === "error") failure = message;
            return;
          }
          const packet = decodeSoundPacket(event.data as ArrayBuffer);
          if (!packet || !node) return;
          if (heard - ackedAt >= ACK_MS && ws.readyState === WebSocket.OPEN) {
            ackedAt = heard;
            ws.send(JSON.stringify({ type: "ack", seq: packet.sequence }));
          }
          if (packet.quiet) {
            node.port.postMessage({ type: "quiet" });
            return;
          }
          const samples = resampler.push(packet.samples, packet.channels, packet.rate, audio.sampleRate);
          node.port.postMessage({ type: "samples", samples }, [samples.buffer]);
        };
        ws.onclose = () => {
          if (stopped) return;
          if (failure && !screenCanRetry(failure)) return end(failure.error || "Sound stopped.");
          if (!ready && ++refusals.current >= (failure ? 2 : 3))
            return end(failure?.error || "The computer's sound didn't connect. Tap the speaker to try again.");
          again();
        };
      })
      .catch(() => end("This browser couldn't start the computer's sound."));
    return () => {
      stopped = true;
      clearTimeout(resumed);
      clearInterval(watchdog);
      socket?.close();
      node?.disconnect();
      node?.port.close();
    };
  }, [on, active, peer.url, peer.token, attempt]);
  return { on, state, error, start, stop };
}
