import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  ChevronLeft,
  Keyboard,
  Laptop,
  Loader2,
  Power,
  RotateCcw,
} from "lucide-react";
import { post, type Peer } from "./api";
import { useRemoteScreen } from "./useRemoteScreen";
import { useDesktopInput, type DesktopAction } from "./useDesktopInput";
import type { TextTarget } from "./desktop-input-queue";
import RemoteTyping from "./RemoteTyping";
import TapToType from "./TapToType";
import AppSurface from "./AppSurface";
import AppLogo from "./AppLogo";
import { PausedCover } from "./PauseControl";
import { useViewportBox } from "./useViewportBox";
import { useImmersiveChrome } from "./useImmersiveChrome";
import {
  keepSnapshot,
  phoneViewport,
  portrait,
  quitThread,
  rotateThread,
  snapshotOf,
  threadFields,
  toDisplay,
  type AppThread as Thread,
  type Field,
} from "./app-threads";
import "./app-thread.css";

type Point = { x: number; y: number };
type Target = TextTarget & { point?: Point; focusAt?: number };

// One Mac app, full screen on the phone, as if it ran here. It runs on the
// Mac on its own hidden display; this view streams only its window and turns
// touches into clicks, scrolls and typing. Like a video player, the controls
// stay out of the way: touching the app shows a slim bar for a few seconds
// (the touch still reaches the app), then it fades. Control is taken on
// open (opening the app is the intent), unless someone else controls the
// Mac: then this phone watches, says who, and offers Take over when it may.
export default function AppThread({
  peer,
  thread,
  threads,
  onLeave,
  onSwitch,
  onReturn,
  onQuit,
  onReopen,
  onUpdate,
  onStale,
  paused = false,
  owner = false,
  controlKey = "",
  toast,
}: {
  peer: Peer;
  thread: Thread;
  threads: Thread[];
  onLeave: () => void;
  onSwitch: (thread: Thread) => void;
  onReturn: (thread: Thread) => void;
  onQuit: (thread: Thread) => void;
  onReopen: (thread: Thread) => void;
  onUpdate: (thread: Thread) => void;
  // The stream ended for good (the app went back or quit): refresh threads.
  onStale?: () => void;
  // Reach is paused on the Mac: the app waits there until Resume, then
  // comes back here by itself.
  paused?: boolean;
  owner?: boolean;
  // Changes when screen control changes hands (the live connection's
  // `changes.control`): a watching phone tries again then.
  controlKey?: string;
  toast?: (message: string) => void;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!document.hidden);
  // Control belongs to one thread: a switch starts without it, so input
  // never connects to the new app's display on a stale grant.
  const [controlFor, setControlFor] = useState<string | null>(null);
  const control = controlFor === thread.id;
  const [failures, setFailures] = useState(0);
  // Someone else controls the Mac: who, whether this phone may take over,
  // and the control key it was told under (a new key means try again).
  const [watching, setWatching] = useState<{
    name: string;
    canTakeOver: boolean;
    key: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [asking, setAsking] = useState<number | null>(null);
  const [typingTarget, setTypingTarget] = useState<Target | null>(null);
  const typingRef = useRef<Target | null>(null);
  typingRef.current = typingTarget;
  const typingEpoch = useRef(0);
  const tapSerial = useRef(0);
  const typingEditor = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const fields = useRef<Field[]>([]);
  const running =
    thread.state === "running" && !!thread.display && !!thread.region;
  const display = thread.display || "primary";
  const stream = useRemoteScreen(
    peer,
    running,
    visible,
    display,
    "auto",
    0,
    false,
    thread.id,
  );
  const ended = useCallback(() => {
    setControlFor(null);
    setFailures((n) => n + 1);
  }, []);
  const input = useDesktopInput(
    peer,
    control && running && visible,
    display,
    ended,
  );
  useViewportBox(shell, true);
  useEffect(() => {
    if (stream.error) onStale?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.error]);
  useEffect(() => {
    // Hidden, the input connection closes and the Mac drops control; take
    // it again on return instead of failing with a stale grant.
    const changed = () => {
      setVisible(!document.hidden);
      if (document.hidden) setControlFor(null);
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  // Take control as soon as the app is up; after a dropped connection, try
  // again a few times before saying so.
  useEffect(() => {
    if (!running || !visible || control) return;
    if (watching && watching.key === controlKey) return;
    if (failures >= 3) {
      setError("Controls disconnected. Tap Retry.");
      return;
    }
    let cancelled = false;
    const id = thread.id;
    const timer = setTimeout(
      async () => {
        try {
          await post(peer, "/api/screen/control", { enabled: true });
          if (!cancelled) {
            setControlFor(id);
            setWatching(null);
            setError("");
          }
        } catch (e) {
          if (cancelled) return;
          const answer = (e as { status?: number; body?: { holder?: { name?: string }; canTakeOver?: boolean } });
          // Someone else controls: watch, never fight for it.
          if (answer.status === 409 && answer.body?.holder) {
            setWatching({
              name: answer.body.holder.name || "Someone",
              canTakeOver: !!answer.body.canTakeOver,
              key: controlKey,
            });
            setError("");
            return;
          }
          setError((e as Error).message);
          setFailures((n) => n + 1);
        }
      },
      failures ? 600 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [running, visible, control, failures, watching, controlKey, thread.id, peer.url, peer.token]);
  const takeOver = async () => {
    try {
      await post(peer, "/api/screen/control", { enabled: true, takeover: true });
      setFailures(0);
      setControlFor(thread.id);
      setWatching(null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Working controls clear any earlier failures.
  useEffect(() => {
    if (!input.ready) return;
    setFailures(0);
    setError("");
  }, [input.ready]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  // A new app starts with its own text fields.
  useEffect(() => {
    fields.current = [];
    setAsking(null);
  }, [thread.id]);
  // Leaving or switching keeps the last frame for "On your phone", taken
  // before the view goes (React detaches the canvas before effect cleanups).
  const snapshot = () => {
    if (stream.ready) keepSnapshot(thread.id, stream.canvas.current);
  };
  const leave = () => {
    snapshot();
    onLeave();
  };
  const switchTo = (next: Thread) => {
    snapshot();
    onSwitch(next);
  };
  // Leaving keeps the app running on the Mac; the phone just lets go.
  const latest = useRef(peer);
  latest.current = peer;
  useEffect(
    () => () => {
      void post(latest.current, "/api/screen/control", {
        enabled: false,
      }).catch(() => {});
    },
    [],
  );
  // Turning the phone reshapes the app's window. Smaller changes, such as
  // Safari's toolbar collapsing, are letterboxed instead.
  const shape = useRef(portrait(phoneViewport()));
  useEffect(() => {
    // Only the owner reshapes the window; a guest's phone letterboxes it.
    if (!running || !owner) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const size = phoneViewport();
        if (portrait(size) === shape.current) return;
        shape.current = portrait(size);
        try {
          onUpdate(await rotateThread(peer, thread.id, size));
        } catch (e) {
          setError((e as Error).message);
        }
      }, 350);
    };
    window.addEventListener("resize", changed);
    window.addEventListener("orientationchange", changed);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", changed);
      window.removeEventListener("orientationchange", changed);
    };
  }, [running, owner, thread.id, peer.url, peer.token, onUpdate]);

  const usable = control && input.ready && stream.ready;
  // Where the window's text fields are, refreshed shortly after each
  // gesture settles, so tapping one can open the keyboard in the same tap.
  const fieldsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const currentThread = useRef(thread.id);
  currentThread.current = thread.id;
  const refreshFields = useCallback(
    (delay = 400) => {
      clearTimeout(fieldsTimer.current);
      fieldsTimer.current = setTimeout(() => {
        const id = thread.id;
        threadFields(peer, id)
          .then((result) => {
            if (id === currentThread.current) fields.current = result.fields;
          })
          .catch(() => {});
      }, delay);
    },
    [peer.url, peer.token, thread.id],
  );
  useEffect(() => {
    if (usable) refreshFields(0);
    return () => clearTimeout(fieldsTimer.current);
  }, [usable, refreshFields]);
  const send = (action: DesktopAction) => {
    if (!usable) return Promise.reject(Error("Connecting to the app…"));
    if (
      action.type === "click" ||
      action.type === "key" ||
      action.phase === "ended" ||
      action.momentum === "ended"
    )
      refreshFields();
    return input.send(action);
  };
  const windowPoint = (point: Point) => {
    const region = thread.region!,
      size = thread.size!;
    return {
      x: point.x * size.w - region.x,
      y: point.y * size.h - region.y,
    };
  };
  const fieldAround = (x: number, y: number) =>
    fields.current.find(
      (f) =>
        x >= f.x - 4 &&
        x <= f.x + f.w + 4 &&
        y >= f.y - 4 &&
        y <= f.y + f.h + 4,
    );
  const clearTyping = () => {
    typingEpoch.current++;
    setTypingTarget(null);
  };
  // A known text field opens the keyboard within the tap itself.
  const typeInField = (point: Point) => {
    const at = windowPoint(point);
    const field = fieldAround(at.x, at.y);
    if (!field || !thread.region) return;
    flushSync(() => {
      typingEpoch.current++;
      setTypingTarget({
        editable: true,
        secure: field.secure,
        point,
        focusAt: at.y / thread.region!.h,
      });
    });
    typingEditor.current?.focus({ preventScroll: true });
  };
  // Every tap also asks the Mac what it focused: that confirms the field
  // (and guards typing to it), closes a keyboard opened for something that
  // turned out not to be a field, or offers "Tap to type" for fields the map
  // didn't know yet.
  const detectTyping = async (point: Point) => {
    if (!input.typing) return;
    const tap = ++tapSerial.current;
    await new Promise((resolve) => setTimeout(resolve, 35));
    if (tap !== tapSerial.current) return;
    try {
      const result = await send({ type: "focus", ...point });
      if (tap !== tapSerial.current) return;
      const target = result.target;
      const current = typingRef.current;
      if (current?.point === point) {
        if (target?.editable) setTypingTarget({ ...current, ...target });
        else clearTyping();
      } else if (target?.editable && target.focus) {
        typingEpoch.current++;
        setTypingTarget({
          ...target,
          point,
          focusAt: windowPoint(point).y / thread.region!.h,
        });
      }
    } catch {
      /* Apps without accessible fields keep the keyboard button. */
    }
  };
  // Must run inside the tap: iOS only opens the keyboard then.
  const openKeyboard = () => {
    if (typingTarget && typingEditor.current) {
      typingEditor.current.focus({ preventScroll: true });
      return;
    }
    flushSync(() => {
      clearTyping();
      setTypingTarget({ editable: true });
    });
    typingEditor.current?.focus({ preventScroll: true });
  };
  const quit = async (confirm = false) => {
    try {
      const result = await quitThread(peer, thread.id, confirm);
      if ("confirm" in result) {
        setAsking(result.others);
        return;
      }
      setAsking(null);
      if (result.waiting)
        setNotice(`${thread.name} is asking something before it quits.`);
      else onQuit(thread);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const others = threads.filter(
    (t) => t.id !== thread.id && t.state === "running",
  );
  const typing = !!typingTarget && usable;
  const shot = snapshotOf(thread.id);
  const closed = thread.state === "closed";
  // Held by a pause that has ended: on its way back from the Mac.
  const returning = !!thread.held && !paused;
  const gone = !running && !closed && thread.state !== "starting" && !returning;
  // Shown on open and after any touch, then faded; kept up while asking.
  const chrome = useImmersiveChrome(
    shell,
    running && !typing,
    asking !== null || !usable,
  );

  return createPortal(
    <div
      ref={shell}
      className={`app-thread ${typing ? "typing" : ""}`}
      role="dialog"
      aria-label={thread.name}
    >
      <div className="app-thread-stage">
        {running && (
          <AppSurface
            canvas={stream.canvas}
            width={stream.width || thread.region!.w}
            height={stream.height || thread.region!.h}
            ready={usable}
            map={(u, v) => toDisplay(thread, u, v)}
            regionWidth={thread.region!.w}
            send={send}
            onTap={(point) => void detectTyping(point)}
            fieldAt={(u, v) =>
              !!fieldAround(u * thread.region!.w, v * thread.region!.h)
            }
            onField={typeInField}
            latency={input.latency}
            typing={typing}
            focus={typingTarget?.focusAt}
          />
        )}
        {(!stream.ready || !running) && (
          <div className="app-thread-cover">
            {shot && <img src={shot} alt="" />}
            {paused && !running ? (
              <PausedCover
                peer={peer}
                platform="darwin"
                owner={owner}
                toast={toast}
              >
                <button className="button secondary small" onClick={leave}>
                  Back to Reach
                </button>
              </PausedCover>
            ) : (
              <div className="app-thread-status" role="status">
                {closed || gone ? (
                  <>
                    <p>
                      {closed
                        ? `${thread.name}'s window was closed on the Mac.`
                        : `${thread.name} is back on the Mac.`}
                    </p>
                    <button
                      className="button primary"
                      onClick={() => onReopen(thread)}
                    >
                      <RotateCcw size={16} /> Open again
                    </button>
                    <button className="button secondary" onClick={leave}>
                      Back to Reach
                    </button>
                  </>
                ) : (
                  <>
                    <AppLogo
                      peer={peer}
                      appId={thread.appId}
                      name={thread.name}
                      size={64}
                    />
                    <Loader2 className="spin" size={20} />
                    <span>{stream.error || `Opening ${thread.name}…`}</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {(error || notice) && running && (
          <div className="app-thread-error" role="alert">
            <span>{error || notice}</span>
            {failures >= 3 && (
              <button
                className="button secondary small"
                onClick={() => {
                  setFailures(0);
                  setError("");
                }}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {watching && !control && running && (
          <div className="app-thread-watching" role="status">
            <span>
              <b>{watching.name}</b> is controlling · you’re watching
            </span>
            {watching.canTakeOver && (
              <button className="button secondary small" onClick={() => void takeOver()}>
                Take over
              </button>
            )}
          </div>
        )}
        {typing && typingTarget && (
          <TapToType
            key={`tap:${typingEpoch.current}`}
            editorRef={typingEditor}
          />
        )}
        {running && !typing && (
          <div
            className={`app-thread-bar ${chrome ? "" : "hidden"}`}
            role="toolbar"
            aria-label="App controls"
            aria-hidden={!chrome}
            inert={!chrome}
            data-immersive-keep
          >
            {asking !== null ? (
              <div className="app-thread-confirm" role="alertdialog">
                <p>
                  {thread.name} also has {asking}{" "}
                  {asking === 1 ? "window" : "windows"} on your Mac. Quit it
                  anyway?
                </p>
                <button
                  className="button primary small"
                  onClick={() => void quit(true)}
                >
                  Quit {thread.name}
                </button>
                <button
                  className="button secondary small"
                  onClick={() => setAsking(null)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  className="app-thread-icon"
                  aria-label="Back to Reach"
                  onClick={leave}
                >
                  <ChevronLeft size={24} />
                </button>
                <span className="app-thread-title">
                  <AppLogo
                    peer={peer}
                    appId={thread.appId}
                    name={thread.name}
                    size={24}
                  />
                  <span>{thread.name}</span>
                </span>
                {others.map((t) => (
                  <button
                    key={t.id}
                    className="app-thread-icon"
                    aria-label={`Switch to ${t.name}`}
                    onClick={() => switchTo(t)}
                  >
                    <AppLogo
                      peer={peer}
                      appId={t.appId}
                      name={t.name}
                      size={26}
                    />
                  </button>
                ))}
                <button
                  className="app-thread-icon"
                  aria-label="Open phone keyboard"
                  disabled={!usable}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={openKeyboard}
                >
                  <Keyboard size={20} />
                </button>
                <button
                  className="app-thread-icon"
                  aria-label={`Return ${thread.name} to the Mac`}
                  onClick={() => onReturn(thread)}
                >
                  <Laptop size={20} />
                </button>
                <button
                  className="app-thread-icon quit"
                  aria-label={`Quit ${thread.name}`}
                  onClick={() => void quit(false)}
                >
                  <Power size={19} />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {typing && typingTarget && (
        <RemoteTyping
          key={`typing:${typingEpoch.current}`}
          target={typingTarget}
          keyRow
          editorRef={typingEditor}
          send={send}
          onClose={clearTyping}
          onError={setError}
        />
      )}
    </div>,
    document.body,
  );
}
