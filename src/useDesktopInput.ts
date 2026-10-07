import { useEffect, useRef, useState } from "react";
import type { Peer } from "./api";
import {
  DesktopInputQueue,
  type DesktopAction,
  type InputResult,
} from "./desktop-input-queue";
export type { DesktopAction } from "./desktop-input-queue";
export function useDesktopInput(
  peer: Peer,
  enabled: boolean,
  display: string,
  onEnd: (message: string) => void,
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
  const dispatcher = useRef<(a: DesktopAction) => Promise<InputResult>>(() =>
    Promise.reject(Error("Enable screen control first.")),
  );
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    setReady(false);
    setTyping(false);
    setProbe(false);
    setInitialCursor(null);
    if (!enabled) return;
    const url = new URL("/ws/screen-input", peer.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    let stopped = false,
      failed = false,
      queue: DesktopInputQueue | undefined,
      measured = 0;
    let deadline: ReturnType<typeof setTimeout>;
    const fail = (message: string) => {
      if (stopped || failed) return;
      failed = true;
      clearTimeout(deadline);
      setReady(false);
      queue?.close();
      socket.close();
      end.current(message);
    };
    dispatcher.current = (a) =>
      queue && !failed
        ? queue.enqueue(a)
        : Promise.reject(Error("Desktop input is not connected."));
    deadline = setTimeout(
      () => fail("Desktop input connection timed out. Try Control again."),
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
          fail(m.error);
          return;
        }
        if (m.type === "ready" && !queue) {
          clearTimeout(deadline);
          queue = new DesktopInputQueue(
            (id, action) =>
              socket.send(JSON.stringify({ type: "input", id, action })),
            fail,
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
        if (m.type !== "ack" || !queue)
          throw Error("Invalid input acknowledgment.");
        const ms = queue.acknowledge(m.id, m);
        if (performance.now() - measured > 500) {
          measured = performance.now();
          setLatency(Math.round(ms));
        }
      } catch (e) {
        fail((e as Error).message);
      }
    };
    socket.onerror = () => fail("Desktop input could not connect.");
    socket.onclose = () => fail("Desktop control disconnected.");
    const heartbeat = setInterval(() => {
      if (queue?.idle)
        void queue.enqueue({ type: "heartbeat" }).catch(() => {});
      queue?.checkTimeout();
    }, 500);
    return () => {
      stopped = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      queue?.close();
      socket.close();
      dispatcher.current = () =>
        Promise.reject(Error("Enable screen control first."));
    };
  }, [peer.url, peer.token, enabled, display]);
  return {
    ready,
    typing,
    probe,
    initialCursor,
    latency,
    send: (action: DesktopAction) => dispatcher.current(action),
  };
}
