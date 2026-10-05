import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Monitor,
  Play,
  Pause,
  RefreshCw,
  MousePointer2,
  Keyboard,
  Maximize,
  Minimize,
  Clipboard,
  Copy,
  ShieldCheck,
  MoreHorizontal,
  Command,
  X,
  ClipboardPaste,
} from "lucide-react";
import { pasteFromPhone } from "./phone-paste";
import { Device, Peer, post, request } from "./api";
import { Empty, ErrorLine, PageTitle } from "./ui";
import { useRemoteScreen } from "./useRemoteScreen";
import { useDesktopInput, type DesktopAction } from "./useDesktopInput";
import QuickLauncher from "./QuickLauncher";
import ScreenPopup from "./ScreenPopup";
import RemoteTyping from "./RemoteTyping";
import ScreenActions, { type ScreenAction } from "./ScreenActions";
import { copyRemoteSelection } from "./remote-copy";
import type { TextTarget } from "./desktop-input-queue";
import DesktopSurface from "./DesktopSurface";
import { useScreenPresentation } from "./useScreenPresentation";
import { useImmersiveChrome } from "./useImmersiveChrome";
import NativeRemoteTyping from "./NativeRemoteTyping";
import ScrollHandle from "./ScrollHandle";
import { useAppContext } from "./useAppContext";
import { allCommands, contextPicks, type ContextAction } from "./app-context";
import { AppCommandList } from "./AppCommands";
import TapToType from "./TapToType";
import { nativeKeyboard } from "./remote-keyboard";
import { PausedCover } from "./PauseControl";
import { controlIn, isPausedMessage, pausedIn } from "./pause";
import "./screen-immersive.css";
import "./screen-ask.css";
import { MacPasswordField } from "./NeedsYou";
type Display = {
  id: string;
  name: string;
  primary: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
};
type Props = {
  peer: Peer;
  device: Device;
  toast: (s: string) => void;
  onChanged: () => void;
  // The computer's change fingerprints: they say at once when it's paused.
  changes?: string;
  // Opened on a Mac dialog to answer (a "Show on screen" card): where it is,
  // whether it's still up, and its System Settings page.
  ask?: ScreenAsk | null;
  onAskDone?: () => void;
  onAskSetting?: () => Promise<string>;
  // The Mac's password for a password dialog (typed only into it).
  onAskPassword?: (password: string) => Promise<unknown>;
};
export type ScreenAsk = {
  id: string;
  // A password dialog is answered by typing (a password keyboard here).
  kind?: "privacy" | "security" | "password";
  title: string;
  bounds?: { x: number; y: number; width: number; height: number };
  open: boolean;
  setting?: { name: string; url: string };
};
export default function Screen({
  peer,
  device,
  toast,
  onChanged,
  changes,
  ask = null,
  onAskDone,
  onAskSetting,
  onAskPassword,
}: Props) {
  const scopes = device.access?.scopes;
  const enabled = device.capabilities.screen,
    // You (setup, permissions), and who may control: you, or someone you
    // invited with screen control.
    owner =
      !device.access ||
      (!!scopes?.includes("admin") && device.access.kind !== "guest"),
    canControl =
      !device.access ||
      !!scopes?.includes("admin") ||
      !!scopes?.includes("screen:control");
  const [live, setLive] = useState(enabled),
    [visible, setVisible] = useState(!document.hidden),
    [control, setControl] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Someone else controls the screen (who, and whether this phone may take
  // over); cleared when control changes hands.
  const [holder, setHolder] = useState<{ name: string; canTakeOver: boolean } | null>(null);
  const [displays, setDisplays] = useState<Display[]>([]),
    [display, setDisplay] = useState("primary"),
    [quality] = useState("auto"),
    [compatibility, setCompatibility] = useState(false),
    [revision, setRevision] = useState(0);
  const [mode, setMode] = useState("direct"),
    [drag, setDrag] = useState(false),
    [clickMode, setClickMode] = useState("left"),
    [feedback, setFeedback] = useState("");
  const [clipboard, setClipboard] = useState(""),
    [clipboardBusy, setClipboardBusy] = useState(false);
  const [panel, setPanel] = useState<
    "clipboard" | "more" | "actions" | null
  >(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const helperPending = useRef(false);
  const [typingTarget, setTypingTarget] = useState<
    | (TextTarget & {
        point?: { x: number; y: number };
        // Opened on the tap itself (the Mac said a field was there).
        opened?: boolean;
      })
    | null
  >(null);
  const typingRef = useRef(typingTarget);
  typingRef.current = typingTarget;
  const typingEpoch = useRef(0);
  const typingEditor = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const clearTyping = () => {
    typingEpoch.current++;
    setTypingTarget(null);
  };
  const viewer = useRef<HTMLElement>(null),
    intent = useRef(false),
    mounted = useRef(true);
  const release = useCallback(() => {
    intent.current = false;
    typingEpoch.current++;
    setTypingTarget(null);
    setControl(false);
    setDrag(false);
    setPanel(null);
    if (canControl)
      void post(peer, "/api/screen/control", { enabled: false }).catch(
        () => {},
      );
  }, [peer.url, peer.token, canControl]);
  // Paused on the computer: no stream and no control until Resume, when
  // both come back (control only if it was on).
  const paused = pausedIn(changes, device);
  const controlKey = controlIn(changes);
  useEffect(() => {
    setHolder((was) => {
      if (was) setError("");
      return null;
    });
  }, [controlKey]);
  const controlBeforePause = useRef(false);
  const ended = useCallback(
    (message: string) => {
      if (isPausedMessage(message)) controlBeforePause.current = true;
      else setError(message);
      release();
    },
    [release],
  );
  const stream = useRemoteScreen(
    peer,
    enabled,
    live && visible && !paused,
    display,
    quality,
    revision,
    compatibility,
  );
  const input = useDesktopInput(
    peer,
    control && live && visible,
    stream.selectedDisplay || display,
    ended,
  );
  const usable =
    control &&
    input.ready &&
    stream.ready &&
    live &&
    visible &&
    Date.now() - stream.updated < 10000;
  const send = async (action: DesktopAction) => {
    if (!usable && action.type !== "release")
      throw Error("Wait for a fresh screen and enable control.");
    return input.send(action);
  };
  const detectTyping = async (point: { x: number; y: number }) => {
    if (!input.typing) return;
    const epoch = typingEpoch.current;
    // Let the desktop process its click before querying focus. No polling on moves.
    await new Promise((resolve) => setTimeout(resolve, 35));
    if (epoch !== typingEpoch.current || !mounted.current) return;
    try {
      let result = await send({ type: "focus", ...point });
      // Electron/web editors can publish their focused accessibility field
      // just after the click. Retry briefly, without ever sending unguarded text.
      for (const delay of [80, 160]) {
        if (result.target?.editable || !typingRef.current?.pending) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (epoch !== typingEpoch.current || !mounted.current) return;
        result = await send({ type: "focus", ...point });
      }
      const current = typingRef.current;
      if (
        epoch === typingEpoch.current &&
        mounted.current &&
        current?.opened &&
        current.point === point
      ) {
        // Opened on the tap: keep that keyboard, now guarded to this field.
        if (result.target?.editable && result.target.focus)
          setTypingTarget({ ...current, ...result.target, pending: false });
        else clearTyping();
        return;
      }
      if (
        epoch === typingEpoch.current &&
        mounted.current &&
        result.target?.editable &&
        result.target.focus
      ) {
        setTypingTarget({ ...result.target, point });
        setFeedback("");
      }
    } catch {
      if (epoch === typingEpoch.current && typingRef.current?.pending) clearTyping();
      /* Older hosts and unsupported apps retain the manual keyboard. */
    }
  };
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      setVisible(!document.hidden);
      if (document.hidden) release();
    };
    const leave = () => {
      intent.current = false;
      void fetch(peer.url + "/api/screen/control", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${peer.token}`,
          "Content-Type": "application/json",
        },
        body: '{"enabled":false}',
        keepalive: true,
        redirect: "error",
      }).catch(() => {});
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      if (canControl) leave();
    };
  }, [release, peer.url, peer.token, canControl]);
  useEffect(() => {
    if (!enabled) {
      release();
      setLive(false);
    }
  }, [enabled, release]);
  useEffect(() => {
    if (stream.error) {
      release();
      setLive(false);
    }
  }, [stream.error, release]);
  const loadDisplays = useCallback(async () => {
    if (!enabled) return;
    try {
      const result = await request<{ displays: Display[] }>(
        peer,
        "/api/screen/displays",
      );
      setDisplays(result.displays);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [peer.url, peer.token, enabled]);
  useEffect(() => {
    void loadDisplays();
  }, [loadDisplays]);
  const typing = !!typingTarget && usable && !panel;
  const { fullscreen, expanded, mobile, toggleFullscreen } =
    useScreenPresentation(viewer, typing);
  // Fullscreen hides the bars until the screen is touched; they stay while
  // something needs attention.
  const chromeShown = useImmersiveChrome(
    viewer,
    fullscreen,
    !!panel || typing || !live || !!(error || stream.error) || !stream.ready,
  );
  // Commands for whichever app is in front on the computer.
  const appContext = useAppContext(
    input.send,
    control && input.ready && stream.ready && live && visible && !typing,
  );
  const contextActions = contextPicks(
    device.platform,
    appContext.app,
    appContext.items,
  );
  const runContext = (item: ContextAction) =>
    void runHelper({
      label: item.label,
      keys: item.keys ?? "",
      action: item.action,
    }).then(() => void appContext.refresh());
  const toggleControl = async () => {
    if (control) {
      release();
      return;
    }
    intent.current = true;
    setBusy(true);
    setError("");
    try {
      // Someone else controls: Control becomes Take over (an explicit tap;
      // control never moves silently).
      await post(peer, "/api/screen/control", {
        enabled: true,
        ...(holder?.canTakeOver ? { takeover: true } : {}),
      });
      setHolder(null);
      if (mounted.current && intent.current && !document.hidden)
        setControl(true);
      else release();
    } catch (e) {
      const answer = e as { status?: number; body?: { holder?: { name?: string }; canTakeOver?: boolean } };
      if (answer.status === 409 && answer.body?.holder)
        setHolder({
          name: answer.body.holder.name || "Someone",
          canTakeOver: !!answer.body.canTakeOver,
        });
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  // Opened on a Mac dialog: its display, zoomed onto it, control on (the
  // tap on "Show on screen" asked for it; someone else's control still needs
  // Take over).
  const askBounds = ask?.bounds;
  const askDisplay = askBounds
    ? displays.find((d) => {
        const cx = askBounds.x + askBounds.width / 2,
          cy = askBounds.y + askBounds.height / 2;
        return cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height;
      })
    : undefined;
  const askRect =
    askBounds && askDisplay
      ? {
          x: (askBounds.x - askDisplay.x) / askDisplay.width,
          y: (askBounds.y - askDisplay.y) / askDisplay.height,
          width: askBounds.width / askDisplay.width,
          height: askBounds.height / askDisplay.height,
        }
      : null;
  useEffect(() => {
    if (askDisplay) setDisplay(askDisplay.primary ? "primary" : askDisplay.id);
  }, [ask?.id, askDisplay?.id]);
  const askedControl = useRef<string | null>(null);
  useEffect(() => {
    if (!ask || !enabled || !canControl || control || busy || askedControl.current === ask.id) return;
    askedControl.current = ask.id;
    void toggleControl();
  }, [ask?.id, enabled, canControl, control]);
  const [askSaid, setAskSaid] = useState("");
  // Pause ends control (the computer ends it too); Resume takes it back if
  // it was on, so everything is where it was.
  useEffect(() => {
    if (paused) {
      if (control || intent.current) controlBeforePause.current = true;
      if (control) release();
      return;
    }
    if (controlBeforePause.current) {
      controlBeforePause.current = false;
      if (canControl && !document.hidden) void toggleControl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);
  // A tap on a text field opens the keyboard within that tap, no Type button:
  // the Mac said on touch-down that a field is there.
  const typeInField = (point: { x: number; y: number }, secure: boolean) => {
    flushSync(() => {
      typingEpoch.current++;
      setPanel(null);
      setTypingTarget({ editable: true, secure, point, opened: true, pending: true });
    });
    typingEditor.current?.focus({ preventScroll: true });
  };
  // Must run inside the tap's event handler: iOS only opens the keyboard then.
  const openKeyboard = () => {
    if (typingTarget && typingEditor.current) {
      typingEditor.current.focus({ preventScroll: true });
      return;
    }
    flushSync(() => {
      clearTyping();
      setPanel(null);
      setTypingTarget({ editable: true });
    });
    typingEditor.current?.focus({ preventScroll: true });
  };
  const toggleViewing = async (value: boolean) => {
    setBusy(true);
    setError("");
    if (!value) release();
    try {
      await post(peer, "/api/settings", { screen: value });
      setLive(value);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const action = async (value: DesktopAction) => {
    try {
      await send(value);
      setFeedback("Sent to your laptop");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const runHelper = async (helper: ScreenAction) => {
    if (!usable || helperPending.current) return;
    helperPending.current = true;
    setHelperBusy(true);
    clearTyping();
    setDrag(false);
    setError("");
    setPanel(null);
    try {
      await send(helper.action);
      if (mounted.current) setFeedback(`${helper.label} sent`);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      helperPending.current = false;
      if (mounted.current) setHelperBusy(false);
    }
  };
  const copyAction = async (kind: string) => {
    setClipboardBusy(true);
    setError("");
    try {
      if (kind === "read") {
        const result = await send({ type: "clipboard-read" });
        setClipboard(result.text || "");
        setFeedback("Laptop clipboard received");
      }
      if (kind === "write") {
        await send({ type: "clipboard-write", text: clipboard });
        setFeedback("Laptop clipboard updated");
      }
      if (kind === "phone") {
        setClipboard(await navigator.clipboard.readText());
      }
      if (kind === "copy") {
        await navigator.clipboard.writeText(clipboard);
        setFeedback("Copied to this device");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClipboardBusy(false);
    }
  };
  // One tap: what's on this phone lands where the cursor is on the computer.
  const pastePhone = async () => {
    // Read inside the tap: phones refuse a clipboard read that comes later.
    const reading = navigator.clipboard?.readText?.();
    if (!reading) {
      clearTyping();
      setPanel("clipboard");
      return;
    }
    setClipboardBusy(true);
    setError("");
    try {
      const done = await pasteFromPhone(reading, send, device.platform);
      if (mounted.current)
        setFeedback(
          done === "pasted" ? "Pasted from your phone" : "Nothing to paste on this phone",
        );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setClipboardBusy(false);
    }
  };
  const copySelectedText = async () => {
    setClipboardBusy(true);
    setError("");
    try {
      const result = await copyRemoteSelection(
        async () => (await send({ type: "selection-read" })).text || "",
      );
      if (!mounted.current) return;
      if (result.copied) setFeedback("Selection copied to your phone");
      else {
        clearTyping();
        setClipboard(result.text);
        setPanel("clipboard");
        setFeedback("Hold the selected text to copy it");
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setClipboardBusy(false);
    }
  };
  const reconnect = () => {
    release();
    setLive(true);
    setRevision((n) => n + 1);
    setError("");
    void loadDisplays();
  };
  return (
    <>
      <PageTitle
        eyebrow={device.name}
        title="Your screen"
        description="Pick up where you left off."
      />
      <ErrorLine error={paused ? "" : error || stream.error} />
      {!enabled ? (
        <section className="panel screen-setup">
          {ask && (
            <div className="screen-ask" role="status">
              <strong>{ask.title}</strong>
              <span>Screen viewing is off. Enable it to inspect the dialog. If Reach needs Screen Recording or Accessibility access, grant it on the Mac first.</span>
              <div className="screen-ask-actions"><button onClick={onAskDone}>Back to request</button></div>
            </div>
          )}
          <Empty
            icon={Monitor}
            title="Your computer, right here"
            action={
              owner && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void toggleViewing(true)}
                >
                  View screen
                </button>
              )
            }
          >
            Enable screen viewing on this computer to begin.
          </Empty>
        </section>
      ) : (
        <section
          ref={viewer}
          className={`panel screen-viewer remote-viewer simple-screen ${expanded ? "screen-expanded" : ""} ${typing ? "screen-typing" : ""} ${fullscreen ? "screen-immersive" : ""} ${chromeShown ? "" : "chrome-hidden"}`}
        >
          <div className="screen-toolbar simple-screen-toolbar">
            <span className="screen-state" role="status">
              <span
                className={`screen-status-dot ${live && stream.ready ? "active" : ""}`}
              />
              {!live || paused
                ? "Paused"
                : stream.connecting
                  ? "Connecting…"
                  : stream.ready
                    ? device.name
                    : "Connecting…"}
            </span>
            <div
              className="simple-screen-actions"
              onPointerDown={(event) => {
                if (typing) event.preventDefault();
              }}
            >
              <button
                className="icon-button"
                aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
              <button
                className="icon-button"
                aria-label="Screen options"
                onClick={() => {
                  clearTyping();
                  setPanel("more");
                }}
              >
                <MoreHorizontal size={21} />
              </button>
            </div>
          </div>
          {expanded && (
            <ErrorLine error={paused ? "" : error || stream.error} />
          )}
          {ask && (
            <div className={`screen-ask ${ask.open ? "" : "done"}`} role="status">
              {ask.open && ask.kind === "password" ? (
                <>
                  <strong>{ask.title}</strong>
                  <span>Enter it here: Reach types it only into that dialog. It isn't kept.</span>
                  {onAskPassword && <MacPasswordField placeholder="Your Mac's password" submit={onAskPassword} />}
                  <div className="screen-ask-actions">
                    <button onClick={onAskDone}>Done</button>
                  </div>
                </>
              ) : ask.open ? (
                <>
                  <strong>{ask.title}</strong>
                  <span>Tap its button on the screen below to answer it.</span>
                  <small>{askSaid || "If viewing or control is unavailable, or macOS blocks the click, approve on the Mac itself."}</small>
                  <div className="screen-ask-actions">
                    {ask.setting && onAskSetting && (
                      <button
                        onClick={() =>
                          void onAskSetting().then(setAskSaid, (e: Error) => setAskSaid(e.message))
                        }
                      >
                        Open setting on Mac
                      </button>
                    )}
                    <button onClick={onAskDone}>Done</button>
                  </div>
                </>
              ) : (
                <>
                  <strong>Dialog closed</strong>
                  <span>This request is no longer visible on your Mac.</span>
                  <div className="screen-ask-actions">
                    <button className="primary" onClick={onAskDone}>
                      Back
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <DesktopSurface
            focusRect={askRect}
            canvas={stream.canvas}
            width={stream.width}
            height={stream.height}
            ready={stream.ready}
            connecting={
              live && visible && !paused && !stream.ready && !stream.error
            }
            canControl={usable}
            initialCursor={input.initialCursor}
            mode={mode}
            drag={drag}
            clickMode={clickMode}
            send={send}
            onDragEnd={() => setDrag(false)}
            onFeedback={setFeedback}
            onInteraction={clearTyping}
            onTextTarget={(point) => void detectTyping(point)}
            {...(input.probe && {
              probe: (point: { x: number; y: number }) =>
                send({ type: "probe", ...point }),
              onField: typeInField,
            })}
            resetKey={`${display}:${revision}`}
            compact
            typing={typing}
            focusPoint={typing && mobile ? typingTarget?.point : undefined}
            idle={
              paused && (
                <PausedCover
                  peer={peer}
                  platform={device.platform}
                  owner={owner}
                  toast={toast}
                />
              )
            }
          />
          {control && stream.ready && !typing && !panel && (
            <ScrollHandle send={send} disabled={!usable} />
          )}
          {typing && typingTarget && (
            nativeKeyboard ? (
              !typingTarget.pending && <NativeRemoteTyping
                key={`${typingTarget.opened ? "tap" : typingTarget.focus}:${typingEpoch.current}`}
                target={typingTarget}
                send={send}
                onClose={clearTyping}
                onError={setError}
              />
            ) : (
              <RemoteTyping
                key={`${typingTarget.opened ? "tap" : typingTarget.focus}:${typingEpoch.current}`}
                target={typingTarget}
                keyRow={mobile}
                modifier={device.platform === "win32" ? "control" : "meta"}
                editorRef={typingEditor}
                send={send}
                onClose={clearTyping}
                onError={setError}
              />
            )
          )}
          {typing && typingTarget && !typingTarget.opened && !nativeKeyboard && mobile && (
            // Its own key: a sibling sharing RemoteTyping's key made React
            // duplicate the keyboard field and key row, and reset the field
            // between keystrokes (each next letter then deleted the last).
            <TapToType
              key={`tap:${typingTarget.focus}:${typingEpoch.current}`}
              editorRef={typingEditor}
            />
          )}
          <div className="simple-screen-dock">
            <span className="simple-screen-caption" role="status">
              {feedback || (control && !input.ready ? "Connecting controls…" : "")}
            </span>
            {control && (
              <>
                {!input.probe && <button
                  className="button primary small keyboard-button"
                  aria-label="Open phone keyboard"
                  onPointerDown={(event) => event.preventDefault()}
                  disabled={!usable}
                  onClick={openKeyboard}
                >
                  <Keyboard size={17} />
                  Type
                </button>}
                <button
                  className="button secondary small paste-button"
                  aria-label="Paste from your phone"
                  onPointerDown={(event) => event.preventDefault()}
                  disabled={!usable || clipboardBusy}
                  onClick={() => void pastePhone()}
                >
                  <ClipboardPaste size={16} />
                  Paste
                </button>
                {typing && (
                  <button
                    className="icon-button"
                    aria-label="Dismiss phone keyboard"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      typingEditor.current?.blur();
                      clearTyping();
                    }}
                  >
                    <X size={19} />
                  </button>
                )}
              </>
            )}
            {!typing &&
              !paused &&
              (control || (canControl && device.capabilities.apps)) && (
                <button
                  className="button secondary small screen-actions-trigger"
                  onPointerDown={(event) => event.preventDefault()}
                  disabled={control && (!usable || helperBusy)}
                  aria-haspopup="dialog"
                  onClick={() => {
                    clearTyping();
                    setPanel("actions");
                  }}
                >
                  <Command size={16} /> Shortcuts
                </button>
              )}
            {canControl && !typing && !paused && (
              <button
                className={`button ${control ? "secondary" : "primary"} small`}
                disabled={!stream.ready || busy || !live}
                onClick={() => void toggleControl()}
              >
                <MousePointer2 size={15} />
                {control ? "Stop" : holder?.canTakeOver ? "Take over" : "Control"}
              </button>
            )}
            {!live && !paused && (
              <button className="button primary small" onClick={reconnect}>
                Resume
              </button>
            )}
          </div>
          {fullscreen && !chromeShown && canControl && (
            <div
              className="screen-immersive-pill"
              data-immersive-keep
              onPointerDown={(event) => event.preventDefault()}
            >
              {control && !input.probe && (
                <button
                  aria-label="Open phone keyboard"
                  disabled={!usable}
                  onClick={openKeyboard}
                >
                  <Keyboard size={18} />
                  Type
                </button>
              )}
              {control && (
                <button
                  aria-label="Paste from your phone"
                  disabled={!usable || clipboardBusy}
                  onClick={() => void pastePhone()}
                >
                  <ClipboardPaste size={17} />
                  Paste
                </button>
              )}
              <button
                aria-label={control ? "Stop controlling" : "Control your computer"}
                aria-pressed={control}
                disabled={!stream.ready || busy || !live}
                onClick={() => void toggleControl()}
              >
                <MousePointer2 size={17} />
                {control ? "Stop" : holder?.canTakeOver ? "Take over" : "Control"}
              </button>
            </div>
          )}
          {panel && (
            <ScreenPopup
              title={
                panel === "clipboard"
                  ? "Clipboard"
                  : panel === "actions"
                    ? "Shortcuts"
                    : "Screen options"
              }
              onClose={() => setPanel(null)}
            >
              {panel === "actions" && control && appContext.app && (
                <AppCommandList
                  app={appContext.app}
                  picks={contextActions}
                  all={allCommands(device.platform, appContext.items)}
                  disabled={!usable || helperBusy}
                  run={runContext}
                />
              )}
              {panel === "actions" && control && (
                <button className="button secondary" aria-label="Open phone keyboard"
                  disabled={!usable} onClick={openKeyboard}>
                  <Keyboard size={17} /> Keyboard
                </button>
              )}
              {panel === "actions" && control && (
                <ScreenActions
                  platform={device.platform}
                  disabled={!usable || helperBusy}
                  run={(helper) => void runHelper(helper)}
                />
              )}
              {panel === "actions" && canControl && device.capabilities.apps && (
                <section className="screen-open-shortcuts">
                  {control && <h3>Open on {device.name}</h3>}
                  <QuickLauncher
                    peer={peer}
                    onDone={(name) => {
                      setPanel(null);
                      setFeedback(`${name} opened`);
                    }}
                  />
                </section>
              )}
              {panel === "clipboard" && <ErrorLine error={error} />}
              {panel === "clipboard" && control && (
                <>
                  <div className="remote-clipboard">
                    <strong>
                      <Clipboard size={16} />
                      Clipboard · text only
                    </strong>
                    <p>
                      Transfer only when you choose. Clipboard contents aren’t
                      saved by Reach.
                    </p>
                    <textarea
                      aria-label="Clipboard text"
                      value={clipboard}
                      maxLength={16384}
                      onChange={(e) => setClipboard(e.target.value)}
                      placeholder="Clipboard preview"
                    />
                    <div className="screen-key-row">
                      <button
                        className="button secondary small"
                        disabled={!usable || clipboardBusy}
                        onClick={() => void copyAction("read")}
                      >
                        Get laptop clipboard
                      </button>
                      <button
                        className="button secondary small"
                        disabled={clipboardBusy || !navigator.clipboard}
                        onClick={() => void copyAction("copy")}
                      >
                        Copy to this device
                      </button>
                      <button
                        className="button secondary small"
                        disabled={
                          clipboardBusy || !navigator.clipboard?.readText
                        }
                        onClick={() => void copyAction("phone")}
                      >
                        Read this device’s clipboard
                      </button>
                      <button
                        className="button primary small"
                        disabled={!usable || clipboardBusy}
                        onClick={() => void copyAction("write")}
                      >
                        Send to laptop clipboard
                      </button>
                      <button
                        className="button secondary small"
                        onClick={() => setClipboard("")}
                      >
                        Clear preview
                      </button>
                    </div>
                  </div>
                </>
              )}
              {panel === "more" && (
                <>
                  <p className="screen-popup-hint">
                    Pinch to zoom. Hold and move over text to select it, then
                    tap Copy selected text. Keys and app commands are in
                    Shortcuts.
                  </p>
                  {control && (
                    <div className="screen-key-row">
                      <button
                        className="button secondary small"
                        disabled={!usable || clipboardBusy}
                        onClick={() => {
                          setPanel(null);
                          void copySelectedText();
                        }}
                      >
                        <Copy size={16} /> Copy selected text
                      </button>
                      <button
                        className="button secondary small"
                        onClick={() => setPanel("clipboard")}
                      >
                        <Clipboard size={16} /> Clipboard transfers
                      </button>
                    </div>
                  )}
                  {displays.length > 1 && (
                    <label className="screen-option">
                      Display
                      <select
                        aria-label="Display"
                        value={display}
                        onChange={(e) => {
                          release();
                          setDisplay(e.target.value);
                          setFeedback("");
                        }}
                      >
                        <option value="primary">Main display</option>
                        {displays.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {canControl && (
                    <>
                      <div className="remote-touch-controls">
                        <label>
                          Touch mode
                          <select
                            aria-label="Touch mode"
                            value={mode}
                            onChange={(e) => {
                              void input
                                .send({ type: "release" })
                                .catch(() => {});
                              setDrag(false);
                              setMode(e.target.value);
                            }}
                          >
                            <option value="trackpad">Trackpad</option>
                            <option value="direct">Direct touch</option>
                            <option value="pan">Pan & zoom</option>
                          </select>
                        </label>
                        <label>
                          Tap action
                          <select
                            aria-label="Tap action"
                            value={clickMode}
                            onChange={(e) => setClickMode(e.target.value)}
                          >
                            <option value="left">Click</option>
                            <option value="right">Right-click</option>
                            <option value="double">Double-click</option>
                          </select>
                        </label>
                        <button
                          className={`button ${drag ? "primary" : "secondary"} small`}
                          disabled={!usable || mode === "pan"}
                          aria-pressed={drag}
                          onClick={() => {
                            void input
                              .send({ type: "release" })
                              .catch(() => {});
                            setDrag(!drag);
                          }}
                        >
                          {drag ? "Drag armed · touch and move" : "Drag"}
                        </button>
                        <button
                          className="button secondary small"
                          disabled={!usable}
                          onClick={() => void action({ type: "release" })}
                        >
                          Release mouse
                        </button>
                      </div>{" "}
                    </>
                  )}
                  <div className="screen-option-actions">
                    <button
                      className="button secondary small"
                      onClick={() => {
                        if (live) {
                          release();
                          setLive(false);
                        } else reconnect();
                        setPanel(null);
                      }}
                    >
                      {live ? <Pause size={15} /> : <Play size={15} />}{" "}
                      {live ? "Pause" : "Resume"}
                    </button>
                    <button
                      className="button secondary small"
                      onClick={reconnect}
                    >
                      <RefreshCw size={15} />
                      Reconnect
                    </button>
                  </div>
                  <details className="screen-diagnostics">
                    <summary>Connection details</summary>
                    <p>
                      {stream.format === "h264"
                        ? "Video"
                        : "Compatibility video"}{" "}
                      · {stream.fps} fps · {stream.mbps} Mbps
                      {usable ? ` · ${input.latency} ms input` : ""}. Quality
                      adjusts automatically.
                    </p>
                    {stream.fallbackReason && <p>{stream.fallbackReason}</p>}
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={compatibility}
                        onChange={(e) => {
                          release();
                          setCompatibility(e.target.checked);
                        }}
                      />
                      Use compatibility video
                    </label>
                  </details>
                  {owner && (
                    <details className="screen-diagnostics">
                      <summary>Permissions</summary>
                      <p>
                        {device.platform === "darwin"
                          ? "Allow Screen Recording for viewing, and Accessibility for control, in macOS System Settings → Privacy & Security."
                          : "Keep Windows signed in and unlocked. Secure desktops cannot be controlled."}{" "}
                        Control stops when you leave or access expires.
                      </p>
                      <button
                        className="button secondary small"
                        onClick={() => void toggleViewing(false)}
                      >
                        <ShieldCheck size={15} />
                        Turn off screen access
                      </button>
                    </details>
                  )}
                </>
              )}
            </ScreenPopup>
          )}
        </section>
      )}
    </>
  );
}
