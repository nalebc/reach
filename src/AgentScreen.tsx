import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CornerDownLeft,
  Eye,
  KeyRound,
  Keyboard,
  Command,
  Hash,
  Maximize,
  Minimize,
  Ellipsis,
  ShieldCheck,
  ZoomIn,
} from "lucide-react";
import { peerFetch, request, type Peer } from "./api";
import ScreenActions from "./ScreenActions";
import ScreenPopup from "./ScreenPopup";
import "./screen-bar.css";
import type { PresetAccess } from "./AgentPage";

// The Mac's screen as the agent's own: pictures follow each other as fast as
// the Mac answers, and a click, drag, scroll or key on the picture happens on
// the Mac, as if the agent sat in front of it. Input runs one action at a
// time, in order; a refusal drops whatever was planned after it.
type Action = Record<string, unknown> & { type: string };
type Tone = "" | "is-wait" | "is-blocked" | "is-done";
type Step = {
  action: Action;
  words: string;
  applied?: () => void;
  quiet?: boolean;
};
type Spot = { x: number; y: number };
type Region = { x0: number; y0: number; w: number; h: number };

// The Mac answers ten screenshots a second per agent; stay just under it.
const FRAME_GAP_MS = 120;
const HIDDEN_FRAME_MS = 2000;
const STALE_MS = 3000;
const HOVER_MS = 600;
const QUEUE_LIMIT = 40;
// The zoomed view shows a quarter of the picture at four times.
const ZOOM = 0.25;
const regionAround = (cx: number, cy: number): Region => ({
  x0: Math.min(1 - ZOOM, Math.max(0, cx - ZOOM / 2)),
  y0: Math.min(1 - ZOOM, Math.max(0, cy - ZOOM / 2)),
  w: ZOOM,
  h: ZOOM,
});
const percent = (value: number) => `${Math.round(value * 100)}%`;
const place = (spot: Spot) => `${percent(spot.x)}, ${percent(spot.y)}`;
// What was typed stays off the status line: only how much.
const typed = (text: string) => `typed ${text.length} character${text.length === 1 ? "" : "s"}`;
const KEYS: { label: string; key: string }[] = [
  { label: "Enter", key: "enter" },
  { label: "Tab", key: "tab" },
  { label: "Esc", key: "escape" },
  { label: "Delete", key: "backspace" },
  { label: "←", key: "left" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
  { label: "→", key: "right" },
];
// Keys a browser names, as the Mac knows them.
const NAMED: Record<string, string> = {
  Enter: "enter",
  Tab: "tab",
  Escape: "escape",
  Backspace: "backspace",
  Delete: "forwarddelete",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ...Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => [`F${i + 1}`, `f${i + 1}`]),
  ),
};
const PUNCTUATION: Record<string, string> = {
  Space: "space",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Quote: "'",
  Semicolon: ";",
  Backslash: "\\",
  Comma: ",",
  Slash: "/",
  Period: ".",
  Backquote: "`",
};
// The physical key under a shortcut, whatever character its modifiers made.
const physical = (code: string, key: string) =>
  /^Key[A-Z]$/.test(code)
    ? code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(code)
      ? code.slice(5)
      : PUNCTUATION[code] || (/^[a-z0-9]$/i.test(key) ? key.toLowerCase() : "");
const MODIFIERS = new Set(["cmd", "shift", "option", "control"]);
const aliases: Record<string, string> = {
  command: "cmd",
  meta: "cmd",
  alt: "option",
  ctrl: "control",
  esc: "escape",
  return: "enter",
};
// A browser on a Mac has its own ⌘ key; elsewhere Ctrl plays that part for
// letter shortcuts (Ctrl+L is ⌘L). Named keys keep Ctrl: Ctrl+Tab stays a tab
// switch, never the Mac's app switcher.
const onMac = () =>
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const chord = (event: React.KeyboardEvent, letter: boolean) => {
  const command = !onMac() && letter;
  return [
    (event.metaKey || (command && event.ctrlKey)) && "cmd",
    !command && event.ctrlKey && "control",
    event.altKey && "option",
    event.shiftKey && "shift",
  ].filter(Boolean) as string[];
};
const pointerAction = (action: Action) =>
  action.type === "click" || action.type === "drag" || action.type === "element";
type Element = { n: number; role: string; name: string; secure?: boolean; x: number; y: number; w: number; h: number };
type Labels = { snapshot: string; items: Element[] };
const LABELS_MS = 1500;

export default function AgentScreen({
  peer,
  access,
  active = true,
  now,
  status,
  tell,
  ended,
  guide = [],
  guideOpen = false,
  onGuide = () => {},
}: {
  peer: Peer;
  access: PresetAccess;
  active?: boolean;
  now: number;
  status: { text: string; tone: Tone };
  tell: (text: string, tone?: Tone) => void;
  ended: (e: unknown) => void;
  // The agent's instructions, a line each (AgentPage): here a popup over
  // the screen, never a block that pushes the picture down.
  guide?: string[];
  guideOpen?: boolean;
  onGuide?: (open: boolean) => void;
}) {
  const control = !!access.control;
  const [imageUrl, setImageUrl] = useState("");
  const [imageAt, setImageAt] = useState<Date | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [hiddenCount, setHiddenCount] = useState(0);
  const [screenError, setScreenError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [front, setFront] = useState("");
  const [sheet, setSheet] = useState<"" | "type" | "signin">("");
  // Full screen: the Mac fills the whole browser window, nothing else shown.
  // A page layer, not the browser's Fullscreen API, which agents' browsers
  // may refuse; Esc on the page itself goes to the Mac, so a button exits.
  const [full, setFull] = useState(false);
  // Numbered labels over the picture, from the Mac's accessibility tree: a
  // click on one presses that exact element, however small it looks here.
  const [labelsOn, setLabelsOn] = useState(true);
  const [labels, setLabels] = useState<Labels | null>(null);
  const labelsBusy = useRef(false);
  const labelsWake = useRef<(() => void) | null>(null);
  const [panel, setPanel] = useState<null | "shortcuts" | "more">(null);
  const userRef = useRef<HTMLInputElement | null>(null);
  const passRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const textRevision = useRef(0);
  const [shortcut, setShortcut] = useState("");
  const [zoomPick, setZoomPick] = useState(false);
  const [zoom, setZoom] = useState<Region | null>(null);
  const [lastClick, setLastClick] = useState<(Spot & { at: number }) | null>(
    null,
  );
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keysRef = useRef<HTMLTextAreaElement | null>(null);
  const objectUrl = useRef("");
  const inFlight = useRef<AbortController | null>(null);
  const lastShot = useRef(0);
  const backoff = useRef(0);
  const wake = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const queue = useRef<Step[][]>([]);
  const running = useRef(false);
  const frontRef = useRef("");
  // Set when a click didn't land: keys would reach whatever is in front.
  const held = useRef<string | null>(null);
  const pendingText = useRef("");
  const textTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingScroll = useRef<(Spot & { dx: number; dy: number }) | null>(
    null,
  );
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastHover = useRef<Spot | null>(null);
  const press = useRef<{
    id: number;
    start: Spot;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const zoomRef = useRef<Region | null>(null);
  zoomRef.current = zoom;
  const zoomPickRef = useRef(false);
  zoomPickRef.current = zoomPick;
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      queue.current = [];
      for (const timer of [textTimer, scrollTimer, hoverTimer])
        clearTimeout(timer.current);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);
  const noteFront = (app: string) => {
    frontRef.current = app;
    setFront(app);
  };

  // Pictures sized to what the page shows (the zoomed view needs the full one).
  const frameWidth = () => {
    if (zoomRef.current || zoomPickRef.current) return 2560;
    const width = stageRef.current?.clientWidth || 0;
    const dpr = window.devicePixelRatio || 1;
    return Math.min(2560, Math.max(1280, Math.ceil((width * dpr) / 320) * 320));
  };
  const refresh = useCallback(async () => {
    if (inFlight.current || !mounted.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    lastShot.current = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    try {
      const response = await peerFetch(
        peer,
        `/api/browser/desktop/screen?maxWidth=${frameWidth()}`,
        { cache: "no-store", redirect: "error", signal: controller.signal },
      );
      if (response.status === 429) {
        backoff.current = 300;
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw Object.assign(
          Error(body.error || "The screen could not be read."),
          { status: response.status },
        );
      }
      const blob = await response.blob();
      if (controller.signal.aborted || !mounted.current) return;
      const url = URL.createObjectURL(blob);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = url;
      setImageUrl(url);
      setImageAt(new Date());
      setScreenError("");
      try {
        const meta = JSON.parse(response.headers.get("X-Reach-Screen") || "{}");
        setHiddenCount(Number(meta.hidden) || 0);
        if (Number(meta.width) > 0 && Number(meta.height) > 0)
          setImageSize((size) =>
            size?.w === Number(meta.width) && size.h === Number(meta.height)
              ? size
              : { w: Number(meta.width), h: Number(meta.height) },
          );
      } catch {
        setHiddenCount(0);
      }
    } catch (e) {
      // A capture that never answers is said, never waited on in silence.
      if (timedOut && mounted.current) {
        setScreenError("The Mac's screen isn't answering. Still trying…");
        backoff.current = 1000;
      } else if (!controller.signal.aborted && mounted.current) {
        setScreenError((e as Error).message || "The screen could not be read.");
        backoff.current = 300;
        ended(e);
      }
    } finally {
      clearTimeout(timeout);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [peer, ended]);
  useEffect(() => {
    if (!active) {
      inFlight.current?.abort();
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void loop(), ms);
    };
    const loop = async () => {
      if (!alive) return;
      if (!running.current) await refresh();
      if (!alive) return;
      const gap = FRAME_GAP_MS - (Date.now() - lastShot.current);
      schedule(document.hidden ? HIDDEN_FRAME_MS : Math.max(backoff.current, gap, 0));
      backoff.current = 0;
    };
    wake.current = () => {
      if (alive && !inFlight.current)
        schedule(Math.max(0, FRAME_GAP_MS - (Date.now() - lastShot.current)));
    };
    // A tab coming back to the front fetches a frame at once.
    const shown = () => {
      if (!document.hidden && alive && !running.current && !inFlight.current) schedule(0);
    };
    document.addEventListener("visibilitychange", shown);
    void loop();
    return () => {
      document.removeEventListener("visibilitychange", shown);
      alive = false;
      clearTimeout(timer);
      inFlight.current?.abort();
      wake.current = null;
    };
  }, [refresh, active]);
  const lookFront = useCallback(async () => {
    try {
      const value = await request<{ app?: string }>(
        peer,
        "/api/browser/desktop/front",
      );
      if (mounted.current) noteFront(value.app || "");
    } catch (e) {
      ended(e);
    }
  }, [peer, ended]);
  const showLabels = control && labelsOn && active;
  useEffect(() => {
    if (!showLabels) {
      setLabels(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      if (!alive) return;
      if (!labelsBusy.current && !running.current && !document.hidden) {
        labelsBusy.current = true;
        try {
          const value = await request<Labels>(peer, "/api/browser/desktop/elements");
          if (alive && mounted.current)
            setLabels((old) =>
              old && JSON.stringify(old.items) === JSON.stringify(value.items) ? old : value,
            );
        } catch (e) {
          if (alive && mounted.current) setLabels(null);
          ended(e);
        } finally {
          labelsBusy.current = false;
        }
      }
      if (alive) timer = setTimeout(() => void load(), LABELS_MS);
    };
    labelsWake.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 250);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
      labelsWake.current = null;
    };
  }, [showLabels, peer, ended]);
  const pressLabel = (item: Element, snapshot: string) => {
    held.current = null;
    setLastClick({ x: item.x + item.w / 2, y: item.y + item.h / 2, at: Date.now() });
    enqueue([
      {
        action: { type: "element", snapshot, n: item.n },
        words: `clicked ${item.n}${item.name ? ` (${item.name})` : ""}`,
      },
    ]);
  };
  const pictured = !!imageUrl;
  useEffect(() => {
    if (pictured && control) void lookFront();
  }, [pictured, control, lookFront]);
  useEffect(() => {
    if (active && control) keysRef.current?.focus({ preventScroll: true });
  }, [active, control]);

  // The picture keeps the screen's own proportions at the largest size the
  // window allows (CSS), so a spot on it is the same spot on the Mac.
  const shape = imageSize
    ? ({ "--ap-aspect": imageSize.w / imageSize.h } as React.CSSProperties)
    : undefined;

  const post = async (body: unknown) => {
    const response = await peerFetch(peer, "/api/browser/desktop/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(Error(value.error || "The Mac couldn't do that."), {
        status: response.status,
        body: value,
      });
    return value as { app?: string };
  };
  const explain = (error: {
    message: string;
    body?: { kind?: string; holder?: string; retryInMs?: number };
  }) => {
    const kind = error.body?.kind;
    if (kind === "busy")
      return tell(
        `Not done: ${error.body?.holder || "another agent"} is using the Mac. Try again in ${Math.ceil((error.body?.retryInMs || 2000) / 1000)} s.`,
        "is-wait",
      );
    if (kind === "paused" || kind === "retry")
      return tell(`Not done: ${error.message} Wait, then try again.`, "is-wait");
    tell(`Not done: ${error.message}`, "is-blocked");
  };
  const dropPending = () => {
    queue.current = [];
    pendingText.current = "";
    pendingScroll.current = null;
    for (const timer of [textTimer, scrollTimer, hoverTimer])
      clearTimeout(timer.current);
  };
  const pump = async () => {
    if (running.current || !mounted.current) return;
    running.current = true;
    setActionBusy(true);
    inFlight.current?.abort();
    try {
      while (queue.current.length && mounted.current) {
        const group = queue.current.shift()!;
        for (const step of group) {
          if (!step.quiet) tell(step.action.type === "type" ? "Typing…" : `${step.words}…`);
          let result: { app?: string };
          try {
            result = await post({ action: step.action });
          } catch (e) {
            if (!mounted.current) return;
            // A hover that didn't land changes nothing on the Mac.
            if (step.quiet) break;
            ended(e);
            explain(e as Error);
            if (pointerAction(step.action))
              held.current = frontRef.current || "the app in front";
            dropPending();
            void lookFront();
            return;
          }
          if (!mounted.current) return;
          step.applied?.();
          if (step.quiet) continue;
          // A scroll reports the app under the pointer, not the one typing reaches.
          if (result.app && step.action.type !== "scroll") noteFront(result.app);
          if (pointerAction(step.action)) held.current = null;
          tell(
            `Done: ${step.words}${result.app ? ` in ${result.app}` : ""}.`,
            "is-done",
          );
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) setActionBusy(false);
      wake.current?.();
      labelsWake.current?.();
    }
  };
  const enqueue = (group: Step[]) => {
    if (queue.current.length >= QUEUE_LIMIT)
      return tell(
        "Not done: too many actions at once. Wait for the screen to catch up.",
        "is-wait",
      );
    queue.current.push(group);
    void pump();
  };
  // Keys wait for a click that lands: when the click meant to focus a field is
  // refused, typing would otherwise reach whatever app is in front.
  const holdKeys = () => {
    if (!held.current) return false;
    pendingText.current = "";
    clearTimeout(textTimer.current);
    tell(
      `Not typed: your last click didn't land, so typing would go to ${held.current}. Click where you want to type first.`,
      "is-blocked",
    );
    return true;
  };
  const flushText = () => {
    clearTimeout(textTimer.current);
    let value = pendingText.current;
    pendingText.current = "";
    while (value) {
      // Text still waiting in line grows instead of queueing a second step.
      const last = queue.current.at(-1);
      const step =
        last?.length === 1 &&
        last[0].action.type === "type" &&
        !last[0].applied &&
        String(last[0].action.text).length <= 1998
          ? last[0]
          : null;
      let size = Math.min(
        value.length,
        2000 - (step ? String(step.action.text).length : 0),
      );
      if (size < value.length && /[\ud800-\udbff]/.test(value[size - 1])) size--;
      const chunk = value.slice(0, size);
      value = value.slice(size);
      if (step) {
        step.action.text = String(step.action.text) + chunk;
        step.words = typed(String(step.action.text));
      } else enqueue([{ action: { type: "type", text: chunk }, words: typed(chunk) }]);
    }
  };
  const addText = (value: string) => {
    if (!control || holdKeys()) return;
    pendingText.current += value;
    clearTimeout(textTimer.current);
    textTimer.current = setTimeout(flushText, 150);
  };
  const keyPress = (key: string, modifiers: string[], words: string) => {
    if (!control || holdKeys()) return;
    flushText();
    enqueue([
      {
        action: modifiers.length
          ? { type: "key", key, modifiers }
          : { type: "key", key },
        words: `pressed ${words}`,
      },
    ]);
  };
  const flushScroll = () => {
    clearTimeout(scrollTimer.current);
    const pending = pendingScroll.current;
    pendingScroll.current = null;
    if (!pending) return;
    const limit = (value: number) =>
      Math.max(-2000, Math.min(2000, Math.round(value)));
    const dx = limit(pending.dx),
      dy = limit(pending.dy);
    if (!dx && !dy) return;
    const direction =
      Math.abs(dy) >= Math.abs(dx)
        ? dy > 0
          ? "down"
          : "up"
        : dx > 0
          ? "right"
          : "left";
    flushText();
    enqueue([
      {
        action: { type: "scroll", x: pending.x, y: pending.y, dx, dy },
        words: `scrolled ${direction} at ${place(pending)}`,
      },
    ]);
  };
  const addScroll = (spot: Spot, dx: number, dy: number) => {
    clearTimeout(hoverTimer.current);
    const pending = pendingScroll.current;
    if (
      pending &&
      Math.abs(pending.x - spot.x) < 0.02 &&
      Math.abs(pending.y - spot.y) < 0.02
    ) {
      pending.dx += dx;
      pending.dy += dy;
    } else {
      flushScroll();
      pendingScroll.current = { ...spot, dx, dy };
    }
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(flushScroll, 120);
  };
  const pointerAct = (action: Action, words: string, at: Spot) => {
    clearTimeout(hoverTimer.current);
    flushText();
    flushScroll();
    setLastClick({ ...at, at: Date.now() });
    // Keys typed from now on wait behind this click; if it is refused too,
    // they are dropped with it.
    held.current = null;
    enqueue([{ action, words }]);
  };
  const hover = (spot: Spot) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const last = lastHover.current;
      if (running.current || queue.current.length || press.current) return;
      if (last && Math.abs(last.x - spot.x) < 0.01 && Math.abs(last.y - spot.y) < 0.01)
        return;
      lastHover.current = spot;
      enqueue([
        {
          action: { type: "move", ...spot },
          words: `moved the pointer to ${place(spot)}`,
          quiet: true,
        },
      ]);
    }, HOVER_MS);
  };

  // Where on the screen a point of the page falls, through the zoomed view.
  const spotAt = (clientX: number, clientY: number): Spot | null => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const region = zoomRef.current;
    return region ? { x: region.x0 + x * region.w, y: region.y0 + y * region.h } : { x, y };
  };
  const canAct = control && !!imageUrl;
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (!imageUrl) return;
    const spot = spotAt(event.clientX, event.clientY);
    if (!spot) return;
    if (zoomPick) {
      setZoom(regionAround(spot.x, spot.y));
      setZoomPick(false);
      tell(
        control
          ? "Zoomed in. Click inside it to click there on the Mac."
          : "Zoomed in.",
      );
      return;
    }
    if (!control) return;
    const count = Math.min(3, Math.max(1, event.detail || 1));
    pointerAct(
      { type: "click", ...spot, button: "left", count },
      `${count === 3 ? "triple-clicked" : count === 2 ? "double-clicked" : "clicked"} at ${place(spot)}`,
      spot,
    );
  };
  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAct) return;
    event.preventDefault();
    const spot = zoomPick ? null : spotAt(event.clientX, event.clientY);
    if (spot)
      pointerAct(
        { type: "click", ...spot, button: "right", count: 1 },
        `right-clicked at ${place(spot)}`,
        spot,
      );
  };
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (!canAct || event.button !== 0 || zoomPick) return;
    keysRef.current?.focus({ preventScroll: true });
    const spot = spotAt(event.clientX, event.clientY);
    if (!spot) return;
    clearTimeout(hoverTimer.current);
    press.current = {
      id: event.pointerId,
      start: spot,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* the pointer is already gone */
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const down = press.current;
    if (down && down.id === event.pointerId) {
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6)
        down.moved = true;
      return;
    }
    if (canAct && !zoomPick && event.pointerType === "mouse") {
      const spot = spotAt(event.clientX, event.clientY);
      if (spot) hover(spot);
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const down = press.current;
    press.current = null;
    if (!down || down.id !== event.pointerId || !down.moved) return;
    suppressClick.current = true;
    const end = spotAt(event.clientX, event.clientY);
    if (!end) return;
    pointerAct(
      { type: "drag", x: down.start.x, y: down.start.y, toX: end.x, toY: end.y },
      `dragged from ${place(down.start)} to ${place(end)}`,
      end,
    );
  };
  wheelRef.current = (event: WheelEvent) => {
    if (!canAct) return;
    event.preventDefault();
    if (zoomPickRef.current) return;
    const spot = spotAt(event.clientX, event.clientY);
    if (!spot) return;
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
    addScroll(spot, event.deltaX * unit, event.deltaY * unit);
  };
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !control) return;
    // React listens to wheel passively; this one must keep the page still.
    const listener = (event: WheelEvent) => wheelRef.current(event);
    frame.addEventListener("wheel", listener, { passive: false });
    return () => frame.removeEventListener("wheel", listener);
  }, [control]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!control || event.nativeEvent.isComposing || event.key === "Process")
      return;
    const named = NAMED[event.key];
    if (named) {
      const modifiers = chord(event, false);
      event.preventDefault();
      keyPress(named, modifiers, [...modifiers, event.key].join("+"));
      return;
    }
    // AltGr (Ctrl+Alt on some layouts) makes characters, not shortcuts.
    if (event.getModifierState?.("AltGraph")) return;
    const modifiers = chord(event, true);
    if (!modifiers.includes("cmd") && !modifiers.includes("control")) return;
    const key = physical(event.code, event.key);
    if (!key) return;
    event.preventDefault();
    keyPress(key, modifiers, [...modifiers, key].join("+"));
  };
  const takeText = (field: HTMLTextAreaElement) => {
    const value = field.value;
    field.value = "";
    if (value) addText(value);
  };

  // The Text and Keys panels: one sequence at a time, never overlapping.
  const runActions = async (steps: Step[]) => {
    if (running.current || queue.current.length || !control) return;
    if (holdKeys()) return;
    flushText();
    queue.current.push(steps);
    await pump();
  };
  const typeText = async (enter: boolean) => {
    const value = text,
      revision = textRevision.current;
    if (!value) return;
    await runActions([
      {
        action: { type: "type", text: value },
        words: typed(value),
        applied: () => {
          // Acknowledged typing clears its own draft even if Enter later
          // fails. Edits made while the request was pending remain untouched.
          if (textRevision.current === revision) {
            textRevision.current++;
            setText("");
          }
        },
      },
      ...(enter
        ? [{ action: { type: "key", key: "enter" }, words: "pressed Enter" }]
        : []),
    ]);
  };
  const pressShortcut = async () => {
    const parts = shortcut
      .toLowerCase()
      .split(/[+\s-]+/)
      .filter(Boolean)
      .map((part) => aliases[part] || part);
    const key = parts.find((part) => !MODIFIERS.has(part));
    const modifiers = parts.filter((part) => MODIFIERS.has(part));
    if (!key)
      return tell("Not done: name a key, like cmd+l or shift+tab.", "is-blocked");
    await runActions([
      { action: { type: "key", key, modifiers }, words: `pressed ${shortcut}` },
    ]);
  };
  // Sign in from the agent's vault: the value is read once, the box is
  // cleared before anything is sent, and nothing echoes it (status, log,
  // saved tool). The Mac never puts it in a terminal.
  const fillSecret = async (field: HTMLInputElement | null, what: "username" | "password", enter = false) => {
    if (!field) return;
    const value = field.value;
    field.value = "";
    if (!value) return;
    await runActions([
      { action: { type: "type", text: value, secret: true }, words: `typed the ${what} (hidden)` },
      ...(enter ? [{ action: { type: "key", key: "enter" }, words: "pressed Enter" }] : []),
    ]);
  };
  const toggleSheet = (next: "type" | "signin") => {
    setSheet((current) => (current === next ? "" : next));
    if (sheet === next) keysRef.current?.focus({ preventScroll: true });
  };
  const toggleZoom = () => {
    if (zoomPick || zoom) {
      setZoomPick(false);
      setZoom(null);
      return;
    }
    setZoomPick(true);
    tell("Click the picture where you want to look closer.");
  };
  const pan = (dx: number, dy: number) =>
    setZoom((current) =>
      current
        ? regionAround(
            current.x0 + current.w / 2 + dx,
            current.y0 + current.h / 2 + dy,
          )
        : current,
    );

  // The zoomed view: a quarter of the full-resolution picture, four times larger.
  useEffect(() => {
    const canvas = canvasRef.current,
      image = imageRef.current;
    if (!canvas || !image || !zoom) return;
    const context = canvas.getContext?.("2d");
    if (!context) return;
    const width = image.naturalWidth || imageSize?.w || 0,
      height = image.naturalHeight || imageSize?.h || 0;
    if (!width || !height) return;
    canvas.width = Math.round(width * zoom.w);
    canvas.height = Math.round(height * zoom.h);
    try {
      context.drawImage(
        image,
        zoom.x0 * width,
        zoom.y0 * height,
        zoom.w * width,
        zoom.h * height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    } catch {
      /* not yet decodable */
    }
  }, [zoom, imageUrl, imageSize]);

  const marker =
    lastClick && now - lastClick.at < 3000
      ? zoom
        ? lastClick.x >= zoom.x0 &&
          lastClick.x <= zoom.x0 + zoom.w &&
          lastClick.y >= zoom.y0 &&
          lastClick.y <= zoom.y0 + zoom.h
          ? {
              x: (lastClick.x - zoom.x0) / zoom.w,
              y: (lastClick.y - zoom.y0) / zoom.h,
            }
          : null
        : lastClick
      : null;
  const stale = !!imageAt && now - imageAt.getTime() > STALE_MS;
  const live = !imageAt
    ? screenError
      ? `No picture: ${screenError}`
      : "Connecting…"
    : stale
      ? screenError
        ? "Reconnecting…"
        : `Picture from ${Math.round((now - imageAt.getTime()) / 1000)} s ago`
      : "Live";
  return (
    <section
      className={`ap-card ap-screen${control ? "" : " is-look"}${full ? " is-full" : ""}`}
      aria-label="The Mac's screen"
    >
      {!control && (
        <p className="ap-hint">Look only. Nothing on this page clicks or types on the Mac.</p>
      )}
      <div className="ap-stage" ref={stageRef}>
        {control && sheet === "signin" && (
          <form
            className="ap-sheet ap-type"
            aria-label="Sign in"
            autoComplete="on"
            onSubmit={(event) => {
              event.preventDefault();
              void fillSecret(passRef.current, "password", true);
            }}
          >
            <span className="ap-quiet">Click the field on the Mac, fill here from your vault. Hidden, never shown.</span>
            <input ref={userRef} type="email" name="username" autoComplete="username" aria-label="Email or username for the Mac" placeholder="Email or username" />
            <button className="ap-pill" type="button" disabled={!canAct || actionBusy} onClick={() => void fillSecret(userRef.current, "username")}>
              Fill email
            </button>
            <input ref={passRef} type="password" name="password" autoComplete="current-password" aria-label="Password for the Mac" placeholder="Password" />
            <button className="ap-pill" type="button" disabled={!canAct || actionBusy} onClick={() => void fillSecret(passRef.current, "password")}>
              Fill password
            </button>
            <button className="ap-pill is-primary" type="submit" disabled={!canAct || actionBusy}>
              <CornerDownLeft size={14} /> Fill + Enter
            </button>
          </form>
        )}
        {control && sheet === "type" && (
          <form
            className="ap-sheet ap-type"
            onSubmit={(event) => {
              event.preventDefault();
              void typeText(false);
            }}
          >
            <input
              aria-label="Text to type"
              placeholder="Text for the focused field"
              value={text}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                textRevision.current++;
                setText(event.target.value);
              }}
            />
            <button
              className="ap-pill is-primary"
              type="submit"
              disabled={!text || !canAct || actionBusy}
            >
              Type
            </button>
            <button
              className="ap-pill"
              type="button"
              disabled={!text || !canAct || actionBusy}
              onClick={() => void typeText(true)}
            >
              <CornerDownLeft size={14} /> Type + Enter
            </button>
          </form>
        )}
        <div
          ref={frameRef}
          className={`ap-frame${canAct || (zoomPick && imageUrl) ? " can-act" : ""}${imageSize ? " is-fit" : ""}`}
          style={shape}
          role={canAct ? "application" : undefined}
          aria-label={
            zoomPick
              ? "Mac screen. Click where to zoom in."
              : canAct
                ? zoom
                  ? "Zoomed Mac screen. Click, drag, scroll and type here as on the Mac."
                  : "Mac screen. Click, drag, scroll and type here as on the Mac."
                : "Mac screen"
          }
          onClick={onClick}
          onContextMenu={onContextMenu}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            press.current = null;
          }}
          onPointerLeave={() => clearTimeout(hoverTimer.current)}
          onMouseDown={(event) => {
            // No text selection or dragged picture; focus stays on the keys.
            if (canAct) event.preventDefault();
          }}
        >
          {imageUrl ? (
            <img
              ref={imageRef}
              src={imageUrl}
              alt={`Screen of ${peer.name}`}
              draggable={false}
              hidden={!!zoom}
            />
          ) : (
            <div className="ap-placeholder" role="status">
              <Eye size={32} />
              <span>
                {screenError
                  ? `The screen could not be read: ${screenError}`
                  : "Waiting for the first picture…"}
              </span>
            </div>
          )}
          {zoom && imageUrl && <canvas ref={canvasRef} aria-hidden="true" />}
          {labels && !zoom && !zoomPick &&
            labels.items.map((item) => (
              <button
                key={`${labels.snapshot}-${item.n}`}
                type="button"
                className={`ap-label${item.secure ? " is-secure" : ""}`}
                style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%` }}
                aria-label={`${item.n}${item.name ? `: ${item.name}` : ""}`}
                title={item.name || item.role}
                disabled={actionBusy}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  pressLabel(item, labels.snapshot);
                }}
              >
                {item.n}
              </button>
            ))}
          {marker && (
            <span
              className="ap-mark-ring"
              style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
              aria-hidden="true"
            />
          )}
          {control && (
            <textarea
              ref={keysRef}
              className="ap-keys"
              aria-label="Keyboard for the Mac"
              inputMode="none"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onKeyDown={onKeyDown}
              onInput={(event) => {
                if (!(event.nativeEvent as InputEvent).isComposing)
                  takeText(event.currentTarget);
              }}
              onCompositionEnd={(event) => takeText(event.currentTarget)}
            />
          )}
        </div>
      </div>
      {/* The owner's Screen bar, for the agent: icons in one small bar at
          the bottom, status in a caption above it, the rest one tap away. */}
      <div className="ap-dock">
        {status.text && (
          <p className={`ap-status ${status.tone}`} role="status" aria-live="polite">
            {status.text}
          </p>
        )}
        <p
          className="ap-live"
          aria-live="off"
          title={hiddenCount ? `${hiddenCount} protected ${hiddenCount === 1 ? "window" : "windows"} left out` : undefined}
        >
          <span className={`ap-dot${stale || !imageAt ? " is-busy" : ""}`} />
          {live}
          {control && (
            <span className="ap-typing">
              {" · "}Typing goes to <strong>{front || "the app in front"}</strong>
            </span>
          )}
        </p>
        <div className="screen-bar" role="toolbar" aria-label="Screen controls">
          {control && (
            <button
              type="button"
              aria-label="Labels"
              title={labelsOn ? "Hide numbered labels" : "Show numbered labels"}
              aria-pressed={labelsOn}
              onClick={() => setLabelsOn((value) => !value)}
            >
              <Hash size={18} />
            </button>
          )}
          {control && (
            <button
              type="button"
              aria-label="Type text"
              title="Type text"
              aria-pressed={sheet === "type"}
              onClick={() => toggleSheet("type")}
            >
              <Keyboard size={19} />
            </button>
          )}
          {control && (
            <button
              type="button"
              aria-label="Shortcuts"
              title="Shortcuts"
              aria-haspopup="dialog"
              onClick={() => {
                setSheet("");
                setPanel("shortcuts");
              }}
            >
              <Command size={18} />
            </button>
          )}
          {(zoomPick || zoom) && (
            <button
              type="button"
              className="screen-bar-text"
              aria-pressed="true"
              onClick={toggleZoom}
            >
              Zoom out
            </button>
          )}
          {zoom &&
            (
              [
                ["left", -0.1, 0, ArrowLeft],
                ["up", 0, -0.1, ArrowUp],
                ["down", 0, 0.1, ArrowDown],
                ["right", 0.1, 0, ArrowRight],
              ] as const
            ).map(([name, dx, dy, Icon]) => (
              <button
                key={name}
                type="button"
                aria-label={`Move zoom ${name}`}
                onClick={() => pan(dx, dy)}
              >
                <Icon size={17} />
              </button>
            ))}
          {guide.length > 0 && (
            <button
              type="button"
              aria-label="Your instructions"
              title="Your instructions"
              aria-haspopup="dialog"
              onClick={() => onGuide(true)}
            >
              <ShieldCheck size={18} />
            </button>
          )}
          <button
            type="button"
            aria-label={full ? "Exit full screen" : "Full screen"}
            title={full ? "Exit full screen" : "Full screen"}
            aria-pressed={full}
            onClick={() => setFull((value) => !value)}
          >
            {full ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
          {(control || !(zoomPick || zoom)) && (
            <button
              type="button"
              aria-label="Screen options"
              title="More"
              aria-haspopup="dialog"
              onClick={() => setPanel("more")}
            >
              <Ellipsis size={20} />
            </button>
          )}
        </div>
      </div>
      {guide.length > 0 && guideOpen && active && !panel && (
        // Read once on arrival, then closed; the shield button opens it again.
        <ScreenPopup title="Your instructions" onClose={() => onGuide(false)}>
          <ul className="ap-guide-list">
            {guide.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </ScreenPopup>
      )}
      {panel === "shortcuts" && control && (
        <ScreenPopup title="Shortcuts" onClose={() => setPanel(null)} returnFocus={() => keysRef.current}>
          <ScreenActions
            platform="darwin"
            disabled={!canAct || actionBusy}
            run={({ keys, action }) => {
              setPanel(null);
              void runActions([{ action: action as Action, words: `pressed ${keys}` }]);
            }}
          />
          <section className="ap-keys-row" role="group" aria-label="Keys">
            {KEYS.map((item) => (
              <button
                key={item.key}
                type="button"
                className="ap-pill"
                disabled={!canAct || actionBusy}
                onClick={() =>
                  void runActions([
                    {
                      action: { type: "key", key: item.key },
                      words: `pressed ${item.label}`,
                    },
                  ])
                }
              >
                {item.label}
              </button>
            ))}
            <form
              className="ap-inline"
              onSubmit={(event) => {
                event.preventDefault();
                void pressShortcut();
              }}
            >
              <input
                aria-label="Shortcut"
                placeholder="cmd+l"
                value={shortcut}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setShortcut(event.target.value)}
              />
              <button
                className="ap-pill"
                type="submit"
                disabled={!shortcut || !canAct || actionBusy}
              >
                Press
              </button>
            </form>
          </section>
        </ScreenPopup>
      )}
      {panel === "more" && (
        <ScreenPopup title="Screen options" onClose={() => setPanel(null)} returnFocus={() => keysRef.current}>
          <div className="ap-options">
            {!(zoomPick || zoom) && (
              <button
                type="button"
                className="button secondary"
                disabled={!imageUrl}
                onClick={() => {
                  setPanel(null);
                  toggleZoom();
                }}
              >
                <ZoomIn size={17} /> Zoom in
              </button>
            )}
            {control && (
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setPanel(null);
                  setSheet("signin");
                }}
              >
                <KeyRound size={17} /> Sign in
              </button>
            )}
          </div>
          {control && (
            // Read by the agent, not the owner: what it may do and how.
            <details className="ap-brief" open>
              <summary>How to use</summary>
              <ul>
                <li>
                  {access.preset === "apps"
                    ? `You may use only the apps the owner chose on ${peer.name}.`
                    : `You have full control of ${peer.name}.`}{" "}
                  Your user's request is your permission: go ahead without asking at each step.
                </li>
                {access.shell && <li>Prefer the terminal? Commands runs commands on the Mac.</li>}
                <li>Numbered labels mark what you can click. Click a label to press that exact thing; it beats aiming at small targets.</li>
                <li>The picture is the Mac, live. Click, double-click, right-click, drag, scroll and type on it. ⌘ shortcuts work (Ctrl does too).</li>
                <li>To sign in, click the field on the Mac, then fill it from your vault under Sign in. It stays hidden.</li>
                <li>A code sent by email? Open Gmail or Mail on the Mac and read it yourself.</li>
                <li>"Not done" says why. Try another way. Small text: Zoom in.</li>
                <li>Ask your user before you pay, send a message or delete something.</li>
                <li>Always closed: password managers, Reach itself, security settings. If the owner pauses you, wait.</li>
              </ul>
            </details>
          )}
        </ScreenPopup>
      )}
    </section>
  );
}
