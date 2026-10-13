import { useEffect, useRef, useState } from "react";
import type { Peer } from "./api";
import { ReconnectTimer } from "./reconnect";
import {
  DesktopInputQueue,
  type DesktopAction,
  type InputResult,
} from "./desktop-input-queue";
export type { DesktopAction } from "./desktop-input-queue";
type Field = { x: number; y: number; w: number; h: number; secure: boolean };
// Inputs that can move or open text fields: a map from before one is stale.
const changes = new Set(["click", "down", "up", "key", "text", "type-edit", "scroll", "menu"]);
export function useDesktopInput(
  peer: Peer,
  enabled: boolean,
  display: string,
  onEnd: (message: string) => void,
  // While the screen is open, a stopped control keeps its connection a
  // minute, parked on the Mac: Control again resumes on it at once.
  open = enabled,
) {
  const [typing, setTyping] = useState(false);
  // The computer can say whether a text field is under the finger.
  const [probe, setProbe] = useState(false);
  const [initialCursor, setInitialCursor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [ready, setReady] = useState(false),
    [latency, setLatency] = useState(0);
  // A brief interruption (the link blinks, the Mac checks the phone late)
  // reconnects quietly, as the live screen does: control stays on, nothing
  // sent before it is replayed. A few in a row with no ready end control.
  const [reconnecting, setReconnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useRef(new ReconnectTimer(Math.random, 4000, 250));
  const tries = useRef(0);
  const dispatcher = useRef<(a: DesktopAction) => Promise<InputResult>>(() =>
    Promise.reject(Error("Enable screen control first.")),
  );
  const end = useRef(onEnd);
  end.current = onEnd;
  const on = useRef(enabled);
  on.current = enabled;
  const [held, setHeld] = useState(false);
  const link = useRef<{ park(): void; resume(): void } | null>(null);
  useEffect(() => {
    if (!open) return setHeld(false);
    if (enabled) {
      setHeld(true);
      link.current?.resume();
      return;
    }
    link.current?.park();
    const timer = setTimeout(() => setHeld(false), 60000);
    return () => clearTimeout(timer);
  }, [enabled, open]);
  const connected = open && (enabled || held);
  // Where the computer's text fields are, pushed ahead of any tap, and the
  // last input sent that could have moved them.
  const fieldMap = useRef<{ after: number; fields: Field[] } | null>(null);
  const lastChange = useRef(0);
  useEffect(() => {
    setReady(false);
    setTyping(false);
    setProbe(false);
    setInitialCursor(null);
    fieldMap.current = null;
    lastChange.current = 0;
    if (!connected) {
      retry.current.reset();
      tries.current = 0;
      setReconnecting(false);
      return;
    }
    const url = new URL("/ws/screen-input", peer.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    let stopped = false,
      failed = false,
      parked = false,
      queue: DesktopInputQueue | undefined,
      measured = 0;
    let deadline: ReturnType<typeof setTimeout>;
    const stop = (message: string, retryable = false) => {
      if (stopped || failed) return;
      failed = true;
      clearTimeout(deadline);
      setReady(false);
      queue?.close();
      // Control is off: the parked connection ends quietly, nothing to say.
      if (parked || !on.current) {
        link.current = null;
        retry.current.reset();
        tries.current = 0;
        setReconnecting(false);
        setHeld(false);
        socket.close();
        return;
      }
      if (retryable && tries.current < 6) {
        tries.current++;
        setReconnecting(true);
        // 4002: closing to come back. The Mac keeps control for the phone a
        // moment (server/desktop-connection.mjs); a clean close lets it go.
        socket.close(4002, "Reconnecting");
        retry.current.schedule(() => {
          if (!stopped) setAttempt((n) => n + 1);
        });
        return;
      }
      retry.current.reset();
      tries.current = 0;
      setReconnecting(false);
      socket.close();
      end.current(
        retryable
          ? `${message.replace(/\s*Reconnecting…$/u, "")} Try Control again.`
          : message,
      );
    };
    const fail = (message: string) => stop(message);
    link.current = {
      park() {
        if (failed || parked) return;
        parked = true;
        clearTimeout(deadline);
        queue?.close();
        queue = undefined;
        setReady(false);
        setTyping(false);
        setProbe(false);
        fieldMap.current = null;
      },
      resume() {
        if (failed || !parked) return;
        parked = false;
        lastChange.current = 0;
        deadline = setTimeout(
          () => stop("Desktop input did not become ready. Reconnecting…", true),
          12000,
        );
        socket.send(JSON.stringify({ type: "resume" }));
      },
    };
    dispatcher.current = (a) =>
      queue && !failed
        ? queue.enqueue(a)
        : Promise.reject(Object.assign(Error("Desktop input is not connected."), { notSent: true }));
    deadline = setTimeout(
      () => stop("Desktop input connection timed out. Reconnecting…", true),
      12000,
    );
    socket.onopen = () => {
      if (stopped || failed) {
        socket.close();
        return;
      }
      clearTimeout(deadline);
      deadline = setTimeout(
        () => fail("Desktop input did not become ready. Try Control again."),
        150000,
      );
      socket.send(JSON.stringify({ type: "auth", token: peer.token, display }));
    };
    socket.onmessage = (event) => {
      if (stopped || failed) return;
      try {
        const m = JSON.parse(event.data);
        if (m.type === "error") {
          // The Mac says whether this is the connection (back in a moment)
          // or the grant (over): older companions only ever meant the grant.
          stop(m.error, m.retryable === true);
          return;
        }
        if (m.type === "parked") return link.current?.park();
        if (m.type === "ready" && !queue && !parked) {
          clearTimeout(deadline);
          retry.current.reset();
          tries.current = 0;
          setReconnecting(false);
          queue = new DesktopInputQueue(
            (id, action) => {
              if (changes.has(action.type)) lastChange.current = id;
              socket.send(JSON.stringify({ type: "input", id, action }));
            },
            // A stalled or filled queue is the link's trouble: reconnect
            // with an empty one (nothing it held is sent late).
            (message) => stop(message, true),
            Number.isInteger(m.window) ? Math.max(1, Math.min(8, m.window)) : 1,
          );
          if (
            Number.isFinite(m.cursor?.x) &&
            Number.isFinite(m.cursor?.y) &&
            m.cursor.x >= 0 &&
            m.cursor.x <= 1 &&
            m.cursor.y >= 0 &&
            m.cursor.y <= 1
          )
            setInitialCursor(m.cursor);
          setTyping(m.typing === true);
          setProbe(m.probe === true);
          setReady(true);
          return;
        }
        if (m.type === "fields" && queue) {
          const ok = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
          if (Number.isSafeInteger(m.after) && Array.isArray(m.fields))
            fieldMap.current = {
              after: m.after,
              fields: m.fields
                .slice(0, 64)
                .filter((f: Field) => ok(f?.x) && ok(f?.y) && ok(f?.w) && ok(f?.h))
                .map((f: Field) => ({ x: f.x, y: f.y, w: f.w, h: f.h, secure: f.secure === true })),
            };
          return;
        }
        // Unknown or out-of-order messages (a second "ready", an early
        // "fields") are harmless; only a malformed ack fails the control.
        if (m.type !== "ack" || !queue) return;
        const ms = queue.acknowledge(m.id, m);
        if (performance.now() - measured > 500) {
          measured = performance.now();
          setLatency(Math.round(ms));
        }
      } catch (e) {
        fail((e as Error).message);
      }
    };
    socket.onerror = () =>
      stop("Desktop input could not connect. Reconnecting…", true);
    // 4001 is the Mac ending control (revoked, expired, taken over, paused):
    // its error message already said why. Any other close is the link.
    socket.onclose = (event) =>
      stop(
        event.code === 4001
          ? "Desktop control ended."
          : "Desktop control disconnected. Reconnecting…",
        event.code !== 4001,
      );
    const heartbeat = setInterval(() => {
      if (queue?.idle)
        void queue.enqueue({ type: "heartbeat" }).catch(() => {});
      queue?.checkTimeout();
    }, 500);
    // The network is back, or the page is: try now, not after the wait.
    const wake = () => {
      if (!document.hidden) retry.current.wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      link.current = null;
      retry.current.cancel();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      clearTimeout(deadline);
      clearInterval(heartbeat);
      queue?.close();
      socket.close();
      dispatcher.current = () =>
        Promise.reject(Error("Enable screen control first."));
    };
  }, [peer.url, peer.token, connected, display, attempt]);
  return {
    ready,
    // Between a dropped connection and the next: control is still on.
    reconnecting,
    typing,
    probe,
    // A text field under this point, known before the tap: only from a map
    // made after the last input that could have moved things.
    fieldAt: (point: { x: number; y: number }) => {
      const map = fieldMap.current;
      if (!map || map.after < lastChange.current) return null;
      return (
        map.fields.find(
          (f) => point.x >= f.x && point.x <= f.x + f.w && point.y >= f.y && point.y <= f.y + f.h,
        ) ?? null
      );
    },
    // The Mac said no field where the map had one: stop trusting it until the next.
    forgetFields: () => {
      fieldMap.current = null;
    },
    initialCursor,
    latency,
    send: (action: DesktopAction) => dispatcher.current(action),
  };
}
