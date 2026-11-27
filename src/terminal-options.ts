import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

// The terminal fitted to its box, the newest line still in sight when the
// reader was at it: a box that shrinks (the keyboard closing, a bar
// growing) must never leave the prompt under the keys.
export function fitKeepingLatest(fit: FitAddon, term: Terminal) {
  const buffer = term.buffer.active;
  const latest = buffer.viewportY >= buffer.baseY;
  fit.fit();
  if (latest) term.scrollToBottom();
}

// One look for every terminal view.
export function terminalOptions(): ITerminalOptions {
  return {
    cursorBlink: true,
    // Phones fit more columns at 12px; full-screen programs need the width.
    fontSize: matchMedia("(max-width: 600px)").matches ? 12 : 14,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    theme: {
      background: "#0c110f",
      foreground: "#dce5dd",
      cursor: "#b9efd4",
      selectionBackground: "#354831",
      black: "#182019",
      red: "#f18d8d",
      green: "#b9f568",
      yellow: "#e3c67a",
      blue: "#8fb9f4",
      magenta: "#c7a8e9",
      cyan: "#86d0bd",
      white: "#e5ece6",
      // xterm draws its own scrollbar; its width is in styles.css.
      scrollbarSliderBackground: "#354635",
      scrollbarSliderHoverBackground: "#354635",
      scrollbarSliderActiveBackground: "#354635",
    },
    scrollback: 5000,
    convertEol: false,
  };
}

// Option (Alt) + ← / → jump a word, as they did before xterm 6, which now
// sends them as bare modified arrows (ESC [1;3D) that shells don't bind.
// Same bytes xterm 5 sent: the Mac's ESC b / ESC f, elsewhere Ctrl + arrow.
export function altArrowWords(term: Terminal) {
  const mac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(
    navigator.platform,
  );
  const words: Record<string, string> = mac
    ? { ArrowLeft: "\x1bb", ArrowRight: "\x1bf" }
    : { ArrowLeft: "\x1b[1;5D", ArrowRight: "\x1b[1;5C" };
  term.attachCustomKeyEventHandler((event) => {
    const word = words[event.key];
    if (!word || event.type !== "keydown" || !event.altKey) return true;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return true;
    event.preventDefault();
    term.input(word);
    return false;
  });
}

// Keystrokes go straight to the computer; the phone must not rewrite them.
export function plainKeyboard(term: Terminal) {
  const helper = term.textarea;
  // xterm positions a tiny textarea over the cursor. Safari zooms the whole
  // page when that field inherits the terminal's 12px font.
  if (helper) helper.style.fontSize = "16px";
  for (const [name, value] of [
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
    ["autocomplete", "off"],
    ["spellcheck", "false"],
    ["writingsuggestions", "false"],
  ])
    helper?.setAttribute(name, value);
}

const snapshotState = new WeakMap<
  Terminal,
  { following: boolean; top: number; pending: number }
>();

// Mac tabs send snapshots, not a PTY stream. Keep the reader's place when
// those snapshots change; a reset must not turn every refresh into "Latest",
// even if a second snapshot arrives before xterm finishes parsing the first.
export function writeSnapshot(term: Terminal, text: string) {
  const buffer = term.buffer?.active;
  let state = snapshotState.get(term);
  if (!state || state.pending === 0) {
    const top = buffer?.viewportY ?? 0;
    const following = !buffer || top >= buffer.baseY;
    state = { following, top, pending: 1 };
    snapshotState.set(term, state);
  } else {
    state.pending++;
  }
  term.reset();
  term.write(text, () => {
    state.pending = Math.max(0, state.pending - 1);
    if (state.following) term.scrollToBottom();
    else {
      const maxTop = term.buffer?.active?.baseY ?? state.top;
      term.scrollToLine(Math.min(state.top, maxTop));
    }
  });
}

// xterm v6 registers a document-level touch gesture on SmoothScrollableElement
// that competes with custom touch handling and ignores mouse-reporting TUIs.
// Stop touch propagation before document, add momentum coasting, and send
// line-mode wheel events whenever alternate screen or mouse reporting is active.
export function terminalTouch(element: HTMLElement, term: Terminal) {
  let samples: { x: number; y: number; at: number }[] = [];
  let velocity = 0;
  let coast: { at: number; started: number } | null = null;
  let gain = 1;
  let start: { x: number; y: number; moved: boolean } | null = null;
  let lastPoint = { x: 0, y: 0 };
  let suppressClickUntil = 0;
  let remainder = 0;
  let coastFrame = 0;
  const clamp = (n: number, low: number, high: number) =>
    Math.max(low, Math.min(high, n));
  const now = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const stopCoast = () => {
    if (coastFrame) {
      cancelAnimationFrame(coastFrame);
      coastFrame = 0;
    }
    coast = null;
  };
  const resetMotion = () => {
    samples = [];
    velocity = 0;
    coast = null;
    gain = 1;
  };
  const recordMove = (x: number, y: number, at: number) => {
    const last = samples.at(-1);
    if (!last) {
      samples = [{ x, y, at }];
      return 0;
    }
    const dy = y - last.y;
    if (!dy) return 0;
    if (Math.abs(dy) >= 2 && dy * velocity < 0) samples = [last];
    samples.push({ x, y, at });
    while (
      samples.length > 32 ||
      (samples.length > 2 && at - samples[0].at > 90)
    )
      samples.shift();
    const first = samples[0];
    const dt = Math.max(16, at - first.at);
    const vy = (y - first.y) / dt;
    const speed = Math.abs(vy);
    gain = samples.length >= 3 ? 1 + 2 * clamp((speed - 0.35) / 1.65, 0, 1) ** 1.2 : 1;
    const limit = Math.min(1, 6 / Math.max(0.001, speed * gain));
    velocity = vy * gain * limit;
    return dy * gain;
  };
  const hasMouseTracking = () =>
    !!term.modes?.mouseTrackingMode &&
    term.modes.mouseTrackingMode !== "none";
  const isAlternateScreen = () =>
    term.buffer?.active?.type === "alternate" && !hasMouseTracking();
  const rowHeight = () =>
    Math.max(
      10,
      (element.querySelector(".xterm-screen")?.getBoundingClientRect().height ||
        element.clientHeight) /
        (term.rows || 24) || 18,
    );
  const clampToScreen = (x: number, y: number) => {
    const rect = (
      element.querySelector(".xterm-screen") || element
    ).getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return { x, y };
    return {
      x: Math.max(rect.left + 1, Math.min(rect.right - 1, x)),
      y: Math.max(rect.top + 1, Math.min(rect.bottom - 1, y)),
    };
  };
  const dispatchWheel = (deltaY: number, deltaMode: number, clientX: number, clientY: number) => {
    const target = element.querySelector(".xterm");
    if (!target) return;
    const pt = clampToScreen(clientX, clientY);
    const WinWheel = element.ownerDocument?.defaultView?.WheelEvent || WheelEvent;
    target.dispatchEvent(
      new WinWheel("wheel", {
        bubbles: true,
        cancelable: true,
        deltaMode,
        deltaY,
        clientX: pt.x,
        clientY: pt.y,
      }),
    );
  };
  const applyDelta = (deltaY: number, clientX: number, clientY: number) => {
    if (isAlternateScreen()) {
      if (deltaY) dispatchWheel(deltaY, 0, clientX, clientY);
      return;
    }
    remainder += deltaY;
    const row = rowHeight();
    const lines = Math.trunc(remainder / row);
    if (!lines) return;
    remainder -= lines * row;
    if (hasMouseTracking()) {
      const dir = lines > 0 ? 1 : -1;
      const steps = Math.min(Math.abs(lines), 12);
      for (let i = 0; i < steps; i++) {
        // DOM_DELTA_LINE bypasses xterm's <50px 0.3x pixel penalty
        dispatchWheel(dir, 1, clientX, clientY);
      }
    } else {
      term.scrollLines(lines);
    }
  };
  const stepCoast = () => {
    if (!coast) {
      coastFrame = 0;
      return;
    }
    const at = now();
    const elapsed = at - coast.at;
    if (
      elapsed > 80 ||
      at - coast.started > 1400 ||
      Math.abs(velocity) < 0.02
    ) {
      resetMotion();
      coastFrame = 0;
      return;
    }
    const dt = clamp(elapsed, 0, 48);
    const keep = Math.exp(-dt / 220);
    const dy = clamp(velocity * 220 * (1 - keep), -120, 120);
    velocity *= keep;
    coast.at = at;
    applyDelta(-dy, lastPoint.x, lastPoint.y);
    coastFrame = requestAnimationFrame(stepCoast);
  };
  const down = (event: TouchEvent) => {
    event.stopPropagation();
    const wasCoasting = coast !== null;
    stopCoast();
    resetMotion();
    if (wasCoasting) suppressClickUntil = Date.now() + 350;
    if (event.touches.length !== 1) {
      start = null;
      return;
    }
    const t = event.touches[0];
    start = { x: t.clientX, y: t.clientY, moved: false };
    lastPoint = { x: t.clientX, y: t.clientY };
    remainder = 0;
  };
  const move = (event: TouchEvent) => {
    event.stopPropagation();
    if (!start || event.touches.length !== 1) {
      start = null;
      resetMotion();
      return;
    }
    const t = event.touches[0];
    lastPoint = { x: t.clientX, y: t.clientY };
    const at = now();
    if (!start.moved) {
      const dx = Math.abs(t.clientX - start.x),
        dy = Math.abs(t.clientY - start.y);
      if (dx > 12 && dx > dy * 1.5) {
        start = null;
        resetMotion();
        return;
      }
      if (dy < 6 || dy < dx * 0.6) return;
      start.moved = true;
      samples = [{ x: start.x, y: start.y, at: Math.max(0, at - 16) }];
    }
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    suppressClickUntil = Date.now() + 500;
    const dy = recordMove(t.clientX, t.clientY, at);
    applyDelta(-dy, t.clientX, t.clientY);
  };
  const up = (event: TouchEvent) => {
    event.stopPropagation();
    const moved = !!start?.moved;
    start = null;
    const at = now();
    const last = samples.at(-1);
    const first = samples[0];
    const canCoast =
      moved &&
      event.type === "touchend" &&
      !!last &&
      !!first &&
      at - last.at <= 80 &&
      Math.abs(last.y - first.y) >= 8 &&
      Math.abs(velocity) >= 0.15;
    if (canCoast) {
      stopCoast();
      coast = { at, started: at };
      coastFrame = requestAnimationFrame(stepCoast);
    } else {
      resetMotion();
    }
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  element.addEventListener("touchstart", down, { passive: true, capture: true });
  element.addEventListener("touchmove", move, { passive: false, capture: true });
  element.addEventListener("touchend", up, true);
  element.addEventListener("touchcancel", up, true);
  element.addEventListener("click", click, true);
  return () => {
    stopCoast();
    resetMotion();
    element.removeEventListener("touchstart", down, true);
    element.removeEventListener("touchmove", move, true);
    element.removeEventListener("touchend", up, true);
    element.removeEventListener("touchcancel", up, true);
    element.removeEventListener("click", click, true);
  };
}

// xterm queues layout work for the next animation frames (open, reset);
// disposing before it runs throws "reading 'dimensions'". Callbacks run in
// order, so two frames later the queued work has finished.
export function disposeLater(term: Terminal) {
  requestAnimationFrame(() => requestAnimationFrame(() => term.dispose()));
}
