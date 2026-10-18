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
  Ellipsis,
  ClipboardPaste,
  ChevronRight,
  ChevronLeft,
  LayoutGrid,
  AppWindow,
  Hand,
  MousePointerClick,
  Move,
  Unplug,
  Activity,
  Bot,
  Volume2,
  VolumeX,
} from "lucide-react";
import { pasteFromPhone } from "./phone-paste";
import { Device, Peer, post, request } from "./api";
import { Empty, ErrorLine, PageTitle } from "./ui";
import { useRemoteScreen } from "./useRemoteScreen";
import { soundSupported, useScreenSound } from "./useScreenSound";
import { useDesktopInput, type DesktopAction } from "./useDesktopInput";
import QuickLauncher from "./QuickLauncher";
import ScreenPopup from "./ScreenPopup";
import RemoteTyping from "./RemoteTyping";
import ScreenActions, { type ScreenAction } from "./ScreenActions";
import { screenActionGroups, shortcutText } from "./screen-action-catalog";
import { CLIPBOARD_BYTES, copyRemoteSelection, fitBytes } from "./remote-copy";
import type { TextTarget } from "./desktop-input-queue";
import DesktopSurface from "./DesktopSurface";
import { useScreenPresentation } from "./useScreenPresentation";
import { useImmersiveChrome } from "./useImmersiveChrome";
import { useScreenChrome } from "./useScreenChrome";
import NativeRemoteTyping from "./NativeRemoteTyping";
import { useAppContext } from "./useAppContext";
import { allCommands, contextPicks, type ContextAction } from "./app-context";
import { AppCommandList } from "./AppCommands";
import TapToType from "./TapToType";
import { focusKeyboard, prepareKeyboard } from "./keyboard-focus";
import { nativeKeyboard } from "./remote-keyboard";
import { PausedCover } from "./PauseControl";
import { agentsWaitIn, computerWord, controlIn, isPausedMessage, pausedIn, usingIn } from "./pause";
import "./screen-immersive.css";
import "./screen-ask.css";
import "./settings-list.css";
import "./screen-bar.css";
import "./screen-chrome.css";
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
  onClose?: () => void;
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
// Why a computer's video isn't its best, already said on this page.
const toldVideo = new Set<string>();
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
    // On the computer itself, its screen would show itself inside itself
    // (Oct 11, a Windows user): said first, shown only if asked. Read from
    // each device update: the first one may be a saved copy without it.
    [showHere, setShowHere] = useState(false),
    [visible, setVisible] = useState(!document.hidden),
    [control, setControl] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Someone else controls the screen (who, and whether this phone may take
  // over); cleared when control changes hands.
  const [holder, setHolder] = useState<{
    name: string;
    canTakeOver: boolean;
  } | null>(null);
  const [displays, setDisplays] = useState<Display[]>([]),
    [display, setDisplay] = useState("primary"),
    [quality] = useState("auto"),
    [revision, setRevision] = useState(0);
  const [mode, setMode] = useState("direct"),
    [touchAssist, setTouchAssist] = useState(true),
    [drag, setDrag] = useState(false),
    [clickMode, setClickMode] = useState("left"),
    [feedback, setFeedback] = useState("");
  const [clipboard, setClipboard] = useState(""),
    [clipboardBusy, setClipboardBusy] = useState(false);
  const [panel, setPanel] = useState<"clipboard" | "more" | "apps" | "connection" | "touch" | null>(
    null,
  );
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
  const typingCheck = useRef(0);
  const typingEditor = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  const clearTyping = () => {
    typingEpoch.current++;
    setTypingTarget(null);
  };
  const startInteraction = () => {
    // A new gesture makes an earlier click's focus reply obsolete, even
    // before finger-up. Keep a confirmed keyboard available for scrolling.
    typingCheck.current++;
    if (typingRef.current?.pending) clearTyping();
  };
  const viewer = useRef<HTMLElement>(null),
    intent = useRef(false),
    mounted = useRef(true);
  // tell: say so to the computer too. Not when control went to this
  // phone's other window: that would end its control.
  const release = useCallback((tell = true) => {
    intent.current = false;
    typingEpoch.current++;
    setTypingTarget(null);
    setControl(false);
    setDrag(false);
    setPanel(null);
    if (canControl && tell)
      void post(peer, "/api/screen/control", { enabled: false }).catch(
        () => {},
      );
  }, [peer.url, peer.token, canControl]);
  // Paused on the computer: no stream and no control until Resume, when
  // both come back (control only if it was on).
  const paused = pausedIn(changes, device);
  const controlKey = controlIn(changes);
  // Someone else on the Mac now (a person in control, an agent acting).
  const using = usingIn(changes);
  // Your input holds agents off the screen until 2 minutes after you stop
  // (server/screen.mjs OwnerHold): one quiet pill, with "Let them back".
  const agentsWait = agentsWaitIn(changes);
  const [lettingBack, setLettingBack] = useState(false);
  useEffect(() => {
    setHolder((was) => {
      if (was) setError("");
      return null;
    });
  }, [controlKey]);
  const controlBeforePause = useRef(false);
  const ended = useCallback(
    (message: string, elsewhere?: boolean) => {
      if (isPausedMessage(message)) controlBeforePause.current = true;
      else setError(message);
      release(!elsewhere);
    },
    [release],
  );
  const here = !!device.sameComputer && !showHere;
  const aspect = useRef(1.6);
  const stream = useRemoteScreen(
    peer,
    enabled,
    live && visible && !paused && !here,
    display,
    quality,
    revision,
    // Real video; the hook falls back to still images by itself when this
    // phone can't decode it.
    false,
  );
  // The computer's sound beside its picture: you and people with full
  // access, never in a browser on the computer itself (it would echo).
  const hears = !!device.capabilities.sound && !device.sameComputer && soundSupported();
  const sound = useScreenSound(peer, hears && live && visible && !paused && !here);
  useEffect(() => {
    if (sound.error) toast(sound.error);
  }, [sound.error]);
  // A computer that can't send its best video says why, once a page: a PC
  // without an H.264 encoder sends still images (never silently).
  useEffect(() => {
    const told = `${peer.url} ${stream.videoWhy}`;
    if (!stream.videoWhy || toldVideo.has(told)) return;
    toldVideo.add(told);
    toast(stream.videoWhy);
  }, [peer.url, stream.videoWhy]);
  const input = useDesktopInput(
    peer,
    control && live && visible,
    stream.selectedDisplay || display,
    ended,
    canControl && live && visible && !paused,
  );
  const usable =
    control &&
    input.ready &&
    stream.ready &&
    live &&
    visible &&
    Date.now() - stream.updated < 10000;
  // The Mac sends a frame only when something on screen moves: 0 a second
  // means a still screen, so it reads "Still", with the most it would send.
  const frameRate = `${stream.fps ? `${stream.fps} fps` : "Still"}${stream.cap ? ` · up to ${stream.cap}` : ""}`;
  // What the computer sends: its word for it, or the stream's own format
  // from a Reach that doesn't say.
  const videoKind =
    stream.video || (stream.format === "h264" ? "H.264" : stream.format === "jpeg" ? "Still images" : "");
  const send = async (action: DesktopAction) => {
    if (!usable && action.type !== "release")
      throw Object.assign(Error("Wait for a fresh screen and enable control."), { notSent: true });
    return input.send(action);
  };
  // Why a tap on the picture can't reach the computer now, in one line
  // (src/DesktopSurface.tsx says it; nothing is ever dropped in silence).
  const stalePicture = Date.now() - stream.updated >= 10000;
  const tapBlocked = !live
    ? "Live view is paused"
    : !stream.ready
      ? "Waiting for the picture"
      : !canControl
        ? "View only"
        : !control
          ? holder?.canTakeOver
            ? `${holder.name} is controlling · tap Take over`
            : "View only · tap Control to use it"
          : input.reconnecting
            ? "Reconnecting controls…"
            : !input.ready
              ? "Connecting controls…"
              : stalePicture
                ? "The picture is out of date"
                : "";
  // Control is on and its connection is coming back: a tap waits a moment.
  const tapWaits = control && !input.ready && live && visible && stream.ready;
  const detectTyping = async (point: { x: number; y: number }) => {
    if (!input.typing) return;
    const epoch = typingEpoch.current;
    const check = ++typingCheck.current;
    const currentCheck = () =>
      epoch === typingEpoch.current &&
      check === typingCheck.current &&
      mounted.current;
    // Let the desktop process its click before querying focus. No polling on moves.
    await new Promise((resolve) => setTimeout(resolve, 35));
    if (!currentCheck()) return;
    try {
      let result = await send({ type: "focus", ...point });
      // Electron/web editors can publish their focused accessibility field
      // just after the click. Retry briefly, without ever sending unguarded text.
      for (const delay of [80, 160, 320]) {
        if (!currentCheck()) return;
        if (result.target?.editable && result.target.focus) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!currentCheck()) return;
        result = await send({ type: "focus", ...point });
      }
      if (!currentCheck()) return;
      const current = typingRef.current;
      if (result.target?.editable && result.target.focus) {
        // The host returns a new point object and may correct a finger miss.
        // This interaction's epoch, rather than point identity, ties its
        // keyboard to the click. Preserve its editor and buffered typing.
        setTypingTarget({ ...current, ...result.target, point, pending: false });
        setFeedback("");
      } else clearTyping();
    } catch {
      if (currentCheck() && typingRef.current?.pending)
        clearTyping();
      /* Older hosts and unsupported apps retain the manual keyboard. */
    }
  };
  // The field again (a new connection, or Tab/Esc moved the computer's
  // focus): its keyboard stays open and keystrokes wait meanwhile. Another
  // field, or none: typing ends and the phone says so.
  const rejoinTyping = async () => {
    const current = typingRef.current;
    if (!current?.rejoin) return;
    const epoch = typingEpoch.current;
    const at = current.rejoin === true ? {} : current.rejoin;
    const still = () => epoch === typingEpoch.current && mounted.current && typingRef.current?.rejoin === current.rejoin;
    try {
      let result = await send({ type: "focus", ...at });
      for (const delay of [80, 160, 320]) {
        if (!still() || (result.target?.editable && result.target.focus)) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (still()) result = await send({ type: "focus", ...at });
      }
      if (!still()) return;
      if (result.target?.editable && result.target.focus)
        setTypingTarget({ ...typingRef.current!, ...result.target, pending: false, rejoin: undefined });
      else {
        clearTyping();
        setFeedback("The computer's text field changed · tap it to type");
      }
    } catch {
      if (still() && input.ready) clearTyping();
    }
  };
  const retarget = () => {
    const t = typingRef.current;
    if (!t?.focus) return;
    setTypingTarget({ ...t, pending: true, rejoin: true, session: t.session ?? t.focus });
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
      setDisplays(result.displays || []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [peer.url, peer.token, enabled]);
  useEffect(() => {
    void loadDisplays();
  }, [loadDisplays]);
  // Feedback fades after a few seconds.
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 4000);
    return () => clearTimeout(timer);
  }, [feedback]);
  // Typing doesn't unmount when the picture goes stale or controls blink
  // (reconnecting): queued edits stay, the keyboard stays open.
  const typingAllowed = control && (input.ready || input.reconnecting) && live && visible;
  // Controls dropped while typing: hold the keystrokes and confirm the same
  // field on the new connection (each connection has its own typing guard).
  useEffect(() => {
    if (input.ready) return;
    const t = typingRef.current;
    if (t?.focus && !t.pending)
      setTypingTarget({ ...t, pending: true, rejoin: t.point ?? true, session: t.session ?? t.focus });
  }, [input.ready]);
  useEffect(() => {
    if (input.ready && typingTarget?.rejoin) void rejoinTyping();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.ready, typingTarget?.rejoin]);
  const typing = !!typingTarget && typingAllowed && !panel;
  const { fullscreen, expanded, mobile, landscape, toggleFullscreen } =
    useScreenPresentation(viewer, typing);
  // Landscape fills the viewport with floating controls. Portrait keeps
  // the controls outside the picture; typing uses the keyboard's layout.
  if (stream.width > 0 && stream.height > 0)
    aspect.current = stream.width / stream.height;
  const chrome = useScreenChrome(viewer, fullscreen && !typing, aspect.current);
  // Turning a phone back closes its automatic fullscreen.
  const turnToLeave = chrome?.placement === "overlay" && landscape;
  // Fullscreen hides the bars until the screen is touched; they stay while
  // something needs attention.
  const chromeShown = useImmersiveChrome(
    viewer,
    fullscreen,
    !!panel ||
      typing ||
      !live ||
      !!(error || stream.error) ||
      !stream.ready ||
      // Reconnecting behind the last picture: the bar says so.
      stream.connecting,
  );
  // Commands for whichever app is in front on the computer.
  const appContext = useAppContext(
    input.send,
    control && input.ready && stream.ready && live && visible && !typing,
  );
  // The bar's desktop switcher: the catalog's own keys for this computer
  // (Ctrl ←/→ and Ctrl ↑ on a Mac; Win Ctrl ←/→ and Win Tab on Windows).
  const desktopItems = screenActionGroups(device.platform).flatMap((group) => group.items);
  const desktopActions = (
    [
      ["previous-desktop", ChevronLeft],
      ["all-windows", LayoutGrid],
      ["next-desktop", ChevronRight],
    ] as const
  ).flatMap(([id, Icon]) => {
    const item = desktopItems.find((entry) => entry.id === id);
    return item
      ? [{
          id,
          label: item.label,
          Icon,
          keys: shortcutText(device.platform, item.modifiers, item.key),
          action: { type: "key", key: item.key, modifiers: item.modifiers } as DesktopAction,
        }]
      : [];
  });
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
      const answer = e as {
        status?: number;
        body?: { holder?: { name?: string }; canTakeOver?: boolean };
      };
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
        return (
          cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height
        );
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
    if (
      !ask?.open ||
      !enabled ||
      !canControl ||
      control ||
      busy ||
      askedControl.current === ask.id
    )
      return;
    askedControl.current = ask.id;
    void toggleControl();
  }, [ask?.id, ask?.open, enabled, canControl, control]);
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
      setTypingTarget({
        editable: true,
        secure,
        point,
        opened: true,
        pending: true,
      });
    });
    typingEditor.current?.focus({ preventScroll: true });
  };
  // Must run inside the tap's event handler: iOS only opens the keyboard then.
  const openKeyboard = () => {
    if (typingTarget && typingEditor.current) {
      focusKeyboard(typingEditor.current);
      return;
    }
    flushSync(() => {
      clearTyping();
      setPanel(null);
      setTypingTarget({ editable: true });
    });
    focusKeyboard(typingEditor.current);
  };
  // Done with the Mac: your control ends and agents have it back now, not 2
  // minutes from now.
  const letAgentsBack = async () => {
    setLettingBack(true);
    if (control) release();
    try {
      await post(peer, "/api/screen/agents-back", {});
      if (mounted.current) setFeedback("Agents are back");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setLettingBack(false);
    }
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
        if (fitBytes(clipboard) !== clipboard)
          throw Error("That's too long for the clipboard (16 KB at most).");
        await send({ type: "clipboard-write", text: clipboard });
        setFeedback("Laptop clipboard updated");
      }
      if (kind === "phone") {
        const text = await navigator.clipboard.readText();
        const fit = fitBytes(text);
        setClipboard(fit);
        if (fit !== text) setFeedback("Only the first 16 KB fits");
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
          done === "pasted"
            ? "Pasted from your phone"
            : "Nothing to paste on this phone",
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
  // The viewer keeps its shape while it connects (aspect, set above): with no
  // picture yet the stream is 0 wide, and the box (with the plug-in scene in
  // it) collapsed to a thin bar. The last screen's shape, or 16:10 at first.
  const statusText = paused
    ? "Paused"
    : stream.error && !stream.ready
      ? "Can't show the screen"
      : !live
        ? "Paused"
        : stream.connecting
          ? stream.ready
            ? stream.cause || "Reconnecting…"
            : stream.cause || "Connecting…"
          : stream.ready
            ? stream.slow
              ? "Slow connection · lowering quality"
              : device.name
            : "Connecting…";
  // The one line over the bar: what just happened, else who else is there.
  const caption =
    feedback ||
    (control && !input.ready
      ? input.reconnecting
        ? "Reconnecting controls…"
        : "Connecting controls…"
      : !control && using
        ? `${using} is using the ${computerWord(device.platform)}`
        : "");
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
      <ErrorLine
        error={paused || (enabled && expanded) ? "" : error || stream.error}
      />
      {!enabled ? (
        <section className="panel screen-setup">
          {ask && (
            <div className="screen-ask" role="status">
              <strong>{ask.title}</strong>
              <span>
                Screen viewing is off. Enable it to inspect the dialog. If Reach
                needs Screen Recording or Accessibility access, grant it on the
                Mac first.
              </span>
              <div className="screen-ask-actions">
                <button onClick={onAskDone}>Back to request</button>
              </div>
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
      ) : here ? (
        <section className="panel screen-setup">
          <Empty
            icon={Monitor}
            title="You're on this computer"
            action={
              <button className="button" onClick={() => setShowHere(true)}>
                Show anyway
              </button>
            }
          >
            Open Reach on your phone or another computer to see this screen.
            Here it would only show itself.
          </Empty>
        </section>
      ) : (
        <section
          aria-label="Screen session viewer"
          ref={viewer}
          style={
            {
              "--screen-aspect": aspect.current,
            } as React.CSSProperties
          }
          data-chrome={chrome?.placement}
          className={`panel screen-viewer remote-viewer simple-screen ${expanded ? "screen-expanded" : ""} ${typing ? "screen-typing" : ""} ${fullscreen ? "screen-immersive" : ""} ${chromeShown ? "" : "chrome-hidden"} ${stream.ready && stream.width ? "" : "screen-waiting"}`}
        >
          <div className="screen-toolbar simple-screen-toolbar">
            <span className="screen-state" role="status">
              <span
                className={`screen-status-dot ${live && stream.ready && !stream.connecting ? (stream.slow ? "slow" : "active") : ""}`}
              />
              {/* In landscape only news needs words; the dot says the rest. */}
              <span
                className="screen-state-text"
                {...(statusText !== device.name && { "data-news": "" })}
              >
                {statusText}
              </span>
            </span>
          </div>
          {expanded && (
            <ErrorLine error={paused ? "" : error || stream.error} />
          )}
          {ask && (
            <div
              className={`screen-ask ${ask.open ? "" : "done"}`}
              role="status"
            >
              {ask.open && ask.kind === "password" ? (
                <>
                  <strong>{ask.title}</strong>
                  <span>
                    Enter it here: Reach types it only into that dialog. It
                    isn't kept.
                  </span>
                  {onAskPassword && (
                    <MacPasswordField
                      placeholder="Your Mac's password"
                      submit={onAskPassword}
                    />
                  )}
                  <div className="screen-ask-actions">
                    <button onClick={onAskDone}>Done</button>
                  </div>
                </>
              ) : ask.open ? (
                <>
                  <strong>{ask.title}</strong>
                  <span>Tap its button on the screen below to answer it.</span>
                  <small>
                    {askSaid ||
                      "If viewing or control is unavailable, or macOS blocks the click, approve on the Mac itself."}
                  </small>
                  <div className="screen-ask-actions">
                    {ask.setting && onAskSetting && (
                      <button
                        onClick={() =>
                          void onAskSetting().then(setAskSaid, (e: Error) =>
                            setAskSaid(e.message),
                          )
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
            touchScroll
            doubleClick={input.doubleClick}
            touchAssist={device.platform === "darwin" && touchAssist}
            focusRect={askRect}
            canvas={stream.canvas}
            width={stream.width}
            height={stream.height}
            ready={stream.ready}
            connecting={
              live && visible && !paused && !stream.ready && !stream.error
            }
            stale={live && !paused && stream.ready && stream.connecting}
            canControl={usable}
            blocked={tapBlocked}
            waitForControl={tapWaits}
            initialCursor={input.initialCursor}
            hostCursor={input.hostCursor}
            mode={mode}
            drag={drag}
            clickMode={clickMode}
            send={send}
            onDragEnd={() => setDrag(false)}
            onFeedback={setFeedback}
            onInteractionStart={startInteraction}
            onInteraction={(repeat) => {
              typingCheck.current++;
              // Keep a confirmed editor for a repeat; every edit still
              // carries its native focus guard.
              const current = typingRef.current;
              if (repeat && current?.focus && !current.pending) {
                flushSync(() => setTypingTarget({
                  ...current,
                  editRevision: (current.editRevision ?? 0) + 1,
                }));
                return true;
              }
              clearTyping();
              return false;
            }}
            onTextTarget={(point) => void detectTyping(point)}
            {...(input.probe && {
              probe: (point: { x: number; y: number }) =>
                send({ type: "probe", ...point }),
              onField: typeInField,
              onKeyboardActivate: () => typingEditor.current?.focus({ preventScroll: true }),
              knownField: input.fieldAt,
              onStaleFields: input.forgetFields,
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
          {typing &&
            typingTarget &&
            (nativeKeyboard ? (
              <NativeRemoteTyping
                key={`${typingTarget.opened ? "tap" : typingTarget.session ?? typingTarget.focus}:${typingEpoch.current}`}
                target={typingTarget}
                send={send}
                onClose={clearTyping}
                onError={setError}
                onRetarget={retarget}
              />
            ) : (
              <RemoteTyping
                key={`${typingTarget.opened ? "tap" : typingTarget.session ?? typingTarget.focus}:${typingEpoch.current}`}
                target={typingTarget}
                onRetarget={retarget}
                keyRow={mobile}
                modifier={device.platform === "darwin" ? "meta" : "control"}
                editorRef={typingEditor}
                send={send}
                onClose={clearTyping}
                onError={setError}
              />
            ))}
          {typing &&
            typingTarget &&
            !typingTarget.pending &&
            !nativeKeyboard &&
            mobile && (
              // Its own key: a sibling sharing RemoteTyping's key made React
              // duplicate the keyboard field and key row, and reset the field
              // between keystrokes (each next letter then deleted the last).
              <TapToType
                key={`tap:${typingTarget.session ?? typingTarget.focus}:${typingEpoch.current}`}
                onOpen={openKeyboard}
                onPrepare={() => prepareKeyboard(typingEditor.current)}
              />
            )}
          {/* Every control in one small bar floating at the bottom center:
              Control, keyboard, paste, fullscreen, and one menu (keys, apps, options). */}
          <div
            className="simple-screen-dock screen-bar-dock"
            inert={chrome?.placement === "overlay" && !chromeShown}
            aria-hidden={chrome?.placement === "overlay" && !chromeShown ? true : undefined}
          >
            {caption && (
              <span className="simple-screen-caption" role="status">
                {caption}
              </span>
            )}
            {/* One line at a time over the bar: the pill steps back while
                a passing caption is said (the row keeps its height). */}
            {agentsWait && !caption && (
              <span className="screen-agents-wait" role="status" data-immersive-keep>
                <Bot size={14} aria-hidden="true" />
                <span>Agents wait · 2 min after you stop</span>
                <button
                  type="button"
                  disabled={lettingBack}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => void letAgentsBack()}
                >
                  Let them back
                </button>
              </span>
            )}
            <div
              className="screen-bar"
              role="toolbar"
              aria-label="Screen controls"
              data-immersive-keep
              onPointerDown={(event) => event.preventDefault()}
            >
              {canControl && !typing && !paused && (
                <button
                  aria-label={control ? "Stop" : holder?.canTakeOver ? "Take over" : "Control"}
                  title={control ? "Stop controlling" : holder?.canTakeOver ? "Take over" : "Control your computer"}
                  aria-pressed={control}
                  // Stop stays available through a reconnect.
                  disabled={busy || (!control && (!stream.ready || !live))}
                  onClick={() => void toggleControl()}
                >
                  <MousePointer2 size={19} />
                </button>
              )}
              {control && (
                <button
                  aria-label={
                    typing
                      ? "Dismiss phone keyboard"
                      : mobile
                        ? "Open phone keyboard"
                        : "Type on computer"
                  }
                  aria-pressed={typing}
                  disabled={!usable}
                  onClick={() => {
                    if (typing) {
                      typingEditor.current?.blur();
                      clearTyping();
                    } else openKeyboard();
                  }}
                >
                  <Keyboard size={19} />
                </button>
              )}
              {control && (
                <button
                  aria-label="Paste from your phone"
                  disabled={!usable || clipboardBusy}
                  onClick={() => void pastePhone()}
                >
                  <ClipboardPaste size={18} />
                </button>
              )}
              {/* Desktops, as the keys menu sends them: previous, all
                  windows, next. Smaller, together, no words. */}
              {control && !typing && (
                <span className="screen-bar-group" role="group" aria-label="Desktops">
                  {desktopActions.map(({ id, label, keys, Icon, action }) => (
                    <button
                      key={id}
                      aria-label={label}
                      title={`${label} · ${keys}`}
                      disabled={!usable || helperBusy}
                      onClick={() => void runHelper({ label, keys, action })}
                    >
                      <Icon size={18} />
                    </button>
                  ))}
                </span>
              )}
              {hears && !typing && !paused && (
                <button
                  aria-label="Sound"
                  title={`${sound.on ? "Stop hearing" : "Hear"} the ${computerWord(device.platform)}`}
                  aria-pressed={sound.on}
                  aria-busy={sound.state === "starting" || undefined}
                  className={sound.state === "starting" ? "screen-bar-pending" : undefined}
                  onClick={() => (sound.on ? sound.stop() : sound.start())}
                >
                  {sound.on ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </button>
              )}
              {!turnToLeave && (
                <button
                  aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                  aria-pressed={fullscreen}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                </button>
              )}
              <button
                aria-label="Screen options"
                aria-haspopup="dialog"
                onClick={() => {
                  clearTyping();
                  setPanel("more");
                }}
              >
                <Ellipsis size={20} />
              </button>
              {!live && !paused && (
                <button className="screen-bar-text" onClick={reconnect}>
                  Resume
                </button>
              )}
            </div>
          </div>
          {panel && (
            <ScreenPopup
              title={
                panel === "clipboard"
                  ? "Clipboard"
                  : panel === "apps"
                    ? `Open on ${device.name}`
                    : panel === "connection"
                      ? "Connection"
                      : panel === "touch"
                        ? "Touch & mouse"
                        : "Screen options"
              }
              className="gs-sheet screen-menu"
              onClose={() => setPanel(null)}
            >
              {panel !== "more" && (
                <button className="gs-back" onClick={() => setPanel("more")}>
                  <ChevronRight size={18} /> Back
                </button>
              )}
              {/* One menu, as ChatGPT lays one out: the keys and commands
                  first, then short grouped lists, little text. */}
              {panel === "more" && (
                <>
                  {control && appContext.app && (
                    <AppCommandList
                      app={appContext.app}
                      picks={contextActions}
                      all={allCommands(device.platform, appContext.items)}
                      disabled={!usable || helperBusy}
                      run={runContext}
                    />
                  )}
                  {control && (
                    <ScreenActions
                      platform={device.platform}
                      disabled={!usable || helperBusy}
                      run={(helper) => void runHelper(helper)}
                      shownAbove={
                        appContext.app ? contextActions.map((item) => item.label) : []
                      }
                    />
                  )}
                  {(control || (canControl && device.capabilities.apps)) && (
                    <div className="gs-group">
                      {control && (
                        <button
                          className="gs-row"
                          disabled={!usable || clipboardBusy}
                          onClick={() => {
                            setPanel(null);
                            void copySelectedText();
                          }}
                        >
                          <Copy />
                          <span className="gs-label">Copy selected text</span>
                        </button>
                      )}
                      {control && (
                        <button className="gs-row" onClick={() => setPanel("clipboard")}>
                          <Clipboard />
                          <span className="gs-label">Clipboard</span>
                          <ChevronRight className="gs-chevron" size={18} />
                        </button>
                      )}
                      {canControl && device.capabilities.apps && (
                        <button className="gs-row" onClick={() => setPanel("apps")}>
                          <AppWindow />
                          <span className="gs-label">Open an app</span>
                          <ChevronRight className="gs-chevron" size={18} />
                        </button>
                      )}
                    </div>
                  )}
                  <div className="gs-group">
                    <button
                      className="gs-row"
                      onClick={() => {
                        if (live) {
                          release();
                          setLive(false);
                        } else reconnect();
                        setPanel(null);
                      }}
                    >
                      {live ? <Pause /> : <Play />}
                      <span className="gs-label">{live ? "Pause" : "Resume"}</span>
                    </button>
                    {(canControl || displays.length > 1) && (
                      <button className="gs-row" onClick={() => setPanel("touch")}>
                        <Hand />
                        <span className="gs-label">Touch & mouse</span>
                        <ChevronRight className="gs-chevron" size={18} />
                      </button>
                    )}
                    <button className="gs-row" onClick={() => setPanel("connection")}>
                      <Activity />
                      <span className="gs-label">Connection</span>
                      <span className="gs-value">{frameRate}</span>
                      <ChevronRight className="gs-chevron" size={18} />
                    </button>
                  </div>
                </>
              )}
              {panel === "touch" && (
                <div className="gs-group">
                  {canControl && device.platform === "darwin" && (
                    <button className="gs-row" aria-pressed={touchAssist}
                      onClick={() => setTouchAssist(!touchAssist)}>
                      <MousePointerClick />
                      <span className="gs-label">Touch assistance</span>
                      <span className="gs-value">{touchAssist ? "On" : "Off"}</span>
                    </button>
                  )}
                  {canControl && (
                    <label className="gs-row">
                      <Hand />
                      <span className="gs-label">Touch</span>
                      <select
                        className="gs-select"
                        aria-label="Touch mode"
                        value={mode}
                        onChange={(e) => {
                          void input.send({ type: "release" }).catch(() => {});
                          setDrag(false);
                          setMode(e.target.value);
                        }}
                      >
                        <option value="trackpad">Trackpad</option>
                        <option value="direct">Direct</option>
                        <option value="pan">Pan & zoom</option>
                      </select>
                    </label>
                  )}
                  {canControl && (
                    <label className="gs-row">
                      <MousePointerClick />
                      <span className="gs-label">Tap</span>
                      <select
                        className="gs-select"
                        aria-label="Tap action"
                        value={clickMode}
                        onChange={(e) => setClickMode(e.target.value)}
                      >
                        <option value="left">Click</option>
                        <option value="right">Right-click</option>
                        <option value="double">Double-click</option>
                      </select>
                    </label>
                  )}
                  {canControl && (
                    <button
                      className="gs-row"
                      disabled={!usable || mode === "pan"}
                      aria-pressed={drag}
                      onClick={() => {
                        void input.send({ type: "release" }).catch(() => {});
                        setDrag(!drag);
                      }}
                    >
                      <Move />
                      <span className="gs-label">Drag</span>
                      <span className="gs-value">{drag ? "On · touch and move" : "Off"}</span>
                    </button>
                  )}
                  {canControl && (
                    <button
                      className="gs-row"
                      disabled={!usable}
                      onClick={() => void action({ type: "release" })}
                    >
                      <Unplug />
                      <span className="gs-label">Release mouse</span>
                    </button>
                  )}
                  {displays.length > 1 && (
                    <label className="gs-row">
                      <Monitor />
                      <span className="gs-label">Display</span>
                      <select
                        className="gs-select"
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
                </div>
              )}
              {panel === "apps" && (
                <QuickLauncher
                  peer={peer}
                  onDone={(name) => {
                    setPanel(null);
                    setFeedback(`${name} opened`);
                  }}
                />
              )}
              {panel === "connection" && (
                <>
                  <div className="gs-group">
                    {!!videoKind && (
                      <div className="gs-row">
                        <span className="gs-label">Video</span>
                        <span className="gs-value">{videoKind}</span>
                      </div>
                    )}
                    <div className="gs-row">
                      <span className="gs-label">Frames</span>
                      <span className="gs-value">{frameRate}</span>
                    </div>
                    <div className="gs-row">
                      <span className="gs-label">Data</span>
                      <span className="gs-value">{stream.mbps} Mbps</span>
                    </div>
                    {!!stream.latency && (
                      <div className="gs-row">
                        <span className="gs-label">Link</span>
                        <span className="gs-value">{stream.latency} ms</span>
                      </div>
                    )}
                    {usable && (
                      <div className="gs-row">
                        <span className="gs-label">Input</span>
                        <span className="gs-value">{input.latency} ms</span>
                      </div>
                    )}
                  </div>
                  {stream.videoWhy && <p className="gs-foot">{stream.videoWhy}</p>}
                  {stream.fallbackReason && <p className="gs-foot">{stream.fallbackReason}</p>}
                  <div className="gs-group gs-end">
                    <button
                      className="gs-row"
                      onClick={() => {
                        reconnect();
                        setPanel(null);
                      }}
                    >
                      <RefreshCw />
                      <span className="gs-label">Reconnect</span>
                    </button>
                  </div>
                  {owner && (
                    <>
                      <div className="gs-group gs-end">
                        <button
                          className="gs-row gs-danger"
                          onClick={() => void toggleViewing(false)}
                        >
                          <ShieldCheck />
                          <span className="gs-label">Turn off screen access</span>
                        </button>
                      </div>
                      <p className="gs-foot">
                        {device.platform === "darwin"
                          ? "Needs Screen Recording to view and Accessibility to control, in System Settings → Privacy & Security."
                          : "Keep Windows signed in and unlocked. Secure desktops can't be controlled."}
                      </p>
                    </>
                  )}
                </>
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
                      maxLength={CLIPBOARD_BYTES}
                      // The limit is in bytes: an emoji or accent takes more than one.
                      onChange={(e) => {
                        const fit = fitBytes(e.target.value);
                        setClipboard(fit);
                        if (fit !== e.target.value) setFeedback("Only the first 16 KB fits");
                      }}
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
            </ScreenPopup>
          )}
        </section>
      )}
    </>
  );
}
