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
  PanelsTopLeft,
  X,
} from "lucide-react";
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
import DesktopMode from "./DesktopMode";
import { useScreenPresentation } from "./useScreenPresentation";
import { useImmersiveChrome } from "./useImmersiveChrome";
import NativeRemoteTyping from "./NativeRemoteTyping";
import { useAppContext } from "./useAppContext";
import { allCommands, contextPicks, type ContextAction } from "./app-context";
import { AppCommandList, ContextBar } from "./AppCommands";
import TapToType from "./TapToType";
import { isNative } from "./native";
import "./screen-immersive.css";
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
};
export default function Screen({ peer, device, onChanged }: Props) {
  const enabled = device.capabilities.screen,
    owner = !device.access || device.access.scopes.includes("admin");
  const [live, setLive] = useState(enabled),
    [visible, setVisible] = useState(!document.hidden),
    [control, setControl] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
    "shortcuts" | "clipboard" | "more" | "actions" | null
  >(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const helperPending = useRef(false);
  const [typingTarget, setTypingTarget] = useState<
    (TextTarget & { point?: { x: number; y: number } }) | null
  >(null);
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
    if (owner)
      void post(peer, "/api/screen/control", { enabled: false }).catch(
        () => {},
      );
  }, [peer.url, peer.token, owner]);
  const ended = useCallback(
    (message: string) => {
      setError(message);
      release();
    },
    [release],
  );
  const stream = useRemoteScreen(
    peer,
    enabled,
    live && visible,
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
      const result = await send({ type: "focus", ...point });
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
      if (owner) leave();
    };
  }, [release, peer.url, peer.token, owner]);
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
      await post(peer, "/api/screen/control", { enabled: true });
      if (mounted.current && intent.current && !document.hidden)
        setControl(true);
      else release();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
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
      {enabled && owner && device.platform === "darwin" && (
        <DesktopMode
          peer={peer}
          device={device}
          beforeOpen={async () => {
            release();
            setLive(false);
            await post(peer, "/api/screen/control", { enabled: false });
          }}
          afterClose={() => setLive(true)}
        />
      )}
      <ErrorLine error={error || stream.error} />
      {!enabled ? (
        <section className="panel screen-setup">
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
              {!live
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
              {owner && device.capabilities.apps && (
                <button
                  className="button secondary small"
                  onClick={() => {
                    clearTyping();
                    setPanel("shortcuts");
                  }}
                >
                  <Command size={16} />
                  Shortcuts
                </button>
              )}
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
          {expanded && <ErrorLine error={error || stream.error} />}
          <DesktopSurface
            canvas={stream.canvas}
            width={stream.width}
            height={stream.height}
            ready={stream.ready}
            connecting={live && visible && !stream.ready && !stream.error}
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
            resetKey={`${display}:${revision}`}
            compact
            typing={typing}
            focusPoint={typing && mobile ? typingTarget?.point : undefined}
          />
          {typing && typingTarget && (
            isNative ? (
              <NativeRemoteTyping
                key={`${typingTarget.focus}:${typingEpoch.current}`}
                target={typingTarget}
                send={send}
                onClose={clearTyping}
                onError={setError}
              />
            ) : (
              <RemoteTyping
                key={`${typingTarget.focus}:${typingEpoch.current}`}
                target={typingTarget}
                editorRef={typingEditor}
                send={send}
                onClose={clearTyping}
                onError={setError}
              />
            )
          )}
          {typing && typingTarget && !isNative && mobile && (
            <TapToType
              key={`${typingTarget.focus}:${typingEpoch.current}`}
              editorRef={typingEditor}
            />
          )}
          <div className="simple-screen-dock">
            {control && !typing && appContext.app && contextActions.length > 0 && (
              <ContextBar
                app={appContext.app}
                picks={contextActions}
                disabled={!usable || helperBusy}
                run={runContext}
                more={() => {
                  clearTyping();
                  setPanel("actions");
                }}
              />
            )}
            <span className="simple-screen-caption" role="status">
              {feedback ||
                (control
                  ? input.ready
                    ? typing
                      ? "Typing on your computer"
                      : "Tap to click · hold to drag"
                    : "Connecting controls…"
                  : "View only")}
            </span>
            {control && (
              <>
                <button
                  className="button primary small keyboard-button"
                  aria-label="Open phone keyboard"
                  onPointerDown={(event) => event.preventDefault()}
                  disabled={!usable}
                  onClick={openKeyboard}
                >
                  <Keyboard size={17} />
                  Type
                </button>
                {typing ? (
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
                ) : (
                  <button
                    className="icon-button"
                    aria-label="Copy selected laptop text to phone"
                    disabled={
                      !usable || clipboardBusy || !!typingTarget?.secure
                    }
                    onClick={() => void copySelectedText()}
                  >
                    <Copy size={18} />
                  </button>
                )}
              </>
            )}
            {control && (
              <button
                className="button secondary small screen-actions-trigger"
                onPointerDown={(event) => event.preventDefault()}
                disabled={!usable || helperBusy}
                aria-label="Screen actions"
                aria-haspopup="dialog"
                onClick={() => {
                  clearTyping();
                  setPanel("actions");
                }}
              >
                <PanelsTopLeft size={16} /> Actions
              </button>
            )}
            {owner && !typing && (
              <button
                className={`button ${control ? "secondary" : "primary"} small`}
                disabled={!stream.ready || busy || !live}
                onClick={() => void toggleControl()}
              >
                <MousePointer2 size={15} />
                {control ? "Stop" : "Control"}
              </button>
            )}
            {!live && (
              <button className="button primary small" onClick={reconnect}>
                Resume
              </button>
            )}
          </div>
          {fullscreen && !chromeShown && owner && (
            <div
              className="screen-immersive-pill"
              data-immersive-keep
              onPointerDown={(event) => event.preventDefault()}
            >
              {control && (
                <button
                  aria-label="Open phone keyboard"
                  disabled={!usable}
                  onClick={openKeyboard}
                >
                  <Keyboard size={18} />
                  Type
                </button>
              )}
              <button
                aria-label={control ? "Stop controlling" : "Control your computer"}
                aria-pressed={control}
                disabled={!stream.ready || busy || !live}
                onClick={() => void toggleControl()}
              >
                <MousePointer2 size={17} />
                {control ? "Stop" : "Control"}
              </button>
            </div>
          )}
          {panel && (
            <ScreenPopup
              title={
                panel === "shortcuts"
                  ? "Shortcuts"
                  : panel === "clipboard"
                    ? "Clipboard"
                    : panel === "actions"
                      ? "Screen actions"
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
                <ScreenActions
                  platform={device.platform}
                  disabled={!usable || helperBusy}
                  run={(helper) => void runHelper(helper)}
                />
              )}
              {panel === "shortcuts" && owner && (
                <QuickLauncher
                  peer={peer}
                  onDone={(name) => {
                    setPanel(null);
                    setFeedback(`${name} opened`);
                  }}
                />
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
                    tap Copy. Tap the keyboard button to type directly on your
                    computer. Extra keys are in Actions. Fullscreen gives you
                    more room.
                  </p>
                  {control && (
                    <button
                      className="button secondary small"
                      onClick={() => setPanel("clipboard")}
                    >
                      <Clipboard size={16} /> Clipboard transfers
                    </button>
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
                  {owner && (
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
